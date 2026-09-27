import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {lib, ROOT, profile, schemaOf} from '../helpers/load.mjs';
const humanize = lib('humanize');
const samples = ['', 'I built it in Go and C++.', 'I am writing to apply. I leverage cutting-edge tools.',
  'It is not just a parser, but a platform. I built it — then shipped it — in May.',
  'The posting says "world-class, cutting-edge tools".', '**Python** is my daily tool.\nDear Hiring Manager,',
  'I built one. I shipped two. I tested three. I wrote four.',
  'I use Python, Rust, and Go. I am writing to apply.', 'I built [Company Name].', 'Certainly! Here is your letter.'];
test('the Python and browser style checklists agree', () => {
  const result = execFileSync('python3', ['-c', `import sys,json;sys.path.insert(0,'server');from dashboard.humanize import report;print(json.dumps([report(t) for t in json.load(sys.stdin)]))`],
    {cwd: ROOT, input: JSON.stringify(samples), encoding:'utf8'});
  assert.deepEqual(samples.map(t => humanize.report(t)), JSON.parse(result));
});
test('generated style rules cannot silently drift', () => {
  execFileSync('python3', ['tools/build-humanizer.py', '--check'], {cwd:ROOT});
});
test('initial and revised drafts retain approval and carry style findings', async () => {
  for (const revision of [null, {previous:'I used Python.',instruction:'Improve wording'}]) {
    const [draft] = await lib('draft').draftAll({schema:schemaOf({label:'Why this role?',type:'textarea'}),
      profile:profile(), about:'I wrote tools.', complete:async()=>samples[2], revision});
    assert.equal(draft.needsApproval,true);
    assert.ok(draft.tells.some(t=>t.code==='§4'));
    assert.deepEqual(lib('draft').applyApproved([draft]).fills,{});
  }
});
test('voice samples and revisions redact contact identity without eating other names', () => {
  const p = profile();
  p.identity.middle_name='Elena';p.identity.preferred_name='Dani';p.identity.date_of_birth='1998-05-12';
  const original = `${p.identity.full_name} Elena Dani 1998-05-12 ${p.identity.email} ${p.links.github} (919) 555-0142. Built Danaher tools.`;
  const result = lib('draft').buildDraftMessages({label:'Why?',type:'textarea'}, {}, p, original, [{question:'Why?',answer:original}], {previous:original,instruction:'Keep the facts'});
  const sent = result.messages[1].content;
  assert.ok(!sent.includes(p.identity.full_name)); assert.ok(!sent.includes(p.identity.email));
  assert.ok(!sent.includes(p.links.github)); assert.ok(!sent.includes('(919) 555-0142'));
  assert.ok(sent.includes('Danaher'));
  for (const value of ['Elena','Dani','1998-05-12']) assert.ok(!sent.includes(value));
});
