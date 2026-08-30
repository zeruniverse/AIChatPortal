import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const log = '/tmp/chatapp-provider-log.jsonl';
fs.rmSync(log,{force:true});
fs.rmSync(path.join(root,'chat'),{recursive:true,force:true});
fs.mkdirSync(path.join(root,'chat'),{recursive:true});
const configPath='/tmp/chatapp-test-config.json';
fs.writeFileSync(configPath, JSON.stringify({
 host:'127.0.0.1', port:4100,
 auth:{sessionSecret:'0123456789abcdef0123456789abcdef',cookieName:'chat_session',users:[{id:'u1',label:'U1',token:'abcdefghijklmnop'}]},
 provider:{url:'http://127.0.0.1:4101/v1/chat/completions',key:'provider-test-key',headers:{},extraBody:{}},
 models:[{id:'m1',label:'M1'},{id:'m2',label:'M2'},{id:'m3',label:'M3'}],
 limits:{maxConcurrentTasks:10,maxCompressedAttachmentBytes:70000000,maxRawUploadBytesPerTurn:10000000,maxFilesPerTurn:20},
 cleanup:{maxChatBytes:3000000000,pressureAgeHours:24,maxAgeDays:7,orphanUploadHours:24,intervalMinutes:10}
}));
const mock=spawn(process.execPath,['tests/mock-provider.js'],{cwd:root,env:{...process.env,MOCK_LOG:log,MOCK_PORT:'4101'},stdio:['ignore','pipe','pipe']});
const app=spawn(process.execPath,['server/app.js'],{cwd:root,env:{...process.env,CONFIG_PATH:configPath},stdio:['ignore','pipe','pipe']});
app.stdout.on('data',d=>process.stdout.write('[app] '+d)); app.stderr.on('data',d=>process.stderr.write('[app-err] '+d));
mock.stderr.on('data',d=>process.stderr.write('[mock-err] '+d));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(url, timeout=8000){const start=Date.now();while(Date.now()-start<timeout){try{const r=await fetch(url);if(r.ok)return r;}catch{}await sleep(100);}throw new Error('wait timeout '+url)}
let cookie='';
async function req(url, options={}){const headers={...(options.headers||{})};if(cookie)headers.Cookie=cookie;const r=await fetch('http://127.0.0.1:4100'+url,{...options,headers});const ct=r.headers.get('content-type')||'';const body=ct.includes('json')?await r.json():await r.arrayBuffer();if(!r.ok)throw new Error(`${r.status} ${body?.error||Buffer.from(body).toString()}`);return {r,body};}
async function login(){const r=await fetch('http://127.0.0.1:4100/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'abcdefghijklmnop'})});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];}
async function upload(name, data){const s=(await req('/api/uploads',{method:'POST'})).body.id;const f=(await req(`/api/uploads/${s}/files`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,size:data.length,type:'application/octet-stream'})})).body.id;await req(`/api/uploads/${s}/files/${f}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:data});return s;}
async function waitTurn(cid,no){for(let i=0;i<160;i++){const d=(await req(`/api/conversations/${cid}`)).body;const t=d.turns.find(x=>x.turnNo===no);if(t&&['completed','error'].includes(t.status))return d;await sleep(100);}throw new Error('turn wait timeout')}
function getLog(){return fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)}
function imageZipNames(imageUrl){assert.ok(imageUrl?.startsWith('data:image/jpeg;base64,'));const b=Buffer.from(imageUrl.split(',')[1],'base64');const eoi=b.indexOf(Buffer.from([0xff,0xd9]));assert.ok(eoi>=0);const z=b.subarray(eoi+2);const p='/tmp/aggregate-test.zip';fs.writeFileSync(p,z);const out=spawnSync('unzip',['-Z1',p],{encoding:'utf8'});assert.equal(out.status,0,out.stderr);return out.stdout.trim().split('\n').filter(Boolean).sort();}
try{
 await wait('http://127.0.0.1:4100/api/health'); await login();
 const headers=await fetch('http://127.0.0.1:4100/api/health');
 assert.match(headers.headers.get('content-security-policy'),/img-src[^;]*https:/); assert.equal(headers.headers.get('cross-origin-opener-policy'),null); assert.equal(headers.headers.get('origin-agent-cluster'),null);
 const up1=await upload('one.txt',Buffer.from('first attachment'));
 const c=(await req('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'q1',modelId:'m1',uploadId:up1,shareEnabled:true})})).body.id;
 let d=await waitTurn(c,1); assert.equal(d.turns[0].attachmentReady,true); assert.equal(d.turns[0].modelId,'m1');
 let dl=await req(`/api/conversations/${c}/turns/1/attachments`); assert.equal(dl.r.status,200); assert.ok(Buffer.from(dl.body).subarray(0,2).equals(Buffer.from('PK')));
 let all=await fetch(`http://127.0.0.1:4100/api/conversations/${c}/attachments`,{headers:{Cookie:cookie}}); assert.equal(all.status,404);
 await req(`/api/conversations/${c}/turns`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'q2',modelId:'m2'})});
 d=await waitTurn(c,2); assert.equal(d.turns[1].hasAttachments,false); assert.equal(fs.existsSync(path.join(root,'chat',`${c}.turn-2.attachments.bin`)),false);
 const up3=await upload('three.bin',Buffer.from('third attachment'));
 await req(`/api/conversations/${c}/turns`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'q3',modelId:'m3',uploadId:up3})});
 d=await waitTurn(c,3); assert.equal(d.turns[2].attachmentReady,true); assert.equal(d.turns[2].modelId,'m3');
 dl=await req(`/api/conversations/${c}/turns/3/attachments`); assert.equal(dl.r.status,200);
 const logs=getLog(); assert.deepEqual(imageZipNames(logs[0].imageUrl),['1.zip']); assert.deepEqual(imageZipNames(logs[1].imageUrl),['1.zip']); assert.deepEqual(imageZipNames(logs[2].imageUrl),['1.zip','3.zip']);
 assert.match(logs[1].prompt,/这是一次用户的追问/); assert.match(logs[1].prompt,/q1/);
 await req(`/api/conversations/${c}/turns/1`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'q1 edited',modelId:'m2'})});
 d=await waitTurn(c,1); assert.equal(d.turns.length,1); assert.equal(d.turns[0].question,'q1 edited'); assert.equal(d.turns[0].modelId,'m2'); assert.equal(fs.existsSync(path.join(root,'chat',`${c}.turn-2.attachments.bin`)),false); assert.equal(fs.existsSync(path.join(root,'chat',`${c}.turn-3.attachments.bin`)),false); assert.equal(fs.existsSync(path.join(root,'chat',`${c}.turn-1.attachments.bin`)),true);
 const share=d.shareToken; const pub=await fetch(`http://127.0.0.1:4100/api/public/shares/${share}`); assert.equal(pub.status,200); const pubdl=await fetch(`http://127.0.0.1:4100/api/public/shares/${share}/turns/1/attachments`); assert.equal(pubdl.status,200);
 await req(`/api/conversations/${c}`,{method:'DELETE'}); assert.equal(fs.existsSync(path.join(root,'chat',`${c}.text.bin`)),false); assert.equal(fs.existsSync(path.join(root,'chat',`${c}.turn-1.attachments.bin`)),false); assert.equal((await fetch(`http://127.0.0.1:4100/api/public/shares/${share}`)).status,404);
 const credit=(await req('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'credit-error',modelId:'m1'})})).body.id;
 const creditData=await waitTurn(credit,1); assert.equal(creditData.turns[0].status,'error'); assert.match(creditData.turns[0].answer,/insufficient credit/); assert.match(creditData.turns[0].answer,/insufficient_credit/);
 const image=(await req('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'image-response',modelId:'m1'})})).body.id;
 const imageData=await waitTurn(image,1); assert.equal(imageData.turns[0].status,'completed'); assert.match(imageData.turns[0].answer,/https:\/\/files\.example\.test\/result\.png/);
 const streamImage=(await req('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'stream-image-response',modelId:'m1'})})).body.id;
 const streamImageData=await waitTurn(streamImage,1); assert.equal(streamImageData.turns[0].status,'completed'); assert.match(streamImageData.turns[0].answer,/https:\/\/files\.example\.test\/stream\.png/);
 console.log('INTEGRATION OK');
} finally { app.kill('SIGTERM'); mock.kill('SIGTERM'); await sleep(300); }
