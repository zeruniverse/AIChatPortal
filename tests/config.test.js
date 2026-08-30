import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
function make(models) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-config-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({host:'0.0.0.0',port:3000,auth:{sessionSecret:'0123456789abcdef0123456789abcdef',users:[{id:'u',token:'abcdefghijklmnop'}]},provider:{url:'https://example.test/v1/chat/completions',key:'k'},models}));
  return dir;
}
test('one model is accepted',()=>{const d=make([{id:'m',label:'M'}]);assert.equal(loadConfig(d).models.length,1);fs.rmSync(d,{recursive:true,force:true});});
test('ten models are accepted',()=>{const d=make(Array.from({length:10},(_,i)=>({id:`m${i}`,label:`M${i}`})));assert.equal(loadConfig(d).models.length,10);fs.rmSync(d,{recursive:true,force:true});});
test('eleven models are rejected',()=>{const d=make(Array.from({length:11},(_,i)=>({id:`m${i}`,label:`M${i}`})));assert.throws(()=>loadConfig(d),/1 到 10/);fs.rmSync(d,{recursive:true,force:true});});
