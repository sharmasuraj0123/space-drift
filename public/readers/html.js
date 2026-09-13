import createDOMPurify from 'dompurify';
import { relativeFilePath } from './runtime.js';

const TAGS = ['a', 'p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 's', 'del', 'u', 'small', 'sub', 'sup', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'img', 'figure', 'figcaption'];
const ATTRS = ['class', 'id', 'title', 'alt', 'href', 'src', 'role', 'aria-label', 'aria-hidden', 'data-reader-src', 'data-reader-href', 'data-reader-path', 'data-reader-hash', 'data-line', 'colspan', 'rowspan', 'scope', 'start', 'reversed', 'target', 'rel', 'loading', 'decoding', 'referrerpolicy'];
const DROP_CONTENTS = ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'video', 'audio'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const RASTER = /\.(?:png|jpe?g|webp|gif|avif|bmp|ico)$/i;
const CLASSES = new Set(['reader-source', 'reader-code-lines', 'reader-code-line', 'reader-task-marker', 'reader-task-item', 'reader-image-note', 'reader-local-image', ...['comment', 'keyword', 'string', 'number', 'function', 'name', 'punctuation', 'invalid'].map(name => `reader-token-${name}`)]);

export function safeReaderClasses(value) {
  return String(value || '').split(/\s+/).filter(name => CLASSES.has(name)).join(' ');
}

export function safeExternalURL(reference) {
  if (typeof reference !== 'string' || CONTROL.test(reference) || reference !== reference.trim() || !/^https:\/\//i.test(reference)) return null;
  try {
    const url = new URL(reference);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function localResourcePath(currentPath, reference, kind = 'link') {
  if (typeof currentPath !== 'string' || typeof reference !== 'string' || CONTROL.test(reference) || reference !== reference.trim()) return null;
  let decoded;
  try { decoded = decodeURIComponent(reference); } catch { return null; }
  if (CONTROL.test(decoded)) return null;
  const path = relativeFilePath(currentPath, reference);
  return path && (kind !== 'image' || RASTER.test(path)) ? path : null;
}

function approvedBlob(url, origin) {
  if (typeof url !== 'string' || !url.startsWith('blob:')) return false;
  try { return new URL(url).origin === origin; } catch { return false; }
}

async function yieldToControls(window, signal) {
  if (window.scheduler?.yield) await window.scheduler.yield();
  else await new Promise(resolve => window.setTimeout(resolve, 0));
  if (signal?.aborted) throw new DOMException('Preview cancelled.', 'AbortError');
}

/** Parse in an inert template, strip fetch attributes, transform, then sanitize again. */
export async function renderHTML(ctx, html, options = {}) {
  const markup = String(html);
  if (markup.length > 2 * 1024 * 1024) throw new Error('This document exceeds the HTML preview size limit. Use Source or open it in its usual app.');
  if (ctx.signal?.aborted) throw new DOMException('Preview cancelled.', 'AbortError');
  const doc = ctx.container.ownerDocument, window = doc.defaultView;
  const purifier = createDOMPurify(window);
  const config = {
    ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ATTRS, ALLOW_DATA_ATTR: false,
    FORBID_TAGS: DROP_CONTENTS, FORBID_CONTENTS: DROP_CONTENTS,
    FORBID_ATTR: ['style', 'srcset', 'name'], RETURN_DOM_FRAGMENT: true,
    SANITIZE_DOM: true, SANITIZE_NAMED_PROPS: true,
    // These are inert metadata, not browser fetch/navigation attributes. Their
    // values are checked below before becoming src/href or delegated actions.
    ADD_URI_SAFE_ATTR: ATTRS.filter(name => name !== 'src' && name !== 'href'),
  };
  const template = doc.createElement('template');
  template.innerHTML = markup;
  for (const node of template.content.querySelectorAll('*')) {
    if (node.localName === 'img') node.setAttribute('data-reader-src', node.getAttribute('src') || node.getAttribute('data-reader-src') || '');
    if (node.localName === 'a') node.setAttribute('data-reader-href', node.getAttribute('href') || node.getAttribute('data-reader-href') || '');
    const classes = safeReaderClasses(node.getAttribute('class'));
    if (classes) node.setAttribute('class', classes); else node.removeAttribute('class');
    for (const attribute of [...node.attributes]) {
      if (/^(?:src|srcset|href|xlink:href|poster|background|ping|action|formaction|style)$/i.test(attribute.name) || /^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    }
  }
  await yieldToControls(window, ctx.signal);
  const fragment = purifier.sanitize(template.content, config);
  await yieldToControls(window, ctx.signal);
  const origin = window.location.origin;
  const trusted = new Set((options.allowBlobImages || []).filter(url => approvedBlob(url, origin)));
  const imageNodes = [...fragment.querySelectorAll('img')];
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  ctx.signal?.addEventListener('abort', cancel, { once: true });
  function imageNote(node, message) {
    const note = doc.createElement('span'); note.className = 'reader-image-note';
    const alt = node.getAttribute('alt')?.slice(0, 240);
    note.textContent = `${alt ? `${alt} — ` : ''}${message}`;
    node.replaceWith(note);
  }
  const resolveImage = async (node, index) => {
    const ref = node.getAttribute('data-reader-src') || '';
    node.removeAttribute('data-reader-src');
    if (index >= 24) return imageNote(node, 'Image limit reached');
    let url = trusted.has(ref) ? ref : null;
    if (!url && localResourcePath(ctx.result.path, ref, 'image') && ctx.resolveAsset) {
      try {
        const asset = await ctx.resolveAsset(ref, 'image');
        if (approvedBlob(asset?.url, origin)) url = asset.url;
      } catch (error) { if (error.name === 'AbortError') cancelled = true; }
    }
    if (cancelled || ctx.signal?.aborted) return;
    if (!url) return imageNote(node, 'Image unavailable in this local preview');
    node.setAttribute('src', url); node.setAttribute('class', 'reader-local-image');
    node.setAttribute('loading', 'lazy'); node.setAttribute('decoding', 'async');
    node.setAttribute('referrerpolicy', 'no-referrer');
  };
  try {
    for (let index = 0; index < imageNodes.length; index += 4) {
      if (cancelled || ctx.signal?.aborted) return;
      await Promise.all(imageNodes.slice(index, index + 4).map((node, offset) => resolveImage(node, index + offset)));
    }
    for (const anchor of fragment.querySelectorAll('a')) {
      const ref = anchor.getAttribute('data-reader-href') || '';
      for (const name of ['data-reader-href', 'data-reader-path', 'data-reader-hash', 'href', 'target', 'rel']) anchor.removeAttribute(name);
      const external = safeExternalURL(ref);
      if (external) {
        anchor.setAttribute('href', external); anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer'); anchor.setAttribute('referrerpolicy', 'no-referrer');
      } else if (ref.startsWith('#') && !CONTROL.test(ref)) {
        let hash; try { hash = decodeURIComponent(ref.slice(1)); } catch { hash = ''; }
        if (hash && !CONTROL.test(hash)) { anchor.setAttribute('href', '#reader-heading'); anchor.setAttribute('data-reader-hash', hash); }
      } else {
        const path = localResourcePath(ctx.result.path, ref);
        if (path) { anchor.setAttribute('href', '#reader-file'); anchor.setAttribute('data-reader-path', path); }
        else anchor.setAttribute('title', 'This link is unavailable in the local preview.');
      }
    }
    if (cancelled || ctx.signal?.aborted) return;
    await yieldToControls(window, ctx.signal);
    // IDs were namespaced in the first pass; preserve that single prefix here.
    const clean = purifier.sanitize(fragment, { ...config, SANITIZE_NAMED_PROPS: false, ALLOWED_URI_REGEXP: /^(?:https:|blob:|#)/i });
    const classes = ['reader-document', ...String(options.className || '').split(/\s+/).filter(name => /^reader-[a-z-]+$/.test(name))];
    ctx.container.classList.add(...classes);
    ctx.container.replaceChildren(clean);
    const click = event => {
      const anchor = event.target.closest?.('a');
      if (!anchor || !ctx.container.contains(anchor)) return;
      const path = anchor.getAttribute('data-reader-path'), hash = anchor.getAttribute('data-reader-hash');
      if (!path && !hash) return;
      event.preventDefault();
      if (ctx.signal?.aborted) return;
      if (path) Promise.resolve().then(() => ctx.openPath?.(path)).catch(() => ctx.status('That file is not available in the connected folder.'));
      else {
        const target = [...ctx.container.querySelectorAll('[id]')].find(node => node.id === `user-content-${hash}`);
        if (target) { target.scrollIntoView({ block: 'start' }); target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
      }
    };
    ctx.container.addEventListener('click', click);
    return { dispose() { ctx.container.removeEventListener('click', click); ctx.container.classList.remove(...classes); } };
  } finally { ctx.signal?.removeEventListener('abort', cancel); }
}
