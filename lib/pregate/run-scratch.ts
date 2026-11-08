/**
 * pregate/run-scratch — one scratch directory per run under the state root
 * (Lane D, GSTA-112): `<state root>/projects/<slug>/pregate/runs/<run id>/`.
 * Every check keeps its working files there (the secrets scan's added-line
 * copies, the lane and guard logs, the remote gate's file list) instead of
 * os.tmpdir(): two pregates running at once never share a path (a taken
 * `--run <id>` takes a numbered sibling), and the log a `fix:` line names
 * survives a host that wipes /tmp between wakes (gbrain 16). The record names
 * the directory. Runs older than the retention are pruned
 * best-effort when a new run starts; the current run is never pruned.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SCRATCH_RETENTION_MS = 7 * 24 * 3600 * 1000;
const MAX_RUN_ID = 96;

/** A filesystem-safe run id: `--run <id>` reduced to [A-Za-z0-9._-], else `<utc stamp>-<pid>-<4 hex>`. */
export function scratchRunId(requested?: string, pid: number = process.pid): string {
  const cleaned = (requested ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, MAX_RUN_ID);
  if (cleaned) return cleaned;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${pid}-${randomBytes(2).toString('hex')}`;
}

/** How many numbered siblings a taken run id may fall back to before the run refuses. */
const MAX_RUN_ID_SIBLINGS = 9;

/**
 * `<runsRoot>/<run id>`, created 0700 (and its parents), after pruning old
 * siblings. The leaf is created without `recursive`, so a directory that
 * already exists (a second `--run <id>` beside a live run, or a finished one
 * under the same name) is never shared: the run takes `<run id>-2` … `-9`
 * instead, and the record names the directory it got.
 */
export function createScratch(runsRoot: string, runId: string): string {
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  pruneScratch(runsRoot, runId);
  for (let n = 1; n <= MAX_RUN_ID_SIBLINGS; n++) {
    const dir = path.join(runsRoot, n === 1 ? runId : `${runId}-${n}`);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e: any) { if (e?.code === 'EEXIST') continue; throw e; }
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on hosts without POSIX modes */ }
    return dir;
  }
  throw new Error(`run directory ${path.join(runsRoot, runId)} and its ${MAX_RUN_ID_SIBLINGS - 1} numbered siblings all exist; choose another --run id`);
}

/** Remove sibling run directories older than the retention, never `keep` (the current run); every failure is ignored. */
export function pruneScratch(runsRoot: string, keep: string, now: number = Date.now()): void {
  let names: string[];
  try { names = fs.readdirSync(runsRoot); } catch { return; }
  for (const name of names) {
    if (name === keep) continue;
    const dir = path.join(runsRoot, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < SCRATCH_RETENTION_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* another run may hold it; leave it */ }
  }
}

/** A fresh subdirectory of the run's scratch for one check (`lanes`, `guards`, `secrets`, `remote`). */
export function checkScratch(scratch: string, check: string): string {
  const dir = path.join(scratch, check);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
