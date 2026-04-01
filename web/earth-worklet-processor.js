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

class EarthWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.module = null;
    this.processor = null;
    this.isInitializing = false;

    this.inLPtr = null;
    this.inRPtr = null;
    this.outLPtr = null;
    this.outRPtr = null;
    this.bufferSize = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === 'init') {
        this.initModule(event.data.wasmBytes).catch((err) => {
          this.reportError('init', err);
        });
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

  async initModule(wasmBytes) {
    if (this.processor || this.isInitializing) {
      return;
    }

    this.isInitializing = true;

    if (!wasmBytes || wasmBytes.byteLength === 0) {
      this.isInitializing = false;
      throw new Error('Missing or empty wasm bytes received in worklet init.');
    }

    let module;
    try {
      ensureURLConstructor();
      module = await Module({
        wasmBinary: wasmBytes
      });
    } catch (err) {
      this.reportError('module-init', err);
      this.isInitializing = false;
      return;
    }

    this.module = module;

    try {
      this.processor = new module.EarthAudioProcessor(sampleRate);
    } catch (err) {
      this.reportError('processor-construct', err);
      this.isInitializing = false;
      return;
    }

    this.port.postMessage({ type: 'ready' });
    this.isInitializing = false;
  }

  static get parameterDescriptors() {
    return [
      { name: 'preDelay', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0 },
      { name: 'mix', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0 },
      { name: 'decay', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0 },
      { name: 'modDepth', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0 },
      { name: 'modSpeed', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0 },
      { name: 'filter', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0 },
      { name: 'eq1Gain', defaultValue: -11.0, minValue: -24.0, maxValue: 24.0 },
      { name: 'eq2Gain', defaultValue: 5.0, minValue: -24.0, maxValue: 24.0 },
      { name: 'reverbSize', defaultValue: 1, minValue: 0, maxValue: 2 },
      { name: 'octaveMode', defaultValue: 0, minValue: 0, maxValue: 2 },
      { name: 'disableInputDiffusion', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  freeBuffers() {
    if (!this.module) return;

    [this.inLPtr, this.inRPtr, this.outLPtr, this.outRPtr].forEach((ptr) => {
      if (ptr) {
        this.module._free(ptr);
      }
    });

    this.inLPtr = null;
    this.inRPtr = null;
    this.outLPtr = null;
    this.outRPtr = null;
    this.bufferSize = 0;
  }

  allocateBuffers(size) {
    if (!this.module || size <= 0) {
      return false;
    }

    if (this.bufferSize === size && this.inLPtr && this.inRPtr && this.outLPtr && this.outRPtr) {
      return true;
    }

    this.freeBuffers();

    const bytes = size * Float32Array.BYTES_PER_ELEMENT;
    this.inLPtr = this.module._malloc(bytes);
    this.inRPtr = this.module._malloc(bytes);
    this.outLPtr = this.module._malloc(bytes);
    this.outRPtr = this.module._malloc(bytes);

    if (!this.inLPtr || !this.inRPtr || !this.outLPtr || !this.outRPtr) {
      this.reportError('buffer-alloc', new Error(`WASM buffer allocation failed for size=${size}`));
      this.freeBuffers();
      return false;
    }

    this.bufferSize = size;
    return true;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    outL.fill(0);
    if (outR !== outL) {
      outR.fill(0);
    }

    if (!this.processor || !this.module) {
      return true;
    }

    const input = inputs[0] || [];
    const inL = input[0] || outL;
    const inR = input.length > 1 ? input[1] : inL;

    if (!inL || !inR) {
      return true;
    }

    const size = inL.length;
    if (!this.allocateBuffers(size)) {
      return true;
    }

    const getParam = (name) => {
      const param = parameters[name];
      if (!param || param.length === 0) {
        return 0;
      }
      return param[0];
    };

    this.processor.setPreDelay(getParam('preDelay'));
    this.processor.setMix(getParam('mix'));
    this.processor.setDecay(getParam('decay'));
    this.processor.setModDepth(getParam('modDepth'));
    this.processor.setModSpeed(getParam('modSpeed'));
    this.processor.setFilter(getParam('filter'));
    this.processor.setEq1Gain(getParam('eq1Gain'));
    this.processor.setEq2Gain(getParam('eq2Gain'));
    this.processor.setReverbSize(Math.round(getParam('reverbSize')));
    this.processor.setOctaveMode(Math.round(getParam('octaveMode')));
    this.processor.setDisableInputDiffusion(getParam('disableInputDiffusion') > 0.5);

    const memView = new Float32Array(this.module.HEAPF32.buffer);

    memView.set(inL, this.inLPtr >> 2);
    memView.set(inR, this.inRPtr >> 2);

    this.processor.process(this.inLPtr, this.inRPtr, this.outLPtr, this.outRPtr, size);

    const outLArray = memView.subarray(this.outLPtr >> 2, (this.outLPtr >> 2) + size);
    const outRArray = memView.subarray(this.outRPtr >> 2, (this.outRPtr >> 2) + size);

    outL.set(outLArray);
    if (output.length > 1) {
      output[1].set(outRArray);
    }

    return true;
  }
}

registerProcessor('earth-worklet-processor', EarthWorkletProcessor);
