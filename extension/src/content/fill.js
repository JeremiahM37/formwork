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
  function matchOption(nodes, value) {
    const want = norm(value);
    return (
      nodes.find((n) => norm(n.textContent) === want) ||
      nodes.find((n) => norm(n.textContent).startsWith(want)) ||
      nodes.find((n) => norm(n.textContent).includes(want)) ||
      null
    );
  }

  function fillText(el, value) {
    el.focus();
    setNativeValue(el, value);
    el.blur();
    return true;
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
  async function fillAutocompleteText(el, value, { query = value } = {}) {
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
      if (await fillAutocompleteText(el, value, { query: next })) return true;
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
    const owned = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
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
  const isPopupButton = (el) => el.tagName === "BUTTON";

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
    Array.from(doc.querySelectorAll('[role="listbox"]:not([hidden])')).filter(
      (list) => !isSelectionList(list) && list.querySelector('[role="option"], li')
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
    // Scope strictly to this widget's own container. An unbounded walk up the
    // tree finds a NEIGHBOURING field's selection — a text input two levels
    // below a phone widget reads back as that widget's "+1" — which would let
    // verification pass on a value belonging to a different question.
    const scope =
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
          Array.from(chosen.querySelectorAll('[role="option"], li, [class*="selected"]'))
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
    for (let n = list; n && n !== list.ownerDocument.body; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 4) return n;
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
  async function findOption(list, value) {
    const rendered = () => Array.from(list.querySelectorAll('[role="option"], li'));
    const hit = matchOption(rendered(), value);
    if (hit) return hit;

    const box = scrollBoxOf(list);
    if (!box) return null;

    const step = Math.max(120, box.clientHeight - 40);
    box.scrollTop = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(50);
      const found = matchOption(rendered(), value);
      if (found) return found;
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 1) return null;
      box.scrollTop += step;
    }
    return null;
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
    const targets = new Set([control, deepestClickable(node), node].filter(Boolean));
    for (const target of targets) {
      for (const type of ["mousedown", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    }
  }

  async function commitOption(el, value, { levels = 3 } = {}) {
    let guessed = false;
    const texts = (list) =>
      Array.from(list.querySelectorAll('[role="option"], li')).map((n) => norm(n.textContent)).join("|");

    for (let level = 0; level < levels; level++) {
      const list = currentListbox(el);
      if (!list) return false;
      const before = texts(list);

      const nodes = Array.from(list.querySelectorAll('[role="option"], li'));
      let target =
        level === 0
          ? await findOption(list, value)
          : nodes.find(
              (n) => norm(n.textContent) === norm(value) || norm(n.textContent).startsWith(norm(value))
            ) || matchOption(nodes, value);

      if (!target && level > 0 && nodes.length) {
        // Inside a category the entries are the employer's own: "Website"
        // opens "NVIDIA.COM", "Udacity", "AI Residency Program". No profile
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

  async function waitForOptions(el, timeoutMs = 1400) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = currentListbox(el);
      const nodes = list ? Array.from(list.querySelectorAll('[role="option"], li')) : [];
      if (nodes.length) return nodes;
      await sleep(60);
    }
    return [];
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

  async function fillCombobox(el, value, { asyncSearch = false } = {}) {
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

      const nodes = await waitForOptions(el, asyncSearch ? 2500 : 1400);
      if (!nodes.length) continue;

      const list = currentListbox(el);
      const scrolls = Boolean(list && scrollBoxOf(list));
      const target =
        matchOption(nodes, value) ||
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
        const committed = await commitOption(el, value);
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
      const committed = list ? await commitOption(el, value) : false;
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

  function fillCheckbox(el, value) {
    const want = /^(true|yes|1|on)$/i.test(String(value));
    if (el.checked !== want) el.click();
    return true;
  }

  function fillRadioGroup(els, value) {
    const target =
      els.find((e) => norm(ns.labelFor(e)) === norm(value)) ||
      els.find((e) => norm(e.value) === norm(value)) ||
      els.find((e) => norm(ns.labelFor(e)).includes(norm(value)));
    if (!target) return false;

    // Click the label, not the input.
    //
    // The browser ticks a checkbox on `input.click()` whether or not the page
    // is listening, so `checked` goes true even when the application never
    // sees the event — the answer looks set and is silently absent on submit.
    // The label is what a person clicks and what these widgets bind to, so it
    // is the primary path rather than a fallback.
    const doc = target.ownerDocument;
    const proxy =
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
    const field = el.closest('[data-automation-id^="formField"], [class*="field"], [role="group"]') || el.parentElement;
    if (el.getAttribute("aria-invalid") === "true") return true;
    if (!field) return false;
    if (field.querySelector('[aria-invalid="true"]')) return true;
    const alert = field.querySelector('[role="alert"], [data-automation-id*="error" i], [class*="error"]');
    return Boolean(alert && alert.textContent.trim());
  }

  function verifyValue(els, field, want) {
    const el = els[0];
    switch (field.type) {
      case "checkbox":
        return el.checked === /^(true|yes|1|on)$/i.test(String(want));
      case "radio":
      case "checkbox-group":
        return els.some((e) => e.checked);
      case "file":
        return el.files && el.files.length > 0;
      case "date":
        // Segments can hold the text while the widget's own model stays empty,
        // and the form then reports the field as missing. Its verdict wins.
        if (els.some(looksRejected)) return false;
        return els.every((seg) => String(seg.value || "").trim().length > 0);
      case "combobox": {
        if (looksRejected(el)) return false;
        // The input inside a combobox is a search box, never the answer: the
        // selection renders elsewhere. Reading its value back therefore proves
        // only that we typed — and typing "Website" into a widget that then
        // discarded it reported a required field as answered while the form
        // said "0 items selected". A button-style dropdown is different: its
        // own label is the selection.
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
        return norm(el.value) === norm(want);
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
    const filled = [];
    const failed = [];

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
      const el = els[0];
      const { field } = entry;
      let ok = false;

      try {
        switch (field.type) {
          case "select":
            ok = fillSelect(el, value);
            break;
          case "combobox":
            ok = await fillCombobox(el, value, { asyncSearch: Boolean(field.asyncSearch) });
            // One retry, after letting the page settle.
            //
            // These widgets disturb each other: dismissing one menu takes a
            // click away from it, and the next widget's opening click can land
            // while the page is still reacting. Filling this field on its own
            // always succeeded; filling it alongside another combobox did not,
            // which is the whole of the difference.
            if (!ok) {
              await sleep(500);
              ok = await fillCombobox(el, value, { asyncSearch: Boolean(field.asyncSearch) });
            }
            // Leave the page settled for whatever is filled next.
            await sleep(200);
            break;
          case "date":
            ok = fillDate(els, field, value);
            break;
          case "checkbox":
            ok = fillCheckbox(el, value);
            break;
          case "radio":
          case "checkbox-group":
            ok = fillRadioGroup(els, value);
            break;
          case "file":
            ok = files[id] ? fillFile(el, files[id]) : false;
            break;
          default:
            ok = fillText(el, value);
        }
      } catch (err) {
        failed.push({ id, reason: String(err.message || err).slice(0, 160) });
        mark(el, "failed");
        continue;
      }

      // Trust the DOM, not the write path. A synthetic event can be accepted by
      // the browser and ignored by the framework on top of it.
      if (ok && !verifyValue(els, field, value)) {
        // A text field that did not keep its value is usually autocomplete
        // backed — retry the way a person would before giving up.
        if (field.type === "text" || field.type === "search") {
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
        failed.push({ id, reason: `could not set "${value}"` });
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
      if (verifyValue(els, entry.field, fills[id])) continue;

      let recovered = false;
      if (entry.field.type === "text" || entry.field.type === "search") {
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
        filled.splice(filled.indexOf(id), 1);
        failed.push({ id, reason: `"${fills[id]}" did not survive — the field discarded it` });
        mark(els[0], "failed");
      }
    }

    repaintMarks();

    return { filled, failed };
  }

  ns.fill = fill;
  ns.setNativeValue = setNativeValue;
  ns.fillCombobox = fillCombobox;
  ns.readComboboxValue = readComboboxValue;
  // Exported for the Workday harness's --inspect diagnostics.
  ns.currentListbox = currentListbox;
  ns.verifyValue = verifyValue;
  ns.clearMarks = clearMarks;
})();
