import Module from './octave-module.js';

class OctaveWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.module = null;
    this.processor = null;
    this.inPtr = 0;
    this.outPtr = 0;
    this.bufferSize = 0;
    this.initializing = false;

    this.port.onmessage = (event) => {
      if (event.data.type === 'init') {
        this.init(event.data.wasmBytes).catch((err) => {
          this.port.postMessage({ type: 'error', stage: 'init', message: err.message || String(err) });
        });
      } else if (event.data.type === 'reset') {
        this.processor?.reset();
      }
    };
  }

  static get parameterDescriptors() {
    return [
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 2 },
      { name: 'dryBlend', defaultValue: 0.5, minValue: 0, maxValue: 1 },
      { name: 'upGain', defaultValue: 1, minValue: 0, maxValue: 2 },
      { name: 'down1Gain', defaultValue: 1, minValue: 0, maxValue: 2 },
      { name: 'down2Gain', defaultValue: 1, minValue: 0, maxValue: 2 },
      { name: 'internalDryEnabled', defaultValue: 1, minValue: 0, maxValue: 1 },
    ];
  }

  async init(wasmBytes) {
    if (this.processor || this.initializing) return;
    this.initializing = true;
    this.module = await Module({ wasmBinary: wasmBytes });
    this.processor = new this.module.OctaveAudioProcessor(sampleRate);
    this.port.postMessage({ type: 'ready' });
    this.initializing = false;
  }

  alloc(size) {
    if (!this.module) return false;
    if (this.bufferSize === size && this.inPtr && this.outPtr) return true;
    if (this.inPtr) this.module._free(this.inPtr);
    if (this.outPtr) this.module._free(this.outPtr);
    const bytes = size * Float32Array.BYTES_PER_ELEMENT;
    this.inPtr = this.module._malloc(bytes);
    this.outPtr = this.module._malloc(bytes);
    this.bufferSize = size;
    return Boolean(this.inPtr && this.outPtr);
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length < 1) return true;
    const outL = output[0];
    const outR = output[1] || output[0];
    outL.fill(0); outR.fill(0);
    if (!this.processor || !this.module) return true;

    const input = inputs[0];
    const inL = input?.[0];
    if (!inL) return true;
    const size = inL.length;
    if (!this.alloc(size)) return true;

    const gp = (name) => (parameters[name]?.length ? parameters[name][0] : 0);
    this.processor.setMode(Math.round(gp('mode')));
    this.processor.setDryBlend(gp('dryBlend'));
    this.processor.setUpGain(gp('upGain'));
    this.processor.setDown1Gain(gp('down1Gain'));
    this.processor.setDown2Gain(gp('down2Gain'));
    this.processor.setInternalDryEnabled(gp('internalDryEnabled') > 0.5);

    const mem = new Float32Array(this.module.HEAPF32.buffer);
    mem.set(inL, this.inPtr >> 2);
    this.processor.process(this.inPtr, this.outPtr, size);
    const out = mem.subarray(this.outPtr >> 2, (this.outPtr >> 2) + size);
    outL.set(out);
    if (outR !== outL) outR.set(out);
    return true;
  }
}

registerProcessor('octave-worklet-processor', OctaveWorkletProcessor);
