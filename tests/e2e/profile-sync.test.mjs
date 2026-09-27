import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from '../helpers/load.mjs';

test('profile synchronization verifies values despite Chrome reordering storage keys', {timeout:45000}, async t=>{
  const directory=mkdtempSync(join(tmpdir(),'formwork-profile-sync-'));
  const extension=join(ROOT,'extension');
  const context=await chromium.launchPersistentContext(directory,{channel:'chromium',headless:true,
    args:[`--load-extension=${extension}`,`--disable-extensions-except=${extension}`,'--remote-debugging-port=0']});
  t.after(async()=>{await context.close();rmSync(directory,{recursive:true,force:true});});
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const port=readFileSync(join(directory,'DevToolsActivePort'),'utf8').split('\n')[0];
  // Deliberately not alphabetical: Chrome's readback reorders nested keys.
  const profile={schema_version:1,identity:{full_name:'Fixture Rivéra',email:'fixture@example.test'},skills:{languages:['Python']},education:[]};
  const {stdout}=await promisify(execFile)(process.execPath,['server/dashboard/drive.mjs','profile',JSON.stringify({profile,about:'Fixture notes'})],
    {cwd:ROOT,env:{...process.env,FORMWORK_CDP_URL:`http://localhost:${port}`,FORMWORK_CHROME_PROFILE:directory}});
  assert.deepEqual(JSON.parse(stdout),{ok:true});
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get(['profile','about'])),{profile,about:'Fixture notes'});
});
