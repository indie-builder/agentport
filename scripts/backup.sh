#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/backup-lib.sh
. "$ROOT/scripts/backup-lib.sh"

ENV_SOURCE="${BACKUP_ENV_FILE:-$ROOT/.env}"
if [ ! -f "$ENV_SOURCE" ]; then
  die "env file not found: $ENV_SOURCE (set BACKUP_ENV_FILE)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(database_url_from_env_file "$ENV_SOURCE")"
fi
[ -n "$DATABASE_URL" ] || die "DATABASE_URL is empty in $ENV_SOURCE"
export DATABASE_URL

ENV_BYTES="$(file_bytes "$ENV_SOURCE")"
[ "$ENV_BYTES" -gt 0 ] || die "env file is empty: $ENV_SOURCE"
[ "$ENV_BYTES" -le "$MAX_ENV_BYTES" ] || die "env file is larger than $MAX_ENV_BYTES bytes: $ENV_SOURCE"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

resolve_workspaces
STAGE="$(mktemp -d "$BACKUP_DIR/.staging.XXXXXX")"
TMP_ARCHIVE=''
cleanup() {
  rm -rf "$STAGE"
  [ -z "$TMP_ARCHIVE" ] || rm -f "$TMP_ARCHIVE"
}
trap cleanup EXIT

case "$WS_MODE" in
  host) log "workspaces: $WS_PATH" ;;
  exec) log "workspaces: compose exec $WS_SERVICE:$WORKSPACES_CONTAINER_DIR" ;;
  run) log "workspaces: compose run $WS_SERVICE:$WORKSPACES_CONTAINER_DIR (docker volume)" ;;
esac

# 1) 一致性数据库导出。pg_dump 自带快照，运行中的 api/worker 不会造成半截数据。
OTHERS="$(pg_client_backends)" || die "cannot query database; check DATABASE_URL and the postgres service"
if [ "${OTHERS:-0}" != 0 ]; then
  log "warning: $OTHERS other database client(s) connected (api/worker). The dump is still consistent, but files and database may differ slightly. Stop api/worker for a fully aligned backup."
fi
if ! pg_run pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" >"$STAGE/database.dump"; then
  die "pg_dump failed; no backup published"
fi
chmod 600 "$STAGE/database.dump"

install -m 600 "$ENV_SOURCE" "$STAGE/env"

mkdir -p "$STAGE/workspaces"
if ! ws_tar_out | tar -xf - -C "$STAGE/workspaces"; then
  die "workspace archive failed; no backup published"
fi
prune_workspaces "$STAGE/workspaces"
chmod 700 "$STAGE"
find "$STAGE/workspaces" -type d -exec chmod 700 {} \;
find "$STAGE/workspaces" -type f -exec chmod 600 {} \;

WS_FILES="$(find "$STAGE/workspaces" -type f | wc -l | tr -d ' ')"
if [ "$WS_FILES" -eq 0 ] && [ "${BACKUP_ALLOW_EMPTY_WORKSPACES:-0}" != 1 ]; then
  die "workspace resolved to an empty directory (mode=$WS_MODE path=$WS_PATH); set BACKUP_WORKSPACES_DIR or BACKUP_ALLOW_EMPTY_WORKSPACES=1"
fi
WS_BYTES="$(find "$STAGE/workspaces" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')"
DB_BYTES="$(file_bytes "$STAGE/database.dump")"

resolve_knowledge
KN_DIR=''
case "$KN_MODE" in
  host) log "knowledge: $KN_MODE $KN_PATH" ;;
  exec) log "knowledge: compose exec $KN_SERVICE:$KNOWLEDGE_CONTAINER_DIR" ;;
  run) log "knowledge: compose run $KN_SERVICE:$KNOWLEDGE_CONTAINER_DIR (docker volume)" ;;
esac
KN_FILES="$(knowledge_file_count)" || die "cannot read knowledge storage (mode=$KN_MODE path=${KN_PATH:-$KNOWLEDGE_CONTAINER_DIR}); no backup published"
if [ "$KN_FILES" -gt 0 ]; then
  mkdir -p "$STAGE/knowledge"
  if ! knowledge_tar_out | tar -xf - -C "$STAGE/knowledge"; then
    die "knowledge archive failed; no backup published"
  fi
  find "$STAGE/knowledge" -type d -exec chmod 700 {} \;
  find "$STAGE/knowledge" -type f -exec chmod 600 {} \;
  KN_DIR="$STAGE/knowledge"
  log "knowledge: $KN_FILES files archived"
else
  log "knowledge: no files, manifest records knowledge: null"
fi

write_manifest "$STAGE/manifest.json" "$STAGE/database.dump" "$STAGE/env" "$STAGE/workspaces" '' "$KN_DIR"

TS="$(now_ts)"
OUT="$BACKUP_DIR/$TS.tar.gz"
TMP_ARCHIVE="$BACKUP_DIR/.tmp-$TS.tar.gz"
if ! tar -C "$STAGE" -czf "$TMP_ARCHIVE" .; then
  die "archive creation failed; no backup published"
fi
if ! gzip -t "$TMP_ARCHIVE"; then
  die "archive integrity check failed; no backup published"
fi
if ! validate_archive "$TMP_ARCHIVE"; then
  die "fresh backup failed validation; no backup published"
fi
chmod 600 "$TMP_ARCHIVE"
mv "$TMP_ARCHIVE" "$OUT"
TMP_ARCHIVE=''
log "backup written: $OUT ($(file_bytes "$OUT") bytes, database $DB_BYTES bytes, workspaces $WS_FILES files / $WS_BYTES bytes${KN_DIR:+, knowledge $(workspace_file_count "$KN_DIR") files})"

ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | grep -v '/pre-restore-' | tail -n +"$((BACKUP_KEEP + 1))" |
  while IFS= read -r old; do rm -f "$old"; done || true

if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  command -v restic >/dev/null 2>&1 || die "RESTIC_REPOSITORY is set but restic is not installed; local backup kept at $OUT"
  log "restic: backing up $OUT"
  if ! restic backup --tag "$BACKUP_FORMAT" "$OUT"; then
    die "restic backup failed; local backup kept at $OUT"
  fi
  # 保留策略按 tag+路径分组，不碰同一仓库里其他来源的快照。
  # 按 host 分组：每次备份的路径都不同，默认的 host+paths 分组会让 keep-last 变成空操作。
  if ! restic forget --tag "$BACKUP_FORMAT" --group-by host \
    --keep-last "$BACKUP_RESTIC_KEEP" --prune; then
    die "restic retention failed; local backup kept at $OUT"
  fi
  if ! restic check; then
    die "restic check failed; local backup kept at $OUT"
  fi
  log "restic: uploaded, retention applied, repository check passed"
fi
echo "BACKUP OK $OUT"
