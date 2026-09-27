/**
 * formwork — DOM filler.
 *
 * Writes validated values back into the page. The hard parts are not the plain
 * text inputs: they are React-controlled state, portalled listboxes, and
 * type-to-search comboboxes that only populate after a query.
 *
 * Nothing here submits a form. formwork fills and highlights; the user clicks.
 */
(function () {
  "use strict";

  const ns = (window.__formwork = window.__formwork || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  /**
   * Assign a value the way a user's keystroke would.
   *
   * React tracks the previous value on the DOM node and swallows any `input`
   * event whose value matches what it already believes. Assigning through the
   * prototype's native setter bypasses React's own value shim, so the change is
   * seen. Plain `el.value = x` silently no-ops on every React-based ATS.
   */
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Best option element for `value`, matched on visible text. */
  /**
   * The option a value names, or nothing if more than one could be it.
   *
   * An inexact hit is only usable while it is the *only* inexact hit. Example ATS's
   * school list has no plain "Example State University" — it has East Campus,
   * Exampletown and North Campus, plus Example Community College. Every one of them contains
   * the value, so taking the first leaves a real school on the form that the
   * applicant did not attend, and does it silently. Which campus is a question
   * only they can answer, so it is asked rather than guessed.
   */
  function matchOption(nodes, value, hints = []) {
    const want = norm(value);
    // Every string contains the empty string, so an empty value matched every
    // option and took the first one. Asking for nothing has to answer nothing:
    // a cleared field is a field someone deliberately emptied.
    if (!want) return null;
    if (nodes.filter(n => norm(n.textContent) === want).length > 1) return null;
    const exact = exactOption(nodes, value);
    if (exact) return exact;
    // A hint already contained in the value cannot tell its options apart:
    // "Exampleland" is in "Example State University", so every campus carries it.
    // The one that discriminates is the town — "Exampletown".
    const useful = hints.map(norm).filter((h) => h && !want.includes(h));
    const narrow = (list) => {
      if (list.length < 2 || !useful.length) return list;
      // A hint is a word from the profile that is not part of the answer —
      // the campus's town, say. It may only choose between options that
      // already matched on their own merits, never add one.
      const byHint = list.filter((n) => useful.some((h) => norm(n.textContent).includes(h)));
      return byHint.length === 1 ? byHint : list;
    };
    const prefixed = narrow(nodes.filter((n) => norm(n.textContent).startsWith(want)));
    if (prefixed.length === 1) return prefixed[0];
    if (prefixed.length > 1) return null;
    const contains = narrow(nodes.filter((n) => norm(n.textContent).includes(want)));
    return contains.length === 1 ? contains[0] : null;
  }

  /** The option that says exactly what was asked for, and nothing more. */
  function exactOption(nodes, value) {
    const want = norm(value);
    if (!want) return null;
    const matches = nodes.filter((n) => norm(n.textContent) === want);
    return matches.length === 1 ? matches[0] : null;
  }

  async function fillText(el, value) {
    if (el.matches('input[data-input="phone_number"]') && /^\s*\+/.test(String(value))) {
      const pair=phonePairFor(el), country=pair?.country;
      const selected=country && confirmedInputSelections.get(country);
      const code=country?.value.match(/^\+(\d{1,3})\s+[A-Z]{2}$/)?.[1];
      const text=String(value).trim();
      const digits=text.replace(/\D/g,'');
      confirmedCompositePhones.delete(el);
      if (!pair || !selected || selected.shown!==country.value || !code ||
          !/^\+[0-9 ()-]+$/.test(text) || !digits.startsWith(code) ||
          digits.length-code.length<4 || digits.length>15) return false;
      const national=digits.slice(code.length);
      el.focus();setNativeValue(el,national);el.blur();
      confirmedCompositePhones.set(el,{pair,country,shown:country.value,want:text,national});
      return true;
    }
    el.focus();
    const workday = Boolean(el.closest('[data-automation-id^="formField"]'));
    // Workday activates fields on click. All controlled text inputs need a
    // turn to commit before blur validation: Eightfold otherwise validates
    // the old empty state even while the new text is visibly retained.
    if(workday) el.click();
    setNativeValue(el, value);
    await sleep(30);
    el.blur();
    return true;
  }

  function isFormattedDate(field) {
    return Boolean(field.dateFormat) && ["text", "search"].includes(field.type);
  }

  // Month calendars must never enter the autocomplete ArrowDown/Enter path:
  // Enter can choose today's month even when typing the requested date failed.
  async function fillFormattedDate(el, field, value) {
    try {
      return await writeFormattedDate(el, field, value);
    } finally {
      // Blur alone leaves some date popovers open. Opening a second one can
      // make their focus traps fight indefinitely (Workable daily -> month
      // calendar). Dismiss through the page's outside-click handlers before
      // touching another field, without clicking any form action.
      pressKey(el, "Escape");
      el.blur();
      const body = el.ownerDocument.body;
      for (const type of ["mousedown", "mouseup", "click"]) {
        body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      await sleep(200);
    }
  }

  async function writeFormattedDate(el, field, value) {
    if (field.dateFormat === "MM/DD/YYYY") return fillDayCalendar(el, value);
    const match = /^(0[1-9]|1[0-2])\/(19\d{2}|20\d{2})$/.exec(String(value));
    if (field.dateFormat !== "MM/YYYY" || !match) return fillText(el, value);
    el.focus();
    el.click();
    await sleep(100);
    const popups = () => [...document.querySelectorAll(".react-datepicker")]
      .filter(p => p.getBoundingClientRect().width > 0 && p.querySelector(".react-datepicker__monthPicker"));
    if (popups().length !== 1) return fillText(el, value);
    const wantedYear = Number(match[2]);
    // Bounded navigation, with an observed year change after every click.
    for (let step = 0; step < 110; step++) {
      const popup = popups()[0];
      if (!popup) return false;
      const year = Number(popup.querySelector(".react-datepicker-year-header")?.textContent);
      if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
      if (year === wantedYear) {
        const month = popup.querySelector(`.react-datepicker__month-${Number(match[1]) - 1}`);
        if (!month || month.classList.contains("react-datepicker__month-text--disabled") || month.getAttribute("aria-disabled") === "true") return false;
        month.click();
        el.blur();
        await sleep(100);
        return el.value === String(value);
      }
      const button = popup.querySelector(`[aria-label="${year > wantedYear ? "Previous" : "Next"} Year"]`);
      if (!button || button.disabled) return false;
      button.click();
      await sleep(30);
      if (Number(popups()[0]?.querySelector(".react-datepicker-year-header")?.textContent) === year) return false;
    }
    return false;
  }

  function fullDateParts(value) {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value));
    if (!match) return null;
    const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 ||
        day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    return { month, day, year };
  }

  async function fillDayCalendar(el, value) {
    const wanted = fullDateParts(value);
    if (!wanted) return false;
    el.focus();
    el.click();
    await sleep(100);
    const popups = () => [...document.querySelectorAll(".react-datepicker")]
      .filter(p => p.getBoundingClientRect().width > 0 && p.querySelector(".react-datepicker__day"));
    if (popups().length !== 1) return fillText(el, value);
    const targetMonth = wanted.year * 12 + wanted.month;
    const currentMonth = popup => {
      const label = popup?.querySelector('.react-datepicker__month[role="listbox"]')?.getAttribute("aria-label") || "";
      const match = /month\s+(\d{4})-(\d{2})/.exec(label);
      return match ? Number(match[1]) * 12 + Number(match[2]) : null;
    };
    const deadline = Date.now() + 10000;
    for (let step = 0; step < 121 && Date.now() < deadline; step++) {
      const popup = popups()[0], month = currentMonth(popup);
      if (month === null) return false;
      if (month === targetMonth) {
        const day = popup.querySelector(`.react-datepicker__day--${String(wanted.day).padStart(3, "0")}:not(.react-datepicker__day--outside-month)`);
        if (!day || day.getAttribute("aria-disabled") === "true" || day.classList.contains("react-datepicker__day--disabled")) return false;
        day.click();
        el.blur();
        await sleep(100);
        const got = fullDateParts(el.value);
        return Boolean(got && got.year === wanted.year && got.month === wanted.month && got.day === wanted.day);
      }
      const nav = popup.querySelector(`[aria-label="${month > targetMonth ? "Previous" : "Next"} month" i]`);
      if (!nav || nav.disabled || nav.getAttribute("aria-disabled") === "true") return false;
      nav.click();
      await sleep(50);
      if (currentMonth(popups()[0]) === month) return false;
    }
    return false;
  }

  /**
   * Commit a value into a text input backed by an autocomplete.
   *
   * Some fields look like plain text inputs but are wired to a suggestion list
   * and discard anything the user did not pick from it — assigning `.value`
   * and blurring leaves the field empty. This was every Lever location field:
   * 21 of 21 forms in a live sweep came back with the location dropped.
   *
   * So: type, wait for suggestions, and commit one the way a person would.
   */
  async function fillAutocompleteText(el, value, { query = value, attempted = new Set() } = {}) {
    // A city with several words produces two shorter queries. Without a
    // shared visited set those recursively retry each other forever when
    // the widget rejects both ("New York" -> "New" -> "New York" ...).
    if (attempted.has(query)) return false;
    attempted.add(query);
    // Deliberately no focus() first. Lever's location field attaches its
    // place lookup on focus and clears itself doing so: focused, the same
    // keystrokes leave the box empty with no suggestions; unfocused, they
    // produce "Asheville, NC, USA". Typing does not require focus, so don't.
    await typeInto(el, query);
    await sleep(500); // let a remote suggestion query settle

    const doc = el.ownerDocument;
    // The list is rarely a child of the input, so look for a nearby one.
    const scope = el.closest("div, fieldset, form") || doc;
    // Many autocompletes ship no ARIA at all — Lever's location dropdown is
    // plain divs — so fall back to the visible children of a nearby menu-ish
    // container rather than requiring role="option".
    const ARIA = '[role="option"], [role="listbox"] li, .pac-item';
    const PLAIN =
      '[class*="dropdown"] > *, [class*="suggest"] > *, [class*="autocomplete"] > *, [class*="results"] > *';
    const seen = new Set();
    const options = [
      ...scope.querySelectorAll(ARIA),
      ...doc.querySelectorAll(`${ARIA}:not([hidden])`),
      ...scope.querySelectorAll(PLAIN),
    ].filter((n) => {
      if (seen.has(n) || !clean(n.textContent)) return false;
      seen.add(n);
      return n.offsetParent !== null || n.getClientRects().length;
    });

    const target = matchOption(options, value) || options[0];
    if (target) {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(80);
      if (norm(el.value)) return true;
    }

    // No visible list (or clicking it did nothing): commit from the keyboard,
    // which is what these widgets bind to.
    pressKey(el, "ArrowDown");
    pressKey(el, "Enter");
    await sleep(120);
    if (norm(el.value)) return true;

    // A place-name lookup may simply not recognise the query as written:
    // Lever's answers "Asheville, North Carolina" with "No location found", and wants
    // the city on its own. Try the shorter forms before giving up — each is
    // still the candidate's own answer, just phrased the way the widget
    // understands.
    const shorter = [
      String(value).split(",")[0].trim(),
      String(value).split(/[\s,]+/)[0].trim(),
    ].filter((q) => q && q !== query);
    for (const next of [...new Set(shorter)]) {
      if (await fillAutocompleteText(el, value, { query: next, attempted })) return true;
    }
    return false;
  }

  /**
   * Enter text the way a keyboard does: one character at a time.
   *
   * A place-name lookup watches for keystrokes, not for its value changing.
   * Assigning "Asheville" in one go left Lever's location field empty with no
   * suggestions at all — it discarded the value outright. The same string
   * typed character by character keeps the value and returns "Asheville, MT,
   * USA". This was the field failing on every Lever form we tried.
   */
  async function typeInto(el, text) {
    if (el.value) {
      setNativeValue(el, "");
      await sleep(60);
    }
    // Build the string locally rather than reading the field back: these
    // widgets blank their own value between keystrokes, so appending to
    // `el.value` ends with just the last character in the box.
    let typed = "";
    for (const char of String(text)) {
      typed += char;
      setNativeValue(el, typed);
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(new KeyboardEvent(type, { key: char, bubbles: true, cancelable: true }));
      }
      await sleep(70);
    }
  }

  function fillSelect(el, value) {
    const option = matchOption(Array.from(el.options), value);
    if (!option) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, option.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return true;
  }

  /**
   * Open a widget's menu, whichever event it listens for.
   *
   * react-select opens on mousedown. Workday's search box ignores synthesised
   * mouse events entirely and opens only on `.click()` — so the filler was
   * searching a menu that had never opened, and reported "could not set" on
   * every one of them.
   *
   * The click is conditional: react-select toggles, so clicking one that is
   * already open would shut it again.
   */
  async function openListbox(el) {
    const doc = el.ownerDocument;
    const before = new Set(openMenus(doc));
    el.focus();
    if (el.closest('.pcty-input-select-full-container')) {
      pressKey(el, 'ArrowDown');await sleep(80);return;
    }
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await sleep(80);
    // Did anything actually open? "Some menu is visible" is not the same
    // question — an already-open menu elsewhere would answer yes, and the
    // extra click would toggle this widget shut instead of opening it.
    if (!openMenus(doc).some((list) => !before.has(list))) el.click();
  }

  /**
   * The listbox belonging to *this* widget.
   *
   * Falling back to the first listbox in the document is what made Workday's
   * Country and State fields both report the phone-code widget's options: the
   * popups render in a portal at the end of <body>, so "the first one" is
   * whichever opened earliest and never closed. Options attributed to the
   * wrong field are worse than none — the value chosen comes from another
   * question's list.
   *
   * The widget's own wiring is authoritative when present; otherwise prefer a
   * listbox that is actually connected to this element, and only then a lone
   * open one.
   */
  function currentListbox(el) {
    const doc = el.ownerDocument;
    const owned = el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || el.closest(".pcty-input-select-full-container")?.getAttribute("aria-owns");
    if (owned) {
      const byId = doc.getElementById(owned);
      if (byId && !isSelectionList(byId)) return byId;
    }
    const reactSelect = el.id && doc.getElementById(`react-select-${el.id}-listbox`);
    if (reactSelect) return reactSelect;

    const open = openMenus(doc);
    if (!open.length) return null;
    // A listbox rendered inside the widget's own container belongs to it.
    const near = open.find((list) => el.parentElement?.contains(list) || list.contains(el));
    if (near) return near;
    // Otherwise only trust it when it is unambiguous.
    return open.length === 1 ? open[0] : null;
  }

  /**
   * Close a widget's menu, and mean it.
   *
   * Escape alone is not enough: Workday's search box ignores it, so the menu
   * stays open with a half-typed query in it. An open menu is not cosmetic —
   * it overlays the page, and the next scrape of the form came back with three
   * fields missing because the sections behind it were no longer reachable.
   *
   * So: clear any leftover query, ask nicely, then take focus away, which is
   * what actually dismisses these widgets.
   */
  function closeListbox(el) {
    // Deliberately does NOT clear a leftover search query. Assigning "" fires
    // an input event, and a multiselect reads that as "the search was
    // emptied", discarding the selection just made: the field verified, then
    // reverted a moment later. A stray query is cosmetic; a lost answer is not.
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    el.blur();

    const doc = el.ownerDocument;
    const stillOpen = () => openMenus(doc).length > 0;
    if (!stillOpen()) return;
    doc.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    doc.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    doc.body.click();
  }

  /**
   * The text a combobox currently displays as its selection.
   *
   * The <input> is empty even when a value is chosen — react-select renders the
   * selection into a sibling node — so the input's value cannot be used to tell
   * whether a fill worked.
   */
  /** A dropdown rendered as a button (Workday) rather than a form control. */
  const isPopupButton = (el) =>
    el.tagName === "BUTTON" || (el.getAttribute("role") === "combobox" && el.tagName !== "INPUT");

  /**
   * A listbox showing what is already chosen rather than what can be chosen.
   *
   * Multiselects mark their selected-pill area `role="listbox"` as well, so it
   * has to be told apart from the menu — the filler was committing its choice
   * against the selection display and reporting failure on a field it had not
   * actually touched.
   */
  const SELECTION_LIST = '[data-automation-id*="selected" i], [class*="selectedItem"]';
  const isSelectionList = (list) => list.matches(SELECTION_LIST) || Boolean(list.closest(SELECTION_LIST));

  /** Menus currently offering options — selection displays excluded. */
  const openMenus = (doc) =>
    Array.from(doc.querySelectorAll('[role="listbox"]:not([hidden]), .react-select__menu:not([hidden]), .pcty-input-select__menu-list')).filter(
      (list) => !isSelectionList(list) && list.querySelector('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]')
    );

  function readComboboxValue(el) {
    // A button holds its selection as its own text, and shows a placeholder
    // when nothing is chosen — which must not read back as a value, or a
    // failed fill verifies as a success.
    if (isPopupButton(el)) {
      const shown = (el.textContent || "").trim();
      return /^(select one|select\.{0,3}|choose\b|--)$/i.test(shown) ? "" : shown;
    }

    return displayedSelection(el) || el.value || "";
  }

  /**
   * The selection a widget renders *beside* its input, if any.
   *
   * Distinct from readComboboxValue, which falls back to the input's own value:
   * only this tells you whether a separate element holds the answer. Clearing a
   * leftover search query is safe when it does and destroys the answer when it
   * does not — a plain text input reads its own value back, so a fallback here
   * would have `closeListbox` wipe every field it touched.
   */
  /** Whether this widget renders its selection somewhere other than the input. */
  function hasSelectionArea(el) {
    if (isPopupButton(el)) return false;
    for (let node = el.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      if (node.querySelector(SELECTION_LIST)) return true;
    }
    return false;
  }

  function displayedSelection(el) {
    if (isPopupButton(el)) return "";
    // Ant Design puts the answer beside its search span. Only a single
    // committed item inside this input's own single-select may prove a fill.
    const ant = el.closest('.ant-select-single');
    if (ant) {
      const selector = el.closest('.ant-select-selector');
      if (!selector || selector.closest('.ant-select-single') !== ant ||
          selector.querySelectorAll('input[role="combobox"]').length !== 1) return "";
      const items = [...selector.querySelectorAll('.ant-select-selection-item')]
        .filter(item => item.closest('.ant-select-selector') === selector &&
          item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
      return items.length === 1 ? clean(items[0].textContent) : "";
    }
    // Scope strictly to this widget's own container. An unbounded walk up the
    // tree finds a NEIGHBOURING field's selection — a text input two levels
    // below a phone widget reads back as that widget's "+1" — which would let
    // verification pass on a value belonging to a different question.
    const scope =
      el.closest(".pcty-input-select-full-container") ||
      el.closest('[class*="value-container"]') ||
      el.closest("[data-uxi-widget-type]") ||
      el.closest('[data-automation-id*="Container" i]') ||
      el.closest('[class*="control"]') ||
      el.parentElement;
    // A multiselect keeps its chosen values in their own listbox beside the
    // search box (Workday: `selectedItemList`), which is the only place the
    // answer exists — the input itself stays empty. Same-widget only: the
    // shared ancestor is walked from the input, never the whole document.
    for (let node = el.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const chosen = node.querySelector(SELECTION_LIST);
      if (!chosen) continue;
      const texts = [
        ...new Set(
          Array.from(chosen.querySelectorAll('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title], [class*="selected"]'))
            .map((n) => n.textContent.trim())
            .filter(Boolean)
        ),
      ];
      // Pills are often rendered twice (a visible one and a screen-reader
      // copy), so identical entries are one selection, not two.
      if (texts.length) return texts.join(", ");
      const own = chosen.textContent.trim();
      if (own) return own;
    }

    if (scope && scope.querySelectorAll("input, select, textarea").length <= 2) {
      // Class-based names cover react-select; the data-automation ones cover
      // Workday, whose classes are hashed and carry no meaning at all.
      const shown = scope.querySelector(
        '[class*="single-value"], [class*="singleValue"], [class*="multi-value"], ' +
          '[class*="selectedItem"], [data-automation-id*="selectedItem" i]'
      );
      if (shown && shown.textContent.trim()) return shown.textContent.trim();
    }
    return "";
  }

  /** The nearest ancestor that actually scrolls, or the list itself. */
  function scrollBoxOf(list) {
    // Virtualized selectors can put the scrolling viewport inside the
    // listbox. Use it only when one scrollable descendant owns the options.
    const inner = [...list.querySelectorAll('*')].filter(node =>
      node.querySelector('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]') &&
      /^(auto|scroll)$/.test(getComputedStyle(node).overflowY) &&
      node.scrollHeight > node.clientHeight + 4);
    if (inner.length === 1) return inner[0];
    if (inner.length > 1) return null;
    for (let n = list; n && n !== list.ownerDocument.body; n = n.parentElement) {
      if (/^(auto|scroll)$/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    }
    return null;
  }

  /**
   * Find an option, scrolling a virtualised menu until it appears.
   *
   * Workday renders long lists through react-virtualized: of 250 countries,
   * about thirteen exist in the DOM at any moment, always starting from the
   * top. Typing does not filter this widget — neither a synthetic `input`
   * event nor real keystrokes changed it — so the only way to reach "United
   * States of America" is the way a person does: scroll until it is on screen.
   *
   * Steps overlap slightly so no row slips between two renders, and the search
   * is bounded — a value that is genuinely not on the list must end as a
   * reported failure, not an endless scroll.
   */
  /**
   * How well an option answers a value. Higher is better; 0 is not an answer.
   *
   * A hint is a word from the profile that is not part of the value — the
   * campus's town beside its university's name — and it only ever breaks a tie
   * between options that already matched on their own.
   */
  function rankOption(node, value, hints) {
    const text = norm(node.textContent);
    const want = norm(value);
    if (!text || !want) return 0;
    if (text === want) return 4;
    const hinted = hints.some((h) => {
      const hint = norm(h);
      return hint && !want.includes(hint) && text.includes(hint);
    });
    if (text.startsWith(want)) return hinted ? 3 : 2;
    if (text.includes(want)) return hinted ? 1.5 : 1;
    return 0;
  }

  /**
   * The option a value names, looked for through the whole list.
   *
   * Ranked rather than first-hit, and ranked across the *whole* scroll rather
   * than across whatever happened to be rendered when the search began. Both
   * halves of that matter, and each was a wrong answer on a real application.
   *
   * Example ATS's school list has no plain "Example State University" — it has
   * East Campus, Exampletown, North Campus, and a "Example Community College Exampleland State
   * University" that merely contains the name. First-hit answered whichever
   * the widget drew first. Ranking fixed that until the list rendered its rows
   * progressively: the first frame held only the first option, so a search that
   * settled on the best candidate it had at the start settled on that one.
   * So the whole list is walked before anything is chosen, unless an exact
   * match turns up, which nothing can beat.
   *
   * A tie at the top is a refusal, as everywhere else: two options equally
   * entitled to the answer means the answer is not knowable from the profile,
   * and the field is better left blank and flagged than filled and wrong.
   */
  async function findOption(list, value, hints = []) {
    const rendered = () => Array.from(list.querySelectorAll('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]'));
    if (rendered().filter(n => norm(n.textContent) === norm(value)).length > 1) return null;
    const exact = exactOption(rendered(), value);
    if (exact) return exact;

    const box = scrollBoxOf(list);
    if (!box) return matchOption(rendered(), value, hints);

    let best = null;
    let bestRank = 0;
    let bestText = "";
    let tied = false;
    let ambiguousExact = false;
    const consider = (nodes) => {
      if (nodes.filter(n => norm(n.textContent) === norm(value)).length > 1)
        ambiguousExact = true;
      for (const node of nodes) {
        const rank = rankOption(node, value, hints);
        if (!rank) continue;
        const text = norm(node.textContent);
        if (rank > bestRank) {
          bestRank = rank;
          best = node;
          bestText = text;
          tied = false;
        } else if (rank === bestRank && text !== bestText) {
          tied = true;
        }
      }
    };

    consider(rendered());
    if (bestRank < 4) {
      const step = Math.max(120, box.clientHeight - 40);
      box.scrollTop = 0;
      for (let i = 0; i < 80; i++) {
        await sleep(50);
        consider(rendered());
        if (bestRank === 4) break;
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) break;
        box.scrollTop += step;
      }
    }

    if (ambiguousExact || (tied && bestRank < 4)) return null;
    // A virtualised list recycles its rows, so a node noted earlier may have
    // been detached by now; a detached node cannot be clicked.
    return best && best.isConnected ? best : null;
  }

  /**
   * Choose `value` from an open menu, following it down if it is a category.
   *
   * Workday's "How Did You Hear About Us" is a two-level picker: the first
   * menu offers "Job Board", "Social Media", "Website", and clicking one opens
   * its contents rather than answering the question. A single click therefore
   * looked like a failed fill — the menu simply stayed open.
   *
   * Deeper levels match strictly (exact, or a clean prefix). Loose matching is
   * fine for picking a category out of six; it is not fine for picking one
   * unfamiliar entry out of a sub-list nobody enumerated, where a near-miss
   * becomes a confident wrong answer to "how did you hear about us".
   */
  /**
   * The element inside an option that actually listens for the click.
   *
   * Workday's menu rows are a `role="option"` wrapper around a
   * `data-automation-id="promptLeafNode"` that carries the handler, so a click
   * on the row itself does nothing at all — the menu just sits there, which
   * reads as "this widget cannot be filled". Walking down to the innermost
   * element that still holds the whole label finds the real target without
   * knowing anything about Workday.
   */
  function deepestClickable(node) {
    let current = node;
    for (let depth = 0; depth < 6; depth++) {
      const text = current.textContent.trim();
      const child = Array.from(current.children).find((c) => c.textContent.trim() === text);
      if (!child) break;
      current = child;
    }
    return current;
  }

  function clickThrough(node) {
    // A menu row's handler may sit on its checkbox rather than on the text —
    // the two are siblings, so walking down the text branch alone misses it.
    const control = node.querySelector(
      '[data-automation-checked], input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]'
    );
    // A single click bubbles through ancestors. Clicking each ancestor again
    // can toggle a Workday checkbox back off after it was selected.
    const target=control || node.querySelector('[data-automation-id="promptLeafNode"]') || deepestClickable(node);
    for (const type of ["mousedown", "mouseup", "click"])
      target.dispatchEvent(new MouseEvent(type, {bubbles:true,cancelable:true}));
  }

  async function commitOption(el, value, { levels = 3, hints = [] } = {}) {
    let guessed = false;
    const texts = (list) =>
      Array.from(list.querySelectorAll('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]')).map((n) => norm(n.textContent)).join("|");

    for (let level = 0; level < levels; level++) {
      const list = currentListbox(el);
      if (!list) return false;
      const before = texts(list);

      const nodes = Array.from(list.querySelectorAll('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]'));
      let target =
        level === 0
          ? await findOption(list, value, hints)
          : nodes.find(
              (n) => norm(n.textContent) === norm(value) || norm(n.textContent).startsWith(norm(value))
            ) || matchOption(nodes, value, hints);

      if (!target && level > 0 && nodes.length) {
        // Inside a category the entries are the employer's own: "Website"
        // opens "EXAMPLE.COM", "Udacity", "AI Residency Program". No profile
        // can name those in advance, and leaving the field empty blocks the
        // application over a marketing question. So take the first and say so
        // — the field is marked for review rather than passed off as known.
        target = nodes[0];
        guessed = true;
      }
      if (!target) return false;

      target.scrollIntoView({ block: "nearest" });
      clickThrough(target);
      await sleep(300);

      if (readComboboxValue(el)) {
        // Escape can be read as "cancel", undoing a choice that was just
        // ticked, so a committed multiselect is dismissed by taking focus
        // away rather than by cancelling.
        el.blur();
        return guessed ? "guessed" : true;
      }

      // Nothing committed. If the menu changed, that click opened a submenu
      // and there is another level to answer; if it did not, the widget simply
      // refused, and clicking again would only repeat it.
      const after = currentListbox(el);
      if (!after || texts(after) === before) return false;
    }
    return false;
  }

  /**
   * Wait for a menu to appear, and then for it to stop growing.
   *
   * The second half is what matters. These lists render progressively, so the
   * first frame after typing can hold one row out of four — and it is not
   * necessarily the row wanted. Typing "Example State University" into a school
   * list draws "Example Community College Example State University" first, because G
   * sorts before M; matching against that frame answers with a college the
   * candidate did not attend, while the three Exampleland State campuses are still
   * a paint away. Two consecutive samples of the same length is the cheapest
   * signal that the filter has finished.
   */
  // A filtered menu holding at least this many rows has finished rendering;
  // below it, the list may still be filling in.
  const SETTLED_ENOUGH = 8;

  async function waitForOptions(el, timeoutMs = 1400) {
    const deadline = Date.now() + timeoutMs;
    const read = () => {
      const list = currentListbox(el);
      return list ? Array.from(list.querySelectorAll('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]')) : [];
    };

    let nodes = [];
    while (Date.now() < deadline) {
      nodes = read();
      if (nodes.length) break;
      await sleep(60);
    }
    if (!nodes.length) return [];

    // Only wait on a menu that looks mid-render. A widget that draws its whole
    // filtered list in one frame comes back with a handful of rows already,
    // and making every combobox on every form pay a settling delay for the one
    // that renders progressively is how a fill goes from seconds to minutes.
    let previous = -1;
    for (let i = 0; i < 6 && nodes.length < SETTLED_ENOUGH && nodes.length !== previous; i += 1) {
      previous = nodes.length;
      await sleep(90);
      const next = read();
      if (next.length) nodes = next;
    }
    return nodes;
  }

  function pressKey(el, key) {
    for (const type of ["keydown", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
    }
  }

  /**
   * Pick a value from a combobox, then confirm it took.
   *
   * Clicking a rendered option does not work on react-select: the menu is
   * portalled and its handlers ignore synthetic mouse events, so the click
   * appears to succeed while nothing is selected. Keyboard interaction goes
   * through the component's own onKeyDown and does work, so the primary path is
   * type-to-filter followed by Enter. Clicking is kept only as a fallback for
   * non-react widgets.
   *
   * A type-to-search widget (`asyncSearch`) has no options until a query is
   * typed, so its first result is accepted — which is why those fields are
   * always flagged for review.
   */
  /**
   * A button-based dropdown: click to open, click the option.
   *
   * There is no text input to type into, so the progressive-query approach used
   * for react-select does not apply — the whole option list appears at once and
   * is chosen from directly.
   */
  async function fillPopupButton(el, value) {
    const doc = el.ownerDocument;
    const openListboxes = () => openMenus(doc);
    // Whichever popup this click opens is this widget's, regardless of where
    // in the document it renders or what else is already showing.
    const already = new Set(openListboxes());
    el.click();

    let list = null;
    for (let i = 0; i < 40 && !list; i++) {
      await sleep(50);
      list = currentListbox(el) || openListboxes().find((candidate) => !already.has(candidate));
    }
    const ok = list ? await commitOption(el, value) : false;
    if (!ok) closeListbox(el);
    return ok;
  }

  // These searchable selectors render the committed selection in the input
  // itself. A typed query is not proof: reopen and inspect aria-selected first.
  const confirmedInputSelections = new WeakMap();
  const confirmedInputReplacements = new WeakMap();
  const confirmedCompositePhones = new WeakMap();
  function phonePairFor(el) {
    const isPhone=el.matches('input[data-input="phone_number"]');
    if (!isPhone && !el.closest('[data-testid="phone_number-code"]')) return null;
    for (let scope=el.parentElement; scope && !scope.matches('form,body,html'); scope=scope.parentElement) {
      const phones=scope.querySelectorAll('input[data-input="phone_number"]');
      if (!phones.length) continue;
      const countries=scope.querySelectorAll('[data-testid="phone_number-code"] input[role="combobox"]');
      if (isPhone && phones.length===1 && phones[0]===el && !countries.length) continue;
      return phones.length===1 && countries.length===1 && (isPhone?phones[0]===el:countries[0]===el)
        ? {scope,phone:phones[0],country:countries[0]} : null;
    }
    return null;
  }
  function confirmedLiveInput(el) {
    const replacement=confirmedInputReplacements.get(el);
    return replacement?.isConnected ? replacement : liveWorkdayInput(el);
  }
  const inputSelectionWidget = el => el.matches('input[data-input="select-search-input"]') &&
    Boolean(el.closest('[data-testid="select-controller"]'));
  async function fillInputSelection(el, value) {
    const original=el, pair=phonePairFor(el);
    confirmedInputSelections.delete(el);
    confirmedInputReplacements.delete(el);
    // Some input-rendered selectors virtualize the list without filtering it.
    // Reuse bounded scrolling, but keep this path restricted to exact labels.
    const locateExact = async nodes => {
      if (nodes.filter(n => norm(n.textContent) === norm(value)).length > 1) return null;
      const direct = exactOption(nodes, value);
      if (direct) return direct;
      const list = currentListbox(el);
      const found = list && await findOption(list, value);
      return found && norm(found.textContent) === norm(value) ? found : null;
    };
    try {
      el.click();
      let nodes = await waitForOptions(el, 1400);
      let target = await locateExact(nodes);
      if (!target) {
        setNativeValue(el, value);
        await sleep(200);
        nodes = await waitForOptions(el, 1400);
        target = await locateExact(nodes);
      }
      if (!target || target.getAttribute('aria-disabled') === 'true') return false;
      for (const type of ['mousedown', 'mouseup', 'click'])
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      await sleep(150);
      if (!el.isConnected) {
        if (!pair?.scope.isConnected || !pair.phone.isConnected ||
            pair.scope.querySelectorAll('input[data-input="phone_number"]').length!==1 ||
            pair.scope.querySelector('input[data-input="phone_number"]')!==pair.phone) return false;
        const candidates=pair.scope.querySelectorAll('[data-testid="phone_number-code"] input[data-input="select-search-input"][role="combobox"]');
        if (candidates.length!==1 || !inputSelectionWidget(candidates[0]) ||
            ns.labelFor(candidates[0])!==ns.labelFor(original)) return false;
        el=candidates[0];
      }
      closeListbox(el);
      el.click();
      nodes = await waitForOptions(el, 1400);
      const selected = await locateExact(nodes);
      if (!selected || selected.getAttribute('aria-selected') !== 'true') return false;
      closeListbox(el);
      await sleep(150);
      if (!el.isConnected || looksRejected(el) || !el.value) return false;
      confirmedInputSelections.set(el, { want: norm(value), shown: el.value });
      if (el!==original) confirmedInputReplacements.set(original,el);
      return true;
    } finally {
      closeListbox(el);
    }
  }

  const confirmedLocations = new WeakMap();
  const locationSuggestionWidget = el => el.matches('input[aria-autocomplete="list"]') &&
    Boolean(el.closest('[data-testid="location"]'));
  async function fillLocationSuggestion(el, value) {
    confirmedLocations.delete(el);
    try {
      el.focus();
      setNativeValue(el, value);
      const nodes = await waitForOptions(el, 3500);
      // Require the saved city AND region. A first-result fallback can choose
      // a similarly named town in another state, which is worse than review.
      const parts = String(value).split(',').map(norm).filter(Boolean);
      if (parts.length < 2) return false;
      const matches = nodes.filter(node => {
        const offered = clean(node.textContent).split(',').map(norm);
        return parts.every((part, index) => part === offered[index]);
      });
      if (matches.length !== 1) return false;
      const target = matches[0], expected = clean(target.textContent);
      if (target.getAttribute('aria-disabled') === 'true') return false;
      for (const type of ['mousedown', 'mouseup', 'click'])
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      await sleep(250);
      // In this widget committing removes the owned suggestion menu and
      // replaces the query with the full place label. Check BEFORE blurring.
      const owns = el.getAttribute('aria-controls');
      if (!el.isConnected || looksRejected(el) || norm(el.value) !== norm(expected) ||
          (owns && el.ownerDocument.getElementById(owns))) return false;
      confirmedLocations.set(el, { want: norm(value), shown: el.value });
      return true;
    } finally { closeListbox(el); }
  }

  // Skill names retain punctuation: C, C++ and C# are different skills.
  const skillName=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
  function selectedSkills(el) {
    const scope=el.closest('[data-automation-id^="formField"], [data-automation-id="skills"]') || el.parentElement;
    const list=scope?.querySelector('[data-automation-id="selectedItemList"]');
    return Array.from(list?.querySelectorAll('[data-automation-id="selectedItem"], [role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]')||[]).map(node=>{
      const copy=node.cloneNode(true);copy.querySelectorAll('button,[aria-hidden="true"]').forEach(n=>n.remove());
      return skillName(copy.textContent);
    });
  }
  async function workdaySelect(el,value) {
    const result=await chrome.runtime.sendMessage({type:'workdaySelect',payload:{id:el.id,value}});
    if(result?.error)throw new Error(result.error);
    return result;
  }
  const hasWorkdayBridge=el=>el.matches('input[data-uxi-widget-type="selectinput"]') && Boolean(globalThis.chrome?.runtime?.sendMessage);
  function liveWorkdayInput(el) {
    if(el.isConnected || !el.id || !el.matches('input[data-uxi-widget-type="selectinput"]'))return el;
    const matches=[...document.querySelectorAll('[id]')].filter(n=>n.id===el.id);
    const live=matches.length===1?matches[0]:null;
    const field=el.closest('[data-automation-id^="formField"]')?.getAttribute('data-automation-id');
    return live?.matches('input[data-uxi-widget-type="selectinput"]') && field &&
      live.closest('[data-automation-id^="formField"]')?.getAttribute('data-automation-id')===field ? live : el;
  }
  async function fillSkills(el,values) {
    if(!Array.isArray(values)||!values.length)return false;
    values=values.slice(0,5);
    try {
      for(const [index,value] of values.entries()) {
        el=liveWorkdayInput(el);
        if(selectedSkills(el).includes(skillName(value)))continue;
        ns.onProgress?.(`Searching for skill ${index+1} of ${values.length}: ${value}`);
        if(hasWorkdayBridge(el)) {
          const result=await workdaySelect(el,value);
          if(!result?.ok){ns.onProgress?.(`${value}: ${result?.reason||'selection failed'}`);break;}
          continue;
        }
        await openListbox(el);setNativeValue(el,value);
        let nodes=[],matches=[];
        const deadline=Date.now()+5000;
        // Keep waiting through empty/loading/partial results; do not replace
        // this query with the next skill before its exact suggestion arrives.
        while(Date.now()<deadline) {
          const list=currentListbox(el);
          nodes=list?[...list.querySelectorAll('[role="option"], li, .react-select__menu .react-select__option, .pcty-input-select__menu-list [id*="-select-row-"][title]')]:[];
          matches=nodes.filter(n=>skillName(n.textContent)===skillName(value) && n.getAttribute('aria-disabled')!=='true');
          if(matches.length===1)break;
          await sleep(100);
        }
        if(matches.length!==1)break;
        ns.onProgress?.(`Selecting skill ${index+1} of ${values.length}: ${value}`);
        clickThrough(matches[0]);
        let committed=Date.now()+1500;
        while(Date.now()<committed&&!selectedSkills(el).includes(skillName(value)))await sleep(100);
        if(selectedSkills(el).includes(skillName(value)))continue;
        // Keyboard fallback only targets the exact live suggestion. No free
        // text Enter: an absent suggestion is a failed skill, not a new token.
        if(!matches[0].isConnected)break;
        const preventSubmit=event=>{event.preventDefault();event.stopImmediatePropagation();};
        const form=el.closest('form');form?.addEventListener('submit',preventSubmit,true);
        try {
          el.focus();
          const active=nodes.findIndex(n=>n.id && n.id===el.getAttribute('aria-activedescendant'));
          const target=nodes.indexOf(matches[0]);
          if(active!==target) {
            const direction=active>target?'ArrowUp':'ArrowDown';
            for(let i=0;i<Math.abs(target-active);i++)pressKey(el,direction);
          }
          for(const type of ['keydown','keypress','keyup'])el.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
          committed=Date.now()+1500;
          while(Date.now()<committed&&!selectedSkills(el).includes(skillName(value)))await sleep(100);
        } finally {form?.removeEventListener('submit',preventSubmit,true);}
        if(!selectedSkills(el).includes(skillName(value)))break;
      }

      el=liveWorkdayInput(el);
      return values.every(v=>selectedSkills(el).includes(skillName(v)));
    } finally {el=liveWorkdayInput(el);if(!values.every(v=>selectedSkills(el).includes(skillName(v))))setNativeValue(el,'');closeListbox(el);}
  }

  function antSelectionMatches(el, value) {
    const exact = text => clean(text).normalize('NFC').toLowerCase();
    const shown = displayedSelection(el);
    if (!shown) return false;
    if (exact(shown) === exact(value)) return true;
    // A dialing selector may shorten a country to its flag and calling code.
    // Require the complete option's selected state in this input's owned list
    // as well as the exact flag/code. A shared +1 alone proves no country.
    const abbreviated = clean(value).match(/^([\u{1F1E6}-\u{1F1FF}]{2}\s+\+\d{1,3})\s+\S/u);
    if (!abbreviated || exact(shown) !== exact(abbreviated[1])) return false;
    const owned = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (!owned) return false;
    const list = el.ownerDocument.getElementById(owned);
    const selected = [...(list?.querySelectorAll('[role="option"][aria-selected="true"]') || [])];
    return selected.length === 1 && exact(selected[0].textContent) === exact(value);
  }

  async function fillAntSingle(el, value) {
    const exact = text => clean(text).normalize('NFC').toLowerCase();
    try {
      await openListbox(el);
      // Search by country name; the flag/code are display decoration and may
      // not participate in filtering. Still select only the full exact option.
      const query = String(value).replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s+\+\d{1,3}\s+/u, '');
      if (!el.readOnly) setNativeValue(el, query);
      const nodes = await waitForOptions(el);
      const matches = nodes.filter(node => exact(node.textContent) === exact(value));
      if (matches.length !== 1 || matches[0].getAttribute('aria-disabled') === 'true' ||
          matches[0].classList.contains('ant-select-item-option-disabled')) return false;
      clickThrough(matches[0]);
      await sleep(150);
      closeListbox(el);
      await sleep(150);
      return el.isConnected && !looksRejected(el) && antSelectionMatches(el, value);
    } finally { closeListbox(el); }
  }

  async function fillPaylocitySelect(el, value) {
    try {
      await openListbox(el);
      setNativeValue(el, value);
      const options=await waitForOptions(el,2500);
      const matches=options.filter(n=>norm(n.textContent)===norm(value));
      if(matches.length!==1 || matches[0].getAttribute('aria-disabled')==='true')return false;
      clickThrough(matches[0]);
      await sleep(180);
      closeListbox(el);
      return el.isConnected && !looksRejected(el) && norm(displayedSelection(el))===norm(value);
    } finally {closeListbox(el);}
  }

  async function fillCombobox(el, value, { asyncSearch = false, hints = [] } = {}) {
    if (!isPopupButton(el) && norm(displayedSelection(el))===norm(value))return true;
    if (el.closest('.pcty-input-select-full-container')) return fillPaylocitySelect(el,value);
    if (el.closest('.ant-select-single')) return fillAntSingle(el, value);
    if(hasWorkdayBridge(el))return Boolean((await workdaySelect(el,String(value)))?.ok);
    if (locationSuggestionWidget(el)) return fillLocationSuggestion(el, value);
    if (inputSelectionWidget(el)) return fillInputSelection(el, value);
    if (isPopupButton(el)) return fillPopupButton(el, value);

    // Progressively shorter queries: a full option label ("United States +1")
    // can filter to nothing when the widget matches on a shorter substring.
    const words = String(value).split(/\s+/);
    const queries = [String(value)];
    if (words.length > 2) queries.push(words.slice(0, 2).join(" "));
    if (words.length > 1) queries.push(words[0]);

    for (const query of queries) {
      await openListbox(el);
      setNativeValue(el, query);
      await sleep(asyncSearch ? 700 : 120);

      let nodes = await waitForOptions(el, asyncSearch ? 2500 : 1400);
      if (!nodes.length) continue;
      if (nodes.filter(n => norm(n.textContent) === norm(value)).length > 1) {
        closeListbox(el);
        return false;
      }

      const list = currentListbox(el);
      const scrolls = Boolean(list && scrollBoxOf(list));

      // On a scrolling list the rendered rows are a window onto the matches,
      // not the whole of them, so a substring hit inside that window is not
      // evidence that the exact entry is missing — only that it has not been
      // scrolled to. Typing "Example State University" into Greenhouse's
      // school list renders "Example Community College Example State University"
      // first; taking it answers a different school, on a form an employer
      // may check against a transcript. So an inexact hit sends the search
      // down the scrolling path first, and is settled for only if that finds
      // nothing better.
      if (!exactOption(nodes, value) && scrolls && list) {
        const scrolled = await commitOption(el, value, { hints });
        if (scrolled) {
          closeListbox(el);
          return scrolled;
        }
        // The scroll search closed the menu and left `nodes` detached. Retype
        // so the keyboard path below has live rows to walk.
        await openListbox(el);
        setNativeValue(el, query);
        await sleep(asyncSearch ? 700 : 120);
        nodes = await waitForOptions(el, asyncSearch ? 2500 : 1400);
        if (!nodes.length) continue;
      }

      const target =
        matchOption(nodes, value, hints) ||
        // Taking the first entry is a reasonable bet on a list the widget
        // filtered down to matches. On a virtualised list it is not filtered,
        // and the first entry is simply whatever sorts first — "Afghanistan"
        // for a candidate in the United States.
        (asyncSearch && !scrolls ? nodes[0] : null);

      if (target) {
        // Walk the focus ring to the intended option, then commit with Enter.
        const index = nodes.indexOf(target);
        for (let i = 0; i < index; i++) pressKey(el, "ArrowDown");
        pressKey(el, "Enter");
        await sleep(140);
      } else if (list) {
        const committed = await commitOption(el, value, { hints });
        if (committed) return committed;
        continue;
      } else {
        continue;
      }

      // Closing on success matters as much as opening did. Workday's multi-
      // select keeps its menu open after Enter, and an open menu covers the
      // rest of the form — later fields cannot be filled, "Save and Continue"
      // cannot be reached, and the widget stays in an editing state the form
      // renders as a validation error on a field that is in fact answered.
      if (readComboboxValue(el)) {
        closeListbox(el);
        return true;
      }

      // Fallback for widgets that are not react-select. commitOption handles
      // the two cases the keyboard cannot: a menu too long to be rendered in
      // full, and one whose entries are categories that open a submenu.
      //
      // Ordered after the keyboard deliberately — react-select ignores clicks
      // on its options but still closes on one, so clicking first would leave
      // nothing for the keyboard to commit against.
      const committed = list ? await commitOption(el, value, { hints }) : false;
      if (committed) return committed;
      target.scrollIntoView({ block: "nearest" });
      for (const type of ["mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
      await sleep(120);
      if (readComboboxValue(el)) {
        closeListbox(el);
        return true;
      }
    }

    closeListbox(el);
    return false;
  }

  /**
   * Write a date across the separate inputs a widget splits it into.
   *
   * Each segment announces which part it wants ("Year", "Month", "Day"), so
   * the value is decomposed rather than typed at the first box — filling a
   * year into a month segment is a validation error, and filling only the
   * first leaves the field incomplete but looking answered.
   *
   * A widget asking only for a year accepts a bare year, which is what a
   * profile records for education; a full date needs all three parts, and
   * anything it cannot supply is left for the user rather than guessed.
   */
  function fillDate(els, field, value) {
    const text = String(value);
    const year = (text.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
    const numbers = text.match(/\d+/g) || [];
    const parsed = Number.isNaN(Date.parse(text)) ? null : new Date(text);
    const pad = (n) => String(n).padStart(2, "0");

    const partFor = (el, index) => {
      const name = (el.getAttribute("aria-label") || field.parts?.[index] || "").toLowerCase();
      if (/year/.test(name)) return year;
      if (/month/.test(name)) return parsed ? pad(parsed.getMonth() + 1) : null;
      if (/day/.test(name)) return parsed ? pad(parsed.getDate()) : null;
      // An unnamed single-box date takes the value as written.
      return els.length === 1 ? text : null;
    };

    // Work out every segment before writing any of them. A half-written date
    // is not a partial success: filling the month and leaving the rest blank
    // leaves the widget holding "08//", which it reports as an invalid date
    // and keeps reporting even after the value is corrected. Nothing written
    // is recoverable; a poisoned field is not.
    const parts = els.map(partFor);
    if (parts.some((part) => part == null)) return false;

    els.forEach((el, index) => {
      el.focus();
      setNativeValue(el, String(parts[index]));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      el.blur();
    });
    return true;
  }

  async function fillCheckbox(el, value) {
    const want = /^(true|yes|1|on)$/i.test(String(value));
    const proxy = ns.choiceProxy?.(el);
    if (el.checked !== want) (proxy || el).click();
    if (proxy) for (let i = 0; i < 10 && (el.checked !== want || proxy.getAttribute('aria-checked') !== String(want)); i++) await sleep(50);
    return true;
  }

  function choiceText(el, field) {
    const label = clean(ns.labelFor(el));
    const question = clean(field?.label);
    return question.length > 15 && label.startsWith(question) && label.length > question.length
      ? label.slice(question.length).trim() : label;
  }

  function choiceTarget(els, value, field) {
    if (!norm(value)) return null;
    const exact =
      els.find((e) => norm(choiceText(e, field)) === norm(value)) ||
      els.find((e) => norm(e.value) === norm(value));
    if (exact) return exact;
    const partial = els.filter(e => norm(choiceText(e, field)).includes(norm(value)));
    return partial.length === 1 ? partial[0] : null;
  }

  function checkboxTargets(els, value, field) {
    const values = Array.isArray(value) ? value : [value];
    if (field.maxSelections && new Set(values.map(norm)).size > field.maxSelections) return null;
    const targets = values.map(item => {
      const matches = els.filter(el => norm(choiceText(el, field)) === norm(item));
      return matches.length === 1 ? matches[0] : null;
    });
    return targets.every(Boolean) ? new Set(targets) : null;
  }
  async function fillCheckboxGroup(els, value, field) {
    const targets = checkboxTargets(els, value, field);
    if (!targets) return false;
    for (const el of els) if (!await fillCheckbox(el, targets.has(el) ? "true" : "false")) return false;
    return true;
  }

  function paycorChoiceConfirmed(els, selected) {
    if(!selected || els.length!==2 || !els.every(el=>el.isConnected))return false;
    const key=selected.id.slice(2),answer=selected.ownerDocument.getElementById(key);
    return answer?.type==='hidden' && answer.value===(selected.id.startsWith('y_')?'true':'false') &&
      selected.classList.contains('isSelected') && els.filter(el=>el.classList.contains('isSelected')).length===1;
  }

  async function fillRadioGroup(els, value, field) {
    const target = choiceTarget(els, value, field);
    if (!target) return false;
    if(field.customChoice==='paycor'){target.click();return paycorChoiceConfirmed(els,target);}
    const visibleProxy = ns.choiceProxy?.(target);
    if (visibleProxy) {
      // One user-facing click. Clicking the hidden input and then its proxy
      // can change native checked state without committing the same state
      // in the framework, or toggle a custom control twice.
      const activationLabel = target.closest("label");
      (activationLabel && visibleProxy.contains(activationLabel) ? activationLabel : visibleProxy).click();
      // Controlled radios can commit on the next render. Read that result
      // before falling back to another click or declaring the answer lost.
      for (let i = 0; i < 10 && (!target.checked || visibleProxy.getAttribute("aria-checked") !== "true"); i++) await sleep(50);
      // Some boolean-option widgets bind only the native input's change
      // event. Fall back only when the proxy did not select it.
      if (!target.checked) target.click();
      return target.checked;
    }

    // Click the label, not the input.
    //
    // The browser ticks a checkbox on `input.click()` whether or not the page
    // is listening, so `checked` goes true even when the application never
    // sees the event — the answer looks set and is silently absent on submit.
    // The label is what a person clicks and what these widgets bind to, so it
    // is the primary path rather than a fallback.
    const doc = target.ownerDocument;
    const proxy =
      ns.choiceProxy?.(target) ||
      (target.id && doc.querySelector(`label[for="${CSS.escape(target.id)}"]`)) || target.closest("label");
    if (proxy) clickThrough(proxy);
    if (target.checked) return true;

    target.click();
    return target.checked;
  }

  /**
   * Attach a File to a file input. The `files` property is read-only, so the
   * only supported route is a synthetic DataTransfer list.
   */
  function fillFile(el, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /** Did the value actually land? Compared loosely — widgets reformat text. */
  /**
   * The page's own verdict on a control.
   *
   * A widget can accept a click, show the chosen text, and still not have
   * committed anything — Workday's "How did you hear about us" did exactly
   * that, reading back as "Website" while the form displayed "is required and
   * must have a value". Reporting that as filled is the worst outcome
   * available: the user is told an empty required field is answered.
   *
   * `aria-invalid` and a rendered error message are both generic, so this
   * costs nothing on forms that behave.
   */
  function looksRejected(el) {
    const visibleError = node => Boolean(node && node.textContent.trim() &&
      !node.closest('[hidden],[aria-hidden="true"]') && node.getClientRects().length &&
      getComputedStyle(node).visibility !== 'hidden');
    if (/(^|\.)paylocity\.com$/.test(location.hostname)) {
      const group=el.closest('.form-group.form-error');
      if(group && [...group.querySelectorAll('.type-footnote.show')].some(visibleError))return true;
    }
    const field = el.closest('[data-automation-id^="formField"], [class*="field"], [role="group"]') || el.parentElement;
    if (el.getAttribute("aria-invalid") === "true") return true;
    const errors = (el.getAttribute('aria-errormessage') || '').split(/\s+/).filter(Boolean);
    if (errors.some(id => visibleError(document.getElementById(id)))) return true;
    if (!field) return false;
    // A form/body wrapper can contain unrelated rejected questions. Only use
    // neighbouring errors inside a field-sized wrapper.
    if (field.matches('form,body,html')) return false;
    return [...field.querySelectorAll('[role="alert"], [data-automation-id*="error" i], [class*="error"]')].some(visibleError);
  }

  function verifyValue(els, field, want) {
    // Detached inputs retain their JS values after the host replaces the
    // form (including an upload-error page). Those are no longer answers
    // on the application and must never count as successful fills.
    if (!els?.length || els.some(el => !el?.isConnected)) return false;
    if (els.some(looksRejected)) return false;
    const el = els[0];
    if (el.matches('input[data-input="phone_number"]') && /^\s*\+/.test(String(want))) {
      const saved=confirmedCompositePhones.get(el), pair=phonePairFor(el);
      const selected=saved && confirmedInputSelections.get(saved.country);
      return Boolean(saved && saved.want===String(want).trim() && pair &&
        pair.scope===saved.pair.scope && pair.country===saved.country &&
        selected?.shown===saved.shown && saved.country.value===saved.shown &&
        !looksRejected(saved.country) && (!el.willValidate || el.validity.valid) && !/[a-z]/i.test(el.value) &&
        el.value.replace(/\D/g,'')===saved.national);
    }
    // Search inputs inside composite widgets may legitimately be empty after
    // selecting an option. Native validity applies to ordinary controls only.
    if (!['combobox', 'date'].includes(field.type) &&
        els.some(node => node.willValidate && !node.validity.valid)) return false;
    if (isFormattedDate(field) && field.dateFormat === "MM/DD/YYYY") {
      const expected = fullDateParts(want), actual = fullDateParts(el.value);
      return Boolean(expected && actual && !looksRejected(el) &&
        expected.year === actual.year && expected.month === actual.month && expected.day === actual.day);
    }
    const textPhone = field.type === 'text' &&
      /^(?:(?:home|mobile|cell|work|contact|primary|secondary)\s+)?(?:phone|telephone)(?:\s+number)?\s*[:*]?$/i.test(clean(field.label));
    if (field.type === 'tel' || textPhone) {
      // Some ATSs render telephone questions as text inputs, then normalize
      // their formatting. Preserve every digit, including country/extension;
      // unrelated text questions still use exact text readback.
      const actual = String(el.value || ''), expected = String(want || '');
      if (looksRejected(el) || /[a-z]/i.test(actual + expected)) return false;
      const digits = expected.replace(/\D/g, '');
      return digits.length >= 7 && actual.replace(/\D/g, '') === digits;
    }
    switch (field.type) {
      case "checkbox":
        return el.checked === /^(true|yes|1|on)$/i.test(String(want)) &&
          (!ns.choiceProxy?.(el) || ns.choiceProxy(el).getAttribute("aria-checked") === String(el.checked));
      case "checkbox-group": {
        const targets = checkboxTargets(els, want, field);
        return Boolean(targets && els.every(el => el.checked === targets.has(el) && !looksRejected(el) &&
          (!ns.choiceProxy?.(el) || ns.choiceProxy(el).getAttribute("aria-checked") === String(el.checked))));
      }
      case "radio":
        {
          const selected = choiceTarget(els, want, field);
          if(field.customChoice==='paycor')return paycorChoiceConfirmed(els,selected);
          return Boolean(selected?.checked) && (!ns.choiceProxy?.(selected) ||
            ns.choiceProxy(selected).getAttribute("aria-checked") === "true");
        }
      case "file":
        return Boolean(want && el.files?.length === 1 &&
          ['name','size','type','lastModified'].every(key => el.files[0][key] === want[key]));
      case "date":
        // Segments can hold the text while the widget's own model stays empty,
        // and the form then reports the field as missing. Its verdict wins.
        if (els.some(looksRejected)) return false;
        return els.every((seg) => String(seg.value || "").trim().length > 0);
      case "combobox": {
        if(field.skillPicker)return !looksRejected(el) && Array.isArray(want) && want.every(v=>selectedSkills(el).includes(skillName(v)));
        if (looksRejected(el)) return false;
        if (locationSuggestionWidget(el)) {
          const confirmed = confirmedLocations.get(el);
          return Boolean(confirmed && confirmed.want === norm(want) && confirmed.shown === el.value);
        }
        if (inputSelectionWidget(el)) {
          const confirmed = confirmedInputSelections.get(el);
          return Boolean(confirmed && confirmed.want === norm(want) && confirmed.shown === el.value);
        }
        // The input inside a combobox is a search box, never the answer: the
        // selection renders elsewhere. Reading its value back therefore proves
        // only that we typed — and typing "Website" into a widget that then
        // discarded it reported a required field as answered while the form
        // said "0 items selected". A button-style dropdown is different: its
        // own label is the selection.
        if (el.closest('.ant-select-single')) {
          return antSelectionMatches(el, want);
        }
        const got = isPopupButton(el)
          ? norm(readComboboxValue(el))
          : norm(displayedSelection(el));
        return Boolean(got) && (got === norm(want) || got.includes(norm(want)) || norm(want).includes(got));
      }
      case "select": {
        const got = norm(el.options[el.selectedIndex]?.textContent);
        return Boolean(got) && (got === norm(want) || got.includes(norm(want)));
      }
      default:
        // Punctuation is data in email addresses, URLs and skills; ASCII-only
        // normalization also collapses different non-Latin names to empty.
        return clean(el.value).normalize('NFC') === clean(want).normalize('NFC');
    }
  }

  const HIGHLIGHT = {
    filled: { color: "#16a34a", style: "solid" },
    review: { color: "#d97706", style: "solid" },
    failed: { color: "#dc2626", style: "dashed" },
  };

  /**
   * Mark the visible control so the user can see what was touched.
   *
   * Two hazards, both learned the hard way on Greenhouse:
   *
   * 1. For a combobox the <input> is a zero-size node inside the widget, so the
   *    outline must go on the bordered control container or it renders
   *    invisibly — on exactly the fields most likely to need a second look.
   * 2. A stylesheet rule loses to the host page. react-select's emotion styles
   *    beat an `!important` rule in our own <style> tag, leaving the control
   *    with its original 1px grey border. An inline declaration marked
   *    important outranks any author stylesheet, so highlighting is applied
   *    directly to the element instead.
   */
  function mark(el, state) {
    let target = el;
    if (el.type === "radio" || el.type === "checkbox") {
      target = el.closest("label, fieldset, div") || el;
    } else {
      const control = el.closest('[class*="control"]');
      // Only trust it if it is a real box, not a layout wrapper.
      if (control && control.getBoundingClientRect().height > 0) target = control;
    }

    paint(target, state);
    applied.push({ target, state });
  }

  /**
   * Marks applied by the current run, so they can be restored after a
   * re-render. Reset at the start of every fill() — otherwise a second run
   * repaints rings for fields it never touched, and the array grows forever.
   */
  let applied = [];

  function paint(target, state) {
    const { color, style } = HIGHLIGHT[state] || HIGHLIGHT.filled;
    target.style.setProperty("outline", `2px ${style} ${color}`, "important");
    target.style.setProperty("outline-offset", "1px", "important");
    target.setAttribute("data-formwork", state);
  }

  /**
   * React owns the `style` property on the nodes it renders, so updating a
   * widget after we paint it wipes the inline highlight — reliably on whichever
   * field was filled last, since it keeps focus. Repainting once the form has
   * settled restores them.
   */
  function repaintMarks() {
    for (const { target, state } of applied) {
      if (target.isConnected) paint(target, state);
    }
  }

  /** Remove every highlight, and forget them so a repaint cannot resurrect them. */
  function clearMarks(root = document) {
    for (const node of root.querySelectorAll("[data-formwork]")) {
      node.style.removeProperty("outline");
      node.style.removeProperty("outline-offset");
      node.removeAttribute("data-formwork");
    }
    applied = [];
  }

  /**
   * Apply validated fills to the page.
   *
   * @param {object} fills    {fieldId: value}
   * @param {object} schema   the scraped schema these ids came from
   * @param {Element[][]} registry field id index -> elements
   * @param {{review?: string[], files?: object, keepExisting?: boolean}} opts
   *   `keepExisting` adds to the current highlights instead of replacing them —
   *   used when a single approved draft is filled into an already-filled form,
   *   which would otherwise clear every ring from the main run.
   * @returns {Promise<{filled: string[], failed: object[]}>}
   */
  async function fill(fills, schema, registry, opts = {}) {
    const byId = Object.fromEntries(schema.fields.map((f, i) => [f.id, { field: f, index: i }]));
    const review = new Set(opts.review || []);
    const files = opts.files || {};
    const hints = opts.hints || {};
    const filled = [];
    const failed = [];
    const originalDates = new Map();
    const attempted = new Set();
    const confirmed = async (els, field, value) => {
      if (!verifyValue(els, field, value)) return false;
      if (field.type !== 'file') return true;
      // A file with the right name/size can still be the wrong document.
      // This confirms local selection only, never server upload acceptance.
      try {
        const actual = els[0].files[0];
        const [a,b] = await Promise.all([actual.arrayBuffer(),value.arrayBuffer()]);
        const bytes = new Uint8Array(b);
        return a.byteLength === b.byteLength && new Uint8Array(a).every((byte,i)=>byte===bytes[i]) &&
          els[0].files[0] === actual && verifyValue(els,field,value);
      } catch { return false; }
    };

    // A fresh run owns the page's highlights; stale rings from a previous run
    // would otherwise survive and be repainted at the end.
    if (!opts.keepExisting) clearMarks();

    // Attachments are keyed by field id but never appear in `fills` — the
    // validator drops file fields on purpose, so iterating `fills` alone would
    // make the whole attachment path unreachable.
    const work = new Map(Object.entries(fills));
    for (const id of Object.keys(files)) if (!work.has(id)) work.set(id, null);

    for (const [id, value] of work) {
      const entry = byId[id];
      if (!entry) {
        failed.push({ id, reason: "field is no longer on the page" });
        continue;
      }
      // The page can rewrite itself between planning and filling — a dropdown
      // opening is enough — leaving the schema describing controls the registry
      // no longer has. That is a field to report, not a crash that abandons
      // every remaining field on the form.
      const els = registry[entry.index];
      if (!els || !els[0]) {
        failed.push({ id, reason: "the page changed and this field could not be found again" });
        continue;
      }
      els[0]=liveWorkdayInput(els[0]);
      let el = els[0];
      const { field } = entry;
      ns.onProgress?.(`Filling ${field.label || "field"} (${[...work.keys()].indexOf(id)+1} of ${work.size})`);
      if (!el.isConnected) {
        failed.push({ id, reason: "the page replaced this field before it could be filled" });
        continue;
      }
      if (isFormattedDate(field)) originalDates.set(id, el.value);
      let ok = false;

      try {
        attempted.add(id);
        switch (field.type) {
          case "select":
            ok = fillSelect(el, value);
            break;
          case "combobox":
            if(field.skillPicker){ok=await fillSkills(el,value);break;}
            ok = await fillCombobox(el, value, {
              asyncSearch: Boolean(field.asyncSearch),
              hints: hints[id] || [],
            });
            // One retry, after letting the page settle.
            //
            // These widgets disturb each other: dismissing one menu takes a
            // click away from it, and the next widget's opening click can land
            // while the page is still reacting. Filling this field on its own
            // always succeeded; filling it alongside another combobox did not,
            // which is the whole of the difference.
            if (!ok && el.isConnected) {
              await sleep(500);
              ok = await fillCombobox(el, value, {
                asyncSearch: Boolean(field.asyncSearch),
                hints: hints[id] || [],
              });
            }
            // Leave the page settled for whatever is filled next.
            await sleep(200);
            break;
          case "date":
            ok = fillDate(els, field, value);
            break;
          case "checkbox":
            ok = await fillCheckbox(el, value);
            break;
          case "checkbox-group":
            ok = await fillCheckboxGroup(els, value, field);
            break;
          case "radio":
            ok = await fillRadioGroup(els, value, field);
            break;
          case "file":
            ok = files[id] ? fillFile(el, files[id]) : false;
            break;
          default:
            ok = isFormattedDate(field) ? await fillFormattedDate(el, field, value) : await fillText(el, value);
        }
      } catch (err) {
        failed.push({ id, reason: String(err.message || err).slice(0, 160) });
        mark(el, "failed");
        continue;
      }

      // Trust the DOM, not the write path. A synthetic event can be accepted by
      // the browser and ignored by the framework on top of it.
      el=els[0]=confirmedLiveInput(el);
      if (ok && !await confirmed(els, field, field.type === 'file' ? files[id] : value)) {
        // A text field that did not keep its value is usually autocomplete
        // backed — retry the way a person would before giving up.
        if (!isFormattedDate(field) && (field.type === "text" || field.type === "search")) {
          ok = (await fillAutocompleteText(el, value)) && verifyValue(els, field, value);
        } else {
          ok = false;
        }
      }

      if (ok === "guessed") review.add(id);
      if (ok) {
        filled.push(id);
        // Highlight the option that was actually chosen. Marking els[0] rings
        // the first radio in the group regardless of the selection, which reads
        // as "formwork picked this" for an answer it did not pick.
        mark(els.find((e) => e.checked) || el, review.has(id) ? "review" : "filled");
      } else {
        if (originalDates.has(id) && el.value !== originalDates.get(id)) { setNativeValue(el, originalDates.get(id)); el.blur(); }
        failed.push({ id, reason: field.skillPicker
          ? `Skills still needing selection: ${value.filter(v=>!selectedSkills(el).includes(skillName(v))).join(", ")}. Existing selections were kept.`
          : field.type === "tel" && el.closest(".iti") && !/^\s*\+/.test(String(value))
          ? "Phone was rejected. Save your phone with its country calling code (starting with +) in your profile, then retry."
          : field.type === "file"
          ? "Attachment could not be confirmed. Check the site’s upload message and attach the document manually if needed."
          : `could not set "${value}"` });
        mark(el, "failed");
      }
    }

    // Let the last-touched widget finish re-rendering, then restore highlights.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await sleep(250);

    // Settle-and-recheck.
    //
    // Verifying immediately after a write only proves the value landed, not
    // that it survived. Widgets revert asynchronously: an autocomplete-backed
    // input clears itself from a blur handler, so the field reads correct for
    // one tick and is empty by the time the user looks. Re-check once the
    // page's own handlers have run, and try to recover anything lost.
    for (const id of [...filled]) {
      const entry = byId[id];
      const els = registry[entry.index];
      els[0]=liveWorkdayInput(els[0]);
      if (els.some(el => !el.isConnected)) {
        filled.splice(filled.indexOf(id), 1);
        failed.push({ id, reason: "the page replaced this field after filling" });
        continue;
      }
      if (await confirmed(els, entry.field, entry.field.type === 'file' ? files[id] : fills[id])) continue;

      let recovered = false;
      if (!isFormattedDate(entry.field) && (entry.field.type === "text" || entry.field.type === "search")) {
        recovered =
          (await fillAutocompleteText(els[0], fills[id])) && verifyValue(els, entry.field, fills[id]);
      } else if (entry.field.type === "combobox") {
        // Widgets clobber each other: Workday's "How did you hear about us"
        // accepts its answer, then loses it the moment the next dropdown on
        // the page is opened — the page itself goes back to reporting "0 items
        // selected". Nothing about the first fill was wrong, so repeating it
        // once everything else has settled is what makes it stick.
        recovered =
          (await fillCombobox(els[0], fills[id], { asyncSearch: Boolean(entry.field.asyncSearch) })) &&
          verifyValue(els, entry.field, fills[id]);
      }
      if (!recovered) {
        if (originalDates.has(id) && els[0].value !== originalDates.get(id)) { setNativeValue(els[0], originalDates.get(id)); els[0].blur(); }
        filled.splice(filled.indexOf(id), 1);
        failed.push({ id, reason: `"${fills[id]}" did not survive — the field discarded it` });
        mark(els[0], "failed");
      }
    }

    repaintMarks();

    const receipts = [...work.keys()].map(id => ({
      id,
      action: byId[id]?.field.type === 'file' ? 'attach' : 'fill',
      state: filled.includes(id) ? 'verified' : attempted.has(id) ? 'unconfirmed' : 'not_attempted',
      verification: byId[id]?.field.type === 'file' ? 'local_file_bytes' : 'settled_control_value',
    }));
    return { filled, failed, receipts };
  }

  ns.fill = fill;
  ns.setNativeValue = setNativeValue;
  ns.fillCombobox = fillCombobox;
  ns.readComboboxValue = readComboboxValue;
  // Exported for the Workday harness's --inspect diagnostics.
  ns.currentListbox = currentListbox;
  // Exported for the suite. Choosing between options that all contain what was
  // typed is where this file has gone wrong before — a different campus, a
  // different college — and those decisions are worth testing directly rather
  // than only through a widget that has to be simulated first.
  ns.matchOption = matchOption;
  ns.exactOption = exactOption;
  ns.rankOption = rankOption;
  ns.findOption = findOption;
  ns.verifyValue = verifyValue;
  ns.clearMarks = clearMarks;
  ns.markField = mark;
})();
