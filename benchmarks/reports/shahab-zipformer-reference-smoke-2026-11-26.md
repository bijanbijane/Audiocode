# Shahab Zipformer — Reference Runtime Qualification

- Date: 2026-11-26
- Model: `persian-zipformer-transducer` (INT8)
- Reference runtime: `sherpa-onnx` Python 2.0.3 on macOS arm64
- Decode mode: `modified_beam_search`, `max_active_paths=4`, 4 CPU threads
- Audio: the model package's `sample.wav`

## Result

The official Sherpa-ONNX reference runtime loaded the model and returned a non-empty Persian transcript:

> شکلات داغ در حد ساندارهای بلژیکی از آبی بالا گران قیمت ولی آنیمون باشند

The package's Persian post-processor returned:

> شکلات داغ در حد سانداره‌ای بلژیکی از آبی بالا گران قیمت ولی آنیمون باشند

This is a single-file smoke test, not a corpus accuracy score.

## Custom WASM decoder parity

The experimental `ShahabZipformerAsrRuntime` custom ONNX/WASM decoder was run against the same audio. It did not achieve parity:

- `SPEED`: empty transcript
- `BALANCED`: `گ`
- `PRECISION`: repeated `ه`
- `VOCABULARY`: repeated `گو`
- `VERBATIM`: `گ`

Therefore the custom WASM Zipformer route remains gated behind `SHAHAB_ENABLE_EXPERIMENTAL_ZIPFORMER=1` and is not the production ASR path. `SmartAudioEditHttpRouter` only enables it through an explicit experimental option. The validated production baseline remains the Sherpa CTC model measured separately on the full 871-utterance FLEURS Persian test split.

## Required engineering follow-up

Port the official Sherpa-ONNX transducer decode path into the native local runtime (or replace the custom WASM decoder with the official Sherpa runtime), then require exact non-empty transcript and regression-corpus parity before enabling the experimental flag.
