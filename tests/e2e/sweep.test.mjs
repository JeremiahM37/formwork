import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ROOT} from '../helpers/load.mjs';

test('live sweep never clicks an Apply submit button and inspects iframe fields', {timeout:60000},async t=>{
  let submissions=0;
  const server=createServer((req,res)=>{
    if(req.method==='POST') submissions++;
    res.setHeader('Content-Type','text/html');
    res.end(`<form method="POST" action="/submitted"><label>First name<input name="first"></label><button type="submit">Apply</button></form><iframe srcdoc='<label>Email<input type="email"></label>'></iframe>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const work=mkdtempSync(join(tmpdir(),'formwork-sweep-'));t.after(()=>rmSync(work,{recursive:true,force:true}));
  const report=join(work,'report.json');
  await promisify(execFile)(process.execPath,['tools/sweep.mjs','--profile','tests/fixtures/profile.example.json','--out',report,`http://127.0.0.1:${server.address().port}/`],{cwd:ROOT,timeout:45000});
  assert.equal(submissions,0);
  const row=JSON.parse(readFileSync(report)).rows[0];
  assert.equal(row.frames,2);
  assert.equal(row.fields,2);
  assert.equal(row.answered,2);
});
