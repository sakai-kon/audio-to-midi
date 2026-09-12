import {
  AudioToMidiError,
  AudioToMidiConverter,
  audioToMidiDefaults,
} from '@musicbento/audio-to-midi';
import './style.css';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 8 * 60;
const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'];

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

async function runConversion(converterInstance) {
  return converterInstance.convert(selectedFile, {
    onStatus(status) {
      setProgress(0.03, statusLabel(status));
    },
    onProgress(progress) {
      // Reserve a small amount of headroom for final MIDI creation.
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
    if (!converter) {
      converter = new AudioToMidiConverter(audioToMidiDefaults);
    }

    try {
      latestResult = await runConversion(converter);
    } catch (error) {
      // Some Safari/iOS/WebGL implementations can fail inside TensorFlow.js.
      // Retry once with the CPU backend instead of leaving the user with a dead conversion.
      if (!isLikelyWebGLFailure(error)) throw error;
      setProgress(0.04, 'GPU解析に失敗したため、CPU解析へ切り替えています…');
      cpuConverter ??= new AudioToMidiConverter({ ...audioToMidiDefaults, backend: 'cpu' });
      latestResult = await runConversion(cpuConverter);
    }

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
        'no-notes-detected': '音声から音符を検出できませんでした。音量を上げるか、楽器音がはっきりした音源で試してください。',
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
