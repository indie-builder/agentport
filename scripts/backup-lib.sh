#!/usr/bin/env bash

: "${ROOT:?ROOT must be set before sourcing backup-lib.sh}"

BACKUP_FORMAT="agentport-backup"
BACKUP_VERSION=2
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_RESTIC_KEEP="${BACKUP_RESTIC_KEEP:-7}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$ROOT/.env}"
PG_CLIENT="${PG_CLIENT:-auto}"
WORKSPACES_CONTAINER_DIR="${WORKSPACES_CONTAINER_DIR:-/workspaces}"
MAX_ENV_BYTES=1048576
MAX_RESTORE_BYTES="${MAX_RESTORE_BYTES:-21474836480}"

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
now_ts() { date +%Y%m%d-%H%M%S; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "need sha256sum or shasum"
  fi
}

workspace_file_count() {
  find "$1" -type f | wc -l | tr -d ' '
}

workspaces_sha256() {
  local dir="$1" tmp sum
  tmp="$(mktemp "${TMPDIR:-/tmp}/ws-sha.XXXXXX")"
  ( cd "$dir" && find . -type f -print0 | sort -z | while IFS= read -r -d '' f; do
      printf '%s\0' "${f#./}"
      cat "$f"
      printf '\0'
    done ) >"$tmp"
  sum="$(sha256_file "$tmp")"
  rm -f "$tmp"
  printf '%s' "$sum"
}

file_bytes() { wc -c <"$1" | tr -d ' '; }

database_url_from_env_file() {
  local file="${1:-${BACKUP_ENV_FILE:-$ROOT/.env}}" raw url sq_char="'"
  raw="$(sed -n 's/^DATABASE_URL=//p' "$file" | tail -n 1)"
  case "$raw" in
    \'*\' )
      url="${raw#\'}"
      url="${url%\'}"
      url="${url//\'\\\'\'/$sq_char}"
      ;;
    *)
      url="${raw%\"}"
      url="${url#\"}"
      url="${url%\'}"
      url="${url#\'}"
      ;;
  esac
  printf '%s' "$url"
}

compose() { docker compose -f "$ROOT/docker-compose.yml" "$@"; }
compose_available() { command -v docker >/dev/null 2>&1 && compose version >/dev/null 2>&1; }

_host_major() {
  command -v "$1" >/dev/null 2>&1 || return 1
  "$1" --version 2>/dev/null | grep -oE '[0-9]+' | head -1
}

_server_major() {
  compose exec -T postgres postgres --version 2>/dev/null | grep -oE '[0-9]+' | head -1
}

pg_use_container() {
  local bin="$1" host server
  case "$PG_CLIENT" in
    container) return 0 ;;
    host) return 1 ;;
  esac
  command -v "$bin" >/dev/null 2>&1 || return 0
  host="$(_host_major "$bin")" || host=''
  server="$(_server_major)" || server=''
  [ -n "$host" ] && [ -n "$server" ] && [ "$host" -lt "$server" ]
}

pg_run() {
  local bin="$1"
  shift
  if pg_use_container "$bin"; then
    command -v docker >/dev/null 2>&1 || die "$bin unavailable: install a PostgreSQL client or start compose"
    compose exec -T postgres "$bin" "$@"
  elif command -v "$bin" >/dev/null 2>&1; then
    "$bin" "$@"
  else
    command -v docker >/dev/null 2>&1 || die "$bin not found: install a PostgreSQL client or start compose"
    compose exec -T postgres "$bin" "$@"
  fi
}

_pg_backends_once() {
  pg_run psql -X -A -t \
    -c "select count(*) from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid()" \
    "$DATABASE_URL" | tr -d '[:space:]'
}

pg_client_backends() {
  local out
  if out="$(_pg_backends_once)"; then
    printf '%s' "$out"
    return 0
  fi
  [ "$PG_CLIENT" = auto ] || return 1
  compose_available || return 1
  PG_CLIENT=container
  _pg_backends_once
}

WS_MODE=''
WS_PATH=''
WS_SERVICE=''

_compose_running_service() {
  local svc
  for svc in api worker; do
    if compose ps --status running -q "$svc" 2>/dev/null | grep -q .; then
      printf '%s' "$svc"
      return 0
    fi
  done
  return 1
}

_compose_volume_name() {
  local key="$1" json
  json="$(compose config --format json 2>/dev/null)" || return 1
  printf '%s' "$json" | KEY="$key" bun -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const config = JSON.parse(s);
  const key = process.env.KEY;
  const volume = (config.volumes || {})[key] || {};
  const name = volume.name || (config.name ? `${config.name}_${key}` : "");
  if (!name) process.exit(1);
  process.stdout.write(name);
});
'
}

resolve_workspaces() {
  local allow_create="${1:-0}" cand vol mount

  if [ -n "${BACKUP_WORKSPACES_DIR:-}" ]; then
    if [ -d "$BACKUP_WORKSPACES_DIR" ]; then
      WS_MODE=host
      WS_PATH="$(cd "$BACKUP_WORKSPACES_DIR" && pwd)"
    elif [ "$allow_create" = 1 ]; then
      WS_MODE=host
      WS_PATH="$BACKUP_WORKSPACES_DIR"
    else
      die "workspaces dir not found: $BACKUP_WORKSPACES_DIR"
    fi
    return 0
  fi

  # compose 部署的显式宿主路径；不可读时继续自动探测（macOS 上卷目录不在宿主）。
  if [ -n "${HOST_WORKSPACES_DIR:-}" ] && [ -d "$HOST_WORKSPACES_DIR" ]; then
    WS_MODE=host
    WS_PATH="$(cd "$HOST_WORKSPACES_DIR" && pwd)"
    return 0
  fi

  if compose_available; then
    if WS_SERVICE="$(_compose_running_service)"; then
      WS_MODE=exec
      return 0
    fi
    vol="$(_compose_volume_name workspaces || true)"
    [ -n "$vol" ] || vol="agentport_workspaces"
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      mount="$(docker volume inspect "$vol" --format '{{.Mountpoint}}' 2>/dev/null || true)"
      if [ -n "$mount" ] && [ -d "$mount" ]; then
        WS_MODE=host
        WS_PATH="$mount"
        return 0
      fi
      WS_MODE=run
      WS_SERVICE="$(compose config --services 2>/dev/null | grep -x api | head -1)"
      [ -n "$WS_SERVICE" ] || WS_SERVICE="$(compose config --services 2>/dev/null | grep -x worker | head -1)"
      [ -n "$WS_SERVICE" ] || WS_SERVICE=api
      return 0
    fi
  fi

  for cand in "${WORKSPACES_DIR:-}" "$ROOT/data/workspaces"; do
    [ -n "$cand" ] || continue
    if [ -d "$cand" ]; then
      WS_MODE=host
      WS_PATH="$(cd "$cand" && pwd)"
      return 0
    fi
  done

  die "cannot locate workspaces; set BACKUP_WORKSPACES_DIR to the host path of the persistent workspaces volume"
}

# 只备份持久内容：run_* 是每次运行重建的派生物，restore 的临时目录也不是数据。
# 不用 tar --exclude：GNU/bsdtar 的 './*/run_*' 会连 agent-memory/run_notes.md 一起排除，
# 而 busybox tar 不会；解出 staging 后按顶层目录精确裁剪，三种 tar 行为一致。
ws_tar_out() {
  case "$WS_MODE" in
    host)
      tar -C "$WS_PATH" -cf - --exclude='./.restore-*' .
      ;;
    exec)
      compose exec -T "$WS_SERVICE" tar -C "$WORKSPACES_CONTAINER_DIR" -cf - \
        --exclude='./.restore-*' .
      ;;
    run)
      compose run --rm --no-deps -T --entrypoint tar "$WS_SERVICE" \
        -C "$WORKSPACES_CONTAINER_DIR" -cf - \
        --exclude='./.restore-*' .
      ;;
    *)
      die "workspaces not resolved"
      ;;
  esac
}

prune_workspaces() {
  local dir="$1"
  find "$dir" -mindepth 2 -maxdepth 2 -type d -name 'run_*' -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$dir/sandbox-probes"
}

ws_swap_script() {
  cat <<'SH'
set -eu
umask 077
staging="$ROOT/.restore-staging-$TS"
holding="$ROOT/.restore-holding-$TS"
ok=0
fail() {
  ok=1
  echo "workspace swap failed: $1" >&2
  kept=''
  if [ -f "$staging/.swapped" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      bad=0
      if [ -d "$holding/$name" ]; then
        for run in "$ROOT/$name"/run_*; do
          [ -e "$run" ] || continue
          mv "$run" "$holding/$name/${run##*/}" 2>/dev/null || { kept="$kept $run"; bad=1; }
        done
      fi
      if [ "$bad" = 0 ]; then rm -rf "$ROOT/$name"; fi
    done <"$staging/.swapped"
  fi
  for old in "$holding"/*; do
    [ -e "$old" ] || continue
    name=${old##*/}
    [ ! -e "$ROOT/$name" ] && mv "$old" "$ROOT/$name" 2>/dev/null || kept="$kept $old"
  done
  rm -rf "$staging"
  if [ -n "$kept" ]; then
    echo "workspace swap rollback incomplete; old files kept in:$kept" >&2
    exit 1
  fi
  rm -rf "$holding" 2>/dev/null || true
  exit 1
}
trap '[ "$ok" = 1 ] || fail "aborted"' EXIT
rm -rf "$staging" "$holding"
mkdir -p "$staging" "$holding"
cp -a "$SRC"/. "$staging"/
find "$staging" -type d -exec chmod 700 {} \;
find "$staging" -type f -exec chmod 600 {} \;
for old in "$ROOT"/*; do
  [ -e "$old" ] || continue
  name=${old##*/}
  case "$name" in .restore-*) continue ;; esac
  mv "$old" "$holding/$name"
done
for new in "$staging"/*; do
  [ -e "$new" ] || continue
  name=${new##*/}
  mv "$new" "$ROOT/$name"
  printf '%s\n' "$name" >>"$staging/.swapped"
done
for old in "$holding"/*; do
  [ -e "$old" ] || continue
  name=${old##*/}
  [ -d "$old" ] || continue
  has_run=0
  for run in "$old"/run_*; do
    [ -e "$run" ] || continue
    has_run=1
    break
  done
  [ "$has_run" = 1 ] || continue
  if [ ! -e "$ROOT/$name" ]; then
    mkdir -p "$ROOT/$name"
    printf '%s\n' "$name" >>"$staging/.swapped"
  fi
  for run in "$old"/run_*; do
    [ -e "$run" ] || continue
    mv "$run" "$ROOT/$name/${run##*/}"
  done
done
rm -rf "$staging" "$holding"
ok=1
SH
}

ws_swap() {
  local src="$1" script ts
  script="$(ws_swap_script)"
  ts="$(now_ts)"
  case "$WS_MODE" in
    host)
      mkdir -p "$WS_PATH"
      SRC="$src" ROOT="$WS_PATH" TS="$ts" sh -c "$script"
      ;;
    run)
      local src_abs
      src_abs="$(cd "$src" && pwd)"
      compose run --rm --no-deps -T \
        -v "$src_abs:/in:ro" \
        -e "SRC=/in" -e "ROOT=$WORKSPACES_CONTAINER_DIR" -e "TS=$ts" \
        --entrypoint sh "$WS_SERVICE" -c "$script"
      ;;
    *)
      die "stop api/worker before restoring files (workspaces are in use)"
      ;;
  esac
}

knowledge_swap() {
  local src="$1" dest="$2" script ts src_abs
  script="$(ws_swap_script)"
  ts="$(now_ts)"
  case "$KN_MODE" in
    host)
      mkdir -p "$dest"
      SRC="$src" ROOT="$dest" TS="$ts" sh -c "$script"
      ;;
    run)
      src_abs="$(cd "$src" && pwd)"
      compose run --rm --no-deps -T \
        -v "$src_abs:/in:ro" \
        -e "SRC=/in" -e "ROOT=$KNOWLEDGE_CONTAINER_DIR" -e "TS=$ts" \
        --entrypoint sh "$KN_SERVICE" -c "$script"
      ;;
    *)
      die "stop api/worker before restoring files (knowledge storage is in use)"
      ;;
  esac
}

KN_MODE=''
KN_PATH=''
KN_SERVICE=''
KNOWLEDGE_CONTAINER_DIR="${KNOWLEDGE_CONTAINER_DIR:-/knowledge}"
resolve_knowledge() {
  local cand="${BACKUP_KNOWLEDGE_DIR:-}" file vol mount
  if [ -n "$cand" ]; then
    case "$cand" in /*) ;; *) cand="$ROOT/$cand" ;; esac
    KN_MODE=host
    KN_PATH="$cand"
    return 0
  fi
  if compose_available; then
    vol="$(_compose_volume_name knowledgedata 2>/dev/null || true)"
    [ -n "$vol" ] || vol="agentport_knowledgedata"
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      mount="$(docker volume inspect "$vol" --format '{{.Mountpoint}}' 2>/dev/null || true)"
      if [ -n "$mount" ] && [ -d "$mount" ] && [ -r "$mount" ]; then
        KN_MODE=host
        KN_PATH="$mount"
        return 0
      fi
      if KN_SERVICE="$(_compose_running_service)"; then
        KN_MODE=exec
      else
        KN_MODE=run
        KN_SERVICE="$(compose config --services 2>/dev/null | grep -x api | head -1)"
        [ -n "$KN_SERVICE" ] || KN_SERVICE=api
      fi
      return 0
    fi
  fi
  cand="${KNOWLEDGE_DIR:-}"
  if [ -z "$cand" ]; then
    file="${BACKUP_ENV_FILE:-$ROOT/.env}"
    if [ -f "$file" ]; then
      cand="$(sed -n 's/^KNOWLEDGE_DIR=//p' "$file" | tail -n 1)"
      cand="${cand%\"}"; cand="${cand#\"}"
      cand="${cand%\'}"; cand="${cand#\'}"
    fi
  fi
  [ -n "$cand" ] || cand="$ROOT/data/knowledge"
  case "$cand" in /*) ;; *) cand="$ROOT/$cand" ;; esac
  KN_MODE=host
  KN_PATH="$cand"
}

_kn_count_script() {
  printf '%s' "if [ ! -d '$KNOWLEDGE_CONTAINER_DIR' ]; then echo 0; exit 0; fi
t=\$(mktemp) || exit 1
find '$KNOWLEDGE_CONTAINER_DIR' -type f >\"\$t\" || { rm -f \"\$t\"; exit 1; }
wc -l <\"\$t\"
rm -f \"\$t\""
}

knowledge_file_count() {
  local out list
  case "$KN_MODE" in
    host)
      [ -d "$KN_PATH" ] || { printf 0; return 0; }
      list="$(mktemp "${TMPDIR:-/tmp}/kn-list.XXXXXX")" || return 1
      # find 在任一层目录读不了时非零退出；不能把权限错误当成空目录。
      if ! find "$KN_PATH" -type f >"$list" 2>/dev/null; then rm -f "$list"; return 1; fi
      out="$(wc -l <"$list" | tr -d ' ')"
      rm -f "$list"
      printf '%s' "$out"
      ;;
    exec)
      out="$(compose exec -T "$KN_SERVICE" sh -c "$(_kn_count_script)")" || return 1
      printf '%s' "$out" | tr -d '[:space:]'
      ;;
    run)
      out="$(compose run --rm --no-deps -T --entrypoint sh "$KN_SERVICE" -c "$(_kn_count_script)")" || return 1
      printf '%s' "$out" | tr -d '[:space:]'
      ;;
    *) return 1 ;;
  esac
}

knowledge_tar_out() {
  case "$KN_MODE" in
    host) tar -C "$KN_PATH" -cf - --exclude='./.restore-*' . ;;
    exec)
      compose exec -T "$KN_SERVICE" tar -C "$KNOWLEDGE_CONTAINER_DIR" -cf - \
        --exclude='./.restore-*' .
      ;;
    run)
      compose run --rm --no-deps -T --entrypoint tar "$KN_SERVICE" \
        -C "$KNOWLEDGE_CONTAINER_DIR" -cf - \
        --exclude='./.restore-*' .
      ;;
    *) die "knowledge not resolved" ;;
  esac
}

normalize_member() {
  local name="$1"
  case "$name" in /*) return 1 ;; esac
  case "$name" in ./*) name="${name#./}" ;; esac
  [ -z "$name" ] && return 0
  [ "$name" = "." ] && return 0
  name="${name%/}"
  [ -n "$name" ] || return 0
  case "$name" in
    *[[:cntrl:]]* | *'\\'*) return 1 ;;
  esac
  case "/$name/" in
    *//* | */../* | */./*) return 1 ;;
  esac
  case "${name%%/*}" in
    manifest.json | database.dump | env | workspaces | knowledge) ;;
    *) return 1 ;;
  esac
  printf '%s' "$name"
}

manifest_extract() {
  local archive="$1" out="$2"
  tar -xzOf "$archive" ./manifest.json >"$out" 2>/dev/null ||
    tar -xzOf "$archive" manifest.json >"$out" 2>/dev/null
}

manifest_fields() {
  bun -e '
const fs = require("node:fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (Number.isInteger(v) && v >= 0 ? String(v) : "");
const db = m.database || {};
const env = m.env || {};
const ws = m.workspaces || {};
const kn = m.knowledge === null || m.knowledge === undefined ? null : m.knowledge;
const knFlag = m.knowledge === undefined ? "" : kn === null ? "0" : "1";
const k = kn || {};
process.stdout.write(
  [str(m.format), num(m.version), str(db.sha256), num(db.bytes), str(env.sha256), num(env.bytes), str(ws.sha256), num(ws.files), num(ws.bytes), knFlag, str(k.sha256), num(k.files), num(k.bytes)].join("\u001f"),
);
' "$1"
}

write_manifest() {
  local file="$1" db="$2" envfile="$3" ws="$4" safety="${5:-}" kn="${6:-}"
  SAFETY_OF="$safety" bun -e '
const fs = require("node:fs");
const [file, format, version, dbSha, dbBytes, envSha, envBytes, wsSha, wsFiles, wsBytes, safetyOf, knSha, knFiles, knBytes, knPresent] = process.argv.slice(1);
const manifest = {
  format,
  version: Number(version),
  createdAt: new Date().toISOString(),
  sourceHost: process.env.HOSTNAME || "",
  database: { sha256: dbSha, bytes: Number(dbBytes) },
  env: { sha256: envSha, bytes: Number(envBytes) },
  workspaces: { sha256: wsSha, files: Number(wsFiles), bytes: Number(wsBytes) },
  knowledge: knPresent === "1" ? { sha256: knSha, files: Number(knFiles), bytes: Number(knBytes) } : null,
};
if (safetyOf) manifest.safetyCopyOf = safetyOf;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
' "$file" "$BACKUP_FORMAT" "$BACKUP_VERSION" \
    "$(sha256_file "$db")" "$(file_bytes "$db")" \
    "$(sha256_file "$envfile")" "$(file_bytes "$envfile")" \
    "$(workspaces_sha256 "$ws")" \
    "$(workspace_file_count "$ws")" \
    "$(find "$ws" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')" \
    "$safety" \
    "${kn:+$(workspaces_sha256 "$kn")}" \
    "${kn:+$(workspace_file_count "$kn")}" \
    "${kn:+$(find "$kn" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')}" \
    "${kn:+1}"
}

M_FORMAT=''
M_VERSION=''
M_DB_SHA=''
M_DB_BYTES=''
M_ENV_SHA=''
M_ENV_BYTES=''
M_WS_SHA=''
M_WS_FILES=''
M_WS_BYTES=''
M_KN_FLAG=''
M_KN_SHA=''
M_KN_FILES=''
M_KN_BYTES=''

is_sha256() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

validate_archive() {
  local archive="$1" list types norm bad dup manifest fields has_kn
  [ -f "$archive" ] || {
    log "backup not found: $archive"
    return 1
  }
  case "$archive" in
    *.sql.gz) log "legacy sql.gz backups are not supported; this version restores $BACKUP_FORMAT@$BACKUP_VERSION tarballs"; return 1 ;;
  esac
  list="$(mktemp "${TMPDIR:-/tmp}/bak-list.XXXXXX")"
  types="$(mktemp "${TMPDIR:-/tmp}/bak-types.XXXXXX")"
  norm="$(mktemp "${TMPDIR:-/tmp}/bak-norm.XXXXXX")"
  manifest="$(mktemp "${TMPDIR:-/tmp}/bak-manifest.XXXXXX")"

  if ! tar -tzf "$archive" >"$list" 2>/dev/null; then
    rm -f "$list" "$types" "$norm" "$manifest"
    log "not a readable tar.gz archive: $archive"
    return 1
  fi
  tar -tvzf "$archive" 2>/dev/null | cut -c1 >"$types" || true
  if [ ! -s "$list" ] || [ ! -s "$types" ]; then
    rm -f "$list" "$types" "$norm" "$manifest"
    log "archive is empty: $archive"
    return 1
  fi
  if grep -Ev '^[-d]$' "$types" >/dev/null 2>&1; then
    rm -f "$list" "$types" "$norm" "$manifest"
    log "archive rejected: contains symlink, hardlink or special file"
    return 1
  fi
  while IFS= read -r member; do
    if ! bad="$(normalize_member "$member")"; then
      rm -f "$list" "$types" "$norm" "$manifest"
      log "archive rejected: unsafe member path: $member"
      return 1
    fi
    [ -n "$bad" ] || continue
    printf '%s\n' "$bad" >>"$norm"
  done <"$list"
  if [ "$(wc -l <"$norm" | tr -d ' ')" -gt 200000 ]; then
    rm -f "$list" "$types" "$norm" "$manifest"
    log "archive rejected: too many members"
    return 1
  fi
  dup="$(sort "$norm" | uniq -d | head -1)"
  if [ -n "$dup" ]; then
    rm -f "$list" "$types" "$norm" "$manifest"
    log "archive rejected: duplicate member: $dup"
    return 1
  fi
  for member in manifest.json database.dump env workspaces; do
    if ! grep -qx "$member" "$norm" && ! grep -q "^$member/" "$norm"; then
      rm -f "$list" "$types" "$norm" "$manifest"
      log "archive rejected: missing $member"
      return 1
    fi
  done
  if ! manifest_extract "$archive" "$manifest"; then
    rm -f "$list" "$types" "$norm" "$manifest"
    log "archive rejected: manifest.json missing or unreadable"
    return 1
  fi
  fields="$(manifest_fields "$manifest" 2>/dev/null)" || {
    rm -f "$list" "$types" "$norm" "$manifest"
    log "archive rejected: manifest.json is not valid JSON"
    return 1
  }
  has_kn=0
  if grep -q '^knowledge' "$norm"; then has_kn=1; fi
  rm -f "$list" "$types" "$norm" "$manifest"
  IFS=$'\x1f' read -r M_FORMAT M_VERSION M_DB_SHA M_DB_BYTES M_ENV_SHA M_ENV_BYTES M_WS_SHA M_WS_FILES M_WS_BYTES M_KN_FLAG M_KN_SHA M_KN_FILES M_KN_BYTES <<<"$fields"
  if [ "$M_FORMAT" != "$BACKUP_FORMAT" ] || [ "$M_VERSION" != "$BACKUP_VERSION" ]; then
    log "archive rejected: unsupported format (expected $BACKUP_FORMAT@$BACKUP_VERSION)"
    return 1
  fi
  if ! is_sha256 "$M_DB_SHA" || ! is_sha256 "$M_ENV_SHA" || ! is_sha256 "$M_WS_SHA" ||
    [ -z "$M_DB_BYTES" ] || [ -z "$M_ENV_BYTES" ] ||
    [ -z "$M_WS_FILES" ] || [ -z "$M_WS_BYTES" ]; then
    log "archive rejected: manifest fields are invalid"
    return 1
  fi
  if [ "$M_KN_FLAG" = 1 ]; then
    if ! is_sha256 "$M_KN_SHA" || [ -z "$M_KN_FILES" ] || [ -z "$M_KN_BYTES" ]; then
      log "archive rejected: manifest fields are invalid"
      return 1
    fi
    [ "$has_kn" = 1 ] || {
      log "archive rejected: manifest lists knowledge but the archive has no knowledge/"
      return 1
    }
  else
    M_KN_SHA=''; M_KN_FILES=''; M_KN_BYTES=0
    [ "$has_kn" = 0 ] || {
      log "archive rejected: archive contains knowledge/ but the manifest has none"
      return 1
    }
  fi
  if [ "$M_DB_BYTES" -le 0 ] || [ "$M_ENV_BYTES" -le 0 ] || [ "$M_ENV_BYTES" -gt "$MAX_ENV_BYTES" ]; then
    log "archive rejected: manifest sizes are out of range"
    return 1
  fi
  if [ "$((M_DB_BYTES + M_ENV_BYTES + M_WS_BYTES + M_KN_BYTES))" -gt "$MAX_RESTORE_BYTES" ]; then
    log "archive rejected: manifest size exceeds MAX_RESTORE_BYTES ($MAX_RESTORE_BYTES)"
    return 1
  fi
  return 0
}

verify_dir() {
  local dir="$1" files="$2" bytes="$3" sha="$4" label="$5" total
  [ "$(workspace_file_count "$dir")" = "$files" ] || {
    log "archive rejected: $label file count mismatch"
    return 1
  }
  total="$(find "$dir" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')"
  if [ "$total" != "$bytes" ]; then
    log "archive rejected: $label size mismatch"
    return 1
  fi
  [ "$(workspaces_sha256 "$dir")" = "$sha" ] || {
    log "archive rejected: $label content checksum mismatch"
    return 1
  }
}

verify_tree() {
  local stage="$1" db="$1/database.dump" env="$1/env" ws="$1/workspaces" kn="$1/knowledge"
  [ -f "$db" ] && [ -f "$env" ] && [ -d "$ws" ] || {
    log "archive rejected: expected files are missing after extraction"
    return 1
  }
  if find "$ws" -type l | grep -q .; then
    log "archive rejected: symlink left in workspaces"
    return 1
  fi
  [ "$(sha256_file "$db")" = "$M_DB_SHA" ] || {
    log "archive rejected: database.dump checksum mismatch"
    return 1
  }
  [ "$(file_bytes "$db")" = "$M_DB_BYTES" ] || {
    log "archive rejected: database.dump size mismatch"
    return 1
  }
  [ "$(sha256_file "$env")" = "$M_ENV_SHA" ] || {
    log "archive rejected: env checksum mismatch"
    return 1
  }
  [ "$(file_bytes "$env")" = "$M_ENV_BYTES" ] || {
    log "archive rejected: env size mismatch"
    return 1
  }
  verify_dir "$ws" "$M_WS_FILES" "$M_WS_BYTES" "$M_WS_SHA" workspace || return 1
  if [ -n "$M_KN_SHA" ]; then
    [ -d "$kn" ] || {
      log "archive rejected: knowledge/ is missing after extraction"
      return 1
    }
    if find "$kn" -type l | grep -q .; then
      log "archive rejected: symlink left in knowledge"
      return 1
    fi
    verify_dir "$kn" "$M_KN_FILES" "$M_KN_BYTES" "$M_KN_SHA" knowledge || return 1
    find "$kn" -type d -exec chmod 700 {} \;
    find "$kn" -type f -exec chmod 600 {} \;
  fi
  chmod 600 "$db" "$env"
  find "$ws" -type d -exec chmod 700 {} \;
  find "$ws" -type f -exec chmod 600 {} \;
}
