import type { Runtime } from "./types";
export function mountPanel(host: HTMLElement, ns: Runtime, STYLE: string, dispose: () => void) {
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
  ): HTMLElementTagNameMap[K] =>
    Object.assign(document.createElement(tag), props);
  /**
   * Mount the panel, and keep it mounted.
   *
   * A content script running at document_idle can land mid-hydration. When a
   * React app's hydration fails it discards the server-rendered DOM and
   * re-renders from scratch, taking any node we already inserted with it — the
   * panel mounts, disappears milliseconds later, and nothing errors.
   */
  let dismissed = false;
  const launcher = el("div");
  launcher.dataset.formworkUi = "launcher";
  launcher.style.cssText = "position:fixed;inset:auto;z-index:2147483647";
  const launcherRoot = launcher.attachShadow({ mode: "open" });
  let launcherPosition: { x: number; y: number } | null = null,
    positionEdited = false,
    drag: {
      id: number;
      x: number;
      y: number;
      left: number;
      top: number;
      moved: boolean;
    } | null = null,
    suppressClick = false;
  const launcherButton = el("button", {
    type: "button",
    textContent: "Formwork",
    ariaLabel: "Reopen Formwork",
    title: "Click to reopen. Drag to move, or focus and use arrow keys.",
    style:
      "position:fixed;right:12px;bottom:12px;min-height:44px;padding:8px 14px;box-shadow:0 4px 16px #0008;touch-action:none;user-select:none;cursor:grab",
    onclick: (event: MouseEvent) => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        return;
      }
      ns._panel?.toggle();
    },
  });
  launcherRoot.append(el("style", { textContent: STYLE }), launcherButton);
  const bounds = () => ({
    x: Math.max(0, innerWidth - launcherButton.offsetWidth - 16),
    y: Math.max(0, innerHeight - launcherButton.offsetHeight - 16),
  });
  const placeLauncher = () => {
    if (!launcherPosition || !launcher.isConnected) return;
    const room = bounds();
    Object.assign(launcherButton.style, {
      right: "auto",
      bottom: "auto",
      left: `${8 + launcherPosition.x * room.x}px`,
      top: `${8 + launcherPosition.y * room.y}px`,
    });
  };
  const moveLauncher = (left: number, top: number) => {
    const room = bounds();
    launcherPosition = {
      x: room.x ? Math.max(0, Math.min(1, (left - 8) / room.x)) : 0,
      y: room.y ? Math.max(0, Math.min(1, (top - 8) / room.y)) : 0,
    };
    positionEdited = true;
    placeLauncher();
  };
  const savePosition = async () => {
    try {
      await chrome.storage.local.set({ launcherPosition });
    } catch {
      /* Keep this tab usable if extension storage is unavailable. */
    }
  };
  launcherButton.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = launcherButton.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    suppressClick = false;
    launcherButton.setPointerCapture(event.pointerId);
  });
  launcherButton.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    launcherButton.style.cursor = "grabbing";
    moveLauncher(drag.left + dx, drag.top + dy);
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved;
    if (drag.moved) void savePosition();
    drag = null;
    launcherButton.style.cursor = "grab";
    if (launcherButton.hasPointerCapture(event.pointerId))
      launcherButton.releasePointerCapture(event.pointerId);
  };
  launcherButton.addEventListener("pointerup", endDrag);
  launcherButton.addEventListener("pointercancel", endDrag);
  launcherButton.addEventListener("keydown", (event) => {
    const deltas: Record<string, number[]> = {
      ArrowLeft: [-24, 0],
      ArrowRight: [24, 0],
      ArrowUp: [0, -24],
      ArrowDown: [0, 24],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = launcherButton.getBoundingClientRect();
    moveLauncher(rect.left + delta[0], rect.top + delta[1]);
    void savePosition();
  });
  window.addEventListener("resize", placeLauncher);
  (async () => {
    try {
      const { launcherPosition: saved } =
        await chrome.storage.local.get("launcherPosition");
      if (
        !positionEdited &&
        saved &&
        typeof saved === "object" &&
        "x" in saved &&
        "y" in saved &&
        typeof saved.x === "number" &&
        typeof saved.y === "number" &&
        Number.isFinite(saved.x) &&
        Number.isFinite(saved.y)
      ) {
        launcherPosition = {
          x: Math.max(0, Math.min(1, saved.x)),
          y: Math.max(0, Math.min(1, saved.y)),
        };
        placeLauncher();
      }
    } catch {
      /* A new install starts in the default corner. */
    }
  })();
  // Extension upgrades create a new isolated world while old shadow-DOM UI
  // can remain in the page. Removing an old host wakes its hydration observer
  // and makes it reappear, so retire legacy hosts in place instead.
  const owner = `${Date.now()}-${Math.random()}`;
  document.documentElement.dataset.formworkOwner = owner;
  const ownsPage = () =>
    document.documentElement.dataset.formworkOwner === owner;
  // Native modal dialogs make every outside node inert, regardless of z-index.
  // Include open shadow roots because application components can own a dialog.
  const pageRoots = (): (Document | ShadowRoot)[] => {
    const roots: (Document | ShadowRoot)[] = [document];
    for (let index = 0; index < roots.length; index++) {
      for (const node of roots[index].querySelectorAll('*')) {
        if (node.shadowRoot && !node.hasAttribute('data-formwork-ui')) roots.push(node.shadowRoot);
      }
    }
    return roots;
  };
  function modalParent(roots: (Document | ShadowRoot)[]): HTMLElement {
    const modals = roots.flatMap(root => [...root.querySelectorAll<HTMLDialogElement>('dialog:modal')]);
    if (modals.length === 1) return modals[0];
    // For stacked dialogs, follow actual focus across shadow boundaries.
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    for (let node: Node | null = active; node; ) {
      if (node instanceof HTMLDialogElement && modals.includes(node)) return node;
      node = node.parentNode || (node instanceof ShadowRoot ? node.host : null);
    }
    return document.documentElement;
  }
  function retireOtherPanels(roots: (Document | ShadowRoot)[]) {
    const candidates = new Set<Element>([...document.documentElement.children,
      ...roots.flatMap(root => [...root.querySelectorAll('[data-formwork-ui]')])]);
    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      if (node === host || node === launcher) continue;
      const shadow = node.shadowRoot;
      const isPanel = shadow
        ?.querySelector(".panel footer")
        ?.textContent?.includes("formwork never submits");
      const isLauncher = shadow?.querySelector(
        'button[aria-label="Reopen Formwork"]',
      );
      if (isPanel || isLauncher) {
        node.style.setProperty("display", "none", "important");
        node.setAttribute("inert", "");
        node.setAttribute("aria-hidden", "true");
      }
    }
  }
  let retired = false;
  let hydrationTimer: ReturnType<typeof setTimeout> | undefined;
  const mount = () => {
    if (!ownsPage()) {
      if (retired) return;
      retired = true;
      mountObserver?.disconnect();
      document.removeEventListener("focusin", scheduleMount, true);
      cancelAnimationFrame(mountFrame);
      clearTimeout(hydrationTimer);
      window.removeEventListener("resize", placeLauncher);
      document.removeEventListener("keydown", handleEscape, true);
      try {chrome.runtime.onMessage.removeListener(handleMessage);} catch {}
      dispose();
      host.remove();
      launcher.remove();
      return;
    }
    const roots = pageRoots();
    for (const root of roots) mountObserver.observe(root, {childList:true, subtree:true, attributes:true, attributeFilter:['open']});
    const parent = modalParent(roots);
    retireOtherPanels(roots);
    if (dismissed) {
      if (launcher.parentElement !== parent) parent.append(launcher);
      placeLauncher();
    } else {
      launcher.remove();
      if (host.parentElement !== parent) parent.append(host);
    }
  };

  let mountFrame = 0;
  function scheduleMount() {
    if (!mountFrame && !retired) mountFrame = requestAnimationFrame(() => { mountFrame = 0; mount(); });
  }
  const mountObserver = new MutationObserver(scheduleMount);
  document.addEventListener("focusin", scheduleMount, true);
  mount();
  hydrationTimer = setTimeout(mount, 1500);

  function hidePanel() {
    if (!ownsPage()) return;
    dismissed = true;
    host.remove();
    mount();
  }
  ns._panel = {
    toggle() {
      if (!ownsPage()) return;
      if (host.isConnected) hidePanel();
      else {
        dismissed = false;
        mount();
      }
    },
  };
  // Escape works even while a model request is running. Keep the detached
  // panel and draft inputs intact so reopening does not discard work.
  function handleEscape(event: KeyboardEvent) {
    if(event.isTrusted && event.key === "Escape" && !event.isComposing && host.isConnected) {
      hidePanel();
      if(event.composedPath().includes(host)) {event.preventDefault();event.stopPropagation();}
    }
  }
  function handleMessage(message: unknown) {
    if(message && typeof message === "object" && "type" in message && message.type === "formwork/toggle-current" && ownsPage()) ns._panel?.toggle();
  }
  document.addEventListener("keydown", handleEscape, true);
  try {
    chrome.runtime.onMessage.addListener(handleMessage);
  } catch (err) {
    ns._listenerError = String(err instanceof Error ? err.message : err);
  }

  return { hide: hidePanel };
}
