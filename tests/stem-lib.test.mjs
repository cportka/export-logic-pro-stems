// stem-lib.test.mjs — unit tests for the pure helpers shared by the browser app.
// Run with `node --test` (also invoked by `npm test` and tests/run-tests.sh via CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAudioFile,
  fileExt,
  baseName,
  stripExt,
  sanitizeName,
  buildStemName,
  classifyPath,
  shouldIngest,
  isReferenceTrack,
  planTakes,
  encodeWav,
  parseWavHeader,
  parseAiffHeader,
  probeAudioHeader,
  crc32,
  buildZip,
  formatBytes,
  formatDuration,
  buildBounceCommand,
} from '../docs/js/stem-lib.js';

test('path & name helpers', () => {
  assert.equal(isAudioFile('Kick.WAV'), true);
  assert.equal(isAudioFile('vox.aiff'), true);
  assert.equal(isAudioFile('notes.txt'), false);
  assert.equal(fileExt('Kick.WAV'), '.wav');
  assert.equal(fileExt('noext'), '');
  assert.equal(baseName('a/b/c.wav'), 'c.wav');
  assert.equal(baseName('a\\b\\c.wav'), 'c.wav');
  assert.equal(stripExt('Track 1.aif'), 'Track 1');
});

test('sanitizeName neutralizes path traversal and illegal chars', () => {
  assert.equal(sanitizeName('Lead Vox'), 'Lead Vox'); // spaces are valid & readable, kept
  assert.equal(sanitizeName('Sub-Bass'), 'Sub-Bass'); // hyphens kept
  assert.equal(sanitizeName('a/b'), 'a_b');
  assert.equal(sanitizeName('../etc'), '_etc'); // leading dots stripped, slash neutralized
  assert.equal(sanitizeName('   '), 'untitled'); // empty after trim
  assert.ok(!sanitizeName('a/../../b').includes('/'));
});

test('buildStemName fills tokens and cleans up empties', () => {
  assert.equal(buildStemName('{project}_{track}', { project: 'My Song', track: 'Lead Vox', ext: '.wav' }), 'My Song_Lead Vox.wav');
  assert.equal(buildStemName('{project}_{track}_{take}', { project: 'P', track: 'T', take: 2, ext: 'wav' }), 'P_T_Take2.wav');
  // empty take must not leave a dangling separator
  assert.equal(buildStemName('{project}_{track}_{take}', { project: 'P', track: 'T', take: null, ext: 'wav' }), 'P_T.wav');
});

test('buildStemName inserts $-sequences literally and supports an {ext} token', () => {
  // a raw String.replace would treat $& / $$ in a name as replacement patterns
  assert.equal(buildStemName('{project}_{track}', { project: 'A$&B', track: 'T', ext: '.wav' }), 'A$&B_T.wav');
  assert.equal(buildStemName('{project}_{track}', { project: 'A$$B', track: 'T', ext: '.wav' }), 'A$$B_T.wav');
  // {ext} token is substituted and not double-appended
  assert.equal(buildStemName('{project}_{track}{ext}', { project: 'P', track: 'T', ext: '.wav' }), 'P_T.wav');
});

test('buildZip rejects more than 65535 entries', () => {
  const many = Array.from({ length: 65536 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }));
  assert.throws(() => buildZip(many), /65535/);
});

test('classifyPath understands .logicx packages and plain folders', () => {
  const media = classifyPath('MySong.logicx/Media/Track 1.aif');
  assert.deepEqual(media, { project: 'MySong', source: 'logic', inMedia: true, inExcluded: false, name: 'Track 1.aif' });

  const audioFiles = classifyPath('MySong.logicx/Audio Files/vox.wav');
  assert.equal(audioFiles.inMedia, true);

  const freeze = classifyPath('MySong.logicx/Freeze Files/x.aif');
  assert.equal(freeze.inExcluded, true);
  assert.equal(freeze.inMedia, false);

  const folder = classifyPath('Stems/kick.wav');
  assert.deepEqual(folder, { project: 'Stems', source: 'folder', inMedia: true, inExcluded: false, name: 'kick.wav' });
});

test('shouldIngest respects Media restriction and includeAll override', () => {
  assert.equal(shouldIngest(classifyPath('P.logicx/Media/a.wav')), true);
  assert.equal(shouldIngest(classifyPath('P.logicx/Freeze Files/a.wav')), false);
  assert.equal(shouldIngest(classifyPath('P.logicx/Freeze Files/a.wav'), { includeAll: true }), true);
  assert.equal(shouldIngest(classifyPath('Loose/a.wav')), true);
});

test('isReferenceTrack matches COMP/ROUGH and the project name', () => {
  assert.equal(isReferenceTrack('Song_COMP.wav'), true);
  assert.equal(isReferenceTrack('rough_mix.aif'), true);
  assert.equal(isReferenceTrack('guitar.wav'), false);
  assert.equal(isReferenceTrack('MySong_ref.wav', { projectName: 'MySong' }), true);
});

test('planTakes mirrors floor(total/ref) splitting', () => {
  assert.deepEqual(planTakes(900, 300), [
    { index: 1, start: 0, end: 300 },
    { index: 2, start: 300, end: 600 },
    { index: 3, start: 600, end: 900 },
  ]);
  assert.deepEqual(planTakes(1000, 300), [
    { index: 1, start: 0, end: 300 },
    { index: 2, start: 300, end: 600 },
    { index: 3, start: 600, end: 900 },
  ]);
  assert.deepEqual(planTakes(200, 300), []);
  assert.deepEqual(planTakes(500, 0), []);
});

test('encodeWav writes a valid 16-bit PCM header and samples', () => {
  const wav = encodeWav([Float32Array.from([0.5, -0.5])], 44100, 16);
  assert.equal(wav.length, 44 + 2 * 2); // 2 frames * mono * 2 bytes
  const dv = new DataView(wav.buffer);
  const tag = (o) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(tag(36), 'data');
  assert.equal(dv.getUint16(22, true), 1); // channels
  assert.equal(dv.getUint32(24, true), 44100); // sample rate
  assert.equal(dv.getUint16(34, true), 16); // bit depth
  assert.equal(dv.getUint32(40, true), 4); // data size
  assert.equal(dv.getInt16(44, true), Math.round(0.5 * 0x7fff)); // 16384
  assert.equal(dv.getInt16(46, true), Math.round(-0.5 * 0x8000)); // -16384
});

test('encodeWav supports 24-bit and clamps out-of-range samples', () => {
  const wav = encodeWav([Float32Array.from([2.0])], 48000, 24); // 2.0 clamps to +1.0
  assert.equal(wav.length, 44 + 3);
  // little-endian 24-bit max positive = 0x7FFFFF
  assert.equal(wav[44], 0xff);
  assert.equal(wav[45], 0xff);
  assert.equal(wav[46], 0x7f);
});

test('parseWavHeader round-trips encodeWav output', () => {
  const wav = encodeWav([new Float32Array(4410)], 44100, 16);
  const meta = parseWavHeader(wav);
  assert.equal(meta.sampleRate, 44100);
  assert.equal(meta.channels, 1);
  assert.equal(meta.bitDepth, 16);
  assert.equal(meta.frames, 4410);
  assert.ok(Math.abs(meta.duration - 0.1) < 1e-9);
  assert.equal(parseWavHeader(new Uint8Array([1, 2, 3])), null);
});

test('parseAiffHeader reads a COMM chunk (big-endian, 80-bit sample rate)', () => {
  // Canonical 80-bit extended float bytes for 44100 Hz.
  const sr = [0x40, 0x0e, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const comm = [];
  comm.push(0x00, 0x02); // channels = 2
  comm.push(0x00, 0x00, 0x2b, 0x11); // numSampleFrames = 11025
  comm.push(0x00, 0x18); // sampleSize = 24
  comm.push(...sr);
  const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const body = [];
  body.push(0x43, 0x4f, 0x4d, 0x4d); // 'COMM'
  body.push(...be32(comm.length));
  body.push(...comm);
  const form = [];
  form.push(0x46, 0x4f, 0x52, 0x4d); // 'FORM'
  form.push(...be32(4 + body.length)); // size = 'AIFF' + body
  form.push(0x41, 0x49, 0x46, 0x46); // 'AIFF'
  form.push(...body);
  const buf = Uint8Array.from(form);
  const meta = parseAiffHeader(buf);
  assert.equal(meta.sampleRate, 44100);
  assert.equal(meta.channels, 2);
  assert.equal(meta.bitDepth, 24);
  assert.equal(meta.frames, 11025);
  assert.ok(Math.abs(meta.duration - 0.25) < 1e-9);
  assert.equal(probeAudioHeader(buf).sampleRate, 44100); // probe falls through to AIFF
});

test('crc32 matches the standard test vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('buildZip produces an archive an independent reader can extract', () => {
  const files = [
    { name: 'a.txt', data: new TextEncoder().encode('hello') },
    { name: 'folder/b.bin', data: Uint8Array.from([0, 1, 2, 253, 254, 255]) },
  ];
  const zip = buildZip(files);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'EOCD signature');
  const count = dv.getUint16(eocd + 10, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  assert.equal(count, files.length);

  let p = cdOff;
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'central dir signature');
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const lho = dv.getUint32(p + 42, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(lho, true), 0x04034b50, 'local header signature');
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const data = zip.subarray(dataStart, dataStart + size);
    const expected = files.find((f) => f.name === name);
    assert.ok(expected, `entry ${name} exists in input`);
    assert.deepEqual(Uint8Array.from(data), expected.data, 'stored bytes match');
    assert.equal(crc, crc32(expected.data), 'recorded CRC matches data');
    p += 46 + nameLen;
  }
});

test('display + command helpers', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(NaN), '—');
  assert.equal(
    buildBounceCommand({ projects: ['/a/My Song.logicx'], outputDir: '~/Stems', format: 'wav', bitDepth: 24 }),
    './scripts/bounce-wet-stems.sh --out "~/Stems" --format wav --bit-depth 24 "/a/My Song.logicx"',
  );
});
