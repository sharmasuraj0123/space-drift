import { createTourDraft, importTourDraft, exportTourDraft, validateTourDraft, MAX_TOUR_BYTES } from './tour-draft.js';

export function createTourEditor({ getWorkspace, getSelection, onOpen, onAtlas, onPreview }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('tour-editor');
  let draft = createTourDraft(), revision = 0, request = 0, selection = null;

  function message(value) { $('editor-status').textContent = value; }
  function changed() {
    revision++;
    message('Draft changed. Preview and export will check the destinations again.');
  }
  function button(parent, label, action, disabled = false) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.disabled = disabled;
    node.addEventListener('click', action); parent.append(node);
    return node;
  }
  function field(parent, label, value, update, { multiline = false, maxLength, type = 'text' } = {}) {
    const wrapper = document.createElement('label'), input = document.createElement(multiline ? 'textarea' : 'input');
    wrapper.textContent = label;
    if (!multiline) input.type = type;
    input.value = value;
    if (maxLength) input.maxLength = maxLength;
    if (type === 'number') { input.min = 0; input.max = 120; input.step = 'any'; }
    input.addEventListener('input', () => { update(type === 'number' ? input.valueAsNumber : input.value); changed(); });
    wrapper.append(input); parent.append(wrapper);
  }
  function renderStops() {
    $('editor-stops').replaceChildren();
    $('editor-empty').hidden = draft.stops.length > 0;
    $('editor-count').textContent = `${draft.stops.length} / 64 stops`;
    for (const [index, stop] of draft.stops.entries()) {
      const row = document.createElement('li');
      row.className = 'editor-stop';
      const destination = document.createElement('p');
      destination.className = 'editor-destination';
      destination.textContent = `${stop.planet ?? 'Workspace'} / ${stop.path ?? stop.molecule ?? 'Fly by'}`;
      const status = document.createElement('p');
      status.className = 'editor-stop-status';
      status.textContent = 'Validate to check this destination.';
      row.append(destination, status);
      field(row, `Stop ${index + 1} title`, stop.title || '', (value) => { stop.title = value; }, { maxLength: 160 });
      field(row, `Stop ${index + 1} explanation`, stop.note || '', (value) => { stop.note = value; }, { multiline: true, maxLength: 2000 });
      field(row, `Stop ${index + 1} pause (seconds)`, stop.dwellSeconds ?? 2, (value) => { stop.dwellSeconds = value; }, { type: 'number' });
      if (stop.path != null) {
        const label = document.createElement('label'), checkbox = document.createElement('input');
        label.className = 'editor-checkbox'; checkbox.type = 'checkbox'; checkbox.checked = stop.open !== false;
        checkbox.addEventListener('change', () => { stop.open = checkbox.checked; changed(); });
        label.append(checkbox, 'Open file and wait for the viewer to close'); row.append(label);
      }
      const actions = document.createElement('div'); actions.className = 'tour-controls';
      const move = (offset) => {
        [draft.stops[index], draft.stops[index + offset]] = [draft.stops[index + offset], draft.stops[index]];
        changed(); renderStops();
        $('editor-stops').children[index + offset].querySelector('input').focus();
      };
      button(actions, 'Move up', () => move(-1), index === 0);
      button(actions, 'Move down', () => move(1), index === draft.stops.length - 1);
      button(actions, 'Remove stop', () => {
        draft.stops.splice(index, 1); changed(); renderStops();
        ($('editor-stops').children[Math.min(index, draft.stops.length - 1)]?.querySelector('input') || $('editor-atlas')).focus();
      });
      row.append(actions); $('editor-stops').append(row);
    }
  }
  function render() {
    for (const key of ['id', 'title', 'description']) $('editor-' + key).value = draft[key];
    const scope = $('editor-import-body');
    scope.replaceChildren(new Option('Workspace paths / explicit body ids', ''));
    for (const body of getWorkspace().bodies) scope.add(new Option(body.name || body.id, body.id));
    selection = getSelection();
    $('editor-selected').disabled = !selection;
    $('editor-selected').textContent = selection ? `Add selected: ${selection.title || selection.path || selection.molecule || selection.planet}` : 'No selected object';
    renderStops();
  }
  async function validate() {
    const version = revision, token = ++request;
    message('Checking destinations in the connected workspace…');
    const result = await validateTourDraft(draft, getWorkspace());
    if (!dialog.open || version !== revision || token !== request) return null;
    if (result.error) { message(result.error); return null; }
    const missing = result.tour.stops.filter((stop) => stop.missing).length;
    for (const [index, stop] of result.tour.stops.entries()) {
      const row = $('editor-stops').children[index];
      row.dataset.missing = String(stop.missing);
      row.querySelector('.editor-stop-status').textContent = stop.reason || 'Available in this workspace.';
    }
    message(missing ? `${missing} of ${draft.stops.length} stops are unavailable. Preview skips them; export retains them for editing.` : `All ${draft.stops.length} stops are available.`);
    return result.tour;
  }
  function open(tour) {
    if (tour) { draft = createTourDraft(tour); changed(); }
    onOpen(); render(); dialog.showModal();
    if (draft.stops.length) validate();
    else message('Add folders or files from Atlas to begin.');
  }
  function add(stop) {
    if (draft.stops.length >= 64) { open(); message('A tour can have at most 64 stops. Remove a stop before adding another.'); return; }
    draft.stops.push({ ...stop, title: stop.title || '', note: '', open: stop.path != null, dwellSeconds: 2 });
    changed(); open();
  }
  for (const key of ['id', 'title', 'description']) $('editor-' + key).addEventListener('input', (event) => { draft[key] = event.target.value; changed(); });
  $('editor-selected').addEventListener('click', () => { if (selection) add(selection); });
  $('editor-atlas').addEventListener('click', onAtlas);
  $('editor-validate').addEventListener('click', validate);
  $('editor-preview').addEventListener('click', async () => {
    const tour = await validate();
    if (!tour) return;
    if (tour.stops.every((stop) => stop.missing)) { message('No available stops to preview. Add a mapped destination or reconnect its workspace.'); return; }
    onPreview(tour);
  });
  $('editor-export').addEventListener('click', async () => {
    const tour = await validate();
    if (!tour) return;
    // Export the draft rather than resolved paths so unavailable destinations survive.
    const result = exportTourDraft(draft);
    if (result.error) { message(result.error); return; }
    const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${tour.id.startsWith('.') ? 'tour-' : ''}${tour.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('editor-import').addEventListener('change', async (event) => {
    const file = event.target.files[0], version = revision, token = ++request;
    const defaultPlanet = $('editor-import-body').value || null;
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_TOUR_BYTES) { message('Tour JSON must be no larger than 1 MB.'); return; }
    try {
      const json = await file.text();
      if (version !== revision || token !== request) return;
      const result = importTourDraft(json, defaultPlanet);
      if (result.error) { message(result.error); return; }
      draft = result.tour; changed(); render(); validate();
    } catch {
      if (version === revision && token === request) message('This tour file could not be read. Try choosing it again.');
    }
  });
  $('editor-new').addEventListener('click', () => {
    draft = createTourDraft(); changed(); render(); message('New draft. Add folders or files from Atlas to begin.');
  });
  return { open, add, reset() {
    draft = createTourDraft(); revision++; request++; selection = null;
    $('editor-import').value = '';
    for (const key of ['id', 'title', 'description']) $('editor-' + key).value = '';
    $('editor-stops').replaceChildren(); $('editor-import-body').replaceChildren(); message('');
  } };
}
