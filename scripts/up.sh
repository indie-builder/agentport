#!/usr/bin/env bash
# 一条命令部署：生成 .env → 启动依赖 → 迁移 → 构建镜像 → 冒烟。
# 用法：pnpm run up [--rebuild]
set -euo pipefail

cd "$(dirname "$0")/.."

REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    -h|--help) echo "用法: bash scripts/up.sh [--rebuild]"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

BASE_URL="${BASE_URL:-http://localhost:3000}"
SANDBOX_IMAGE=agentport/sandbox:dev

fail() {
  echo "UP FAIL: $*" >&2
  exit 1
}

env_get() {
  sed -n "s/^$1=//p" .env | tail -n 1
}

command -v docker >/dev/null 2>&1 || fail "未找到 docker"
docker compose version >/dev/null 2>&1 || fail "未找到 docker compose"

if [ ! -f .env ]; then
  cp .env.example .env
  ENV_FILE=.env node --input-type=commonjs <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');

const file = process.env.ENV_FILE;
const secret = () => crypto.randomBytes(32).toString('base64url');
const redisPassword = crypto.randomBytes(18).toString('base64url');
const adminPassword = crypto.randomBytes(18).toString('base64url');

let text = fs.readFileSync(file, 'utf8');
const values = {
  APP_SECRET_KEY: secret(),
  JWT_SECRET: secret(),
  PLATFORM_MCP_TOKEN: secret(),
  REDIS_PASSWORD: redisPassword,
  REDIS_URL: `redis://:${redisPassword}@localhost:6379`,
  ADMIN_PASSWORD: adminPassword,
};
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  text = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.replace(/\s*$/, '')}\n${line}\n`;
}
fs.writeFileSync(file, text);
console.log(`已生成 ADMIN_PASSWORD=${adminPassword}`);
NODE
  echo "已从 .env.example 生成 .env（APP_SECRET_KEY / JWT_SECRET / REDIS_PASSWORD / PLATFORM_MCP_TOKEN / ADMIN_PASSWORD 已随机填充）"
  echo "提示：请按需修改 .env 中的 ADMIN_PASSWORD 后重新部署；运行智能体还需填写 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN"
fi

ADMIN_PASSWORD="$(env_get ADMIN_PASSWORD)"
[ -n "$ADMIN_PASSWORD" ] ||
  fail ".env 中 ADMIN_PASSWORD 为空：请设置至少 12 字符的密码后重新运行"

echo "==> 启动 postgres / redis"
docker compose up -d --build postgres redis || fail "启动 postgres / redis 失败"

deps_healthy() {
  local status
  status="$(docker compose ps --format '{{.Service}}|{{.Health}}' 2>/dev/null || true)"
  grep -qx 'postgres|healthy' <<<"$status" && grep -qx 'redis|healthy' <<<"$status"
}
for _ in $(seq 1 60); do
  deps_healthy && break
  sleep 2
done
deps_healthy || {
  docker compose ps >&2 || true
  fail "postgres / redis 未在 120 秒内 healthy"
}
echo "依赖就绪"

if [ "$REBUILD" = 1 ] || ! docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
  echo "==> 构建沙盒镜像 $SANDBOX_IMAGE"
  pnpm --filter @agentport/sandbox build || fail "构建 sandbox dist 失败（先运行 pnpm install）"
  # runner 在 stdin 边界用 @agentport/shared 校验任务，镜像需要它的编译产物。
  pnpm --filter @agentport/shared build || fail "构建 shared dist 失败"
  rm -rf packages/sandbox/shared
  cp -R packages/shared/dist packages/sandbox/shared
  docker build -t "$SANDBOX_IMAGE" packages/sandbox || fail "构建沙盒镜像失败"
else
  echo "==> 沙盒镜像已存在，跳过构建（需要重建时加 --rebuild）"
fi

echo "==> 修正工作区卷属主"
# docker compose down -v 之后命名卷归 root，worker 以 node(1000) 运行会 Permission denied。
# 卷本身用一次性 alpine 容器 chown，避免依赖宿主权限。
docker run --rm -v agentport_workspaces:/w alpine sh -c 'chown -R 1000:1000 /w' >/dev/null 2>&1 ||
  echo "warn: 工作区卷属主修正失败，若首次运行报 EACCES 请手动 chown" >&2

echo "==> 迁移并启动 api / worker"
# 删除上次完成的一次性迁移容器，确保本次重新执行迁移。
docker compose rm -sf migrate >/dev/null 2>&1 || true
if ! docker compose up -d --build api worker; then
  docker compose logs --tail=60 migrate api >&2 || true
  fail "构建或启动 api / worker 失败（迁移日志见上）"
fi

echo "==> 等待 $BASE_URL/health/ready"
READY=0
for _ in $(seq 1 45); do
  if curl -fsS "$BASE_URL/health/ready" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" != 1 ]; then
  docker compose ps >&2 || true
  docker compose logs --tail=60 migrate api >&2 || true
  fail "api 未在 90 秒内就绪"
fi

echo "==> 冒烟测试"
BASE_URL="$BASE_URL" \
ADMIN_USER="$(env_get ADMIN_USER)" \
ADMIN_PASSWORD="$ADMIN_PASSWORD" \
PLATFORM_MCP_TOKEN="$(env_get PLATFORM_MCP_TOKEN)" \
  bash scripts/smoke.sh || fail "冒烟测试失败"

echo "部署完成：$BASE_URL"
if ! env_get ANTHROPIC_API_KEY >/dev/null 2>&1 && ! env_get ANTHROPIC_AUTH_TOKEN >/dev/null 2>&1; then
  echo
  echo "注意：未配置模型凭据（ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN）。"
  echo "      平台本身可用，但发起对话会失败；补全 .env 后运行 pnpm run up 重启。"
fi
