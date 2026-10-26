/** Icons, pop-up menus and small builders shared by the views. */

import { el } from "./dom";

const svg = (body: string, size = 20, view = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${view} ${view}" fill="none" stroke-width="1.6" `
  + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  banks: svg('<rect class="accent" x="3" y="4" width="18" height="4" rx="1.5"/><rect x="3" y="10" width="18" height="4" rx="1.5"/>'
    + '<rect x="3" y="16" width="18" height="4" rx="1.5"/>', 22, 24),
  preset: svg('<circle class="accent" cx="12" cy="12" r="8"/><path d="M12 12 12 6"/>', 22, 24),
  midi: svg('<path d="M4 7h16M4 12h16M4 17h10"/>', 22, 24),
  prev: svg('<path d="M10 3 5 8l5 5"/>', 18),
  next: svg('<path d="M6 3l5 5-5 5"/>', 18),
  chevron: svg('<path d="M6 3l5 5-5 5"/>', 14),
  undo: svg('<path d="M5.5 3.5 2.5 6.5l3 3M3 6.5h6.5a4 4 0 0 1 0 8H7"/>', 20),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>', 18),
  more: '<svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true" fill="#ECEAE6">'
    + '<circle cx="8" cy="3.5" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="12.5" r="1.3"/></svg>',
};

export function iconButton(icon: string, label: string, action: () => void): HTMLButtonElement {
  const b = el("button", "icon-button");
  b.type = "button";
  b.innerHTML = icon;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.addEventListener("click", action);
  return b;
}

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

/** Pop-up menu next to an element (or at a point), closed by any tap outside. */
export function showMenu(anchor: HTMLElement | { x: number; y: number }, items: MenuItem[]): void {
  const scrim = el("div", "menu-scrim");
  const menu = el("div", "menu");
  menu.setAttribute("role", "menu");
  const close = () => {
    scrim.remove();
    menu.remove();
  };
  for (const item of items) {
    const b = el("button", "", item.label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.disabled = !!item.disabled;
    b.addEventListener("click", () => {
      close();
      item.action();
    });
    menu.append(b);
  }
  scrim.addEventListener("pointerdown", close);
  document.body.append(scrim, menu);
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { right: anchor.x, bottom: anchor.y, top: anchor.y };
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width))}px`;
  const below = r.bottom + 4;
  menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 4) : below}px`;
  (menu.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus();
}

/** Calls `action` on a long press (touch) or a right click (mouse). */
export function onLongPress(target: HTMLElement, action: (x: number, y: number) => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  target.addEventListener("pointerdown", (e) => {
    fired = false;
    cancel();
    timer = setTimeout(() => {
      fired = true;
      action(e.clientX, e.clientY);
    }, 500);
  });
  target.addEventListener("pointerup", cancel);
  target.addEventListener("pointerleave", cancel);
  target.addEventListener("pointercancel", cancel);
  target.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancel();
    fired = true;
    action(e.clientX, e.clientY);
  });
  // Swallow the click that ends a long press.
  target.addEventListener("click", (e) => {
    if (fired) {
      e.stopImmediatePropagation();
      e.preventDefault();
      fired = false;
    }
  }, true);
}
