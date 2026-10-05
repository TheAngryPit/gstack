import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readlinkSync, symlinkSync, readdirSync, chmodSync, realpathSync, copyFileSync } from 'fs';
import { tmpdir, hostname } from 'os';
import { join, resolve } from 'path';
import { spawnSync, spawn } from 'child_process';
import { createHash } from 'crypto';

const root=resolve(import.meta.dir,'..');
let temp:string, env:NodeJS.ProcessEnv, native:any, command:string;
function saveNative() {
  const config = Bun.TOML.stringify(native);
  if (typeof config !== 'string') throw new Error('Native fixture configuration did not serialize.');
  writeFileSync(join(temp,'codex','config.toml'), config);
}
function run(bin:string, args:string[] = [], input?:string) {
  return spawnSync(process.execPath,[join(root,bin),...args],{env,input,encoding:'utf8',timeout:30_000});
}
function refresh(args:string[]=['--server','chosen']) {
  return run('scripts/refresh-codex-gbrain.ts',args);
}
beforeEach(()=>{
  temp=mkdtempSync(join(tmpdir(),'codex-brain-binding-'));
  mkdirSync(join(temp,'codex','skills'),{recursive:true});
  symlinkSync(root,join(temp,'codex','skills','gstack'));
  mkdirSync(join(temp,'brain','.gbrain'),{recursive:true});
  mkdirSync(join(temp,'bin'),{recursive:true});
  command=join(temp,'bin','gbrain');
  writeFileSync(join(temp,'brain','.gbrain','config.json'),JSON.stringify({engine:'postgres',database_url:'postgres://fixture'}));
  writeFileSync(command,`#!/usr/bin/env bun
import {appendFileSync, existsSync, readFileSync} from 'fs';
const args=process.argv.slice(2);
if(['search','call','get','put'].includes(args[0])) {
  const ledger=process.env.GSTACK_HOME+'/security/egress.jsonl';
  appendFileSync(process.env.PROBE_LOG+'.receipt-order', JSON.stringify({receiptBeforeDispatch:existsSync(ledger)&&readFileSync(ledger,'utf8').includes('gbrain-codex')})+'\\n');
}
appendFileSync(process.env.PROBE_LOG,JSON.stringify({args,stdin:args[0]==='put'&&!args.includes('--content')?await Bun.stdin.text():undefined,path:process.env.PATH,home:process.env.GBRAIN_HOME,source:process.env.GBRAIN_SOURCE,extra:process.env.FIXTURE_PROVIDER,database:process.env.DATABASE_URL,brain:process.env.GBRAIN_BRAIN_ID,gdatabase:process.env.GBRAIN_DATABASE_URL,direct:process.env.GBRAIN_DIRECT_DATABASE_URL,cwd:process.cwd()})+'\\n');
if(args[0]==='--version')console.log('gbrain 0.48.2.0');
else if(args[0]==='doctor')console.log(JSON.stringify({status:'ok'}));
else if(args[0]==='sources')console.log('[]');
else console.log(JSON.stringify({ok:true,args,source:process.env.GBRAIN_SOURCE}));
`,{mode:0o755});
  native={model:'gpt-6-astra',mcp_servers:{chosen:{command,args:['serve'],env:{GBRAIN_HOME:join(temp,'brain'),GBRAIN_SOURCE:'selected',FIXTURE_PROVIDER:'kept'}},other:{command,args:['serve'],env:{GBRAIN_HOME:join(temp,'brain'),GBRAIN_SOURCE:'other'}}}};
  saveNative();
  env={...process.env,HOME:temp,TMPDIR:temp,CODEX_HOME:join(temp,'codex'),GSTACK_HOME:join(temp,'state'),PROBE_LOG:join(temp,'calls.jsonl'),GBRAIN_HOME:'/wrong',GBRAIN_SOURCE:'wrong',DATABASE_URL:'postgres://wrong',PATH:`${join(temp,'bin')}:${process.env.PATH}`};
});
afterEach(()=>rmSync(temp,{recursive:true,force:true}));

test('missing selection fails closed even with multiple valid native registrations',()=>{
  expect(refresh([]).status).toBe(1);
  expect(existsSync(join(temp,'calls.jsonl'))).toBe(false);
});
test('refresh selects one brain, preserves model and installs reachable Codex sections without writes',()=>{
  const result=refresh();
  expect(result.status).toBe(0);
  const binding=JSON.parse(readFileSync(join(temp,'state','gbrain-codex-binding.json'),'utf8'));
  expect(binding.server).toBe('chosen');
  expect(binding.source).toBe('selected');
  expect(JSON.stringify(binding)).not.toContain('postgres://');
  expect(JSON.stringify(binding)).not.toContain('FIXTURE_PROVIDER');
  const skill=readFileSync(join(temp,'codex','skills','gstack-ship','SKILL.md'),'utf8');
  expect(skill).toContain('--model "gpt-6-astra"');
  expect(skill.length).toBeLessThan(160_000);
  expect(skill).toContain('gstack-gbrain-codex');
  const sections=join(temp,'codex','skills','gstack-ship','sections');
  const union=skill+readdirSync(sections).map(name=>readFileSync(join(sections,name),'utf8')).join('\n');
  expect(union.includes('Without task-scoped')).toBe(true);
  expect(union.includes('gbrain put')).toBe(false);
  expect(union).not.toContain('--content "<frontmatter');
  expect(union).not.toContain('./gbrain-request.json');
  expect(union).toContain('--prepare-request');
  expect(union).toContain('--request-file');
  expect(union).toContain('--authorized-write');
  expect(union).toContain('retained_private');
  expect(union).not.toContain('call get_page');
  expect(union).not.toContain('search "<keywords>"');
  const installedRender = join(temp,'state','render','codex');
  for(const match of skill.matchAll(/`([^`]+\/sections\/[^`]+\.md)`/g)) {
    const sectionRef=match[1];
    const sectionPath=sectionRef.startsWith('$GSTACK_ROOT/')
      ? join(installedRender,sectionRef.slice('$GSTACK_ROOT/'.length))
      : sectionRef;
    expect(existsSync(sectionPath), `${sectionRef} => ${sectionPath}`).toBe(true);
  }
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(calls.every(c=>['--version','doctor','sources'].includes(c.args[0]))).toBe(true);
});
test('explicit Codex detection uses the saved binding and does not enable another host',()=>{
  expect(refresh().status).toBe(0);
  const result=run('bin/gstack-gbrain-detect',['--host','codex']);
  expect(result.status).toBe(0);
  const detection=JSON.parse(result.stdout);
  expect(detection.gbrain_local_status).toBe('ok');
  expect(detection.gbrain_binding_host).toBe('codex');
  expect(detection.gbrain_mcp_mode_source).toBe('codex-registration');
  expect(run('bin/gstack-gbrain-detect',['--host','codex','--is-ok']).status).toBe(0);
  const output=join(temp,'claude-render');
  expect(run('scripts/gen-skill-docs.ts',['--host','claude','--respect-detection','--out-dir',output]).status).toBe(0);
  expect(readFileSync(join(output,'office-hours','SKILL.md'),'utf8').includes('## Brain Context Load')).toBe(false);
});
test('later reads and explicitly authorized fixture writes retain the selected binding',()=>{
  expect(refresh().status).toBe(0);
  expect(run('bin/gstack-gbrain-codex',['search','needle']).status).toBe(0);
  expect(run('bin/gstack-gbrain-codex',['put','fixture','--content','test']).status).toBe(1);
  expect(run('bin/gstack-gbrain-codex',['--authorized-write','put','fixture','--content','test']).status).toBe(0);
  expect(run('bin/gstack-gbrain-codex',['call','get_page',JSON.stringify({slug:'fixture',include_content:true})]).status).toBe(0);
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const reads=calls.filter(c=>['put','search','call'].includes(c.args[0]));
  expect(reads.length).toBe(3);
  for(const read of reads){expect(read.home).toBe(join(temp,'brain'));expect(read.source).toBe('selected');expect(read.extra).toBe('kept');expect(read.database).toBe('postgres://fixture');}
  expect(JSON.parse(reads[2].args[2]).source_id).toBe('selected');
});
test('routing overrides and changed or removed bindings fail without invoking gbrain',()=>{
  expect(refresh().status).toBe(0);
  for(const args of [['search','x','--source','other'],['call','get_page','{"slug":"x","source_id":"other"}'],['--authorized-write','put','x','--source-id','other']]) {
    expect(run('bin/gstack-gbrain-codex',args).status).toBe(1);
  }
  const before=readFileSync(join(temp,'calls.jsonl'),'utf8');
  native.mcp_servers.chosen.env.GBRAIN_SOURCE='changed';saveNative();
  expect(run('bin/gstack-gbrain-codex',['search','x']).status).toBe(1);
  expect(refresh([]).status).toBe(1);
  delete native.mcp_servers.chosen;saveNative();
  expect(run('bin/gstack-gbrain-codex',['search','x']).status).toBe(1);
  expect(readFileSync(join(temp,'calls.jsonl'),'utf8')).toBe(before);
});
test('qualified page slugs fail closed while colon search stays a literal query',()=>{
  expect(refresh().status).toBe(0);
  const before=readFileSync(join(temp,'calls.jsonl'),'utf8');
  for(const args of [['get','other:page'],['--authorized-write','put','other:page'],['call','get_page','{"slug":"other:page"}']]) {
    expect(run('bin/gstack-gbrain-codex',args).status).toBe(1);
  }
  expect(readFileSync(join(temp,'calls.jsonl'),'utf8')).toBe(before);
  expect(run('bin/gstack-gbrain-codex',['search','other:needle']).status).toBe(0);
});
test('ambient routing and cwd cannot override the explicit host binding',()=>{
  Object.assign(env,{GBRAIN_BRAIN_ID:'wrong',GBRAIN_DATABASE_URL:'postgres://wrong',GBRAIN_DIRECT_DATABASE_URL:'postgres://wrong'});
  expect(refresh().status).toBe(0);
  expect(run('bin/gstack-gbrain-codex',['search','needle']).status).toBe(0);
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const probes=calls.filter(call=>['--version','doctor','sources'].includes(call.args[0]));
  const dispatches=calls.filter(call=>!['--version','doctor','sources'].includes(call.args[0]));
  expect(probes.length).toBeGreaterThan(0);
  expect(dispatches.map(call=>call.args[0])).toEqual(['search']);
  for(const call of probes) {
    const expectedCwd=call.args[0]==='sources' ? join(temp,'brain','.gbrain') : join(temp,'brain');
    expect(call.cwd, `${call.args.join(' ')} cwd=${call.cwd}`).toBe(realpathSync(expectedCwd));
  }
  for(const call of dispatches) {
    expect(call.brain).toBe('host');
    expect(call.gdatabase).toBe('postgres://fixture');
    expect(call.direct).toBeUndefined();
    expect(call.cwd).toBe(realpathSync(join(temp,'brain')));
  }
});
test('explicit native database routing wins over the home config for probes and calls',()=>{
  native.mcp_servers.chosen.env.DATABASE_URL='postgres://native'; saveNative();
  expect(refresh().status).toBe(0);
  expect(run('bin/gstack-gbrain-codex',['search','needle']).status).toBe(0);
  expect(run('bin/gstack-gbrain-codex',['--authorized-write','put','fixture','--content','test']).status).toBe(0);
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  for(const call of calls) {
    expect(call.database).toBe('postgres://native');
    expect(call.gdatabase).toBe('postgres://native');
  }
});
test('authorized stdin saves preserve Markdown metacharacters literally',()=>{
  expect(refresh().status).toBe(0);
  const content='# Fixture\n`echo example` $(echo example) $HOME "quoted" \\slashes\n';
  expect(run('bin/gstack-gbrain-codex',['--authorized-write','put','fixture'],content).status).toBe(0);
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(calls.at(-1).stdin).toBe(content);
  expect(calls.at(-1).args).toEqual(['put','fixture']);
});
test('request stdin maps hostile values to literal argv without shell evaluation',()=>{
  expect(refresh().status).toBe(0);
  const marker=join(temp,'request-stdin-marker');
  const query=`query café 🐝 日本語 "quoted" \`backtick\` $(touch ${marker})\nnext`;
  const slug=`slug-café-🐝-日本語-"quoted"-\`backtick\`-$(touch ${marker})\nnext`;
  const content=`# Content\nCafé 🐝 日本語 "quoted" \`backtick\` $(touch ${marker}) $HOME\nnext`;
  const request=(authorized:boolean, body:unknown)=>run(
    'bin/gstack-gbrain-codex',
    [...(authorized?['--authorized-write']:[]),'--request-stdin'],
    JSON.stringify(body),
  );

  expect(request(false,{op:'search',query}).status).toBe(0);
  expect(request(false,{op:'get',slug}).status).toBe(0);
  // The request body cannot grant write authority. The wrapper must reject
  // before the fixture executable is invoked.
  expect(request(false,{op:'put',slug,content}).status).toBe(1);
  expect(request(true,{op:'put',slug,content}).status).toBe(0);
  expect(existsSync(marker)).toBe(false);

  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const search=calls.find(call=>call.args[0]==='search');
  expect(search.args).toEqual(['search',query]);
  const get=calls.find(call=>call.args[0]==='call');
  expect(get.args.slice(0,2)).toEqual(['call','get_page']);
  expect(JSON.parse(get.args[2])).toEqual({slug,include_content:true,source_id:'selected'});
  const put=calls.at(-1);
  expect(put.args).toEqual(['put',slug]);
  expect(put.stdin).toBe(content);
});
test('request stdin sends large Markdown through child stdin, not argv',()=>{
  expect(refresh().status).toBe(0);
  const content='Café 🐝 日本語\n'+('literal markdown '.repeat(10_000));
  expect(Buffer.byteLength(content,'utf8')).toBeGreaterThan(128*1024);
  expect(Buffer.byteLength(JSON.stringify({op:'put',slug:'large-content',content}),'utf8')).toBeLessThan(1_048_576);
  expect(run('bin/gstack-gbrain-codex',['--authorized-write','--request-stdin'],JSON.stringify({op:'put',slug:'large-content',content})).status).toBe(0);
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const put=calls.at(-1);
  expect(put.args).toEqual(['put','large-content']);
  expect(put.stdin).toBe(content);
  expect(JSON.stringify(put.args)).not.toContain(content);
});
test('request stdin rejects invalid JSON, extra fields, source overrides, and missing authorization without invocation',()=>{
  expect(refresh().status).toBe(0);
  const before=readFileSync(join(temp,'calls.jsonl'),'utf8');
  const invoke=(body:string, flags:string[]=['--request-stdin'])=>run('bin/gstack-gbrain-codex',flags,body);
  expect(invoke(JSON.stringify({op:'get',slug:'fixture',source_id:'other'})).status).toBe(1);
  expect(invoke(JSON.stringify({op:'search',query:'fixture',extra:'not allowed'})).status).toBe(1);
  expect(invoke(JSON.stringify({op:'search',query:'--source-id=other'})).status).toBe(1);
  expect(invoke(JSON.stringify({op:'remove',slug:'fixture'})).status).toBe(1);
  expect(invoke('{"op":"search"}').status).toBe(1);
  expect(invoke(JSON.stringify({op:'search',query:'x'.repeat(1_048_500)})).status).toBe(1);
  expect(invoke(JSON.stringify({op:'put',slug:'fixture',content:'x'})).status).toBe(1);
  expect(invoke(JSON.stringify(['search','fixture'])).status).toBe(1);
  expect(invoke(JSON.stringify({op:'search',query:'fixture'}),['--request-stdin','search']).status).toBe(1);
  expect(readFileSync(join(temp,'calls.jsonl'),'utf8')).toBe(before);
});

test('every content-bearing Codex send has a content-free receipt before subprocess dispatch', () => {
  expect(refresh().status).toBe(0);
  const content='Private fixture body $() with a newline\n';
  const requests=[
    {flags:[], body:{op:'search',query:'private-fixture-query'}},
    {flags:[], body:{op:'get',slug:'private-fixture-page'}},
    {flags:['--authorized-write'], body:{op:'put',slug:'private-fixture-output',content}},
  ];
  for (const request of requests) expect(run('bin/gstack-gbrain-codex',[...request.flags,'--request-stdin'],JSON.stringify(request.body)).status).toBe(0);
  const order=readFileSync(join(temp,'calls.jsonl.receipt-order'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(order).toHaveLength(3);
  expect(order.every(row=>row.receiptBeforeDispatch)).toBe(true);
  const raw=readFileSync(join(temp,'state/security/egress.jsonl'),'utf8');
  const receipts=raw.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.sink==='gbrain-codex');
  expect(receipts).toHaveLength(3);
  expect(receipts.at(-1).sha256).toBe(createHash('sha256').update(content).digest('hex'));
  for(const privateValue of [content,'private-fixture-query','private-fixture-page','postgres://fixture']) expect(raw).not.toContain(privateValue);
  expect(receipts.at(-1).consent).toContain('--authorized-write');
});

test('receipt failure prevents reads and authorized writes from dispatching', () => {
  expect(refresh().status).toBe(0);
  mkdirSync(join(temp,'state/security'),{recursive:true});
  // A directory at the ledger path causes a deterministic failure even as root.
  mkdirSync(join(temp,'state/security/egress.jsonl'));
  const before=readFileSync(join(temp,'calls.jsonl'),'utf8');
  for(const args of [['search','fixture'],['get','fixture'],['call','get_page','{"slug":"fixture"}'],['--authorized-write','put','fixture','--content','fixture']]) {
    const result=run('bin/gstack-gbrain-codex',args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EGRESS_RECEIPT_FAILED');
    expect(result.stderr).not.toContain('postgres://');
  }
  expect(readFileSync(join(temp,'calls.jsonl'),'utf8')).toBe(before);
});

test('invalid UTF-8 input cannot become a different content-bearing send', () => {
  expect(refresh().status).toBe(0);
  const before = readFileSync(join(temp, 'calls.jsonl'), 'utf8');
  const result = spawnSync(process.execPath, [join(root, 'bin/gstack-gbrain-codex'), '--authorized-write', 'put', 'fixture'], {env, input: Buffer.from([0xff]), encoding:'utf8', timeout:5_000});
  expect(result.status).toBe(1);
  expect(readFileSync(join(temp, 'calls.jsonl'), 'utf8')).toBe(before);
});

test('private file transport preserves literal bytes and recovers successful artifacts in Trash', () => {
  expect(refresh().status).toBe(0);
  mkdirSync(join(temp,'.Trash'),{mode:0o700});
  const allocated=run('bin/gstack-gbrain-codex',['--prepare-request']);
  expect(allocated.status).toBe(0);
  const request=JSON.parse(allocated.stdout);
  const content='Literal $(touch nope) `ignored` "quoted" ☃\n';
  writeFileSync(request.path,JSON.stringify({op:'put',slug:'private-transport',content}));
  const result=run('bin/gstack-gbrain-codex',['--authorized-write','--request-file',request.path]);
  expect(result.status).toBe(0);
  const artifact=JSON.parse(result.stderr.match(/GSTACK_REQUEST_ARTIFACT: (.+)/)![1]);
  expect(artifact.status).toBe(process.platform==='darwin'?'retired':'retained_private');
  const retainedPath=join(artifact.path,'request.json');
  expect(JSON.parse(readFileSync(retainedPath,'utf8')).content).toBe(content);
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(calls.at(-1).stdin).toBe(content);
  expect(result.stderr).not.toContain(content);
});

test('concurrent file consumers dispatch only once and leave failed artifacts explicitly private', async () => {
  expect(refresh().status).toBe(0);
  const request=JSON.parse(run('bin/gstack-gbrain-codex',['--prepare-request']).stdout);
  writeFileSync(request.path,JSON.stringify({op:'search',query:'single-claim'}));
  const invoke=async()=>{
    const child=Bun.spawn([process.execPath,join(root,'bin/gstack-gbrain-codex'),'--request-file',request.path],{env,stdout:'pipe',stderr:'pipe'});
    return {status:await child.exited,stderr:await new Response(child.stderr).text()};
  };
  const results=await Promise.all([invoke(),invoke()]);
  expect(results.map(result=>result.status).sort()).toEqual([0,1]);
  expect(results.find(result=>result.status===1)!.stderr).toContain('already claimed');
  expect(results.find(result=>result.status===0)!.stderr).toContain('retained_private');
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(calls.filter(call=>call.args[0]==='search'&&call.args[1]==='single-claim')).toHaveLength(1);

  const failed=JSON.parse(run('bin/gstack-gbrain-codex',['--prepare-request']).stdout);
  writeFileSync(failed.path,JSON.stringify({op:'put',slug:'not-authorized',content:'do not send'}));
  const refused=run('bin/gstack-gbrain-codex',['--request-file',failed.path]);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('retained_private');
  expect(readFileSync(failed.path,'utf8')).toContain('do not send');
});
test('PGLite and unknown engines are rejected before launching a competing CLI',()=>{
  for(const engine of ['pglite','unknown',undefined]) {
    writeFileSync(join(temp,'brain','.gbrain','config.json'),JSON.stringify({engine}));
    const result=refresh();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires an explicit Postgres engine');
    expect(existsSync(join(temp,'calls.jsonl'))).toBe(false);
  }
});
test('native MCP tool controls and unknown registration policies cannot be bypassed',()=>{
  expect(refresh().status).toBe(0);
  const before=readFileSync(join(temp,'calls.jsonl'),'utf8');
  for(const [key,value] of Object.entries({enabled_tools:['search'],disabled_tools:['put_page'],tools:{put_page:{approval_mode:'prompt'}},future_policy:{writes:false}})) {
    native.mcp_servers.chosen[key]=value;saveNative();
    expect(refresh().status).toBe(1);
    expect(run('bin/gstack-gbrain-codex',['--authorized-write','put','fixture','--content','fixture']).status).toBe(1);
    delete native.mcp_servers.chosen[key];
  }
  expect(readFileSync(join(temp,'calls.jsonl'),'utf8')).toBe(before);
});
test('refresh detection and later calls preserve explicitly configured native PATH',()=>{
  const nativePrefix=join(temp,'native-helpers');
  native.mcp_servers.chosen.env.PATH=`${nativePrefix}:${process.env.PATH}`;saveNative();
  env.PATH=`${join(temp,'caller-only')}:${env.PATH}`;
  const result=refresh();
  expect(result.status,result.stderr).toBe(0);
  expect(run('bin/gstack-gbrain-detect',['--host','codex']).status).toBe(0);
  expect(run('bin/gstack-gbrain-codex',['search','needle']).status).toBe(0);
  const calls=readFileSync(join(temp,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  for(const call of calls) {
    expect(call.path).toContain(nativePrefix);
    expect(call.path).not.toContain(join(temp,'caller-only'));
  }
});
test('a verified-dead refresh owner is recovered and a live owner is preserved',()=>{
  const state=join(temp,'state'), lock=join(state,'.gbrain-codex-refresh.v2.lock');
  mkdirSync(lock,{recursive:true});
  // A completed child gives us a real PID that is no longer live.
  const child=spawnSync(process.execPath,['-e',''],{encoding:'utf8',timeout:30_000});
  expect(child.status).toBe(0);
  if (typeof child.pid !== 'number') throw new Error('Completed fixture child did not expose a PID.');
  const owner=`owner-${child.pid}-fixture.json`;
  writeFileSync(join(lock,owner),JSON.stringify({pid:child.pid,host:hostname()}));
  expect(refresh().status).toBe(0);
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(state).some(name=>name.startsWith('gbrain-codex-stale-owner-'))).toBe(true);
  mkdirSync(lock);
  const liveOwner=`owner-${process.pid}-live.json`;
  writeFileSync(join(lock,liveOwner),JSON.stringify({pid:process.pid,host:hostname()}));
  const before=readFileSync(join(temp,'calls.jsonl'),'utf8');
  expect(refresh([]).status).toBe(1);
  expect(existsSync(join(lock,liveOwner))).toBe(true);
  expect(readFileSync(join(temp,'calls.jsonl'),'utf8')).toBe(before);
});
test('unknown and legacy locks fail without stealing ownership',()=>{
  const legacy=join(temp,'state','.gbrain-codex-refresh.lock');
  mkdirSync(legacy,{recursive:true});
  expect(refresh().stderr).toContain('Legacy refresh lock');
  expect(existsSync(legacy)).toBe(true);
  rmSync(legacy,{recursive:true});
  const lock=join(temp,'state','.gbrain-codex-refresh.v2.lock');
  mkdirSync(lock);
  writeFileSync(join(lock,'user-data'),'preserve');
  expect(refresh().status).toBe(1);
  expect(readFileSync(join(lock,'user-data'),'utf8')).toBe('preserve');
  expect(existsSync(join(temp,'calls.jsonl'))).toBe(false);
});
test('concurrent stale-lock reclaimers retain one owner and converge',async()=>{
  const state=join(temp,'state'), lock=join(state,'.gbrain-codex-refresh.v2.lock');
  mkdirSync(lock,{recursive:true});
  const child=spawnSync(process.execPath,['-e',''],{encoding:'utf8',timeout:30_000});
  expect(child.status).toBe(0);
  if (typeof child.pid !== 'number') throw new Error('Completed fixture child did not expose a PID.');
  const dead=child.pid;
  writeFileSync(join(lock,`owner-${dead}-fixture.json`),JSON.stringify({pid:dead,host:hostname()}));
  const launch=()=>new Promise<number|null>((resolve,reject)=>{
    const child=spawn(process.execPath,[join(root,'scripts/refresh-codex-gbrain.ts'),'--server','chosen'],{env,stdio:'ignore'});
    child.on('error',reject); child.on('close',resolve);
  });
  const results=await Promise.all([launch(),launch()]);
  expect(results).toContain(0);
  expect(results.every(code=>code===0 || code===1)).toBe(true);
  expect(existsSync(lock)).toBe(false);
  expect(refresh([]).status).toBe(0);
  expect(readdirSync(state).filter(name=>name.startsWith('gbrain-codex-stale-owner-')).length).toBe(1);
});
test('unsupported inherited registrations and nonstandard executable names fail before probing',()=>{
  native.mcp_servers.chosen.env_vars=['GBRAIN_SOURCE']; saveNative();
  expect(refresh().status).toBe(1);
  delete native.mcp_servers.chosen.env_vars;
  native.mcp_servers.chosen.command=join(temp,'bin','custom-gbrain');
  writeFileSync(native.mcp_servers.chosen.command,'fixture',{mode:0o755}); saveNative();
  expect(refresh().status).toBe(1);
  expect(existsSync(join(temp,'calls.jsonl'))).toBe(false);
});
test('configuration drift and disabled servers fail closed',()=>{
  const initial=refresh();
  expect(initial.status,initial.stderr).toBe(0);
  writeFileSync(join(temp,'brain','.gbrain','config.json'),'{}');
  expect(run('bin/gstack-gbrain-codex',['search','x']).status).toBe(1);
  native.mcp_servers.chosen.enabled=false;saveNative();
  expect(refresh().status).toBe(1);
});
test('repeated refresh is recoverable and unrelated broken skill links are preserved',()=>{
  expect(refresh().status).toBe(0);
  const link=join(temp,'codex','skills','gstack-ship');
  const original=readlinkSync(link);
  expect(refresh([]).status).toBe(0);
  expect(readlinkSync(link)).toBe(original);
  const other=join(temp,'codex','skills','gstack-review');
  rmSync(other);symlinkSync(join(temp,'unrelated-missing'),other);
  expect(refresh([]).status).toBe(1);
  expect(readlinkSync(other)).toBe(join(temp,'unrelated-missing'));
});
test.skipIf(process.getuid?.() === 0)('a filesystem install failure restores prior render and state',()=>{
  expect(refresh().status).toBe(0);
  const before=readFileSync(join(temp,'state','gbrain-codex-binding.json'),'utf8');
  const skills=join(temp,'codex','skills');
  const ship=readFileSync(join(skills,'gstack-ship','SKILL.md'),'utf8');
  chmodSync(skills,0o500);
  try {
    const result=refresh([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('previous installation was restored');
    expect(readFileSync(join(temp,'state','gbrain-codex-binding.json'),'utf8')).toBe(before);
    expect(readFileSync(join(skills,'gstack-ship','SKILL.md'),'utf8')).toBe(ship);
  } finally {chmodSync(skills,0o700);}
  expect(existsSync(join(temp,'state','.gbrain-codex-refresh.v2.lock'))).toBe(false);
});
test('malformed native configuration is not echoed in caller diagnostics',()=>{
  expect(refresh().status).toBe(0);
  writeFileSync(join(temp,'codex','config.toml'),'not valid TOML FIXTURE_SECRET');
  const result=run('bin/gstack-gbrain-codex',['search','x']);
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain('FIXTURE_SECRET');
});
test('refresh refuses a missing or unrelated runtime before touching installed skills',()=>{
  rmSync(join(temp,'codex','skills','gstack'));
  expect(refresh().status).toBe(1);
  expect(existsSync(join(temp,'state','gbrain-codex-binding.json'))).toBe(false);
  expect(existsSync(join(temp,'calls.jsonl'))).toBe(false);
});

for (const scenario of [
  {name:'partial render with caught generator error',diagnostic:true,complete:false},
  {name:'missing expected skill without diagnostics',diagnostic:false,complete:false},
  {name:'complete skill set with generator diagnostics',diagnostic:true,complete:true},
]) test(`refresh retains the entire prior installation on ${scenario.name}`,()=>{
  expect(refresh().status).toBe(0);
  const state=join(temp,'state'), skills=join(temp,'codex','skills');
  const binding=readFileSync(join(state,'gbrain-codex-binding.json'),'utf8');
  const detection=readFileSync(join(state,'gbrain-detection.json'),'utf8');
  const before=readdirSync(skills).filter(name=>name.startsWith('gstack-')).map(name=>({
    name,target:readlinkSync(join(skills,name)),body:readFileSync(join(skills,name,'SKILL.md'),'utf8'),
  }));
  // A separate fixture checkout exercises the actual refresh subprocess,
  // without changing production sources or adding a test-only runtime switch.
  const fixture=join(temp,'fixture');
  mkdirSync(join(fixture,'scripts'),{recursive:true});
  symlinkSync(join(root,'scripts','models.ts'),join(fixture,'scripts','models.ts'));
  for(const dir of ['lib','hosts','bin']) symlinkSync(join(root,dir),join(fixture,dir));
  for(const file of ['refresh-codex-gbrain.ts','resolve-codex-generation-model.ts','discover-skills.ts']) {
    copyFileSync(join(root,'scripts',file),join(fixture,'scripts',file));
  }
  for(const name of ['ship','review']) {
    mkdirSync(join(fixture,name));
    writeFileSync(join(fixture,name,'SKILL.md.tmpl'),`---\nname: ${name}\n---\nFixture\n`);
  }
  writeFileSync(join(fixture,'scripts','gen-skill-docs.ts'),`
import {mkdirSync,writeFileSync} from 'fs';
import {join} from 'path';
const output=process.argv[process.argv.indexOf('--out-dir')+1];
for(const name of ${JSON.stringify(scenario.complete?['ship','review']:['ship'])}) {
  const dir=join(output,'.agents','skills','gstack-'+name);
  mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),'gstack-gbrain-codex new fixture');
}
${scenario.diagnostic?"console.error('WARNING: codex generation failed: fixture caught error');":''}
process.exit(0);
`);
  const result=spawnSync(process.execPath,[join(fixture,'scripts','refresh-codex-gbrain.ts'),'--server','chosen'],{env,encoding:'utf8',timeout:30_000});
  expect(result.status,result.stderr).toBe(1);
  expect(result.stderr).toContain(scenario.diagnostic?'generator diagnostics':'expected skill');
  expect(result.stdout).not.toContain('enrichment refreshed');
  expect(readFileSync(join(state,'gbrain-codex-binding.json'),'utf8')).toBe(binding);
  expect(readFileSync(join(state,'gbrain-detection.json'),'utf8')).toBe(detection);
  for(const old of before) {
    expect(readlinkSync(join(skills,old.name))).toBe(old.target);
    expect(readFileSync(join(skills,old.name,'SKILL.md'),'utf8')).toBe(old.body);
  }
});
