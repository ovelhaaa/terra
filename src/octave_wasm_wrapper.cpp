#include <emscripten/bind.h>

#include "../poly_octave/poly_octaver.h"

class OctaveAudioProcessor {
public:
    explicit OctaveAudioProcessor(float sampleRate) {
        octaver_.Init(sampleRate);
    }

    void setMode(int mode) {
        if (mode <= 0) {
            octaver_.SetMode(poly_octave::Mode::Off);
        } else if (mode == 1) {
            octaver_.SetMode(poly_octave::Mode::Up);
        } else {
            octaver_.SetMode(poly_octave::Mode::UpDown);
        }
    }

    void setDryBlend(float dryBlend) { octaver_.SetDryBlend(dryBlend); }
    void setUpGain(float gain) { octaver_.SetUpGain(gain); }
    void setDown1Gain(float gain) { octaver_.SetDown1Gain(gain); }
    void setDown2Gain(float gain) { octaver_.SetDown2Gain(gain); }
    void setInternalDryEnabled(bool enabled) { octaver_.SetInternalDryEnabled(enabled); }
    void reset() { octaver_.Reset(); }

    void process(uintptr_t inPtr, uintptr_t outPtr, int size) {
        if (size <= 0) {
            return;
        }

        const float* input = reinterpret_cast<float*>(inPtr);
        float* output = reinterpret_cast<float*>(outPtr);
        octaver_.ProcessBlockMono(input, output, static_cast<std::size_t>(size));
    }

private:
    poly_octave::PolyOctaver octaver_;
};

EMSCRIPTEN_BINDINGS(octave_module) {
    emscripten::class_<OctaveAudioProcessor>("OctaveAudioProcessor")
        .constructor<float>()
        .function("setMode", &OctaveAudioProcessor::setMode)
        .function("setDryBlend", &OctaveAudioProcessor::setDryBlend)
        .function("setUpGain", &OctaveAudioProcessor::setUpGain)
        .function("setDown1Gain", &OctaveAudioProcessor::setDown1Gain)
        .function("setDown2Gain", &OctaveAudioProcessor::setDown2Gain)
        .function("setInternalDryEnabled", &OctaveAudioProcessor::setInternalDryEnabled)
        .function("reset", &OctaveAudioProcessor::reset)
        .function("process", &OctaveAudioProcessor::process, emscripten::allow_raw_pointers());
}
