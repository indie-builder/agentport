import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { fail } from './errors.js';

const PRIVATE_NETWORKS = new BlockList();
// BlockList 原生把 IPv4-mapped IPv6（::ffff:a.b.c.d）与 IPv4 网段互相匹配，
// 这里只需补 NAT64 64:ff9b::/96 的内嵌形式（RFC 6052 §2.2）。
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
PRIVATE_NETWORKS.addSubnet('ff00::', 8, 'ipv6');
PRIVATE_NETWORKS.addSubnet('2001:db8::', 32, 'ipv6');

function stripAddress(ip: string): string {
  return ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
}

export function isPrivateAddress(ip: string): boolean {
  const address = stripAddress(ip);
  const family = isIP(address);
  if (family === 4) return PRIVATE_NETWORKS.check(address, 'ipv4');
  if (family === 6) {
    const embedded = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (embedded) return PRIVATE_NETWORKS.check(embedded, 'ipv4');
    return PRIVATE_NETWORKS.check(address, 'ipv6');
  }
  return true;
}

export function isLoopbackAddress(ip: string): boolean {
  const address = stripAddress(ip).toLowerCase();
  const embedded = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  if (embedded) return embedded.startsWith('127.');
  if (isIP(address) === 4) return address.startsWith('127.');
  if (isIP(address) === 6) return address === '::1';
  return address === 'localhost';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 本地 MCP server 开发时必须可用；生产一律走正常检查。 */
function isDevLocal(host: string, nodeEnv: string | undefined, allowDevLocal: boolean): boolean {
  return allowDevLocal && nodeEnv === 'development' && LOCAL_HOSTS.has(host.toLowerCase());
}

/**
 * 只允许 http/https 且解析结果不得为私网地址。
 * 注意：DNS 重绑定无法在解析与 fetch 之间彻底消除，出站仍应配合网络层 allowlist。
 */
export async function assertSafeUrl(
  raw: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  await assertSafeUrlInternal(raw, nodeEnv, true);
}

async function assertSafeUrlInternal(
  raw: string,
  nodeEnv: string | undefined,
  allowDevLocal: boolean,
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
  if (isDevLocal(host, nodeEnv, allowDevLocal)) return;

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
      fail('INVALID_URL', `无法解析地址 ${host}`, { retryable: true, cause: err });
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    fail('INVALID_URL', '该地址解析到内网，生产环境不允许');
  }
}

function defaultPort(protocol: string): string {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

type AllowlistEntry = { host: string; port: string | null };

function parseAllowlistEntry(raw: string): AllowlistEntry {
  if (raw.includes('://')) {
    try {
      const url = new URL(raw);
      return {
        host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
        port: url.port || defaultPort(url.protocol),
      };
    } catch {
      return { host: raw.toLowerCase(), port: null };
    }
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  if (bracketed) {
    const host = bracketed[1];
    if (host) return { host: host.toLowerCase(), port: bracketed[2] ?? null };
  }
  const colon = raw.indexOf(':');
  if (colon >= 0 && colon === raw.lastIndexOf(':')) {
    return { host: raw.slice(0, colon).toLowerCase(), port: raw.slice(colon + 1) || null };
  }
  return { host: raw.toLowerCase(), port: null };
}

/** 显式配置的私网主机按主机名与有效端口匹配后放行；其余目标仍走 assertSafeUrl。 */
export async function assertServerEndpoint(
  raw: string,
  opts: { nodeEnv: string | undefined; allowlist: string; allowDevLocal?: boolean },
): Promise<void> {
  const allowDevLocal = opts.allowDevLocal ?? true;
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return assertSafeUrlInternal(raw, nodeEnv, allowDevLocal);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || defaultPort(url.protocol);
  const allowed = opts.allowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseAllowlistEntry);
  if (allowed.some((entry) => entry.host === host && (entry.port === null || entry.port === port)))
    return;
  await assertSafeUrlInternal(raw, nodeEnv, allowDevLocal);
}
