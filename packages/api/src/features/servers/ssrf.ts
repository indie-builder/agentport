import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { fail } from '@agentport/core';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const PRIVATE_NETWORKS = new BlockList();
// BlockList 原生把 IPv4-mapped IPv6（::ffff:a.b.c.d）与 IPv4 网段互相匹配，
// 无需另登记 ::ffff:0:0/96；这里只需补 NAT64 64:ff9b::/96 的内嵌形式（RFC 6052 §2.2）。
// 255.255.255.255 已包含在 240.0.0.0/4，无需单独的精确匹配。
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['192.0.0.0', 24],
  ['192.88.99.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, 'ipv4');
  PRIVATE_NETWORKS.addSubnet(`64:ff9b::${network}`, 96 + prefix, 'ipv6');
}
PRIVATE_NETWORKS.addSubnet('::', 128, 'ipv6');
PRIVATE_NETWORKS.addSubnet('::1', 128, 'ipv6');
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_NETWORKS.addSubnet('fe80::', 10, 'ipv6');

function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE_NETWORKS.check(ip, 'ipv4');
  if (family === 6) return PRIVATE_NETWORKS.check(ip, 'ipv6');
  return true;
}

/** 本地 MCP server 开发时必须可用；生产一律走正常检查。 */
function isDevLocal(host: string, nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' && LOCAL_HOSTS.has(host.toLowerCase());
}

/**
 * 只允许 http/https 且解析结果不得为私网地址。
 * 注意：DNS 重绑定无法在解析与 fetch 之间彻底消除，出站仍应配合网络层 allowlist。
 */
export async function assertSafeUrl(
  raw: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('INVALID_URL', '地址格式不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('INVALID_URL', '仅支持 http/https 地址');
  }
  if (url.username || url.password) {
    fail('INVALID_URL', 'URL不能包含账号密码，请通过加密headers配置凭证');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isDevLocal(host, nodeEnv)) return;

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      fail('INVALID_URL', `无法解析地址 ${host}`);
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    fail('INVALID_URL', '该地址解析到内网，生产环境不允许');
  }
}
