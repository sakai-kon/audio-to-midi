import * as ort from 'onnxruntime-web';
import { CONSTANTS, DemucsProcessor } from 'demucs-web';
import {
  AudioToMidiError,
  AudioToMidiConverter,
  audioToMidiDefaults,
} from '@musicbento/audio-to-midi';
import './style.css';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 8 * 60;
const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'];
const STEMS = ['vocals', 'bass', 'other', 'drums'];
const $ = (selector) => document.querySelector(selector);
const fileInput = $('#file-input');
const dropzone = $('#dropzone');
const fileCard = $('#file-card');
const fileName = $('#file-name');
const fileMeta = $('#file-meta');
const audioPlayer = $('#audio-player');
const convertButton = $('#convert-button');
const removeFileButton = $('#remove-file');
const progressPanel = $('#progress-panel');
const progressBar = $('#progress-bar');
const progressPercent = $('#progress-percent');
const statusText = $('#status-text');
const resultPanel = $('#result-panel');
const stats = $('#stats');
const downloadButton = $('#download-button');
const resetButton = $('#reset-button');

let selectedFile = null;
let latestBlob = null;
let objectUrl = null;
let conversionBusy = false;
let separator = null;
let separatorReady = false;
let midiConverter = null;
let cpuMidiConverter = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function extensionOf(name) { return name.includes('.') ? name.split('.').pop().toLowerCase() : ''; }
function setProgress(value, status) {
  const safe = Math.max(0, Math.min(1, value));
  const percent = Math.round(safe * 100);
  progressBar.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  if (status) statusText.textContent = status;
}
function showError(message) { statusText.textContent = message; statusText.classList.add('error-text'); }
function clearError() { statusText.classList.remove('error-text'); }
function reset() {
  if (conversionBusy) return;
  selectedFile = null;
  latestBlob = null;
  fileInput.value = '';
  fileCard.classList.add('hidden');
  audioPlayer.classList.add('hidden');
  audioPlayer.removeAttribute('src');
  convertButton.disabled = true;
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
  clearError();
  setProgress(0, '準備しています…');
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

async function getAudioDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      const cleanup = () => { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); };
      audio.addEventListener('loadedmetadata', () => {
        const value = audio.duration;
        cleanup();
        Number.isFinite(value) ? resolve(value) : reject(new Error('invalid-duration'));
      }, { once: true });
      audio.addEventListener('error', () => { cleanup(); reject(new Error('audio-decode-failed')); }, { once: true });
      audio.src = url;
    });
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

async function inspectFile(file) {
  clearError();
  if (!file) return;
  const extension = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    showError('対応していない形式です。MP3 / WAV / M4A / AAC / OGG / FLAC / WebMを選択してください。');
    return;
  }
  if (file.size > MAX_BYTES) { showError('ファイルが大きすぎます。100 MB以下の音声を選択してください。'); return; }
  try {
    const duration = await getAudioDuration(file);
    if (duration > MAX_SECONDS) { showError('音声が長すぎます。8分以内の音声を選択してください。'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    selectedFile = file;
    latestBlob = null;
    fileName.textContent = file.name;
    fileMeta.textContent = `${formatBytes(file.size)} · ${formatDuration(duration)}`;
    fileCard.classList.remove('hidden');
    audioPlayer.src = objectUrl;
    audioPlayer.classList.remove('hidden');
    convertButton.disabled = false;
    resultPanel.classList.add('hidden');
  } catch {
    showError('この音声をブラウザで読み込めませんでした。別の形式の音声で試してください。');
    convertButton.disabled = true;
  }
}

function statusLabel(status) {
  return ({
    'loading-separator': '音源分離AIモデルを読み込んでいます…',
    'decoding-audio': '音声を解析用データに変換しています…',
    separating: '音源をボーカル・ベース・その他・ドラムに分離しています…',
    'loading-model': 'MIDI変換AIモデルを読み込んでいます…',
    transcribing: '分離した音源を個別にMIDI化しています…',
    'preparing-midi': 'MIDIを統合しています…',
  })[status] ?? '解析しています…';
}

function getOrCreateSeparator() {
  if (separator) return separator;
  ort.env.wasm.numThreads = 1;
  separator = new DemucsProcessor({
    ort,
    sessionOptions: {
      enableCpuMemArena: false,
      enableMemPattern: false,
      executionProviders: ['webgpu', 'wasm'],
    },
    onProgress: ({ progress }) => setProgress(0.05 + progress * 0.45, '音源を分離しています…'),
  });
  return separator;
}

async function decodeStereo(file) {
  const context = new AudioContext({ sampleRate: CONSTANTS.SAMPLE_RATE });
  try {
    const data = await file.arrayBuffer();
    const buffer = await context.decodeAudioData(data.slice(0));
    const length = buffer.length;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    const l = buffer.getChannelData(0);
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
    left.set(l);
    right.set(r);
    return { left, right };
  } finally {
    await context.close();
  }
}

function pcm16(value) {
  const sample = Math.max(-1, Math.min(1, value));
  return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
}
function stemToWav(stem, sampleRate) {
  const length = Math.min(stem.left.length, stem.right.length);
  const bytes = new Uint8Array(44 + length * 4);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + length * 4, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * 4, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) { view.setInt16(offset, pcm16(stem.left[i]), true); view.setInt16(offset + 2, pcm16(stem.right[i]), true); offset += 4; }
  return new File([bytes], `${stem.name}.wav`, { type: 'audio/wav' });
}

function readVarInt(bytes, index) {
  let value = 0;
  for (let count = 0; count < 4; count += 1) {
    if (index >= bytes.length) throw new Error('invalid-midi-varint');
    const byte = bytes[index++]; value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: index };
  }
  throw new Error('invalid-midi-varint');
}
function writeVarInt(value) {
  let buffer = value & 0x7f; const result = [];
  while ((value >>= 7)) { buffer <<= 8; buffer |= (value & 0x7f) | 0x80; }
  while (true) { result.push(buffer & 0xff); if (buffer & 0x80) buffer >>= 8; else return result; }
}
function u32(bytes, index) { return ((bytes[index] << 24) | (bytes[index + 1] << 16) | (bytes[index + 2] << 8) | bytes[index + 3]) >>> 0; }
function putU32(value) { return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]; }
function putU16(value) { return [(value >>> 8) & 255, value & 255]; }

function parseMidi(bytes) {
  if (bytes.length < 14 || String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') throw new Error('not-midi');
  const headerLength = u32(bytes, 4); const format = (bytes[8] << 8) | bytes[9]; const trackCount = (bytes[10] << 8) | bytes[11]; const division = (bytes[12] << 8) | bytes[13];
  if (headerLength < 6 || division & 0x8000) throw new Error('unsupported-midi-division');
  let offset = 8 + headerLength; const tracks = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (offset + 8 > bytes.length || String.fromCharCode(...bytes.slice(offset, offset + 4)) !== 'MTrk') throw new Error('invalid-midi-track');
    const length = u32(bytes, offset + 4); const start = offset + 8; const end = start + length;
    if (end > bytes.length) throw new Error('invalid-midi-track-length');
    let cursor = start; let absoluteTick = 0; let runningStatus = null; const events = [];
    while (cursor < end) {
      const delta = readVarInt(bytes, cursor); cursor = delta.next; absoluteTick += delta.value;
      if (cursor >= end) break;
      let status = bytes[cursor];
      if (status < 0x80) { if (runningStatus === null) throw new Error('invalid-midi-running-status'); status = runningStatus; }
      else { cursor += 1; if (status < 0xf0) runningStatus = status; else runningStatus = null; }
      const type = status & 0xf0; let data = [];
      if (status === 0xff) {
        if (cursor >= end) throw new Error('invalid-meta');
        const metaType = bytes[cursor++]; const lengthInfo = readVarInt(bytes, cursor); cursor = lengthInfo.next;
        const metaEnd = cursor + lengthInfo.value; if (metaEnd > end) throw new Error('invalid-meta-length');
        data = [metaType, ...bytes.slice(cursor, metaEnd)]; cursor = metaEnd;
      } else if (status === 0xf0 || status === 0xf7) {
        const lengthInfo = readVarInt(bytes, cursor); cursor = lengthInfo.next; const sysexEnd = cursor + lengthInfo.value;
        if (sysexEnd > end) throw new Error('invalid-sysex-length'); data = bytes.slice(cursor, sysexEnd); cursor = sysexEnd;
      } else {
        const dataLength = type === 0xc0 || type === 0xd0 ? 1 : 2;
        if (cursor + dataLength > end) throw new Error('invalid-midi-event'); data = bytes.slice(cursor, cursor + dataLength); cursor += dataLength;
      }
      events.push({ tick: absoluteTick, status, data });
    }
    tracks.push(events); offset = end;
  }
  return { format, division, tracks };
}

function encodeMidi(parsed) {
  const output = [0x4d,0x54,0x68,0x64,0,0,0,6,...putU16(1),...putU16(parsed.tracks.length),...putU16(parsed.division)];
  for (const events of parsed.tracks) {
    const track = []; let previousTick = 0;
    for (const event of events) { track.push(...writeVarInt(Math.max(0, event.tick - previousTick)), event.status, ...event.data); previousTick = event.tick; }
    output.push(0x4d,0x54,0x72,0x6b,...putU32(track.length),...track);
  }
  return new Uint8Array(output);
}
function addTrackName(events, name) {
  const bytes = [...new TextEncoder().encode(name)];
  return [{ tick: 0, status: 0xff, data: [0x03, ...bytes] }, ...events];
}

function getMidiConverter(useCpu = false) {
  if (useCpu && cpuMidiConverter) return cpuMidiConverter;
  if (!useCpu && midiConverter) return midiConverter;
  const options = { ...audioToMidiDefaults };
  if (useCpu) options.backend = 'cpu';
  const instance = new AudioToMidiConverter(options);
  if (useCpu) cpuMidiConverter = instance; else midiConverter = instance;
  return instance;
}
function isLikelyGpuFailure(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  return text.includes('webgl') || text.includes('webgpu') || text.includes('shader') || text.includes('backend') || text.includes('gpu');
}
async function convertStem(stem, index, total) {
  const file = stemToWav(stem, CONSTANTS.SAMPLE_RATE);
  const base = 0.55 + (index / total) * 0.4;
  const onStatus = ({ status }) => setProgress(base, statusLabel(status));
  const onProgress = ({ progress }) => setProgress(base + (progress / total) * 0.4, statusLabel('transcribing'));
  try {
    return await getMidiConverter(false).convert(file, { onStatus, onProgress });
  } catch (error) {
    if (!isLikelyGpuFailure(error)) throw error;
    return getMidiConverter(true).convert(file, { onStatus, onProgress });
  }
}

async function separateAndConvert(file) {
  setProgress(0.02, statusLabel('loading-separator'));
  const processor = getOrCreateSeparator();
  if (!separatorReady) { await processor.loadModel(CONSTANTS.DEFAULT_MODEL_URL); separatorReady = true; }
  setProgress(0.05, statusLabel('decoding-audio'));
  const stereo = await decodeStereo(file);
  const separated = await processor.separate(stereo.left, stereo.right);
  const results = []; let division = 480;
  const available = STEMS.filter((name) => separated[name]?.left?.length && separated[name]?.right?.length);
  if (!available.length) throw new Error('no-separated-stems');
  for (let i = 0; i < available.length; i += 1) {
    const name = available[i];
    setProgress(0.55 + (i / available.length) * 0.4, `${name} をMIDI化しています…`);
    const midi = await convertStem({ name, ...separated[name] }, i, available.length);
    const parsed = parseMidi(new Uint8Array(await midi.midiBlob.arrayBuffer()));
    if (i === 0) division = parsed.division;
    for (const track of parsed.tracks) results.push(addTrackName(track, name));
  }
  if (!results.length) throw new Error('no-midi-tracks');
  return { bytes: encodeMidi({ format: 1, division, tracks: results }), stemCount: available.length };
}

async function convert() {
  if (!selectedFile || conversionBusy) return;
  conversionBusy = true; convertButton.disabled = true; progressPanel.classList.remove('hidden'); resultPanel.classList.add('hidden'); clearError();
  try {
    const { bytes, stemCount } = await separateAndConvert(selectedFile);
    latestBlob = new Blob([bytes], { type: 'audio/midi' });
    stats.textContent = `${stemCount}音源を分離 → 個別MIDI化 → 統合 · ${formatBytes(bytes.length)}`;
    resultPanel.classList.remove('hidden'); setProgress(1, '変換が完了しました。');
  } catch (error) {
    console.error(error);
    const message = error instanceof AudioToMidiError ? error.message : String(error?.message ?? error);
    showError(`変換に失敗しました。${message}`);
  } finally {
    conversionBusy = false; convertButton.disabled = !selectedFile;
  }
}

convertButton.addEventListener('click', convert);
removeFileButton.addEventListener('click', reset);
resetButton.addEventListener('click', reset);
downloadButton.addEventListener('click', () => {
  if (!latestBlob) return;
  const url = URL.createObjectURL(latestBlob); const link = document.createElement('a');
  link.href = url; link.download = `${selectedFile?.name.replace(/\.[^.]+$/, '') || 'converted'}-separated.mid`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
});
fileInput.addEventListener('change', (event) => inspectFile(event.target.files?.[0]));
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (event) => { event.preventDefault(); dropzone.classList.remove('dragover'); inspectFile(event.dataTransfer.files?.[0]); });
