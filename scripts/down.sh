#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    -h|--help) echo "用法: bash scripts/down.sh [--clean]"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

if [ "$CLEAN" = 1 ]; then
  echo "==> docker compose down -v（删除数据卷）"
  docker compose down -v
else
  echo "==> docker compose down（保留数据卷）"
  docker compose down
fi
