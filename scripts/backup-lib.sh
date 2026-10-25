#!/usr/bin/env bash
# backup.sh / restore.sh 的共享实现：Postgres 客户端选择、工作区定位与交换、
# 归档格式校验。调用方需先设置 ROOT 再 source 本文件。

: "${ROOT:?ROOT must be set before sourcing backup-lib.sh}"

BACKUP_FORMAT="agentport-backup"
BACKUP_VERSION=2
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_RESTIC_KEEP="${BACKUP_RESTIC_KEEP:-7}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$ROOT/.env}"
PG_CLIENT="${PG_CLIENT:-auto}"
WORKSPACES_CONTAINER_DIR="${WORKSPACES_CONTAINER_DIR:-/workspaces}"
# 恢复端的资源上限：归档解压总量 / 单个文件（ulimit -f 由 restore.sh 设置）。
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

# 工作区内容指纹：按相对路径排序后逐文件拼接 "路径\0内容\0" 再哈希。
# 只比文件数与总字节无法发现「同样大小、内容被替换」的归档。
workspaces_sha256() {
  local dir="$1" tmp sum
  tmp="$(mktemp "${TMPDIR:-/tmp}/ws-sha.XXXXXX")"
  # 不用 trap RETURN：本文件被 source，会覆盖调用方（backup/restore）的 EXIT trap。
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

compose() { docker compose -f "$ROOT/docker-compose.yml" "$@"; }
compose_available() { command -v docker >/dev/null 2>&1 && compose version >/dev/null 2>&1; }

# ── Postgres 客户端 ─────────────────────────────────────────────
# 宿主客户端旧于服务器（或干脆没装）时改走 compose 的 postgres 容器。
# PG_CLIENT=host 强制宿主（连外部库时用），=container 强制容器。
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

# 宿主客户端可能装得到、却连不上只有容器内才解析的主机名；auto 模式下退到容器。
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

# ── 工作区定位 ─────────────────────────────────────────────────
# WS_MODE: host（宿主目录）/ exec（容器在跑，docker compose exec 读）/
#          run（一次性容器，停止状态也能读/写卷）。
WS_MODE=''
WS_PATH=''
WS_SERVICE=''

_compose_running_service() {
  local svc
  # 优先 api：它只挂 workspaces 卷，不带 docker.sock。
  for svc in api worker; do
    if compose ps --status running -q "$svc" 2>/dev/null | grep -q .; then
      printf '%s' "$svc"
      return 0
    fi
  done
  return 1
}

_compose_volume_name() {
  local json
  json="$(compose config --format json 2>/dev/null)" || return 1
  printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const config = JSON.parse(s);
  const volume = (config.volumes || {}).workspaces || {};
  const name = volume.name || (config.name ? `${config.name}_workspaces` : "");
  if (!name) process.exit(1);
  process.stdout.write(name);
});
'
}

# 备份只接受已存在的源；恢复允许目标目录/卷还不存在。
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
    vol="$(_compose_volume_name || true)"
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

  # 宿主直跑（pnpm dev）时的 WORKSPACES_DIR；放在 compose 探测之后，
  # 避免 .env 里的 ./data/workspaces 抢走 compose 命名卷的数据。
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

# 解出工作区并剪掉派生内容：顶层 <slug>/run_* 与试连挂载点 sandbox-probes。
# 在宿主完成，避免依赖容器内 find 的可用性。
prune_workspaces() {
  local dir="$1"
  find "$dir" -mindepth 2 -maxdepth 2 -type d -name 'run_*' -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$dir/sandbox-probes"
}

# 在目标工作区内做“先暂存、再按顶层目录整体换入”的恢复；run_* 原样保留。
# 一次实现同时给宿主和容器用（容器里由 sh 执行）。
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
  # 尽力回滚：只把已经搬走的旧内容放回原位。绝不把线上目录移进 staging ——
  # cp -a 阶段失败时 staging 里已有同名目录，mv 会嵌套后随 rm 一起删掉线上数据。
  for old in "$holding"/*; do
    [ -e "$old" ] || continue
    mv "$old" "$ROOT/${old##*/}" 2>/dev/null || true
  done
  rm -rf "$staging" "$holding" 2>/dev/null || true
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
  mv "$new" "$ROOT/${new##*/}"
done
for old in "$holding"/*; do
  [ -e "$old" ] || continue
  name=${old##*/}
  if [ -d "$old" ] && [ -d "$ROOT/$name" ]; then
    for run in "$old"/run_*; do
      [ -e "$run" ] || continue
      mv "$run" "$ROOT/$name/${run##*/}"
    done
  fi
done
rm -rf "$staging" "$holding"
ok=1
SH
}

# ws_swap 只接管整棵目标树；目标目录由调用方决定（默认工作区或 --target-workspaces）。
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

# ── 归档校验（真实信任边界）───────────────────────────────────
# 只接受本格式：manifest.json / database.dump / env / workspaces/**；
# 拒绝绝对路径、..、控制字符、重复成员、符号链接/硬链接/设备文件。
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
    manifest.json | database.dump | env | workspaces) ;;
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
  node -e '
const fs = require("node:fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (Number.isInteger(v) && v >= 0 ? String(v) : "");
const db = m.database || {};
const env = m.env || {};
const ws = m.workspaces || {};
process.stdout.write(
  [str(m.format), num(m.version), str(db.sha256), num(db.bytes), str(env.sha256), num(env.bytes), str(ws.sha256), num(ws.files), num(ws.bytes)].join("\u001f"),
);
' "$1"
}

# 归档清单：只记录格式版本与校验值，不写 DATABASE_URL 或任何秘密。
write_manifest() {
  local file="$1" db="$2" envfile="$3" ws="$4" safety="${5:-}"
  SAFETY_OF="$safety" node -e '
const fs = require("node:fs");
const [file, format, version, dbSha, dbBytes, envSha, envBytes, wsSha, wsFiles, wsBytes, safetyOf] = process.argv.slice(1);
const manifest = {
  format,
  version: Number(version),
  createdAt: new Date().toISOString(),
  sourceHost: process.env.HOSTNAME || "",
  database: { sha256: dbSha, bytes: Number(dbBytes) },
  env: { sha256: envSha, bytes: Number(envBytes) },
  workspaces: { sha256: wsSha, files: Number(wsFiles), bytes: Number(wsBytes) },
};
if (safetyOf) manifest.safetyCopyOf = safetyOf;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
' "$file" "$BACKUP_FORMAT" "$BACKUP_VERSION" \
    "$(sha256_file "$db")" "$(file_bytes "$db")" \
    "$(sha256_file "$envfile")" "$(file_bytes "$envfile")" \
    "$(workspaces_sha256 "$ws")" \
    "$(workspace_file_count "$ws")" \
    "$(find "$ws" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')" \
    "$safety"
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

is_sha256() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in *[!0-9a-f]*) return 1 ;; esac
}

validate_archive() {
  local archive="$1" list types norm bad dup manifest fields
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
  # 任何非普通文件/目录的成员（l/h/b/c/p/s）一律拒绝：恢复不使用链接，也不跟随后来的写入。
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
  rm -f "$list" "$types" "$norm" "$manifest"
  IFS=$'\x1f' read -r M_FORMAT M_VERSION M_DB_SHA M_DB_BYTES M_ENV_SHA M_ENV_BYTES M_WS_SHA M_WS_FILES M_WS_BYTES <<<"$fields"
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
  if [ "$M_DB_BYTES" -le 0 ] || [ "$M_ENV_BYTES" -le 0 ] || [ "$M_ENV_BYTES" -gt "$MAX_ENV_BYTES" ]; then
    log "archive rejected: manifest sizes are out of range"
    return 1
  fi
  if [ "$((M_DB_BYTES + M_ENV_BYTES + M_WS_BYTES))" -gt "$MAX_RESTORE_BYTES" ]; then
    log "archive rejected: manifest size exceeds MAX_RESTORE_BYTES ($MAX_RESTORE_BYTES)"
    return 1
  fi
  return 0
}

# 解压后逐项核对 manifest，防截断/替换。
verify_tree() {
  local stage="$1" db="$1/database.dump" env="$1/env" ws="$1/workspaces" total
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
  [ "$(workspace_file_count "$ws")" = "$M_WS_FILES" ] || {
    log "archive rejected: workspace file count mismatch"
    return 1
  }
  total="$(find "$ws" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')"
  if [ "$total" != "$M_WS_BYTES" ]; then
    log "archive rejected: workspace size mismatch"
    return 1
  fi
  [ "$(workspaces_sha256 "$ws")" = "$M_WS_SHA" ] || {
    log "archive rejected: workspace content checksum mismatch"
    return 1
  }
  chmod 600 "$db" "$env"
  find "$ws" -type d -exec chmod 700 {} \;
  find "$ws" -type f -exec chmod 600 {} \;
}
