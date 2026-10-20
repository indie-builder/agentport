#!/usr/bin/env bash
# 从备份恢复：校验备份 → 生成恢复前安全副本 → 单事务整库替换 → 补齐迁移。
set -euo pipefail

FILE="${1:-}"
[ -n "$FILE" ] || { echo "usage: pnpm restore <backup-file>" >&2; exit 1; }
[ -f "$FILE" ] || { echo "backup not found: $FILE" >&2; exit 1; }
gzip -t "$FILE" 2>/dev/null || { echo "not a valid gzip file: $FILE" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 宿主没装客户端时借 compose 的 postgres 容器（与 backup.sh 一致）。
pg() {
  if command -v "$1" >/dev/null 2>&1; then "$@"; else docker compose -f "$ROOT/docker-compose.yml" exec -T postgres "$@"; fi
}

DIR="$ROOT/backups"
mkdir -p "$DIR"
SAFETY="$DIR/pre-restore-$(date +%Y%m%d-%H%M%S).sql.gz"

# 恢复会删表，先留当前库的副本；失败则不动库。
if ! pg pg_dump --no-owner --no-privileges --clean --if-exists "$DATABASE_URL" | gzip >"$SAFETY"; then
  rm -f "$SAFETY"
  echo "pre-restore backup failed, aborting" >&2
  exit 1
fi
echo "pre-restore backup: $SAFETY"

# 单事务：备份里的 DROP/CREATE 要么全部生效，要么全部回滚。
if ! gunzip -c "$FILE" | pg psql -q -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL"; then
  echo "restore failed; database left unchanged. safety copy: $SAFETY" >&2
  exit 1
fi

DATABASE_URL="$DATABASE_URL" pnpm --dir "$ROOT" db:migrate
echo "RESTORE OK $FILE"
