import {
  AudioToMidiError,
  AudioToMidiConverter,
  audioToMidiDefaults,
} from '@musicbento/audio-to-midi';
import './style.css';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 8 * 60;

const fileInput = document.querySelector('#file-input');
const dropzone = document.querySelector('#dropzone');
const fileCard = document.querySelector('#file-card');
const fileName = document.querySelector('#file-name');
const fileMeta = document.querySelector('#file-meta');
const audioPlayer = document.querySelector('#audio-player');
const convertButton = document.querySelector('#convert-button');
const removeFileButton = document.querySelector('#remove-file');
const progressPanel = document.querySelector('#progress-panel');
const progressBar = document.querySelector('#progress-bar');
const progressPercent = document.querySelector('#progress-percent');
const statusText = document.querySelector('#status-text');
const resultPanel = document.querySelector('#result-panel');
const stats = document.querySelector('#stats');
const downloadButton = document.querySelector('#download-button');
const resetButton = document.querySelector('#reset-button');

let selectedFile = null;
let latestResult = null;
let objectUrl = null;
let converter = null;

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
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

async function inspectFile(file) {
  clearError();
  if (!file) return;

  if (file.size > MAX_BYTES) {
    showError('ファイルが大きすぎます。100 MB以下の音声を選択してください。');
    return;
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  fileName.textContent = file.name;
  fileMeta.textContent = `${formatBytes(file.size)} · 読み込み中…`;
  fileCard.classList.remove('hidden');
  audioPlayer.src = objectUrl;
  audioPlayer.classList.remove('hidden');

  try {
    const duration = await new Promise((resolve, reject) => {
      const onLoaded = () => cleanup(resolve, audioPlayer.duration);
      const onError = () => cleanup(reject, new Error('audio-decode-failed'));
      const cleanup = (fn, value) => {
        audioPlayer.removeEventListener('loadedmetadata', onLoaded);
        audioPlayer.removeEventListener('error', onError);
        fn(value);
      };
      audioPlayer.addEventListener('loadedmetadata', onLoaded, { once: true });
      audioPlayer.addEventListener('error', onError, { once: true });
      audioPlayer.load();
    });

    if (duration > MAX_SECONDS) {
      showError('音声が長すぎます。8分以内の音声を選択してください。');
      convertButton.disabled = true;
      return;
    }

    selectedFile = file;
    fileMeta.textContent = `${formatBytes(file.size)} · ${formatDuration(duration)}`;
    convertButton.disabled = false;
  } catch {
    showError('この音声をブラウザで読み込めませんでした。WAVやMP3などを試してください。');
    convertButton.disabled = true;
  }
}

function statusLabel(status) {
  return {
    'loading-model': 'AIモデルを読み込んでいます…',
    'decoding-audio': '音声を解析用データに変換しています…',
    transcribing: 'AIが音高と発音タイミングを解析しています…',
    'preparing-midi': 'MIDIノートを整理しています…',
  }[status] ?? '解析しています…';
}

async function convert() {
  if (!selectedFile) return;

  clearError();
  convertButton.disabled = true;
  progressPanel.classList.remove('hidden');
  resultPanel.classList.add('hidden');
  setProgress(0, '変換を開始しています…');
  progressPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    // Reuse the model between conversions so repeated runs do not reload it.
    if (!converter) converter = new AudioToMidiConverter(audioToMidiDefaults);

    latestResult = await converter.convert(selectedFile, {
      onStatus(status) {
        setProgress(0.02, statusLabel(status));
      },
      onProgress(progress) {
        // Keep the loading/decoding stages visible while allowing the model
        // to report its actual transcription progress.
        const value = Math.max(0.02, Math.min(0.98, progress));
        setProgress(value, 'AIが音声からノートを推定しています…');
      },
    });

    setProgress(1, '変換が完了しました。');
    renderResult(latestResult);
  } catch (error) {
    console.error(error);
    let message = '変換に失敗しました。別の音声ファイルで試してください。';

    if (error instanceof AudioToMidiError) {
      const messages = {
        'file-too-large': 'ファイルが大きすぎます。100 MB以下にしてください。',
        'audio-too-long': '音声が長すぎます。8分以内にしてください。',
        'decode-failed': '音声をデコードできませんでした。対応形式か確認してください。',
        'model-load-failed': 'AIモデルを読み込めませんでした。通信状態を確認してください。',
        'transcription-failed': '音声のAI解析に失敗しました。',
        'no-notes-detected': '音声から音符を検出できませんでした。',
      };
      message = messages[error.code] ?? message;
    }

    showError(message);
  } finally {
    convertButton.disabled = !selectedFile;
  }
}

function renderResult(result) {
  const noteCount = Number(result.noteCount ?? 0);
  const duration = audioPlayer.duration;
  const midiSize = result.midiBytes?.byteLength ?? result.midiBlob?.size ?? 0;

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
  anchor.href = url;
  anchor.download = latestResult.filename || `${selectedFile?.name.replace(/\.[^.]+$/, '') || 'audio'}-transcribed.mid`;
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
  const file = event.dataTransfer.files?.[0];
  if (file) inspectFile(file);
});
