import {describe,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateGBrainContextLoad} from '../scripts/resolvers/gbrain';
import {HOST_PATHS} from '../scripts/resolvers/types';

describe('installed Codex GBrain executable entrypoint',()=>{
  test('launches through Bun as generated skills instruct, then refuses a missing binding',()=>{
    const guidance=generateGBrainContextLoad({skillName:'investigate',tmplPath:'investigate/SKILL.md.tmpl',host:'codex',paths:HOST_PATHS.codex});
    expect(guidance).toContain('bun "$GSTACK_BIN/gstack-gbrain-codex" --request-stdin');
    const temporary=mkdtempSync(join(tmpdir(),'gstack-direct-entrypoint-'));
    const result=spawnSync(process.execPath,[resolve(import.meta.dir,'../bin/gstack-gbrain-codex'),'--request-stdin'],{
      env:{PATH:process.env.PATH!,HOME:temporary,GSTACK_HOME:temporary},
      input:JSON.stringify({op:'search',query:'synthetic'}),encoding:'utf8',timeout:5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No valid Codex GBrain binding');
  });
});
