// Shared DOM primitives. All SVG fragments are local constants.
const icons = {
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  settings:'<path d="m9 3-.7 2.1-2 .9-2-.5-2 3.5 1.4 1.6v2.3l-1.4 1.6 2 3.5 2-.5 2 .9L9 21h4l.7-2.1 2-.9 2 .5 2-3.5-1.4-1.6v-2.3l1.4-1.6-2-3.5-2 .5-2-.9L13 3z"/><circle cx="11" cy="12" r="3"/>',
  activity:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  play:'<path d="m9 5 10 7-10 7z" fill="currentColor" stroke="none"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  star:'<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 18 17"/>',
  expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  'chevron-down':'<path d="m6 9 6 6 6-6"/>',
  'chevron-left':'<path d="m15 6-6 6 6 6"/>',
  'chevron-right':'<path d="m9 6 6 6-6 6"/>',
  tv:'<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 22h8M12 18v4"/>',
  bookmark:'<path d="M6 4h12v17l-6-4-6 4z"/>',
  film:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4"/>'
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const iconTemplates = new Map();
export function icon(name) {
  const key = Object.hasOwn(icons, name) ? name : 'info';
  if (!iconTemplates.has(key)) {
    // Every SVG fragment comes from the fixed, local icon table above.
    const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" viewBox="0 0 24 24" aria-hidden="true">${icons[key]}</svg>`, 'image/svg+xml');
    iconTemplates.set(key, document.importNode(parsed.documentElement, true));
  }
  return iconTemplates.get(key).cloneNode(true);
}
export function replaceIcon(element, name) {
  const graphic = icon(name);
  if (element.namespaceURI === SVG_NS && element.localName === 'svg') {
    element.setAttribute('viewBox', '0 0 24 24');
    element.setAttribute('aria-hidden', 'true');
    element.replaceChildren(...Array.from(graphic.childNodes));
  } else element.replaceChildren(graphic);
}
export function mountIcons(root = document) {
  const targets = [...root.querySelectorAll('[data-icon]')];
  if (root.matches?.('[data-icon]')) targets.unshift(root);
  targets.forEach(element => replaceIcon(element, element.dataset.icon));
}
export function node(tag, className = '', content) { const element = document.createElement(tag); if (className) element.className = className; if (content !== undefined) element.textContent = content; return element; }
export function iconNode(name, className = '') { const element = node('span', className); element.replaceChildren(icon(name)); return element; }
export function button(text, className, handler, name) { const element = node('button', className); element.type = 'button'; if (name) element.append(iconNode(name)); element.append(document.createTextNode(text)); if (handler) element.addEventListener('click', handler); return element; }
