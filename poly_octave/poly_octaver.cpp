#include "poly_octaver.h"

#include "../Util/Multirate.h"
#include "../Util/OctaveGenerator.h"

#include <algorithm>
#include <array>
#include <span>

namespace poly_octave {

struct PolyOctaver::Impl {
    explicit Impl(float sample_rate)
    : octave(sample_rate / static_cast<float>(resample_factor)) {}

    Decimator2 decimator;
    Interpolator interpolator;
    OctaveGenerator octave;
};

namespace {
float clamp01(float value) {
    return std::clamp(value, 0.0f, 1.0f);
}
} // namespace

PolyOctaver::PolyOctaver() = default;
PolyOctaver::~PolyOctaver() = default;

void PolyOctaver::Init(float sample_rate) {
    sample_rate_ = sample_rate;
    impl_ = std::make_unique<Impl>(sample_rate_);
    initialized_ = true;
    Reset();
}

void PolyOctaver::SetMode(Mode mode) { mode_ = mode; }
void PolyOctaver::SetDryBlend(float dry_blend) { dry_blend_ = clamp01(dry_blend); }
void PolyOctaver::SetUpGain(float up_gain) { up_gain_ = up_gain; }
void PolyOctaver::SetDown1Gain(float down1_gain) { down1_gain_ = down1_gain; }
void PolyOctaver::SetDown2Gain(float down2_gain) { down2_gain_ = down2_gain; }
void PolyOctaver::SetInternalDryEnabled(bool enabled) { internal_dry_enabled_ = enabled; }

float PolyOctaver::ProcessMono(float in_sample) {
    if (!initialized_ || !impl_) {
        return in_sample;
    }

    const float out_sample = output_ring_[ring_index_];
    input_ring_[ring_index_] = in_sample;

    if (ring_index_ == static_cast<int>(resample_factor) - 1) {
        std::span<const float, resample_factor> in_chunk(&(input_ring_[0]), resample_factor);
        const float decimated = impl_->decimator(in_chunk);

        impl_->octave.update(decimated);

        float octave_mix = 0.0f;
        if (mode_ != Mode::Off) {
            octave_mix += impl_->octave.up1() * up_gain_;
            if (mode_ == Mode::UpDown) {
                octave_mix += impl_->octave.down1() * down1_gain_;
                octave_mix += impl_->octave.down2() * down2_gain_;
            }
        }

        const std::array<float, resample_factor> upsampled = impl_->interpolator(octave_mix);
        for (std::size_t i = 0; i < upsampled.size(); ++i) {
            const float dry = internal_dry_enabled_ ? input_ring_[i] * dry_blend_ : 0.0f;
            output_ring_[i] = dry + upsampled[i];
        }
    }

    ring_index_ += 1;
    if (ring_index_ >= static_cast<int>(resample_factor)) {
        ring_index_ = 0;
    }

    return out_sample;
}

void PolyOctaver::ProcessBlockMono(const float* input, float* output, std::size_t frames) {
    if (!input || !output) {
        return;
    }

    for (std::size_t i = 0; i < frames; ++i) {
        output[i] = ProcessMono(input[i]);
    }
}

void PolyOctaver::Reset() {
    std::fill(std::begin(input_ring_), std::end(input_ring_), 0.0f);
    std::fill(std::begin(output_ring_), std::end(output_ring_), 0.0f);
    ring_index_ = 0;

    if (sample_rate_ > 0.0f) {
        impl_ = std::make_unique<Impl>(sample_rate_);
        initialized_ = true;
    }
}

} // namespace poly_octave
