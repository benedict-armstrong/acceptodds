import { readFileSync } from 'node:fs';

/**
 * Email domain → research organisation, from the ROR data dump (§8).
 *
 * **Never called over the network at runtime.** A signup path that depends on
 * a third party being up is a signup path that is down. The dump is
 * downloaded by an operator, compacted by `npm run ror:index` into a
 * domain → organisation index, and the index is read from `ROR_INDEX_PATH`
 * (baked into the image or mounted as a volume, §11).
 *
 * Index format, versioned so a stale file fails loudly:
 * `{ "format": 1, "source": "<dump file>", "domains": { "ethz.ch": ["https://ror.org/05a28rw58", "ETH Zurich"] } }`
 */

export interface Institution {
  rorId: string;
  name: string;
}

export interface RorIndex {
  format: 1;
  source: string;
  domains: Record<string, [rorId: string, name: string]>;
}

let cached: { path: string; index: RorIndex } | undefined;

/** The index at `ROR_INDEX_PATH`, or `null` if none is configured. Throws on a malformed file. */
export function loadRorIndex(path = process.env.ROR_INDEX_PATH): RorIndex | null {
  if (!path) return null;
  if (cached?.path === path) return cached.index;
  const index = JSON.parse(readFileSync(path, 'utf8')) as RorIndex;
  if (index.format !== 1 || typeof index.domains !== 'object') {
    throw new Error(`${path} is not a format-1 ROR index; rebuild it with npm run ror:index`);
  }
  cached = { path, index };
  return index;
}

/**
 * The organisation an email domain belongs to, matching the domain or any
 * parent of it: `inf.ethz.ch` → `ethz.ch`. It never matches on fewer than two
 * labels, so a public suffix (`ac.uk`) is not an institution.
 */
export function institutionForDomain(domain: string, index: RorIndex): Institution | null {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; labels.length - i >= 2; i += 1) {
    const hit = index.domains[labels.slice(i).join('.')];
    if (hit) return { rorId: hit[0], name: hit[1] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// building the index from a dump
// ---------------------------------------------------------------------------

interface RorRecord {
  id: string;
  status?: string;
  domains?: string[];
  links?: { type?: string; value?: string }[];
  names?: { value: string; types?: string[] }[];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Compact a ROR schema-v2 dump (the JSON array in the Zenodo zip) into a
 * domain index. Only `active` organisations count. A record's `domains` are
 * used, falling back to its website's host. A domain claimed by more than one
 * organisation is dropped: an ambiguous domain verifies nobody.
 */
export function buildRorIndex(records: RorRecord[], source: string): RorIndex {
  const claims = new Map<string, [string, string][]>();
  for (const r of records) {
    if (r.status && r.status !== 'active') continue;
    const name =
      r.names?.find((n) => n.types?.includes('ror_display'))?.value ?? r.names?.[0]?.value ?? r.id;
    let domains = (r.domains ?? []).map((d) => d.toLowerCase().replace(/^www\./, ''));
    if (domains.length === 0) {
      const site = r.links?.find((l) => l.type === 'website')?.value;
      const host = site ? hostOf(site) : null;
      if (host) domains = [host];
    }
    for (const d of new Set(domains)) {
      if (d.split('.').length < 2) continue;
      const list = claims.get(d) ?? [];
      list.push([r.id, name]);
      claims.set(d, list);
    }
  }
  const domains: RorIndex['domains'] = {};
  for (const [d, list] of [...claims].sort(([a], [b]) => a.localeCompare(b))) {
    if (new Set(list.map(([id]) => id)).size === 1) domains[d] = list[0];
  }
  return { format: 1, source, domains };
}
