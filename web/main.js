let audioCtx;
let earthNode;
let micSourceNode;
let micStream;
let audioBuffer;
let fileSourceNode;
let uiBindingsInitialized = false;

let engineState = 'off';
let transportState = 'stopped';
let playbackStartTime = 0;
let pausedOffset = 0;
let animationFrameId = null;

const ENGINE_MAX_BLOCK_SIZE = 128;
const DEFAULT_PATCH_VERSION = 1;
const GAIN_MODULE_ID = 'gain_1';

const startButton = document.getElementById('start-audio');
const statusText = document.getElementById('status-text');
const statusPill = document.getElementById('status-pill');
const engineStateLabel = document.getElementById('engine-state-label');

const audioSourceSelect = document.getElementById('audioSource');
const activeSourceBadge = document.getElementById('active-source-badge');
const audioFileInput = document.getElementById('audioFile');
const playFileBtn = document.getElementById('playFileBtn');
const pauseFileBtn = document.getElementById('pauseFileBtn');
const stopFileBtn = document.getElementById('stopFileBtn');
const transportStateLabel = document.getElementById('transport-state');
const timelineInput = document.getElementById('transportTimeline');
const elapsedTimeLabel = document.getElementById('elapsed-time');
const durationTimeLabel = document.getElementById('duration-time');
const loopPlaybackInput = document.getElementById('loopPlayback');

const gainInput = document.getElementById('engineGain');
const gainValueLabel = document.getElementById('engineGain-val');
const gainBypassInput = document.getElementById('gainBypass');

const metricBlockSize = document.getElementById('metric-block-size');
const metricSampleRate = document.getElementById('metric-sample-rate');
const metricAvgMs = document.getElementById('metric-avg-ms');
const metricPeakMs = document.getElementById('metric-peak-ms');

const WORKLET_URL = new URL('./earth-worklet-processor.js', import.meta.url).href;
const WASM_URL = new URL('./earth-module.wasm', import.meta.url).href;

function setStatus(message) {
  statusText.textContent = message;
}

function setEngineState(state, message) {
  engineState = state;
  statusPill.dataset.state = state;

  const stateLabel = {
    off: 'Engine Off',
    initializing: 'Initializing',
    ready: 'Ready',
    running: 'Running',
    error: 'Error'
  };

  engineStateLabel.textContent = stateLabel[state] || 'Unknown';
  startButton.classList.toggle('running', state === 'running');
  startButton.textContent = state === 'running' ? 'On' : 'Power';

  if (message) {
    setStatus(message);
  }

  updateTransportButtons();
}

function setTransportState(state, message) {
  transportState = state;

  const readable = {
    stopped: 'Stopped',
    playing: 'Playing',
    paused: 'Paused',
    empty: 'No file loaded'
  };

  transportStateLabel.textContent = message || readable[state] || 'Unknown transport state';
  updateTransportButtons();
}

function logError(context, err) {
  console.error(`[EarthPedal] ${context}`, err);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateSourceBadge() {
  if (audioSourceSelect.value === 'mic') {
    activeSourceBadge.textContent = 'Mic Active';
    activeSourceBadge.classList.add('active');
  } else {
    activeSourceBadge.textContent = 'File Player Active';
    activeSourceBadge.classList.add('active');
  }
}

function updateTimelineUI(currentTime = 0) {
  if (!audioBuffer) {
    timelineInput.value = 0;
    timelineInput.style.setProperty('--progress', '0%');
    elapsedTimeLabel.textContent = '00:00';
    durationTimeLabel.textContent = '00:00';
    return;
  }

  const duration = audioBuffer.duration;
  const safeTime = Math.max(0, Math.min(currentTime, duration));
  const progress = duration > 0 ? (safeTime / duration) * 100 : 0;

  timelineInput.value = String(progress);
  timelineInput.style.setProperty('--progress', `${progress}%`);
  elapsedTimeLabel.textContent = formatTime(safeTime);
  durationTimeLabel.textContent = formatTime(duration);
}

function stopProgressAnimation() {
  if (!animationFrameId) return;
  cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
}

function updateProgressLoop() {
  if (!audioCtx || !audioBuffer || transportState !== 'playing') {
    stopProgressAnimation();
    return;
  }

  const duration = audioBuffer.duration;
  if (duration <= 0) {
    updateTimelineUI(0);
    animationFrameId = requestAnimationFrame(updateProgressLoop);
    return;
  }

  const elapsedSinceStart = audioCtx.currentTime - playbackStartTime;
  const rawPosition = pausedOffset + elapsedSinceStart;

  let playbackPosition = rawPosition;
  if (loopPlaybackInput.checked) {
    playbackPosition = rawPosition % duration;
  } else {
    playbackPosition = Math.min(rawPosition, duration);
  }

  updateTimelineUI(playbackPosition);
  animationFrameId = requestAnimationFrame(updateProgressLoop);
}

function stopAndDisconnectFileSource() {
  if (!fileSourceNode) return;

  try {
    fileSourceNode.stop();
  } catch (err) {
    // source may already have ended
  }

  try {
    fileSourceNode.disconnect();
  } catch (err) {
    // source may already be disconnected
  }

  fileSourceNode.onended = null;
  fileSourceNode = null;
}

function disconnectMicSource() {
  if (!micSourceNode) return;

  try {
    micSourceNode.disconnect();
  } catch (err) {
    // source may already be disconnected
  }
}

function disconnectAllSources() {
  stopAndDisconnectFileSource();
  disconnectMicSource();
}

async function ensureMicSource() {
  if (!audioCtx || !earthNode) {
    throw new Error('Audio graph is not initialized yet.');
  }

  if (!micStream) {
    setStatus('Requesting microphone access…');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        latency: 0
      }
    });
  }

  if (!micSourceNode) {
    micSourceNode = audioCtx.createMediaStreamSource(micStream);
  }

  disconnectAllSources();
  micSourceNode.connect(earthNode);
  setStatus('Mic routed to Earth engine.');
}

function connectFileMode() {
  disconnectAllSources();
  setStatus(audioBuffer ? 'File source ready. Use transport controls.' : 'File source selected. Load an audio file.');
  if (!audioBuffer) {
    setTransportState('empty', 'No file loaded.');
    updateTimelineUI(0);
  }
}

function switchSource(mode) {
  updateSourceBadge();

  if (mode === 'mic') {
    if (!audioCtx || !earthNode) {
      setStatus('Engine is off. Power on to use mic input.');
      return Promise.resolve();
    }

    stopPlayback();
    return ensureMicSource();
  }

  connectFileMode();
  return Promise.resolve();
}

function updateTransportButtons() {
  const engineRunning = engineState === 'running';
  const inFileMode = audioSourceSelect.value === 'file';
  const hasFile = Boolean(audioBuffer);

  playFileBtn.disabled = !engineRunning || !inFileMode || !hasFile || transportState === 'playing';
  pauseFileBtn.disabled = !engineRunning || !inFileMode || !hasFile || transportState !== 'playing';
  stopFileBtn.disabled = !engineRunning || !inFileMode || !hasFile || transportState === 'stopped';
  timelineInput.disabled = !engineRunning || !inFileMode || !hasFile;
}

function startPlaybackAt(offsetSeconds) {
  if (!audioCtx || !audioBuffer || !earthNode) {
    return;
  }

  stopAndDisconnectFileSource();
  disconnectMicSource();

  fileSourceNode = audioCtx.createBufferSource();
  fileSourceNode.buffer = audioBuffer;
  fileSourceNode.loop = loopPlaybackInput.checked;
  fileSourceNode.connect(earthNode);

  const startOffset = Math.max(0, Math.min(offsetSeconds, audioBuffer.duration || 0));
  pausedOffset = startOffset;
  playbackStartTime = audioCtx.currentTime;

  fileSourceNode.onended = () => {
    if (fileSourceNode && fileSourceNode.loop) {
      return;
    }

    fileSourceNode = null;
    pausedOffset = 0;
    stopProgressAnimation();
    updateTimelineUI(0);
    setTransportState('stopped', 'Stopped.');
  };

  fileSourceNode.start(0, startOffset);
  setTransportState('playing', `Playing from ${formatTime(startOffset)}.`);
  updateProgressLoop();
}

function playFile() {
  if (!audioBuffer) {
    setTransportState('empty', 'Load a file before pressing Play.');
    return;
  }

  if (!audioCtx || audioCtx.state !== 'running') {
    setStatus('Engine is not running. Power on first.');
    return;
  }

  startPlaybackAt(pausedOffset);
}

function pausePlayback() {
  if (transportState !== 'playing' || !audioBuffer || !audioCtx) {
    return;
  }

  pausedOffset += audioCtx.currentTime - playbackStartTime;
  if (audioBuffer.duration > 0) {
    pausedOffset %= audioBuffer.duration;
  }

  stopAndDisconnectFileSource();
  stopProgressAnimation();
  updateTimelineUI(pausedOffset);
  setTransportState('paused', `Paused at ${formatTime(pausedOffset)}.`);
}

function stopPlayback() {
  stopAndDisconnectFileSource();
  stopProgressAnimation();
  pausedOffset = 0;
  updateTimelineUI(0);

  if (audioBuffer) {
    setTransportState('stopped', 'Stopped.');
  } else {
    setTransportState('empty', 'No file loaded.');
  }
}

function readGainValue() {
  const fallback = 1.0;
  if (!gainInput) {
    return fallback;
  }

  const value = Number(gainInput.value);
  return Number.isFinite(value) ? value : fallback;
}

function buildPatch() {
  return {
    version: DEFAULT_PATCH_VERSION,
    chain: [
      { id: 'pt_1', type: 'passthrough', enabled: true, bypass: false, params: {} },
      {
        id: GAIN_MODULE_ID,
        type: 'gain',
        enabled: true,
        bypass: gainBypassInput?.value === '1',
        params: { gain: readGainValue() }
      }
    ]
  };
}

function sendPatch() {
  if (!earthNode) return;
  earthNode.port.postMessage({ type: 'setPatch', patch: buildPatch() });
}

function sendGainUpdate(value) {
  if (!earthNode) return;
  earthNode.port.postMessage({
    type: 'setParam',
    moduleId: GAIN_MODULE_ID,
    paramId: 'gain',
    value
  });
}

function sendGainBypassUpdate(bypass) {
  if (!earthNode) return;
  earthNode.port.postMessage({
    type: 'setModuleBypass',
    moduleId: GAIN_MODULE_ID,
    bypass
  });
}

function sendReset() {
  if (!earthNode) return;
  earthNode.port.postMessage({ type: 'reset' });
}

function setMetricText(el, text) {
  if (el) {
    el.textContent = text;
  }
}

function updateMetricsUI(metrics) {
  setMetricText(metricBlockSize, String(metrics.blockSize ?? '-'));
  setMetricText(metricSampleRate, String(metrics.sampleRate ?? '-'));
  setMetricText(metricAvgMs, Number(metrics.avgProcessMs || 0).toFixed(4));
  setMetricText(metricPeakMs, Number(metrics.peakProcessMs || 0).toFixed(4));
}

function setupUIBindings() {
  if (gainInput) {
    setMetricText(gainValueLabel, Number(gainInput.value).toFixed(2));
    gainInput.addEventListener('input', (e) => {
      const value = Number(e.target.value);
      setMetricText(gainValueLabel, value.toFixed(2));
      sendGainUpdate(value);
    });
  }

  if (gainBypassInput) {
    gainBypassInput.addEventListener('change', (e) => {
      sendGainBypassUpdate(e.target.value === '1');
    });
  }
}

async function initAudio() {
  try {
    setEngineState('initializing', 'Initializing AudioContext…');
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

    setStatus('Loading DSP worklet…');
    await audioCtx.audioWorklet.addModule(WORKLET_URL);

    setStatus('Fetching wasm module…');
    const response = await fetch(WASM_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch wasm (${response.status} ${response.statusText}) from ${response.url || WASM_URL}`);
    }

    const wasmBytes = await response.arrayBuffer();
    earthNode = new AudioWorkletNode(audioCtx, 'earth-worklet-processor', {
      outputChannelCount: [2]
    });

    earthNode.port.onmessage = async (event) => {
      if (event.data.type === 'ready') {
        if (!uiBindingsInitialized) {
          setupUIBindings();
          uiBindingsInitialized = true;
        }

        sendPatch();

        setEngineState('running', 'Engine online. Select source and play.');

        try {
          await switchSource(audioSourceSelect.value);
        } catch (err) {
          logError('source activation failed after worklet ready', err);
          setStatus(`Engine ready, but source activation failed: ${err.message}`);
        }
        return;
      }

      if (event.data.type === 'metrics') {
        updateMetricsUI(event.data);
        return;
      }

      if (event.data.type === 'error') {
        const details = `[${event.data.stage || 'worklet'}] ${event.data.message || 'Unknown worklet error'}`;
        console.error('[EarthPedal] Worklet reported error', event.data);
        setEngineState('error', `Worklet error: ${details}`);
      }
    };

    earthNode.connect(audioCtx.destination);
    earthNode.port.postMessage({ type: 'init', wasmBytes, maxBlockSize: ENGINE_MAX_BLOCK_SIZE });

    setStatus('Finalizing engine startup…');
  } catch (err) {
    logError('audio initialization failed', err);
    setEngineState('error', `Initialization failed: ${err.message}`);
    throw err;
  }
}

// Handle Source Switching
audioSourceSelect.addEventListener('change', async (e) => {
  try {
    await switchSource(e.target.value);
    updateTransportButtons();
  } catch (err) {
    logError('source switch failed', err);
    setStatus(`Source switch error: ${err.message}`);
  }
});

// Handle File Upload
audioFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (!audioCtx) {
    setStatus('Power on engine before loading files.');
    return;
  }

  try {
    setStatus('Loading file…');
    const arrayBuffer = await file.arrayBuffer();
    setStatus('Decoding file…');
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    pausedOffset = 0;
    updateTimelineUI(0);
    setTransportState('stopped', `Loaded: ${file.name}`);
    setStatus('File decoded and ready.');
  } catch (err) {
    logError('error decoding audio file', err);
    setEngineState('error', `File decode error: ${err.message}`);
  }
});

playFileBtn.addEventListener('click', () => {
  if (audioSourceSelect.value !== 'file') {
    setStatus('Switch source to File Player first.');
    return;
  }

  playFile();
});

pauseFileBtn.addEventListener('click', () => {
  pausePlayback();
});

stopFileBtn.addEventListener('click', () => {
  stopPlayback();
});

timelineInput.addEventListener('input', () => {
  if (!audioBuffer) return;

  const target = (Number(timelineInput.value) / 100) * audioBuffer.duration;
  updateTimelineUI(target);

  if (transportState === 'playing') {
    startPlaybackAt(target);
  } else {
    pausedOffset = target;
    setTransportState('paused', `Position set to ${formatTime(target)}.`);
  }
});

loopPlaybackInput.addEventListener('change', () => {
  if (fileSourceNode) {
    fileSourceNode.loop = loopPlaybackInput.checked;
  }
});

startButton.addEventListener('click', async () => {
  if (!audioCtx) {
    try {
      await initAudio();
    } catch (err) {
      // initAudio already reports failure
    }
    return;
  }

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
    setEngineState('running', 'Engine running. Audio path active.');
    return;
  }

  if (audioCtx.state === 'running') {
    await audioCtx.suspend();
    sendReset();
    setEngineState('ready', 'Engine initialized but paused. Press power to run audio.');
    stopProgressAnimation();
  }
});

updateSourceBadge();
updateTransportButtons();
updateTimelineUI(0);
