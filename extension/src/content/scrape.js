/**
 * formwork — DOM scraper.
 *
 * Turns an arbitrary application form into a compact, ATS-agnostic field schema
 * that a language model can reason about. Generic HTML semantics cover most
 * controls; narrowly identified history editors add record context.
 *
 * Selectors never leave the page. The model sees only opaque ids ("f3"), and
 * the registry translates them back to live elements at fill time.
 */
(function () {
  "use strict";

  const ns = (window.__formwork = window.__formwork || {});

  /** Inputs we never touch: hidden state, CSRF tokens, search boxes, buttons. */
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

  /**
   * Every fillable control, including the ones that are not form elements.
   *
   * Workday builds its dropdowns as `<button aria-haspopup="listbox">` — no
   * input, no select — so a query for form elements alone is blind to the
   * entire "My Information" page: phone device type, state, country, and every
   * application question. They answer to the same combobox handling that
   * react-select needs, once they are seen at all.
   */
  const CONTROLS =
    'input, select, textarea, button[aria-haspopup="listbox"], button[data-automation-id="selectInput"], [role="combobox"]:not(input)';

  /**
   * A listbox that shows what is already chosen, not what can be chosen.
   *
   * Multiselects mark their selected-pill area `role="listbox"` too — Workday
   * uses `data-automation-id="selectedItemList"`. Counting it as an options
   * menu is how "Country" and "State" came back offering two identical
   * entries: that was the phone widget's *selection*, read as a menu. It is
   * also what the filler kept committing against instead of the real list.
   */
  const SELECTION_LIST = '[data-automation-id*="selected" i], [class*="selectedItem"]';
  const isSelectionList = (list) => list.matches(SELECTION_LIST) || Boolean(list.closest(SELECTION_LIST));

  /** Menus currently offering options — selection displays excluded. */
  function openMenus(doc) {
    return Array.from(doc.querySelectorAll('[role="listbox"]:not([hidden]), .react-select__menu:not([hidden]), .pcty-input-select__menu-list')).filter(
      (list) => !isSelectionList(list) && list.querySelector('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]')
    );
  }

  /** A dropdown rendered as a button rather than a form control. */
  const isPopupButton = (el) =>
    el.tagName === "BUTTON" || (el.getAttribute("role") === "combobox" && el.tagName !== "INPUT");

  /**
   * Sub-controls of composite widgets that are not questions in their own right
   * — e.g. intl-tel-input renders a country search box next to the phone field.
   */
  /**
   * The parts of a phone widget that belong to its country picker rather than
   * to the question: the flag button, its search box, its clear button.
   *
   * Named one by one, not by their shared container. intl-tel-input wraps the
   * *number itself* in `.iti` alongside them, so skipping the container
   * skipped the phone number — a required field on most applications, and one
   * the panel then reported as simply absent from the form.
   */
  const SUBWIDGET =
    '.iti__selected-country, .iti__search-input, .iti__search-clear, [class*="country-select"]';

  /** Beyond this, option lists cost more tokens than they inform. */
  const MAX_INLINE_OPTIONS = 25;

  /**
   * Transient or decorative UI that sits inside a field's container but is not
   * part of its question: autocomplete menus, live-region status, validation
   * messages, loading spinners.
   */
  const NOISE =
    '[aria-live], [role="status"], [role="alert"], [role="listbox"], [role="menu"], ' +
    '[class*="dropdown"]:not([class*="label"]), [class*="menu"], [class*="suggest"], [class*="error"], ' +
    '[class*="hint"], [class*="loading"], [class*="spinner"]';

  /**
   * Remove a widget's own furniture from a candidate label: the placeholder it
   * shows when unanswered, and the marker saying an answer is needed. Both sit
   * inside the field's container and neither is part of the question.
   */
  function stripChrome(text) {
    return text
      .replace(/^\s*(select one|select\.{0,3}|choose\.{0,3}|please select)\b/i, "")
      // Marker first, then the placeholder it sits after — otherwise the
      // placeholder is no longer at the end by the time it is looked for.
      .replace(/\s*\b(required|optional)\s*$/i, "")
      .replace(/\s*\b(select one|please select)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Accessible names that describe the widget, not the question it asks. */
  const GENERIC_NAME =
    /^(year|month|day|hour|minute|second|select one|select\.{0,3}|choose\.{0,3}|please select|--)$/i;

  /** Transient status wording, whether or not the markup announces it. */
  const NOISE_TEXT =
    /\bno (results?|options?|matches?|locations?|cities)\b.*\bfound\b|try (entering|again|another)|^\s*loading\b|please wait/i;

  /** File-input labels that name the button rather than the question. */
  const GENERIC_FILE_LABEL = /^(attach|upload|choose|browse|select)\b|^add file/i;

  /**
   * Bot traps.
   *
   * Applicant tracking systems plant a field that a person cannot see but a
   * naive autofiller will happily complete, and treat anything typed into it as
   * proof of a robot. Workday's is `data-automation-id="beecatcher"`, named
   * "website", labelled "This input is for robots only" — and rendered 1px by
   * 0.01px with a zero clip-path, so `display` and `visibility` both say it is
   * perfectly visible.
   *
   * Filling one risks the user's account on a site they need. A field left
   * empty costs nothing by comparison, so these checks are deliberately
   * eager: any one of wording, naming or impossible geometry is enough.
   */
  const HONEYPOT_TEXT =
    /robots?\s+only|do not (fill|enter|complete|use)|leave (this|it)\b.*\b(blank|empty)|if you'?re\s+(a\s+)?human|human.{0,12}(leave|skip)|honey\s?pot/i;
  const HONEYPOT_NAME = /(^|[\s\-_])(beecatcher|honey\s?pot|bot[-_]?trap|nobots?)([\s\-_]|$)/i;

  const isHoneypot = (el) => {
    const named = `${el.getAttribute("data-automation-id") || ""} ${el.name || ""} ${el.id || ""}`;
    if (HONEYPOT_NAME.test(named)) return true;
    if (HONEYPOT_TEXT.test(labelFor(el) || "")) return true;
    if (HONEYPOT_TEXT.test(el.getAttribute("placeholder") || "")) return true;

    // Radios and checkboxes are routinely shrunk to nothing and replaced by a
    // styled stand-in — Workday's are `radioBtn` inputs a pixel across. They
    // are real questions, so geometry cannot condemn them; wording and naming
    // still can.
    // Controls driven through a visible stand-in are measured by that
    // stand-in, not by themselves: a date segment and a styled radio are both
    // zero-size on purpose.
    // A file input is hidden by design on every modern form — the visible
    // control is a styled label or button beside it — so a 1px "visually
    // hidden" file input is the normal case, not a trap. Greenhouse's résumé
    // and cover-letter slots are exactly that, and geometry alone was
    // dropping both: the application was filled and the résumé never attached.
    const styled =
      el.type === "radio" || el.type === "checkbox" || el.type === "file" || isProxied(el);

    // No real text control is a couple of pixels tall, or parked off the canvas.
    const rect = el.getBoundingClientRect();
    if (!styled && (rect.width < 4 || rect.height < 4)) return true;
    // "Off the canvas" means off the *document*, not off the screen.
    // getBoundingClientRect is viewport-relative, so a field scrolled above the
    // fold reports a negative bottom — and reading that as a trap condemned
    // every question above the current scroll position. On a form filled once
    // and filled again without scrolling back up, that was the applicant's
    // name, email and phone number: five fields silently dropped, on a page
    // where they were plainly visible a moment earlier. The scroll offsets put
    // the test back in document coordinates, where `left: -9999px` still fails
    // it and an ordinary field never does.
    const offCanvas = rect.right + window.scrollX < 0 || rect.bottom + window.scrollY < 0;
    if (!styled && offCanvas) return true;
    if (styled) return false;

    // Clipped to nothing while still reporting itself as displayed.
    const style = getComputedStyle(el);
    if (/polygon\(([^)]*?\b0(px)?\s+0(px)?\b[,\s]*){3}/.test(style.clipPath)) return true;
    if (/^rect\(\s*1px,\s*1px,\s*1px,\s*1px\s*\)$/.test(style.clip)) return true;
    return false;
  };

  /**
   * A control the user drives through something else.
   *
   * Workday's date fields are a `role="group"` wrapper holding a zero-size
   * `role="spinbutton"` input per segment, with a visible `aria-hidden` span
   * drawn in its place. The input is the real control — it is simply not the
   * thing on screen — so measuring it says nothing about whether the question
   * is being asked. This left "From" and "To" invisible to the scraper, and
   * they are the two fields Workday refuses to turn the page without.
   */
  const PROXIED_ROLE = /^(spinbutton|textbox|combobox|searchbox)$/i;
  const isProxied = (el) => {
    if (!PROXIED_ROLE.test(el.getAttribute("role") || "")) return false;
    // From the parent up: `closest` would match the input itself, which is the
    // very element whose size we have already decided says nothing.
    const shell =
      el.parentElement?.closest('[role="group"], [data-automation-id]') || comboShell(el);
    if (!shell) return false;
    const rect = shell.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /**
   * The widget an ARIA combobox is actually driven through.
   *
   * A combobox library sizes its `<input>` to the text being typed, not to the
   * question: Greenhouse's (react-select) is 3.9px wide, with the label, the
   * chosen value and the arrow all drawn by ancestors. Nothing marks that shell
   * — no `role="group"`, no `data-automation-id` — so the geometry rule below
   * was reading a perfectly ordinary dropdown as a bot trap and dropping it.
   * On one Example ATS posting that was 14 of 21 questions, work authorisation and
   * citizenship among them.
   *
   * Only the ARIA combobox pattern is exempted, and only by borrowing a real
   * ancestor's size; the wording and naming rules still apply, so a trap that
   * dresses itself as a combobox is still caught by what it says and is named.
   */
  const comboShell = (el) => {
    let node = el.parentElement;
    for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      // Wide enough to be a control a person could click, rather than another
      // wrapper drawn around the same few pixels.
      if (rect.width >= 40 && rect.height >= 12) return node;
    }
    return null;
  };

  const VISIBLE = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return isProxied(el);
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  function choiceProxy(el) {
    if (!["checkbox", "radio"].includes(el.type)) return null;
    const proxy = el.parentElement?.closest(`[role="${el.type}"]`);
    if (!proxy || proxy.closest('[aria-hidden="true"]') || !VISIBLE(proxy)) return null;
    if (proxy.getAttribute("aria-disabled") === "true") return null;
    if (proxy.querySelectorAll(`input[type="${el.type}"]`).length !== 1) return null;
    return proxy;
  }

  const clean = (s) =>
    (s || "")
      .replace(/[\s ]+/g, " ")
      .replace(/\*$/, "")
      .trim();

  /**
   * Best-effort human label for a control, in descending order of reliability.
   * The label is the model's primary signal, so it is worth trying hard here.
   */
  // Rippling custom questions put their prompt beside the field rather than
  // wiring it with aria-labelledby. Only borrow from a single-field wrapper.
  function adjacentFieldPrompt(el) {
    const field = el.closest('[data-testid="field"]'), wrapper = field?.parentElement;
    if (!wrapper || wrapper.querySelectorAll('[data-testid="field"]').length !== 1) return "";
    const before = [];
    for (const sibling of wrapper.children) {
      if (sibling === field) break;
      if (sibling.querySelector('input, textarea, select, button, [role="combobox"]')) return "";
      const caption = clean(visibleText(sibling));
      if (caption) before.push(caption);
    }
    return before.length === 1 ? before[0] : "";
  }

  // Unwired labels in a single-field group still name that field. Read only
  // its direct caption so help text cannot turn a mobile number into a country
  // code question. Never borrow a label from a sibling field.
  function ownGroupLabel(el) {
    const group = el.closest('.form-group');
    if (!group || group.querySelectorAll('input:not([type="hidden"]),select,textarea').length !== 1) return null;
    const labels = [...group.querySelectorAll(':scope > label')]
      .filter(label => !label.htmlFor && VISIBLE(label));
    return labels.length === 1 ? labels[0] : null;
  }

  function labelFor(el) {
    const doc = el.ownerDocument;
    if(el.matches('.gnewtonQuestionWrapper .gnewtonYes, .gnewtonQuestionWrapper .gnewtonNo'))return clean(el.textContent);
    const pcty = el.closest('.pcty-input-select-full-container');
    if (pcty) {
      const label = pcty.closest('label');
      if (label) {const copy=label.cloneNode(true);copy.querySelectorAll('.pcty-input-select-full-container, .pcty-input-select__menu-list').forEach(n=>n.remove());const caption=clean(copy.textContent);if(caption)return caption;}
    }
    const proxy = choiceProxy(el);
    if (proxy) {
      // A choice proxy contains only its own visible caption. Walking upward
      // can collect every sibling answer (Rippling: both options became Yes No).
      const caption = clean(visibleText(proxy));
      if (caption) return caption;
      return labelFor(proxy);
    }
    if (el.id) {
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      // An upload can have both an icon-only label and an accessible caption.
      // SVG fallback descriptions are not the question (observed on Workable).
      const text = lbl && clean(visibleText(lbl));
      if (text) return text;
    }

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent)
        .join(" ");
      if (clean(text)) return clean(text);
    }

    // Rippling labels the dialing-country selector's editable input "Search".
    // Its explicit phone-code wrapper identifies the question; neither the
    // selected dial code nor a nearby residence field is a reliable label.
    if (el.matches('input[role="combobox"]') &&
        el.closest('[data-testid="phone_number-code"]') &&
        /^(search)?$/i.test(clean(el.getAttribute('aria-label')))) {
      return "Phone country code";
    }

    // "Year" names a segment of a date widget, not the question it belongs to
    // — and both ends of a range would answer to it. Keep walking for the
    // label that distinguishes "From" from "To".
    // Some accessible names describe the control rather than the question: a
    // date segment is "Year", and an unselected dropdown announces itself as
    // "Select One". Both would label every such field identically, so keep
    // looking for the text that distinguishes them.
    // A dropdown built as a button announces its *selection* as its accessible
    // name: "Select One" before it is answered, "Yes" afterwards. Taking that
    // as the label makes the question change once it has been answered — the
    // work-authorisation question came back labelled "Yes" on a second visit,
    // and nothing could match it. When the name is just the button's own text,
    // it is a value, not a question.
    // Stripped, because an accessible name is often the placeholder plus the
    // required marker — "Select One Required" — which differs from the
    // button's own text and so slips past the check below while saying
    // nothing at all.
    const aria = stripChrome(clean(el.getAttribute("aria-label")));
    const ownText = isPopupButton(el) ? stripChrome(clean(el.textContent)) : "";
    if (aria && !GENERIC_NAME.test(aria) && aria !== ownText) return aria;
    const ownCaption = ownGroupLabel(el);
    if (ownCaption) return clean(visibleText(ownCaption));
    const adjacent = adjacentFieldPrompt(el);
    if (adjacent) return adjacent;

    // A segment of a composite widget is labelled through its group.
    const group = el.parentElement?.closest('[role="group"]');
    if (group) {
      const by = group.getAttribute("aria-labelledby");
      const text = by
        ? by
            .split(/\s+/)
            .map((id) => doc.getElementById(id)?.textContent || "")
            .join(" ")
        : group.getAttribute("aria-label") || "";
      if (clean(text)) return clean(text);
    }

    const wrapping = el.closest("label");
    if (wrapping) {
      // Same rule as the container walk: read what is on screen. A wrapping
      // label can contain the field's live status too, and cloning it whole
      // produced "Current location ✱No location found. Try entering a
      // different locationLoading" as the question.
      const text = stripChrome(clean(visibleText(wrapping)));
      if (text && /[a-z0-9]/i.test(text)) return text;
    }

    // Walk up looking for a container that holds exactly one control plus text.
    //
    // A composite widget's segments count as one control, not three: a date
    // field wraps month, day and year inputs, so counting them naively makes
    // the very first container look shared and stops the walk before it
    // reaches the caption. That left "From" and "To" with no label at all,
    // and an unlabelled field is dropped from the schema entirely.
    // Only a genuine segment of a composite widget: a control that merely sits
    // inside some group is not one, and starting the walk above that group
    // skips the container holding its question. That is what reduced the
    // application questions to the heading "Application Questions".
    const segments = isProxied(el) ? el.parentElement?.closest('[role="group"]') : null;
    // Only controls a person can see. A field container commonly holds one
    // visible widget plus a hidden input holding its value — counting that
    // second one makes every such container look shared, so the walk stops
    // before the question and the field ends up labelled by its internal id.
    const controlCount = (n) =>
      Array.from(n.querySelectorAll(CONTROLS)).filter(
        (c) => (!segments || !segments.contains(c)) && VISIBLE(c)
      ).length;

    let node = segments ? segments.parentElement : el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (controlCount(node) > 1) break;
      const text = stripChrome(clean(visibleText(node)));
      // Chrome is not a caption. A container may hold only the widget's own
      // placeholder and a required marker — "Select One Required" — which
      // reads as a label while saying nothing. Keep climbing for text that
      // actually asks something.
      if (text && text.length < 300 && /[a-z0-9]/i.test(text)) return text;
    }

    // Last resort before giving up: the field's own container. Markup nests to
    // different depths, and a fixed climb that suits one form runs out before
    // the caption on another — which is how two questions came back labelled
    // "Select One Required" and unanswerable.
    const container = el.closest('[data-automation-id^="formField"], [class*="form-field"], [class*="formField"]');
    if (container) {
      const text = stripChrome(clean(visibleText(container)));
      if (text && text.length < 300 && /[a-z0-9]/i.test(text)) return text;
    }

    const fallback = clean(el.placeholder) || clean(el.name) || "";
    return GENERIC_NAME.test(fallback) ? "" : fallback;
  }

  /**
   * The text of a container as a person reads it.
   *
   * Cloning and stripping by selector cannot tell a caption from a caption's
   * screen-reader twin, so a date field came back labelled "use right and left
   * arrows to navigate spin buttons" and another "YYYY" — instructions and a
   * placeholder, neither of which is the question. Walking the live tree gives
   * access to layout, and anything not actually on screen can be left out.
   */
  function visibleText(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.textContent;
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.matches("input, select, textarea, button")) continue;
      if (child.matches(NOISE)) continue;
      // Some status text carries no marking at all — Lever's location field
      // renders "No location found. Try entering a different location" as a
      // plain div, which then reads as part of the question and rides into
      // every prompt. Judge it by what it says.
      if (NOISE_TEXT.test(child.textContent || "")) continue;
      if (child.getAttribute("aria-hidden") === "true") continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = child.getBoundingClientRect();
      // Screen-reader-only text is clipped to a pixel; it duplicates or
      // explains the visible caption rather than being it.
      if (rect.width <= 1 || rect.height <= 1) continue;
      out += ` ${visibleText(child)}`;
    }
    return out;
  }

  /**
   * The section a field sits in, taken from the nearest heading above it.
   *
   * "From" and "To" mean different things under "Education" than under "Work
   * Experience", and the label alone cannot tell them apart — so a rule that
   * answers one would confidently answer the other with the wrong dates. The
   * heading is the same cue a person uses.
   */
  function sectionLabel(el) {
    let best = "";
    for (const heading of el.ownerDocument.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      // Keep the last heading that appears before this control.
      if (heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const text = clean(heading.textContent);
        if (text) best = text;
      }
    }
    return best.slice(0, 60);
  }

  /** Explicit inline history editors, rather than the page's nearest heading.
   * Scope narrowly: an entire application form can contain both history kinds.
   * List position covers multiple rows; existing identity is reconciled with
   * the profile by the validator before any values are transcribed.
   */
  function historyContext(el) {
    const specs=[
      {kind:'experience',identity:'company',second:'jobTitle',keys:{company:'employer',jobTitle:'title',roleDescription:'summary',description:'summary',currentlyWorkHere:'current',location:'location',startDate:'start',endDate:'end'}},
      {kind:'education',identity:'school',second:'degree',keys:{school:'school',degree:'degree',fieldOfStudy:'field_of_study',gpa:'gpa',firstYearAttended:'start',lastYearAttended:'end'}},
      {kind:'languages',identity:'language',keys:{language:'language',nativeLanguage:'native',reading:'reading',speaking:'speaking',writing:'writing',comprehension:'comprehension'}}
    ];
    for(const spec of specs){
      const selector=`[data-automation-id="${spec.identity}"]`;
      for(let row=el.parentElement;row && !/^(FORM|MAIN|BODY|HTML)$/.test(row.tagName);row=row.parentElement){
        const identities=[...row.querySelectorAll(selector)].filter(n=>n.matches('input,button,select,[role="combobox"]'));
        if(identities.length!==1 || spec.second && !row.querySelector(`[data-automation-id="${spec.second}"]`))continue;
        const automation=el.getAttribute('data-automation-id') || el.closest('[data-automation-id^="formField-"]')?.getAttribute('data-automation-id')?.replace('formField-','');
        const label=labelFor(el).toLowerCase().replace(/[*:]/g,'').trim();
        const aliases=spec.kind==='experience'?{'role description':'summary','job title':'title','company':'employer'}:
          spec.kind==='education'?{'school or university':'school','school/university':'school','degree':'degree','field of study':'field_of_study','overall result (gpa)':'gpa'}:
          {'language':'language','reading':'reading','speaking':'speaking','writing':'writing','comprehension':'comprehension'};
        const key=spec.keys[automation] || aliases[label];
        if(!key)continue;
        const identity=identities[0], other=spec.second && row.querySelector(`[data-automation-id="${spec.second}"]`);
        const value=n=>n?.tagName==='INPUT'?n.value:'';
        const index=[...el.ownerDocument.querySelectorAll(selector)].filter(n=>n.matches('input,button,select,[role="combobox"]')).indexOf(identity);
        return {kind:spec.kind,index,key,existing:{[spec.keys[spec.identity]]:value(identity),...(other?{[spec.keys[spec.second]]:value(other)}:{})}};
      }
    }
    const editor = el.closest('[data-ui="editor"]');
    if (!editor) return null;
    const input = name => editor.querySelector(`[name="${name}"]`);
    const kind = input('school') && !input('company') ? 'education' :
      input('company') && input('title') && !input('school') ? 'experience' : null;
    if (!kind) return null;
    const name=el.getAttribute('name') || '';
    const key=({company:'employer',start_date:'start',end_date:'end'})[name] || name;
    const row=editor.closest('li');
    if (!row || !row.parentElement.matches('ul,ol')) return null;
    const index=Array.from(row.parentElement.children).filter(n=>n.tagName==='LI').indexOf(row);
    const existing=kind==='education'?{school:input('school')?.value,degree:input('degree')?.value}:
      {employer:input('company')?.value,title:input('title')?.value};
    return {kind,index,key,existing};
  }

  /**
   * The question a set of choices belongs to, or null for a standalone control.
   *
   * Radios share a `name`; checkboxes usually do too. Workday's disability
   * question uses neither — three mutually exclusive checkboxes with no name
   * at all — so each option arrived as its own field, labelled with its own
   * text and impossible to answer. Choices that share a field container are
   * one question whatever the markup calls them.
   */
  function choiceGroupKey(el, controls) {
    if (el.type === "radio") return `radio:${el.name || groupLabel(el) || labelFor(el)}`;
    if (el.type !== "checkbox") return null;
    if (el.name && controls.filter((c) => c.name === el.name).length > 1) return `checkbox:${el.name}`;

    // JazzHR gives each checkbox a distinct name and stores the question's
    // answer in one hidden field. Group only this explicit questionnaire shape.
    if (el.matches(".resumator-questionnaire-checkbox")) {
      const container = el.closest(".form-group");
      const answers = container?.querySelectorAll("input.resumator-questionnaire-checkbox-answer") || [];
      if (answers.length === 1 && answers[0].id &&
          controls.filter(c => c.type === "checkbox" && container.contains(c)).length > 1)
        return `checkbox:${answers[0].id}`;
    }
    const box = el.closest('fieldset, [role="group"], [role="radiogroup"], [data-automation-id^="formField"]');
    if (!box) return null;
    const siblings = controls.filter((c) => c.type === "checkbox" && box.contains(c));
    // One checkbox in a container is a single yes/no — an agreement, an
    // opt-in — and must stay its own field.
    if (siblings.length < 2) return null;
    return `checkbox:${box.getAttribute("data-automation-id") || box.id || groupLabel(el)}`;
  }

  /**
   * Question text shared by a radio/checkbox group — usually a legend.
   *
   * `members` is the rest of the group, when the caller knows it. Without it
   * the search up the tree finds the nearest label, and for a radio the
   * nearest label is its own option: Ashby marks the EEO questions up as a
   * fieldset with no legend, holding a `<label>Gender</label>` and one
   * `<label>` per choice, so the gender question came back called "Male" and
   * the veteran question came back called "I identify as one or more of the
   * classifications of protected veteran listed above". The answers were still
   * right — they are matched against the option list, not the label — but a
   * reviewer reading "Male" as a question on their own application has every
   * reason to think something has gone badly wrong.
   */
  function linkedInCaption(el) {
    if (!/(^|\.)linkedin\.com$/.test(location.hostname)) return null;
    const box = el.closest('[componentkey^="easyApplyFieldFocus_"]');
    const captions = box ? [...box.querySelectorAll(':scope > p')].filter(VISIBLE) : [];
    return captions.length === 1 ? captions[0] : null;
  }

  function groupLabel(el, members = []) {
    const linkedIn = linkedInCaption(el);
    if (linkedIn) return clean(linkedIn.textContent);
    // A label belonging to one of the choices is a choice, not the question —
    // but only where the choices carry their own labels. A group whose options
    // are drawn some other way (a styled span, the input's value) often has a
    // single `label[for]` pointing at its first radio, and that label *is* the
    // question. So the test is whether this group labels its options
    // individually, not whether this label happens to name a member.
    const owned = new Set(members.map((m) => m.id).filter(Boolean));
    const doc = el.ownerDocument;
    const labelledOptions = members.filter(
      (m) => m.id && doc.querySelector(`label[for="${CSS.escape(m.id)}"]`)
    ).length;
    const perOption = labelledOptions > 1;
    const isChoice = (node) =>
      node.contains(el) ||
      members.some((m) => node.contains(m)) ||
      (perOption && owned.has(node.getAttribute("for") || ""));

    const fs = el.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector("legend");
      if (legend && clean(legend.textContent)) return clean(legend.textContent);
    }
    const grouped = el.closest('[role="group"], [role="radiogroup"]');
    if (grouped) {
      // Some forms label the radiogroup itself rather than its native inputs.
      const ids = (grouped.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      const linked = clean(ids.map(id => doc.getElementById(id)?.textContent || "").join(" "));
      if (linked) return linked;
      const label = grouped.id && doc.querySelector(`label[for="${CSS.escape(grouped.id)}"]`);
      if (label && !isChoice(label) && clean(label.textContent)) return clean(label.textContent);
      const aria = clean(grouped.getAttribute("aria-label"));
      if (aria) return aria;
    }
    const ownCaption = ownGroupLabel(el);
    if (ownCaption) return clean(visibleText(ownCaption));
    const adjacent = adjacentFieldPrompt(el);
    if (adjacent) return adjacent;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      for (const heading of node.querySelectorAll("legend, h2, h3, h4, label")) {
        if (isChoice(heading)) continue;
        const text = clean(heading.textContent);
        if (text) return text;
      }
    }
    return "";
  }

  /**
   * The label exactly as authored, before the readable version is tidied.
   *
   * `clean()` strips the trailing asterisk that marks a required field — which
   * is right for a label shown to a model, and wrong for deciding whether the
   * field is required. Workday marks "Phone Device Type*" this way and sets no
   * `required` or `aria-required`, so reading the tidied label meant every such
   * field was reported as optional and its absence never raised.
   */
  function rawLabelText(el) {
    const doc = el.ownerDocument;
    if (el.id) {
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent || "";
    }
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent || "")
        .join(" ");
    }
    return el.getAttribute("aria-label") || el.closest("label")?.textContent || ownGroupLabel(el)?.textContent || "";
  }

  function isRequired(el) {
    if (/\*\s*$/.test(linkedInCaption(el)?.textContent || '')) return true;
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    // Indeed labels its telephone widget rather than its inner input. Keep the
    // search bounded and require exactly one phone control in that group.
    if (/(^|\.)indeed\.com$/.test(location.hostname) && el.type === 'tel') {
      let group = el.parentElement;
      for (let depth=0; group && depth<3; depth++, group=group.parentElement) {
        if (group.querySelectorAll('input[type="tel"]').length !== 1) break;
        const labels=[...group.querySelectorAll('label,legend')].filter(VISIBLE);
        if (labels.some(label=>/^phone(?: number)?\s*\*\s*$/i.test(label.textContent.trim()))) return true;
      }
    }
    if (/(^|\.)applicantpro\.com$/.test(location.hostname) && el.closest("form#apply") && el.classList.contains("required")) return true;
    if (el.closest('[data-question-mandatory="true"]')) return true;
    if (el.type === 'file') {
      const fieldset = el.closest('fieldset');
      const marker = fieldset?.querySelector(':scope > legend abbr[title="required" i]');
      if (fieldset?.querySelectorAll('input[type="file"]').length === 1 && marker && VISIBLE(marker)) return true;
    }
    return /\*\s*(?:Required)?\s*$|\(required\)/i.test(rawLabelText(el).replace(/[\s ]+/g, " ").trim());
  }

  /**
   * Combobox-style widgets (Workday, Ashby, Greenhouse's newer selects) render as
   * a text input plus a listbox rather than a <select>. Detect so the filler
   * knows to click rather than assign.
   */
  /**
   * The chrome of a select widget that carries no ARIA of its own: a selection
   * rendered as a pill, and a button that opens the list.
   *
   * Workday's "Country Phone Code" is a bare <input type="text"> — the search
   * box inside a multiselect that already holds a value. Read as a plain text
   * field it is filled by assignment, its `.value` stays empty because the
   * selection lives in a sibling, and verification reports a failure on a field
   * that is in fact answered correctly.
   */
  const WIDGET_CHROME =
    '[class*="value-container"], [class*="multi-value"], [class*="single-value"], ' +
    '[class*="selectedItem"], [aria-haspopup="listbox"], [role="listbox"]';

  /** A generic placeholder betrays a search box rather than a question. */
  const WIDGET_PLACEHOLDER = /^(search|select|choose)\b\.{0,3}$/i;

  /**
   * Widget naming, across the several conventions in use. Workday writes
   * `data-automation-id="monikerSearchBox"` and
   * `data-uxi-element-id="selectinput-…"`; others use classes or their own
   * data attributes. None of it is per-employer, and none of it is a question.
   */
  const WIDGET_NAME = /(^|[-_ ])(select|combobox|typeahead|autocomplete)|search ?box/i;

  const looksLikeWidgetChrome = (el) => {
    const attrs = [
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-uxi-widget-type"),
      el.getAttribute("data-uxi-element-id"),
      el.className,
    ];
    return attrs.some((a) => a && WIDGET_NAME.test(String(a)));
  };

  function isCombobox(el) {
    // Paylocity's street-address suggestions are optional; free text is valid.
    // Keep other autocomplete controls on the selection-verification path.
    if (/(^|\.)paylocity\.com$/.test(el.ownerDocument.location.hostname) &&
        el.matches('input[data-automation-id="public-site-address-address-1"][aria-autocomplete="list"]')) return false;
    if (
      el.matches('[data-automation-id="selectInput"], input[data-automation-id="searchBox"]') ||
      /type.*add.*skills/i.test(el.placeholder||"") ||
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.getAttribute("aria-controls") ||
      el.getAttribute("aria-owns")
    ) {
      return true;
    }
    // No ARIA: judge by the company it keeps. Only the immediate surroundings
    // count — widen this and every input on a page with a dropdown somewhere
    // becomes a combobox.
    if (el.tagName !== "INPUT" || (el.type && el.type !== "text" && el.type !== "search")) return false;
    if (WIDGET_PLACEHOLDER.test(el.getAttribute("placeholder") || "")) return true;
    if (looksLikeWidgetChrome(el)) return true;
    for (let node = el.parentElement, depth = 0; node && depth < 2; node = node.parentElement, depth++) {
      // A page/form container is not widget chrome. A directly nested name
      // input must not inherit a neighboring dropdown's type and search logic.
      if (/^(MAIN|FORM|BODY|HTML)$/.test(node.tagName)) break;
      // A separate input beside this one owns its own dropdown chrome.
      // Rippling places the telephone textbox beside the country selector.
      if ([...node.querySelectorAll('input:not([type="hidden"]), select, textarea')]
          .some(input => input !== el)) break;
      if (node.querySelector(WIDGET_CHROME) || looksLikeWidgetChrome(node)) return true;
    }
    return false;
  }

  /** Options already present in the DOM, if the widget wires up aria-controls. */
  function staticOptions(el) {
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || el.closest(".pcty-input-select-full-container")?.getAttribute("aria-owns");
    const list = id && el.ownerDocument.getElementById(id);
    if (!list) return [];
    return readListbox(list);
  }

  function readListbox(list) {
    return Array.from(list.querySelectorAll('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]'))
      .map((n) => clean(n.textContent))
      .filter(Boolean);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Read every option, scrolling a virtualised menu to reach the rest.
   *
   * Workday renders long lists through react-virtualized: about thirteen of
   * 250 countries exist in the DOM at once. Reading only what is rendered
   * hands the validator a list starting at "Afghanistan" and ending well
   * before "United States", which then correctly refuses a correct answer.
   *
   * Order is preserved and duplicates dropped, because a virtualised list
   * re-renders overlapping rows as it scrolls. The scroll position is put back
   * so the page looks untouched.
   */
  /**
   * Every option in a listbox, scrolling a virtualised one to reach them.
   *
   * `partial` says the scroll ran out of turns before reaching the bottom, so
   * what came back is a prefix of the real list rather than the whole of it.
   * That distinction is load-bearing downstream: a prefix cannot be matched
   * against. Greenhouse's school list stops in the A's after 80 turns, and
   * placing "Example State University" in it produced "Alabama State
   * University" — a real school, on a real application, and the wrong one.
   */
  async function readListboxFully(list) {
    const seen = new Set();
    const push = () => {
      for (const text of readListbox(list)) seen.add(text);
    };
    push();
    // An empty/loading menu has no scrollable option inventory yet.
    if (!seen.size) return { options: [], partial: true };

    const inner = [...list.querySelectorAll('*')].filter(node =>
      node.querySelector('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]') &&
      /^(auto|scroll)$/.test(getComputedStyle(node).overflowY) &&
      node.scrollHeight > node.clientHeight + 4);
    if (inner.length > 1) return { options: [...seen], partial: true };
    let box = inner[0] || null;
    for (let n = list; !box && n && n !== list.ownerDocument.body; n = n.parentElement) {
      if (/^(auto|scroll)$/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 4) {
        box = n;
        break;
      }
    }
    if (!box) return { options: [...seen], partial: false };

    const restore = box.scrollTop;
    const step = Math.max(120, box.clientHeight - 40);
    box.scrollTop = 0;
    let reachedEnd = false;
    for (let i = 0; i < 80; i++) {
      await sleep(40);
      push();
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) {
        reachedEnd = true;
        break;
      }
      box.scrollTop += step;
    }
    box.scrollTop = restore;
    return { options: [...seen], partial: !reachedEnd };
  }

  /**
   * Open a combobox and read its rendered options.
   *
   * react-select (Greenhouse, Ashby) opens on mousedown rather than click, and
   * portals the listbox outside the field's own subtree — so we look it up by
   * the conventional id first, then fall back to any open listbox.
   *
   * @returns {Promise<{options: string[], async: boolean}>} `async` marks a
   *   type-to-search widget that returns nothing until a query is entered; those
   *   are filled by typing and taking the first match instead of by matching a
   *   known list.
   */
  async function expandCombobox(el) {
    const doc = el.ownerDocument;
    const before = staticOptions(el);
    if (before.length) return { options: before, async: false };

    // These widgets render their popup in a portal at the end of <body>, not
    // inside themselves, so "the open listbox" cannot be found by position in
    // the tree. Note which ones are already open, and take the one that
    // appears — otherwise a popup left open by an earlier field is read as
    // this field's options. That mis-attribution had Workday's Country and
    // State both reporting the phone-code widget's two entries, and it is
    // worse than finding nothing: the value chosen comes from another
    // question's list.
    // "Newly open", not "newly created": some widgets build the popup on
    // demand, others keep it in the DOM and toggle `hidden`. Only the first
    // kind is caught by watching for new nodes.
    const openListboxes = () => openMenus(doc);
    const already = new Set(openListboxes());

    el.focus();
    // react-select opens on mousedown; a button dropdown needs an actual
    // click. Without it Workday's State and Phone Device Type lists are never
    // read, so the validator has no options to match an answer against and
    // discards a correct one as "matches no available option".
    if (el.closest('.pcty-input-select-full-container')) {
      el.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',code:'ArrowDown',bubbles:true}));
    } else if (isPopupButton(el)) {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      // Workday's search box ignores synthesised mouse events and opens only
      // on a real click. react-select has already opened by now, and clicking
      // an open one would toggle it shut — so only click if nothing opened.
      await sleep(80);
      if (!openMenus(doc).some((list) => !already.has(list))) el.click();
    }

    const owned = () => {
      const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || el.closest(".pcty-input-select-full-container")?.getAttribute("aria-owns");
      const byId = id && doc.getElementById(id);
      if (byId && !isSelectionList(byId)) return byId;
      if (el.id && doc.getElementById(`react-select-${el.id}-listbox`)) {
        return doc.getElementById(`react-select-${el.id}-listbox`);
      }
      // Opened since this widget was clicked.
      return openListboxes().find((list) => !already.has(list));
    };

    let options = [];
    let partial = false;
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      const list = owned();
      if (list) {
        ({ options, partial } = await readListboxFully(list));
        if (options.length) break;
      }
    }

    await closePopup(el);
    return { options, partial, async: options.length === 0 };
  }

  /**
   * Shut a widget's menu before moving to the next field, and confirm it shut.
   *
   * Reading options means opening every dropdown on the page, so a close that
   * silently fails leaves a trail of open menus behind. Workday ignores Escape
   * here, and two stale menus left open were enough to make the *filler* pick
   * the wrong list entirely: it committed against a leftover popup holding two
   * duplicate entries instead of the widget it was actually filling.
   *
   * Waiting for the menu to actually go is the point — an unverified close is
   * how the trail accumulated in the first place.
   */
  async function closePopup(el) {
    const doc = el.ownerDocument;
    const stillOpen = () => openMenus(doc).length;

    const before = stillOpen();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    el.blur();
    await sleep(60);
    if (stillOpen() < before || !stillOpen()) return;

    // Clicking away is what dismisses the widgets that ignore Escape.
    doc.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    doc.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    doc.body.click();
    for (let i = 0; i < 10 && stillOpen(); i++) await sleep(50);
  }

  /**
   * Second pass over a scraped schema: open each combobox to learn its options.
   * Mutates `schema.fields` in place and stashes full option lists on the
   * namespace so the filler can fuzzy-match locally against lists too large to
   * send to the model.
   */
  async function expandOptions(schema, registry) {
    ns._options = ns._options || {};
    for (let i = 0; i < schema.fields.length; i++) {
      const field = schema.fields[i];
      if (field.type !== "combobox" || field.options) continue;
      const el = registry[i][0];
      // Workday search inputs query their own taxonomy. Enumerating it scrolls
      // huge menus and can disturb an existing selection before filling starts.
      if(field.skillPicker || el.matches('input[data-uxi-widget-type="selectinput"]')) {
        field.asyncSearch=true;field.optionsPartial=true;continue;
      }
      let result;
      try {
        result = await expandCombobox(el);
      } catch {
        continue;
      }
      ns._options[field.id] = result.options;
      // Read off the page but not to the end — see readListboxFully.
      if (result.partial) field.optionsPartial = true;
      if (result.async) {
        field.asyncSearch = true; // fill by typing, then accept first match
        continue;
      }
      field.options = result.options.slice(0, MAX_INLINE_OPTIONS);
      if (result.options.length > MAX_INLINE_OPTIONS) {
        field.optionsTruncated = true;
        field.optionCount = result.options.length;
      }
    }
    return schema;
  }

  function detectAts() {
    const host = location.hostname;
    const html = document.documentElement.innerHTML;
    if (/greenhouse\.io/.test(host) || /greenhouse/i.test(html.slice(0, 4000))) return "greenhouse";
    if (/lever\.co/.test(host)) return "lever";
    if (/myworkdayjobs\.com|workday/.test(host)) return "workday";
    if (/ashbyhq\.com/.test(host)) return "ashby";
    if (/bamboohr\.com/.test(host)) return "bamboohr";
    if (/workable\.com/.test(host)) return "workable";
    if (/jobvite\.com/.test(host)) return "jobvite";
    if (/smartrecruiters\.com/.test(host)) return "smartrecruiters";
    if (/icims\.com/.test(host)) return "icims";
    return "unknown";
  }

  /** Job title / company, used as context when the model writes free-text answers. */
  function jobContext() {
    const meta = (prop) =>
      clean(document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.content);
    const h1 = clean(document.querySelector("h1")?.textContent);
    // Boards title pages as "Job Application for <role> at <Company>".
    const fromTitle = /\bat\s+([^|·—-]+?)\s*$/.exec(clean(document.title));
    return {
      url: location.href,
      title: h1 || meta("og:title") || clean(document.title),
      company: meta("og:site_name") || (fromTitle ? fromTitle[1].trim() : "") || companyFromUrl(),
    };
  }

  /**
   * The employer, taken from the address when the page does not say.
   *
   * Workday titles its pages after the role and sets no og:site_name, so the
   * employer was simply unknown — and "have you worked here before?" cannot be
   * answered without it. Every major applicant tracking system puts the tenant
   * in the host or the first path segment, which is the one piece of employer
   * identity that is always present.
   */
  function companyFromUrl() {
    const { hostname, pathname } = location;
    const workday = /^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(hostname);
    if (workday) return workday[1];

    const slug = pathname.split("/").filter(Boolean);
    if (/(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|jobvite\.com)$/i.test(hostname)) {
      // e.g. boards.greenhouse.io/<company>/jobs/123, jobs.lever.co/<company>/…
      const first = slug.find((part) => !/^(embed|en-us|jobs|job|careers|o)$/i.test(part));
      if (first) return first;
    }
    return "";
  }

  /**
   * Scrape every fillable control on the page.
   * @returns {{schema: object, registry: Element[][]}}
   */
  function breezyResumeProxy(el) {
    if (!el.matches('input#main-attachment[name="cResume"][type="file"][ng-file-select="onFileSelect($files)"]')) return null;
    const form = el.closest('form[ng-submit="apply()"]');
    const trigger = form?.querySelector('a.resume[ng-click*="showFileSelector()"]');
    return trigger && VISIBLE(trigger) && !trigger.closest('[aria-hidden="true"]') ? trigger : null;
  }

  function selectableReadonlyAnt(el) {
    if (!el.matches('input[readonly][role="combobox"][aria-haspopup="listbox"]')) return false;
    const widget = el.closest('.ant-select-single');
    const selector = el.closest('.ant-select-selector');
    return Boolean(widget && selector && selector.closest('.ant-select-single') === widget &&
      el.closest('form, .ant-form-item') && VISIBLE(selector) &&
      !widget.matches('.ant-select-disabled, [aria-disabled="true"]') &&
      !widget.closest('[hidden], [aria-hidden="true"]') &&
      widget.querySelectorAll('input[role="combobox"]').length === 1 &&
      (el.getAttribute('aria-controls') || el.getAttribute('aria-owns')));
  }

  function dayforceFileProxy(el) {
    if (el.type !== 'file') return null;
    const definitions = {
      jobPostingApplication_files_resume: ['resume-upload-button', 'Import Resume', 'Resume'],
      jobPostingApplication_files_coverLetter: ['cover-letter-upload-button', 'Add Cover Letter', 'Cover Letter'],
      jobPostingApplication_files_additionalDocument: ['additional-documents-upload-button', 'Add Additional Documents', 'Additional Documents'],
    };
    const spec = definitions[el.id];
    const wrapper = el.parentElement;
    if (!spec || !wrapper?.matches('span.ant-upload') ||
        wrapper.querySelectorAll('input[type="file"]').length !== 1 ||
        wrapper.closest('[hidden],[aria-hidden="true"],.ant-upload-disabled')) return null;
    const buttons = wrapper.querySelectorAll('button');
    const button = buttons[0];
    if (buttons.length !== 1 || button.type !== 'button' || button.disabled ||
        button.getAttribute('aria-disabled') === 'true' || !VISIBLE(button) ||
        button.getAttribute('test-id') !== spec[0] || clean(visibleText(button)) !== spec[1]) return null;
    return spec[2];
  }

  function fileLabelProxy(el) {
    if (el.type !== 'file') return null;
    const labels = [...(el.labels || [])].filter(label => label.control === el && label.contains(el) &&
      label.querySelectorAll('input[type="file"]').length <= 1 && VISIBLE(label) &&
      !label.closest('[hidden],[aria-hidden="true"]') && clean(visibleText(label)));
    return labels.length === 1 ? labels[0] : null;
  }

  function personioDocumentGroup(el) {
    if (el.type !== 'file' || !/^documents\.(cv|cover-letter|other)$/.test(el.name) ||
        el.id !== 'doc-input-' + el.name.slice('documents.'.length)) return null;
    const group = el.closest('.document-field-wrapper[role="group"][aria-labelledby]');
    const wrapper = el.parentElement;
    const trigger = wrapper?.querySelector('button.add-file-button[type="button"]');
    if (!group || !wrapper.matches('.document-input-wrapper') ||
        wrapper.querySelectorAll('input[type="file"]').length !== 1 ||
        !trigger || !VISIBLE(trigger) || group.closest('[hidden],[aria-hidden="true"]')) return null;
    return group;
  }

  // Paycom marks the visible contact section inside its modal aria-hidden.
  // Limit the compatibility exception to enabled, visible text controls inside
  // that vendor's active dialog; background forms and hidden fields stay out.
  function paycomVisibleContact(el) {
    if (!/(^|\.)paycomonline\.(net|com)$/.test(el.ownerDocument.location.hostname) ||
        !el.matches('input[type="text"][tabindex="0"]') || !VISIBLE(el)) return false;
    const dialog=el.closest('.uiLibModalBody[role="dialog"][aria-modal="true"]');
    if (!dialog || !VISIBLE(dialog) || dialog.closest('[hidden],[aria-hidden="true"]')) return false;
    for(let n=el;n&&n!==dialog;n=n.parentElement) {
      if(n.hidden || getComputedStyle(n).display==='none' || getComputedStyle(n).visibility==='hidden')return false;
    }
    return Boolean(el.closest('.uiLibInput') && (el.required || el.getAttribute('aria-label')));
  }

  function scrape() {
    ns._honeypots = 0;
    // LinkedIn keeps its background search inputs visible behind Easy Apply.
    // Restrict an observed application dialog without treating other dialogs
    // (messages, settings, cookie prompts) as application forms.
    const applicationDialogs = /(^|\.)linkedin\.com$/.test(location.hostname)
      ? [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
        .filter(d => VISIBLE(d) && /^Apply to\s+/i.test(clean(d.querySelector('h1,h2,h3')?.textContent))) : [];
    const scope = applicationDialogs.length === 1 ? applicationDialogs[0] : document;
    const controls = Array.from(scope.querySelectorAll(CONTROLS)).filter((el) => {
      // Site navigation is not the application. A footer locale selector on
      // an employer-hosted page must not be filled before its ATS iframe.
      if (el.closest('nav, footer, [role="navigation"], [role="contentinfo"]')) return false;
      if (/(^|\.)applicantpro\.com$/.test(location.hostname) && el.closest('form#refer-widget-form,form#faq_bar_form')) return false;
      // Personio's page/iframe locale switches sit outside semantic navigation.
      // They change the page language, not a candidate's language proficiency.
      if (el.closest('.locale-display.language-selector')) return false;
      // A <button> reports type "submit", which SKIP_TYPES rejects; the skip
      // list is about input types, so it must not be applied to them.
      if (!isPopupButton(el) && SKIP_TYPES.has(el.type)) return false;
      if (el.disabled || (el.readOnly && !selectableReadonlyAnt(el))) return false;
      const proxy = choiceProxy(el);
      if (el.closest('[aria-hidden="true"]') && !proxy && !paycomVisibleContact(el)) return false;
      if (el.closest(SUBWIDGET)) return false;
      if (!VISIBLE(el) && !proxy && !breezyResumeProxy(el) && !personioDocumentGroup(el) && !fileLabelProxy(el) && !dayforceFileProxy(el)) return false;
      // Never scraped, so never sent to a model and never filled.
      if (isHoneypot(el)) {
        ns._honeypots++;
        return false;
      }
      return true;
    });

    const fields = [];
    const registry = [];
    const radioGroups = new Map();
    const dateGroups = new Map();
    ns._options = {};

    for (const el of controls) {
      // A date is one question spread over month, day and year inputs. Emit it
      // once, holding every segment, or the form comes back as three fields
      // sharing the label "/ /" and no way to answer any of them.
      const segmentGroup = isProxied(el) ? el.parentElement?.closest('[role="group"]') : null;
      if (segmentGroup) {
        if (dateGroups.has(segmentGroup)) {
          dateGroups.get(segmentGroup).push(el);
          continue;
        }
        dateGroups.set(segmentGroup, [el]);
        continue;
      }

      // Radios and grouped checkboxes collapse into a single question.
      const key = choiceGroupKey(el, controls);
      if (key) {
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(el);
        continue;
      }

      const id = `f${registry.length}`;
      const field = {
        id,
        label: labelFor(el),
        type: el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : el.type || "text",
        required: isRequired(el),
      };
      if (breezyResumeProxy(el)) {
        field.label = "Resume";
        field.required = el.closest('form').querySelector('input#resume_required[type="hidden"]')?.value === "required";
      }
      const documentGroup = personioDocumentGroup(el);
      if (documentGroup) {
        const caption = document.getElementById(documentGroup.getAttribute('aria-labelledby'));
        field.label = clean(caption?.textContent || el.getAttribute('aria-label') || '').replace(/\s*\(required\)\s*/ig,'').replace(/\*/g,'').trim();
        field.required = field.required || /\*|\(required\)/i.test(caption?.textContent || '');
      }

      const dayforceFile = dayforceFileProxy(el);
      if (dayforceFile) field.label = dayforceFile;

      const section = sectionLabel(el);
      if (section && section !== field.label) field.section = section;
      const history=historyContext(el);
      if(history) {field.history=history;field.section=history.kind;}
      if(/^(?:MM\/YYYY|MM\/DD\/YYYY|YYYY(?:-MM(?:-DD)?)?)$/i.test(el.placeholder || ''))field.dateFormat=el.placeholder.toUpperCase();

      // File inputs usually label themselves after the button ("Attach",
      // "Upload"), which makes a resume slot and a cover-letter slot identical.
      // The question they belong to sits above them.
      if (field.type === "file" && (!field.label || GENERIC_FILE_LABEL.test(field.label) || fileLabelProxy(el))) {
        // When the question above is generic too — Greenhouse draws "Attach"
        // for both the résumé and the cover letter, under headings that read
        // the same — the input's own name is what tells them apart. Every
        // applicant tracking system names these honestly (`resume`,
        // `cover_letter`), because their own backend has to route the file.
        const fieldset = el.closest('fieldset');
        const legend = fieldset?.querySelector(':scope > legend');
        const ownCaption = fileLabelProxy(el) && clean(visibleText(fileLabelProxy(el)));
        const asked = ownCaption && !GENERIC_FILE_LABEL.test(ownCaption) ? ownCaption
          : legend && fieldset.querySelectorAll('input[type="file"]').length === 1
          ? clean(visibleText(legend)) : groupLabel(el);
        const named = `${el.id || ""} ${el.name || ""}`.replace(/[_\-]+/g, " ").trim();
        field.label =
          (asked && !GENERIC_FILE_LABEL.test(asked) ? asked : "") ||
          (/resume|curriculum vitae|\bcv\b|cover/i.test(named) ? named : "") ||
          asked ||
          field.label;
      }

      if (el.tagName === "SELECT") {
        const all = Array.from(el.options)
          .map((o) => clean(o.textContent))
          .filter((t) => t && !/^(select|choose|--)/i.test(t));
        ns._options[id] = all;
        field.options = all.slice(0, MAX_INLINE_OPTIONS);
        if (all.length > MAX_INLINE_OPTIONS) {
          field.optionsTruncated = true;
          field.optionCount = all.length;
        }
      } else if (isCombobox(el)) {
        field.type = "combobox";
        if(el.closest('[data-automation-id="formField-skills"], [data-automation-id="skills"]') || /^skills\b/i.test(field.label) || /type.*add.*skills/i.test(el.placeholder||'')) {
          field.skillPicker=true;
          field.multiple=true;
          field.asyncSearch=true;
        }
        const known = staticOptions(el);
        if (known.length) {
          ns._options[id] = known;
          field.options = known.slice(0, MAX_INLINE_OPTIONS);
          if (known.length > MAX_INLINE_OPTIONS) {
            field.optionsTruncated = true;
            field.optionCount = known.length;
          }
        }
      }

      if (el.maxLength > 0 && el.maxLength < 10000) field.maxLength = el.maxLength;
      if (!field.label && !field.options) continue; // unlabelled and unconstrained — skip

      fields.push(field);
      registry.push([el]);
    }

    for (const [group, segments] of dateGroups) {
      const id = `f${registry.length}`;
      const dateField = {
        id,
        label: labelFor(segments[0]),
        type: "date",
        required: segments.some(isRequired),
        // What the widget wants back, so a caller knows a bare year will do.
        parts: segments.map((seg) => clean(seg.getAttribute("aria-label")) || "value"),
      };
      const dateSection = sectionLabel(segments[0]);
      if (dateSection && dateSection !== dateField.label) dateField.section = dateSection;
      fields.push(dateField);
      registry.push(segments);
      void group;
    }

    // Paycor's initial screening questions use paired div buttons and a
    // hidden boolean answer. Surface them as required questions, not "no form".
    if (location.hostname==='recruitingbypaycor.com') for(const group of document.querySelectorAll('.gnewtonQuestionWrapper')) {
      const yes=group.querySelectorAll('.gnewtonYes[id^="y_"]'),no=group.querySelectorAll('.gnewtonNo[id^="n_"]');
      const caption=group.querySelector(':scope > .gnewtonQuestion');
      if(yes.length!==1||no.length!==1||!caption||!VISIBLE(yes[0])||!VISIBLE(no[0])||
         group.closest('[hidden],[aria-hidden="true"]'))continue;
      const key=yes[0].id.slice(2),answer=document.getElementById(key);
      if(no[0].id!=='n_'+key||answer?.type!=='hidden'||!key)continue;
      fields.push({id:`f${registry.length}`,label:clean(caption.textContent),type:'radio',required:true,options:['Yes','No'],customChoice:'paycor'});
      registry.push([yes[0],no[0]]);
    }

    for (const [key, els] of radioGroups) {
      const id = `f${registry.length}`;
      const type = key.startsWith("radio") ? "radio" : "checkbox-group";
      // The first option's own text is not the question — "Yes, I have a
      // disability" labelling the disability question makes the answer look
      // like the prompt. Fall back to the section heading instead.
      const optionTexts = els.map((e) => labelFor(e) || clean(e.value)).filter(Boolean);
      // Some ARIA proxies repeat the full question before each YES/NO label.
      // Recover that shared question instead of inheriting a vague heading
      // such as "Details", which hides what fact the answer must be pinned to.
      const repeated = optionTexts.map(text => /^(.+\?)\s+(yes|no)$/i.exec(text));
      const repeatedQuestion = repeated.length >= 2 && repeated.every(m => m && m[1] === repeated[0]?.[1])
        ? repeated[0][1] : null;
      const own = labelFor(els[0]);
      // LinkedIn's saved-document cards have filename labels, but their
      // question is a paragraph outside the cards, not a fieldset legend.
      const linkedInDialog = /(^|\.)linkedin\.com$/.test(location.hostname)
        ? els[0].closest('dialog[open], [role="dialog"][aria-modal="true"]') : null;
      const resumeCaptions = linkedInDialog && els.every(el => /\.(pdf|docx?)$/i.test(el.closest('[role="radio"]')?.getAttribute('aria-label') || ''))
        ? [...linkedInDialog.querySelectorAll('p')].filter(el => VISIBLE(el) && /^Resume\s*\*?$/i.test(el.textContent.trim())) : [];
      const resumeCaption = resumeCaptions.length === 1 ? resumeCaptions[0].textContent.trim() : '';
      const choiceField = {
        id,
        // The group is handed to groupLabel so it can tell the question from
        // the choices — without it the nearest label is one of the answers.
        label: clean(resumeCaption) || repeatedQuestion || groupLabel(els[0], els) || (optionTexts.includes(own) ? sectionLabel(els[0]) || own : own),
        type,
        required: /\*$/.test(resumeCaption) || els.some(isRequired) || /\*\s*Required\b|\(required\)/i.test(groupLabel(els[0], els)) ||
          Boolean(els[0].matches(".resumator-questionnaire-checkbox") && els[0].closest(".form-group")?.querySelector("label.control-label .asterisk")),
        options: optionTexts,
      };
      if (type === "checkbox-group" && /(?:choose|select)\s+(?:1|one)\s+(?:answer|option)\s+only/i.test(choiceField.label))
        choiceField.maxSelections = 1;
      if (/^(details|personal information|profile|qualifications|application questions)$/i.test(choiceField.label || "") && optionTexts.length > 1) {
        let shared = optionTexts[0];
        for (const option of optionTexts.slice(1)) {
          let end = 0;
          while (end < shared.length && shared[end] === option[end]) end++;
          shared = shared.slice(0, end);
        }
        // Only a complete shared question/prompt, not a common answer prefix.
        const prompt = shared.match(/^(.+[?:])\s*/)?.[1];
        if (prompt && prompt.length > 15) choiceField.label = prompt.trim();
      }
      const question = clean(choiceField.label);
      if (question.length > 15 && optionTexts.every(text => text.startsWith(question) && text.length > question.length)) {
        choiceField.options = optionTexts.map(text => text.slice(question.length).trim());
      }
      const choiceSection = sectionLabel(els[0]);
      if (choiceSection && choiceSection !== choiceField.label) choiceField.section = choiceSection;
      fields.push(choiceField);
      registry.push(els);
    }

    ns._registry = registry;
    return {
      schema: { ats: detectAts(), ...jobContext(), fields },
      registry,
    };
  }

  /**
   * Full scrape: structure first, then open each combobox to learn its options.
   * This is the entry point callers should use; `scrape()` alone cannot see
   * options that only exist once a widget is opened.
   */
  async function scrapeFull() {
    // JazzHR starts with neither attachment nor paste mode open. Reveal only
    // the explicit local attachment choice, preserving existing resume work.
    const resume = document.getElementById("resumator-resume");
    const attach = resume?.querySelector('a#resumator-choose-upload[href="#"]');
    const file = resume?.querySelector('input#resumator-resume-value[type="file"]');
    const pasted = resume?.querySelector("textarea#resumator-resumetext-value");
    if (attach && file && VISIBLE(attach) && !attach.closest('[aria-hidden="true"]') &&
        !file.disabled && !file.files?.length && !pasted?.value.trim() && !isHoneypot(file)) {
      attach.click();
      await sleep(100);
    }
    const { schema, registry } = scrape();
    await expandOptions(schema, registry);
    return { schema, registry };
  }

  /**
   * Fillable controls that exist but are not currently visible.
   *
   * Distinguishes "there is no form here" from "the form is closed". Many
   * careers pages mount the ATS iframe collapsed until an Apply button is
   * pressed — 39 inputs present, none rendered — and reporting that as "no form
   * found" tells the user nothing actionable.
   */
  function hiddenFieldCount() {
    return Array.from(document.querySelectorAll("input, select, textarea")).filter(
      (el) =>
        !SKIP_TYPES.has(el.type) &&
        !el.disabled &&
        !el.closest(SUBWIDGET) &&
        !VISIBLE(el)
    ).length;
  }

  /** Reviewed application entries: the form is mounted only after this click.
   * No generic "Apply" inference on a final-review page with no input fields.
   */
  function lazyFormOpener(root = document) {
    const matches = [...root.querySelectorAll('button[type="button"][data-bi-id="careers-site-apply-button"], ukg-button[data-automation="apply-now-button"][data-tag-name="button"], button[type="button"][test-id="apply-without-account"]')]
      .filter(el => !el.form && !el.closest('form') && !el.disabled &&
        !el.hasAttribute('disabled') && el.getAttribute('aria-disabled')!=='true' && VISIBLE(el) &&
        (el.tagName==='UKG-BUTTON' ? /^apply now$/i : el.getAttribute('test-id')==='apply-without-account' ? /^apply without an account$/i : /^apply for this job$/i).test(clean(el.textContent)));
    if (/(^|\.)icims\.com$/i.test(location.hostname) && /^\/jobs\/\d+\//.test(location.pathname)) {
      for (const link of root.querySelectorAll('a.iCIMS_ApplyOnlineButton[title="Apply for this job online"]')) {
        if (!VISIBLE(link) || link.closest('form') || link.getAttribute('aria-disabled') === 'true' ||
            link.hasAttribute('download') || link.hasAttribute('onclick') ||
            (link.target && link.target !== '_self') ||
            clean(link.querySelector('.iCIMS_LongLabel')?.textContent) !== 'Apply for this job online') continue;
        let target; try { target = new URL(link.href); } catch { continue; }
        if (target.origin === location.origin && target.pathname === location.pathname &&
            target.searchParams.get('mode') === 'apply' && target.searchParams.get('apply') === 'yes') matches.push(link);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * A control that would reveal a closed application form.
   *
   * Only ever used when nothing fillable is visible, so "Apply" here opens a
   * form rather than submitting one. Anything that looks like a real submission
   * is excluded outright — revealing a form must never risk sending it.
   */
  function findOpener(root = document) {
    const lazy = lazyFormOpener(root);
    if (lazy) return lazy;
    const OPENS = /\bapply\b|start (your )?application|apply now|view application/i;
    const NEVER = /\bsubmit\b|send application|confirm|agree|sign in|log ?in|search/i;
    const candidates = Array.from(
      root.querySelectorAll('button, a, [role="button"], input[type="button"]')
    );
    const matches = candidates.filter((el) => {
        const text = clean(el.textContent || el.value || el.getAttribute("aria-label") || "");
        if (!text || text.length > 40) return false;
        if (NEVER.test(text) || !OPENS.test(text)) return false;
        if (!VISIBLE(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;

        // `type="submit"` alone does not mean "sends an application" — Airbnb's
        // "Apply Now", which merely opens the form, is one. Refuse only when the
        // button could actually submit something: a form with visible fields in
        // it. With nothing fillable on screen there is nothing to send.
        if (el.type === "submit") {
          const form = el.closest("form");
          const live = form
            ? Array.from(form.querySelectorAll("input, select, textarea")).filter(
                (f) => !SKIP_TYPES.has(f.type) && VISIBLE(f)
              ).length
            : 0;
          if (live) return false;
        }
        return true;
      });
    if (matches.length === 1) return matches[0];
    // Careers pages repeat the same navigation at the top and bottom. Those
    // links identify one destination; duplicate buttons do not provide that
    // evidence. Only equivalent ordinary same-tab links may share a target.
    if (matches.length > 1 && matches.every(el => el.tagName === 'A' &&
      /^https?:\/\//.test(el.href) && !el.hasAttribute('download') &&
      !el.hasAttribute('onclick') && (!el.target || el.target === '_self') &&
      el.href === matches[0].href && clean(el.textContent) === clean(matches[0].textContent)))
      return matches[0];
    return null;
  }

  ns.scrape = scrape;
  ns.scrapeFull = scrapeFull;
  ns.isHoneypot = isHoneypot;
  // Exported for diagnostics: why a control was or was not picked up.
  ns.isVisible = VISIBLE;
  ns.choiceProxy = choiceProxy;
  ns.groupLabel = groupLabel;
  ns.sectionLabel = sectionLabel;
  ns.hiddenFieldCount = hiddenFieldCount;
  ns.lazyFormOpener = lazyFormOpener;
  ns.findOpener = findOpener;
  ns.expandOptions = expandOptions;
  ns.labelFor = labelFor;
  ns.detectAts = detectAts;
})();
