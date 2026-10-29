#!/usr/bin/env bash
# 从完整备份恢复：校验归档 → 生成恢复前安全副本（库 + 工作区）→ 单事务替换数据库 →
# 换入工作区文件 → 补齐迁移。
# 用法：pnpm restore <backup.tar.gz> [--target-workspaces <dir>] [--target-knowledge <dir>]
# 数据库目标永远来自调用环境（DATABASE_URL 或 BACKUP_ENV_FILE 里的值），
# 备份里的 env 只用于恢复配置文件，不会覆盖本次连接的数据库。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/backup-lib.sh
. "$ROOT/scripts/backup-lib.sh"

ARCHIVE=''
TARGET_WS=''
TARGET_KN=''
while [ $# -gt 0 ]; do
  case "$1" in
    --target-workspaces)
      [ $# -ge 2 ] || die "--target-workspaces needs a directory"
      TARGET_WS="$2"
      shift 2
      ;;
    --target-knowledge)
      [ $# -ge 2 ] || die "--target-knowledge needs a directory"
      TARGET_KN="$2"
      shift 2
      ;;
    -h | --help)
      echo "usage: pnpm restore <backup.tar.gz> [--target-workspaces <dir>] [--target-knowledge <dir>]" >&2
      exit 0
      ;;
    *)
      [ -z "$ARCHIVE" ] || die "unexpected argument: $1"
      ARCHIVE="$1"
      shift
      ;;
  esac
done
[ -n "$ARCHIVE" ] || die "usage: pnpm restore <backup.tar.gz> [--target-workspaces <dir>] [--target-knowledge <dir>]"
ARCHIVE="$(cd "$(dirname -- "$ARCHIVE")" && pwd)/$(basename -- "$ARCHIVE")"

ENV_SOURCE="${BACKUP_ENV_FILE:-$ROOT/.env}"
# 灾难恢复常见于新机器：没有 .env 也能恢复，只要调用方显式给了 DATABASE_URL。
# 安全副本必须包含配置；本地配置不存在时用该 URL 生成最小引导 env，
# 现存但空/不可读的配置仍视为损坏，在写安全副本前中止。
if [ ! -f "$ENV_SOURCE" ] && [ -z "${DATABASE_URL:-}" ]; then
  die "env file not found: $ENV_SOURCE (set BACKUP_ENV_FILE or export DATABASE_URL)"
fi

# 目标库只用调用环境；缺省时从 BACKUP_ENV_FILE 读（与 backup.sh 一致），绝不读归档内的 env。
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
[ -n "$DATABASE_URL" ] || die "DATABASE_URL is empty; export it or set BACKUP_ENV_FILE"
export DATABASE_URL

log "validating $ARCHIVE"
validate_archive "$ARCHIVE" || die "restore aborted: archive rejected, nothing changed"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/restore.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if ! (
  # 单个文件写超上限时由内核终止 tar；总量在解压后按清单核对。
  # shortcut: 解压期间只有单文件上限，极端压缩比仍可能占满临时盘，等真实大归档需求再升级。
  ulimit -f "$((MAX_RESTORE_BYTES / 512))" 2>/dev/null || true
  tar -xzf "$ARCHIVE" -C "$WORK"
); then
  die "extract failed; nothing changed"
fi
if ! verify_tree "$WORK"; then
  die "restore aborted: archive content does not match manifest, nothing changed"
fi

# 应用必须先停：恢复期间不替用户停共享服务，也不接管别的会话在跑的服务。
OTHERS="$(pg_client_backends)" || die "cannot query database; check DATABASE_URL and the postgres service"
RUNNING="$(compose ps --status running -q api worker 2>/dev/null | grep -c . || true)"
if [ "${RUNNING:-0}" -gt 0 ]; then
  die "api/worker are running; stop them first: docker compose stop api worker"
fi
# 非 compose 部署（宿主直跑）只能靠连接数提示：脚本不替用户停服务。
[ "${OTHERS:-0}" = 0 ] ||
  log "warning: $OTHERS other database client(s) are connected; the restored database may be immediately overwritten by them. Restore expects api/worker to be stopped."

if [ -n "$TARGET_WS" ]; then
  if [ -e "$TARGET_WS" ] && [ ! -d "$TARGET_WS" ]; then
    die "--target-workspaces is not a directory: $TARGET_WS"
  fi
  if [ -n "$(ls -A "$TARGET_WS" 2>/dev/null || true)" ]; then
    die "--target-workspaces must be empty for a side-by-side verification restore: $TARGET_WS"
  fi
  mkdir -p "$TARGET_WS"
  WS_MODE=host
  WS_PATH="$(cd "$TARGET_WS" && pwd)"
else
  resolve_workspaces 1
fi
# 新机器上工作区目录可能还不存在；安全副本允许是空目录。
[ "$WS_MODE" = host ] && mkdir -p "$WS_PATH"

# 知识库目标：默认回到配置位置（容器卷时在容器里，宿主目录时在宿主）。
# --target-knowledge 是隔离演练，永远写宿主空目录，不碰真实知识库。
# 只给 --target-workspaces 时与配置一致：旁路验证不碰真实知识库。
resolve_knowledge
KN_TARGET=''
if [ -n "$TARGET_KN" ]; then
  if [ -e "$TARGET_KN" ] && [ ! -d "$TARGET_KN" ]; then
    die "--target-knowledge is not a directory: $TARGET_KN"
  fi
  if [ -n "$(ls -A "$TARGET_KN" 2>/dev/null || true)" ]; then
    die "--target-knowledge must be empty for a side-by-side verification restore: $TARGET_KN"
  fi
  mkdir -p "$TARGET_KN"
  KN_MODE=host
  KN_TARGET="$(cd "$TARGET_KN" && pwd)"
elif [ -n "$TARGET_WS" ]; then
  log "knowledge not restored (--target-workspaces verification run); set --target-knowledge to write it"
else
  case "$KN_MODE" in
    host)
      KN_TARGET="$KN_PATH"
      [ -d "$KN_TARGET" ] && [ -n "$(ls -A "$KN_TARGET" 2>/dev/null || true)" ] &&
        log "warning: knowledge dir $KN_TARGET is not empty; its files will be replaced (current copy saved in the pre-restore safety archive)"
      ;;
    *) KN_TARGET="$KNOWLEDGE_CONTAINER_DIR" ;;
  esac
fi

# 安全副本必须包含一份可恢复的配置：现存但为空/不可读时先中止，
# 不能写出一个会被 validate_archive 拒绝的空 env 回退点。
ENV_MISSING=0
if [ ! -e "$ENV_SOURCE" ]; then
  ENV_MISSING=1
elif [ ! -f "$ENV_SOURCE" ] || [ ! -r "$ENV_SOURCE" ] || [ ! -s "$ENV_SOURCE" ]; then
  die "config is empty or unreadable for the pre-restore safety copy: $ENV_SOURCE (set BACKUP_ENV_FILE)"
fi

STAMP="$(now_ts)"
SAFETY="$BACKUP_DIR/pre-restore-$STAMP.tar.gz"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# ── 恢复前安全副本：当前库 + 当前工作区 ────────────────────────
SAFETY_STAGE=""
cleanup() {
  rm -rf "$WORK"
  [ -z "$SAFETY_STAGE" ] || rm -rf "$SAFETY_STAGE"
}
trap cleanup EXIT

log "writing pre-restore safety copy: $SAFETY"
SAFETY_STAGE="$(mktemp -d "$BACKUP_DIR/.safety.XXXXXX")"
if ! pg_run pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" >"$SAFETY_STAGE/database.dump"; then
  die "pre-restore database backup failed; restore aborted, nothing changed"
fi
chmod 600 "$SAFETY_STAGE/database.dump"
if [ "$ENV_MISSING" = 1 ]; then
  # 本地配置原本不存在，没有可备份的密钥；只记录目标 DATABASE_URL。
  # 单引号包裹，URL 被 source 时不会展开或执行其中的 shell 字符。
  sq() {
    local s=$1
    s=${s//\'/\'\\\'\'}
    printf "'%s'" "$s"
  }
  {
    printf '%s\n' '# generated by restore.sh: no local config existed before this restore; only the target DATABASE_URL is recorded.'
    printf 'DATABASE_URL=%s\n' "$(sq "$DATABASE_URL")"
  } >"$SAFETY_STAGE/env" || die "pre-restore config backup failed; restore aborted, nothing changed"
  chmod 600 "$SAFETY_STAGE/env"
elif ! install -m 600 "$ENV_SOURCE" "$SAFETY_STAGE/env"; then
  die "pre-restore config backup failed; restore aborted, nothing changed"
fi
mkdir -p "$SAFETY_STAGE/workspaces"
if ! ws_tar_out | tar -xf - -C "$SAFETY_STAGE/workspaces"; then
  die "pre-restore workspace backup failed; restore aborted, nothing changed"
fi
prune_workspaces "$SAFETY_STAGE/workspaces"
# 当前知识库也进安全副本；侧验模式不碰真实知识库，无需复制。没有时留空，清单写 knowledge: null。
# 已配置却读不到时中止：安全副本缺知识库等于没有回退路径。
SAFETY_KN=''
if [ -z "$TARGET_WS" ]; then
  KN_FILES="$(knowledge_file_count)" || die "cannot read current knowledge storage; restore aborted, nothing changed"
  if [ "$KN_FILES" -gt 0 ]; then
    mkdir -p "$SAFETY_STAGE/knowledge"
    if ! knowledge_tar_out | tar -xf - -C "$SAFETY_STAGE/knowledge"; then
      die "pre-restore knowledge backup failed; restore aborted, nothing changed"
    fi
    find "$SAFETY_STAGE/knowledge" -type d -exec chmod 700 {} \;
    find "$SAFETY_STAGE/knowledge" -type f -exec chmod 600 {} \;
    SAFETY_KN="$SAFETY_STAGE/knowledge"
  fi
fi
chmod 700 "$SAFETY_STAGE"
find "$SAFETY_STAGE/workspaces" -type d -exec chmod 700 {} \;
find "$SAFETY_STAGE/workspaces" -type f -exec chmod 600 {} \;
write_manifest "$SAFETY_STAGE/manifest.json" "$SAFETY_STAGE/database.dump" "$SAFETY_STAGE/env" \
  "$SAFETY_STAGE/workspaces" "$ARCHIVE" "$SAFETY_KN"
SAFETY_TMP="$SAFETY.tmp"
if ! tar -C "$SAFETY_STAGE" -czf "$SAFETY_TMP" .; then
  rm -f "$SAFETY_TMP"
  die "pre-restore safety archive failed; restore aborted, nothing changed"
fi
chmod 600 "$SAFETY_TMP"
mv "$SAFETY_TMP" "$SAFETY"
rm -rf "$SAFETY_STAGE"
SAFETY_STAGE=''
# 安全副本本身要能通过恢复侧同一套校验；不可恢复的包不能当回退点，改库前中止。
if ! validate_archive "$SAFETY"; then
  rm -f "$SAFETY"
  die "pre-restore safety copy failed archive validation; restore aborted, database unchanged"
fi
log "safety copy: $SAFETY"

# 先做一次只读的 TOC 解析：归档损坏在改库之前就失败。
if ! pg_run pg_restore --list <"$WORK/database.dump" >/dev/null; then
  die "backup database image is unreadable; restore aborted, database unchanged"
fi
# ── 数据库：单事务整库替换；失败则整体回滚 ─────────────────────
log "restoring database"
# --clean --if-exists 由归档生成 DROP；--single-transaction 保证失败时整库回滚。
# 归档从 stdin 传入：容器模式 exec 在 postgres 容器里，看不到宿主的临时路径。
if ! pg_run pg_restore --clean --if-exists --no-owner --no-privileges \
  --single-transaction --exit-on-error --dbname="$DATABASE_URL" <"$WORK/database.dump"; then
  die "database restore failed and was rolled back; database unchanged. safety copy: $SAFETY"
fi

# 恢复配置文件（备份里的 env）；数据库连接始终是上面的目标，不受它影响。
# 归档里的 DATABASE_URL 与新环境不同只提示一句，不打印任何一方的值。
ARCHIVE_DB_URL="$(sed -n 's/^DATABASE_URL=//p' "$WORK/env" | tail -n 1)"
if [ -n "$ARCHIVE_DB_URL" ] && [ "$ARCHIVE_DB_URL" != "$DATABASE_URL" ]; then
  log "note: the backup's .env points at a different DATABASE_URL than the one restored into; update it if this environment uses its own database"
fi
# 旁路验证到新目录时默认不碰配置；要覆盖配置就显式给 RESTORE_ENV_TARGET。
if [ -n "$TARGET_WS" ] && [ -z "${RESTORE_ENV_TARGET:-}" ]; then
  log "config not restored (--target-workspaces verification run); set RESTORE_ENV_TARGET to write it"
else
  ENV_TARGET="${RESTORE_ENV_TARGET:-$ENV_SOURCE}"
  if [ -e "$ENV_TARGET" ]; then
    install -m 600 "$ENV_TARGET" "$BACKUP_DIR/pre-restore-$STAMP.env"
    log "previous config saved: $BACKUP_DIR/pre-restore-$STAMP.env"
  fi
  install -m 600 "$WORK/env" "$ENV_TARGET"
  log "config restored: $ENV_TARGET"
fi

# ── 工作区文件：先暂存，再整体换入；run_* 保留 ──────────────────
log "restoring workspaces ($WS_MODE)"
ws_swap "$WORK/workspaces" ||
  die "database and config were restored, but workspace files did NOT complete. Re-run the file restore or copy from $SAFETY; do not assume a full rollback. safety copy: $SAFETY"

# ── 知识库文件：同套暂存/换入；归档里没有 knowledge/ 时保持现状 ──
if [ -z "$KN_TARGET" ]; then
  log "knowledge not restored (side-by-side run without --target-knowledge)"
elif [ -d "$WORK/knowledge" ]; then
  log "restoring knowledge ($KN_TARGET)"
  knowledge_swap "$WORK/knowledge" "$KN_TARGET" ||
    die "database, config and workspaces were restored, but knowledge files did NOT complete. Re-run the file restore or copy from $SAFETY; do not assume a full rollback. safety copy: $SAFETY"
else
  log "backup has no knowledge/; leaving $KN_TARGET unchanged"
fi

log "applying migrations"
if ! DATABASE_URL="$DATABASE_URL" pnpm --dir "$ROOT" db:migrate; then
  die "database and files restored, but migrations failed. Fix and re-run 'pnpm db:migrate'. safety copy: $SAFETY"
fi

echo "RESTORE OK $ARCHIVE"
