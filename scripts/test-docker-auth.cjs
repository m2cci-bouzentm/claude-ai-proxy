#!/usr/bin/env node
'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const volumeName = `test-claude-vol-${process.pid}-${Date.now()}`;
const imageName = `test-claude-img-${process.pid}-${Date.now()}`;

const docker = (...args) => execFileSync('docker', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const serverName = `${volumeName}-server`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-auth-fixture-'));
const statusKeys = ['configured','type','provider','expiresAt','isExpired','accessPresent','refreshPresent','accountIdPresent','subscriptionType','rateLimitTier'].sort();
const secretAccess = 'synthetic-docker-access-first';
const secretRefresh = 'synthetic-docker-refresh-first';
function command(args, input, env = []) {
  const r = spawnSync('docker', ['run','--rm','--network','none','-i','-v',`${volumeName}:/data`,'-v',`${scratch}:/fixture`,...env.flatMap(e=>['-e',e]),imageName,'proxy-auth',...args], {cwd:root,encoding:'utf8',input,maxBuffer:8*1024*1024,timeout:30000});
  // Bounded stdin reader may close pipe before oversized input finishes.
  if(r.error && r.error.code !== 'EPIPE') throw r.error;
  for(const secret of [secretAccess,secretRefresh,'MALFORMED_SECRET_NEVER_PRINT']) assert.ok(!(r.stdout+r.stderr).includes(secret),'secret leaked');
  return r;
}
function contract(value, envelope=false) {
  const copy={...value}; if(envelope){assert.equal(copy.success,true);delete copy.success;}
  assert.deepEqual(Object.keys(copy).sort(),statusKeys);
}
function rejected(r) {assert.notEqual(r.status,0);assert.equal(r.stdout,'');}


(async () => {
  try {
    console.log('Building Docker image...');
    docker('build', '-t', imageName, root);

    console.log('Creating volume for persistent auth...');
    docker('volume', 'create', volumeName);

    // 1. Initial status in container -> unconfigured
    const initialStatusRaw = docker('run', '--rm', '-v', `${volumeName}:/data`, imageName, 'proxy-auth', 'status');
    const initialStatus = JSON.parse(initialStatusRaw);
    contract(initialStatus);
    const loginHelp = docker('run','--rm','--network','none',imageName,'claude','auth','login','--help');
    assert.match(loginHelp,/--email/);
    console.log('PASS: actual image Claude login help');
    assert.equal(initialStatus.configured, false);

    // 2. Import valid synthetic auth via stdin
    const syntheticAuth = {
      type: 'oauth',
      access: secretAccess,
      refresh: secretRefresh,
      expires: Date.now() + 3600000,
      subscriptionType: 'pro'
    };

    const importResRaw = execFileSync('docker', [
      'run', '--rm', '-i',
      '-v', `${volumeName}:/data`,
      imageName,
      'proxy-auth', 'import', '-'
    ], { input: JSON.stringify(syntheticAuth), encoding: 'utf8' });

    const importRes = JSON.parse(importResRaw);
    contract(importRes,true);
    assert.equal(importRes.success, true);
    assert.equal(importRes.configured, true);
    assert.equal(importRes.subscriptionType, 'pro');
    assert.equal(importResRaw.includes('sk-ant-docker-test-access-token'), false);
    assert.equal(importResRaw.includes('sk-ant-docker-test-refresh-token'), false);

    // 3. Status in container -> configured, no tokens exposed
    const afterStatusRaw = docker('run', '--rm', '-v', `${volumeName}:/data`, imageName, 'proxy-auth', 'status');
    const afterStatus = JSON.parse(afterStatusRaw);
    assert.equal(afterStatus.configured, true);
    assert.equal(afterStatus.type, 'oauth');
    assert.equal(afterStatus.access, undefined);
    assert.equal(afterStatus.refresh, undefined);
    assert.equal(afterStatusRaw.includes('sk-ant-docker-test-access-token'), false);

    // 4. Test entrypoint wrapper shorthand: "status" without "proxy-auth"
    const shorthandStatusRaw = docker('run', '--rm', '-v', `${volumeName}:/data`, imageName, 'status');
    const shorthandStatus = JSON.parse(shorthandStatusRaw);
    assert.equal(shorthandStatus.configured, true);

    contract(afterStatus);
    assert.equal(afterStatusRaw.includes(secretAccess),false);
    assert.equal(afterStatusRaw.includes(secretRefresh),false);
    assert.equal(afterStatus.type,'oauth');
    assert.equal(afterStatus.provider,'claude');
    assert.equal(afterStatus.expiresAt,new Date(syntheticAuth.expires).toISOString());
    assert.equal(afterStatus.isExpired,false);
    assert.equal(afterStatus.accessPresent,true);
    assert.equal(afterStatus.refreshPresent,true);
    assert.equal(afterStatus.accountIdPresent,false);
    assert.equal(afterStatus.subscriptionType,'pro');
    assert.equal(afterStatus.rateLimitTier,null);
    rejected(command(['import','-'],'{"secret":"MALFORMED_SECRET_NEVER_PRINT", broken'));
    rejected(command(['import','-'],JSON.stringify({...syntheticAuth,padding:'x'.repeat(2*1024*1024)})));
    rejected(command(['import','-'],JSON.stringify({...syntheticAuth,access:42})));
    fs.writeFileSync(path.join(scratch,'valid.json'),JSON.stringify(syntheticAuth));
    fs.symlinkSync('/fixture/valid.json',path.join(scratch,'link.json'));
    rejected(command(['import','--file','/fixture/link.json']));
    rejected(command(['import','--file','/fixture']));
    docker('run','--rm','--network','none','-v',`${volumeName}:/data`,imageName,'node','-e',"const f=require('fs');f.mkdirSync('/data/target');f.symlinkSync('/data/target','/data/linked');const a=require('assert/strict');a.equal(f.statSync('/data').mode&511,448);a.equal(f.statSync('/data/auth.json').mode&511,384)");
    rejected(command(['import','-'],JSON.stringify(syntheticAuth),['PROXY_AUTH_DIR=/data/linked']));
    fs.writeFileSync(path.join(scratch,'claude'),`#!/usr/bin/env node\nconst f=require('fs'),p=require('path');console.log('STDOUT_LOGIN_PROMPT');console.error('STDERR_LOGIN_PROMPT');const d=process.env.CLAUDE_CONFIG_DIR;f.mkdirSync(d,{recursive:true});const file=p.join(d,'.credentials.json');try{f.unlinkSync(file)}catch{};const m=f.existsSync('/fixture/mode')?f.readFileSync('/fixture/mode','utf8'):'';if(m==='symlink'){f.writeFileSync('/data/generated-target.json','{}');f.symlinkSync('/data/generated-target.json',file)}else f.writeFileSync(file,m==='malformed'?'MALFORMED_SECRET_NEVER_PRINT {':JSON.stringify(m==='schema'?{claudeAiOauth:{accessToken:42}}:{claudeAiOauth:{accessToken:'${secretAccess}',refreshToken:'${secretRefresh}',expiresAt:${syntheticAuth.expires}}}));\n`,{mode:0o755});
    const env=['PATH=/fixture:/usr/local/bin:/usr/bin:/bin'];
    const login=command(['login'],undefined,env);
    assert.equal(login.status,0,login.stderr);contract(JSON.parse(login.stdout),true);
    assert.match(login.stderr,/STDOUT_LOGIN_PROMPT/);assert.match(login.stderr,/STDERR_LOGIN_PROMPT/);
    for(const mode of ['malformed','schema','symlink']) { fs.writeFileSync(path.join(scratch,'mode'),mode); const result=command(['login'],undefined,env); assert.notEqual(result.status,0,`generated credential ${mode} accepted`);rejected(result); }
    docker('run','--rm','--network','none','-v',`${volumeName}:/data`,imageName,'node','-e',"const f=require('fs');f.rmSync('/data/.claude',{recursive:true,force:true});f.symlinkSync('/data/target','/data/.claude')");
    rejected(command(['login'],undefined,env));
    console.log('PASS: security rejection, exact status contract, login prompts stderr / JSON stdout');
    docker('run','-d','--name',serverName,'--network','none','-v',`${volumeName}:/data`,'-v',`${path.join(root,'scripts/docker-auth-provider-fixture.cjs')}:/app/auth-fixture.cjs:ro`,'-e','NODE_OPTIONS=--require=/app/auth-fixture.cjs','-e','API_KEY=fixture-inbound',imageName);
    const request=`(async()=>{for(let i=0;i<100;i++){try{await fetch('http://127.0.0.1:4181/health');break}catch{await new Promise(r=>setTimeout(r,100))}}const r=await fetch('http://127.0.0.1:4181/anthropic/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':'fixture-inbound'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:8,messages:[{role:'user',content:'local fixture'}]})});require('assert/strict').equal(r.status,200,await r.text())})().catch(e=>{console.error(e);process.exit(1)})`;
    const pid=docker('inspect','-f','{{.State.Pid}}',serverName).trim();
    docker('exec','-e','NODE_OPTIONS=',serverName,'node','-e',request);
    const second=command(['import','-'],JSON.stringify({...syntheticAuth,access:'synthetic-docker-access-second'}));
    assert.equal(second.status,0,second.stderr);
    docker('exec','-e','NODE_OPTIONS=',serverName,'node','-e',request);
    const captures=JSON.parse(docker('exec','-e','NODE_OPTIONS=',serverName,'node','-e',"console.log(JSON.stringify(require('fs').readFileSync('/tmp/auth-provider.jsonl','utf8').trim().split('\\n').map(JSON.parse)))"));
    const messages=captures.filter(c=>c.path==='/v1/messages');
    assert.deepEqual(messages.map(c=>c.authorization),[`Bearer ${secretAccess}`,'Bearer synthetic-docker-access-second']);
    assert.equal(new Set(messages.map(c=>c.pid)).size,1);
    assert.equal(docker('inspect','-f','{{.State.Pid}}',serverName).trim(),pid);
    console.log('PASS: local HTTP provider Authorization changes after import; same server PID; external network disabled');
    console.log('PASS: Docker integration test with persistent volume and proxy-auth CLI succeeded');
  } catch(error) {
    try { console.error(docker('logs', '--tail', '40', serverName)); } catch {}
    throw error;
  } finally {
    try { docker('rm', '-f', serverName); } catch {}
    fs.rmSync(scratch,{recursive:true,force:true});
    try { docker('volume', 'rm', '-f', volumeName); } catch {}
    try { docker('image', 'rm', '-f', imageName); } catch {}
  }
})().catch(err => {
  console.error('Docker test failed:', err);
  process.exitCode = 1;
});
