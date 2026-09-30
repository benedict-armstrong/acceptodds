import { readFileSync } from 'node:fs';

/**
 * Who may sign up: an allowlist of institutional email domains.
 *
 * For now this **is** institutional verification. Sign-up is refused for an
 * address whose domain is not on the list, and confirming the address (Better
 * Auth's email verification) proves the person controls a mailbox at that
 * institution. That is what sets `accounts.verified_at` and unlocks trading.
 *
 * The list is a JSON file, `config/institution-domains.json` by default
 * (`INSTITUTION_DOMAINS_PATH` overrides it), mapping a domain to the
 * institution's display name:
 *
 *   { "domains": { "ethz.ch": "ETH Zurich", "ox.ac.uk": "University of Oxford" } }
 *
 * A domain also admits its subdomains (`inf.ethz.ch` matches `ethz.ch`), and
 * matching never goes below two labels, so a bare TLD on the list admits
 * nobody. List exact institutional domains: `ac.uk` would admit every UK
 * university. The file is read once per process; restart after changing it.
 *
 * The file is generated (`npm run institutions:build`) from swot, ROR and
 * Hipo's list plus `config/institution-domains.curated.json`; see
 * `scripts/build-institution-domains.ts`. Edit the curated file, not it.
 */

export interface Institution {
  domain: string;
  name: string;
}

const DEFAULT_PATH = 'config/institution-domains.json';

let cached: { path: string; domains: Map<string, string> } | undefined;

function domains(): Map<string, string> {
  const path = process.env.INSTITUTION_DOMAINS_PATH || DEFAULT_PATH;
  if (cached?.path === path) return cached.domains;
  // Read at runtime from the working directory; the image copies config/ in
  // itself. Traced, this one read pulls the whole project into standalone.
  const parsed = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8')) as { domains?: Record<string, unknown> };
  if (!parsed.domains || typeof parsed.domains !== 'object') {
    throw new Error(`${path} must be { "domains": { "<domain>": "<institution name>" } }`);
  }
  const map = new Map<string, string>();
  for (const [domain, name] of Object.entries(parsed.domains)) {
    if (typeof name !== 'string' || !name) throw new Error(`${path}: "${domain}" needs an institution name`);
    map.set(normalise(domain), name);
  }
  cached = { path, domains: map };
  return map;
}

function normalise(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** The institution an email address belongs to, or `null` if its domain is not on the list. */
export function institutionForEmail(email: string): Institution | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const labels = normalise(email.slice(at + 1)).split('.');
  const list = domains();
  for (let i = 0; labels.length - i >= 2; i += 1) {
    const domain = labels.slice(i).join('.');
    const name = list.get(domain);
    if (name) return { domain, name };
  }
  return null;
}

/** How many institutions are on the allowlist, for telling people who may sign up. */
export function allowedInstitutionCount(): number {
  return new Set(domains().values()).size;
}
