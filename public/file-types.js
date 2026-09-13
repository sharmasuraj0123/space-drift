/** Shared browser and optional Node preview classification. SVG/HTML remain inert source. */
const TEXT_EXTENSIONS = new Set(('txt md mdx markdown rst adoc log csv tsv json jsonl ndjson geojson js mjs cjs ts tsx jsx css scss sass less html htm xhtml svg xml yaml yml toml ini conf cfg sql py rb rs go java kt kts c h cc cpp hpp cs swift sh bash zsh fish vue svelte astro graphql gql proto r tex').split(' '));
const TEXT_NAMES = new Set(['readme', 'license', 'licence', 'notice', 'authors', 'changelog', 'makefile', 'dockerfile', 'procfile', 'gemfile', 'rakefile']);
const MEDIA = new Map([
  ['png', ['image', 'image/png']], ['jpg', ['image', 'image/jpeg']], ['jpeg', ['image', 'image/jpeg']],
  ['gif', ['image', 'image/gif']], ['webp', ['image', 'image/webp']], ['avif', ['image', 'image/avif']],
  ['bmp', ['image', 'image/bmp']], ['ico', ['image', 'image/x-icon']],
  ['pdf', ['pdf', 'application/pdf']], ['mp3', ['audio', 'audio/mpeg']], ['wav', ['audio', 'audio/wav']],
  ['ogg', ['audio', 'audio/ogg']], ['opus', ['audio', 'audio/ogg']], ['flac', ['audio', 'audio/flac']],
  ['m4a', ['audio', 'audio/mp4']], ['aac', ['audio', 'audio/aac']], ['mp4', ['video', 'video/mp4']],
  ['webm', ['video', 'video/webm']], ['mov', ['video', 'video/quicktime']], ['ogv', ['video', 'video/ogg']],
]);

export function classifyFile(name) {
  const filename = String(name).toLowerCase();
  const extension = filename.includes('.') ? filename.split('.').at(-1) : '';
  if (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(filename)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  if (['docx', 'xlsx', 'xls', 'ods'].includes(extension)) return { kind: 'document', mime: 'application/octet-stream' };
  const media = MEDIA.get(extension);
  return media ? { kind: media[0], mime: media[1] } : { kind: 'unsupported', mime: 'application/octet-stream' };
}


export function rendererFor(file) {
  const ext = String(file.name).toLowerCase().split('.').at(-1);
  if (file.kind === 'text') {
    if (['md', 'markdown'].includes(ext)) return 'markdown';
    if (['json', 'geojson', 'jsonl', 'ndjson', 'csv', 'tsv'].includes(ext)) return 'data';
    return 'code';
  }
  if (file.kind === 'document') return 'documents';
  if (['image', 'audio', 'video', 'pdf'].includes(file.kind)) return 'media';
  return null;
}
