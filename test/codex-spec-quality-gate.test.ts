import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { preparePrivateRequest } from '../lib/codex-request-file';
import { adaptNativeTemplate } from '../scripts/resolvers/native-template';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { generateRedactInvocationBlock } from '../scripts/resolvers/redact-doc';

const root = resolve(import.meta.dir, '..');
const path = 'spec/sections/gate-and-file.md.tmpl';
const source = readFileSync(resolve(root, path), 'utf8');
const ctx = { host: 'codex' as const, skillName: 'spec', tmplPath: path, paths: HOST_PATHS.codex };
const output = () => adaptNativeTemplate(source, ctx, path);

test('native spec gate preserves the full scoring prompt and all upstream ordering and thresholds', () => {
  const native = output();
  const prompt = source.match(/Write the prompt with the exact redaction-approved spec bytes using the Write tool; never shell-interpolate the raw draft\. Keep hard delimiters and this boundary:\n\n([\s\S]*?)\n\n\{\{OUTSIDE_INVOCATION:spec\}\}/)![1];
  expect(native).toContain(prompt);
  expect(native).toContain('<<<USER_SPEC>>>');
  expect(native).toContain('<<<END_USER_SPEC>>>');
  expect(native).not.toContain('{{OUTSIDE_INVOCATION:spec}}');
  expect(native).not.toContain('{{OUTSIDE_PREFLIGHT:opt-in}}');
  expect(native).not.toContain('{{OUTSIDE_PROVENANCE:spec-quality-gate}}');
  expect(native).not.toContain('undefined');
  const phases = ['Phase 4.5a:', 'Phase 4.5b:', '**Dispatch', '**Scoring outcomes:**', 'Phase 5:'];
  for (let i=1; i<phases.length; i++) expect(native.indexOf(phases[i])).toBeGreaterThan(native.indexOf(phases[i-1]));
  for(const item of ['--no-gate', 'redaction always runs', 'Score ≥7', 'Score <7, iteration 1', 'Score <7, iteration 2', 'Max 3 dispatches total', '2-minute', 'PUBLIC repo', 'option B is disabled', 'Audit-sink invariant', '{{REDACT_INVOCATION_BLOCK:pre-issue:brief}}', '{{REDACT_INVOCATION_BLOCK:pre-archive:brief}}']) expect(native).toContain(item);
});

test('native spec gate dispatch is fresh and actual states cannot become model or timeout fiction', () => {
  const native = output();
  expect(native).toContain('fork_turns: "none"');
  expect(native).toContain('malformed_response');
  expect(native).toContain('timeout');
  expect(native).toContain('review_not_run');
  expect(native).toContain('does not prove a different model');
  expect(native).toContain('No fourth dispatch');
  expect(native).not.toMatch(/codex\s+exec|CODEX_MODEL_CONFIG_FLAG|codex login|codex doctor|Install OpenAI/);
  expect(native).not.toContain('spec-quality-gate-secret-sink.test.ts');
});

test('actual redaction scanner blocks a synthetic credential and does not echo raw secret bytes', () => {
  const key = ['AKIA', '1234567890ABCDEF'].join('');
  const result = Bun.spawnSync([process.execPath, resolve(root,'bin/gstack-redact'), '--json'], {
    stdin: Buffer.from('Private spec includes ' + key), timeout: 5_000,
  });
  expect(result.exitCode).toBe(3);
  expect(JSON.parse(result.stdout.toString()).counts.HIGH).toBe(1);
  expect(result.stdout.toString()).not.toContain(key);
  expect(result.stderr.toString()).not.toContain(key);
});

test('source-anchor drift fails explicitly rather than retaining CLI dispatch', () => {
  expect(() => adaptNativeTemplate(source.replace('{{OUTSIDE_INVOCATION:spec}}', '{{CHANGED_INVOCATION}}'), ctx, path)).toThrow('spec native prompt anchor drift');
});

test('native privacy instructions keep untrusted body out of shell and retain scanned bytes until final consumption', () => {
  const native = output();
  expect(native).not.toContain('printf');
  expect(native).not.toMatch(/(?<!<)<<(?!<)-?\s*['"]?\w|rm -f/);
  expect(native).toContain('gstack-private-input');
  for (const sink of ['pre-codex', 'pre-issue', 'pre-archive', 'pre-pr-body', 'pre-pr-title', 'pre-commit']) {
    for (const brief of [false, true]) {
      const text = generateRedactInvocationBlock(ctx, brief ? [sink,'brief'] : [sink]);
      expect(text).not.toMatch(/<<['"]|rm -f|scan skipped|<the exact/);
      for (const required of ['literal bytes', 'SAME', 'HIGH', 'retained_private', 'final consumer', '--sha256']) expect(text).toContain(required);
    }
  }
});

test('native issue and archive consumers use explicit scanned input paths and preserve complete metadata', () => {
  const native = output();
  expect(native).not.toContain('$REDACT_FILE');
  expect(native).not.toContain('--title "<title>"');
  expect(native).toContain('--body-file "<allocated scanned body path>"');
  expect(native).toContain('cat -- "<allocated scanned title path>"');
  expect(native).toContain('"<scanned complete archive input path>" "<owned archive staging path>"');
  expect(native).not.toMatch(/(?<!<)<<(?!<)-?\s*['"]?\w/);
  for (const key of ['spec_issue_number','spec_issue_url','spec_filed_at','spec_branch','spec_plan_mode','spec_executed','spec_worktree_path','ttfc_ms','tthw_ms']) expect(native).toContain(key + ':');
  expect(native).toContain('Re-scan the COMPLETE archive file');
  expect(native).toContain('mv -n --');
});

test('the rendered issue/archive commands preserve actual scanned bytes with hostile title/body and detect archive collisions', () => {
  const fixture = fs.mkdtempSync(join(tmpdir(), 'native-spec-consumer-'));
  try {
    const env = {...process.env, PATH:fixture + ':' + process.env.PATH, PROBE_LOG:join(fixture,'issue.json')};
    const gh = join(fixture,'gh');
    fs.writeFileSync(gh, `#!/usr/bin/env bun
import fs from 'node:fs';
const args=process.argv.slice(2);
fs.writeFileSync(process.env.PROBE_LOG, JSON.stringify({args,body:fs.readFileSync(args[args.indexOf('--body-file')+1]).toString('base64')}));
console.log('https://example.invalid/issues/123');
`, {mode:0o700});
    const marker=join(fixture,'must-not-execute');
    const title='Literal $(touch ' + marker + ') `false` "quotes"';
    const body='Body is literal DATA.\nEOF\n$(touch ' + marker + ')\n`false` "quotes" \'single\' ☃\n';
    const allocate=(bytes:string)=>{const item=preparePrivateRequest({tempRoot:fixture,filename:'input.txt'});fs.writeFileSync(item.path,bytes);return item.path;};
    const titlePath=allocate(title),bodyPath=allocate(body);
    const scan=(path:string)=>Bun.spawnSync([process.execPath,resolve(root,'bin/gstack-redact'),'--from-file',path,'--repo-visibility','private','--json'],{timeout:5_000});
    for(const path of [titlePath,bodyPath]) expect(scan(path).exitCode).toBe(0);
    const native=output();
    const issueLine=native.split('\n').find(line=>line.startsWith('gh issue create '))!;
    expect(issueLine).toBeDefined();
    const issue=Bun.spawnSync(['/bin/bash','-c',issueLine.replace('<allocated scanned title path>',titlePath).replace('<allocated scanned body path>',bodyPath)],{env,timeout:5_000});
    expect(issue.exitCode).toBe(0);
    const sent=JSON.parse(fs.readFileSync(env.PROBE_LOG,'utf8'));
    expect(sent.args[sent.args.indexOf('--title')+1]).toBe(title);
    expect(Buffer.from(sent.body,'base64')).toEqual(fs.readFileSync(bodyPath));
    expect(fs.existsSync(marker)).toBe(false);

    const metadata={spec_issue_number:123,spec_issue_url:'https://example.invalid/issues/123',spec_filed_at:'2026-09-12T00:00:00Z',spec_branch:'fixture',spec_plan_mode:'inactive',spec_executed:false,spec_worktree_path:'',ttfc_ms:1,tthw_ms:2};
    const archive='---\n'+Object.entries(metadata).map(([key,value])=>key+': '+JSON.stringify(value)).join('\n')+'\n---\n\n# '+title+'\n\n'+body;
    const archiveInput=allocate(archive);
    expect(scan(archiveInput).exitCode).toBe(0);
    const stage=join(fixture,'owned-stage.md'),destination=join(fixture,'archive.md');
    fs.writeFileSync(stage,'',{flag:'wx',mode:0o600});
    const copyLine=native.split('\n').find(line=>line.startsWith('cp -- '))!;
    expect(Bun.spawnSync(['/bin/bash','-c',copyLine.replace('<scanned complete archive input path>',archiveInput).replace('<owned archive staging path>',stage)],{timeout:5_000}).exitCode).toBe(0);
    expect(fs.readFileSync(stage)).toEqual(fs.readFileSync(archiveInput));
    const moveLine=native.split('\n').find(line=>line.startsWith('mv -n -- '))!;
    const move=()=>Bun.spawnSync(['/bin/bash','-c',moveLine.replace('<owned archive staging path>',stage).replace('<new archive path>',destination)],{timeout:5_000});
    expect(move().exitCode).toBe(0);
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(archiveInput));
    expect(fs.statSync(destination).mode&0o777).toBe(0o600);
    expect(fs.existsSync(marker)).toBe(false);
    // On BSD mv, -n can return success while declining the collision. Readback,
    // not its exit code alone, must keep that case out of the archived state.
    fs.writeFileSync(stage,'new attempt',{flag:'wx',mode:0o600});
    move();
    expect(fs.existsSync(stage)).toBe(true);
    expect(fs.readFileSync(destination,'utf8')).toBe(archive);
    expect(fs.readFileSync(stage,'utf8')).toBe('new attempt');
  } finally {fs.rmSync(fixture,{recursive:true,force:true});}
});
