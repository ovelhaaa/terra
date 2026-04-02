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
const EARTH_MODULE_ID = 'earth_1';
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

const patchChainList = document.getElementById('patch-chain-list');
const addGainBtn = document.getElementById('add-gain-module');
const addPassthroughBtn = document.getElementById('add-passthrough-module');
const resetPatchBtn = document.getElementById('restore-default-patch');
const exportPatchBtn = document.getElementById('export-patch-json');
const importPatchBtn = document.getElementById('import-patch-json');
const patchJsonTextarea = document.getElementById('patch-json');
const patchMessage = document.getElementById('patch-message');

const metricBlockSize = document.getElementById('metric-block-size');
const metricSampleRate = document.getElementById('metric-sample-rate');
const metricAvgMs = document.getElementById('metric-avg-ms');
const metricPeakMs = document.getElementById('metric-peak-ms');

const WORKLET_URL = new URL('./earth-worklet-processor.js', import.meta.url).href;
const WASM_URL = new URL('./earth-module.wasm', import.meta.url).href;

const earthParamMappings = [
  { id: 'preDelay', isSwitch: false, suffix: '', decimals: 2 },
  { id: 'mix', isSwitch: false, suffix: '', decimals: 2 },
  { id: 'decay', isSwitch: false, suffix: '', decimals: 2 },
  { id: 'modDepth', isSwitch: false, suffix: '', decimals: 2 },
  { id: 'modSpeed', isSwitch: false, suffix: '', decimals: 2 },
  { id: 'filter', isSwitch: false, suffix: '', decimals: 2 },
  { id: 'eq1Gain', isSwitch: false, suffix: ' dB', decimals: 1 },
  { id: 'eq2Gain', isSwitch: false, suffix: ' dB', decimals: 1 },
  { id: 'reverbSize', isSwitch: true },
  { id: 'octaveMode', isSwitch: true },
  { id: 'disableInputDiffusion', isSwitch: true }
];

const DEFAULT_EARTH_PARAMS = {
  preDelay: 0.0,
  mix: 0.5,
  decay: 0.5,
  modDepth: 0.5,
  modSpeed: 0.5,
  filter: 0.5,
  eq1Gain: -11.0,
  eq2Gain: 5.0,
  reverbSize: 1,
  octaveMode: 0,
  disableInputDiffusion: false
};

let patchState = createDefaultPatch();
let patchCounters = { earth: 1, gain: 1, passthrough: 0 };

function createDefaultPatch() {
  return {
    version: DEFAULT_PATCH_VERSION,
    meta: { name: 'Default Patch' },
    chain: [
      {
        id: EARTH_MODULE_ID,
        type: 'earth',
        enabled: true,
        bypass: false,
        params: { ...DEFAULT_EARTH_PARAMS }
      },
      {
        id: GAIN_MODULE_ID,
        type: 'gain',
        enabled: true,
        bypass: false,
        params: { gain: 1.0 }
      }
    ]
  };
}

function clonePatch(patch) {
  return JSON.parse(JSON.stringify(patch));
}

function normalizeModule(module, index) {
  if (!module || typeof module !== 'object') {
    return null;
  }

  const type = String(module.type || '').trim();
  if (!['earth', 'gain', 'passthrough'].includes(type)) {
    return null;
  }

  const id = String(module.id || `${type}_${index + 1}`);
  const rawParams = module.params && typeof module.params === 'object' ? module.params : {};
  const params = {};
  const paramKeys = Object.keys(rawParams);
  for (let i = 0; i < paramKeys.length; i += 1) {
    const key = paramKeys[i];
    const value = rawParams[key];
    params[key] = typeof value === 'boolean' ? value : Number(value);
  }

  return {
    id,
    type,
    enabled: module.enabled !== false,
    bypass: module.bypass === true,
    params
  };
}

function parsePatch(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`JSON inválido: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Patch precisa ser um objeto JSON.');
  }

  if (!Array.isArray(parsed.chain)) {
    throw new Error('Patch precisa conter "chain" como array.');
  }

  const seenIds = new Set();
  const normalizedChain = [];

  for (let i = 0; i < parsed.chain.length; i += 1) {
    const normalized = normalizeModule(parsed.chain[i], i);
    if (!normalized) {
      throw new Error(`Módulo inválido na posição ${i}. Tipos suportados: earth, gain, passthrough.`);
    }

    if (seenIds.has(normalized.id)) {
      throw new Error(`ID duplicado no patch: ${normalized.id}`);
    }
    seenIds.add(normalized.id);

    if (normalized.type === 'earth') {
      normalized.params = { ...DEFAULT_EARTH_PARAMS, ...normalized.params };
    }
    if (normalized.type === 'gain') {
      normalized.params = { gain: Number(normalized.params.gain ?? 1.0) };
    }

    normalizedChain.push(normalized);
  }

  return {
    version: Number(parsed.version) || DEFAULT_PATCH_VERSION,
    meta: parsed.meta && typeof parsed.meta === 'object'
      ? { name: String(parsed.meta.name || 'Imported Patch') }
      : { name: 'Imported Patch' },
    chain: normalizedChain
  };
}

function serializePatch(patch) {
  return JSON.stringify(patch, null, 2);
}

function updatePatchCountersFromState() {
  patchCounters = { earth: 0, gain: 0, passthrough: 0 };
  for (let i = 0; i < patchState.chain.length; i += 1) {
    const entry = patchState.chain[i];
    if (!patchCounters[entry.type] && patchCounters[entry.type] !== 0) continue;
    const match = String(entry.id).match(/_(\d+)$/);
    if (match) {
      patchCounters[entry.type] = Math.max(patchCounters[entry.type], Number(match[1]));
    }
  }
}

function nextModuleId(type) {
  patchCounters[type] = (patchCounters[type] || 0) + 1;
  return `${type}_${patchCounters[type]}`;
}

function addModuleToPatch(type) {
  const id = nextModuleId(type);
  const module = {
    id,
    type,
    enabled: true,
    bypass: false,
    params: {}
  };

  if (type === 'gain') {
    module.params.gain = 1.0;
  }

  patchState.chain.push(module);
  return module;
}

function removeModuleFromPatch(moduleId) {
  const index = patchState.chain.findIndex((entry) => entry.id === moduleId);
  if (index === -1) return null;
  const [removed] = patchState.chain.splice(index, 1);
  return removed;
}

function moveModuleInPatch(moduleId, direction) {
  const index = patchState.chain.findIndex((entry) => entry.id === moduleId);
  if (index === -1) return false;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= patchState.chain.length) return false;
  const [entry] = patchState.chain.splice(index, 1);
  patchState.chain.splice(target, 0, entry);
  return true;
}

function findFirstModuleByType(type) {
  return patchState.chain.find((entry) => entry.type === type) || null;
}

function setStatus(message) {
  statusText.textContent = message;
}

function setPatchMessage(message, isError = false) {
  if (!patchMessage) return;
  patchMessage.textContent = message;
  patchMessage.dataset.state = isError ? 'error' : 'ok';
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

function postToEngine(message) {
  if (!earthNode) return;
  earthNode.port.postMessage(message);
}

function sendPatch() {
  postToEngine({ type: 'setPatch', patch: clonePatch(patchState) });
}

function sendReset() {
  postToEngine({ type: 'reset' });
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

function syncEarthControlsFromPatch() {
  const earthModule = findFirstModuleByType('earth');

  for (let i = 0; i < earthParamMappings.length; i += 1) {
    const mapping = earthParamMappings[i];
    const input = document.getElementById(mapping.id);
    const valueLabel = document.getElementById(`${mapping.id}-val`);
    if (!input) continue;

    const hasEarth = Boolean(earthModule);
    input.disabled = !hasEarth;

    if (!hasEarth) continue;

    const value = earthModule.params[mapping.id] ?? DEFAULT_EARTH_PARAMS[mapping.id] ?? 0;
    input.value = String(value);

    if (!mapping.isSwitch && valueLabel) {
      valueLabel.textContent = `${Number(value).toFixed(mapping.decimals)}${mapping.suffix}`;
    }
  }
}

function syncGainControlsFromPatch() {
  const gainModule = findFirstModuleByType('gain');
  const hasGain = Boolean(gainModule);

  if (gainInput) {
    gainInput.disabled = !hasGain;
    const value = hasGain ? Number(gainModule.params.gain ?? 1.0) : 1.0;
    gainInput.value = String(value);
    setMetricText(gainValueLabel, value.toFixed(2));
  }

  if (gainBypassInput) {
    gainBypassInput.disabled = !hasGain;
    gainBypassInput.value = hasGain && gainModule.bypass ? '1' : '0';
  }
}

function refreshPatchJsonTextarea() {
  if (patchJsonTextarea) {
    patchJsonTextarea.value = serializePatch(patchState);
  }
}

function renderPatchChain() {
  if (!patchChainList) return;

  patchChainList.innerHTML = '';

  for (let i = 0; i < patchState.chain.length; i += 1) {
    const module = patchState.chain[i];
    const item = document.createElement('li');
    item.className = 'patch-item';

    const label = document.createElement('span');
    label.className = 'patch-item-label';
    label.textContent = `${i + 1}. ${module.type} (${module.id})`;

    const controls = document.createElement('div');
    controls.className = 'patch-item-actions';

    const enabledToggle = document.createElement('button');
    enabledToggle.className = 'patch-action-btn';
    enabledToggle.textContent = module.enabled ? 'Disable' : 'Enable';
    enabledToggle.addEventListener('click', () => {
      module.enabled = !module.enabled;
      postToEngine({ type: 'setModuleEnabled', moduleId: module.id, enabled: module.enabled });
      renderPatchChain();
      refreshPatchJsonTextarea();
    });

    const bypassToggle = document.createElement('button');
    bypassToggle.className = 'patch-action-btn';
    bypassToggle.textContent = module.bypass ? 'Unbypass' : 'Bypass';
    bypassToggle.addEventListener('click', () => {
      module.bypass = !module.bypass;
      postToEngine({ type: 'setModuleBypass', moduleId: module.id, bypass: module.bypass });
      syncGainControlsFromPatch();
      renderPatchChain();
      refreshPatchJsonTextarea();
    });

    const upBtn = document.createElement('button');
    upBtn.className = 'patch-action-btn';
    upBtn.textContent = '↑';
    upBtn.disabled = i === 0;
    upBtn.addEventListener('click', () => {
      if (moveModuleInPatch(module.id, 'up')) {
        postToEngine({ type: 'reorderModules', moduleIds: patchState.chain.map((entry) => entry.id) });
        syncControlsFromPatch();
      }
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'patch-action-btn';
    downBtn.textContent = '↓';
    downBtn.disabled = i === patchState.chain.length - 1;
    downBtn.addEventListener('click', () => {
      if (moveModuleInPatch(module.id, 'down')) {
        postToEngine({ type: 'reorderModules', moduleIds: patchState.chain.map((entry) => entry.id) });
        syncControlsFromPatch();
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'patch-action-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.disabled = module.type === 'earth' && patchState.chain.filter((entry) => entry.type === 'earth').length === 1;
    removeBtn.addEventListener('click', () => {
      const removed = removeModuleFromPatch(module.id);
      if (!removed) return;
      postToEngine({ type: 'removeModule', moduleId: module.id });
      syncControlsFromPatch();
      setPatchMessage(`Módulo ${removed.id} removido.`);
      if (removed.type === 'earth' && !findFirstModuleByType('earth')) {
        setPatchMessage('Último módulo earth removido. DSP principal ficará em bypass até adicionar outro.', true);
      }
    });

    controls.append(enabledToggle, bypassToggle, upBtn, downBtn, removeBtn);
    item.append(label, controls);
    patchChainList.appendChild(item);
  }
}

function syncControlsFromPatch() {
  syncEarthControlsFromPatch();
  syncGainControlsFromPatch();
  renderPatchChain();
  refreshPatchJsonTextarea();
}

function setModuleParam(type, paramId, value) {
  const module = findFirstModuleByType(type);
  if (!module) return;
  module.params[paramId] = value;
  postToEngine({ type: 'setParam', moduleId: module.id, paramId, value });
  refreshPatchJsonTextarea();
}

function setupUIBindings() {
  for (let i = 0; i < earthParamMappings.length; i += 1) {
    const mapping = earthParamMappings[i];
    const input = document.getElementById(mapping.id);
    const valueLabel = document.getElementById(`${mapping.id}-val`);
    if (!input) continue;

    if (!mapping.isSwitch) {
      input.addEventListener('input', (e) => {
        const value = Number(e.target.value);
        setModuleParam('earth', mapping.id, value);

        if (valueLabel) {
          valueLabel.textContent = `${value.toFixed(mapping.decimals)}${mapping.suffix}`;
        }
      });
    }

    if (mapping.isSwitch) {
      input.addEventListener('change', (e) => {
        const value = Number(e.target.value);
        setModuleParam('earth', mapping.id, value);
      });
    }
  }

  if (gainInput) {
    gainInput.addEventListener('input', (e) => {
      const value = Number(e.target.value);
      setMetricText(gainValueLabel, value.toFixed(2));
      setModuleParam('gain', 'gain', value);
    });
  }

  if (gainBypassInput) {
    gainBypassInput.addEventListener('change', (e) => {
      const gainModule = findFirstModuleByType('gain');
      if (!gainModule) return;
      gainModule.bypass = e.target.value === '1';
      postToEngine({ type: 'setModuleBypass', moduleId: gainModule.id, bypass: gainModule.bypass });
      renderPatchChain();
      refreshPatchJsonTextarea();
    });
  }

  addGainBtn?.addEventListener('click', () => {
    const module = addModuleToPatch('gain');
    postToEngine({ type: 'addModule', module });
    syncControlsFromPatch();
    setPatchMessage(`Módulo ${module.id} adicionado.`);
  });

  addPassthroughBtn?.addEventListener('click', () => {
    const module = addModuleToPatch('passthrough');
    postToEngine({ type: 'addModule', module });
    syncControlsFromPatch();
    setPatchMessage(`Módulo ${module.id} adicionado.`);
  });

  resetPatchBtn?.addEventListener('click', () => {
    patchState = createDefaultPatch();
    updatePatchCountersFromState();
    sendPatch();
    syncControlsFromPatch();
    setPatchMessage('Patch restaurado para o default.');
  });

  exportPatchBtn?.addEventListener('click', async () => {
    refreshPatchJsonTextarea();
    if (!patchJsonTextarea) return;
    try {
      await navigator.clipboard.writeText(patchJsonTextarea.value);
      setPatchMessage('Patch exportado para a área de transferência.');
    } catch (err) {
      setPatchMessage('Patch exportado no painel (não foi possível copiar automaticamente).', true);
    }
  });

  importPatchBtn?.addEventListener('click', () => {
    if (!patchJsonTextarea) return;

    try {
      const parsed = parsePatch(patchJsonTextarea.value);
      patchState = clonePatch(parsed);
      updatePatchCountersFromState();
      sendPatch();
      syncControlsFromPatch();
      setPatchMessage('Patch importado com sucesso.');
    } catch (err) {
      setPatchMessage(err.message || 'Falha ao importar patch.', true);
    }
  });
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
    sendPatch();
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

updatePatchCountersFromState();
syncControlsFromPatch();
setPatchMessage('Patch pronto.');
updateSourceBadge();
updateTransportButtons();
updateTimelineUI(0);
