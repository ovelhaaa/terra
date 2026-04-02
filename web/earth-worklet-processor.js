import Module from './earth-module.js';

function ensureURLConstructor() {
  if (typeof globalThis.URL === 'function') {
    return;
  }

  const hasAbsoluteScheme = (value) => /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);

  const normalizePath = (path) => {
    const segments = [];
    path.split('/').forEach((segment) => {
      if (!segment || segment === '.') return;
      if (segment === '..') {
        segments.pop();
        return;
      }
      segments.push(segment);
    });
    return segments.join('/');
  };

  globalThis.URL = class URL {
    constructor(path, base) {
      const input = String(path ?? '');
      if (!base || input.startsWith('/') || hasAbsoluteScheme(input)) {
        this.href = input;
        return;
      }

      const baseStr = String(base);
      const originMatch = baseStr.match(/^([a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]+)(\/.*)?$/);
      if (!originMatch) {
        this.href = input;
        return;
      }

      const origin = originMatch[1];
      const basePath = originMatch[2] || '/';
      const folder = basePath.endsWith('/') ? basePath : basePath.slice(0, basePath.lastIndexOf('/') + 1);
      const normalized = normalizePath(`${folder}${input}`);
      this.href = `${origin}/${normalized}`;
    }

    toString() {
      return this.href;
    }
  };
}

class PassThroughModule {
  reset() {}
  setParam() {}

  process(channelData) {
    return channelData;
  }
}

class GainModule {
  constructor() {
    this.gain = 1.0;
  }

  setParam(paramId, value) {
    if (paramId === 'gain') {
      this.gain = Number.isFinite(value) ? value : this.gain;
    }
  }

  reset() {}

  process(channelData, frames) {
    const gain = this.gain;
    for (let ch = 0; ch < channelData.length; ch += 1) {
      const channel = channelData[ch];
      for (let i = 0; i < frames; i += 1) {
        channel[i] *= gain;
      }
    }
    return channelData;
  }
}

class EarthModule {
  constructor(wasmModule, sampleRateValue, maxBlockSize) {
    this.module = wasmModule;
    this.sampleRate = sampleRateValue;
    this.maxBlockSize = maxBlockSize;
    this.processor = new wasmModule.EarthAudioProcessor(sampleRateValue);

    this.inLPtr = 0;
    this.inRPtr = 0;
    this.outLPtr = 0;
    this.outRPtr = 0;
    this.bufferSize = 0;

    this.params = {
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
      disableInputDiffusion: 0
    };

    this.ensureBuffer(Math.max(1, maxBlockSize || 128));
  }

  ensureBuffer(size) {
    if (this.bufferSize >= size && this.inLPtr && this.inRPtr && this.outLPtr && this.outRPtr) {
      return true;
    }

    this.freeBuffers();

    const bytes = size * Float32Array.BYTES_PER_ELEMENT;
    this.inLPtr = this.module._malloc(bytes);
    this.inRPtr = this.module._malloc(bytes);
    this.outLPtr = this.module._malloc(bytes);
    this.outRPtr = this.module._malloc(bytes);

    if (!this.inLPtr || !this.inRPtr || !this.outLPtr || !this.outRPtr) {
      this.freeBuffers();
      return false;
    }

    this.bufferSize = size;
    return true;
  }

  freeBuffers() {
    if (!this.module) return;

    if (this.inLPtr) this.module._free(this.inLPtr);
    if (this.inRPtr) this.module._free(this.inRPtr);
    if (this.outLPtr) this.module._free(this.outLPtr);
    if (this.outRPtr) this.module._free(this.outRPtr);

    this.inLPtr = 0;
    this.inRPtr = 0;
    this.outLPtr = 0;
    this.outRPtr = 0;
    this.bufferSize = 0;
  }

  setParam(paramId, value) {
    this.params[paramId] = value;
  }

  applyParams() {
    this.processor.setPreDelay(Number(this.params.preDelay) || 0);
    this.processor.setMix(Number(this.params.mix) || 0);
    this.processor.setDecay(Number(this.params.decay) || 0);
    this.processor.setModDepth(Number(this.params.modDepth) || 0);
    this.processor.setModSpeed(Number(this.params.modSpeed) || 0);
    this.processor.setFilter(Number(this.params.filter) || 0);
    this.processor.setEq1Gain(Number(this.params.eq1Gain) || 0);
    this.processor.setEq2Gain(Number(this.params.eq2Gain) || 0);
    this.processor.setReverbSize(Math.round(Number(this.params.reverbSize) || 0));
    this.processor.setOctaveMode(Math.round(Number(this.params.octaveMode) || 0));
    this.processor.setDisableInputDiffusion(Number(this.params.disableInputDiffusion) > 0.5);
  }

  process(channelData, frames) {
    if (!this.ensureBuffer(frames)) {
      return channelData;
    }

    const inL = channelData[0];
    let inR;

  process(channelData, frames) {
    if (!this.ensureBuffer(frames)) {
      return channelData;
    }

    const inL = channelData[0];
    const inR = channelData[1] || channelData[0];
    const outL = channelData[0];
    const outR = channelData[1] || channelData[0];
    const isStereo = channelData[1] !== undefined;

    this.applyParams();

    const heapF32 = this.module.HEAPF32;
    const inLIndex = this.inLPtr >> 2;
    const inRIndex = this.inRPtr >> 2;
    const outLIndex = this.outLPtr >> 2;
    const outRIndex = this.outRPtr >> 2;

    for (let i = 0; i < frames; i += 1) {
      heapF32[inLIndex + i] = inL[i];
      heapF32[inRIndex + i] = inR[i];
    }

    this.processor.process(this.inLPtr, this.inRPtr, this.outLPtr, this.outRPtr, frames);

    for (let i = 0; i < frames; i += 1) {
      outL[i] = heapF32[outLIndex + i];
      if (isStereo) {
        outR[i] = heapF32[outRIndex + i];
      }
    }

    return channelData;
  }

  dispose() {
    this.freeBuffers();
  }

  reset() {}
}

class SerialAudioEngine {
  constructor() {
    this.sampleRate = 0;
    this.maxBlockSize = 128;
    this.channelCount = 2;
    this.module = null;
    this.moduleStates = [];
    this.channelData = [null, null];
  }

  init(sampleRateValue, maxBlockSize, wasmModule) {
    this.sampleRate = sampleRateValue;
    this.maxBlockSize = Math.max(1, Math.floor(maxBlockSize || 128));
    this.module = wasmModule || null;
  }

  disposeModules() {
    for (let i = 0; i < this.moduleStates.length; i += 1) {
      const state = this.moduleStates[i];
      if (typeof state.module.dispose === 'function') {
        state.module.dispose();
      }
    }
  }

  createModule(type) {
    if (type === 'passthrough') return new PassThroughModule();
    if (type === 'gain') return new GainModule();
    if (type === 'earth' && this.module) {
      return new EarthModule(this.module, this.sampleRate, this.maxBlockSize);
    }
    return null;
  }

  setPatch(patch) {
    const chain = Array.isArray(patch?.chain) ? patch.chain : [];
    this.disposeModules();
    this.moduleStates = [];

    for (let i = 0; i < chain.length; i += 1) {
      const moduleConfig = chain[i];
      const module = this.createModule(moduleConfig?.type);
      if (!module) continue;

      const state = {
        id: String(moduleConfig.id || `${moduleConfig.type}_${i}`),
        enabled: moduleConfig.enabled !== false,
        bypass: moduleConfig.bypass === true,
        module
      };

      const params = moduleConfig.params || {};
      const paramIds = Object.keys(params);
      for (let p = 0; p < paramIds.length; p += 1) {
        module.setParam(paramIds[p], Number(params[paramIds[p]]));
      }

      this.moduleStates.push(state);
    }
  }

  setParam(moduleId, paramId, value) {
    for (let i = 0; i < this.moduleStates.length; i += 1) {
      const state = this.moduleStates[i];
      if (state.id === moduleId) {
        state.module.setParam(paramId, Number(value));
        return true;
      }
    }
    return false;
  }

  setModuleBypass(moduleId, bypass) {
    for (let i = 0; i < this.moduleStates.length; i += 1) {
      const state = this.moduleStates[i];
      if (state.id === moduleId) {
        state.bypass = bypass === true;
        return true;
      }
    }
    return false;
  }

  reset() {
    for (let i = 0; i < this.moduleStates.length; i += 1) {
      const state = this.moduleStates[i];
      if (typeof state.module.reset === 'function') {
        state.module.reset();
      }
    }
  }

  process(inputs, outputs, frames) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    if (output.length === 0 || frames <= 0) return;

    for (let ch = 0; ch < this.channelCount; ch += 1) {
      const inChannel = input[ch] || input[0];
      const outChannel = output[ch] || output[0];
      if (!outChannel) continue;

      if (inChannel) {
        outChannel.set(inChannel);
      } else {
        outChannel.fill(0, 0, frames);
      }
    }

    this.channelData[0] = output[0];
    this.channelData[1] = output[1] || output[0];

    for (let i = 0; i < this.moduleStates.length; i += 1) {
      const state = this.moduleStates[i];
      if (!state.enabled || state.bypass) continue;
      state.module.process(this.channelData, frames);
    }
  }
}

class EarthWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.module = null;
    this.isInitializing = false;
    this.engine = new SerialAudioEngine();

    this.metrics = {
      callbacks: 0,
      totalMs: 0,
      peakMs: 0,
      reportInterval: 30
    };

    this.port.onmessage = (event) => {
      const msg = event.data || {};

      if (msg.type === 'init') {
        this.init(msg.wasmBytes, msg.maxBlockSize).catch((err) => this.reportError('init', err));
        return;
      }

      if (msg.type === 'setPatch') {
        this.engine.setPatch(msg.patch || {});
        return;
      }

      if (msg.type === 'setParam') {
        this.engine.setParam(msg.moduleId, msg.paramId, msg.value);
        return;
      }

      if (msg.type === 'setModuleBypass') {
        this.engine.setModuleBypass(msg.moduleId, msg.bypass);
        return;
      }

      if (msg.type === 'reset') {
        this.engine.reset();
      }
    };
  }

  reportError(stage, err) {
    this.port.postMessage({
      type: 'error',
      stage,
      message: err?.message || String(err),
      stack: err?.stack || null
    });
  }

  async init(wasmBytes, maxBlockSize) {
    if (this.isInitializing) return;
    this.isInitializing = true;

    if (!wasmBytes || wasmBytes.byteLength === 0) {
      this.reportError('module-init', new Error('Missing wasm bytes'));
      this.isInitializing = false;
      return;
    }

    try {
      ensureURLConstructor();
      this.module = await Module({ wasmBinary: wasmBytes });
    } catch (err) {
      this.reportError('module-init', err);
      this.isInitializing = false;
      return;
    }

    this.engine.init(sampleRate, maxBlockSize || 128, this.module);
    this.port.postMessage({ type: 'ready', sampleRate, maxBlockSize: maxBlockSize || 128 });
    this.isInitializing = false;
  }

  maybeReportMetrics(frames, elapsedMs) {
    this.metrics.callbacks += 1;
    this.metrics.totalMs += elapsedMs;
    if (elapsedMs > this.metrics.peakMs) this.metrics.peakMs = elapsedMs;

    if (this.metrics.callbacks % this.metrics.reportInterval === 0) {
      this.port.postMessage({
        type: 'metrics',
        blockSize: frames,
        sampleRate,
        avgProcessMs: this.metrics.totalMs / this.metrics.callbacks,
        peakProcessMs: this.metrics.peakMs
      });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output?.[0]?.length || 0;
    if (!output || output.length === 0 || frames <= 0) {
      return true;
    }

    const start = globalThis.performance ? globalThis.performance.now() : 0;
    this.engine.process(inputs, outputs, frames);
    const end = globalThis.performance ? globalThis.performance.now() : start;
    this.maybeReportMetrics(frames, end - start);

    return true;
  }
}

registerProcessor('earth-worklet-processor', EarthWorkletProcessor);