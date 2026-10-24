#!/usr/bin/env bash
# 数据库备份：pg_dump → backups/<timestamp>.sql.gz，保留最近 7 份。
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/backups"
mkdir -p "$DIR"

# 宿主没装客户端时借 compose 的 postgres 容器；DATABASE_URL 需在容器内可达（localhost 指向容器自身）。
# 宿主 pg_dump 主版本与服务器不一致（旧客户端连 PG18）时同样改走容器。
container_pg() { docker compose -f "$ROOT/docker-compose.yml" exec -T postgres "$@"; }

dump_client_matches_server() {
  command -v pg_dump >/dev/null 2>&1 || return 1
  local host_major server_major
  host_major="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
  server_major="$(container_pg postgres --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  # 容器没起来时无从比较，只能寄望宿主客户端。
  [ -z "$server_major" ] || [ "$host_major" = "$server_major" ]
}

pg() {
  if [ "$1" = pg_dump ] && ! dump_client_matches_server; then
    container_pg "$@"
  elif command -v "$1" >/dev/null 2>&1; then
    "$@"
  else
    container_pg "$@"
  fi
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

# 只清理本脚本产出的 YYYYMMDD-HHMMSS.sql.gz；外部文件与 restore.sh 的
# pre-restore-*.sql.gz 不参与保留数量与删除。
# BSD xargs 没有 -r，用 while 读入；为空时循环不执行。
ls -1t "$DIR"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].sql.gz 2>/dev/null |
  tail -n +8 | while IFS= read -r old; do rm -f "$old"; done || true
