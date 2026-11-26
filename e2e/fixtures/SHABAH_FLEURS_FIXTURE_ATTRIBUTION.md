# SHAHAB Persian ASR smoke-test audio attribution

The file `shahab-fleurs-fa-ir-test.wav` is a mono 16 kHz PCM16 conversion of one publicly released Persian test utterance from **Google FLEURS**, configuration `fa_ir`, split `test`.

- Dataset: https://huggingface.co/datasets/google/fleurs
- Dataset licence: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Source split: `fa_ir/test`
- Source audio file: `2429365418083437624.wav`
- Reference transcript (official normalized transcript): `کشتی گیران همکار نیز به لونا ادای احترام کردند`
- Transformation: decoded/re-encoded to mono 16 kHz signed PCM16 WAV for the Sherpa-ONNX local inference smoke test; no transcript text is embedded in the audio.
- Purpose: deterministic integration smoke test only; not a representative benchmark and not a training sample.

Attribution: Google, FLEURS (Few-shot Learning Evaluation of Universal Representations of Speech), fa_ir test split, CC BY 4.0.
