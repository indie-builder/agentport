import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { fail } from '@agentport/core';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const PRIVATE_IPV4 = new BlockList();
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
  PRIVATE_IPV4.addSubnet(network, prefix);
}

function isPrivateIpv4(ip: string): boolean {
  return PRIVATE_IPV4.check(ip, 'ipv4');
}

/** 展开 IPv6 为 16 字节；只覆盖需要判断的写法，解析失败返回 null。 */
function ipv6Bytes(ip: string): number[] | null {
  const [head = '', tail] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? headParts
      : [
          ...headParts,
          ...Array<string>(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0'),
          ...tailParts,
        ];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const v = Number.parseInt(g, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes;
}

function embeddedIpv4(bytes: number[]): string | null {
  // IPv4-mapped ::ffff:a.b.c.d（含十六进制写法）与 NAT64 64:ff9b::/96。
  const isMapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);
  if (!isMapped && !isNat64) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped 地址按内嵌 IPv4 判断，否则 ::ffff:127.0.0.1 会绕过检查。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  const bytes = ipv6Bytes(lower);
  if (!bytes) return true;
  // 十六进制写法 [::ffff:7f00:1] 与 NAT64 都要拆出内嵌 IPv4 再判断。
  const embedded = embeddedIpv4(bytes);
  if (embedded !== null) return isPrivateIpv4(embedded);
  const loopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  const unspecified = bytes.every((b) => b === 0);
  const uniqueLocal = ((bytes[0] ?? 0) & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80;
  return loopback || unspecified || uniqueLocal || linkLocal;
}

function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
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
