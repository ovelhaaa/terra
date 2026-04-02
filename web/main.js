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
let selectedModuleId = null;

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
const fileControlsWrap = document.getElementById('file-player-controls');
const audioFileInput = document.getElementById('audioFile');
const playFileBtn = document.getElementById('playFileBtn');
const pauseFileBtn = document.getElementById('pauseFileBtn');
const stopFileBtn = document.getElementById('stopFileBtn');
const transportStateLabel = document.getElementById('transport-state');
const timelineInput = document.getElementById('transportTimeline');
const elapsedTimeLabel = document.getElementById('elapsed-time');
const durationTimeLabel = document.getElementById('duration-time');
const loopPlaybackInput = document.getElementById('loopPlayback');

const patchChainList = document.getElementById('patch-chain-list');
const inspectorContent = document.getElementById('inspector-content');
const addEarthBtn = document.getElementById('add-earth-module');
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
  { id: 'preDelay', label: 'Pre-Delay', kind: 'range', min: 0, max: 1, step: 0.01, decimals: 2, suffix: '' },
  { id: 'mix', label: 'Mix', kind: 'range', min: 0, max: 1, step: 0.01, decimals: 2, suffix: '' },
  { id: 'decay', label: 'Decay', kind: 'range', min: 0, max: 1, step: 0.01, decimals: 2, suffix: '' },
  { id: 'modDepth', label: 'Mod Depth', kind: 'range', min: 0, max: 1, step: 0.01, decimals: 2, suffix: '' },
  { id: 'modSpeed', label: 'Mod Speed', kind: 'range', min: 0, max: 1, step: 0.01, decimals: 2, suffix: '' },
  { id: 'filter', label: 'Filter', kind: 'range', min: 0, max: 1, step: 0.01, decimals: 2, suffix: '' },
  { id: 'eq1Gain', label: 'EQ 1 (Hi)', kind: 'range', min: -24, max: 24, step: 0.1, decimals: 1, suffix: ' dB' },
  { id: 'eq2Gain', label: 'EQ 2 (Lo)', kind: 'range', min: -24, max: 24, step: 0.1, decimals: 1, suffix: ' dB' },
  {
    id: 'reverbSize', label: 'Size', kind: 'select',
    options: [{ value: 0, label: 'Small' }, { value: 1, label: 'Medium' }, { value: 2, label: 'Big' }]
  },
  {
    id: 'octaveMode', label: 'Octave', kind: 'select',
    options: [{ value: 0, label: 'None' }, { value: 1, label: 'Up' }, { value: 2, label: 'Up + Down' }]
  },
  {
    id: 'disableInputDiffusion', label: 'Input Diffusion', kind: 'select',
    options: [{ value: 0, label: 'On' }, { value: 1, label: 'Off' }]
  }
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
      { id: EARTH_MODULE_ID, type: 'earth', enabled: true, bypass: false, params: { ...DEFAULT_EARTH_PARAMS } },
      { id: GAIN_MODULE_ID, type: 'gain', enabled: true, bypass: false, params: { gain: 1.0 } }
    ]
  };
}

function clonePatch(patch) {
  return JSON.parse(JSON.stringify(patch));
}

function normalizeModule(module, index) {
  if (!module || typeof module !== 'object') return null;
  const type = String(module.type || '').trim();
  if (!['earth', 'gain', 'passthrough'].includes(type)) return null;

  const id = String(module.id || `${type}_${index + 1}`);
  const rawParams = module.params && typeof module.params === 'object' ? module.params : {};
  const params = {};
  for (const [key, value] of Object.entries(rawParams)) {
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

  if (!parsed || typeof parsed !== 'object') throw new Error('Patch precisa ser um objeto JSON.');
  if (!Array.isArray(parsed.chain)) throw new Error('Patch precisa conter "chain" como array.');

  const seenIds = new Set();
  const normalizedChain = [];
  for (let i = 0; i < parsed.chain.length; i += 1) {
    const normalized = normalizeModule(parsed.chain[i], i);
    if (!normalized) throw new Error(`Módulo inválido na posição ${i}. Tipos suportados: earth, gain, passthrough.`);
    if (seenIds.has(normalized.id)) throw new Error(`ID duplicado no patch: ${normalized.id}`);
    seenIds.add(normalized.id);

    if (normalized.type === 'earth') normalized.params = { ...DEFAULT_EARTH_PARAMS, ...normalized.params };
    if (normalized.type === 'gain') normalized.params = { gain: Number(normalized.params.gain ?? 1.0) };
    normalizedChain.push(normalized);
  }

  return {
    version: Number(parsed.version) || DEFAULT_PATCH_VERSION,
    meta: parsed.meta && typeof parsed.meta === 'object' ? { name: String(parsed.meta.name || 'Imported Patch') } : { name: 'Imported Patch' },
    chain: normalizedChain
  };
}

function serializePatch(patch) {
  return JSON.stringify(patch, null, 2);
}

function updatePatchCountersFromState() {
  patchCounters = { earth: 0, gain: 0, passthrough: 0 };
  for (const entry of patchState.chain) {
    if (!(entry.type in patchCounters)) continue;
    const match = String(entry.id).match(/_(\d+)$/);
    if (match) patchCounters[entry.type] = Math.max(patchCounters[entry.type], Number(match[1]));
  }
}

function nextModuleId(type) {
  patchCounters[type] = (patchCounters[type] || 0) + 1;
  return `${type}_${patchCounters[type]}`;
}

function findModuleById(moduleId) {
  return patchState.chain.find((entry) => entry.id === moduleId) || null;
}

function addModuleToPatch(type) {
  const module = { id: nextModuleId(type), type, enabled: true, bypass: false, params: {} };
  if (type === 'gain') module.params.gain = 1.0;
  if (type === 'earth') module.params = { ...DEFAULT_EARTH_PARAMS };
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

function setStatus(message) {
  statusText.textContent = message;
}

function setPatchMessage(message, isError = false) {
  patchMessage.textContent = message;
  patchMessage.dataset.state = isError ? 'error' : 'ok';
}

function setEngineState(state, message) {
  engineState = state;
  statusPill.dataset.state = state;
  const stateLabel = { off: 'Engine Off', initializing: 'Initializing', ready: 'Ready', running: 'Running', error: 'Error' };
  engineStateLabel.textContent = stateLabel[state] || 'Unknown';
  startButton.classList.toggle('running', state === 'running');
  startButton.textContent = state === 'running' ? 'On' : 'Power';
  if (message) setStatus(message);
  updateTransportButtons();
}

function setTransportState(state, message) {
  transportState = state;
  const readable = { stopped: 'Parado.', playing: 'Tocando.', paused: 'Pausado.', empty: 'Nenhum arquivo carregado.' };
  transportStateLabel.textContent = message || readable[state] || 'Estado desconhecido.';
  updateTransportButtons();
}

function logError(context, err) {
  console.error(`[EarthPedal] ${context}`, err);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateSourceUI() {
  const isMic = audioSourceSelect.value === 'mic';
  activeSourceBadge.textContent = isMic ? 'Mic Active' : 'File Active';
  activeSourceBadge.classList.add('active');
  fileControlsWrap.classList.toggle('hidden', isMic);
}

function updateTimelineUI(currentTime = 0) {
  if (!audioBuffer) {
    timelineInput.value = 0;
    elapsedTimeLabel.textContent = '00:00';
    durationTimeLabel.textContent = '00:00';
    return;
  }

  const duration = audioBuffer.duration;
  const safeTime = Math.max(0, Math.min(currentTime, duration));
  const progress = duration > 0 ? (safeTime / duration) * 100 : 0;
  timelineInput.value = String(progress);
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
  const elapsedSinceStart = audioCtx.currentTime - playbackStartTime;
  const rawPosition = pausedOffset + elapsedSinceStart;
  const playbackPosition = loopPlaybackInput.checked ? rawPosition % duration : Math.min(rawPosition, duration);
  updateTimelineUI(playbackPosition);
  animationFrameId = requestAnimationFrame(updateProgressLoop);
}

function stopAndDisconnectFileSource() {
  if (!fileSourceNode) return;
  try { fileSourceNode.stop(); } catch (_e) {}
  try { fileSourceNode.disconnect(); } catch (_e) {}
  fileSourceNode.onended = null;
  fileSourceNode = null;
}

function disconnectMicSource() {
  if (!micSourceNode) return;
  try { micSourceNode.disconnect(); } catch (_e) {}
}

function disconnectAllSources() {
  stopAndDisconnectFileSource();
  disconnectMicSource();
}

async function ensureMicSource() {
  if (!audioCtx || !earthNode) throw new Error('Audio graph is not initialized yet.');

  if (!micStream) {
    setStatus('Requesting microphone access…');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false, latency: 0 }
    });
  }

  if (!micSourceNode) micSourceNode = audioCtx.createMediaStreamSource(micStream);
  disconnectAllSources();
  micSourceNode.connect(earthNode);
  setStatus('Mic routed to Earth engine.');
}

function connectFileMode() {
  disconnectAllSources();
  setStatus(audioBuffer ? 'Arquivo pronto. Use o transporte.' : 'Fonte arquivo selecionada. Carregue um áudio.');
  if (!audioBuffer) {
    setTransportState('empty', 'Nenhum arquivo carregado.');
    updateTimelineUI(0);
  }
}

function switchSource(mode) {
  updateSourceUI();
  if (mode === 'mic') {
    if (!audioCtx || !earthNode) {
      setStatus('Engine desligada. Ligue a engine para usar microfone.');
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
  audioFileInput.disabled = !inFileMode;
  loopPlaybackInput.disabled = !inFileMode;
}

function startPlaybackAt(offsetSeconds) {
  if (!audioCtx || !audioBuffer || !earthNode) return;

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
    if (fileSourceNode && fileSourceNode.loop) return;
    fileSourceNode = null;
    pausedOffset = 0;
    stopProgressAnimation();
    updateTimelineUI(0);
    setTransportState('stopped', 'Parado.');
  };

  fileSourceNode.start(0, startOffset);
  setTransportState('playing', `Tocando em ${formatTime(startOffset)}.`);
  updateProgressLoop();
}

function playFile() {
  if (!audioBuffer) {
    setTransportState('empty', 'Carregue um arquivo antes de tocar.');
    return;
  }
  if (!audioCtx || audioCtx.state !== 'running') {
    setStatus('Engine não está em execução.');
    return;
  }
  startPlaybackAt(pausedOffset);
}

function pausePlayback() {
  if (transportState !== 'playing' || !audioBuffer || !audioCtx) return;
  pausedOffset += audioCtx.currentTime - playbackStartTime;
  if (audioBuffer.duration > 0) pausedOffset %= audioBuffer.duration;
  stopAndDisconnectFileSource();
  stopProgressAnimation();
  updateTimelineUI(pausedOffset);
  setTransportState('paused', `Pausado em ${formatTime(pausedOffset)}.`);
}

function stopPlayback() {
  stopAndDisconnectFileSource();
  stopProgressAnimation();
  pausedOffset = 0;
  updateTimelineUI(0);
  setTransportState(audioBuffer ? 'stopped' : 'empty', audioBuffer ? 'Parado.' : 'Nenhum arquivo carregado.');
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

function updateMetricsUI(metrics) {
  metricBlockSize.textContent = String(metrics.blockSize ?? '-');
  metricSampleRate.textContent = String(metrics.sampleRate ?? '-');
  metricAvgMs.textContent = Number(metrics.avgProcessMs || 0).toFixed(4);
  metricPeakMs.textContent = Number(metrics.peakProcessMs || 0).toFixed(4);
}

function refreshPatchJsonTextarea() {
  patchJsonTextarea.value = serializePatch(patchState);
}

function setSelectedModule(moduleId) {
  selectedModuleId = moduleId;
  renderPatchChain();
  renderInspector();
}

function renderPatchChain() {
  patchChainList.innerHTML = '';

  patchState.chain.forEach((module, index) => {
    const item = document.createElement('li');
    item.className = `patch-item${module.id === selectedModuleId ? ' selected' : ''}`;

    const top = document.createElement('div');
    top.className = 'patch-item-top';
    top.textContent = `${index + 1}. ${module.type} (${module.id})`;

    const state = document.createElement('span');
    state.className = 'pill';
    state.textContent = module.bypass ? 'Bypassed' : (module.enabled ? 'Enabled' : 'Disabled');
    top.appendChild(state);

    const actions = document.createElement('div');
    actions.className = 'patch-actions';

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.textContent = module.id === selectedModuleId ? 'Selected' : 'Select';
    selectBtn.addEventListener('click', () => setSelectedModule(module.id));

    const bypassBtn = document.createElement('button');
    bypassBtn.type = 'button';
    bypassBtn.textContent = module.bypass ? 'Unbypass' : 'Bypass';
    bypassBtn.addEventListener('click', () => {
      module.bypass = !module.bypass;
      postToEngine({ type: 'setModuleBypass', moduleId: module.id, bypass: module.bypass });
      renderPatchChain();
      renderInspector();
      refreshPatchJsonTextarea();
    });

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      if (moveModuleInPatch(module.id, 'up')) {
        postToEngine({ type: 'reorderModules', moduleIds: patchState.chain.map((entry) => entry.id) });
        syncControlsFromPatch();
      }
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.textContent = '↓';
    downBtn.disabled = index === patchState.chain.length - 1;
    downBtn.addEventListener('click', () => {
      if (moveModuleInPatch(module.id, 'down')) {
        postToEngine({ type: 'reorderModules', moduleIds: patchState.chain.map((entry) => entry.id) });
        syncControlsFromPatch();
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.disabled = module.type === 'earth' && patchState.chain.filter((entry) => entry.type === 'earth').length === 1;
    removeBtn.addEventListener('click', () => {
      const removed = removeModuleFromPatch(module.id);
      if (!removed) return;
      postToEngine({ type: 'removeModule', moduleId: module.id });
      if (selectedModuleId === module.id) selectedModuleId = patchState.chain[0]?.id || null;
      syncControlsFromPatch();
      setPatchMessage(`Módulo ${removed.id} removido.`);
    });

    actions.append(selectBtn, bypassBtn, upBtn, downBtn, removeBtn);
    item.append(top, actions);
    patchChainList.appendChild(item);
  });
}

function createRangeControl(module, config) {
  const wrap = document.createElement('div');
  wrap.className = 'control';

  const head = document.createElement('div');
  head.className = 'control-head';
  const label = document.createElement('span');
  label.textContent = config.label;
  const valueTag = document.createElement('strong');

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = String(config.step);
  const value = Number(module.params[config.id] ?? 0);
  input.value = String(value);
  valueTag.textContent = `${value.toFixed(config.decimals)}${config.suffix}`;

  input.addEventListener('input', (e) => {
    const next = Number(e.target.value);
    module.params[config.id] = next;
    valueTag.textContent = `${next.toFixed(config.decimals)}${config.suffix}`;
    postToEngine({ type: 'setParam', moduleId: module.id, paramId: config.id, value: next });
    refreshPatchJsonTextarea();
  });

  head.append(label, valueTag);
  wrap.append(head, input);
  return wrap;
}

function createSelectControl(module, config) {
  const wrap = document.createElement('div');
  wrap.className = 'control';
  const label = document.createElement('label');
  label.textContent = config.label;

  const select = document.createElement('select');
  for (const option of config.options) {
    const item = document.createElement('option');
    item.value = String(option.value);
    item.textContent = option.label;
    select.appendChild(item);
  }

  const rawValue = module.params[config.id] ?? 0;
  const selectValue = config.id === 'disableInputDiffusion' ? (rawValue ? 1 : 0) : Number(rawValue);
  select.value = String(selectValue);

  select.addEventListener('change', (e) => {
    const next = Number(e.target.value);
    module.params[config.id] = config.id === 'disableInputDiffusion' ? next === 1 : next;
    postToEngine({ type: 'setParam', moduleId: module.id, paramId: config.id, value: next });
    refreshPatchJsonTextarea();
  });

  wrap.append(label, select);
  return wrap;
}

function renderInspector() {
  const module = findModuleById(selectedModuleId);
  if (!module) {
    inspectorContent.className = 'inspector-empty';
    inspectorContent.textContent = 'Nenhum módulo selecionado. Selecione um item da cadeia para editar parâmetros.';
    return;
  }

  inspectorContent.className = 'inspector-controls';
  inspectorContent.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'control';
  title.innerHTML = `<div class="control-head"><strong>${module.type.toUpperCase()}</strong><span>${module.id}</span></div>`;
  inspectorContent.appendChild(title);

  if (module.type === 'earth') {
    earthParamMappings.forEach((config) => {
      inspectorContent.appendChild(config.kind === 'range' ? createRangeControl(module, config) : createSelectControl(module, config));
    });
    return;
  }

  if (module.type === 'gain') {
    inspectorContent.appendChild(createRangeControl(module, {
      id: 'gain', label: 'Output Gain', kind: 'range', min: 0, max: 2, step: 0.01, decimals: 2, suffix: ''
    }));

    const bypassWrap = document.createElement('div');
    bypassWrap.className = 'control';
    const bypassLabel = document.createElement('label');
    bypassLabel.textContent = 'Bypass';
    const bypassSelect = document.createElement('select');
    bypassSelect.innerHTML = '<option value="0">Off</option><option value="1">On</option>';
    bypassSelect.value = module.bypass ? '1' : '0';
    bypassSelect.addEventListener('change', (e) => {
      module.bypass = e.target.value === '1';
      postToEngine({ type: 'setModuleBypass', moduleId: module.id, bypass: module.bypass });
      renderPatchChain();
      refreshPatchJsonTextarea();
    });
    bypassWrap.append(bypassLabel, bypassSelect);
    inspectorContent.appendChild(bypassWrap);
    return;
  }

  const passthroughHint = document.createElement('div');
  passthroughHint.className = 'control';
  passthroughHint.textContent = 'Passthrough não possui parâmetros.';
  inspectorContent.appendChild(passthroughHint);
}

function syncControlsFromPatch() {
  if (!findModuleById(selectedModuleId)) selectedModuleId = patchState.chain[0]?.id || null;
  renderPatchChain();
  renderInspector();
  refreshPatchJsonTextarea();
}

function setupUIBindings() {
  addEarthBtn?.addEventListener('click', () => {
    const module = addModuleToPatch('earth');
    postToEngine({ type: 'addModule', module });
    setSelectedModule(module.id);
    syncControlsFromPatch();
    setPatchMessage(`Módulo ${module.id} adicionado.`);
  });

  addGainBtn?.addEventListener('click', () => {
    const module = addModuleToPatch('gain');
    postToEngine({ type: 'addModule', module });
    setSelectedModule(module.id);
    syncControlsFromPatch();
    setPatchMessage(`Módulo ${module.id} adicionado.`);
  });

  addPassthroughBtn?.addEventListener('click', () => {
    const module = addModuleToPatch('passthrough');
    postToEngine({ type: 'addModule', module });
    setSelectedModule(module.id);
    syncControlsFromPatch();
    setPatchMessage(`Módulo ${module.id} adicionado.`);
  });

  resetPatchBtn?.addEventListener('click', () => {
    patchState = createDefaultPatch();
    updatePatchCountersFromState();
    selectedModuleId = patchState.chain[0]?.id || null;
    sendPatch();
    syncControlsFromPatch();
    setPatchMessage('Patch restaurado para o padrão.');
  });

  exportPatchBtn?.addEventListener('click', async () => {
    refreshPatchJsonTextarea();
    try {
      await navigator.clipboard.writeText(patchJsonTextarea.value);
      setPatchMessage('Patch exportado para a área de transferência.');
    } catch (_err) {
      setPatchMessage('Patch disponível no painel (cópia automática indisponível).', true);
    }
  });

  importPatchBtn?.addEventListener('click', () => {
    try {
      const parsed = parsePatch(patchJsonTextarea.value);
      patchState = clonePatch(parsed);
      updatePatchCountersFromState();
      selectedModuleId = patchState.chain[0]?.id || null;
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
    earthNode = new AudioWorkletNode(audioCtx, 'earth-worklet-processor', { outputChannelCount: [2] });

    earthNode.port.onmessage = async (event) => {
      if (event.data.type === 'ready') {
        if (!uiBindingsInitialized) {
          setupUIBindings();
          uiBindingsInitialized = true;
        }

        sendPatch();
        setEngineState('running', 'Engine online. Escolha fonte e toque áudio.');

        try {
          await switchSource(audioSourceSelect.value);
        } catch (err) {
          logError('source activation failed after worklet ready', err);
          setStatus(`Engine pronta, mas a fonte falhou: ${err.message}`);
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

    setStatus('Finalizando startup da engine…');
  } catch (err) {
    logError('audio initialization failed', err);
    setEngineState('error', `Initialization failed: ${err.message}`);
    throw err;
  }
}

audioSourceSelect.addEventListener('change', async (e) => {
  try {
    await switchSource(e.target.value);
    updateTransportButtons();
  } catch (err) {
    logError('source switch failed', err);
    setStatus(`Erro na troca de fonte: ${err.message}`);
  }
});

audioFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (!audioCtx) {
    setStatus('Ligue a engine antes de carregar arquivo.');
    return;
  }

  try {
    setStatus('Loading file…');
    const arrayBuffer = await file.arrayBuffer();
    setStatus('Decoding file…');
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    pausedOffset = 0;
    updateTimelineUI(0);
    setTransportState('stopped', `Carregado: ${file.name}`);
    setStatus('Arquivo pronto para reprodução.');
  } catch (err) {
    logError('error decoding audio file', err);
    setEngineState('error', `File decode error: ${err.message}`);
  }
});

playFileBtn.addEventListener('click', () => {
  if (audioSourceSelect.value !== 'file') {
    setStatus('Troque para fonte Arquivo para usar transporte.');
    return;
  }
  playFile();
});

pauseFileBtn.addEventListener('click', pausePlayback);
stopFileBtn.addEventListener('click', stopPlayback);

timelineInput.addEventListener('input', () => {
  if (!audioBuffer) return;
  const target = (Number(timelineInput.value) / 100) * audioBuffer.duration;
  updateTimelineUI(target);
  if (transportState === 'playing') {
    startPlaybackAt(target);
  } else {
    pausedOffset = target;
    setTransportState('paused', `Posição: ${formatTime(target)}.`);
  }
});

loopPlaybackInput.addEventListener('change', () => {
  if (fileSourceNode) fileSourceNode.loop = loopPlaybackInput.checked;
});

startButton.addEventListener('click', async () => {
  if (!audioCtx) {
    try {
      await initAudio();
    } catch (_err) {}
    return;
  }

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
    sendPatch();
    setEngineState('running', 'Engine em execução.');
    return;
  }

  if (audioCtx.state === 'running') {
    await audioCtx.suspend();
    sendReset();
    setEngineState('ready', 'Engine inicializada, mas pausada.');
    stopProgressAnimation();
  }
});

updatePatchCountersFromState();
selectedModuleId = patchState.chain[0]?.id || null;
syncControlsFromPatch();
setPatchMessage('Patch pronto.');
updateSourceUI();
updateTransportButtons();
updateTimelineUI(0);
