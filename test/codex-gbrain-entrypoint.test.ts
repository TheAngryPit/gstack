import {describe,expect,test} from 'bun:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

describe('installed Codex GBrain executable entrypoint',()=>{
  test('launches directly as generated skills instruct, then refuses a missing binding',()=>{
    const temporary=mkdtempSync(join(tmpdir(),'gstack-direct-entrypoint-'));
    const result=spawnSync(resolve(import.meta.dir,'../bin/gstack-gbrain-codex'),['--request-stdin'],{
      env:{PATH:process.env.PATH!,HOME:temporary,GSTACK_HOME:temporary},
      input:JSON.stringify({op:'search',query:'synthetic'}),encoding:'utf8',timeout:5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No valid Codex GBrain binding');
  });
});
