import { isIPv4, isIPv6 } from 'node:net';

/**
 * The network an address stands for, as one visitor would hold it: an IPv4
 * address is itself, an IPv6 address its /64, since a single host is usually
 * handed a whole /64 and can rotate through 2^64 addresses at will. An
 * IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is its IPv4 address. Anything
 * that is not an address is `null`.
 */
export function ipNetwork(ip: string | null): string | null {
  if (!ip) return null;
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return null;
  const groups = expandIPv6(ip.split('%')[0]);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function expandIPv6(ip: string): number[] {
  let text = ip;
  // A trailing dotted quad is the last two groups.
  const quad = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    text = text.slice(0, quad.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const parse = (s: string | undefined) => (s ? s.split(':').map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  if (tail === undefined) return left;
  const right = parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}
