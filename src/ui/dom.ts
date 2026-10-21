/**
 * Tiny DOM helpers. Everything that comes out of the library goes through
 * textContent — never innerHTML — so a track title with markup in it stays a title.
 */

type Child = Node | string | null | undefined | false;

/**
 * Permissive on purpose: attributes, event handlers (`onclick: fn`) and ARIA names all
 * go through the same map. Values are always applied as attributes/textContent, never
 * as HTML.
 */
export interface Attrs {
  [key: string]: string | number | boolean | ((event: Event) => void) | undefined | null;
}

/**
 * Accepts children either as individual arguments, as a spread, or as arrays —
 * `h('div', {}, [a, b])` and `h('div', {}, ...items)` both read fine, and mixing the
 * two should not be a type error.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Child | readonly Child[]>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node: Element, children: readonly (Child | readonly Child[])[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child as readonly Child[]);
      continue;
    }
    node.append(child as Node | string);
  }
}

export function replace(host: Element, ...children: Array<Child | readonly Child[]>): void {
  host.replaceChildren();
  appendChildren(host, children);
}

/** `duration` is seconds, as Subsonic reports it. */
export function formatDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '--:--';
  // Same rule as `formatTime`: a length is truncated, so a 179.6 s track reads 2:59 both places.
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function cover(
  url: string | null,
  className: string,
  alt: string,
  crossOrigin = false,
  fallback = '♪',
): HTMLElement {
  if (!url) {
    return h('div', { class: `${className} cover-placeholder`, text: fallback, 'aria-hidden': 'true' });
  }
  const image = h('img', { class: className, src: url, alt, loading: 'lazy', decoding: 'async' });
  if (crossOrigin) image.crossOrigin = 'anonymous';
  image.addEventListener('error', () => {
    const placeholder = h('div', { class: `${className} cover-placeholder`, text: fallback, 'aria-hidden': 'true' });
    image.replaceWith(placeholder);
  });
  return image;
}

export function icon(path: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  node.setAttribute('fill', 'currentColor');
  svg.append(node);
  return svg;
}

export const ICONS = {
  play: 'M8 5.14v13.72L19 12 8 5.14z',
  pause: 'M6 5h4v14H6V5zm8 0h4v14h-4V5z',
  next: 'M6 5l9 7-9 7V5zm10 0h2v14h-2V5z',
  previous: 'M18 5l-9 7 9 7V5zM6 5h2v14H6V5z',
  star: 'M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9L12 3.5z',
  starOutline:
    'M12 5.6l1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6L12 5.6z',
  back: 'M14.7 5.3 8 12l6.7 6.7 1.4-1.4L10.8 12l5.3-5.3-1.4-1.4z',
  close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5z',
  search: 'M10 3a7 7 0 1 0 4.2 12.6l4.6 4.6 1.4-1.4-4.6-4.6A7 7 0 0 0 10 3zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z',
  queue: 'M4 6h11v2H4V6zm0 5h11v2H4v-2zm0 5h7v2H4v-2zm13 0v-6l4 3-4 3z',
  settings:
    'M4 7h9v2H4V7zm13 0h3v2h-3V7zm-5-3h2v8h-2V4zM4 15h3v2H4v-2zm7 0h9v2h-9v-2zm-4-3h2v8H7v-8z',
  // v1.1: shuffle and repeat, for the compact bar on the spectrum screen.
  shuffle:
    'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  repeatOne:
    'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
  changelog: 'M6 3h9l5 5v13H6V3zm2 8h8v2H8v-2zm0 4h8v2H8v-2z',
  /*
   * v1.9.20 — the two download marks. One arrow into a tray, drawn solid for "this is on your phone"
   * and hollow for "some of it is / it is coming". Paths rather than images: they inherit
   * `currentColor` like every other icon, they cost nothing to ship, and there is no new asset
   * pipeline. They are never buttons — the whole row is the one tap target (v1.5) — so the
   * accessible name carries the state instead (`Play X, downloaded`).
   */
  download: 'M12 3v9.6l3.3-3.3 1.4 1.4L12 16.4 7.3 10.7l1.4-1.4L12 12.6V3zM5 17h14v2H5v-2z',
  downloadPartial: 'M12 3.8 8.5 7.3 7.4 6.2 12 1.6l4.6 4.6-1.1 1.1L12 3.8v8.8h-1.5V3.8zM5 17.5h14v1.7H5v-1.7z',
};

export function playIcon(playing: boolean, size = 24): SVGSVGElement {
  return icon(playing ? ICONS.pause : ICONS.play, size);
}

export function starIcon(filled: boolean, size = 18): SVGSVGElement {
  return icon(filled ? ICONS.star : ICONS.starOutline, size);
}
