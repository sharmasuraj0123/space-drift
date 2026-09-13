const MAX_TEXT = 256 * 1024;
const MAX_HIGHLIGHT = 64 * 1024;
const MAX_TOKENS = 20000;
const MAX_LINES = 3000;
const LANGUAGES = Object.freeze({
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'), tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'), jsonc: () => import('@shikijs/langs/jsonc'),
  yaml: () => import('@shikijs/langs/yaml'), toml: () => import('@shikijs/langs/toml'),
  html: () => import('@shikijs/langs/html'), css: () => import('@shikijs/langs/css'),
  python: () => import('@shikijs/langs/python'), shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'), go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'), java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'), cpp: () => import('@shikijs/langs/cpp'),
  ruby: () => import('@shikijs/langs/ruby'), diff: () => import('@shikijs/langs/diff'),
});
const ALIASES = Object.freeze({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript',
  yml: 'yaml', htm: 'html', py: 'python', pyw: 'python', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  rs: 'rust', h: 'c', cc: 'cpp', hpp: 'cpp', cxx: 'cpp', rb: 'ruby', patch: 'diff',
});
const TOKEN_COLORS = Object.freeze({
  '#8794b0': 'comment', '#b9adff': 'keyword', '#9bd9bc': 'string', '#ffcb8b': 'number',
  '#91dcec': 'function', '#8fbdfd': 'name', '#b7bfd8': 'punctuation', '#ffacaf': 'invalid',
});
const THEME = Object.freeze({
  name: 'space-drift', type: 'dark', colors: { 'editor.background': '#0b1020', 'editor.foreground': '#dbe4ff' },
  tokenColors: [
    { scope: ['comment'], settings: { foreground: '#8794b0' } },
    { scope: ['keyword', 'storage'], settings: { foreground: '#b9adff' } },
    { scope: ['string'], settings: { foreground: '#9bd9bc' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#ffcb8b' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#91dcec' } },
    { scope: ['entity.name', 'entity.other', 'support.type'], settings: { foreground: '#8fbdfd' } },
    { scope: ['punctuation'], settings: { foreground: '#b7bfd8' } },
    { scope: ['invalid'], settings: { foreground: '#ffacaf' } },
  ],
});
let highlighterPromise;

export function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/** Only these explicit imports can be selected by a file or a code fence. */
export function languageFor(name = '', explicit = '') {
  const requested = String(explicit || '').trim().split(/\s+/)[0].toLowerCase();
  const leaf = String(name).split('/').pop().toLowerCase();
  const candidate = requested || (leaf.includes('.') ? leaf.split('.').pop() : leaf === 'dockerfile' ? 'shellscript' : '');
  const canonical = Object.hasOwn(ALIASES, candidate) ? ALIASES[candidate] : candidate;
  return Object.hasOwn(LANGUAGES, canonical) ? canonical : null;
}

function sourceHTML(text, numbered = true) {
  const lines = text.split('\n');
  if (!numbered || lines.length > MAX_LINES) return `<pre class="reader-source"><code>${escapeHTML(text)}</code></pre>`;
  return `<pre class="reader-source reader-code-lines"><code>${lines.map((line, index) => `<span class="reader-code-line" data-line="${index + 1}">${escapeHTML(line)}</span>`).join('')}</code></pre>`;
}

async function highlighter() {
  highlighterPromise ||= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([core, engine]) => core.createHighlighterCore({
    themes: [THEME], langs: [], engine: engine.createJavaScriptRegexEngine(),
  }));
  return highlighterPromise;
}

export async function highlightCode(text, language, { numbered = true } = {}) {
  const plain = () => ({ html: sourceHTML(text, numbered), highlighted: false, language });
  if (!language || text.length > MAX_HIGHLIGHT || text.split('\n').some(line => line.length > 2000)) return plain();
  try {
    const painter = await highlighter();
    if (!painter.getLoadedLanguages().includes(language)) await painter.loadLanguage(await LANGUAGES[language]());
    const { tokens } = painter.codeToTokens(text, { lang: language, theme: 'space-drift' });
    if (tokens.length > MAX_LINES || tokens.reduce((count, line) => count + line.length, 0) > MAX_TOKENS) return plain();
    const lines = tokens.map((line, index) => {
      const contents = line.map(token => {
        const color = TOKEN_COLORS[token.color?.toLowerCase()];
        return color ? `<span class="reader-token-${color}">${escapeHTML(token.content)}</span>` : escapeHTML(token.content);
      }).join('');
      return `<span class="reader-code-line"${numbered ? ` data-line="${index + 1}"` : ''}>${contents}</span>`;
    }).join('');
    return { html: `<pre class="reader-source${numbered ? ' reader-code-lines' : ''}"><code>${lines}</code></pre>`, highlighted: true, language };
  } catch { return plain(); }
}

function decorateMarkdown(tokens) {
  const headings = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'heading_open') {
      const label = tokens[index + 1]?.content || 'section';
      const base = label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'section';
      const count = headings.get(base) || 0; headings.set(base, count + 1);
      token.attrSet('id', `${base}${count ? `-${count}` : ''}`);
    }
    if (token.type !== 'inline' || tokens[index - 1]?.type !== 'paragraph_open' || tokens[index - 2]?.type !== 'list_item_open') continue;
    const first = token.children?.[0];
    const match = first?.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content);
    if (!match) continue;
    first.content = first.content.slice(match[0].length);
    const checked = match[1] !== ' ';
    const marker = new token.constructor('html_inline', '', 0);
    marker.content = `<span class="reader-task-marker" role="img" aria-label="${checked ? 'Completed task' : 'Incomplete task'}">${checked ? '☑' : '☐'}</span> `;
    token.children.unshift(marker);
    tokens[index - 2].attrJoin('class', 'reader-task-item');
  }
}

export async function renderMarkdown(text) {
  const { default: MarkdownIt } = await import('markdown-it');
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 32 });
  // Image references stay inert until the main-thread resource policy approves them.
  parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index], ref = token.attrGet('src') || '';
    const alt = renderer.renderInlineAsText(token.children || [], options, env);
    return `<img data-reader-src="${escapeHTML(ref)}" alt="${escapeHTML(alt)}">`;
  };
  const env = {}, tokens = parser.parse(text, env);
  const count = tokens.reduce((sum, token) => sum + 1 + (token.children?.length || 0), 0);
  if (count > 12000) return { html: sourceHTML(text, false), fallback: true, warning: 'This document is very complex. Showing its readable source.' };
  decorateMarkdown(tokens);
  let remaining = MAX_HIGHLIGHT, fences = 0;
  for (const token of tokens) {
    if (token.type !== 'fence') continue;
    const language = languageFor('', token.info), allowed = ++fences <= 24 && token.content.length <= remaining;
    const result = await highlightCode(token.content, allowed ? language : null, { numbered: false });
    if (allowed) remaining -= token.content.length;
    token.meta = { previewHTML: result.html };
  }
  parser.renderer.rules.fence = (tokens, index) => tokens[index].meta.previewHTML;
  const html = parser.renderer.render(tokens, parser.options, env);
  if (html.length > 2 * 1024 * 1024) return { html: sourceHTML(text, false), fallback: true, warning: 'This document is very complex. Showing its readable source.' };
  return { html, fallback: false };
}

export async function handleTextJob(payload) {
  if (!payload || typeof payload.text !== 'string') throw new Error('No readable text was provided.');
  const text = payload.text.slice(0, MAX_TEXT);
  if (payload.kind === 'markdown') return renderMarkdown(text);
  if (payload.kind === 'code') return highlightCode(text, languageFor(payload.name, payload.language));
  throw new Error('Unknown text reader.');
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && !self.document) {
  self.onmessage = async ({ data }) => {
    try { self.postMessage({ result: await handleTextJob(data) }); }
    catch { self.postMessage({ error: 'The text reader could not finish. Try Source.' }); }
  };
}
