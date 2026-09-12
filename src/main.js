import {
  AudioToMidiError,
  AudioToMidiConverter,
  audioToMidiDefaults,
} from '@musicbento/audio-to-midi';
import './style.css';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 8 * 60;
const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'];

// Voice recordings often produce tiny same-pitch note fragments around consonants,
// vibrato and pitch-tracking jitter. These conservative limits join only very short
// fragments, so intentional notes are left alone.
const VOICE_SMOOTH_MAX_GAP_TICKS = 18;
const VOICE_SMOOTH_MAX_FRAGMENT_TICKS = 30;

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
let latestResult = null;
let objectUrl = null;
let converter = null;
let cpuConverter = null;
let conversionBusy = false;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function extensionOf(name) {
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}

function setProgress(value, status) {
  const safe = Math.max(0, Math.min(1, value));
  const percent = Math.round(safe * 100);
  progressBar.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  if (status) statusText.textContent = status;
}

function showError(message) {
  statusText.textContent = message;
  statusText.classList.add('error-text');
}

function clearError() {
  statusText.classList.remove('error-text');
}

function reset() {
  if (conversionBusy) return;
  selectedFile = null;
  latestResult = null;
  fileInput.value = '';
  fileCard.classList.add('hidden');
  audioPlayer.classList.add('hidden');
  audioPlayer.removeAttribute('src');
  convertButton.disabled = true;
  progressPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
  clearError();
  setProgress(0, '準備しています…');
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

async function getAudioDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    const duration = await new Promise((resolve, reject) => {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      const cleanup = () => {
        audio.removeAttribute('src');
        audio.load();
        URL.revokeObjectURL(url);
      };
      audio.addEventListener('loadedmetadata', () => {
        const value = audio.duration;
        cleanup();
        Number.isFinite(value) ? resolve(value) : reject(new Error('invalid-duration'));
      }, { once: true });
      audio.addEventListener('error', () => {
        cleanup();
        reject(new Error('audio-decode-failed'));
      }, { once: true });
      audio.src = url;
    });
    return duration;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function inspectFile(file) {
  clearError();
  if (!file) return;

  const extension = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    showError('対応していない形式です。MP3 / WAV / M4A / AAC / OGG / FLAC / WebMを選択してください。');
    return;
  }

  if (file.size > MAX_BYTES) {
    showError('ファイルが大きすぎます。100 MB以下の音声を選択してください。');
    return;
  }

  try {
    const duration = await getAudioDuration(file);
    if (duration > MAX_SECONDS) {
      showError('音声が長すぎます。8分以内の音声を選択してください。');
      return;
    }

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    selectedFile = file;
    latestResult = null;

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
  return {
    'loading-model': 'AIモデルを読み込んでいます…',
    'decoding-audio': '音声を解析用データに変換しています…',
    transcribing: 'AIが音高・発音タイミングを解析しています…',
    'preparing-midi': '検出したノートからMIDIを生成しています…',
  }[status] ?? '解析しています…';
}

function isLikelyWebGLFailure(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  return text.includes('webgl') || text.includes('shader') || text.includes('backend') || text.includes('gpu');
}

function readVarInt(bytes, index) {
  let value = 0;
  let count = 0;
  while (index < bytes.length && count < 4) {
    const byte = bytes[index++];
    value = (value << 7) | (byte & 0x7f);
    count += 1;
    if (!(byte & 0x80)) return { value, next: index };
  }
  throw new Error('invalid-midi-varint');
}

function writeVarInt(value) {
  let buffer = value & 0x7f;
  const result = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    result.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return result;
}

function u32(bytes, index) {
  return ((bytes[index] << 24) | (bytes[index + 1] << 16) | (bytes[index + 2] << 8) | bytes[index + 3]) >>> 0;
}

function putU32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function putU16(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function parseMidi(bytes) {
  if (bytes.length < 14 || String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') throw new Error('not-midi');
  const headerLength = u32(bytes, 4);
  const format = (bytes[8] << 8) | bytes[9];
  const trackCount = (bytes[10] << 8) | bytes[11];
  const division = (bytes[12] << 8) | bytes[13];
  if (division & 0x8000 || headerLength < 6) throw new Error('unsupported-midi-division');

  let offset = 8 + headerLength;
  const tracks = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (offset + 8 > bytes.length || String.fromCharCode(...bytes.slice(offset, offset + 4)) !== 'MTrk') throw new Error('invalid-midi-track');
    const length = u32(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new Error('invalid-midi-track-length');

    let cursor = start;
    let absoluteTick = 0;
    let runningStatus = null;
    const events = [];
    while (cursor < end) {
      const delta = readVarInt(bytes, cursor);
      cursor = delta.next;
      absoluteTick += delta.value;
      if (cursor >= end) break;

      let status = bytes[cursor];
      if (status < 0x80) {
        if (runningStatus === null) throw new Error('invalid-midi-running-status');
        status = runningStatus;
      } else {
        cursor += 1;
        if (status < 0xf0) runningStatus = status;
        else if (status === 0xf4 || status === 0xf5 || status === 0xf6 || status === 0xf8 || status === 0xf9 || status === 0xfa || status === 0xfb || status === 0xfc || status === 0xfd || status === 0xfe || status === 0xff) runningStatus = null;
      }

      const type = status & 0xf0;
      let data = [];
      if (status === 0xff) {
        if (cursor >= end) throw new Error('invalid-meta');
        const metaType = bytes[cursor++];
        const lengthInfo = readVarInt(bytes, cursor);
        cursor = lengthInfo.next;
        const metaEnd = cursor + lengthInfo.value;
        if (metaEnd > end) throw new Error('invalid-meta-length');
        data = [metaType, ...bytes.slice(cursor, metaEnd)];
        cursor = metaEnd;
      } else if (status === 0xf0 || status === 0xf7) {
        const lengthInfo = readVarInt(bytes, cursor);
        cursor = lengthInfo.next;
        const sysexEnd = cursor + lengthInfo.value;
        if (sysexEnd > end) throw new Error('invalid-sysex-length');
        data = bytes.slice(cursor, sysexEnd);
        cursor = sysexEnd;
      } else {
        const dataLength = type === 0xc0 || type === 0xd0 ? 1 : 2;
        if (cursor + dataLength > end) throw new Error('invalid-midi-event');
        data = bytes.slice(cursor, cursor + dataLength);
        cursor += dataLength;
      }

      events.push({ tick: absoluteTick, status, data });
    }
    tracks.push(events);
    offset = end;
  }

  return { format, division, tracks };
}

function encodeMidi(parsed) {
  const output = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, ...putU16(parsed.format), ...putU16(parsed.tracks.length), ...putU16(parsed.division)];
  for (const events of parsed.tracks) {
    const track = [];
    let previousTick = 0;
    for (const event of events) {
      const delta = Math.max(0, event.tick - previousTick);
      track.push(...writeVarInt(delta), event.status, ...event.data);
      previousTick = event.tick;
    }
    output.push(0x4d, 0x54, 0x72, 0x6b, ...putU32(track.length), ...track);
  }
  return new Uint8Array(output);
}

function smoothVoiceMidi(midiBytes) {
  try {
    const parsed = parseMidi(new Uint8Array(midiBytes));
    let changed = false;

    for (const events of parsed.tracks) {
      const notes = [];
      const active = new Map();
      for (const event of events) {
        const type = event.status & 0xf0;
        const channel = event.status & 0x0f;
        if ((type === 0x90 && event.data[1] > 0) || type === 0x80 || (type === 0x90 && event.data[1] === 0)) {
          const key = `${channel}:${event.data[0]}`;
          if (type === 0x90 && event.data[1] > 0) {
            const list = active.get(key) ?? [];
            list.push({ start: event.tick, event });
            active.set(key, list);
          } else {
            const list = active.get(key);
            if (list?.length) {
              const note = list.shift();
              notes.push({ start: note.start, end: event.tick, channel, pitch: event.data[0], on: note.event, off: event });
            }
          }
        }
      }

      notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      const remove = new Set();
      for (let i = 0; i < notes.length - 1; i += 1) {
        const current = notes[i];
        const next = notes[i + 1];
        const sameVoice = current.channel === next.channel && current.pitch === next.pitch;
        const gap = next.start - current.end;
        const nextLength = next.end - next.start;
        if (sameVoice && gap >= 0 && gap <= VOICE_SMOOTH_MAX_GAP_TICKS && nextLength <= VOICE_SMOOTH_MAX_FRAGMENT_TICKS) {
          current.end = next.end;
          current.off.tick = next.off.tick;
          remove.add(next.on);
          remove.add(next.off);
          changed = true;
        }
      }

      if (remove.size) {
        // Move the retained note-off event to the merged note's final position.
        for (const note of notes) {
          if (remove.has(note.on) || remove.has(note.off)) continue;
          if (note.end !== note.off.tick) {
            note.off.tick = note.end;
          }
        }
        const keptOffs = new Set(notes.filter((note) => !remove.has(note.off)).map((note) => note.off));
        events.splice(0, events.length, ...events.filter((event) => !remove.has(event)));
        // The event object already carries the final tick, so sorting restores chronological order.
        events.sort((a, b) => a.tick - b.tick);
        void keptOffs;
      }
    }

    if (!changed) return new Uint8Array(midiBytes);
    return encodeMidi(parsed);
  } catch (error) {
    console.warn('Voice MIDI smoothing skipped:', error);
    return new Uint8Array(midiBytes);
  }
}

function makeMidiBlob(result) {
  const sourceBytes = result?.midiBytes;
  if (!sourceBytes) return result?.midiBlob ?? null;
  const smoothed = smoothVoiceMidi(sourceBytes);
  return new Blob([smoothed], { type: 'audio/midi' });
}

async function runConversion(converterInstance) {
  return converterInstance.convert(selectedFile, {
    onStatus(status) {
      setProgress(0.03, statusLabel(status));
    },
    onProgress(progress) {
      setProgress(0.05 + Math.max(0, Math.min(1, progress)) * 0.9, 'AIが音声からノートを推定しています…');
    },
  });
}

async function convert() {
  if (!selectedFile || conversionBusy) return;

  conversionBusy = true;
  clearError();
  convertButton.disabled = true;
  progressPanel.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  setProgress(0, '変換を開始しています…');
  progressPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    if (!converter) converter = new AudioToMidiConverter(audioToMidiDefaults);

    try {
      latestResult = await runConversion(converter);
    } catch (error) {
      if (!isLikelyWebGLFailure(error)) throw error;
      setProgress(0.04, 'GPU解析に失敗したため、CPU解析へ切り替えています…');
      cpuConverter ??= new AudioToMidiConverter({ ...audioToMidiDefaults, backend: 'cpu' });
      latestResult = await runConversion(cpuConverter);
    }

    const smoothedBlob = makeMidiBlob(latestResult);
    if (smoothedBlob) latestResult = { ...latestResult, midiBlob: smoothedBlob, midiBytes: await smoothedBlob.arrayBuffer() };
    setProgress(1, '変換が完了しました。');
    renderResult(latestResult);
  } catch (error) {
    console.error('Audio to MIDI conversion failed:', error);
    let message = '変換に失敗しました。別の音声ファイルで試してください。';

    if (error instanceof AudioToMidiError) {
      const messages = {
        'file-too-large': 'ファイルが大きすぎます。100 MB以下にしてください。',
        'audio-too-long': '音声が長すぎます。8分以内にしてください。',
        'decode-failed': '音声をデコードできませんでした。ブラウザが対応する形式か確認してください。',
        'model-load-failed': 'AIモデルを読み込めませんでした。ページを再読み込みしてもう一度試してください。',
        'transcription-failed': '音声のAI解析に失敗しました。',
        'no-notes-detected': '音声から音符を検出できませんでした。音量を上げるか、音程がはっきりした音源で試してください。',
      };
      message = messages[error.code] ?? message;
    }

    showError(message);
    setProgress(0, '変換に失敗しました。');
  } finally {
    conversionBusy = false;
    convertButton.disabled = !selectedFile;
  }
}

function renderResult(result) {
  const noteCount = Number(result?.noteCount ?? 0);
  const duration = audioPlayer.duration;
  const midiSize = result?.midiBytes?.byteLength ?? result?.midiBlob?.size ?? 0;

  stats.innerHTML = `
    <div class="stat"><span>検出ノート</span><strong>${noteCount.toLocaleString('ja-JP')}</strong><small>notes</small></div>
    <div class="stat"><span>音声長</span><strong>${formatDuration(duration)}</strong><small>duration</small></div>
    <div class="stat"><span>MIDIサイズ</span><strong>${formatBytes(midiSize)}</strong><small>standard MIDI</small></div>
  `;

  resultPanel.classList.remove('hidden');
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function downloadMidi() {
  if (!latestResult?.midiBlob) return;
  const url = URL.createObjectURL(latestResult.midiBlob);
  const anchor = document.createElement('a');
  const baseName = selectedFile?.name?.replace(/\.[^.]+$/, '') || 'audio';
  anchor.href = url;
  anchor.download = latestResult.filename || `${baseName}-transcribed.mid`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

fileInput.addEventListener('change', () => inspectFile(fileInput.files?.[0]));
removeFileButton.addEventListener('click', reset);
resetButton.addEventListener('click', reset);
convertButton.addEventListener('click', convert);
downloadButton.addEventListener('click', downloadMidi);

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragging');
});

dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  inspectFile(event.dataTransfer.files?.[0]);
});

window.addEventListener('beforeunload', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
