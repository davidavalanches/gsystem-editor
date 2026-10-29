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
    const cancel = el("button", "pill", "Cancel");
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

export interface ChecklistItem {
  id: number;
  label: string;
}

export interface ChecklistAction {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  /** Runs with the ids checked; the dialog closes. */
  run(ids: number[]): void;
}

/** A list with a box per item (all checked at first) and actions on the items checked. */
export function showChecklist(title: string, note: string, items: ChecklistItem[], actions: ChecklistAction[]): void {
  const layer = el("div", "dialog-layer");
  const box = el("div", "dialog checklist");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", title);
  const list = el("div", "checklist-items");
  const boxes = items.map((item) => {
    const row = el("label", "checklist-item");
    const check = el("input");
    check.type = "checkbox";
    check.checked = true;
    row.append(check, el("span", "checklist-label", item.label));
    list.append(row);
    return check;
  });
  const all = el("input");
  all.type = "checkbox";
  all.checked = true;
  all.setAttribute("aria-label", "Select all");
  const head = el("label", "checklist-all");
  head.append(all, el("span", "dialog-title", title));
  const close = () => {
    layer.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const buttons = actions.map((a) => {
    const b = el("button", a.primary ? "pill primary" : "pill", a.label);
    b.type = "button";
    b.addEventListener("click", () => {
      const ids = items.filter((_, i) => boxes[i].checked).map((item) => item.id);
      close();
      a.run(ids);
    });
    return b;
  });
  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    all.checked = n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    buttons.forEach((b, i) => (b.disabled = !n || !!actions[i].disabled));
  };
  all.addEventListener("change", () => {
    boxes.forEach((b) => (b.checked = all.checked));
    update();
  });
  boxes.forEach((b) => b.addEventListener("change", update));
  const cancel = el("button", "pill", "Close");
  cancel.type = "button";
  cancel.addEventListener("click", close);
  const footer = el("div", "dialog-actions");
  footer.append(cancel, ...buttons);
  box.append(head, el("p", "checklist-note", note), list, footer);
  layer.append(box);
  layer.addEventListener("pointerdown", (e) => {
    if (e.target === layer) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.append(layer);
  update();
  (buttons.find((b) => !b.disabled) ?? cancel).focus();
}
