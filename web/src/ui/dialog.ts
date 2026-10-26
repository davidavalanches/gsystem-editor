/**
 * In-app dialogs. The Android WebView's prompt() ignores the default value, so
 * text input goes through this dialog instead.
 */

import { el } from "./dom";

export function askText(title: string, value: string, maxLength: number): Promise<string | null> {
  return new Promise((resolve) => {
    const layer = el("div", "dialog-layer");
    const box = el("form", "dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", title);
    const label = el("label", "dialog-title", title);
    const input = el("input", "dialog-input");
    input.type = "text";
    input.value = value;
    input.maxLength = maxLength;
    input.autocomplete = "off";
    input.spellcheck = false;
    label.append(input);
    const cancel = el("button", "pill", "Annuler");
    cancel.type = "button";
    const ok = el("button", "pill primary", "OK");
    ok.type = "submit";
    const actions = el("div", "dialog-actions");
    actions.append(cancel, ok);
    box.append(label, actions);
    layer.append(box);
    const done = (result: string | null) => {
      layer.remove();
      resolve(result);
    };
    cancel.addEventListener("click", () => done(null));
    layer.addEventListener("pointerdown", (e) => {
      if (e.target === layer) done(null);
    });
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      done(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
    });
    document.body.append(layer);
    input.focus();
    input.select();
  });
}
