import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HTTP_URL_ONLY_MESSAGE, URL_CREDENTIALS_MESSAGE } from '@agentport/shared';
import ipaddr from 'ipaddr.js';
import { fail } from './errors.js';

const NAT64_PREFIX = ipaddr.IPv6.parseCIDR('64:ff9b::/96');
const DEV_PROXY_V4 = ipaddr.IPv4.parseCIDR('198.18.0.0/15');
const DEV_PROXY_V6 = ipaddr.IPv6.parseCIDR('2001:2::/48');

function stripAddress(ip: string): string {
  return ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
}

export function isPrivateAddress(ip: string, allowDevProxy = false): boolean {
  const address = stripAddress(ip);
  if (!isIP(address)) return true;
  const parsed = ipaddr.process(address);
  if (allowDevProxy && parsed.match(parsed instanceof ipaddr.IPv6 ? DEV_PROXY_V6 : DEV_PROXY_V4))
    return false;
  if (parsed instanceof ipaddr.IPv6 && parsed.match(NAT64_PREFIX)) {
    return ipaddr.fromByteArray(parsed.toByteArray().slice(-4)).range() !== 'unicast';
  }
  return parsed.range() !== 'unicast';
}

export function isLoopbackAddress(ip: string): boolean {
  const address = stripAddress(ip);
  return isIP(address)
    ? ipaddr.process(address).range() === 'loopback'
    : address.toLowerCase() === 'localhost';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isDevLocal(host: string, nodeEnv: string | undefined, allowDevLocal: boolean): boolean {
  return allowDevLocal && nodeEnv === 'development' && LOCAL_HOSTS.has(host.toLowerCase());
}

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
    fail('INVALID_URL', HTTP_URL_ONLY_MESSAGE);
  }
  if (url.username || url.password) {
    fail('INVALID_URL', URL_CREDENTIALS_MESSAGE);
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
  if (
    addresses.length === 0 ||
    addresses.some((address) => isPrivateAddress(address, nodeEnv === 'development'))
  ) {
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
