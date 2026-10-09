import { execFileSync } from 'node:child_process';
import pkg from '../../package.json';

/** When this server process started: a deploy restarts it, so a client sees a new one even without a commit. */
const STARTED_AT = new Date();

/**
 * What is running, for `GET /version`: the package version, the git commit
 * and when the process started. The commit is `GIT_COMMIT`, stamped into the
 * image at build time (the Docker build has no `.git`; the deploy exports
 * `GIT_COMMIT`, see docker-compose.prod.yml), else, outside production, read from
 * the checkout, else null (as is the image's `unknown`, a build without it).
 */
export function runningVersion(): { version: string; commit: string | null; startedAt: Date } {
  return { version: pkg.version, commit: commit(), startedAt: STARTED_AT };
}

function commit(): string | null {
  const stamped = process.env.GIT_COMMIT?.trim();
  if (stamped && stamped !== 'unknown') return stamped;
  if (process.env.NODE_ENV === 'production') return null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
