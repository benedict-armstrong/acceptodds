import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Build `config/institution-domains.json`, the sign-up allowlist
 * (`server/institution-domains.ts`), from public sources:
 *
 * - **swot** (JetBrains, MIT): academic email domains, each added by a
 *   reviewed pull request, since they grant free licences. The backbone.
 *   Domains swot itself lists as abused or stopped are left out.
 * - **ROR** (Research Organization Registry, CC0): every active
 *   organisation with a curated `domains` entry, of any type but `company`.
 *   Universities, research institutes, labs, hospitals, agencies: the
 *   places papers come from. ROR's companies include ISPs and mail
 *   providers, so companies come only from the curated list.
 * - **Hipo university-domains-list** (MIT), looser, so only its domains in
 *   an academic namespace (`edu`, `ac`, `edu.xx`, `ac.xx`, …) that only
 *   institutions can register.
 * - **`config/institution-domains.curated.json`**: companies that do
 *   research and institutes the sources miss, plus `exclude`. It wins.
 *
 * Every generated domain must pass two filters: it is not a public suffix
 * (a listed `edu.cn` would admit every Chinese university, and a mistake like
 * it everyone under it), and, unless swot or the curated list vouches for it,
 * it is not a known free-mail domain. Where sources disagree on a name,
 * curated beats ROR beats swot beats Hipo.
 *
 *   npm run institutions:build            # downloads into .cache/, rebuilds
 *   npm run institutions:build -- --offline  # reuse what .cache/ holds
 */

const CACHE = '.cache/institution-sources';
const OUT = 'config/institution-domains.json';
const CURATED = 'config/institution-domains.curated.json';

const SWOT_REPO = 'https://github.com/JetBrains/swot.git';
const HIPO_URL =
  'https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json';
const ROR_RECORDS = 'https://zenodo.org/api/records?communities=ror-data&sort=mostrecent&size=1';
const PSL_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const FREEMAIL_URL = 'https://raw.githubusercontent.com/Kikobeats/free-email-domains/master/domains.json';

/**
 * Second-level labels countries use as registries (`ac.cd`, `co.cu`,
 * `edu.na`). The Public Suffix List misses some; a source that lists one as
 * an institution's domain would admit everyone registered under it.
 */
const REGISTRY_LABELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'go',
  'gob',
  'gov',
  'mil',
  'ne',
  'net',
  'or',
  'org',
  'sch',
  'school',
]);

/** Namespaces only institutions can register in; see Hipo above. */
const ACADEMIC_LABELS = new Set(['edu', 'ac']);

const offline = process.argv.includes('--offline');

type Source = 'curated' | 'ror' | 'swot' | 'hipo';
const PRIORITY: Record<Source, number> = { curated: 0, ror: 1, swot: 2, hipo: 3 };

function normalise(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
}

async function download(url: string, file: string): Promise<string> {
  const path = join(CACHE, file);
  if (offline && existsSync(path)) return path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

function swot(): { domains: Map<string, string>; bad: Set<string>; version: string } {
  const dir = join(CACHE, 'swot');
  if (!existsSync(dir)) execFileSync('git', ['clone', '--quiet', '--depth', '1', SWOT_REPO, dir]);
  else if (!offline) execFileSync('git', ['-C', dir, 'pull', '--quiet', '--ff-only']);
  const version = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const root = join(dir, 'lib/domains');
  const lines = (file: string) => readFileSync(join(root, file), 'utf8').split('\n').map(normalise).filter(Boolean);
  const bad = new Set([...lines('abused.txt'), ...lines('stoplist.txt')]);

  // lib/domains/edu/mit.txt is mit.edu; its first line is the name.
  const domains = new Map<string, string>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (at !== root && entry.endsWith('.txt')) {
        const domain = relative(root, path).slice(0, -4).split(sep).reverse().join('.');
        const name = readFileSync(path, 'utf8').split('\n')[0].trim();
        if (name) domains.set(normalise(domain), name);
      }
    }
  };
  walk(root);
  return { domains, bad, version: `JetBrains/swot@${version.slice(0, 12)}` };
}

interface RorOrg {
  status: string;
  types: string[];
  domains?: string[];
  names: { value: string; types: string[] }[];
  relationships?: { type: string }[];
}

async function ror(): Promise<{ domains: Map<string, string>; version: string }> {
  let file = readdirSync(CACHE).find((f) => f.endsWith('-ror-data.json'));
  if (!offline || !file) {
    const record = (await (await fetch(ROR_RECORDS)).json()) as {
      hits: { hits: { files: { key: string; links: { self: string } }[] }[] };
    };
    const zip = record.hits.hits[0].files.find((f) => f.key.endsWith('.zip'));
    if (!zip) throw new Error('no ROR data zip on Zenodo');
    file = zip.key.replace(/\.zip$/, '.json');
    if (!existsSync(join(CACHE, file))) {
      const path = await download(zip.links.self, zip.key);
      execFileSync('unzip', ['-oq', path, file, '-d', CACHE]);
    }
  }
  const orgs = JSON.parse(readFileSync(join(CACHE, file), 'utf8')) as RorOrg[];

  // A domain several organisations claim (a university and its institutes)
  // takes the name of the top of the tree: no parent, then the shortest name.
  const claims = new Map<string, { name: string; rank: number }>();
  for (const org of orgs) {
    if (org.status !== 'active' || org.types.includes('company')) continue;
    const name = org.names.find((n) => n.types.includes('ror_display'))?.value;
    if (!name) continue;
    const rank = (org.relationships?.some((r) => r.type === 'parent') ? 1e6 : 0) + name.length;
    for (const d of org.domains ?? []) {
      const domain = normalise(d);
      const held = claims.get(domain);
      if (!held || rank < held.rank) claims.set(domain, { name, rank });
    }
  }
  const domains = new Map([...claims].map(([d, c]) => [d, c.name]));
  return { domains, version: `ROR ${file.replace(/-ror-data\.json$/, '')}` };
}

async function hipo(): Promise<Map<string, string>> {
  const path = await download(HIPO_URL, 'hipo.json');
  const list = JSON.parse(readFileSync(path, 'utf8')) as { name: string; domains: string[] }[];
  const domains = new Map<string, string>();
  for (const u of list) {
    for (const d of u.domains) {
      const domain = normalise(d);
      const labels = domain.split('.');
      // mit.edu, x.ac.uk, x.edu.cn; not x.gov.au or x.com.
      const academic = labels.at(-1) === 'edu' || (labels.length > 2 && ACADEMIC_LABELS.has(labels.at(-2)!));
      if (academic) domains.set(domain, u.name);
    }
  }
  return domains;
}

async function publicSuffixes(): Promise<Set<string>> {
  const path = await download(PSL_URL, 'public_suffix_list.dat');
  const set = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const rule = line.trim();
    if (!rule || rule.startsWith('//')) continue;
    // Kept literally: `*.ck` makes every x.ck a suffix, which main() checks.
    // An exception (`!www.ck`) is kept as a suffix too, which only drops it.
    set.add(rule.replace(/^!/, '').toLowerCase());
  }
  return set;
}

async function freemail(): Promise<Set<string>> {
  const path = await download(FREEMAIL_URL, 'freemail.json');
  return new Set((JSON.parse(readFileSync(path, 'utf8')) as string[]).map(normalise));
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const curated = JSON.parse(readFileSync(CURATED, 'utf8')) as {
    domains: Record<string, string>;
    exclude: string[];
  };
  const [sw, rr, hp, psl, free] = [swot(), await ror(), await hipo(), await publicSuffixes(), await freemail()];

  const exclude = new Set(curated.exclude.map(normalise));
  const under = (domain: string, set: Set<string>) => {
    const labels = domain.split('.');
    return labels.some((_, i) => set.has(labels.slice(i).join('.')));
  };

  const picked = new Map<string, { name: string; source: Source }>();
  const dropped: Record<string, number> = {
    publicSuffix: 0,
    registry: 0,
    freemail: 0,
    swotAbused: 0,
    excluded: 0,
    malformed: 0,
  };
  const offer = (domain: string, name: string, source: Source) => {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return void dropped.malformed++;
    if (under(domain, exclude)) return void dropped.excluded++;
    if (source !== 'curated') {
      const labels = domain.split('.');
      if (psl.has(domain) || psl.has(`*.${labels.slice(1).join('.')}`)) return void dropped.publicSuffix++;
      if (labels.length === 2 && labels[1].length === 2 && REGISTRY_LABELS.has(labels[0]))
        return void dropped.registry++;
      if (under(domain, sw.bad)) return void dropped.swotAbused++;
      if (source !== 'swot' && free.has(domain) && !sw.domains.has(domain)) return void dropped.freemail++;
    }
    const held = picked.get(domain);
    if (!held || PRIORITY[source] < PRIORITY[held.source]) picked.set(domain, { name: name.trim(), source });
  };

  for (const [d, n] of Object.entries(curated.domains)) offer(normalise(d), n, 'curated');
  for (const [d, n] of rr.domains) offer(d, n, 'ror');
  for (const [d, n] of sw.domains) offer(d, n, 'swot');
  for (const [d, n] of hp) offer(d, n, 'hipo');

  const bySource: Record<Source, number> = { curated: 0, ror: 0, swot: 0, hipo: 0 };
  for (const { source } of picked.values()) bySource[source]++;

  const domains = Object.fromEntries(
    [...picked].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([d, { name }]) => [d, name]),
  );
  const out = {
    about: `Generated by scripts/build-institution-domains.ts; do not edit. Change ${CURATED} and rebuild.`,
    sources: [sw.version, rr.version, 'Hipo/university-domains-list', CURATED],
    domains,
  };
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${OUT}: ${picked.size} domains`, bySource, 'dropped', dropped);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
