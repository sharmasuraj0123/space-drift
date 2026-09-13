import { DATA_BYTES, MAX_DEPTH } from './limits.js';

/** Validate JSON grammar and change whitespace only; never coerce a number. */
export function formatJSON(source) {
  if (typeof source !== 'string' || source.length > DATA_BYTES) throw new Error('JSON exceeds the preview limit.');
  let at = 0, outputSize = 0;
  const budget = length => { outputSize += length; if (outputSize > DATA_BYTES * 3) throw new Error('Formatted JSON exceeds the preview limit.'); };
  const error = () => { throw new Error(`Invalid JSON near character ${at + 1}.`); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[at] || '\0')) at++; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const character = source[at++];
      if (character === '"') {
        const token = source.slice(start, at);
        try { JSON.parse(token); } catch { error(); }
        budget(token.length);
        return token;
      }
      if (character === '\\') at++;
    }
    error();
  };
  const value = depth => {
    if (depth > MAX_DEPTH) throw new Error(`JSON nesting exceeds ${MAX_DEPTH} levels.`);
    whitespace();
    const character = source[at];
    if (character === '"') return string();
    if (character === '{' || character === '[') {
      const object = character === '{', close = object ? '}' : ']';
      at++; whitespace(); budget(2);
      if (source[at] === close) { at++; return character + close; }
      const entries = [];
      while (at < source.length) {
        let key = '';
        if (object) {
          whitespace();
          if (source[at] !== '"') error();
          key = string(); whitespace();
          if (source[at++] !== ':') error();
          key += ': '; budget(2);
        }
        budget((depth + 1) * 2 + 2);
        entries.push('  '.repeat(depth + 1) + key + value(depth + 1));
        whitespace();
        if (source[at] === close) { at++; budget(depth * 2 + 1); return character + '\n' + entries.join(',\n') + '\n' + '  '.repeat(depth) + close; }
        if (source[at++] !== ',') error();
      }
      error();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!token) error();
    at += token[0].length;
    budget(token[0].length);
    return token[0];
  };
  const formatted = value(0);
  whitespace();
  if (at !== source.length) error();
  if (formatted.length > DATA_BYTES * 3) throw new Error('Formatted JSON exceeds the preview limit.');
  return formatted;
}
