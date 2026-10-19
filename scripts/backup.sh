#!/usr/bin/env bash
# 数据库备份：pg_dump → backups/<timestamp>.sql.gz，保留最近 7 份。
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/backups"
mkdir -p "$DIR"

OUT="$DIR/$(date +%Y%m%d-%H%M%S).sql.gz"
TMP="$OUT.tmp"

if ! pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip >"$TMP"; then
  rm -f "$TMP"
  echo "backup failed" >&2
  exit 1
fi
mv "$TMP" "$OUT"
echo "backup written: $OUT"

# 只清理本脚本产出的文件名，避免误删 backups/ 里的其他文件。
# BSD xargs 没有 -r，用 while 读入；为空时循环不执行。
ls -1t "$DIR"/*.sql.gz 2>/dev/null | tail -n +8 | while IFS= read -r old; do rm -f "$old"; done
