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
import * as companion from './companion.js';

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

// Bit depth for a decoded/encoded output. When splitting under "passthrough" we still have to
// decode+re-encode, so preserve the source's own depth (24-bit sources stay 24-bit) instead of
// silently quantizing to 16-bit.
function outputBitDepth(item) {
  if (state.settings.format === 'wav24') return 24;
  if (state.settings.format === 'wav16') return 16;
  return item?.meta?.bitDepth >= 24 ? 24 : 16; // passthrough being decoded for a split
}

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
  const bd = outputBitDepth(item);

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

/* ------------------------------------------ File System Access: save to a folder */

// Tiny IndexedDB key/value store, used to remember the chosen output directory handle so the
// user picks their folder once and the app can write straight into it on later visits.
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('stem-exporter', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const q = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// Reuse a remembered directory if we still have permission; otherwise show the picker.
async function getOutputDir() {
  try {
    const saved = await idbGet('outdir');
    if (saved) {
      if ((await saved.queryPermission?.({ mode: 'readwrite' })) === 'granted') return saved;
      if ((await saved.requestPermission?.({ mode: 'readwrite' })) === 'granted') return saved;
    }
  } catch {
    /* fall through to the picker */
  }
  const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'stem-exporter-out' });
  try {
    await idbSet('outdir', dir);
  } catch {
    /* persistence is best-effort */
  }
  return dir;
}

async function saveToFolder() {
  const items = selectedItems();
  if (!items.length) return setStatus('Nothing selected.', true);
  let dir;
  try {
    dir = await getOutputDir();
  } catch (err) {
    if (err && err.name !== 'AbortError') setStatus(`Could not open a folder: ${err.message}`, true);
    return; // user cancelled the picker
  }
  setBusy(true);
  try {
    const entries = await collectEntries(items, (d, t) => setStatus(`Processing ${d}/${t}…`));
    let n = 0;
    for (const e of entries) {
      const handle = await dir.getFileHandle(e.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(e.data);
      await writable.close();
      n++;
    }
    setStatus(`Wrote ${n} file${n === 1 ? '' : 's'} to “${dir.name}”.`);
  } catch (err) {
    setStatus(`Write failed: ${err.message}`, true);
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
  for (const id of ['#zipBtn', '#dlBtn', '#folderBtn']) {
    const b = $(id);
    if (b) b.disabled = busy;
  }
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
  const disabled = sel === 0 || document.body.classList.contains('busy');
  for (const id of ['#zipBtn', '#dlBtn', '#folderBtn']) {
    const b = $(id);
    if (b) b.disabled = disabled;
  }
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
    // reselect rows according to the new rule, then re-render so the row checkboxes match
    for (const i of state.items) i.selected = shouldIngest(i.info, { includeAll: state.settings.includeAll });
    render();
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
  wireCollapse('#wetHead', '#wetCard', '#wetToggle');
  wireCollapse('#companionHead', '#companionCard', '#companionToggle');
  wireCompanion();

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

  // "Save to folder" only where the File System Access API exists (Chromium desktop); the ZIP
  // download is the universal fallback everywhere else.
  const folderBtn = $('#folderBtn');
  if (folderBtn && 'showDirectoryPicker' in window) {
    folderBtn.hidden = false;
    folderBtn.addEventListener('click', saveToFolder);
  }

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

/* --------------------------------------------------------- collapsible cards */

function wireCollapse(headSel, cardSel, toggleSel) {
  const head = $(headSel);
  const card = $(cardSel);
  if (!head || !card) return;
  head.addEventListener('click', () => {
    const open = card.classList.toggle('open');
    const t = $(toggleSel);
    if (t) {
      t.textContent = open ? '－' : '＋';
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  });
}

function openCollapse(cardSel, toggleSel) {
  const card = $(cardSel);
  if (!card || card.classList.contains('open')) return;
  card.classList.add('open');
  const t = $(toggleSel);
  if (t) {
    t.textContent = '－';
    t.setAttribute('aria-expanded', 'true');
  }
}

/* ------------------------------------------------------------ local companion */

function setCompanionStatus(text, on) {
  const s = $('#companionStatus');
  s.textContent = text;
  s.classList.toggle('on', !!on);
}

function cxSetResult(text, isError) {
  const r = $('#cxResult');
  r.textContent = text || '';
  r.style.color = isError ? 'var(--err)' : '';
}

function refreshWetGate() {
  const info = companion.current()?.info;
  const b = $('#cxWet');
  if (b) {
    b.disabled = !info?.logic;
    b.title = info?.logic ? '' : 'Logic Pro was not detected on the companion machine';
  }
}

function setBusyCx(busy, msg) {
  for (const id of ['#cxDry', '#cxWet', '#cxScan', '#cxConnect', '#cxDisconnect']) {
    const b = $(id);
    if (b) b.disabled = busy;
  }
  if (!busy) refreshWetGate();
  if (busy && msg) cxSetResult(msg);
}

function showCompanionConnected(info) {
  $('#connectForm').hidden = true;
  $('#connectedPanel').hidden = false;
  $('#cxInfo').textContent = [
    `companion ${info.version}`,
    info.macos ? 'macOS' : info.platform,
    info.logic ? 'Logic Pro detected' : 'Logic Pro not found',
  ].join(' · ');
  setCompanionStatus('Connected', true);
  refreshWetGate();
}

function showCompanionDisconnected() {
  $('#connectForm').hidden = false;
  $('#connectedPanel').hidden = true;
  setCompanionStatus('Not connected', false);
}

async function companionConnect(base, token, { announce = true } = {}) {
  try {
    const info = await companion.connect({ base, token });
    showCompanionConnected(info);
    openCollapse('#companionCard', '#companionToggle');
    return true;
  } catch (err) {
    if (announce) {
      setCompanionStatus('Connection failed', false);
      cxSetResult(`Could not connect: ${err.message}. Is the companion running, and the token correct?`, true);
    }
    return false;
  }
}

function summarizeRun(data) {
  const lines = [data.ok ? '✓ done' : `✗ failed (exit ${data.code})`];
  if (data.files?.length) lines.push(`${data.files.length} file(s) in ${data.out}:`, ...data.files.map((f) => '  ' + f));
  if (data.stdout?.trim()) lines.push('', data.stdout.trim());
  if (data.stderr?.trim()) lines.push('', data.stderr.trim());
  return lines.join('\n');
}

function renderProjectHits(projects) {
  const box = $('#cxProjects');
  box.textContent = '';
  if (!projects?.length) {
    box.append(el('span', { className: 'hint', textContent: 'No .logicx projects found there.' }));
    return;
  }
  box.append(el('span', { className: 'hint', textContent: 'Found — click to use: ' }));
  for (const p of projects) {
    const b = el('button', { className: 'btn small project-hit', textContent: p.name, title: p.path });
    b.addEventListener('click', () => {
      $('#cxProject').value = p.path;
    });
    box.append(b);
  }
}

function wireCompanion() {
  $('#copyRun').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#companionRun').textContent);
      cxSetResult('Command copied to clipboard.');
    } catch {
      cxSetResult('Copy failed — select the command and copy manually.', true);
    }
  });

  $('#cxConnect').addEventListener('click', async () => {
    const base = companion.normalizeBase($('#cxUrl').value);
    const token = $('#cxToken').value.trim();
    if (!base || !token) return cxSetResult('Enter the companion address and pairing token.', true);
    setCompanionStatus('Connecting…', false);
    await companionConnect(base, token);
  });

  $('#cxDisconnect').addEventListener('click', () => {
    companion.forget();
    showCompanionDisconnected();
    cxSetResult('');
  });

  $('#cxScan').addEventListener('click', async () => {
    const dir = $('#cxProject').value.trim();
    if (!dir) return cxSetResult('Enter a folder to scan for .logicx projects.', true);
    try {
      const { projects } = await companion.listProjects(dir);
      renderProjectHits(projects);
    } catch (err) {
      cxSetResult(`Scan failed: ${err.message}`, true);
    }
  });

  $('#cxDry').addEventListener('click', async () => {
    const project = $('#cxProject').value.trim();
    const out = $('#cxOut').value.trim();
    if (!project || !out) return cxSetResult('Enter a project path and an output folder.', true);
    setBusyCx(true, 'Extracting dry stems…');
    try {
      const data = await companion.extractDry({
        project,
        out,
        template: state.settings.template,
        split: state.settings.split,
        includeAll: state.settings.includeAll,
      });
      cxSetResult(summarizeRun(data), !data.ok);
    } catch (err) {
      cxSetResult(`Failed: ${err.message}`, true);
    } finally {
      setBusyCx(false);
    }
  });

  $('#cxWet').addEventListener('click', async () => {
    const project = $('#cxProject').value.trim();
    const out = $('#cxOut').value.trim();
    if (!project || !out) return cxSetResult('Enter a project path and an output folder.', true);
    setBusyCx(true, 'Bouncing all tracks in Logic Pro… (this drives Logic — watch for permission prompts)');
    try {
      const data = await companion.bounceWet({ projects: [project], out, format: $('#cxFormat').value, bitDepth: $('#cxDepth').value });
      cxSetResult(summarizeRun(data), !data.ok);
    } catch (err) {
      cxSetResult(`Failed: ${err.message}`, true);
    } finally {
      setBusyCx(false);
    }
  });

  // Auto-pair from the URL fragment (set by `stem-companion.py --open`), else a saved session.
  const pair = companion.readPairingFromHash();
  if (pair) {
    history.replaceState(null, '', location.pathname + location.search); // strip the token from the visible URL
    $('#cxUrl').value = pair.base.replace(/^https?:\/\//, '');
    $('#cxToken').value = pair.token;
    companionConnect(pair.base, pair.token, { announce: false });
  } else {
    const saved = companion.loadSaved();
    if (saved) {
      $('#cxUrl').value = saved.base.replace(/^https?:\/\//, '');
      $('#cxToken').value = saved.token;
      companionConnect(saved.base, saved.token, { announce: false });
    }
  }
}

document.addEventListener('DOMContentLoaded', wire);

// Register the service worker so the app installs as a PWA and works offline.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
