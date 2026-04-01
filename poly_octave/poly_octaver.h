#pragma once

#include <cstddef>
#include <memory>

namespace poly_octave {

enum class Mode {
    Off = 0,
    Up = 1,
    UpDown = 2,
};

class PolyOctaver {
public:
    PolyOctaver();
    ~PolyOctaver();

    void Init(float sample_rate);
    void SetMode(Mode mode);
    void SetDryBlend(float dry_blend);
    void SetUpGain(float up_gain);
    void SetDown1Gain(float down1_gain);
    void SetDown2Gain(float down2_gain);
    void SetInternalDryEnabled(bool enabled);

    float ProcessMono(float in_sample);
    void ProcessBlockMono(const float* input, float* output, std::size_t frames);

    void Reset();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    bool initialized_ = false;
    float sample_rate_ = 48000.0f;

    Mode mode_ = Mode::Off;
    float dry_blend_ = 0.5f;
    float up_gain_ = 1.0f;
    float down1_gain_ = 1.0f;
    float down2_gain_ = 1.0f;
    bool internal_dry_enabled_ = true;

    float input_ring_[6] = {};
    float output_ring_[6] = {};
    int ring_index_ = 0;
};

} // namespace poly_octave
