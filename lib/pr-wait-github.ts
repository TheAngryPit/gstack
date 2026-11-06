/**
 * pr-wait-github — the GitHub read side of gstack-pr-wait: a gh runner that
 * retries transient failures, the one GraphQL read of a pull request, its
 * checks from `gh pr checks`, the required-check names from rulesets and
 * classic branch protection, and the base-branch comparisons. The event logic
 * is lib/pr-wait.ts; the two are split so each stays under the module-size
 * ratchet.
 *
 * Design ported from tstack's `pr-wait` (t3dotgg/tstack,
 * skills/babysit-pr/scripts/pr-wait at 7de017b, MIT, Copyright (c) 2026 Theo
 * Browne; NOTICE.md and licenses/MIT-tstack.txt), rewritten in TypeScript on
 * gstack's gh runner shape (lib/ci-gate.ts).
 */
import type { GhResult, GhRunner } from './ci-gate';

export class GhError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
    this.name = 'GhError';
  }
}

export interface GhEnv {
  gh: GhRunner;
  sleep(ms: number): void;
  log(message: string): void;
}

export type BucketClass = 'pass' | 'pending' | 'fail';

export interface Actor { login: string; bot: boolean }
export interface Comment { id: string; url: string; body: string; author: Actor }
export interface Review { id: string; url: string; state: string; body: string; commitOid: string | null; author: Actor }
export interface Thread { isResolved: boolean; path: string; line: number | null; comments: Comment[] }
export interface PullRequest {
  url: string;
  state: string;
  headRefOid: string;
  baseRefName: string;
  mergeStateStatus: string;
  baseOid: string | null;
  author: string;
  viewer: string;
  comments: Comment[];
  reviews: Review[];
  threads: Thread[];
}
export interface Check { name: string; bucket: string; link: string; description: string }

const TRANSIENT = /HTTP (5\d\d|429)|rate limit|timed? ?out|connection (reset|refused)|EOF|temporar|could not resolve host|TLS handshake|Something went wrong/i;
const RETRIES = 5;
const PASS_BUCKETS = new Set(['pass', 'skipping', 'neutral']);
/** Worst bucket first, for collapsing duplicate check names (push and pull_request runs of one job). */
const RANK: Record<BucketClass, number> = { fail: 2, pending: 1, pass: 0 };

export const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url state headRefOid baseRefName mergeStateStatus
      author { login }
      baseRef { target { oid } }
      comments(last: 100) { nodes { id url body author { login __typename } } }
      reviews(last: 100) {
        nodes { id url state body commit { oid } author { login __typename } }
      }
      reviewThreads(last: 100) {
        nodes {
          isResolved path line
          comments(first: 100) { nodes { id url body author { login __typename } } }
        }
      }
    }
  }
}
`;

export function bucketClass(bucket: string): BucketClass {
  if (PASS_BUCKETS.has(bucket)) return 'pass';
  return bucket === 'pending' ? 'pending' : 'fail';
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}

/** Run gh. A transient failure (HTTP 5xx or 429, network) is retried with doubling backoff. */
export function runGh(env: GhEnv, args: string[], allow: number[] = [0]): GhResult {
  let delay = 2_000;
  for (let attempt = 1; ; attempt++) {
    const result = env.gh(args);
    // gh missing is fatal; any other spawn failure (its 60 s timeout, a signal) is a slow API, so retry.
    if (result.error && /not installed/.test(result.error)) throw new GhError(result.error, false);
    const status = result.status ?? -1;
    const transient = status !== 0 && (result.error !== undefined || result.status === null || TRANSIENT.test(result.stderr));
    if (!transient && allow.includes(status)) return result;
    const message = result.error ?? (lastLine(result.stderr) || `gh exited ${status}`);
    if (!transient || attempt === RETRIES) throw new GhError(message, transient);
    env.log(`gh ${args.slice(0, 2).join(' ')}: ${message}; retry in ${delay / 1000}s`);
    env.sleep(delay);
    delay *= 2;
  }
}

function ghLines(env: GhEnv, args: string[]): string[] {
  return runGh(env, args).stdout.split(/\r?\n/).filter(Boolean);
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const nodes = (value: unknown): Json[] => {
  const list = obj(value).nodes;
  return Array.isArray(list) ? list.map(obj) : [];
};
const actor = (node: Json): Actor => {
  const author = obj(node.author);
  return { login: str(author.login) || 'ghost', bot: author.__typename === 'Bot' };
};
const comment = (node: Json): Comment => ({ id: str(node.id), url: str(node.url), body: str(node.body), author: actor(node) });

/** The current owner/name of the checkout's GitHub repository. */
export function currentRepo(env: GhEnv): string {
  return runGh(env, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).stdout.trim();
}

/** Confirms the PR exists and is readable; throws GhError otherwise. */
export function confirmPullRequest(env: GhEnv, repo: string, pr: number): void {
  runGh(env, ['pr', 'view', String(pr), '-R', repo, '--json', 'number']);
}

export function fetchPullRequest(env: GhEnv, repo: string, pr: number): PullRequest {
  const [owner, name] = repo.split('/');
  const result = runGh(env, ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]);
  let parsed: Json;
  try { parsed = obj(JSON.parse(result.stdout)); } catch {
    throw new GhError('gh api graphql printed output that is not JSON', false);
  }
  const node = obj(obj(obj(parsed.data).repository).pullRequest);
  if (!str(node.headRefOid)) {
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(e => str(obj(e).message)).filter(Boolean).join('; ') : '';
    throw new GhError(errors || `${repo}#${pr} is not a pull request GitHub returned`, false);
  }
  return {
    url: str(node.url),
    state: str(node.state),
    headRefOid: str(node.headRefOid),
    baseRefName: str(node.baseRefName),
    mergeStateStatus: str(node.mergeStateStatus) || 'UNKNOWN',
    baseOid: str(obj(obj(node.baseRef).target).oid) || null,
    author: str(obj(node.author).login) || 'ghost',
    viewer: str(obj(obj(parsed.data).viewer).login),
    comments: nodes(node.comments).map(comment),
    reviews: nodes(node.reviews).map(r => ({ ...comment(r), state: str(r.state), commitOid: str(obj(r.commit).oid) || null })),
    threads: nodes(node.reviewThreads).map(t => ({
      isResolved: t.isResolved === true,
      path: str(t.path),
      line: typeof t.line === 'number' ? t.line : null,
      comments: nodes(t.comments).map(comment),
    })),
  };
}

/**
 * Every check on the PR head by name, duplicates collapsed to the worst
 * bucket. `gh pr checks` exits 8 while checks run and 1 when one failed:
 * those are states, so the JSON is read whatever the exit status.
 */
export function fetchChecks(env: GhEnv, repo: string, pr: number): Map<string, Check> {
  const result = runGh(env, ['pr', 'checks', String(pr), '-R', repo, '--json', 'name,bucket,link,description'], [0, 1, 8]);
  const checks = new Map<string, Check>();
  if (!result.stdout.trim()) {
    if (/no checks reported/.test(result.stderr)) return checks;
    throw new GhError(lastLine(result.stderr) || `gh pr checks exited ${result.status}`, false);
  }
  let rows: unknown;
  try { rows = JSON.parse(result.stdout); } catch {
    throw new GhError('gh pr checks printed output that is not JSON', false);
  }
  if (!Array.isArray(rows)) throw new GhError('gh pr checks JSON is not a list', false);
  for (const raw of rows.map(obj)) {
    const name = str(raw.name);
    if (!name) continue;
    const row: Check = { name, bucket: str(raw.bucket) || 'pending', link: str(raw.link), description: str(raw.description) };
    const current = checks.get(name);
    if (!current || RANK[bucketClass(row.bucket)] > RANK[bucketClass(current.bucket)]) checks.set(name, row);
  }
  return checks;
}

/**
 * Required check names for the base branch, from rulesets and classic branch
 * protection. Reading them up front means a required check that has not
 * started yet counts as pending instead of green by omission. A 404 means no
 * protection of that kind, which is normal; any other failure is logged, that
 * source contributes nothing, and `known` is false: the set may be short, so a
 * caller that would relax the gate on it (`--exclude`) must not.
 */
export function requiredChecks(env: GhEnv, repo: string, base: string): { names: Set<string>; known: boolean } {
  const sources: Array<[string, string]> = [
    [`repos/${repo}/rules/branches/${base}`, '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'],
    [`repos/${repo}/branches/${base}/protection/required_status_checks`, '.contexts[]?, .checks[]?.context'],
  ];
  const names = new Set<string>();
  let known = true;
  for (const [path, jq] of sources) {
    try {
      for (const name of ghLines(env, ['api', path, '--jq', jq])) names.add(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP 404/.test(message)) continue;
      known = false;
      env.log(`could not read required checks from ${path}: ${message}`);
    }
  }
  return { names, known };
}

/** Files the PR changes, from `gh pr diff --name-only`. */
export function pullRequestFiles(env: GhEnv, repo: string, pr: number): Set<string> {
  return new Set(ghLines(env, ['pr', 'diff', String(pr), '-R', repo, '--name-only']));
}

/** Files the commits between two base-branch heads changed. */
export function compareFiles(env: GhEnv, repo: string, from: string, to: string): string[] {
  return ghLines(env, ['api', `repos/${repo}/compare/${from}...${to}`, '--jq', '.files[].filename']);
}

/** How many commits the head is behind the base head, or null when unreadable. */
export function behindBy(env: GhEnv, repo: string, baseOid: string, head: string): string | null {
  try {
    return runGh(env, ['api', `repos/${repo}/compare/${baseOid}...${head}`, '--jq', '.behind_by']).stdout.trim() || null;
  } catch {
    return null;
  }
}
