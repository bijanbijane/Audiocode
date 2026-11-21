# AVP-P0-008 — Audio DSP Integrity, Sample-Accurate Timeline & Deterministic Rendering

**Status:** `VERIFIED`  
**Primary Module:** `src/audio-renderer/CanonicalAudioDspEngine.ts`  
**Test Suite:** `src/workflow/CanonicalProjectWorkflowAndDsp.test.ts`

---

## 1. DSP Engineering Guarantees

1. **Canonical Audio Descriptor & Buffer Integrity:** Enforces planar Float32 internal representation, explicit channel layouts (`mono`, `stereo`, `quad`, `5.1`), integer `frameCount`, and strict rejection of `NaN`/`Infinity` samples (`NON_FINITE_AUDIO_SAMPLES`) inside `createCanonicalAudioBuffer`.
2. **Integer-Sample Timebase:** `secondsToSampleIndex`, `millisecondsToSampleIndex`, and `sampleIndexToSeconds` eliminate floating-point drift across timeline edits.
3. **Anti-Aliased Kaiser-Windowed Sinc Resampling (`resamplePlanarAudio`):** Supports both downsampling (48 kHz → 16 kHz) via bounded streaming chunks and upsampling (16 kHz → 48 kHz) via anti-imaged Kaiser sinc interpolation; verified >40 dB steady-state stopband attenuation of 14 kHz above 8 kHz Nyquist and exact pitch preservation of 1 kHz tones.
4. **Explicit Channel Conversion (`convertChannelLayout`):** Implements explicit equal-amplitude/equal-power stereo→mono, ITU-R BS.775-3 normalized 5.1→stereo, quad→stereo, and multichannel→mono policies without clipping.
5. **Smooth Edge Fades & Non-Destructive Silence Classification:** `applyFadeInOut` eliminates abrupt step discontinuities; `classifySilenceWindow` distinguishes `DIGITAL_SILENCE`, `LOW_LEVEL_AMBIENT`, and `ACTIVE_SIGNAL`.
6. **Sample-Accurate Timeline Execution & Independent Decode-Back WAV Verification:** `executeSampleAccurateTimeline` and `renderAndVerifyDeterministicWav` produce bit-identical deterministic WAV files across `pcm16`, `pcm24`, and `float32` encodings, verified by decoding each output back with `decodeWaveArtifactToPlanarFloat32` to confirm exact sample rate, channel count, and frame count.

## 2. Verified Automated Evidence

- `src/workflow/CanonicalProjectWorkflowAndDsp.test.ts`: **PASS** (all DSP fixtures, Kaiser sinc up/down resampling, stopband aliasing check, multichannel downmix, fades, silence classification, NaN/Inf rejection, and bit-identical PCM16/PCM24/Float32 WAV decode-back verification).
