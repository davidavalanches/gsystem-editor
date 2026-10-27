/** Tiny DOM helper. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Desktop layout (a PC screen): wide and tall enough for the multi-column views. */
export const DESKTOP = matchMedia("(min-width: 1200px) and (min-height: 700px)");
