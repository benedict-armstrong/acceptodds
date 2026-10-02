import { describe, expect, it } from 'vitest';
import { ipNetwork } from '@/lib/ip-network';

describe('ipNetwork', () => {
  it('is an IPv4 address itself', () => {
    expect(ipNetwork('203.0.113.7')).toBe('203.0.113.7');
  });

  it('is the /64 of an IPv6 address, however it is written', () => {
    expect(ipNetwork('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipNetwork('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipNetwork('::1')).toBe('0:0:0:0::/64');
    expect(ipNetwork('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('is the IPv4 address of an IPv4-mapped one', () => {
    expect(ipNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipNetwork('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('is null for anything that is not an address', () => {
    expect(ipNetwork(null)).toBeNull();
    expect(ipNetwork('')).toBeNull();
    expect(ipNetwork('not an ip')).toBeNull();
    expect(ipNetwork('2001:db8::1, 10.0.0.1')).toBeNull();
  });
});
