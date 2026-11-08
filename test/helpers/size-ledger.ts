/**
 * Size ledger for a carved skill's union bytes (GSTA-132).
 *
 * A guard with `sizeLedger` replaces the one-tree `maxSizeRatio` pin: the
 * skill's union bytes must equal `base.json`'s `union_bytes` plus the sum of
 * one entry per branch that changed them (`<branch>.json`: `{ bytes, why }`).
 * An entry is a property of its branch's own diff, so it survives base merges
 * and composes across a merge train: a clean three-way merge adds byte deltas
 * exactly, and overlapping hunks are a train conflict. Equality, not a ceiling:
 * an undeclared shrink would leave headroom a later branch could spend without
 * declaring it. Record an entry with
 * `bun --no-env-file --config=/dev/null scripts/size-ledger.ts record <skill> --why "<what changed>"`.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SizeLedger {
  dir: string;
  base: { union_bytes: number; measured_at: string };
  entries: Array<{ file: string; bytes: number; why: string }>;
}

export const LEDGER_ENTRY = /^[a-z0-9][a-z0-9._-]*\.json$/;

export function recordCommand(skill: string): string {
  return `bun --no-env-file --config=/dev/null scripts/size-ledger.ts record ${skill} --why "<what changed>"`;
}

/** Branch name to entry filename: lowercase, [a-z0-9._-] only. */
export function entryFile(branch: string): string {
  const slug = branch.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '');
  if (!slug || slug === 'base') throw new Error(`branch ${JSON.stringify(branch)} gives no usable ledger entry name; pass --branch <name>`);
  return `${slug}.json`;
}

export function readSizeLedger(repoRoot: string, dir: string): SizeLedger | { error: string } {
  const abs = path.join(repoRoot, dir);
  let base: unknown;
  try { base = JSON.parse(fs.readFileSync(path.join(abs, 'base.json'), 'utf-8')); } catch (err) { return { error: `${dir}/base.json unreadable: ${(err as Error).message}` }; }
  const b = base as { union_bytes?: unknown; measured_at?: unknown };
  if (!Number.isSafeInteger(b.union_bytes) || (b.union_bytes as number) <= 0 || typeof b.measured_at !== 'string' || !b.measured_at.trim()) {
    return { error: `${dir}/base.json needs a positive integer union_bytes and a measured_at` };
  }
  const entries: SizeLedger['entries'] = [];
  for (const file of fs.readdirSync(abs).sort()) {
    if (!file.endsWith('.json') || file === 'base.json') continue;
    if (!LEDGER_ENTRY.test(file)) return { error: `${dir}/${file}: entry names are [a-z0-9._-] ending in .json` };
    let e: { bytes?: unknown; why?: unknown };
    try { e = JSON.parse(fs.readFileSync(path.join(abs, file), 'utf-8')); } catch (err) { return { error: `${dir}/${file} unreadable: ${(err as Error).message}` }; }
    if (!Number.isSafeInteger(e.bytes) || e.bytes === 0 || typeof e.why !== 'string' || !e.why.trim()) {
      return { error: `${dir}/${file} needs a non-zero integer bytes and a why` };
    }
    entries.push({ file, bytes: e.bytes as number, why: e.why });
  }
  return { dir, base: { union_bytes: b.union_bytes as number, measured_at: b.measured_at }, entries };
}

export const ledgerExpected = (l: SizeLedger) => l.base.union_bytes + l.entries.reduce((n, e) => n + e.bytes, 0);

/** Set `branch`'s entry to what `measured` differs from the base plus every other entry; zero deletes it. */
export function recordEntry(repoRoot: string, ledger: SizeLedger, measured: number, branch: string, why: string): { file: string; bytes: number } {
  const file = entryFile(branch);
  const bytes = measured - ledger.base.union_bytes - ledger.entries.filter(e => e.file !== file).reduce((n, e) => n + e.bytes, 0);
  const target = path.join(repoRoot, ledger.dir, file);
  if (bytes === 0) fs.rmSync(target, { force: true });
  else fs.writeFileSync(target, JSON.stringify({ bytes, why: why.trim() }, null, 2) + '\n');
  return { file, bytes };
}

/** Move the entries' sum into base.json and delete them; the caller checks the ledger holds first. */
export function foldLedger(repoRoot: string, ledger: SizeLedger, measuredAt: string): number {
  const total = ledgerExpected(ledger);
  const abs = path.join(repoRoot, ledger.dir);
  fs.writeFileSync(path.join(abs, 'base.json'), JSON.stringify({ union_bytes: total, measured_at: measuredAt.trim() }, null, 2) + '\n');
  for (const e of ledger.entries) fs.rmSync(path.join(abs, e.file));
  return total;
}

/** Null when `measured` is what the ledger accounts for, else the failure line. */
export function ledgerFailure(skill: string, measured: number, ledger: SizeLedger | { error: string }, baselineBytes?: number): string | null {
  if ('error' in ledger) return `size ledger: ${ledger.error}`;
  const expected = ledgerExpected(ledger);
  if (measured === expected) return null;
  const ratio = baselineBytes ? ` (${(measured / baselineBytes).toFixed(4)}x baseline)` : '';
  const d = measured - expected;
  return `size union ${measured} bytes${ratio} != ledger ${ledger.base.union_bytes} + ${expected - ledger.base.union_bytes} (${ledger.entries.length} entries in ${ledger.dir}) = ${expected}; this tree is ${d > 0 ? '+' : ''}${d} bytes off: ${recordCommand(skill)}`;
}
