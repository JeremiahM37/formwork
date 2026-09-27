/**
 * Choosing between options that all contain what was typed.
 *
 * This is where the filler has gone wrong before, and always the same way:
 * something plausible near the top of the list gets taken while the right
 * answer is a scroll away. On a live Example ATS application "Exampleland State
 * University" became "Alabama State University"; on the fix for that it became
 * "Example Community College Example State University"; on the fix for *that* it
 * became "Example State University - East Campus". None of them error, and all of
 * them put a school on a form that the applicant did not attend.
 *
 * A real browser, because the search reads rendered text and scrolls a real
 * overflow box.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/load.mjs";

async function loadPlaywright() {
  for (const spec of [process.env.PW_MODULE, "playwright", "playwright-core"].filter(Boolean)) {
    try {
      return (await import(spec)).chromium;
    } catch {
      /* next */
    }
  }
  return null;
}
const chromium = await loadPlaywright();

const CAMPUSES = [
  "Example State University - East Campus",
  "Example State University - Exampletown",
  "Example State University - North Campus",
];

test('duplicate exact labels cannot select an arbitrary distinct option', async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<label for="school">School</label><select id="school"><option value="">Choose</option><option value="campus-a">Example University</option><option value="campus-b">Example University</option></select>
    <div role="listbox" id="list"><div role="option" data-value="a">Example University</div><div role="option" data-value="b">Example University</div></div>`);
  for(const file of ['scrape.js','fill.js'])await page.addScriptTag({path:join(ROOT,'extension/src/content',file)});
  const result=await page.evaluate(async()=>{
    const ns=window.__formwork,{schema,registry}=ns.scrape();
    const options=[...document.querySelectorAll('[role=option]')];
    const exact=ns.exactOption(options,'Example University');
    const found=await ns.findOption(document.getElementById('list'),'Example University');
    const report=await ns.fill({[schema.fields[0].id]:'Example University'},schema,registry);
    return {exact:!!exact,found:!!found,report,value:document.getElementById('school').value};
  });
  assert.equal(result.exact,false);assert.equal(result.found,false);
  assert.equal(result.report.filled.length,0);assert.equal(result.report.failed.length,1);
  assert.equal(result.value,'');
});

test('duplicate exact options arriving during a scroll search remain ambiguous', async t=>{
  const result=await withList(t,async()=>{
    const list=document.getElementById('list');
    list.innerHTML=Array.from({length:10},(_,i)=>`<div role="option">Other ${i}</div>`).join('');
    setTimeout(()=>{list.innerHTML='<div role="option" data-value="a">Example University</div><div role="option" data-value="b">Example University</div>';},25);
    return Boolean(await window.__formwork.findOption(list,'Example University'));
  });
  assert.equal(result,false);
});

async function withList(t, run) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    `<style>#box{height:80px;overflow:auto}#list div{height:20px}</style>
     <div id="box"><div id="list" role="listbox"></div></div>`
  );
  for (const file of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({
      content: readFileSync(join(ROOT, "extension", "src", "content", file), "utf8"),
    });
  }
  return page.evaluate(run);
}

test("picking one option out of several", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const seen = await withList(t, () => {
    const ns = window.__formwork;
    const list = document.getElementById("list");
    const render = (texts) => {
      list.innerHTML = "";
      return texts.map((text) => {
        const node = document.createElement("div");
        node.setAttribute("role", "option");
        node.textContent = text;
        list.append(node);
        return node;
      });
    };
    const pick = (options, value, hints) => {
      const got = ns.matchOption(render(options), value, hints || []);
      return got ? got.textContent : null;
    };
    const campuses = [
      "Example State University - East Campus",
      "Example State University - Exampletown",
      "Example State University - North Campus",
    ];
    return {
      exactBeatsLonger: pick(
        ["Example Community College Example State University", "Example State University"],
        "Example State University"
      ),
      onlyPrefix: pick(["Example State University - Exampletown"], "Example State University"),
      severalPrefixes: pick(campuses, "Example State University"),
      hintDecides: pick(campuses, "Example State University", ["Exampletown", "Exampleland"]),
      hintInsideValue: pick(campuses, "Example State University", ["Exampleland"]),
      hintStillAmbiguous: pick(
        ["Example State University - Exampletown East", "Example State University - Exampletown West"],
        "Example State University",
        ["Exampletown"]
      ),
      oneContains: pick(["Example Community College Example State University"], "Example State University"),
      twoContain: pick(
        ["Example Community College Example State University", "Exampletown Example State University Extension"],
        "Example State University"
      ),
      caseAndSpacing: pick(["  EXAMPLE STATE   university  "], "Example State University"),
      noMatch: pick(["Alabama State University"], "Example State University"),
      noOptions: pick([], "Example State University"),
      emptyValue: pick(["Anything at all"], ""),
    };
  });

  await t.test("an exact match beats a longer one that merely contains it", () => {
    assert.equal(seen.exactBeatsLonger, "Example State University");
  });

  await t.test("one option that starts with the value is the answer", () => {
    assert.equal(seen.onlyPrefix, "Example State University - Exampletown");
  });

  await t.test("several equally good options are a refusal, not a coin toss", () => {
    // Which campus is a question only the applicant can answer.
    assert.equal(seen.severalPrefixes, null);
    assert.equal(seen.twoContain, null);
  });

  await t.test("a hint from the profile settles it", () => {
    assert.equal(seen.hintDecides, "Example State University - Exampletown");
  });

  await t.test("a hint already inside the value cannot settle anything", () => {
    // Every campus carries "Exampleland"; only the town tells them apart.
    assert.equal(seen.hintInsideValue, null);
  });

  await t.test("a hint that still fits two options is a refusal", () => {
    assert.equal(seen.hintStillAmbiguous, null);
  });

  await t.test("one option that contains the value is taken", () => {
    assert.equal(seen.oneContains, "Example Community College Example State University");
  });

  await t.test("case and spacing are not differences", () => {
    assert.equal(seen.caseAndSpacing, "  EXAMPLE STATE   university  ");
  });

  await t.test("nothing plausible means nothing", () => {
    assert.equal(seen.noMatch, null);
    assert.equal(seen.noOptions, null);
  });

  await t.test("an empty value chooses nothing", () => {
    // Every string contains the empty string, so this used to take whichever
    // option came first — a cleared field answering itself.
    assert.equal(seen.emptyValue, null);
  });
});

test("searching a list too long to be rendered at once", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const seen = await withList(t, async () => {
    const ns = window.__formwork;
    const list = document.getElementById("list");
    const render = (texts) => {
      list.innerHTML = "";
      for (const text of texts) {
        const node = document.createElement("div");
        node.setAttribute("role", "option");
        node.textContent = text;
        list.append(node);
      }
    };
    const filler = Array.from({ length: 40 }, (_, i) => `Filler College ${i}`);
    const find = async (options, value, hints) => {
      render(options);
      const got = await ns.findOption(list, value, hints || []);
      return got ? got.textContent : null;
    };
    return {
      exactDeepDown: await find(
        ["Example Community College Example State University", ...filler, "Example State University"],
        "Example State University"
      ),
      hintedDeepDown: await find(
        [
          "Example Community College Example State University",
          ...filler,
          "Example State University - East Campus",
          "Example State University - Exampletown",
        ],
        "Example State University",
        ["Exampletown"]
      ),
      ambiguousDeepDown: await find(
        [
          "Example Community College Example State University",
          ...filler,
          "Example State University - East Campus",
          "Example State University - Exampletown",
        ],
        "Example State University"
      ),
      onlyContains: await find(
        ["Example Community College Example State University", ...filler],
        "Example State University"
      ),
      nothing: await find(["Alabama State University", ...filler], "Example State University"),
    };
  });

  await t.test("the whole list is searched before anything is chosen", () => {
    // Stopping at the first hit answered with the college at the top while the
    // university itself was forty rows below it.
    assert.equal(seen.exactDeepDown, "Example State University");
  });

  await t.test("a hinted match below the fold beats a near miss above it", () => {
    assert.equal(seen.hintedDeepDown, "Example State University - Exampletown");
  });

  await t.test("two equally good matches anywhere in it are a refusal", () => {
    assert.equal(seen.ambiguousDeepDown, null);
  });

  await t.test("a single containing match is settled for when there is nothing better", () => {
    assert.equal(seen.onlyContains, "Example Community College Example State University");
  });

  await t.test("a list with nothing in it returns nothing", () => {
    assert.equal(seen.nothing, null);
  });
});
