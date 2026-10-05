import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { SECTION, rewriteCarvedSectionRefs } from '../scripts/resolvers/sections';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { getHostConfig } from '../hosts';
import { adaptNativeTemplate } from '../scripts/resolvers/native-template';

const root=resolve(import.meta.dir,'..');
const output=mkdtempSync(join(tmpdir(),'codex-sections-'));
beforeAll(()=>{
  const result=spawnSync(process.execPath,[join(root,'scripts/gen-skill-docs.ts'),'--host','codex','--model','gpt-6-astra','--out-dir',output],{encoding:'utf8',timeout:30_000});
  expect(result.status).toBe(0);
});
afterAll(()=>rmSync(output,{recursive:true,force:true}));

test('ship skeleton is under the existing ceiling and all section references reach Codex assets',()=>{
  const skill=readFileSync(join(output,'.agents','skills','gstack-ship','SKILL.md'),'utf8');
  expect(skill.length).toBeLessThan(160_000);
  expect(Buffer.byteLength(skill)).toBeLessThan(160_000);
  const manifest=JSON.parse(readFileSync(join(root,'ship','sections','manifest.json'),'utf8'));
  for(const section of manifest.sections) {
    // The upstream Apple adapter deliberately remains a source-tree path;
    // carved sections use the Codex runtime skill asset directory.
    const expected=[
      `$GSTACK_ROOT/ship/sections/${section.file}`,
      `$GSTACK_ROOT/.agents/skills/gstack-ship/sections/${section.file}`,
      `sections/${section.file}`,
    ];
    expect(expected.some(reference=>skill.includes(reference))).toBe(true);
    expect(existsSync(join(output,'.agents','skills','gstack-ship','sections',section.file))).toBe(true);
    expect(existsSync(join(root,'ship','sections',section.file))).toBe(true);
  }
});
test('generated Codex setup and execution preserve native capabilities without Claude commands',()=>{
  const skills=join(output,'.agents','skills');
  expect(existsSync(join(skills,'gstack-claude'))).toBe(false);
  const mcp=readFileSync(join(skills,'gstack-setup-gbrain','SKILL.md'),'utf8');
  expect(mcp).toContain('codex mcp add gbrain --env');
  expect(mcp).toContain('Native Codex decisions');
  expect(mcp).toContain('request_user_input');
  const transcript=readFileSync(join(skills,'gstack-setup-gbrain','sections','transcript-gate.md'),'utf8');
  expect(transcript).toContain('no current-repo filter');
  expect(transcript).toContain('A skill-start call alone does not automatically ingest');
  const spec=readFileSync(join(skills,'gstack-spec','sections','gate-and-file.md'),'utf8');
  expect(spec).toContain('native Codex worker');
  expect(spec).not.toContain('Then fall back to current dir');
  const review=readFileSync(join(skills,'gstack-review','sections','adversarial.md'),'utf8');
  expect(review).toContain('fork_turns: "none"');
  for(const content of [mcp,transcript,spec,review]) {
    expect(content).not.toContain('claude -p');
    expect(content).not.toContain('claude mcp');
    expect(content).not.toContain('{{');
  }
});
test('every operational line in adapted ship sections is conserved with host rewrites',()=>{
  const changes=getHostConfig('codex').pathRewrites || [];
  let checked=0;
  for(const name of readdirSync(join(root,'ship','sections')).filter(n=>n.endsWith('.md.tmpl'))) {
    const generated=readFileSync(join(output,'.agents','skills','gstack-ship','sections',name.slice(0,-5)),'utf8');
    expect(generated.includes('{{')).toBe(false);
    const source = `ship/sections/${name}`;
    const ctx = {skillName:'ship',tmplPath:source,host:'codex' as const,paths:HOST_PATHS.codex};
    // Match processTemplate's LF normalization before adapting: Windows
    // checkouts with core.autocrlf=true feed CRLF on disk, but generation
    // deliberately normalizes the input before resolver and rewrite passes.
    let adapted = adaptNativeTemplate(readFileSync(join(root,source),'utf8').replace(/\r\n/g,'\n'), ctx, source);
    for(const rewrite of changes) adapted=adapted.split(rewrite.from).join(rewrite.to);
    adapted=rewriteCarvedSectionRefs(adapted,ctx);
    for(const line of adapted.split('\n')) {
      if (!line.trim() || line.includes('{{')) continue;
      expect({file:name,line,preserved:generated.includes(line)}).toEqual({file:name,line,preserved:true});
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(300);
});
test('all carved Codex skills emit manifest assets; another host still receives full inline text',()=>{
  for(const skill of readdirSync(root)) {
    const manifestPath=join(root,skill,'sections','manifest.json');
    if(!existsSync(manifestPath))continue;
    const destination=join(output,'.agents','skills',`gstack-${skill}`);
    if(!existsSync(join(destination,'SKILL.md')))continue;
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    for(const entry of manifest.sections) expect(existsSync(join(destination,'sections',entry.file))).toBe(true);
  }
  const ship=SECTION({skillName:'ship',tmplPath:join(root,'ship','SKILL.md.tmpl'),host:'factory',paths:HOST_PATHS.factory},['tests']);
  expect(ship).toContain('**STOP.**');
  expect(ship).toContain('`sections/tests.md` relative to the installed `gstack-ship`');
  const actual=SECTION({skillName:'office-hours',tmplPath:join(root,'office-hours','SKILL.md.tmpl'),host:'factory',paths:HOST_PATHS.factory},['design-and-handoff']);
  expect(actual).toBe(readFileSync(join(root,'office-hours','sections','design-and-handoff.md.tmpl'),'utf8').trimEnd());
});
