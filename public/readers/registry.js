import { rendererFor } from '../file-types.js';

// Explicit entry points keep every heavy dependency out of flight's initial graph.
const loaders = {
  markdown: () => import('/reader-assets/markdown.js'),
  code: () => import('/reader-assets/code.js'),
  data: () => import('/reader-assets/data.js'),
  documents: () => import('/reader-assets/documents.js'),
  media: () => import('/reader-assets/media.js'),
};
export { rendererFor };
export function loadRenderer(file) { return loaders[rendererFor(file)]?.(); }
export async function renderHTML(ctx, html, options) {
  const renderer = await import('/reader-assets/html.js');
  if (!ctx.signal.aborted) return renderer.renderHTML(ctx, html, options);
}
