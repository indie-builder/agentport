#!/usr/bin/env bash
# 完整备份：一致性 pg_dump + 持久工作区（agent-memory / SDK transcript）+ 必要 .env →
# backups/<timestamp>.tar.gz（0600）。可选 RESTIC_REPOSITORY 在本地成功后推送整包。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/backup-lib.sh
. "$ROOT/scripts/backup-lib.sh"

ENV_SOURCE="${BACKUP_ENV_FILE:-$ROOT/.env}"
if [ ! -f "$ENV_SOURCE" ]; then
  die "env file not found: $ENV_SOURCE (set BACKUP_ENV_FILE)"
fi

# 只读取 DATABASE_URL，不 source 整个文件：.env 里的值可能带空格或注释。
if [ -z "${DATABASE_URL:-}" ]; then
  RAW_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_SOURCE" | tail -n 1)"
  # restore.sh 的最小引导 env 用单引号 + '\'' 转义；只对这种生成格式反解，普通配置保持原读法。
  SQ_CHAR="'"
  case "$RAW_URL" in
    \'*\' )
      DATABASE_URL="${RAW_URL#\'}"
      DATABASE_URL="${DATABASE_URL%\'}"
      DATABASE_URL="${DATABASE_URL//\'\\\'\'/$SQ_CHAR}"
      ;;
    *)
      DATABASE_URL="${RAW_URL%\"}"
      DATABASE_URL="${DATABASE_URL#\"}"
      DATABASE_URL="${DATABASE_URL%\'}"
      DATABASE_URL="${DATABASE_URL#\'}"
      ;;
  esac
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
# 服务器上只留本脚本的连接，避免清点行数时混入应用连接。
OTHERS="$(pg_client_backends)" || die "cannot query database; check DATABASE_URL and the postgres service"
if [ "${OTHERS:-0}" != 0 ]; then
  log "warning: $OTHERS other database client(s) connected (api/worker). The dump is still consistent, but files and database may differ slightly. Stop api/worker for a fully aligned backup."
fi
if ! pg_run pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" >"$STAGE/database.dump"; then
  die "pg_dump failed; no backup published"
fi
chmod 600 "$STAGE/database.dump"

# 2) 配置：整份 .env（含密钥），归档与解包后都是 0600，脚本不打印内容。
install -m 600 "$ENV_SOURCE" "$STAGE/env"

# 3) 持久工作区。run_* 是每次运行重建的派生物，agent-memory/ 与 SDK transcript 才需要保留。
mkdir -p "$STAGE/workspaces"
if ! ws_tar_out | tar -xf - -C "$STAGE/workspaces"; then
  die "workspace archive failed; no backup published"
fi
prune_workspaces "$STAGE/workspaces"
chmod 700 "$STAGE"
find "$STAGE/workspaces" -type d -exec chmod 700 {} \;
find "$STAGE/workspaces" -type f -exec chmod 600 {} \;

WS_FILES="$(find "$STAGE/workspaces" -type f | wc -l | tr -d ' ')"
# 0 个文件几乎一定是工作区定位错了（空目录/别的 checkout）；不能当完整备份发布。
if [ "$WS_FILES" -eq 0 ] && [ "${BACKUP_ALLOW_EMPTY_WORKSPACES:-0}" != 1 ]; then
  die "workspace resolved to an empty directory (mode=$WS_MODE path=$WS_PATH); set BACKUP_WORKSPACES_DIR or BACKUP_ALLOW_EMPTY_WORKSPACES=1"
fi
WS_BYTES="$(find "$STAGE/workspaces" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')"
DB_BYTES="$(file_bytes "$STAGE/database.dump")"

# 4) 知识库（原件 blob + 解析产物）。可选：还没启用知识库时归档里就没有 knowledge/。
# 已配置却读不到（卷在宿主不可见、容器不可用）必须失败，不能伪装成「没有数据」。
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

# 5) 先临时后发布：同一目录内 rename，半截文件不会出现在备份名里。
TS="$(now_ts)"
OUT="$BACKUP_DIR/$TS.tar.gz"
TMP_ARCHIVE="$BACKUP_DIR/.tmp-$TS.tar.gz"
if ! tar -C "$STAGE" -czf "$TMP_ARCHIVE" .; then
  die "archive creation failed; no backup published"
fi
if ! gzip -t "$TMP_ARCHIVE"; then
  die "archive integrity check failed; no backup published"
fi
# 用恢复端同一套校验先自检：链接、越界路径或清单不符在发布前就失败，
# 不会留下一个 restore 会拒收的「备份」。
if ! validate_archive "$TMP_ARCHIVE"; then
  die "fresh backup failed validation; no backup published"
fi
chmod 600 "$TMP_ARCHIVE"
mv "$TMP_ARCHIVE" "$OUT"
TMP_ARCHIVE=''
log "backup written: $OUT ($(file_bytes "$OUT") bytes, database $DB_BYTES bytes, workspaces $WS_FILES files / $WS_BYTES bytes${KN_DIR:+, knowledge $(workspace_file_count "$KN_DIR") files})"

# 只清理本脚本产出的 .tar.gz；restore.sh 的 pre-restore-* 安全副本不参与保留数量。
ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | grep -v '/pre-restore-' | tail -n +"$((BACKUP_KEEP + 1))" |
  while IFS= read -r old; do rm -f "$old"; done || true

# 6) 可选：restic 把整个包推到远端（加密由 restic 完成，本脚本不自造协议）。
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
