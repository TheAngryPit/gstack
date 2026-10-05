#!/usr/bin/env bun
/** Codex branch of gstack-config gbrain-refresh. Uses the existing generator. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync, copyFileSync, rmdirSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { bindingPath, selectCodexBrain, loadCodexBrain, codexBrainProbeEnv } from '../lib/gbrain-codex-binding';
import { resolveCodexGenerationModel } from './resolve-codex-generation-model';
import { discoverTemplates } from './discover-skills';
import { getHostConfig } from '../hosts/index';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
let lock: string | undefined;
let lockOwner: string | undefined;
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
function arg(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${flag} value.`);
  return args[index + 1];
}
function acquireRefreshLock(state: string): void {
  // An old anonymous lock cannot establish whether its owner is alive. Leave
  // it untouched, with an actionable diagnostic, rather than steal it.
  if (present(join(state,'.gbrain-codex-refresh.lock'))) {
    throw new Error('Legacy refresh lock has no owner identity. Confirm no old refresh is running and move that lock aside before retrying.');
  }
  const target=join(state,'.gbrain-codex-refresh.v2.lock');
  const owner=`owner-${process.pid}-${randomUUID()}.json`;
  const prepared=mkdtempSync(join(state,'.gbrain-codex-refresh-owner-'));
  writeFileSync(join(prepared,owner),JSON.stringify({pid:process.pid,host:hostname()}),{mode:0o600});
  try {
    for (let attempt=0; attempt<4; attempt++) {
      try {
        // Publish a nonempty directory atomically: no empty lock/bookkeeping
        // gap. Only a released or reclaimed empty v2 directory is replaceable.
        renameSync(prepared,target);
        lock=target; lockOwner=owner;
        return;
      } catch(error) {
        if (!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      }
      const stat=lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refresh lock is not a managed directory.');
      const entries=readdirSync(target);
      if (entries.length===0) continue;
      const previous=entries[0];
      if (entries.length!==1 || !/^owner-\d+-[\w-]+\.json$/.test(previous)) throw new Error('Refresh lock has unknown ownership; inspect it before retrying.');
      const record=join(target,previous);
      if (!lstatSync(record).isFile()) throw new Error('Refresh lock owner is not a regular file.');
      const info=JSON.parse(readFileSync(record,'utf8'));
      if (!Number.isSafeInteger(info.pid) || info.pid<=0 || info.host!==hostname() || !previous.startsWith(`owner-${info.pid}-`)) {
        throw new Error('Refresh lock owner cannot be verified on this host.');
      }
      try {
        process.kill(info.pid,0);
        throw new Error('Another refresh owns the lock; retry after it completes.');
      } catch(error) {
        if ((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;
      }
      // Moving the uniquely named dead owner's record claims recovery. A
      // competing reclaimer cannot remove a newer owner's differently named
      // record or empty its nonempty directory. Preserve the old record.
      try { renameSync(record,join(state,`gbrain-codex-stale-owner-${randomUUID()}.json`)); }
      catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    }
    throw new Error('Refresh lock changed during recovery; retry.');
  } finally {
    if (present(prepared)) { unlinkSync(join(prepared,owner)); rmdirSync(prepared); }
  }
}
try {
  for (let i=0; i<args.length; i+=2) {
    if (!['--server','--model'].includes(args[i]) || !args[i+1]) throw new Error('Usage: gbrain-refresh --host codex [--server NAME] [--model MODEL]');
  }
  const selected = arg('--server');
  const binding = selected ? selectCodexBrain(selected) : loadCodexBrain();
  const installed = join(binding.codexHome, 'skills');
  if (!existsSync(join(installed,'gstack','bin')) || realpathSync(join(installed,'gstack','bin')) !== realpathSync(join(root,'bin'))) {
    throw new Error('The Codex gstack runtime must already point at this installation.');
  }
  const state = dirname(bindingPath());
  mkdirSync(state, {recursive: true});
  acquireRefreshLock(state);
  const stage = mkdtempSync(join(state, 'gbrain-codex-refresh-'));
  const render = join(state, 'render', 'codex');
  const env = {...codexBrainProbeEnv(binding), GSTACK_HOME: stage, GSTACK_DETECT_NO_CACHE: '1'};
  const detection = JSON.parse(execFileSync(process.execPath, [join(root, 'bin/gstack-gbrain-detect')], {env, cwd:binding.home, encoding:'utf8', timeout:30_000}));
  if (detection.gbrain_local_status !== 'ok') throw new Error(`Selected brain was not proven reachable (${detection.gbrain_local_status}). Previous installation retained.`);
  detection.gbrain_binding_host='codex';
  detection.gbrain_mcp_mode='local-stdio';
  detection.gbrain_mcp_mode_source='codex-registration';
  writeFileSync(join(stage, 'gbrain-codex-binding.json'), JSON.stringify(binding, null, 2) + '\n', {mode:0o600});
  writeFileSync(join(stage, 'gbrain-detection.json'), JSON.stringify(detection, null, 2) + '\n', {mode:0o600});
  const output = join(stage, 'render');
  const model = resolveCodexGenerationModel({explicit:arg('--model'), codexHome:binding.codexHome}).model;
  const generation = spawnSync(process.execPath, [join(root, 'scripts/gen-skill-docs.ts'), '--host','codex','--model',model,
    '--respect-detection','--out-dir',output,'--link-root',render], {env, encoding:'utf8', timeout:60_000});
  // The generator can catch a host failure yet exit zero. Diagnostics are
  // therefore a separate failure signal, never evidence of a usable render.
  // Do not echo raw subprocess output (it may contain local configuration).
  if (generation.error || generation.status !== 0) throw new Error('Codex enrichment generator failed. Previous installation retained.');
  if (generation.stderr.trim()) throw new Error('Codex enrichment generator diagnostics reported. Previous installation retained.');
  const generated = join(output, '.agents','skills');
  // Derive the complete expected set from source templates and the same host
  // include/skip policy, not from whatever subset the generator produced.
  const expected = discoverTemplates(root,getHostConfig('codex').generation).map(({tmpl}) => {
    const skillDir=dirname(tmpl);
    if (skillDir === '.') return 'gstack';
    const content=readFileSync(join(root,tmpl),'utf8').replace(/\r\n/g,'\n');
    const frontmatter=content.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
    const name=frontmatter.match(/^name:\s*(.+)$/m)?.[1].trim() || skillDir;
    return name.startsWith('gstack-') ? name : `gstack-${name}`;
  });
  if (!expected.length || expected.some(name=>!existsSync(join(generated,name,'SKILL.md')))) {
    throw new Error('Codex enrichment generation omitted an expected skill. Previous installation retained.');
  }
  const names = readdirSync(generated).filter(name => name.startsWith('gstack-') && existsSync(join(generated,name,'SKILL.md')));
  if (names.some(name=>!expected.includes(name))) throw new Error('Codex enrichment generation produced an unexpected skill. Previous installation retained.');
  if (!names.length || !readFileSync(join(generated,'gstack-ship','SKILL.md'),'utf8').includes('gstack-gbrain-codex')) throw new Error('Codex enrichment generation failed.');
  // Validate every target before touching any installed link. Never claim a
  // user directory or an unrelated symlink merely because its name matches.
  for (const name of names) {
    const target = join(installed,name);
    if (!present(target)) continue;
    if (!lstatSync(target).isSymbolicLink()) throw new Error(`Existing skill is not a managed link: ${name}`);
    const destination = resolve(dirname(target),readlinkSync(target));
    if (![join(root,'.agents','skills',name),join(render,'.agents','skills',name)].includes(destination)) throw new Error(`Existing skill belongs to another installation: ${name}`);
  }
  mkdirSync(dirname(render), {recursive:true});
  mkdirSync(installed, {recursive:true});
  if (present(render) && lstatSync(render).isSymbolicLink()) throw new Error('Codex render directory must not be a symlink.');
  const files=['gbrain-codex-binding.json','gbrain-detection.json'];
  for (const file of files) {
    const target=join(state,file);
    if (present(target) && lstatSync(target).isSymbolicLink()) throw new Error('GBrain state must not be a symlink.');
    if (existsSync(target)) copyFileSync(target,join(stage,`previous-${file}`));
  }
  for (const name of names) {
    const target=join(installed,name);
    if (present(target)) symlinkSync(readlinkSync(target),join(stage,`previous-${name}`));
  }
  let installedRender=false;
  const installedFiles:string[]=[], installedLinks:string[]=[];
  try {
    if (existsSync(render)) renameSync(render, join(stage,'previous-render'));
    renameSync(output,render);
    installedRender=true;
    for (const file of files) {
      renameSync(join(stage,file),join(state,file));
      installedFiles.push(file);
    }
    for (const name of names) {
      const temporary=join(installed,`.${name}.${process.pid}`);
      symlinkSync(join(render,'.agents','skills',name),temporary);
      renameSync(temporary,join(installed,name));
      installedLinks.push(name);
    }
  } catch {
    // Keep the failed new output as well as the old installation recoverable.
    try {
    for (const name of installedLinks.reverse()) {
      renameSync(join(installed,name),join(stage,`failed-${name}`));
      const previous=join(stage,`previous-${name}`);
      if (present(previous)) symlinkSync(readlinkSync(previous),join(installed,name));
    }
    for (const file of installedFiles) {
      renameSync(join(state,file),join(stage,`failed-${file}`));
      const previous=join(stage,`previous-${file}`);
      if (existsSync(previous)) copyFileSync(previous,join(state,file));
    }
    if (installedRender) renameSync(render,join(stage,'failed-render'));
    if (existsSync(join(stage,'previous-render'))) renameSync(join(stage,'previous-render'),render);
    } catch {
      throw new Error(`Install failed and restoration is incomplete. Inspect the installation before use. Recovery: ${stage}`);
    }
    throw new Error(`Install failed and previous installation was restored. Recovery: ${stage}`);
  }
  console.log(`Codex GBrain enrichment refreshed: ${names.length} skills, model ${model}. Writes require task authorization. Recovery: ${stage}`);
} catch(error) {
  console.error(`Codex GBrain refresh failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
  process.exitCode=1;
} finally {
  if (lock && lockOwner) {
    unlinkSync(join(lock,lockOwner));
    // A successor can atomically replace our now-empty directory. Never
    // remove its nonempty lock or turn that harmless race into a failure.
    try { rmdirSync(lock); }
    catch(error) { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  }
}
