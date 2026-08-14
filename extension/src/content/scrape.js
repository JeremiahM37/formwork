/**
 * formwork — DOM scraper.
 *
 * Turns an arbitrary application form into a compact, ATS-agnostic field schema
 * that a language model can reason about. Deliberately contains NO per-ATS
 * selector maps: everything here is derived from generic HTML semantics, which
 * is what makes the project survive ATS redesigns.
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
    'input, select, textarea, button[aria-haspopup="listbox"], [role="combobox"]:not(input)';

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
    return Array.from(doc.querySelectorAll('[role="listbox"]:not([hidden])')).filter(
      (list) => !isSelectionList(list) && list.querySelector('[role="option"], li')
    );
  }

  /** A dropdown rendered as a button rather than a form control. */
  const isPopupButton = (el) =>
    el.tagName === "BUTTON" || (el.getAttribute("role") === "combobox" && el.tagName !== "INPUT");

  /**
   * Sub-controls of composite widgets that are not questions in their own right
   * — e.g. intl-tel-input renders a country search box next to the phone field.
   */
  const SUBWIDGET = '.iti, .iti__search-input, [class*="country-select"]';

  /** Beyond this, option lists cost more tokens than they inform. */
  const MAX_INLINE_OPTIONS = 25;

  /**
   * Transient or decorative UI that sits inside a field's container but is not
   * part of its question: autocomplete menus, live-region status, validation
   * messages, loading spinners.
   */
  const NOISE =
    '[aria-live], [role="status"], [role="alert"], [role="listbox"], [role="menu"], ' +
    '[class*="dropdown"], [class*="menu"], [class*="suggest"], [class*="error"], ' +
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
    const styled = el.type === "radio" || el.type === "checkbox" || isProxied(el);

    // No real text control is a couple of pixels tall, or parked off the canvas.
    const rect = el.getBoundingClientRect();
    if (!styled && (rect.width < 4 || rect.height < 4)) return true;
    if (!styled && (rect.right < 0 || rect.bottom < 0)) return true;
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
    const shell = el.parentElement?.closest('[role="group"], [data-automation-id]');
    if (!shell) return false;
    const rect = shell.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const VISIBLE = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return isProxied(el);
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const clean = (s) =>
    (s || "")
      .replace(/[\s ]+/g, " ")
      .replace(/\*$/, "")
      .trim();

  /**
   * Best-effort human label for a control, in descending order of reliability.
   * The label is the model's primary signal, so it is worth trying hard here.
   */
  function labelFor(el) {
    const doc = el.ownerDocument;

    if (el.id) {
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return clean(lbl.textContent);
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

    const box = el.closest('fieldset, [role="group"], [role="radiogroup"], [data-automation-id^="formField"]');
    if (!box) return null;
    const siblings = controls.filter((c) => c.type === "checkbox" && box.contains(c));
    // One checkbox in a container is a single yes/no — an agreement, an
    // opt-in — and must stay its own field.
    if (siblings.length < 2) return null;
    return `checkbox:${box.getAttribute("data-automation-id") || box.id || groupLabel(el)}`;
  }

  /** Question text shared by a radio/checkbox group — usually a legend. */
  function groupLabel(el) {
    const fs = el.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector("legend");
      if (legend && clean(legend.textContent)) return clean(legend.textContent);
    }
    const grouped = el.closest('[role="group"], [role="radiogroup"]');
    if (grouped) {
      const aria = clean(grouped.getAttribute("aria-label"));
      if (aria) return aria;
    }
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const heading = node.querySelector("legend, h2, h3, h4, label");
      if (heading && !heading.contains(el) && clean(heading.textContent)) {
        return clean(heading.textContent);
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
    return el.getAttribute("aria-label") || el.closest("label")?.textContent || "";
  }

  function isRequired(el) {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    return /\*\s*$|\(required\)/i.test(rawLabelText(el).replace(/[\s ]+/g, " ").trim());
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
    if (
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
      if (node.querySelector(WIDGET_CHROME) || looksLikeWidgetChrome(node)) return true;
    }
    return false;
  }

  /** Options already present in the DOM, if the widget wires up aria-controls. */
  function staticOptions(el) {
    const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
    const list = id && el.ownerDocument.getElementById(id);
    if (!list) return [];
    return readListbox(list);
  }

  function readListbox(list) {
    return Array.from(list.querySelectorAll('[role="option"], li'))
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
  async function readListboxFully(list) {
    const seen = new Set();
    const push = () => {
      for (const text of readListbox(list)) seen.add(text);
    };
    push();

    let box = null;
    for (let n = list; n && n !== list.ownerDocument.body; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 4) {
        box = n;
        break;
      }
    }
    if (!box) return [...seen];

    const restore = box.scrollTop;
    const step = Math.max(120, box.clientHeight - 40);
    box.scrollTop = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(40);
      push();
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) break;
      box.scrollTop += step;
    }
    box.scrollTop = restore;
    return [...seen];
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
    if (isPopupButton(el)) {
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
      const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      const byId = id && doc.getElementById(id);
      if (byId && !isSelectionList(byId)) return byId;
      if (el.id && doc.getElementById(`react-select-${el.id}-listbox`)) {
        return doc.getElementById(`react-select-${el.id}-listbox`);
      }
      // Opened since this widget was clicked.
      return openListboxes().find((list) => !already.has(list));
    };

    let options = [];
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      const list = owned();
      if (list) {
        options = await readListboxFully(list);
        if (options.length) break;
      }
    }

    await closePopup(el);
    return { options, async: options.length === 0 };
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
      let result;
      try {
        result = await expandCombobox(el);
      } catch {
        continue;
      }
      ns._options[field.id] = result.options;
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
  function scrape() {
    ns._honeypots = 0;
    const controls = Array.from(document.querySelectorAll(CONTROLS)).filter((el) => {
      // A <button> reports type "submit", which SKIP_TYPES rejects; the skip
      // list is about input types, so it must not be applied to them.
      if (!isPopupButton(el) && SKIP_TYPES.has(el.type)) return false;
      if (el.disabled || el.readOnly) return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.closest(SUBWIDGET)) return false;
      if (!VISIBLE(el)) return false;
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

      const section = sectionLabel(el);
      if (section && section !== field.label) field.section = section;

      // File inputs usually label themselves after the button ("Attach",
      // "Upload"), which makes a resume slot and a cover-letter slot identical.
      // The question they belong to sits above them.
      if (field.type === "file" && (!field.label || GENERIC_FILE_LABEL.test(field.label))) {
        field.label = groupLabel(el) || field.label;
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

    for (const [key, els] of radioGroups) {
      const id = `f${registry.length}`;
      const type = key.startsWith("radio") ? "radio" : "checkbox-group";
      // The first option's own text is not the question — "Yes, I have a
      // disability" labelling the disability question makes the answer look
      // like the prompt. Fall back to the section heading instead.
      const optionTexts = els.map((e) => labelFor(e) || clean(e.value)).filter(Boolean);
      const own = labelFor(els[0]);
      const choiceField = {
        id,
        label: groupLabel(els[0]) || (optionTexts.includes(own) ? sectionLabel(els[0]) || own : own),
        type,
        required: els.some(isRequired),
        options: optionTexts,
      };
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

  /**
   * A control that would reveal a closed application form.
   *
   * Only ever used when nothing fillable is visible, so "Apply" here opens a
   * form rather than submitting one. Anything that looks like a real submission
   * is excluded outright — revealing a form must never risk sending it.
   */
  function findOpener(root = document) {
    const OPENS = /\bapply\b|start (your )?application|apply now|view application/i;
    const NEVER = /\bsubmit\b|send application|confirm|agree|sign in|log ?in|search/i;
    const candidates = Array.from(
      root.querySelectorAll('button, a, [role="button"], input[type="button"]')
    );
    return (
      candidates.find((el) => {
        const text = clean(el.textContent || el.value || el.getAttribute("aria-label") || "");
        if (!text || text.length > 40) return false;
        if (NEVER.test(text) || !OPENS.test(text)) return false;
        if (!VISIBLE(el)) return false;

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
      }) || null
    );
  }

  ns.scrape = scrape;
  ns.scrapeFull = scrapeFull;
  ns.isHoneypot = isHoneypot;
  // Exported for diagnostics: why a control was or was not picked up.
  ns.isVisible = VISIBLE;
  ns.groupLabel = groupLabel;
  ns.sectionLabel = sectionLabel;
  ns.hiddenFieldCount = hiddenFieldCount;
  ns.findOpener = findOpener;
  ns.expandOptions = expandOptions;
  ns.labelFor = labelFor;
  ns.detectAts = detectAts;
})();
