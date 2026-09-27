/* Ordinary forms over the existing profile schema; unknown fields survive edits. */
"use strict";

function profileControl(key, label, kind, value) {
  if (kind === "proficiency") {
    const choices = [["", "Not answered"], ["native", "Native"], ["near-native", "Near-native"],
      ...["C2","C1","B2","B1","A2","A1"].map(v=>[v,v])];
    if (value != null && !choices.some(([v])=>v === value)) choices.push([String(value), `Saved response: ${value}`]);
    const input = el("select", {ariaLabel:label}, ...choices.map(([v,text])=>el("option", {value:v,textContent:text,selected:v===String(value??"")})));
    const initial = input.value;
    return {key,input,node:el("label",{className:"field"},el("span",{textContent:label}),input),
      read:()=>input.value===initial?value:input.value||undefined};
  }
  if (kind === "boolean") {
    const legacy = value != null && typeof value !== "boolean";
    const choices = [["", "Not answered"], ["true", "Yes"], ["false", "No"]];
    if (legacy) choices.push(["existing", `Saved response: ${value}`]);
    const input = el("select", {ariaLabel:label},
      ...choices.map(([v, text]) =>
        el("option", {value:v, textContent:text, selected:(legacy ? "existing" : String(value ?? "")) === v})));
    const initial = input.value;
    return {key, input, node:el("label", {className:"field"}, el("span", {textContent:label}), input),
      read:()=>input.value === initial ? value : input.value === "" ? undefined : input.value === "true"};
  }
  const lines = kind === "lines";
  const field = workspaceField(label, lines ? "textarea" : kind || "text", lines ? (value || []).join("\n") : value ?? "");
  if (key === "phone") {
    field.input.placeholder = "+1 555-555-0142";
    field.input.setAttribute("aria-label", label);
    field.input.setAttribute("aria-describedby", "profile-phone-format-help");
    field.node.append(el("span", {id:"profile-phone-format-help", className:"small muted",
      textContent:"Include the country calling code, starting with +. Use your phone’s country code even if you live elsewhere."}));
  }
  const initial = field.input.value;
  return {key, ...field, read:()=>field.input.value === initial ? value : lines ? field.input.value.split("\n").map(s=>s.trim()).filter(Boolean) : field.input.value.trim() || undefined};
}

function profileFields(schema, source) {
  return schema.map(([key,label,kind])=>profileControl(key,label,kind,source?.[key]));
}

function readProfileFields(original, fields) {
  const result = {...original};
  for (const field of fields) {
    const value = field.read();
    if (value === undefined) delete result[field.key]; else result[field.key] = value;
  }
  return result;
}

async function renderProfileEditor(holder, candidate) {
  const source = candidate.profile;
  const result = el("p", {className:"small muted", role:"status", id:"profileSaveStatus"});
  const save = async (path, original, replacement) => {
    const latest = (await api("/api/profile")).profile;
    const at = (object) => path.reduce((v,k)=>v?.[k],object);
    if (JSON.stringify(at(latest) ?? {}) !== JSON.stringify(original ?? {}))
      throw new Error("This section changed since you opened it. Reload Settings before saving.");
    let parent = latest;
    for (const part of path.slice(0,-1)) parent = parent[part] ||= {};
    parent[path.at(-1)] = replacement;
    const receipt = await api("/api/profile", {method:"POST",body:{text:JSON.stringify(latest)}});
    // Keep this editor's baseline current after a successful save.
    let local = source;
    for (const part of path.slice(0,-1)) local = local[part] ||= {};
    local[path.at(-1)] = replacement;
    result.textContent = receipt.synced ? "Profile saved and verified in the extension." : "Profile saved. Browser sync is pending; use Retry extension profile sync when connected.";
    toast(result.textContent, receipt.synced ? "" : "warn");
    await refreshState();
  };
  const section = (title,path,schema) => {
    const value = () => path.reduce((v,k)=>v?.[k],source);
    const fields = profileFields(schema,value());
    return el("details", {open:title === "Contact details" && !source.identity?.full_name}, el("summary", {textContent:title}),
      workspaceForm(title,fields,`Save ${title.toLowerCase()}`,()=>save(path,value(),readProfileFields(value(),fields))));
  };
  const records = (title,key,schema,help="Add or remove entries, then save this section. Dates may be month/year. One achievement per line.") => {
    const root = el("details", {}, el("summary", {textContent:title}));
    const list = el("div");
    if (!Array.isArray(source[key] || [])) {
      root.append(el("p", {textContent:"This section uses a custom format. It is preserved; use the JSON editor to review it."}));
      return root;
    }
    const entries = structuredClone(source[key] || []).map(entry=>key === "languages" && typeof entry === "string" ? {name:entry} : entry);
    let controls = [];
    const capture = () => controls.forEach((fields,index)=>entries[index]=readProfileFields(entries[index],fields));
    const render = () => {
      controls = entries.map(item=>profileFields(schema,item));
      list.replaceChildren(...controls.map((fields,index)=>el("fieldset", {className:"card"},
        el("legend", {textContent:`${title} ${index+1}`}), ...fields.map(f=>f.node),
        workspaceButton(`Remove ${title.toLowerCase()} ${index+1}`,()=>{
          capture(); entries.splice(index,1); render();
        }))));
    };
    render();
    root.append(list, el("p", {className:"small muted",textContent:help}),
      workspaceButton(`Add ${title.toLowerCase()} entry`,()=>{capture();entries.push({});render();}),
      workspaceButton(`Save ${title.toLowerCase()}`,async()=>{capture();await save([key],source[key],structuredClone(entries));}));
    return root;
  };
  const skills = el("details", {}, el("summary",{textContent:"Skills"}));
  // Preserve existing category names and values; new profiles start with a general category.
  const flatSkills = Array.isArray(source.skills);
  const categories = flatSkills ? ["general"] : Object.keys(source.skills || {});
  if (!categories.length) categories.push("general");
  const skillFields = categories.filter(k=>Array.isArray(source.skills?.[k]) || k === "general").map(k=>
    profileControl(k,`Skills: ${k.replaceAll('_',' ')}`,"lines",flatSkills ? source.skills : source.skills?.[k]));
  skills.append(workspaceForm("Skills",skillFields,"Save skills",()=>save(["skills"],source.skills,
    flatSkills ? skillFields[0].read() : readProfileFields(source.skills,skillFields))));
  holder.append(el("h2",{textContent:"Set up your application profile"}),
    el("p",{textContent:"Start with your contact details, add career history or import a résumé, then review your application preferences. Blank answers stay unknown. Each section saves separately."}),
    el("a",{href:"#documents",textContent:"Import a résumé or open the résumé builder"}),result,
    section("Contact details",["identity"],[
      ["full_name","Full name"],["first_name","First name"],["last_name","Last name"],
      ["middle_name","Middle name (optional)"],["preferred_name","Preferred name (optional)"],
      ["preferred_first_name","Preferred first name (optional)"],["preferred_last_name","Preferred last name (optional)"],
      ["email","Email","email"],["phone","Phone","tel"],["phone_country","Phone country (for dialing-code selectors)"],["date_of_birth","Birth date (optional, YYYY-MM-DD)"],
      ["language","Preferred language"],["willing_to_relocate","Willing to relocate","boolean"]]),
    section("Address",["identity","location"],[
      ["street","Street address"],["street2","Address line 2"],["city","City"],["state","State or region"],
      ["postal_code","Postal code"],["country","Country"]]),
    section("Links",["links"],[["linkedin","LinkedIn URL","url"],["github","GitHub URL","url"],["website","Website URL","url"]]),
    records("Work history","experience",[["employer","Employer"],["title","Role title"],["location","Role location"],
      ["start","Role start date"],["end","Role end date"],["current","Current role","boolean"],["bullets","Achievements","lines"]]),
    records("Education","education",[["school","School"],["degree","Degree"],["field_of_study","Field of study"],
      ["location","School location"],["start","Education start date"],["end","Education end date"],
      ["current","Currently studying","boolean"],["gpa","GPA"],["honors","Honors","lines"],["coursework","Coursework","lines"]]),
    records("Projects","projects",[["name","Project name"],["tagline","Project summary"],["url","Project URL","url"],["bullets","Project achievements","lines"]]),
    skills,
    records("Languages","languages",[["name","Language"],["proficiency","Proficiency","proficiency"]],
      "Record each language and your proficiency. Leave unknown levels unanswered. This is separate from your preferred interface language."),
    section("Work authorization",["work_authorization"],[
      ["authorized_to_work_us","Authorized to work in the US","boolean"],
      ["requires_sponsorship_now","Requires sponsorship now","boolean"],
      ["requires_sponsorship_future","Requires sponsorship in the future","boolean"],["visa_status","Visa status (optional)"]]),
    section("Application preferences",["preferences"],[
      ["desired_salary","Desired salary (include currency and period)"],["earliest_start_date","Earliest start date"],
      ["remote_preference","Remote or onsite preference"],["work_locations","Preferred work locations (one per line)","lines"],["requires_relocation_assistance","Requires relocation assistance","boolean"],
      ["preferred_contact_method","Preferred contact method (optional)"],["how_did_you_hear","Default application source"]]),
    section("Voluntary demographics",["demographics"],[
      ["gender","Gender response"],["race_ethnicity","Race or ethnicity response"],["hispanic_latino","Hispanic or Latino response"],
      ["veteran_status","Veteran response"],["disability_status","Disability response"]]),
    section("Other application answers",["compliance"],[
      ["over_18","At least 18 years old","boolean"],["felony_conviction","Felony conviction response","boolean"],
      ["previously_employed_here","Previously employed response"],["non_compete","Non-compete response"]]));
}
