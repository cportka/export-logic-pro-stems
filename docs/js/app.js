// app.js — browser UI for the Logic Pro stem exporter.
//
// All processing happens locally in the browser: files are read from disk on demand,
// decoded with the Web Audio API when needed, and downloaded as renamed copies or a
// ZIP. Nothing is ever uploaded. The pure logic (ZIP/WAV/naming/splitting) lives in
// stem-lib.js so it can be unit-tested outside a browser.

import {
  isAudioFile,
  fileExt,
  baseName,
  stripExt,
  buildStemName,
  classifyPath,
  shouldIngest,
  isReferenceTrack,
  planTakes,
  encodeWav,
  probeAudioHeader,
  buildZip,
  formatBytes,
  formatDuration,
  buildBounceCommand,
} from './stem-lib.js';

/* --------------------------------------------------------------------- state */

let nextId = 1;
const state = {
  /** @type {Array<{id:number,project:string,track:string,relPath:string,file:File,info:object,meta:?object,isRef:boolean,selected:boolean,status:string}>} */
  items: [],
  settings: {
    format: 'passthrough', // passthrough | wav16 | wav24
    split: false,
    refId: null,
    template: '{project}_{track}',
    includeAll: false,
  },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(n.dataset, v); // .dataset is read-only; assign into it
    else n[k] = v;
  }
  for (const k of kids) if (k != null && k !== '') n.append(k);
  return n;
};

/* ----------------------------------------------------------------- ingestion */

/** Recursively read a drag-and-drop directory entry into {file, relPath} records. */
async function readEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, relPath: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await readEntry(e, out);
    } while (batch.length);
  }
}

/** Add {file, relPath} records to state, classifying and de-duplicating by path. */
function ingest(records) {
  const seen = new Set(state.items.map((i) => i.relPath));
  let added = 0;
  for (const { file, relPath } of records) {
    if (!isAudioFile(relPath) || seen.has(relPath)) continue;
    const info = classifyPath(relPath);
    seen.add(relPath);
    const item = {
      id: nextId++,
      project: info.project,
      track: stripExt(baseName(relPath)),
      relPath,
      file,
      info,
      meta: null,
      isRef: false,
      selected: shouldIngest(info, { includeAll: state.settings.includeAll }),
      status: '',
    };
    state.items.push(item);
    added++;
    probeMeta(item); // fire-and-forget; updates the row when done
  }
  autoDetectReference();
  render();
  if (added) setStatus(`Added ${added} audio file${added === 1 ? '' : 's'}.`);
}

/** Cheaply read a duration for a row by parsing just the file header. */
async function probeMeta(item) {
  try {
    const head = new Uint8Array(await item.file.slice(0, 256 * 1024).arrayBuffer());
    item.meta = probeAudioHeader(head);
  } catch {
    item.meta = null;
  }
  renderRowMeta(item);
}

/** Pick a default reference track per project (first COMP/ROUGH/project-name match). */
function autoDetectReference() {
  if (state.settings.refId && state.items.some((i) => i.id === state.settings.refId)) return;
  const ref = state.items.find((i) => isReferenceTrack(i.track, { projectName: i.project }));
  state.settings.refId = ref ? ref.id : state.items[0]?.id ?? null;
  for (const i of state.items) i.isRef = i.id === state.settings.refId;
}

/* ------------------------------------------------------------------ exporting */

let audioCtxUnsupported = false;

/** Decode a file to an AudioBuffer at its own sample rate (avoids resampling when known). */
async function decodeFile(file, srHint) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC) {
    audioCtxUnsupported = true;
    throw new Error('Web Audio API unavailable');
  }
  const sr = srHint && srHint >= 8000 && srHint <= 192000 ? srHint : 44100;
  const ctx = new AC(1, 1, sr);
  const buf = await file.arrayBuffer();
  return ctx.decodeAudioData(buf);
}

const channelsOf = (audioBuffer) => {
  const chans = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) chans.push(audioBuffer.getChannelData(c));
  return chans;
};

const wavBitDepth = () => (state.settings.format === 'wav24' ? 24 : 16);

/**
 * Turn a selected item into one or more { name, data } output entries, honoring the
 * chosen format and (optional) reference-length take-splitting.
 */
async function renderItem(item, refDurationSec) {
  const s = state.settings;
  const splitting = s.split && !item.isRef && refDurationSec > 0;

  if (s.format === 'passthrough' && !splitting) {
    const data = new Uint8Array(await item.file.arrayBuffer());
    return [{ name: buildStemName(s.template, { project: item.project, track: item.track, ext: fileExt(item.relPath) || '.wav' }), data }];
  }

  const audio = await decodeFile(item.file, item.meta?.sampleRate);
  const chans = channelsOf(audio);
  const bd = wavBitDepth();

  if (!splitting) {
    const data = encodeWav(chans, audio.sampleRate, bd);
    return [{ name: buildStemName(s.template, { project: item.project, track: item.track, ext: '.wav' }), data }];
  }

  const refSamples = Math.round(refDurationSec * audio.sampleRate);
  const takes = planTakes(audio.length, refSamples);
  if (!takes.length) {
    // Shorter than one reference length — emit the whole thing as a single stem.
    const data = encodeWav(chans, audio.sampleRate, bd);
    return [{ name: buildStemName(s.template, { project: item.project, track: item.track, ext: '.wav' }), data }];
  }
  // Ensure each take gets a distinct name even if the template lacks a {take} token.
  const takeTpl = s.template.includes('{take}') ? s.template : `${s.template}_{take}`;
  return takes.map((t) => {
    const slice = chans.map((ch) => ch.subarray(t.start, t.end));
    const data = encodeWav(slice, audio.sampleRate, bd);
    return { name: buildStemName(takeTpl, { project: item.project, track: item.track, take: t.index, ext: '.wav' }), data };
  });
}

/** Reference length in seconds, decoding the reference track if the header didn't give it. */
async function referenceDuration() {
  if (!state.settings.split) return 0;
  const ref = state.items.find((i) => i.id === state.settings.refId);
  if (!ref) return 0;
  if (ref.meta?.duration > 0) return ref.meta.duration;
  try {
    const audio = await decodeFile(ref.file, ref.meta?.sampleRate);
    return audio.duration;
  } catch {
    return 0;
  }
}

/** De-duplicate output names within one archive/batch (append _2, _3, …). */
function uniquifyNames(entries) {
  const used = new Map();
  for (const e of entries) {
    let name = e.name;
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = used.get(name) + 1;
      while (used.has(`${stem}_${n}${ext}`)) n++;
      used.set(name, n);
      name = `${stem}_${n}${ext}`;
    }
    used.set(name, used.get(name) ?? 1);
    e.name = name;
  }
  return entries;
}

async function collectEntries(items, onProgress) {
  const refDur = await referenceDuration();
  const entries = [];
  let done = 0;
  for (const item of items) {
    try {
      item.status = 'working';
      renderRowMeta(item);
      const out = await renderItem(item, refDur);
      entries.push(...out);
      item.status = 'done';
    } catch (err) {
      item.status = 'error';
      console.error('Failed on', item.relPath, err);
      setStatus(`Could not process "${item.track}": ${err.message}${audioCtxUnsupported ? ' (this browser lacks Web Audio decoding — use Passthrough)' : ''}`, true);
    }
    renderRowMeta(item);
    onProgress?.(++done, items.length);
  }
  return uniquifyNames(entries);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function selectedItems() {
  return state.items.filter((i) => i.selected);
}

async function downloadZip() {
  const items = selectedItems();
  if (!items.length) return setStatus('Nothing selected.', true);
  setBusy(true);
  try {
    const entries = await collectEntries(items, (d, t) => setStatus(`Processing ${d}/${t}…`));
    if (!entries.length) return setStatus('No output produced.', true);
    const zip = buildZip(entries);
    const projects = [...new Set(items.map((i) => i.project))];
    const name = (projects.length === 1 ? projects[0] : 'logic') + '-stems.zip';
    triggerDownload(new Blob([zip], { type: 'application/zip' }), name);
    setStatus(`Downloaded ${entries.length} file${entries.length === 1 ? '' : 's'} as ${name}.`);
  } finally {
    setBusy(false);
  }
}

async function downloadIndividually() {
  const items = selectedItems();
  if (!items.length) return setStatus('Nothing selected.', true);
  setBusy(true);
  try {
    const entries = await collectEntries(items, (d, t) => setStatus(`Processing ${d}/${t}…`));
    for (const e of entries) triggerDownload(new Blob([e.data]), e.name);
    setStatus(`Downloaded ${entries.length} file${entries.length === 1 ? '' : 's'}.`);
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------------------- render */

function setStatus(msg, isError = false) {
  const s = $('#status');
  s.textContent = msg;
  s.classList.toggle('error', isError);
}

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  $('#zipBtn').disabled = busy;
  $('#dlBtn').disabled = busy;
}

/** Short badge describing where an audio file came from. */
function badgeText(info) {
  if (info.source === 'folder') return 'Folder';
  if (info.inExcluded) return 'Package';
  return info.inMedia ? 'Media' : 'Package';
}

function render() {
  const tbody = $('#list');
  tbody.textContent = '';
  const visible = state.items;
  $('#empty').hidden = visible.length > 0;
  $('#tableWrap').hidden = visible.length === 0;

  // reference dropdown
  const refSel = $('#refSelect');
  refSel.textContent = '';
  for (const i of state.items) {
    refSel.append(el('option', { value: String(i.id), textContent: `${i.project} — ${i.track}`, selected: i.id === state.settings.refId }));
  }

  for (const item of state.items) {
    const cb = el('input', { type: 'checkbox', checked: item.selected });
    cb.addEventListener('change', () => {
      item.selected = cb.checked;
      updateCounts();
    });
    const row = el(
      'tr',
      { dataset: { id: String(item.id) } },
      el('td', {}, cb),
      el('td', { className: 'proj', textContent: item.project }),
      el('td', { className: 'track', textContent: item.track }),
      el('td', {}, el('span', { className: `badge src-${item.info.source}`, textContent: badgeText(item.info) })),
      el('td', { className: 'dur mono', textContent: item.meta?.duration != null ? formatDuration(item.meta.duration) : '…' }),
      el('td', { className: 'size mono', textContent: formatBytes(item.file.size) }),
      el('td', { className: 'refcell' }, item.isRef ? el('span', { className: 'badge ref', textContent: 'REF' }) : ''),
    );
    row.classList.toggle('is-ref', item.isRef);
    tbody.append(row);
  }
  updateCounts();
  updateSplitUI();
  updateWetCommand();
}

function renderRowMeta(item) {
  const row = $(`#list tr[data-id="${item.id}"]`);
  if (!row) return;
  const dur = row.querySelector('.dur');
  if (dur) dur.textContent = item.meta?.duration != null ? formatDuration(item.meta.duration) : '—';
  row.classList.toggle('working', item.status === 'working');
  row.classList.toggle('err', item.status === 'error');
}

function updateCounts() {
  const sel = selectedItems().length;
  $('#selCount').textContent = `${sel} of ${state.items.length} selected`;
  $('#zipBtn').disabled = sel === 0 || document.body.classList.contains('busy');
  $('#dlBtn').disabled = sel === 0 || document.body.classList.contains('busy');
  const all = $('#selectAll');
  all.checked = sel > 0 && sel === state.items.length;
  all.indeterminate = sel > 0 && sel < state.items.length;
}

function updateSplitUI() {
  $('#refRow').hidden = !state.settings.split;
}

function updateWetCommand() {
  const projects = [...new Set(state.items.filter((i) => i.info.source === 'logic').map((i) => `/path/to/${i.project}.logicx`))];
  const cmd = buildBounceCommand({
    projects,
    outputDir: $('#wetOut').value || '~/Desktop/Stems',
    format: $('#wetFormat').value || 'wav',
    bitDepth: 24,
  });
  $('#wetCmd').textContent = cmd;
}

/* ---------------------------------------------------------------------- wire */

function wire() {
  // pickers
  $('#pickDir').addEventListener('change', (e) => {
    ingest([...e.target.files].map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name })));
    e.target.value = '';
  });
  $('#pickFiles').addEventListener('change', (e) => {
    ingest([...e.target.files].map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name })));
    e.target.value = '';
  });

  // drag & drop
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
      drop.classList.remove('over');
    }),
  );
  drop.addEventListener('drop', async (e) => {
    const items = [...(e.dataTransfer?.items || [])];
    const records = [];
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length) {
      for (const entry of entries) await readEntry(entry, records);
    } else {
      for (const f of e.dataTransfer.files) records.push({ file: f, relPath: f.name });
    }
    ingest(records);
  });

  // settings
  $('#fmt').addEventListener('change', (e) => {
    state.settings.format = e.target.value;
  });
  $('#split').addEventListener('change', (e) => {
    state.settings.split = e.target.checked;
    updateSplitUI();
  });
  $('#refSelect').addEventListener('change', (e) => {
    state.settings.refId = Number(e.target.value);
    for (const i of state.items) i.isRef = i.id === state.settings.refId;
    render();
  });
  $('#tpl').addEventListener('input', (e) => {
    state.settings.template = e.target.value || '{project}_{track}';
  });
  $('#includeAll').addEventListener('change', (e) => {
    state.settings.includeAll = e.target.checked;
    // reselect rows according to the new rule
    for (const i of state.items) i.selected = shouldIngest(i.info, { includeAll: state.settings.includeAll });
    updateCounts();
  });

  // wet helper
  $('#wetOut').addEventListener('input', updateWetCommand);
  $('#wetFormat').addEventListener('change', updateWetCommand);
  $('#copyCmd').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#wetCmd').textContent);
      setStatus('Command copied to clipboard.');
    } catch {
      setStatus('Copy failed — select the command and copy manually.', true);
    }
  });
  $('#wetHead').addEventListener('click', () => {
    const card = $('#wetCard');
    card.classList.toggle('open');
    $('#wetToggle').textContent = card.classList.contains('open') ? '－' : '＋';
    $('#wetToggle').setAttribute('aria-expanded', card.classList.contains('open') ? 'true' : 'false');
  });

  // selection + actions
  $('#selectAll').addEventListener('change', (e) => {
    for (const i of state.items) i.selected = e.target.checked;
    render();
  });
  $('#clearBtn').addEventListener('click', () => {
    state.items = [];
    state.settings.refId = null;
    render();
    setStatus('Cleared.');
  });
  $('#zipBtn').addEventListener('click', downloadZip);
  $('#dlBtn').addEventListener('click', downloadIndividually);

  // theme toggle: auto → light → dark
  const themeBtn = $('#themeBtn');
  if (themeBtn) {
    const store = {
      get: () => {
        try { return localStorage.getItem('theme'); } catch { return null; }
      },
      set: (v) => {
        try { localStorage.setItem('theme', v); } catch { /* ignore */ }
      },
    };
    const apply = (t) => {
      if (t === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
      themeBtn.textContent = t === 'dark' ? '🌙' : t === 'light' ? '☀️' : '🌗';
      themeBtn.title = `Theme: ${t} (click to change)`;
    };
    let cur = store.get() || 'auto';
    apply(cur);
    themeBtn.addEventListener('click', () => {
      cur = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
      store.set(cur);
      apply(cur);
    });
  }

  render();
  setStatus('Drop a .logicx project folder or an audio folder to begin.');
}

document.addEventListener('DOMContentLoaded', wire);
