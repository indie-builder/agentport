import { beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

import { assertSafeUrl } from '../src/features/servers/ssrf.js';

const DEV = 'development';
const PROD = 'production';

async function expectBlocked(raw: string, nodeEnv: string = PROD): Promise<void> {
  await expect(assertSafeUrl(raw, nodeEnv)).rejects.toMatchObject({ code: 'INVALID_URL' });
}

async function expectAllowed(raw: string, nodeEnv: string = PROD): Promise<void> {
  await expect(assertSafeUrl(raw, nodeEnv)).resolves.toBeUndefined();
}

beforeEach(() => {
  dns.lookup.mockReset();
});

describe('IPv4 private ranges', () => {
  // 每个网段都取 CIDR 首尾，外加紧邻网段外侧的可用地址。
  const ranges = [
    { cidr: '0.0.0.0/8', blocked: ['0.0.0.0', '0.255.255.255'], allowed: ['1.0.0.0'] },
    {
      cidr: '10.0.0.0/8',
      blocked: ['10.0.0.0', '10.255.255.255'],
      allowed: ['9.255.255.255', '11.0.0.0'],
    },
    {
      cidr: '127.0.0.0/8',
      blocked: ['127.0.0.0', '127.255.255.255'],
      allowed: ['126.255.255.255', '128.0.0.0'],
    },
    {
      cidr: '169.254.0.0/16',
      blocked: ['169.254.0.0', '169.254.255.255'],
      allowed: ['169.253.255.255', '169.255.0.0'],
    },
    {
      cidr: '172.16.0.0/12',
      blocked: ['172.16.0.0', '172.31.255.255'],
      allowed: ['172.15.255.255', '172.32.0.0'],
    },
    {
      cidr: '192.168.0.0/16',
      blocked: ['192.168.0.0', '192.168.255.255'],
      allowed: ['192.167.255.255', '192.169.0.0'],
    },
    {
      cidr: '100.64.0.0/10',
      blocked: ['100.64.0.0', '100.127.255.255'],
      allowed: ['100.63.255.255', '100.128.0.0'],
    },
    {
      cidr: '192.0.0.0/24',
      blocked: ['192.0.0.0', '192.0.0.255'],
      allowed: ['191.255.255.255', '192.0.1.0'],
    },
    {
      cidr: '192.88.99.0/24',
      blocked: ['192.88.99.0', '192.88.99.255'],
      allowed: ['192.88.98.255', '192.88.100.0'],
    },
    {
      cidr: '224.0.0.0/4',
      blocked: ['224.0.0.0', '239.255.255.255'],
      allowed: ['223.255.255.255'],
    },
    {
      cidr: '240.0.0.0/4',
      // 255.255.255.255 属于 240/4，不需要单独的精确匹配。
      blocked: ['240.0.0.0', '255.255.255.255'],
      allowed: ['223.255.255.255'],
    },
  ];

  it.each(ranges)(
    '$cidr blocks its boundaries and allows adjacent public addresses',
    async ({ blocked, allowed }) => {
      for (const ip of blocked) await expectBlocked(`http://${ip}/`);
      for (const ip of allowed) await expectAllowed(`http://${ip}/`);
    },
  );
});

describe('IPv6 private ranges', () => {
  it.each([
    ['loopback', '::1', false],
    ['unspecified', '::', false],
    ['unique local', 'fd00::1', false],
    ['link local', 'fe80::1', false],
    ['public', '2001:4860:4860::8888', true],
  ])('handles %s address %s', async (_label, ip, isPublic) => {
    const url = `http://[${ip}]/`;
    if (isPublic) await expectAllowed(url);
    else await expectBlocked(url);
  });
});

describe('IPv4 embedded in IPv6', () => {
  it.each([
    ['mapped private', '::ffff:127.0.0.1', false],
    ['mapped public', '::ffff:8.8.8.8', true],
    ['hex mapped private', '::ffff:7f00:1', false],
    ['hex mapped public', '::ffff:808:808', true],
    ['NAT64 private', '64:ff9b::7f00:1', false],
    ['NAT64 public', '64:ff9b::808:808', true],
  ])('handles %s %s', async (_label, ip, isPublic) => {
    const url = `http://[${ip}]/`;
    if (isPublic) await expectAllowed(url);
    else await expectBlocked(url);
  });
});

describe('DNS resolution', () => {
  it('allows a host when every resolved address is public', async () => {
    dns.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ]);
    await expectAllowed('http://public.example/');
    expect(dns.lookup).toHaveBeenCalledWith('public.example', { all: true });
  });

  it('rejects a host when any resolved IPv4 address is private', async () => {
    dns.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expectBlocked('http://mixed.example/');
  });

  it('rejects a host when any resolved IPv6 address is private', async () => {
    dns.lookup.mockResolvedValue([
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '::1', family: 6 },
    ]);
    await expectBlocked('http://mixed-ipv6.example/');
  });

  it('rejects a decimal IPv4-mapped address returned by DNS', async () => {
    dns.lookup.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    await expectBlocked('http://mapped.example/');
  });

  it('rejects an empty resolution result', async () => {
    dns.lookup.mockResolvedValue([]);
    await expectBlocked('http://empty.example/');
  });

  it('rejects a host that fails to resolve', async () => {
    dns.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expectBlocked('http://missing.example/');
  });
});

describe('development allowance', () => {
  it.each(['localhost', '127.0.0.1', '::1'])(
    'allows %s only outside production checks',
    async (host) => {
      const url = host.includes(':') ? `http://[${host}]/` : `http://${host}/`;
      await expectAllowed(url, DEV);
      dns.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expectBlocked(url, PROD);
    },
  );

  it('still rejects other private IPv4 addresses in development', async () => {
    await expectBlocked('http://10.0.0.1/', DEV);
  });

  it('still resolves and checks non-local hosts in development', async () => {
    dns.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expectBlocked('http://internal.example/', DEV);
  });
});

describe('URL validation', () => {
  it.each([
    ['non-http protocol', 'ftp://8.8.8.8/'],
    ['file protocol', 'file:///etc/passwd'],
    ['credentials', 'http://user:pass@8.8.8.8/'],
    ['username only', 'http://user@8.8.8.8/'],
    ['malformed URL', 'not a url'],
  ])('rejects %s', async (_label, raw) => {
    await expectBlocked(raw);
  });
});
