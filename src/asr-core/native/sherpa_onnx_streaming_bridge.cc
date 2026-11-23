/**
 * AVAPARDAZ — PHASE 1C-B NATIVE SHERPA-ONNX PERSISTENT STREAMING BRIDGE
 *
 * Keeps the verified local Sherpa-ONNX OfflineRecognizer (e.g. Reza2kn/Shenava-Rizeh INT8)
 * resident in native C++ memory across streaming utterance windows and partial decodes.
 *
 * Binary Stdin Protocol (Little-Endian):
 *   Each request frame:
 *     - magic:      uint32 (0x41565053 = "AVPS")
 *     - requestId:  uint32
 *     - flags:      uint32 (bit 0: isFinal, bit 1: shutdown)
 *     - numSamples: uint32 (number of float32 samples @ 16000 Hz)
 *     - samples:    float32[numSamples]
 *
 * Stdout Protocol (Newline-delimited JSON):
 *   On startup:
 *     {"type":"READY","pid":1234,"loadTimeMs":123.4}
 *   On each decoded frame:
 *     {"type":"RESULT","requestId":1,"isFinal":false,"decodeTimeMs":42.1,"result":{...sherpa json...}}
 */

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>
#include <unistd.h>

#include "sherpa-onnx/c-api/c-api.h"

static bool read_exact(int fd, void *buf, size_t count) {
  uint8_t *ptr = static_cast<uint8_t *>(buf);
  size_t remaining = count;
  while (remaining > 0) {
    ssize_t n = ::read(fd, ptr, remaining);
    if (n <= 0) {
      return false;
    }
    ptr += n;
    remaining -= static_cast<size_t>(n);
  }
  return true;
}

int main(int argc, char *argv[]) {
  std::string model_path;
  std::string tokens_path;
  std::string arch = "nemo-ctc";
  std::string whisper_encoder;
  std::string whisper_decoder;
  std::string language = "";
  int32_t num_threads = 2;

  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg.rfind("--nemo-ctc-model=", 0) == 0) {
      model_path = arg.substr(std::strlen("--nemo-ctc-model="));
      arch = "nemo-ctc";
    } else if (arg.rfind("--tokens=", 0) == 0) {
      tokens_path = arg.substr(std::strlen("--tokens="));
    } else if (arg.rfind("--num-threads=", 0) == 0) {
      num_threads = std::max(1, std::atoi(arg.substr(std::strlen("--num-threads=")).c_str()));
    } else if (arg.rfind("--whisper-encoder=", 0) == 0) {
      whisper_encoder = arg.substr(std::strlen("--whisper-encoder="));
      arch = "whisper";
    } else if (arg.rfind("--whisper-decoder=", 0) == 0) {
      whisper_decoder = arg.substr(std::strlen("--whisper-decoder="));
      arch = "whisper";
    } else if (arg.rfind("--whisper-language=", 0) == 0) {
      language = arg.substr(std::strlen("--whisper-language="));
    }
  }

  if (tokens_path.empty() || (arch == "nemo-ctc" && model_path.empty())) {
    std::fprintf(stderr, "ERROR: Missing --tokens or --nemo-ctc-model arguments.\n");
    return 2;
  }

  auto t0 = std::chrono::steady_clock::now();

  SherpaOnnxOfflineRecognizerConfig config;
  std::memset(&config, 0, sizeof(config));
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;

  if (arch == "whisper") {
    config.model_config.whisper.encoder = whisper_encoder.c_str();
    config.model_config.whisper.decoder = whisper_decoder.c_str();
    config.model_config.whisper.language = language.c_str();
    config.model_config.whisper.task = "transcribe";
    config.model_config.whisper.tail_paddings = -1;
  } else {
    config.model_config.nemo_ctc.model = model_path.c_str();
  }

  config.model_config.tokens = tokens_path.c_str();
  config.model_config.num_threads = num_threads;
  config.model_config.debug = 0;
  config.model_config.provider = "cpu";
  config.decoding_method = "greedy_search";
  config.max_active_paths = 4;

  const SherpaOnnxOfflineRecognizer *recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
  if (!recognizer) {
    std::fprintf(stderr, "ERROR: SherpaOnnxCreateOfflineRecognizer returned NULL.\n");
    return 3;
  }

  auto t1 = std::chrono::steady_clock::now();
  double load_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

  std::printf("{\"type\":\"READY\",\"pid\":%d,\"loadTimeMs\":%.2f}\n", static_cast<int>(::getpid()), load_ms);
  std::fflush(stdout);

  const uint32_t EXPECTED_MAGIC = 0x41565053U; // "AVPS"
  const uint32_t MAX_WINDOW_SAMPLES = 16000U * 60U; // Max 60s window safety cap
  std::vector<float> sample_buf;

  while (true) {
    uint32_t header[4];
    if (!read_exact(STDIN_FILENO, header, sizeof(header))) {
      break;
    }
    uint32_t magic = header[0];
    uint32_t request_id = header[1];
    uint32_t flags = header[2];
    uint32_t num_samples = header[3];

    if (magic != EXPECTED_MAGIC) {
      std::fprintf(stderr, "ERROR: Invalid frame magic 0x%08x\n", magic);
      break;
    }

    if ((flags & 2U) != 0U) {
      // Explicit shutdown flag
      break;
    }

    if (num_samples > MAX_WINDOW_SAMPLES) {
      std::fprintf(stderr, "ERROR: Window sample count %u exceeds safety cap %u\n", num_samples, MAX_WINDOW_SAMPLES);
      break;
    }

    sample_buf.resize(num_samples);
    if (num_samples > 0) {
      if (!read_exact(STDIN_FILENO, sample_buf.data(), static_cast<size_t>(num_samples) * sizeof(float))) {
        break;
      }
    }

    auto dec_start = std::chrono::steady_clock::now();
    const SherpaOnnxOfflineStream *stream = SherpaOnnxCreateOfflineStream(recognizer);
    if (!stream) {
      std::printf("{\"type\":\"ERROR\",\"requestId\":%u,\"message\":\"CreateOfflineStream failed\"}\n", request_id);
      std::fflush(stdout);
      continue;
    }

    if (num_samples > 0) {
      SherpaOnnxAcceptWaveformOffline(stream, 16000, sample_buf.data(), static_cast<int32_t>(num_samples));
      SherpaOnnxDecodeOfflineStream(recognizer, stream);
    }

    const char *json_str = SherpaOnnxGetOfflineStreamResultAsJson(stream);
    auto dec_end = std::chrono::steady_clock::now();
    double dec_ms = std::chrono::duration<double, std::milli>(dec_end - dec_start).count();

    bool is_final = (flags & 1U) != 0U;
    std::printf(
      "{\"type\":\"RESULT\",\"requestId\":%u,\"isFinal\":%s,\"decodeTimeMs\":%.2f,\"result\":%s}\n",
      request_id,
      is_final ? "true" : "false",
      dec_ms,
      json_str ? json_str : "{\"text\":\"\",\"timestamps\":[],\"tokens\":[]}"
    );
    std::fflush(stdout);

    if (json_str) {
      SherpaOnnxDestroyOfflineStreamResultJson(json_str);
    }
    SherpaOnnxDestroyOfflineStream(stream);

    // Release excess vector capacity if a large window was decoded
    if (sample_buf.capacity() > 16000U * 35U) {
      std::vector<float>().swap(sample_buf);
    }
  }

  SherpaOnnxDestroyOfflineRecognizer(recognizer);
  return 0;
}
