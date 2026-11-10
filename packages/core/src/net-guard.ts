import { BlockList, isIP } from 'node:net';

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
