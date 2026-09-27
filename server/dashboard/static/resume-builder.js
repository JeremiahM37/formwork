/* Editable document content; saving always creates a new immutable version. */
let resumeBuilderDraft = {name:"", headline:"", contact:"", template:"classic", paper:"letter", font_size:11, margin:0.7, sections:[]};
let resumeBuilderName = "Edited resume";

function openResumeBuilder(text) {
  resumeBuilderDraft = JSON.parse(text);
  renderResumeBuilder();
  document.querySelector('#resumeBuilder details').open = true;
  document.querySelector('#resumeBuilder').scrollIntoView({block:"start"});
}

function renderResumeBuilder() {
  const holder = document.querySelector('#resumeBuilder');
  if (!holder) return;
  const wasOpen = holder.querySelector('details')?.open || false;
  holder.replaceChildren();
  const body = el("div", {className:"card"});
  const preview = el("article", {className:"resume-paper", ariaLabel:"Resume layout preview"});
  function showPreview() {
    preview.className = `resume-paper ${resumeBuilderDraft.template}`;
    preview.style.fontSize = `${resumeBuilderDraft.font_size}pt`;
    preview.style.padding = `${resumeBuilderDraft.margin * 36}px`;
    preview.replaceChildren(el("header", {}, el("h2", {textContent:resumeBuilderDraft.name}),
      el("p", {textContent:resumeBuilderDraft.headline}), el("p", {textContent:resumeBuilderDraft.contact})));
    for (const section of resumeBuilderDraft.sections) {
      preview.append(el("h3", {textContent:section.heading}), el("p", {className:"preserve-lines", textContent:section.text}));
      for (const entry of section.entries) preview.append(el("div", {},
        el("strong", {textContent:entry.title}), el("span", {textContent:entry.dates ? ` | ${entry.dates}` : ""}),
        el("p", {textContent:[entry.subtitle,entry.location].filter(Boolean).join(" | ")}),
        el("ul", {}, ...entry.bullets.map(b=>el("li", {textContent:b})))));
    }
  }
  function field(label, value, setter, type="text") {
    const f = workspaceField(label,type,value);
    f.input.oninput = ()=>{setter(f.input.value);showPreview();};
    return f.node;
  }
  function select(label, values, selected, setter) {
    const input = el("select", {ariaLabel:label}, ...values.map(v=>el("option", {value:v, textContent:v, selected:String(v)===String(selected)})));
    input.onchange = ()=>{setter(input.value);showPreview();};
    return el("label", {className:"field"}, el("span", {textContent:label}), input);
  }
  function move(items,index,delta) {
    if (index+delta<0 || index+delta>=items.length) return;
    [items[index],items[index+delta]]=[items[index+delta],items[index]];
    renderResumeBuilder();
  }
  body.append(el("p", {className:"small muted", textContent:"Edit content and layout directly. Existing profile data and saved versions are unchanged until you explicitly save a new document version."}),
    workspaceButton("Start from saved profile", async()=>{
      body.replaceChildren(el("p", {textContent:"Loading saved profile…"}));
      try {resumeBuilderDraft=await api('/api/resume-builder/profile');}
      finally {renderResumeBuilder();}
    }),
    field("Builder version name",resumeBuilderName,v=>resumeBuilderName=v),
    field("Resume display name",resumeBuilderDraft.name,v=>resumeBuilderDraft.name=v),
    field("Resume headline",resumeBuilderDraft.headline,v=>resumeBuilderDraft.headline=v),
    field("Resume contact line",resumeBuilderDraft.contact,v=>resumeBuilderDraft.contact=v),
    el("div", {className:"pipeline-filters"},
      select("Resume template",["classic","compact","modern","executive","minimal","technical","editorial","traditional"],resumeBuilderDraft.template,v=>resumeBuilderDraft.template=v),
      select("Paper size",["letter","a4"],resumeBuilderDraft.paper,v=>resumeBuilderDraft.paper=v),
      select("Font size",[10,11,12],resumeBuilderDraft.font_size,v=>resumeBuilderDraft.font_size=Number(v)),
      select("Page margin (inches)",[0.5,0.6,0.7,0.8,0.9,1],resumeBuilderDraft.margin,v=>resumeBuilderDraft.margin=Number(v))));
  resumeBuilderDraft.sections.forEach((section,index)=>{
    const card = el("div", {className:"card builder-section"},
      field(`Section ${index+1} heading`,section.heading,v=>section.heading=v),
      field(`Section ${index+1} text`,section.text,v=>section.text=v,"textarea"),
      el("div", {className:"row wrap"},
        workspaceButton(`Move section ${index+1} up`,()=>move(resumeBuilderDraft.sections,index,-1)),
        workspaceButton(`Move section ${index+1} down`,()=>move(resumeBuilderDraft.sections,index,1)),
        workspaceButton(`Remove section ${index+1}`,()=>{if(confirm(`Remove ${section.heading} from this draft?`)){resumeBuilderDraft.sections.splice(index,1);renderResumeBuilder();}})));
    section.entries.forEach((entry,j)=>{
      const prefix=`Section ${index+1} entry ${j+1}`;
      card.append(el("details", {}, el("summary", {textContent:entry.title || `Entry ${j+1}`}),
        ...["title","subtitle","dates","location"].map(key=>field(`${prefix} ${key}`,entry[key],v=>entry[key]=v)),
        field(`${prefix} bullets (one per line)`,entry.bullets.join('\n'),v=>entry.bullets=v.split('\n').filter(v=>v.trim()),"textarea"),
        el("div", {className:"row wrap"},
          workspaceButton(`Move entry ${j+1} up`,()=>move(section.entries,j,-1)),
          workspaceButton(`Move entry ${j+1} down`,()=>move(section.entries,j,1)),
          workspaceButton(`Remove entry ${j+1}`,()=>{if(confirm('Remove this entry from the draft?')){section.entries.splice(j,1);renderResumeBuilder();}}))));
    });
    card.append(workspaceButton(`Add entry to section ${index+1}`,()=>{
      section.entries.push({title:"",subtitle:"",dates:"",location:"",bullets:[]});renderResumeBuilder();
    }));
    body.append(card);
  });
  body.append(workspaceButton("Add resume section",()=>{resumeBuilderDraft.sections.push({heading:"New section",text:"",entries:[]});renderResumeBuilder();}),
    el("h3", {textContent:"Layout preview"}),
    el("p", {className:"small muted", textContent:"Use the exported PDF to check exact spacing and page breaks. PDF and Word use the same content and section order; typography can differ."}),preview,
    workspaceButton("Save builder as new version",async()=>{
      const saved=await api('/api/resumes',{method:'POST',body:{name:resumeBuilderName,format:'structured',text:JSON.stringify(resumeBuilderDraft)}});
      await renderResumeStudio();
      const links=el('div',{className:'row wrap card'},el('span',{textContent:'Version saved.'}),
        el('a',{href:`/api/resumes/${saved.id}/export.pdf?inline=1`,target:'_blank',rel:'noreferrer',textContent:'Preview saved PDF'}),
        el('a',{href:`/api/resumes/${saved.id}/export.docx`,textContent:'Download saved Word document'}));
      document.querySelector('#resumeStudio').prepend(links);
      toast('New version saved. Select it from the application details before preparing.');
    }));
  holder.append(el("details", {open:wasOpen}, el("summary", {textContent:"Build and arrange a resume"}),body));
  showPreview();
}
