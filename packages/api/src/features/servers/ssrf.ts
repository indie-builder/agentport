import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (
    ((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)
  );
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip) >>> 0;
  const inRange = (base: string, bits: number): boolean => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||
    inRange('10.0.0.0', 8) ||
    inRange('127.0.0.0', 8) ||
    inRange('169.254.0.0', 16) ||
    inRange('172.16.0.0', 12) ||
    inRange('192.168.0.0', 16) ||
    inRange('100.64.0.0', 10) ||
    inRange('224.0.0.0', 4)
  );
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

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped 地址按内嵌 IPv4 判断，否则 ::ffff:127.0.0.1 会绕过检查。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  const bytes = ipv6Bytes(lower);
  if (!bytes) return true;
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
    throw Object.assign(new Error('invalid url'), { statusCode: 400, code: 'INVALID_INPUT' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('only http/https urls are allowed'), {
      statusCode: 400,
      code: 'INVALID_INPUT',
    });
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
      throw Object.assign(new Error(`cannot resolve host ${host}`), {
        statusCode: 400,
        code: 'INVALID_INPUT',
      });
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw Object.assign(new Error('url resolves to a private address'), {
      statusCode: 400,
      code: 'SSRF_BLOCKED',
    });
  }
}
