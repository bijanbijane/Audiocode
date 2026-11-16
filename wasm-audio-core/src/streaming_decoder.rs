import std::io::Cursor;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use wasm_bindgen::prelude::*;

/// Random-access seek table entry generated incrementally during streaming decode (Section 16).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WasmSeekTableEntry {
    pub sample_offset: u64,
    pub packet_duration_samples: u32,
}

#[wasm_bindgen]
pub struct SafeStreamingDecodeSummary {
    pub sample_rate: u32,
    pub channels: u32,
    pub total_decoded_frames: u64,
    pub corrupted_packets_skipped: u32,
    seek_table: Vec<WasmSeekTableEntry>,
}

#[wasm_bindgen]
impl SafeStreamingDecodeSummary {
    pub fn seek_table_len(&self) -> usize {
        self.seek_table.len()
    }

    pub fn get_seek_entry(&self, index: usize) -> Option<WasmSeekTableEntry> {
        self.seek_table.get(index).copied()
    }

    /// Flat interleaved `[sample_offset, packet_duration_samples, ...]` array for JS transfer.
    pub fn take_seek_table_flat_u64(&self) -> Vec<u64> {
        let mut flat = Vec::with_capacity(self.seek_table.len() * 2);
        for entry in &self.seek_table {
            flat.push(entry.sample_offset);
            flat.push(entry.packet_duration_samples as u64);
        }
        flat
    }
}

/// Pure-Rust implementation so native `cargo test` runs on host targets without JsValue panics.
pub fn inspect_and_index_audio_container_native(
    container_bytes: &[u8],
    max_allowed_samples: u64,
) -> Result<SafeStreamingDecodeSummary, String> {
    let cursor = Cursor::new(container_bytes.to_vec());
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let hint = Hint::new();
    let format_opts = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let metadata_opts: MetadataOptions = Default::default();
    let decoder_opts: DecoderOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .map_err(|e| format!("DECODE_PROBE_FAILED: {}", e))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "DECODE_NO_SUPPORTED_AUDIO_TRACK".to_string())?;

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(48000);
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u32)
        .unwrap_or(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &decoder_opts)
        .map_err(|e| format!("DECODE_CODEC_INIT_FAILED: {}", e))?;

    let mut total_decoded_frames: u64 = 0;
    let mut corrupted_packets_skipped: u32 = 0;
    let mut seek_table: Vec<WasmSeekTableEntry> = Vec::with_capacity(256);
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(_)) => break, // Natural EOF
            Err(SymphoniaError::DecodeError(_)) => {
                // Section 41: Skip malformed container packets without aborting import
                corrupted_packets_skipped += 1;
                continue;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                let frames = audio_buf.frames() as u64;
                let next_total = total_decoded_frames.saturating_add(frames);

                // Section 41: Hardware-level Decompression Bomb protection
                if next_total > max_allowed_samples {
                    return Err(
                        "SECURITY_DECOMPRESSION_BOMB_ABORTED: تعداد نمونه‌ها از سقف مجاز عبور کرد."
                            .to_string(),
                    );
                }

                let needs_realloc = sample_buf
                    .as_ref()
                    .map_or(true, |b| b.capacity() < audio_buf.capacity());
                if needs_realloc {
                    let spec = *audio_buf.spec();
                    let duration = audio_buf.capacity() as u64;
                    sample_buf = Some(SampleBuffer::<f32>::new(duration, spec));
                }
                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(audio_buf);
                }

                seek_table.push(WasmSeekTableEntry {
                    sample_offset: total_decoded_frames,
                    packet_duration_samples: frames as u32,
                });
                total_decoded_frames = next_total;
            }
            Err(SymphoniaError::DecodeError(_)) => {
                // Section 41: Skip damaged audio frames and recover at the next valid packet
                corrupted_packets_skipped += 1;
                continue;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => break,
        }
    }

    Ok(SafeStreamingDecodeSummary {
        sample_rate,
        channels,
        total_decoded_frames,
        corrupted_packets_skipped,
        seek_table,
    })
}

/// Fault-tolerant streaming container decoder & seek-table builder (Sections 16, 41 & 58).
#[wasm_bindgen]
pub fn inspect_and_index_audio_container(
    container_bytes: &[u8],
    max_allowed_samples: u64,
) -> Result<SafeStreamingDecodeSummary, JsValue> {
    inspect_and_index_audio_container_native(container_bytes, max_allowed_samples)
        .map_err(|err| JsValue::from_str(&err))
}
