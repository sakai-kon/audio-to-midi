import {
  AudioToMidiError,
  AudioToMidiConverter,
  audioToMidiDefaults,
} from '@musicbento/audio-to-midi';
import './style.css';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_SECONDS = 8 * 60;
const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'];
const TICKS = { voiceGap: 18, voiceFragment: 30, voicePitchJitter: 1, pianoGap: 8, pianoFragment: 6 };
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
let latestBlob = null;
let objectUrl = null;
let converter = null;
let cpuConverter = null;
let conversionBusy = false;
let sourceMode = 'auto';

const modeStyle = document.createElement('style');
modeStyle.textContent = `.source-mode-control{margin:1rem 0;display:grid;gap:.45rem}.source-mode-control label{font-size:.82rem;font-weight:700}.source-mode-control select{width:100%;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(255,255,255,.05);color:inherit;padding:.75rem .85rem;font:inherit}.source-mode-control small{opacity:.65;line-height:1.5}`;
document.head.appendChild(modeStyle);

function installSourceModeControl() {
  const wrapper = document.createElement('div');
  wrapper.className = 'source-mode-control';
  wrapper.innerHTML = `<label for="source-mode">音源タイプ</label><select id="source-mode"><option value="auto">自動判定（おすすめ）</option><option value="voice">ボーカル・歌声</option><option value="piano">ピアノ・楽器</option></select><small>歌声は細かな音高揺れをつなぎ、ピアノは短い音をなるべく保持します。</small>`;
  convertButton.before(wrapper);
  wrapper.querySelector('#source-mode').addEventListener('change', (event) => { sourceMode = event.target.value; });
}
installSourceModeControl();

function formatBytes(bytes) { if (!Number.isFinite(bytes)) return '—'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatDuration(seconds) { if (!Number.isFinite(seconds)) return '—'; const total = Math.max(0, Math.round(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; }
function extensionOf(name) { return name.includes('.') ? name.split('.').pop().toLowerCase() : ''; }
function setProgress(value, status) { const safe = Math.max(0, Math.min(1, value)); const percent = Math.round(safe * 100); progressBar.style.width = `${percent}%`; progressPercent.textContent = `${percent}%`; if (status) statusText.textContent = status; }
function showError(message) { statusText.textContent = message; statusText.classList.add('error-text'); }
function clearError() { statusText.classList.remove('error-text'); }
function reset() { if (conversionBusy) return; selectedFile = null; latestResult = null; latestBlob = null; fileInput.value = ''; fileCard.classList.add('hidden'); audioPlayer.classList.add('hidden'); audioPlayer.removeAttribute('src'); convertButton.disabled = true; progressPanel.classList.add('hidden'); resultPanel.classList.add('hidden'); clearError(); setProgress(0, '準備しています…'); if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } }

async function getAudioDuration(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      const cleanup = () => { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); };
      audio.addEventListener('loadedmetadata', () => { const value = audio.duration; cleanup(); Number.isFinite(value) ? resolve(value) : reject(new Error('invalid-duration')); }, { once: true });
      audio.addEventListener('error', () => { cleanup(); reject(new Error('audio-decode-failed')); }, { once: true });
      audio.src = url;
    });
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

async function inspectFile(file) {
  clearError(); if (!file) return;
  const extension = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) { showError('対応していない形式です。MP3 / WAV / M4A / AAC / OGG / FLAC / WebMを選択してください。'); return; }
  if (file.size > MAX_BYTES) { showError('ファイルが大きすぎます。100 MB以下の音声を選択してください。'); return; }
  try {
    const duration = await getAudioDuration(file);
    if (duration > MAX_SECONDS) { showError('音声が長すぎます。8分以内の音声を選択してください。'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file); selectedFile = file; latestResult = null; latestBlob = null;
    fileName.textContent = file.name; fileMeta.textContent = `${formatBytes(file.size)} · ${formatDuration(duration)}`; fileCard.classList.remove('hidden'); audioPlayer.src = objectUrl; audioPlayer.classList.remove('hidden'); convertButton.disabled = false; resultPanel.classList.add('hidden');
  } catch { showError('この音声をブラウザで読み込めませんでした。別の形式の音声で試してください。'); convertButton.disabled = true; }
}

function statusLabel(status) { return ({ 'loading-model':'AIモデルを読み込んでいます…','decoding-audio':'音声を解析用データに変換しています…',transcribing:'AIが音高・発音タイミングを解析しています…','preparing-midi':'検出したノートからMIDIを生成しています…' })[status] ?? '解析しています…'; }
function isLikelyWebGLFailure(error) { const text = String(error?.message ?? error ?? '').toLowerCase(); return text.includes('webgl') || text.includes('shader') || text.includes('backend') || text.includes('gpu'); }
function readVarInt(bytes, index) { let value = 0; for (let count = 0; count < 4; count += 1) { if (index >= bytes.length) throw new Error('invalid-midi-varint'); const byte = bytes[index++]; value = (value << 7) | (byte & 0x7f); if (!(byte & 0x80)) return { value, next: index }; } throw new Error('invalid-midi-varint'); }
function writeVarInt(value) { let buffer = value & 0x7f; const result = []; while ((value >>= 7)) { buffer <<= 8; buffer |= (value & 0x7f) | 0x80; } while (true) { result.push(buffer & 0xff); if (buffer & 0x80) buffer >>= 8; else return result; } }
function u32(bytes, index) { return ((bytes[index] << 24) | (bytes[index + 1] << 16) | (bytes[index + 2] << 8) | bytes[index + 3]) >>> 0; }
function putU32(value) { return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]; }
function putU16(value) { return [(value >>> 8) & 0xff, value & 0xff]; }

function parseMidi(bytes) {
  if (bytes.length < 14 || String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') throw new Error('not-midi');
  const headerLength = u32(bytes, 4); const format = (bytes[8] << 8) | bytes[9]; const trackCount = (bytes[10] << 8) | bytes[11]; const division = (bytes[12] << 8) | bytes[13];
  if (headerLength < 6 || division & 0x8000) throw new Error('unsupported-midi-division');
  let offset = 8 + headerLength; const tracks = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (offset + 8 > bytes.length || String.fromCharCode(...bytes.slice(offset, offset + 4)) !== 'MTrk') throw new Error('invalid-midi-track');
    const length = u32(bytes, offset + 4); const start = offset + 8; const end = start + length; if (end > bytes.length) throw new Error('invalid-midi-track-length');
    let cursor = start; let absoluteTick = 0; let runningStatus = null; const events = [];
    while (cursor < end) {
      const delta = readVarInt(bytes, cursor); cursor = delta.next; absoluteTick += delta.value; if (cursor >= end) break;
      let status = bytes[cursor];
      if (status < 0x80) { if (runningStatus === null) throw new Error('invalid-midi-running-status'); status = runningStatus; } else { cursor += 1; if (status < 0xf0) runningStatus = status; else runningStatus = null; }
      const type = status & 0xf0; let data = [];
      if (status === 0xff) { if (cursor >= end) throw new Error('invalid-meta'); const metaType = bytes[cursor++]; const lengthInfo = readVarInt(bytes, cursor); cursor = lengthInfo.next; const metaEnd = cursor + lengthInfo.value; if (metaEnd > end) throw new Error('invalid-meta-length'); data = [metaType, ...bytes.slice(cursor, metaEnd)]; cursor = metaEnd; }
      else if (status === 0xf0 || status === 0xf7) { const lengthInfo = readVarInt(bytes, cursor); cursor = lengthInfo.next; const sysexEnd = cursor + lengthInfo.value; if (sysexEnd > end) throw new Error('invalid-sysex-length'); data = bytes.slice(cursor, sysexEnd); cursor = sysexEnd; }
      else { const dataLength = type === 0xc0 || type === 0xd0 ? 1 : 2; if (cursor + dataLength > end) throw new Error('invalid-midi-event'); data = bytes.slice(cursor, cursor + dataLength); cursor += dataLength; }
      events.push({ tick: absoluteTick, status, data });
    }
    tracks.push(events); offset = end;
  }
  return { format, division, tracks };
}

function encodeMidi(parsed) {
  const output = [0x4d,0x54,0x68,0x64,0,0,0,6,...putU16(parsed.format),...putU16(parsed.tracks.length),...putU16(parsed.division)];
  for (const events of parsed.tracks) { const track = []; let previousTick = 0; for (const event of events) { track.push(...writeVarInt(Math.max(0,event.tick-previousTick)),event.status,...event.data); previousTick = event.tick; } output.push(0x4d,0x54,0x72,0x6b,...putU32(track.length),...track); }
  return new Uint8Array(output);
}

function collectTrackNotes(events) {
  const notes = []; const active = new Map();
  for (const event of events) {
    const type = event.status & 0xf0; if (type !== 0x90 && type !== 0x80) continue;
    const pitch = event.data[0]; const velocity = event.data[1]; const channel = event.status & 0x0f;
    const isOn = type === 0x90 && velocity > 0; const isOff = type === 0x80 || (type === 0x90 && velocity === 0); const key = `${channel}:${pitch}`;
    if (isOn) { const list = active.get(key) ?? []; list.push({ start:event.tick, velocity, on:event }); active.set(key,list); }
    else if (isOff) { const list = active.get(key); if (list?.length) { const note=list.shift(); notes.push({ start:note.start,end:Math.max(note.start+1,event.tick),channel,pitch,velocity:note.velocity,on:note.on,off:event }); } }
  }
  return notes;
}

function cleanVoiceNotes(notes) {
  const sorted=[...notes].sort((a,b)=>a.start-b.start || (b.end-b.start)-(a.end-a.start)); const cleaned=[];
  for (const note of sorted) {
    let merged=false;
    for (let i=cleaned.length-1;i>=0;i-=1) {
      const prev=cleaned[i]; if (prev.channel!==note.channel || note.start<prev.start) continue;
      const gap=note.start-prev.end; const distance=Math.abs(note.pitch-prev.pitch); const length=note.end-note.start;
      if (gap<=TICKS.voiceGap && distance<=TICKS.voicePitchJitter && length<=TICKS.voiceFragment) { if(length>prev.end-prev.start) prev.pitch=note.pitch; prev.end=Math.max(prev.end,note.end); prev.velocity=Math.max(prev.velocity,note.velocity); merged=true; break; }
      if(note.start>=prev.end) break;
    }
    if(!merged) cleaned.push({...note});
  }
  const monophonic=[];
  for(const note of cleaned.sort((a,b)=>a.start-b.start)) {
    const prev=monophonic.at(-1);
    if(prev && note.start<prev.end && Math.abs(note.pitch-prev.pitch)<=2) {
      const prevLength=prev.end-prev.start; const noteLength=note.end-note.start;
      if(noteLength<=TICKS.voiceFragment || prevLength>=noteLength){ prev.end=Math.max(prev.end,note.end); continue; }
      prev.end=Math.max(prev.start+1,note.start);
    }
    monophonic.push({...note});
  }
  return monophonic.filter((note)=>note.end>note.start);
}

function cleanPianoNotes(notes) {
  const sorted=[...notes].sort((a,b)=>a.start-b.start || a.pitch-b.pitch); const cleaned=[];
  for(const note of sorted){ const previous=cleaned.at(-1); if(previous && previous.channel===note.channel && previous.pitch===note.pitch && note.start>=previous.end && note.start-previous.end<=TICKS.pianoGap && note.end-note.start<=TICKS.pianoFragment){ previous.end=Math.max(previous.end,note.end); previous.velocity=Math.max(previous.velocity,note.velocity); } else cleaned.push({...note}); }
  return cleaned;
}

function detectSourceMode(parsed) {
  const notes=parsed.tracks.flatMap(collectTrackNotes); if(notes.length<2) return 'piano'; notes.sort((a,b)=>a.start-b.start);
  let overlaps=0, close=0;
  for(let i=1;i<notes.length;i+=1){ const a=notes[i-1],b=notes[i]; if(a.channel===b.channel&&b.start<a.end){ overlaps+=1; if(Math.abs(a.pitch-b.pitch)<=2) close+=1; } }
  const overlapRatio=overlaps/Math.max(1,notes.length-1); return overlapRatio<0.08 || close/Math.max(1,overlaps)>0.65 ? 'voice' : 'piano';
}

function rebuildTrack(events, mode) {
  const notes=collectTrackNotes(events); if(!notes.length) return events; const cleaned=mode==='voice'?cleanVoiceNotes(notes):cleanPianoNotes(notes); const noteEvents=new Set(notes.flatMap((note)=>[note.on,note.off])); const retained=events.filter((event)=>!noteEvents.has(event));
  for(const note of cleaned){ const on={...note.on,data:[note.pitch,note.velocity],tick:note.start}; const off={...note.off,data:[note.pitch,0],tick:note.end}; retained.push(on,off); }
  retained.sort((a,b)=>a.tick-b.tick || (((a.status&0xf0)===0x80)?-1:1)); return retained;
}

function postProcessMidi(midiBytes, requestedMode) {
  try { const parsed=parseMidi(new Uint8Array(midiBytes)); const mode=requestedMode==='auto'?detectSourceMode(parsed):requestedMode; parsed.tracks=parsed.tracks.map((events)=>rebuildTrack(events,mode)); return {bytes:encodeMidi(parsed),mode}; }
  catch(error){ console.warn('MIDI post-processing skipped:',error); return {bytes:new Uint8Array(midiBytes),mode:requestedMode==='auto'?'auto':requestedMode}; }
}

function makeMidiBlob(result) { if(!result?.midiBytes) return {blob:result?.midiBlob??null,mode:'auto'}; const processed=postProcessMidi(result.midiBytes,sourceMode); return {blob:new Blob([processed.bytes],{type:'audio/midi'}),mode:processed.mode}; }
async function runConversion(converterInstance){ return converterInstance.convert(selectedFile,{onStatus(status){setProgress(.03,statusLabel(status));},onProgress(progress){setProgress(.05+Math.max(0,Math.min(1,progress))*.9,'AIが音声からノートを推定しています…');}}); }

async function convert(){
  if(!selectedFile||conversionBusy)return; conversionBusy=true; clearError(); convertButton.disabled=true; progressPanel.classList.remove('hidden'); resultPanel.classList.add('hidden'); setProgress(.01,'変換を準備しています…');
  try{
    if(!converter)converter=new AudioToMidiConverter(audioToMidiDefaults); let result;
    try{result=await runConversion(converter);}catch(error){if(!isLikelyWebGLFailure(error))throw error; statusText.textContent='GPU解析に失敗したため、CPUモードへ切り替えています…'; if(!cpuConverter)cpuConverter=new AudioToMidiConverter({...audioToMidiDefaults,backend:'cpu'}); result=await runConversion(cpuConverter);}
    const processed=makeMidiBlob(result); latestResult=result; latestBlob=processed.blob??result.midiBlob; if(!latestBlob)throw new Error('midi-generation-failed');
    const modeLabel=processed.mode==='voice'?'ボーカル最適化':processed.mode==='piano'?'ピアノ・楽器最適化':'標準';
    stats.innerHTML=`<div><span>検出ノート</span><strong>${result.noteCount??'—'}</strong></div><div><span>音源処理</span><strong>${modeLabel}</strong></div><div><span>出力形式</span><strong>MIDI</strong></div>`;
    setProgress(1,'変換が完了しました。'); resultPanel.classList.remove('hidden');
  }catch(error){ showError(error instanceof AudioToMidiError?error.message:'変換に失敗しました。音量が極端に小さい音源や、複数楽器が重なった音源では精度が下がることがあります。'); progressPanel.classList.remove('hidden'); }
  finally{conversionBusy=false;convertButton.disabled=!selectedFile;}
}

function downloadMidi(){ if(!latestBlob||!latestResult)return; const base=(latestResult.filename||selectedFile?.name||'audio').replace(/\.[^.]+$/,''); const url=URL.createObjectURL(latestBlob); const anchor=document.createElement('a'); anchor.href=url; anchor.download=`${base}.mid`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
fileInput.addEventListener('change',(event)=>inspectFile(event.target.files?.[0])); removeFileButton.addEventListener('click',reset); resetButton.addEventListener('click',reset); convertButton.addEventListener('click',convert); downloadButton.addEventListener('click',downloadMidi);
dropzone.addEventListener('dragover',(event)=>{event.preventDefault();dropzone.classList.add('dragover');}); dropzone.addEventListener('dragleave',()=>dropzone.classList.remove('dragover')); dropzone.addEventListener('drop',(event)=>{event.preventDefault();dropzone.classList.remove('dragover');const file=event.dataTransfer?.files?.[0];if(file)inspectFile(file);});
