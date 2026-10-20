#!/usr/bin/env bash
# 数据库备份：pg_dump → backups/<timestamp>.sql.gz，保留最近 7 份。
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/backups"
mkdir -p "$DIR"

# 宿主没装客户端时借 compose 的 postgres 容器；DATABASE_URL 需在容器内可达（localhost 指向容器自身）。
pg() {
  if command -v "$1" >/dev/null 2>&1; then "$@"; else docker compose -f "$ROOT/docker-compose.yml" exec -T postgres "$@"; fi
}

OUT="$DIR/$(date +%Y%m%d-%H%M%S).sql.gz"
TMP="$OUT.tmp"

# --clean --if-exists 让备份可以直接恢复到已有库（restore.sh 依赖这一点）。
if ! pg pg_dump --no-owner --no-privileges --clean --if-exists "$DATABASE_URL" | gzip >"$TMP"; then
  rm -f "$TMP"
  echo "backup failed" >&2
  exit 1
fi
if ! gzip -t "$TMP"; then
  rm -f "$TMP"
  echo "backup integrity check failed" >&2
  exit 1
fi
mv "$TMP" "$OUT"
echo "backup written: $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"

# 只清理本脚本产出的文件名，避免误删 backups/ 里的其他文件。
# BSD xargs 没有 -r，用 while 读入；为空时循环不执行。
ls -1t "$DIR"/*.sql.gz 2>/dev/null | tail -n +8 | while IFS= read -r old; do rm -f "$old"; done
