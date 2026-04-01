#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vector>
#include <span>

#include "../Dattorro/Dattorro.hpp"
#include "../Util/Multirate.h"
#include "../Util/OctaveGenerator.h"
#include <q/fx/biquad.hpp>

namespace q = cycfi::q;
using namespace q::literals;

class EarthAudioProcessor {
public:
    EarthAudioProcessor(float sampleRate) :
        sampleRate_(sampleRate),
        reverb_(sampleRate, 16, 4.0),
        octave_(sampleRate / resample_factor),
        eq1_(-11, 140_Hz, sampleRate),
        eq2_(5, 160_Hz, sampleRate)
    {
        reverb_.setSampleRate(sampleRate);
        reverb_.setTimeScale(4.0);
        reverb_.setPreDelay(0.0);

        reverb_.setInputFilterLowCutoffPitch(10. * 0.0);
        reverb_.setInputFilterHighCutoffPitch(10. - (10. * 0.0));
        reverb_.enableInputDiffusion(true);
        reverb_.setDecay(0.877465);
        reverb_.setTankDiffusion(1.0 * 0.7);
        reverb_.setTankFilterLowCutFrequency(10. * 0.0);
        reverb_.setTankFilterHighCutFrequency(10. - (10. * 0.0));
        reverb_.setTankModSpeed(1.0);
        reverb_.setTankModDepth(0.5);
        reverb_.setTankModShape(0.5);
        reverb_.clear();

        for (int j = 0; j < 6; ++j) {
            buff_[j] = 0.0f;
            buff_out_[j] = 0.0f;
        }

        // Initialize parameters to default values
        setPreDelay(0.0f);
        setMix(0.5f);
        setDecay(0.5f);
        setModDepth(0.5f);
        setModSpeed(0.5f);
        setFilter(0.5f);
        setReverbSize(1);
        setOctaveMode(0);
        setDisableInputDiffusion(false);
    }

    void setPreDelay(float value) { predelay_ = value; updateSmoothedParams(); }
    void setMix(float value) { mix_ = value; updateSmoothedParams(); }
    void setDecay(float value) { decay_ = value; updateSmoothedParams(); }
    void setModDepth(float value) { moddepth_ = value; updateSmoothedParams(); }
    void setModSpeed(float value) { modspeed_ = value; updateSmoothedParams(); }
    void setFilter(float value) { filter_ = value; updateSmoothedParams(); }

    void setEq1Gain(float gain) {
        eq1_gain_ = gain;
        eq1_.config(eq1_gain_, 140_Hz, sampleRate_);
    }

    void setEq2Gain(float gain) {
        eq2_gain_ = gain;
        eq2_.config(eq2_gain_, 160_Hz, sampleRate_);
    }

    void setReverbSize(int size) {
        float setTimeScale;
        if (size == 0) { // Small
            setTimeScale = 1.0;
        } else if (size == 2) { // Big
            setTimeScale = 4.0;
        } else { // Medium
            setTimeScale = 2.0;
        }
        reverb_.setTimeScale(setTimeScale);
    }

    void setOctaveMode(int mode) {
        effect_mode_ = mode;
    }

    void setDisableInputDiffusion(bool disabled) {
        disable_input_diffusion_ = disabled;
    }

    void process(uintptr_t inL_ptr, uintptr_t inR_ptr, uintptr_t outL_ptr, uintptr_t outR_ptr, int size) {
        float* inL = reinterpret_cast<float*>(inL_ptr);
        float* inR = reinterpret_cast<float*>(inR_ptr);
        float* outL = reinterpret_cast<float*>(outL_ptr);
        float* outR = reinterpret_cast<float*>(outR_ptr);

        reverb_.enableInputDiffusion(!disable_input_diffusion_);

        for (int i = 0; i < size; ++i) {
            float inputL = inL[i];
            float inputR = inR[i];

            // Re-implement process logic from earth.cpp
            buff_[bin_counter_] = inputL;

            if (bin_counter_ > 4) {
                std::span<const float, resample_factor> in_chunk(&(buff_[0]), resample_factor);
                const auto sample = decimate_(in_chunk);

                float octave_mix = 0.0f;
                octave_.update(sample);

                if (effect_mode_ != 0)
                    octave_mix += octave_.up1() * 2.0f;
                if (effect_mode_ == 2) {
                    octave_mix += octave_.down1() * 2.0f;
                    octave_mix += octave_.down2() * 2.0f;
                }

                auto out_chunk = interpolate_(octave_mix);
                for (size_t j = 0; j < out_chunk.size(); ++j) {
                    float mix = eq2_(eq1_(out_chunk[j]));
                    float dryLevel = 0.5f;

                    if (effect_mode_ == 2 || octave_only_mode_ == false) {
                        mix += dryLevel * buff_[j];
                    }

                    if (effect_mode_ != 0)
                        buff_out_[j] = mix;
                    else
                        buff_out_[j] = 0.0f;
                }
            }

            bin_counter_ += 1;
            if (bin_counter_ > 5)
                bin_counter_ = 0;

            float reverb_in = inputL;
            if (effect_mode_ != 0) {
                reverb_in = buff_out_[bin_counter_];
            }

            reverb_.process(reverb_in, reverb_in);

            float effectLeftOut = reverb_.getLeftOutput();
            float effectRightOut = reverb_.getRightOutput();

            float leftOutput = inputL * dryMix_ + effectLeftOut * wetMix_ * 0.4f;
            float rightOutput = inputR * dryMix_ + effectRightOut * wetMix_ * 0.4f;

            outL[i] = leftOutput;
            outR[i] = rightOutput;
        }
    }

private:

    // Single pole filter logic from fonepole macro in earth.cpp
    // This isn't necessary for frame-based updates since we aren't smoothing continuously per sample in process() here,
    // but we can apply it right away since it sets parameters.
    // Wait, the real earth.cpp does smoothing *inside* the process loop.
    // I can just set them instantly when called for now or set up continuous smoothing.
    // Let's set them directly.

    void updateSmoothedParams() {
        // PreDelay
        reverb_.setPreDelay(predelay_ * 1000.0f * 2.0f > 700.0f ? 700.0f : predelay_ * 1000.0f * 2.0f); // approximating from earth.cpp (max ~700ms)

        // Mix
        // A cheap mostly energy constant crossfade
        float x2 = 1.0f - mix_;
        float A = mix_ * x2;
        float B = A * (1.0f + 1.4186f * A);
        float C = B + mix_;
        float D = B + x2;
        wetMix_ = C * C;
        dryMix_ = D * D;

        // Decay
        reverb_.setDecay(decay_);

        // Mod Depth
        reverb_.setTankModDepth(moddepth_ * 8.0f);

        // Mod Rate
        reverb_.setTankModSpeed(0.3f + modspeed_ * 15.0f);

        // Filter (damp)
        if (filter_ < 0.5f) {
            float reverbDampHigh = filter_ * 2.0f;
            reverb_.setInputFilterHighCutoffPitch(7.0f * reverbDampHigh + 3.0f);
            // reverb.setTankFilterHighCutFrequency(7. * reverbDampHigh + 3);
        } else {
            float reverbDampLow = (filter_ - 0.5f) * 2.0f;
            reverb_.setInputFilterLowCutoffPitch(9.0f * reverbDampLow);
            // reverb.setTankFilterLowCutFrequency(9. * reverbDampLow);
        }
    }

    float sampleRate_;
    Dattorro reverb_;
    Decimator2 decimate_;
    Interpolator interpolate_;
    OctaveGenerator octave_;
    q::highshelf eq1_;
    q::lowshelf eq2_;

    float buff_[6];
    float buff_out_[6];
    int bin_counter_ = 0;

    int effect_mode_ = 0; // 0=none, 1=up, 2=up+down
    bool disable_input_diffusion_ = false;
    bool octave_only_mode_ = false;

    float predelay_ = 0.0f;
    float mix_ = 0.5f;
    float decay_ = 0.5f;
    float moddepth_ = 0.5f;
    float modspeed_ = 0.5f;
    float filter_ = 0.5f;

    float dryMix_ = 1.0f;
    float wetMix_ = 1.0f;

    float eq1_gain_ = -11.0f;
    float eq2_gain_ = 5.0f;
};

EMSCRIPTEN_BINDINGS(earth_module) {
    emscripten::class_<EarthAudioProcessor>("EarthAudioProcessor")
        .constructor<float>()
        .function("setPreDelay", &EarthAudioProcessor::setPreDelay)
        .function("setMix", &EarthAudioProcessor::setMix)
        .function("setDecay", &EarthAudioProcessor::setDecay)
        .function("setModDepth", &EarthAudioProcessor::setModDepth)
        .function("setModSpeed", &EarthAudioProcessor::setModSpeed)
        .function("setFilter", &EarthAudioProcessor::setFilter)
        .function("setReverbSize", &EarthAudioProcessor::setReverbSize)
        .function("setOctaveMode", &EarthAudioProcessor::setOctaveMode)
        .function("setDisableInputDiffusion", &EarthAudioProcessor::setDisableInputDiffusion)
        .function("setEq1Gain", &EarthAudioProcessor::setEq1Gain)
        .function("setEq2Gain", &EarthAudioProcessor::setEq2Gain)
        .function("process", &EarthAudioProcessor::process, emscripten::allow_raw_pointers());
}
