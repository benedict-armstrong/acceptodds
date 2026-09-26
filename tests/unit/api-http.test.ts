import { describe, expect, it } from 'vitest';
import { clientIp } from '@/server/api/http';
import { MicroInput } from '@/server/api/schemas';

describe('clientIp', () => {
  it('reads Cf-Connecting-Ip', () => {
    const req = new Request('http://x/', { headers: { 'Cf-Connecting-Ip': ' 203.0.113.7 ' } });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('never trusts X-Forwarded-For or X-Real-Ip', () => {
    const req = new Request('http://x/', {
      headers: { 'X-Forwarded-For': '198.51.100.1', 'X-Real-Ip': '198.51.100.2' },
    });
    expect(clientIp(req)).toBeNull();
  });
});

describe('MicroInput', () => {
  it('parses decimal strings and safe JSON integers to bigint', () => {
    expect(MicroInput.parse('123')).toBe(123n);
    expect(MicroInput.parse('-9223372036854775807')).toBe(-9223372036854775807n);
    expect(MicroInput.parse(42)).toBe(42n);
  });

  it('refuses floats, exponents, unsafe integers and out-of-range strings', () => {
    for (const bad of [1.5, '1e6', '1.0', '', ' 1', 2 ** 60, '9223372036854775808', null]) {
      expect(MicroInput.safeParse(bad).success).toBe(false);
    }
  });
});
