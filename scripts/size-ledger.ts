#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Size ledger for a carved skill's union bytes (GSTA-132; format in
 * test/helpers/size-ledger.ts).
 *
 *   size-ledger.ts record <skill> --why <text> [--branch <name>]
 *     set this branch's entry to what this tree's union bytes differ from the
 *     base plus every other entry; a zero difference deletes the entry
 *   size-ledger.ts check <skill>
 *     print measured, expected and each entry; exit 1 on a mismatch
 *   size-ledger.ts fold <skill> --measured-at <text>
 *     move the entries' sum into base.json and delete them (a tidy-up PR,
 *     never a stamp commit); refuses on a mismatch
 */
import { spawnSync } from 'child_process';
import { CARVE_GUARDS } from '../test/helpers/carve-guards';
import { readSkillForParity } from '../test/helpers/parity-harness';
import { foldLedger, ledgerExpected, ledgerFailure, readSizeLedger, recordEntry } from '../test/helpers/size-ledger';

const USAGE = 'usage: size-ledger.ts record <skill> --why <text> [--branch <name>] | check <skill> | fold <skill> --measured-at <text>';

function fail(msg: string, code = 2): never {
  console.error(`size-ledger: ${msg}`);
  process.exit(code);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) fail(`${name} needs a value`);
  return v;
}

const [cmd, skill, ...rest] = process.argv.slice(2);
if (!cmd || !skill || !['record', 'check', 'fold'].includes(cmd)) fail(USAGE);
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', timeout: 10_000 }).stdout?.trim() || process.cwd();
const dir = CARVE_GUARDS[skill]?.sizeLedger;
if (!dir) fail(`${skill} has no sizeLedger in test/helpers/carve-guards.ts`);
const measured = readSkillForParity(root, skill, true).unionBytes;
const ledger = readSizeLedger(root, dir);
if ('error' in ledger) fail(ledger.error, 1);

if (cmd === 'check') {
  console.log(`base ${ledger.base.union_bytes} (${ledger.base.measured_at})`);
  for (const e of ledger.entries) console.log(`${e.bytes > 0 ? '+' : ''}${e.bytes} ${e.file}: ${e.why}`);
  console.log(`expected ${ledgerExpected(ledger)} measured ${measured}`);
  const failure = ledgerFailure(skill, measured, ledger);
  if (failure) fail(failure, 1);
  console.log('SIZE_LEDGER: ok');
} else if (cmd === 'record') {
  const why = flag(rest, '--why');
  if (!why?.trim()) fail('record needs --why "<what changed>"');
  const branch = flag(rest, '--branch') ?? spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8', timeout: 10_000 }).stdout?.trim();
  if (!branch || branch === 'HEAD') fail('detached HEAD: pass --branch <name>');
  if (branch === 'main' || branch === 'master') fail(`refusing to record on ${branch}; record on the branch that made the change`);
  let r: { file: string; bytes: number };
  try { r = recordEntry(root, ledger, measured, branch, why); } catch (err) { fail((err as Error).message); }
  console.log(r.bytes === 0
    ? `SIZE_LEDGER: ${dir}/${r.file} not needed (this tree matches the ledger without it); expected ${measured}`
    : `SIZE_LEDGER: ${dir}/${r.file} ${r.bytes > 0 ? '+' : ''}${r.bytes}; expected ${measured}`);
} else {
  const at = flag(rest, '--measured-at');
  if (!at?.trim()) fail('fold needs --measured-at "<tree it was measured on>"');
  const failure = ledgerFailure(skill, measured, ledger);
  if (failure) fail(`fold refused: ${failure}`, 1);
  foldLedger(root, ledger, at);
  console.log(`SIZE_LEDGER: folded ${ledger.entries.length} entries into ${dir}/base.json = ${measured}`);
}
