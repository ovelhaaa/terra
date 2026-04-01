let audioCtx;
let octaveNode;
let micStream;
let micSource;
let fileBuffer;
let fileSource;
let playbackStartTime = 0;
let pausedOffset = 0;
let animId;

const els = {
  powerBtn: document.getElementById('powerBtn'),
  sourceSelect: document.getElementById('sourceSelect'),
  fileInput: document.getElementById('fileInput'),
  playBtn: document.getElementById('playBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  timeline: document.getElementById('timeline'),
  time: document.getElementById('time'),
  status: document.getElementById('status'),
  engine: document.getElementById('engine'),
  source: document.getElementById('source'),
  mode: document.getElementById('mode'),
  dryBlend: document.getElementById('dryBlend'),
  upGain: document.getElementById('upGain'),
  down1Gain: document.getElementById('down1Gain'),
  down2Gain: document.getElementById('down2Gain'),
  internalDry: document.getElementById('internalDry'),
  resetBtn: document.getElementById('resetBtn'),
};

const WORKLET_URL = new URL('./octave-worklet-processor.js', import.meta.url).href;
const WASM_URL = new URL('./octave-module.wasm', import.meta.url).href;

function setStatus(message, error = false) {
  els.status.textContent = message;
  els.status.className = error ? 'err' : 'ok';
}

function fmt(sec) {
  if (!Number.isFinite(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function applyParams() {
  if (!octaveNode) return;
  octaveNode.parameters.get('mode').setValueAtTime(Number(els.mode.value), audioCtx.currentTime);
  octaveNode.parameters.get('dryBlend').setValueAtTime(Number(els.dryBlend.value), audioCtx.currentTime);
  octaveNode.parameters.get('upGain').setValueAtTime(Number(els.upGain.value), audioCtx.currentTime);
  octaveNode.parameters.get('down1Gain').setValueAtTime(Number(els.down1Gain.value), audioCtx.currentTime);
  octaveNode.parameters.get('down2Gain').setValueAtTime(Number(els.down2Gain.value), audioCtx.currentTime);
  octaveNode.parameters.get('internalDryEnabled').setValueAtTime(Number(els.internalDry.value), audioCtx.currentTime);
}

async function initAudio() {
  els.engine.textContent = 'Engine: initializing';
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule(WORKLET_URL);

  octaveNode = new AudioWorkletNode(audioCtx, 'octave-worklet-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  octaveNode.port.onmessage = (event) => {
    const data = event.data;
    if (data.type === 'ready') {
      els.engine.textContent = 'Engine: ready';
      setStatus('Octave DSP ready.');
      applyParams();
    } else if (data.type === 'error') {
      els.engine.textContent = 'Engine: error';
      setStatus(`${data.stage}: ${data.message}`, true);
    }
  };

  const wasmBytes = await fetch(WASM_URL).then((r) => {
    if (!r.ok) throw new Error(`Failed to load wasm (${r.status})`);
    return r.arrayBuffer();
  });
  octaveNode.port.postMessage({ type: 'init', wasmBytes }, [wasmBytes]);

  octaveNode.connect(audioCtx.destination);
  await audioCtx.resume();
  els.engine.textContent = 'Engine: running';
}

function disconnectSources() {
  if (micSource) { micSource.disconnect(); }
  if (fileSource) {
    try { fileSource.stop(); } catch {}
    fileSource.disconnect();
    fileSource = null;
  }
}

async function routeSource() {
  if (!audioCtx || !octaveNode) return;
  disconnectSources();
  if (els.sourceSelect.value === 'mic') {
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(octaveNode);
  }
  els.source.textContent = `Source: ${els.sourceSelect.value}`;
}

function playFrom(offset) {
  if (!fileBuffer || !audioCtx) return;
  disconnectSources();
  fileSource = audioCtx.createBufferSource();
  fileSource.buffer = fileBuffer;
  fileSource.connect(octaveNode);
  playbackStartTime = audioCtx.currentTime;
  pausedOffset = offset;
  fileSource.onended = () => {
    if (!fileSource) return;
    fileSource = null;
    pausedOffset = 0;
    els.timeline.value = 0;
  };
  fileSource.start(0, offset);
  tick();
}

function tick() {
  if (!fileBuffer || !fileSource) return;
  const pos = Math.min(pausedOffset + (audioCtx.currentTime - playbackStartTime), fileBuffer.duration);
  const percent = fileBuffer.duration > 0 ? (pos / fileBuffer.duration) * 100 : 0;
  els.timeline.value = String(percent);
  els.time.textContent = `${fmt(pos)} / ${fmt(fileBuffer.duration)}`;
  animId = requestAnimationFrame(tick);
}

els.powerBtn.addEventListener('click', async () => {
  try {
    if (!audioCtx) await initAudio();
    await audioCtx.resume();
    await routeSource();
    setStatus('Audio started.');
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
});

els.sourceSelect.addEventListener('change', () => routeSource().catch((e) => setStatus(e.message, true)));
els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !audioCtx) return;
  try {
    const data = await file.arrayBuffer();
    fileBuffer = await audioCtx.decodeAudioData(data);
    els.time.textContent = `00:00 / ${fmt(fileBuffer.duration)}`;
    setStatus(`Loaded ${file.name}.`);
  } catch (err) {
    setStatus(`File load failed: ${err.message}`, true);
  }
});

els.playBtn.addEventListener('click', () => {
  if (els.sourceSelect.value !== 'file') return setStatus('Switch source to file first.', true);
  if (!fileBuffer) return setStatus('Load a file first.', true);
  playFrom(pausedOffset);
});
els.pauseBtn.addEventListener('click', () => {
  if (!fileSource || !audioCtx || !fileBuffer) return;
  pausedOffset = Math.min(pausedOffset + (audioCtx.currentTime - playbackStartTime), fileBuffer.duration);
  disconnectSources();
  cancelAnimationFrame(animId);
});
els.stopBtn.addEventListener('click', () => {
  pausedOffset = 0;
  disconnectSources();
  cancelAnimationFrame(animId);
  els.timeline.value = 0;
  if (fileBuffer) els.time.textContent = `00:00 / ${fmt(fileBuffer.duration)}`;
});
els.timeline.addEventListener('input', () => {
  if (!fileBuffer) return;
  pausedOffset = (Number(els.timeline.value) / 100) * fileBuffer.duration;
  els.time.textContent = `${fmt(pausedOffset)} / ${fmt(fileBuffer.duration)}`;
});
els.timeline.addEventListener('change', () => {
  if (fileSource) playFrom(pausedOffset);
});

['mode', 'dryBlend', 'upGain', 'down1Gain', 'down2Gain', 'internalDry'].forEach((id) => {
  els[id].addEventListener('input', applyParams);
  els[id].addEventListener('change', applyParams);
});

els.resetBtn.addEventListener('click', () => {
  octaveNode?.port.postMessage({ type: 'reset' });
  setStatus('DSP reset.');
});
