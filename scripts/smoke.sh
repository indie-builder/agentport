#!/usr/bin/env bash
# 部署自检：健康检查 → 登录 → 核心读接口 → MCP 鉴权。
# 用法：BASE_URL=http://localhost:3000 ADMIN_USER=admin ADMIN_PASSWORD=... bash scripts/smoke.sh
# 可选：PLATFORM_MCP_TOKEN 有值时额外验证 /mcp 的 tools/list。
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
BODY_FILE="$(mktemp)"
HEADER_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE" "$HEADER_FILE"' EXIT

fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}

# 发请求并校验状态码；expected 可空格分隔多个，响应体留在 $BODY_FILE。
check() {
  local method="$1" path="$2" expected="$3"
  shift 3
  local status
  status="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" "$@" "$BASE_URL$path")" ||
    fail "${method} ${path} 请求失败（服务未启动？BASE_URL=${BASE_URL}）"
  case " $expected " in
    *" $status "*) echo "ok  $method $path -> $status" ;;
    *) fail "${method} ${path} 期望 ${expected}，实际 ${status}：$(cat "$BODY_FILE")" ;;
  esac
}

for path in /health/live /health/ready; do
  check GET "$path" 200
done

[ -n "$ADMIN_PASSWORD" ] || fail "ADMIN_PASSWORD 未设置"

status="$(curl -sS -D "$HEADER_FILE" -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "$BASE_URL/api/auth/login" \
  -H 'content-type: application/json' \
  -d "$(printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$ADMIN_PASSWORD")")" ||
  fail "POST /api/auth/login 请求失败"
[ "$status" = 200 ] || fail "登录失败（${status}）：$(cat "$BODY_FILE")"
# 生产模式 cookie 带 Secure，curl 的 cookie jar 不会把它发回 http，所以手动取 header。
COOKIE="$(sed -n 's/^[Ss]et-[Cc]ookie: *\([^;]*\).*/\1/p' "$HEADER_FILE")"
[ -n "$COOKIE" ] || fail "登录响应没有 Set-Cookie"
echo "ok  POST /api/auth/login"

# 指标含队列/连接池内部信息，匿名必须 401；登录后必须 200。
check GET /health/metrics 401
check GET /health/metrics 200 -H "Cookie: $COOKIE"

for path in /api/servers /api/agents '/api/runs?limit=1'; do
  check GET "$path" 200 -H "Cookie: $COOKIE"
done

# 未配置 PLATFORM_MCP_TOKEN 时没有该路由（404）；配置了则无 token 必须 401。
MCP_STATUS="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X POST "$BASE_URL/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" ||
  fail "POST /mcp 请求失败"
case "$MCP_STATUS" in
  401) echo "ok  POST /mcp 无 token 被拒 (401)" ;;
  404) echo "ok  POST /mcp 未启用 (404，未设置 PLATFORM_MCP_TOKEN)" ;;
  *) fail "POST /mcp 期望 401（未启用时 404），实际 ${MCP_STATUS}：$(cat "$BODY_FILE")" ;;
esac

if [ -n "${PLATFORM_MCP_TOKEN:-}" ]; then
  [ "$MCP_STATUS" = 401 ] || fail "设置了 PLATFORM_MCP_TOKEN 但 /mcp 返回 ${MCP_STATUS}"
  # 必须先 initialize 再 tools/list：空库时平台不宣告 tools capability，
  # 直接 tools/list 会得到 -32601。子进程用同一个 cookie jar 不适用，这里用 curl 顺序调用。
  INIT_STATUS="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' -X POST "$BASE_URL/mcp" \
    -H "authorization: Bearer $PLATFORM_MCP_TOKEN" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')" ||
    fail "POST /mcp initialize 失败"
  [ "$INIT_STATUS" = 200 ] || fail "POST /mcp initialize 期望 200，实际 ${INIT_STATUS}：$(cat "$BODY_FILE")"
  grep -q '"serverInfo"' "$BODY_FILE" || fail "initialize 响应缺 serverInfo：$(cat "$BODY_FILE")"

  check POST /mcp 200 -H "authorization: Bearer $PLATFORM_MCP_TOKEN" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  # 空库时零工具：MCP 不宣告 tools capability，tools/list 合法地返回 -32601。
  # 有工具时必须返回 tools 数组。两者都算部署成功。
  if grep -q '"tools"' "$BODY_FILE"; then
    echo "ok  tools/list 返回 tools"
  elif grep -q '"code":-32601' "$BODY_FILE"; then
    echo "ok  tools/list 返回 -32601（空库无工具，符合 MCP 协议）"
  else
    fail "tools/list 响应既无 tools 也无 -32601：$(cat "$BODY_FILE")"
  fi
fi

echo "SMOKE OK"
