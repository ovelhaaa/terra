import Module from './earth-module.js';

function ensureURLConstructor() {
  if (typeof globalThis.URL === 'function') {
    return;
  }

  const hasAbsoluteScheme = (value) => /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);

  const normalizePath = (path) => {
    const segments = [];
    path.split('/').forEach((segment) => {
      if (!segment || segment === '.') {
        return;
      }
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
  process(channelData, frames) {
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

class SerialAudioEngine {
  constructor() {
    this.sampleRate = 0;
    this.maxBlockSize = 128;
    this.channelCount = 2;
    this.tempChannels = [];
    this.currentChannels = [];
    this.modules = [];
    this.moduleStates = [];
  }

  init(sampleRateValue, maxBlockSize) {
    this.sampleRate = sampleRateValue;
    this.maxBlockSize = Math.max(1, Math.floor(maxBlockSize || 128));

    this.tempChannels = new Array(this.channelCount);
    this.currentChannels = new Array(this.channelCount);

    for (let ch = 0; ch < this.channelCount; ch += 1) {
      this.tempChannels[ch] = new Float32Array(this.maxBlockSize);
      this.currentChannels[ch] = this.tempChannels[ch];
    }
  }

  createModule(type) {
    if (type === 'passthrough') return new PassThroughModule();
    if (type === 'gain') return new GainModule();
    return null;
  }

  setPatch(patch) {
    const chain = Array.isArray(patch?.chain) ? patch.chain : [];
    this.modules = [];
    this.moduleStates = [];

    for (let i = 0; i < chain.length; i += 1) {
      const moduleConfig = chain[i];
      const module = this.createModule(moduleConfig?.type);
      if (!module) {
        continue;
      }

      const state = {
        id: String(moduleConfig.id || `${moduleConfig.type}_${i}`),
        enabled: moduleConfig.enabled !== false,
        bypass: moduleConfig.bypass === true,
        module
      };

      const params = moduleConfig.params || {};
      Object.keys(params).forEach((paramId) => {
        if (typeof module.setParam === 'function') {
          module.setParam(paramId, Number(params[paramId]));
        }
      });

      this.modules.push(module);
      this.moduleStates.push(state);
    }
  }

  setParam(moduleId, paramId, value) {
    for (let i = 0; i < this.moduleStates.length; i += 1) {
      const state = this.moduleStates[i];
      if (state.id === moduleId && typeof state.module.setParam === 'function') {
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
    for (let ch = 0; ch < this.channelCount; ch += 1) {
      this.tempChannels[ch].fill(0);
    }
  }

  process(inputs, outputs, frames) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    if (output.length === 0 || frames <= 0) {
      return;
    }

    for (let ch = 0; ch < this.channelCount; ch += 1) {
      const inChannel = input[ch] || input[0];
      const outChannel = output[ch] || output[0];
      if (!outChannel) {
        continue;
      }

      if (inChannel) {
        outChannel.set(inChannel.subarray(0, frames));
      } else {
        outChannel.fill(0, 0, frames);
      }

      this.currentChannels[ch] = outChannel;
    }

    for (let i = 0; i < this.moduleStates.length; i += 1) {
      const state = this.moduleStates[i];
      if (!state.enabled || state.bypass) {
        continue;
      }

      state.module.process(this.currentChannels, frames);
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
        this.init(msg.wasmBytes, msg.maxBlockSize).catch((err) => {
          this.reportError('init', err);
        });
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
    const message = err?.message || String(err);
    const stack = err?.stack || null;
    this.port.postMessage({
      type: 'error',
      stage,
      message,
      stack
    });
  }

  async init(wasmBytes, maxBlockSize) {
    if (this.isInitializing) {
      return;
    }

    this.isInitializing = true;

    if (wasmBytes && wasmBytes.byteLength > 0) {
      try {
        ensureURLConstructor();
        this.module = await Module({ wasmBinary: wasmBytes });
      } catch (err) {
        this.reportError('module-init', err);
      }
    }

    this.engine.init(sampleRate, maxBlockSize || 128);
    this.port.postMessage({ type: 'ready', sampleRate, maxBlockSize: maxBlockSize || 128 });
    this.isInitializing = false;
  }

  maybeReportMetrics(frames, elapsedMs) {
    this.metrics.callbacks += 1;
    this.metrics.totalMs += elapsedMs;
    this.metrics.peakMs = Math.max(this.metrics.peakMs, elapsedMs);

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
    if (!output || output.length === 0) {
      return true;
    }

    const frames = output[0]?.length || 0;
    if (frames <= 0) {
      return true;
    }

    const startMs = globalThis.performance ? globalThis.performance.now() : 0;
    this.engine.process(inputs, outputs, frames);
    const endMs = globalThis.performance ? globalThis.performance.now() : startMs;

    this.maybeReportMetrics(frames, endMs - startMs);

    return true;
  }
}

registerProcessor('earth-worklet-processor', EarthWorkletProcessor);
