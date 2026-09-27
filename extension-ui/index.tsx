import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Panel } from "./Panel";
import { initializeFrame } from "./frame";
import { mountPanel } from "./mount";
import style from "./panel.css";
import type { Bridge } from "./types";
const bridge: Bridge | undefined = initializeFrame();
if (bridge && window.top === window) {
  const host = document.createElement("div");
  host.dataset.formworkUi = "panel";
  host.style.cssText = "position:fixed;inset:auto;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "open" }),
    sheet = document.createElement("style"),
    container = document.createElement("div");
  sheet.textContent = style;
  shadow.append(sheet, container);
  // Keep the React root alive while the host is detached: close/reopen preserves drafts and in-flight work.
  let hide = () => {};
  const reactRoot = createRoot(container);
  flushSync(() =>
    reactRoot.render(<Panel bridge={bridge} hide={() => hide()} />),
  );
  hide = mountPanel(host, bridge.ns, style, () => reactRoot.unmount()).hide;
}
