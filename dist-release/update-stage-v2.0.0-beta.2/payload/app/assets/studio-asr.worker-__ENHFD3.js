// src/ai-engine/OnnxPersianAsrAndVadAdapter.ts
/**
* 80-Channel Log-Mel Spectrogram Extractor & ONNX ASR/VAD Adapter (Sections 13, 35 & 40)
* Converts 16 kHz Mono PCM into normalized [numFrames x 80] Log-Mel feature tensors
* matching Whisper & Persian FastConformer specifications, and implements AsrModelRunnerAdapter.
*/
var OnnxPersianAsrAndVadAdapter = class {
	constructor(modelId = "persian-fastconformer-int8", modelVersion = "1.2.0", inferenceRunner) {
		this.sampleRate = 16e3;
		this.nFft = 512;
		this.winLength = 400;
		this.hopLength = 160;
		this.nMels = 80;
		this.modelId = modelId;
		this.modelVersion = modelVersion;
		this.inferenceRunner = inferenceRunner;
		this.hannWindow = this.buildPeriodicHannWindow(this.winLength);
		this.melFilterbank = this.build80BandMelFilterbank(this.sampleRate, this.nFft, this.nMels, 0, 8e3);
	}
	/** True strictly when a real ONNX inference runner is bound to this adapter. */
	isReady() {
		return typeof this.inferenceRunner === "function";
	}
	/** True strictly when a real decoder/inference runner is configured. */
	hasDecoderConfiguration() {
		return typeof this.inferenceRunner === "function";
	}
	/**
	* Lightweight speech-band energy + Zero-Crossing Rate VAD over 30ms frames @ 16kHz.
	*/
	async detectVoiceActivity(pcm16kMono) {
		const frameSize = 480;
		let totalFrames = 0;
		let activeSpeechFrames = 0;
		for (let start = 0; start + frameSize <= pcm16kMono.length; start += frameSize) {
			totalFrames++;
			let sumSq = 0;
			let zcr = 0;
			let prevSample = 0;
			for (let i = start; i < start + frameSize; i++) {
				const raw = pcm16kMono[i];
				const s = Number.isFinite(raw) ? raw : 0;
				sumSq += s * s;
				if (i > start && (prevSample >= 0 && s < 0 || prevSample < 0 && s >= 0)) zcr++;
				prevSample = s;
			}
			const rmsDb = 10 * Math.log10(sumSq / frameSize + 1e-12);
			const zcrRatio = zcr / frameSize;
			if (rmsDb > -44 && zcrRatio > .015 && zcrRatio < .45) activeSpeechFrames++;
		}
		const speechRatio = totalFrames > 0 ? activeSpeechFrames / totalFrames : 0;
		return {
			hasSpeech: speechRatio >= .03,
			speechRatio: Number(speechRatio.toFixed(3))
		};
	}
	/**
	* Computes normalized 80-Channel Log-Mel Spectrogram [numFrames * 80] matching Whisper/Conformer input.
	*/
	computeLogMelSpectrogram(pcm16kMono) {
		if (pcm16kMono.length < this.winLength) return {
			melTensor: /* @__PURE__ */ new Float32Array(0),
			numFrames: 0,
			nMels: this.nMels
		};
		const numFrames = 1 + Math.floor((pcm16kMono.length - this.winLength) / this.hopLength);
		const melTensor = new Float32Array(numFrames * this.nMels);
		const nFreqBins = (this.nFft >> 1) + 1;
		const real = new Float32Array(this.nFft);
		const imag = new Float32Array(this.nFft);
		const powerSpectrum = new Float32Array(nFreqBins);
		let globalMaxLogMel = -Infinity;
		for (let f = 0; f < numFrames; f++) {
			const start = f * this.hopLength;
			real.fill(0);
			imag.fill(0);
			for (let i = 0; i < this.winLength; i++) {
				const raw = pcm16kMono[start + i];
				real[i] = (Number.isFinite(raw) ? raw : 0) * this.hannWindow[i];
			}
			this.radix2FftInPlace(real, imag);
			for (let k = 0; k < nFreqBins; k++) {
				const p = real[k] * real[k] + imag[k] * imag[k];
				powerSpectrum[k] = Number.isFinite(p) ? p : 0;
			}
			const frameOffset = f * this.nMels;
			for (let m = 0; m < this.nMels; m++) {
				const filterWeights = this.melFilterbank[m];
				let melEnergy = 0;
				for (let k = 0; k < nFreqBins; k++) melEnergy += powerSpectrum[k] * filterWeights[k];
				const logMel = Math.log10(Number.isFinite(melEnergy) && melEnergy > 1e-10 ? melEnergy : 1e-10);
				melTensor[frameOffset + m] = logMel;
				if (logMel > globalMaxLogMel) globalMaxLogMel = logMel;
			}
		}
		if (!Number.isFinite(globalMaxLogMel)) globalMaxLogMel = -10;
		const floorClip = globalMaxLogMel - 8;
		for (let i = 0; i < melTensor.length; i++) {
			const clamped = Math.max(melTensor[i], floorClip);
			melTensor[i] = (clamped + 4) / 4;
		}
		return {
			melTensor,
			numFrames,
			nMels: this.nMels
		};
	}
	/**
	* Computes 80-Channel NeMo Log-Mel Spectrogram [numFrames * 80] matching
	* Shenava-Rizeh / NVIDIA NeMo FastConformer ONNX export (`normalize_type: ""`):
	* - Pre-emphasis (coeff 0.97)
	* - Center zero-padding (nFft/2 = 256 samples on both sides)
	* - Periodic Hann window (400 samples @ 16kHz, hop 160 samples, nFft 512)
	* - Slaney area-normalized 80-bin Mel filterbank (0..8000 Hz)
	* - Natural log `ln(melEnergy + 2^-24)` with NO per-feature mean/variance normalization
	*/
	computeNemoLogMelSpectrogram(pcm16kMono) {
		if (pcm16kMono.length === 0) return {
			melTensor: /* @__PURE__ */ new Float32Array(0),
			numFrames: 0,
			nMels: this.nMels
		};
		const preemph = new Float32Array(pcm16kMono.length);
		preemph[0] = Number.isFinite(pcm16kMono[0]) ? pcm16kMono[0] : 0;
		for (let i = 1; i < pcm16kMono.length; i++) {
			const curr = Number.isFinite(pcm16kMono[i]) ? pcm16kMono[i] : 0;
			const prev = Number.isFinite(pcm16kMono[i - 1]) ? pcm16kMono[i - 1] : 0;
			preemph[i] = curr - .97 * prev;
		}
		const pad = this.nFft >> 1;
		const padded = new Float32Array(preemph.length + 2 * pad);
		padded.set(preemph, pad);
		const numFrames = Math.max(1, 1 + Math.floor((padded.length - this.nFft) / this.hopLength));
		const melTensor = new Float32Array(numFrames * this.nMels);
		const nFreqBins = (this.nFft >> 1) + 1;
		const winOffset = this.nFft - this.winLength >> 1;
		const logZeroGuard = Math.pow(2, -24);
		const real = new Float32Array(this.nFft);
		const imag = new Float32Array(this.nFft);
		const powerSpectrum = new Float32Array(nFreqBins);
		for (let f = 0; f < numFrames; f++) {
			const start = f * this.hopLength;
			real.fill(0);
			imag.fill(0);
			for (let i = 0; i < this.winLength; i++) {
				const idx = start + winOffset + i;
				const s = idx < padded.length ? padded[idx] : 0;
				real[winOffset + i] = s * this.hannWindow[i];
			}
			this.radix2FftInPlace(real, imag);
			for (let k = 0; k < nFreqBins; k++) {
				const p = real[k] * real[k] + imag[k] * imag[k];
				powerSpectrum[k] = Number.isFinite(p) ? p : 0;
			}
			const frameOffset = f * this.nMels;
			for (let m = 0; m < this.nMels; m++) {
				const filterWeights = this.melFilterbank[m];
				let melEnergy = 0;
				for (let k = 0; k < nFreqBins; k++) melEnergy += powerSpectrum[k] * filterWeights[k];
				const safeEnergy = Number.isFinite(melEnergy) && melEnergy > 0 ? melEnergy : 0;
				melTensor[frameOffset + m] = Math.log(safeEnergy + logZeroGuard);
			}
		}
		return {
			melTensor,
			numFrames,
			nMels: this.nMels
		};
	}
	/**
	* Estimates explicit transient JavaScript TypedArray allocations for feature extraction
	* over `sampleCount16k` samples (Log-Mel tensor + FFT real/imag + power spectrum).
	*
	* NOTE: Does NOT include opaque memory allocated internally inside an external ONNX
	* Runtime, WebAssembly heap, or WebGPU driver unless separately exposed by that runtime.
	*/
	estimateWorkingMemoryBytes(sampleCount16k) {
		if (typeof sampleCount16k !== "number" || !Number.isFinite(sampleCount16k) || sampleCount16k < this.winLength) return 0;
		const numFrames = 1 + Math.floor((Math.trunc(sampleCount16k) - this.winLength) / this.hopLength);
		const nFreqBins = (this.nFft >> 1) + 1;
		const melTensorBytes = numFrames * this.nMels * Float32Array.BYTES_PER_ELEMENT;
		const fftRealBytes = this.nFft * Float32Array.BYTES_PER_ELEMENT;
		const fftImagBytes = this.nFft * Float32Array.BYTES_PER_ELEMENT;
		const powerSpectrumBytes = nFreqBins * Float32Array.BYTES_PER_ELEMENT;
		return melTensorBytes + fftRealBytes + fftImagBytes + powerSpectrumBytes;
	}
	/**
	* Extracts Log-Mel features for a 16kHz window and runs the bound ONNX inference runner if present.
	*/
	async transcribeWindow(pcm16kMono) {
		const { melTensor, numFrames, nMels } = this.computeLogMelSpectrogram(pcm16kMono);
		if (numFrames === 0) return [];
		if (this.inferenceRunner) return this.inferenceRunner(melTensor, numFrames, nMels);
		return [];
	}
	/**
	* Decodes per-frame CTC token probabilities into Persian word spans using greedy collapse (index 0 = blank).
	*/
	static greedyDecodeCtcToWords(frameProbs, idToChar, frameStrideSec = .02) {
		const safeStrideSec = Number.isFinite(frameStrideSec) && frameStrideSec > 0 ? frameStrideSec : .02;
		let prevTok = 0;
		let currentWord = "";
		let wordStartFrame = -1;
		let wordProbSum = 0;
		let wordCharCount = 0;
		const words = [];
		for (let t = 0; t < frameProbs.length; t++) {
			const probs = frameProbs[t];
			let bestId = 0;
			let bestProb = -Infinity;
			for (let c = 0; c < probs.length; c++) {
				const p = probs[c];
				if (Number.isFinite(p) && p > bestProb) {
					bestProb = p;
					bestId = c;
				}
			}
			if (!Number.isFinite(bestProb)) bestProb = 0;
			if (bestId !== 0 && bestId !== prevTok) {
				const ch = idToChar.get(bestId) ?? "";
				if (ch === " ") {
					if (currentWord.length > 0) {
						words.push({
							word: currentWord,
							relativeStartSec: Number((wordStartFrame * safeStrideSec).toFixed(3)),
							relativeEndSec: Number((t * safeStrideSec).toFixed(3)),
							probability: Number((wordProbSum / Math.max(1, wordCharCount)).toFixed(3))
						});
						currentWord = "";
						wordStartFrame = -1;
						wordProbSum = 0;
						wordCharCount = 0;
					}
				} else if (ch.length > 0) {
					if (currentWord.length === 0) wordStartFrame = t;
					currentWord += ch;
					wordProbSum += Math.max(0, Math.min(1, bestProb));
					wordCharCount++;
				}
			}
			prevTok = bestId;
		}
		if (currentWord.length > 0 && wordStartFrame >= 0) words.push({
			word: currentWord,
			relativeStartSec: Number((wordStartFrame * safeStrideSec).toFixed(3)),
			relativeEndSec: Number((frameProbs.length * safeStrideSec).toFixed(3)),
			probability: Number((wordProbSum / Math.max(1, wordCharCount)).toFixed(3))
		});
		return words;
	}
	buildPeriodicHannWindow(length) {
		const win = new Float32Array(length);
		for (let i = 0; i < length; i++) win[i] = .5 * (1 - Math.cos(2 * Math.PI * i / length));
		return win;
	}
	build80BandMelFilterbank(sampleRate, nFft, nMels, fMin, fMax) {
		const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
		const melToHz = (mel) => 700 * (Math.pow(10, mel / 2595) - 1);
		const melMin = hzToMel(fMin);
		const melMax = hzToMel(fMax);
		const melPoints = new Float32Array(nMels + 2);
		for (let i = 0; i < nMels + 2; i++) melPoints[i] = melToHz(melMin + (melMax - melMin) * i / (nMels + 1));
		const nFreqBins = (nFft >> 1) + 1;
		const fftFreqs = new Float32Array(nFreqBins);
		for (let k = 0; k < nFreqBins; k++) fftFreqs[k] = k * sampleRate / nFft;
		const filters = [];
		for (let m = 0; m < nMels; m++) {
			const weights = new Float32Array(nFreqBins);
			const fLeft = melPoints[m];
			const fCenter = melPoints[m + 1];
			const fRight = melPoints[m + 2];
			const normFactor = 2 / (fRight - fLeft + 1e-12);
			for (let k = 0; k < nFreqBins; k++) {
				const freq = fftFreqs[k];
				if (freq >= fLeft && freq <= fCenter) weights[k] = (freq - fLeft) / (fCenter - fLeft + 1e-12) * normFactor;
				else if (freq > fCenter && freq <= fRight) weights[k] = (fRight - freq) / (fRight - fCenter + 1e-12) * normFactor;
			}
			filters.push(weights);
		}
		return filters;
	}
	/** Zero-allocation in-place Radix-2 Cooley-Tukey FFT */
	radix2FftInPlace(real, imag) {
		const n = real.length;
		let j = 0;
		for (let i = 0; i < n - 1; i++) {
			if (i < j) {
				const tr = real[i];
				real[i] = real[j];
				real[j] = tr;
				const ti = imag[i];
				imag[i] = imag[j];
				imag[j] = ti;
			}
			let k = n >> 1;
			while (k <= j) {
				j -= k;
				k >>= 1;
			}
			j += k;
		}
		for (let size = 2; size <= n; size <<= 1) {
			const half = size >> 1;
			const stepAngle = -2 * Math.PI / size;
			const wStepR = Math.cos(stepAngle);
			const wStepI = Math.sin(stepAngle);
			for (let i = 0; i < n; i += size) {
				let wr = 1;
				let wi = 0;
				for (let k = 0; k < half; k++) {
					const evenIdx = i + k;
					const oddIdx = i + k + half;
					const tr = wr * real[oddIdx] - wi * imag[oddIdx];
					const ti = wr * imag[oddIdx] + wi * real[oddIdx];
					real[oddIdx] = real[evenIdx] - tr;
					imag[oddIdx] = imag[evenIdx] - ti;
					real[evenIdx] += tr;
					imag[evenIdx] += ti;
					const nextWr = wr * wStepR - wi * wStepI;
					wi = wr * wStepI + wi * wStepR;
					wr = nextWr;
				}
			}
		}
	}
};
// src/ai-engine/asr/PersianCtcPrefixBeamSearchDecoder.ts
const NEG_INF = -0x56bc75e2d63100000;
const IGNORED_SPECIAL_TOKENS = /* @__PURE__ */ new Set([
	"<blk>",
	"<eps>",
	"<pad>",
	"<unk>",
	"<s>",
	"</s>"
]);
var PersianCtcPrefixBeamSearchDecoder = class {
	constructor(vocabulary, blankTokenId = 0, spaceChar = " ", lmScorer) {
		this.vocabulary = vocabulary;
		this.blankTokenId = blankTokenId;
		this.spaceChar = spaceChar;
		this.lmScorer = lmScorer;
	}
	/**
	* اجرای CTC Prefix Beam Search روی ماتریس خروجی شبکه عصبی [T_frames x VocabSize]
	*/
	decodeWithWordTimestamps(params) {
		const { logProbsPerFrame, frameDurationSec = .04, beamWidth = 16, lmAlpha = .45, wordInsertionBeta = 1.2, topKPerFrame = 8 } = params;
		if (logProbsPerFrame.length === 0) return {
			bestTranscript: "",
			words: [],
			totalLogScore: 0
		};
		let activeBeams = /* @__PURE__ */ new Map();
		activeBeams.set("", {
			text: "",
			lastTokenId: null,
			logPBlank: 0,
			logPNonBlank: NEG_INF,
			logPLm: 0,
			wordCount: 0,
			charSpans: []
		});
		for (let t = 0; t < logProbsPerFrame.length; t++) {
			const frameLogProbs = logProbsPerFrame[t];
			const nextBeams = /* @__PURE__ */ new Map();
			const topTokenIndices = this.getTopKTokenIndices(frameLogProbs, topKPerFrame);
			const blankLogP = this.blankTokenId >= 0 && this.blankTokenId < frameLogProbs.length ? frameLogProbs[this.blankTokenId] : NEG_INF;
			for (const beam of activeBeams.values()) {
				const beamTotalAcoustic = this.logAddExp(beam.logPBlank, beam.logPNonBlank);
				this.accumulateBeam(nextBeams, beam.text, beam.lastTokenId, beamTotalAcoustic + blankLogP, NEG_INF, beam.logPLm, beam.wordCount, beam.charSpans);
				for (const tokId of topTokenIndices) {
					if (tokId === this.blankTokenId) continue;
					const rawToken = this.vocabulary[tokId];
					if (!rawToken || IGNORED_SPECIAL_TOKENS.has(rawToken)) continue;
					const charLogP = frameLogProbs[tokId];
					const textPiece = rawToken.replace(/▁/g, " ");
					const lastChar = beam.text.length > 0 ? beam.text[beam.text.length - 1] : "";
					if (tokId === beam.lastTokenId || rawToken.length === 1 && textPiece === lastChar && beam.lastTokenId !== null) {
						const updatedSpans = this.extendLastCharSpan(beam.charSpans, t, charLogP);
						this.accumulateBeam(nextBeams, beam.text, tokId, NEG_INF, beam.logPNonBlank + charLogP, beam.logPLm, beam.wordCount, updatedSpans);
						const extendedText = beam.text + textPiece;
						const { deltaLm, deltaWords } = this.evaluateWordCompletionOnToken(beam.text, rawToken, lmAlpha);
						const newSpans = [...beam.charSpans, {
							char: rawToken,
							startFrame: t,
							endFrame: t + 1,
							logProb: charLogP
						}];
						this.accumulateBeam(nextBeams, extendedText, tokId, NEG_INF, beam.logPBlank + charLogP, beam.logPLm + deltaLm, beam.wordCount + deltaWords, newSpans);
					} else {
						const extendedText = beam.text + textPiece;
						const { deltaLm, deltaWords } = this.evaluateWordCompletionOnToken(beam.text, rawToken, lmAlpha);
						const newSpans = [...beam.charSpans, {
							char: rawToken,
							startFrame: t,
							endFrame: t + 1,
							logProb: charLogP
						}];
						this.accumulateBeam(nextBeams, extendedText, tokId, NEG_INF, beamTotalAcoustic + charLogP, beam.logPLm + deltaLm, beam.wordCount + deltaWords, newSpans);
					}
				}
			}
			activeBeams = this.pruneBeams(nextBeams, beamWidth, wordInsertionBeta);
		}
		let bestBeam = null;
		let bestFinalScore = NEG_INF;
		for (const beam of activeBeams.values()) {
			const { deltaLm, deltaWords } = this.evaluateWordCompletionOnToken(beam.text, this.spaceChar, lmAlpha);
			const finalScore = this.logAddExp(beam.logPBlank, beam.logPNonBlank) + beam.logPLm + deltaLm + (beam.wordCount + deltaWords) * wordInsertionBeta;
			if (finalScore > bestFinalScore) {
				bestFinalScore = finalScore;
				bestBeam = beam;
			}
		}
		if (!bestBeam) return {
			bestTranscript: "",
			words: [],
			totalLogScore: 0
		};
		const words = this.groupCharSpansIntoWordPredictions(bestBeam.charSpans, frameDurationSec);
		return {
			bestTranscript: bestBeam.text.replace(/\s+/g, " ").trim(),
			words,
			totalLogScore: Number(bestFinalScore.toFixed(3))
		};
	}
	evaluateWordCompletionOnToken(prevText, nextToken, lmAlpha) {
		if (!(nextToken === this.spaceChar || nextToken.startsWith("▁") || nextToken.startsWith(" "))) return {
			deltaLm: 0,
			deltaWords: 0
		};
		const wordsSoFar = prevText.trim().split(/\s+/).filter(Boolean);
		if (wordsSoFar.length === 0) return {
			deltaLm: 0,
			deltaWords: 0
		};
		const completedWord = wordsSoFar[wordsSoFar.length - 1];
		const prevWord = wordsSoFar.length >= 2 ? wordsSoFar[wordsSoFar.length - 2] : null;
		if (!this.lmScorer) return {
			deltaLm: 0,
			deltaWords: 1
		};
		return {
			deltaLm: lmAlpha * (this.lmScorer.scoreWordTransitionLogProb(prevWord, completedWord) + (this.lmScorer.isKnownPersianWord(completedWord) ? .8 : -.6)),
			deltaWords: 1
		};
	}
	groupCharSpansIntoWordPredictions(charSpans, frameDurationSec) {
		const words = [];
		let currentChars = [];
		const flushWord = () => {
			if (currentChars.length === 0) return;
			const wordText = currentChars.map((c) => c.char).join("");
			const startFrame = currentChars[0].startFrame;
			const endFrame = currentChars[currentChars.length - 1].endFrame;
			const avgLogP = currentChars.reduce((acc, c) => acc + c.logProb, 0) / currentChars.length;
			words.push({
				word: wordText,
				relativeStartSec: Number((startFrame * frameDurationSec).toFixed(3)),
				relativeEndSec: Number(Math.max(endFrame * frameDurationSec, startFrame * frameDurationSec + .04).toFixed(3)),
				probability: Number(Math.min(.99, Math.exp(Math.max(-10, avgLogP))).toFixed(3))
			});
			currentChars = [];
		};
		for (const span of charSpans) if (span.char === this.spaceChar || span.char === "▁") flushWord();
		else if (span.char.startsWith("▁") || span.char.startsWith(" ")) {
			flushWord();
			const cleanPiece = span.char.replace(/^[\s▁]+/, "");
			if (cleanPiece.length > 0) currentChars.push({
				...span,
				char: cleanPiece
			});
		} else currentChars.push(span);
		flushWord();
		return words;
	}
	accumulateBeam(map, text, lastTokenId, addLogPBlank, addLogPNonBlank, logPLm, wordCount, charSpans) {
		const existing = map.get(text);
		if (!existing) {
			map.set(text, {
				text,
				lastTokenId,
				logPBlank: addLogPBlank,
				logPNonBlank: addLogPNonBlank,
				logPLm,
				wordCount,
				charSpans
			});
			return;
		}
		const prevAcoustic = this.logAddExp(existing.logPBlank, existing.logPNonBlank);
		existing.logPBlank = this.logAddExp(existing.logPBlank, addLogPBlank);
		existing.logPNonBlank = this.logAddExp(existing.logPNonBlank, addLogPNonBlank);
		if (this.logAddExp(addLogPBlank, addLogPNonBlank) > prevAcoustic && charSpans.length >= existing.charSpans.length) {
			existing.lastTokenId = lastTokenId;
			existing.logPLm = logPLm;
			existing.wordCount = wordCount;
			existing.charSpans = charSpans;
		}
	}
	extendLastCharSpan(spans, frameIdx, frameLogProb) {
		if (spans.length === 0) return spans;
		const copy = spans.slice(0, -1);
		const last = spans[spans.length - 1];
		copy.push({
			...last,
			endFrame: frameIdx + 1,
			logProb: Math.max(last.logProb, frameLogProb)
		});
		return copy;
	}
	pruneBeams(beams, beamWidth, wordInsertionBeta) {
		if (beams.size <= beamWidth) return beams;
		const sorted = Array.from(beams.values()).sort((a, b) => {
			const scoreA = this.logAddExp(a.logPBlank, a.logPNonBlank) + a.logPLm + a.wordCount * wordInsertionBeta;
			return this.logAddExp(b.logPBlank, b.logPNonBlank) + b.logPLm + b.wordCount * wordInsertionBeta - scoreA;
		});
		const pruned = /* @__PURE__ */ new Map();
		for (let i = 0; i < Math.min(beamWidth, sorted.length); i++) pruned.set(sorted[i].text, sorted[i]);
		return pruned;
	}
	getTopKTokenIndices(logProbs, k) {
		const limit = Math.min(k, logProbs.length);
		const topIndices = [];
		for (let i = 0; i < logProbs.length; i++) {
			const val = logProbs[i];
			if (!Number.isFinite(val)) continue;
			if (topIndices.length < limit) {
				topIndices.push(i);
				for (let j = topIndices.length - 1; j > 0; j--) if (logProbs[topIndices[j]] > logProbs[topIndices[j - 1]]) {
					const tmp = topIndices[j];
					topIndices[j] = topIndices[j - 1];
					topIndices[j - 1] = tmp;
				} else break;
			} else if (val > logProbs[topIndices[limit - 1]]) {
				topIndices[limit - 1] = i;
				for (let j = limit - 1; j > 0; j--) if (logProbs[topIndices[j]] > logProbs[topIndices[j - 1]]) {
					const tmp = topIndices[j];
					topIndices[j] = topIndices[j - 1];
					topIndices[j - 1] = tmp;
				} else break;
			}
		}
		return topIndices;
	}
	logAddExp(a, b) {
		if (a <= NEG_INF * .5) return b;
		if (b <= NEG_INF * .5) return a;
		return a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));
	}
};
// src/ai-engine/asr/UnifiedOnnxPersianAsrEngine.ts
/**
* موتور کامل استنتاج تشخیص گفتار فارسی (سازگار با Browser Worker و Node.js Backend)
*/
var UnifiedOnnxPersianAsrEngine = class {
	constructor(ortProvider, architecture, config) {
		this.ortProvider = ortProvider;
		this.encoderSession = null;
		this.decoderSession = null;
		this.ctcDecoder = null;
		this.architecture = architecture;
		this.modelId = config.modelId;
		this.modelVersion = config.modelVersion;
		this.featureExtractor = new OnnxPersianAsrAndVadAdapter(config.modelId, config.modelVersion);
		const { decoderMap, encoderMap } = this.buildWhisperByteMaps();
		this.whisperByteDecoderMap = decoderMap;
		this.whisperByteEncoderMap = encoderMap;
		if (architecture === "FASTCONFORMER_CTC" && config.ctcVocabulary && config.ctcVocabulary.length > 0) {
			const detectedBlankId = config.ctcVocabulary.indexOf("<blk>");
			const blankTokenId = detectedBlankId >= 0 ? detectedBlankId : 0;
			this.ctcDecoder = new PersianCtcPrefixBeamSearchDecoder(config.ctcVocabulary, blankTokenId, " ", config.persianLmScorer);
		}
		this.whisperIdToToken = config.whisperIdToBpeToken ?? /* @__PURE__ */ new Map();
		this.whisperSpecial = config.whisperSpecialTokens ?? {
			sotTokenId: 50258,
			persianLangTokenId: 50300,
			transcribeTaskTokenId: 50359,
			eotTokenId: 50257,
			timestampBeginId: 50364
		};
	}
	hasDecoderConfiguration() {
		if (this.architecture === "FASTCONFORMER_CTC") return this.ctcDecoder !== null;
		return this.whisperIdToToken.size > 0;
	}
	isReady() {
		if (!this.encoderSession) return false;
		if (this.architecture === "FASTCONFORMER_CTC") return this.ctcDecoder !== null;
		return this.decoderSession !== null && this.whisperIdToToken.size > 0;
	}
	getReadinessReport() {
		const sessionInitialized = this.architecture === "FASTCONFORMER_CTC" ? this.encoderSession !== null : this.encoderSession !== null && this.decoderSession !== null;
		const decoderConfigured = this.hasDecoderConfiguration();
		return {
			modelId: this.modelId,
			modelVersion: this.modelVersion,
			architecture: this.architecture,
			sessionInitialized,
			decoderConfigured,
			ready: sessionInitialized && decoderConfigured
		};
	}
	/** کمکی برای ساخت توکن BPE از متن UTF-8 فارسی در تست‌ها و واژه‌نامه‌ها */
	encodeUtf8StringToWhisperBpeToken(utf8Text) {
		const bytes = new TextEncoder().encode(utf8Text);
		let out = "";
		for (const b of bytes) out += this.whisperByteEncoderMap.get(b) ?? "";
		return out;
	}
	/**
	* ۱. بارگذاری مدل(ها) در حافظه Runtime (بدون کپی مضاعف و با پشتیبانی از WebGPU / WASM / CPU / CUDA)
	*/
	async loadModels(params) {
		this.encoderSession = await this.ortProvider.createSession(params.encoderModelBytesOrPath, params.executionProviders);
		if (this.architecture === "WHISPER_SEQ2SEQ" && params.decoderModelBytesOrPath) this.decoderSession = await this.ortProvider.createSession(params.decoderModelBytesOrPath, params.executionProviders);
	}
	/** آزادسازی کامل حافظه مدل پس از اتمام پردازش (سیاست Single-Active-Heavy-Model) */
	async unloadModels() {
		if (this.encoderSession?.release) await this.encoderSession.release();
		if (this.decoderSession?.release) await this.decoderSession.release();
		this.encoderSession = null;
		this.decoderSession = null;
	}
	async dispose() {
		await this.unloadModels();
	}
	async detectVoiceActivity(pcm16kMono) {
		return this.featureExtractor.detectVoiceActivity(pcm16kMono);
	}
	/**
	* ۲. اجرای کامل خط لوله استنتاج روی یک پنجره صوتی 16kHz Mono و استخراج کلمات زمان‌بندی‌شده فارسی
	*/
	async transcribeWindow(pcm16kMono) {
		if (!this.encoderSession) throw new Error("ASR_ENGINE_NOT_LOADED: جلسه مدل استنتاج هنوز بارگذاری نشده است.");
		const { melTensor, numFrames, nMels } = this.architecture === "FASTCONFORMER_CTC" ? this.featureExtractor.computeNemoLogMelSpectrogram(pcm16kMono) : this.featureExtractor.computeLogMelSpectrogram(pcm16kMono);
		if (numFrames === 0) return [];
		if (this.architecture === "FASTCONFORMER_CTC") return this.runFastConformerCtcInference(melTensor, numFrames, nMels);
		return this.runWhisperAutoregressiveInference(melTensor, numFrames, nMels);
	}
	/**
	* الف) استنتاج معماری FastConformer-CTC فارسی
	*/
	async runFastConformerCtcInference(melTensor, numFrames, nMels) {
		if (!this.encoderSession || !this.ctcDecoder) throw new Error("FASTCONFORMER_SESSION_OR_VOCAB_MISSING");
		const transposedMel = new Float32Array(nMels * numFrames);
		for (let t = 0; t < numFrames; t++) for (let m = 0; m < nMels; m++) transposedMel[m * numFrames + t] = melTensor[t * nMels + m];
		const audioSignalTensor = this.ortProvider.createTensor("float32", transposedMel, [
			1,
			nMels,
			numFrames
		]);
		const lengthTensor = this.ortProvider.createTensor("int64", BigInt64Array.from([BigInt(numFrames)]), [1]);
		const outputs = await this.encoderSession.run({
			audio_signal: audioSignalTensor,
			length: lengthTensor
		});
		const logProbsOutput = outputs["logprobs"] ?? Object.values(outputs)[0];
		const [, outFrames, vocabSize] = logProbsOutput.dims;
		const flatData = logProbsOutput.data;
		const framesArray = new Array(outFrames);
		for (let t = 0; t < outFrames; t++) {
			const start = t * vocabSize;
			framesArray[t] = flatData.subarray(start, start + vocabSize);
		}
		const frameDurationSec = Math.max(1, Math.round(numFrames / Math.max(1, outFrames))) * .01;
		return this.ctcDecoder.decodeWithWordTimestamps({
			logProbsPerFrame: framesArray,
			frameDurationSec,
			beamWidth: 16
		}).words;
	}
	/**
	* ب) استنتاج خودبازگشتی Whisper فارسی + استخراج بازه‌های زمانی کلمات از توکن‌های Timestamp
	*/
	async runWhisperAutoregressiveInference(melTensor, numFrames, nMels) {
		if (!this.encoderSession || !this.decoderSession) throw new Error("WHISPER_ENCODER_OR_DECODER_MISSING");
		const WHISPER_FRAMES = 3e3;
		const paddedMel = new Float32Array(nMels * WHISPER_FRAMES);
		const copyFrames = Math.min(numFrames, WHISPER_FRAMES);
		for (let t = 0; t < copyFrames; t++) for (let m = 0; m < nMels; m++) paddedMel[m * WHISPER_FRAMES + t] = melTensor[t * nMels + m];
		const melInput = this.ortProvider.createTensor("float32", paddedMel, [
			1,
			nMels,
			WHISPER_FRAMES
		]);
		const encOutputs = await this.encoderSession.run({ input_features: melInput });
		const encoderHiddenStates = encOutputs["last_hidden_state"] ?? Object.values(encOutputs)[0];
		const generatedTokens = [
			{
				tokenId: this.whisperSpecial.sotTokenId,
				prob: 1
			},
			{
				tokenId: this.whisperSpecial.persianLangTokenId,
				prob: 1
			},
			{
				tokenId: this.whisperSpecial.transcribeTaskTokenId,
				prob: 1
			}
		];
		const maxNewTokens = 224;
		for (let step = 0; step < maxNewTokens; step++) {
			const inputIds = BigInt64Array.from(generatedTokens.map((g) => BigInt(g.tokenId)));
			const decInputTensor = this.ortProvider.createTensor("int64", inputIds, [1, inputIds.length]);
			const decOut = await this.decoderSession.run({
				input_ids: decInputTensor,
				encoder_hidden_states: encoderHiddenStates
			});
			const logitsTensor = decOut["logits"] ?? Object.values(decOut)[0];
			const [, seqLen, vocabSize] = logitsTensor.dims;
			const logitsData = logitsTensor.data;
			const lastStepOffset = (seqLen - 1) * vocabSize;
			const lastLogits = logitsData.subarray(lastStepOffset, lastStepOffset + vocabSize);
			const { bestId, prob } = this.argmaxWithSoftmaxProb(lastLogits);
			if (bestId === this.whisperSpecial.eotTokenId) break;
			generatedTokens.push({
				tokenId: bestId,
				prob
			});
		}
		return this.parseWhisperTimestampedTokensToWords(generatedTokens.slice(3));
	}
	/**
	* تبدیل دنباله توکن‌های BPE و توکن‌های زمانی Whisper (<|0.00|> ... <|2.40|>) به کلمات فارسی با زمان دقیق
	*/
	parseWhisperTimestampedTokensToWords(sequence) {
		const segments = [];
		let curStartSec = 0;
		let curTokens = [];
		for (const item of sequence) if (item.tokenId >= this.whisperSpecial.timestampBeginId) {
			const timeSec = (item.tokenId - this.whisperSpecial.timestampBeginId) * .02;
			if (curTokens.length === 0) curStartSec = timeSec;
			else {
				segments.push({
					startSec: curStartSec,
					endSec: Math.max(timeSec, curStartSec + .05),
					textTokenIds: curTokens
				});
				curTokens = [];
				curStartSec = timeSec;
			}
		} else curTokens.push(item);
		const words = [];
		for (const seg of segments) {
			const segWords = this.decodeWhisperBpeTokensToUtf8(seg.textTokenIds.map((t) => t.tokenId)).trim().split(/\s+/).filter(Boolean);
			if (segWords.length === 0) continue;
			const avgProb = seg.textTokenIds.reduce((a, b) => a + b.prob, 0) / seg.textTokenIds.length;
			const totalChars = Math.max(1, segWords.reduce((acc, w) => acc + w.length, 0));
			const segDur = seg.endSec - seg.startSec;
			let cursorSec = seg.startSec;
			for (const w of segWords) {
				const wordDur = w.length / totalChars * segDur;
				words.push({
					word: w,
					relativeStartSec: Number(cursorSec.toFixed(3)),
					relativeEndSec: Number((cursorSec + wordDur).toFixed(3)),
					probability: Number(avgProb.toFixed(3))
				});
				cursorSec += wordDur;
			}
		}
		return words;
	}
	/** دیکد صحیح رشته بایت‌های BPE به متن UTF-8 فارسی بدون شکستن حروف چندبایتی */
	decodeWhisperBpeTokensToUtf8(tokenIds) {
		const rawBytes = [];
		for (const id of tokenIds) {
			const bpeStr = this.whisperIdToToken.get(id);
			if (!bpeStr) continue;
			for (const ch of bpeStr) {
				const byteVal = this.whisperByteDecoderMap.get(ch);
				if (byteVal !== void 0) rawBytes.push(byteVal);
			}
		}
		return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(rawBytes));
	}
	buildWhisperByteMaps() {
		const bs = [];
		for (let b = 33; b <= 126; b++) bs.push(b);
		for (let b = 161; b <= 172; b++) bs.push(b);
		for (let b = 174; b <= 255; b++) bs.push(b);
		const cs = [...bs];
		let n = 0;
		for (let b = 0; b < 256; b++) if (!bs.includes(b)) {
			bs.push(b);
			cs.push(256 + n);
			n++;
		}
		const decoderMap = /* @__PURE__ */ new Map();
		const encoderMap = /* @__PURE__ */ new Map();
		for (let i = 0; i < bs.length; i++) {
			const ch = String.fromCharCode(cs[i]);
			decoderMap.set(ch, bs[i]);
			encoderMap.set(bs[i], ch);
		}
		return {
			decoderMap,
			encoderMap
		};
	}
	argmaxWithSoftmaxProb(logits) {
		let bestId = 0;
		let maxLogit = -Infinity;
		for (let i = 0; i < logits.length; i++) if (logits[i] > maxLogit) {
			maxLogit = logits[i];
			bestId = i;
		}
		let expSum = 0;
		for (let i = 0; i < logits.length; i++) expSum += Math.exp(logits[i] - maxLogit);
		return {
			bestId,
			prob: 1 / expSum
		};
	}
};
// src/utils/StreamingSha256.ts
const SHA256_IV = new Uint32Array([
	1779033703,
	3144134277,
	1013904242,
	2773480762,
	1359893119,
	2600822924,
	528734635,
	1541459225
]);
const SHA256_K = new Uint32Array([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
const HEX_BYTES = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
var IncrementalSha256 = class {
	constructor() {
		this.state = new Uint32Array(SHA256_IV);
		this.blockBuffer = /* @__PURE__ */ new Uint8Array(64);
		this.schedule = /* @__PURE__ */ new Uint32Array(64);
		this.blockLength = 0;
		this.bytesLow = 0;
		this.bytesHigh = 0;
		this.finalized = false;
	}
	update(data) {
		if (this.finalized) throw new Error("SHA256_ALREADY_FINALIZED: Cannot call update() after the SHA-256 digest has been finalized.");
		if (!(data instanceof Uint8Array)) throw new TypeError("SHA256_INVALID_INPUT: IncrementalSha256.update() requires a Uint8Array.");
		const totalLen = data.byteLength;
		if (totalLen === 0) return this;
		const lowAdd = totalLen >>> 0;
		const highAdd = Math.floor(totalLen / 4294967296);
		const prevLow = this.bytesLow;
		this.bytesLow = prevLow + lowAdd >>> 0;
		this.bytesHigh = this.bytesHigh + highAdd + (this.bytesLow < prevLow ? 1 : 0) >>> 0;
		let offset = 0;
		if (this.blockLength > 0) {
			const needed = 64 - this.blockLength;
			if (totalLen < needed) {
				this.blockBuffer.set(data, this.blockLength);
				this.blockLength += totalLen;
				return this;
			}
			this.blockBuffer.set(data.subarray(0, needed), this.blockLength);
			this.compressBlock(this.blockBuffer, 0);
			this.blockLength = 0;
			offset = needed;
		}
		while (offset + 64 <= totalLen) {
			this.compressBlock(data, offset);
			offset += 64;
		}
		const remaining = totalLen - offset;
		if (remaining > 0) {
			this.blockBuffer.set(data.subarray(offset), 0);
			this.blockLength = remaining;
		}
		return this;
	}
	digest() {
		if (this.finalized) throw new Error("SHA256_ALREADY_FINALIZED: Cannot call digest() more than once on the same IncrementalSha256 instance.");
		this.finalized = true;
		const buf = this.blockBuffer;
		let pos = this.blockLength;
		buf[pos++] = 128;
		if (pos > 56) {
			buf.fill(0, pos, 64);
			this.compressBlock(buf, 0);
			pos = 0;
		}
		buf.fill(0, pos, 56);
		const bitsHigh = (this.bytesHigh << 3 | this.bytesLow >>> 29) >>> 0;
		const bitsLow = this.bytesLow << 3 >>> 0;
		buf[56] = bitsHigh >>> 24 & 255;
		buf[57] = bitsHigh >>> 16 & 255;
		buf[58] = bitsHigh >>> 8 & 255;
		buf[59] = bitsHigh & 255;
		buf[60] = bitsLow >>> 24 & 255;
		buf[61] = bitsLow >>> 16 & 255;
		buf[62] = bitsLow >>> 8 & 255;
		buf[63] = bitsLow & 255;
		this.compressBlock(buf, 0);
		const out = /* @__PURE__ */ new Uint8Array(32);
		const st = this.state;
		for (let i = 0; i < 8; i++) {
			const word = st[i];
			const base = i * 4;
			out[base] = word >>> 24 & 255;
			out[base + 1] = word >>> 16 & 255;
			out[base + 2] = word >>> 8 & 255;
			out[base + 3] = word & 255;
		}
		this.blockBuffer.fill(0);
		this.schedule.fill(0);
		this.blockLength = 0;
		return out;
	}
	digestHex() {
		const bytes = this.digest();
		let hex = "";
		for (let i = 0; i < 32; i++) hex += HEX_BYTES[bytes[i]];
		return hex;
	}
	compressBlock(chunk, offset) {
		const w = this.schedule;
		const k = SHA256_K;
		const st = this.state;
		for (let i = 0; i < 16; i++) {
			const base = offset + (i << 2);
			w[i] = (chunk[base] << 24 | chunk[base + 1] << 16 | chunk[base + 2] << 8 | chunk[base + 3]) >>> 0;
		}
		for (let i = 16; i < 64; i++) {
			const w15 = w[i - 15];
			const s0 = (w15 >>> 7 | w15 << 25) ^ (w15 >>> 18 | w15 << 14) ^ w15 >>> 3;
			const w2 = w[i - 2];
			const s1 = (w2 >>> 17 | w2 << 15) ^ (w2 >>> 19 | w2 << 13) ^ w2 >>> 10;
			w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
		}
		let a = st[0];
		let b = st[1];
		let c = st[2];
		let d = st[3];
		let e = st[4];
		let f = st[5];
		let g = st[6];
		let h = st[7];
		for (let i = 0; i < 64; i++) {
			const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
			const ch = e & f ^ ~e & g;
			const temp1 = h + S1 + ch + k[i] + w[i] | 0;
			const temp2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) | 0;
			h = g;
			g = f;
			f = e;
			e = d + temp1 | 0;
			d = c;
			c = b;
			b = a;
			a = temp1 + temp2 | 0;
		}
		st[0] = st[0] + a >>> 0;
		st[1] = st[1] + b >>> 0;
		st[2] = st[2] + c >>> 0;
		st[3] = st[3] + d >>> 0;
		st[4] = st[4] + e >>> 0;
		st[5] = st[5] + f >>> 0;
		st[6] = st[6] + g >>> 0;
		st[7] = st[7] + h >>> 0;
	}
};
// src/security/LocalPrivacyPolicy.ts
var InputHardeningError = class extends Error {
	constructor(code, message) {
		super(message);
		this.name = "InputHardeningError";
		this.code = code;
	}
};
const DANGEROUS_KEYS = /* @__PURE__ */ new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function assertNoPrototypePollution(node, depth = 0) {
	if (depth > 40) throw new InputHardeningError("MALFORMED_JSON", "JSON nesting depth exceeds safe limit (40).");
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) assertNoPrototypePollution(node[i], depth + 1);
		return;
	}
	for (const key of Object.keys(node)) {
		if (DANGEROUS_KEYS.has(key)) throw new InputHardeningError("PROTOTYPE_POLLUTION_BLOCKED", `Blocked forbidden JSON key "${key}" during hardened import.`);
		assertNoPrototypePollution(node[key], depth + 1);
	}
}
/**
* Safely parses untrusted JSON (imported EDLs, transcripts, project metadata, model manifests)
* with explicit byte-size bounds and prototype-pollution blocking.
*/
function safeParseJsonWithGuards(rawJson, maxBytes = 5242880) {
	if (typeof rawJson !== "string") throw new InputHardeningError("MALFORMED_JSON", "Input JSON must be a string.");
	const byteLen = new TextEncoder().encode(rawJson).byteLength;
	if (byteLen > maxBytes) throw new InputHardeningError("PAYLOAD_TOO_LARGE", `JSON payload (${byteLen} B) exceeds maximum permitted size (${maxBytes} B).`);
	let parsed;
	try {
		parsed = JSON.parse(rawJson);
	} catch (err) {
		throw new InputHardeningError("MALFORMED_JSON", `Malformed JSON input: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (/"__proto__"\s*:|"constructor"\s*:|"prototype"\s*:/i.test(rawJson)) throw new InputHardeningError("PROTOTYPE_POLLUTION_BLOCKED", "Rejected JSON containing prototype-pollution keys (__proto__/constructor/prototype).");
	assertNoPrototypePollution(parsed);
	return parsed;
}
// src/runtime/memory/MemoryPolicy.ts
/**
* Centralized application-managed memory policy and audio-cache split constants
* for Avapardaz local-first runtime discipline.
*
* NOTE: These constants govern application-managed memory accounting and admission
* thresholds. They do NOT guarantee a browser-process-wide, GPU, OS, or
* browser-internal decoded-media RAM ceiling of 1 GiB.
*/
const AVAPARDAZ_MEMORY_POLICY = {
	hardLimitBytes: 1073741824,
	targetBytes: 891289600,
	throttleBytes: 943718400,
	emergencyBytes: 996147200,
	audioCacheBytes: 33554432
};
const AVAPARDAZ_AUDIO_CACHE_SPLIT = {
	mainThreadBytes: 25165824,
	workerFallbackBytes: 8388608,
	combinedMaxBytes: AVAPARDAZ_MEMORY_POLICY.audioCacheBytes
};
if (AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes + AVAPARDAZ_AUDIO_CACHE_SPLIT.workerFallbackBytes !== AVAPARDAZ_MEMORY_POLICY.audioCacheBytes) throw new Error("AVAPARDAZ_AUDIO_CACHE_SPLIT must sum to AVAPARDAZ_MEMORY_POLICY.audioCacheBytes");
function validateMemoryPolicy(policy) {
	for (const key of [
		"hardLimitBytes",
		"targetBytes",
		"throttleBytes",
		"emergencyBytes",
		"audioCacheBytes"
	]) {
		const val = policy[key];
		if (typeof val !== "number" || !Number.isSafeInteger(val) || val <= 0) throw new RangeError(`MemoryPolicy.${key} must be a positive safe integer byte count, got ${String(val)}`);
	}
	if (!(policy.targetBytes <= policy.throttleBytes && policy.throttleBytes <= policy.emergencyBytes && policy.emergencyBytes <= policy.hardLimitBytes)) throw new RangeError("MemoryPolicy must satisfy targetBytes <= throttleBytes <= emergencyBytes <= hardLimitBytes");
}
// src/runtime/memory/MemoryBudgetManager.ts
var InvalidMemoryReservationError = class extends RangeError {
	constructor(message) {
		super(message);
		this.code = "INVALID_MEMORY_RESERVATION";
		this.name = "InvalidMemoryReservationError";
	}
};
var DuplicateMemoryAllocationIdError = class extends Error {
	constructor(allocationId) {
		super(`Duplicate active memory allocation ID: "${allocationId}".`);
		this.code = "DUPLICATE_MEMORY_ALLOCATION_ID";
		this.name = "DuplicateMemoryAllocationIdError";
		this.allocationId = allocationId;
	}
};
var MemoryPressureError = class extends Error {
	constructor(params) {
		super(params.message);
		this.code = "MEMORY_PRESSURE_LIMIT";
		this.name = "MemoryPressureError";
		this.requestedBytes = params.requestedBytes;
		this.accountedBytes = params.accountedBytes;
		this.hardLimitBytes = params.hardLimitBytes;
		this.availableBytes = Math.max(0, params.hardLimitBytes - params.accountedBytes);
		this.pressureLevel = params.pressureLevel;
	}
};
const ALL_CATEGORIES = [
	"decoded-audio",
	"asr-input-windows",
	"asr-feature-buffers",
	"model-runtime",
	"render-export-buffers",
	"audio-cache",
	"other"
];
function createEmptyCategoryMap() {
	return {
		"decoded-audio": 0,
		"asr-input-windows": 0,
		"asr-feature-buffers": 0,
		"model-runtime": 0,
		"render-export-buffers": 0,
		"audio-cache": 0,
		other: 0
	};
}
function readBrowserJsHeapMeasurement() {
	const mem = (typeof performance !== "undefined" ? performance : void 0)?.memory;
	if (mem && typeof mem.usedJSHeapSize === "number" && Number.isFinite(mem.usedJSHeapSize) && typeof mem.totalJSHeapSize === "number" && Number.isFinite(mem.totalJSHeapSize) && typeof mem.jsHeapSizeLimit === "number" && Number.isFinite(mem.jsHeapSizeLimit)) return {
		available: true,
		usedJSHeapSizeBytes: Math.trunc(mem.usedJSHeapSize),
		totalJSHeapSizeBytes: Math.trunc(mem.totalJSHeapSize),
		jsHeapSizeLimitBytes: Math.trunc(mem.jsHeapSizeLimit),
		scopeNote: "Main-thread JS heap only; excludes Workers, WebAssembly, GPU, decoded media, and browser-internal buffers."
	};
	return {
		available: false,
		usedJSHeapSizeBytes: null,
		totalJSHeapSizeBytes: null,
		jsHeapSizeLimitBytes: null,
		scopeNote: "Browser JS heap telemetry (performance.memory) is unavailable in this environment."
	};
}
/**
* Application-managed memory reservation and pressure-control coordinator.
* All admission decisions use exact integer byte arithmetic.
*/
var MemoryBudgetManager = class {
	constructor(policy = AVAPARDAZ_MEMORY_POLICY, options) {
		this.reservations = /* @__PURE__ */ new Map();
		this.evictionCallbacks = /* @__PURE__ */ new Set();
		this.categoryTotals = createEmptyCategoryMap();
		this.accountedBytes = 0;
		this.highWaterMarkBytes = 0;
		this.seq = 0;
		this.evictionTriggerCount = 0;
		this.isRunningEvictionCallbacks = false;
		this.disposed = false;
		validateMemoryPolicy(policy);
		this.policy = { ...policy };
		this.now = options?.now ?? (() => Date.now());
	}
	getUsedBytes() {
		return this.accountedBytes;
	}
	getCategoryUsage(category) {
		return this.categoryTotals[category] ?? 0;
	}
	getPressureLevel(bytes = this.accountedBytes) {
		if (bytes >= this.policy.emergencyBytes) return "emergency";
		if (bytes >= this.policy.throttleBytes) return "throttle";
		if (bytes >= this.policy.targetBytes) return "elevated";
		return "normal";
	}
	registerCacheEvictionCallback(callback) {
		if (this.disposed) return () => {};
		this.evictionCallbacks.add(callback);
		return () => {
			this.evictionCallbacks.delete(callback);
		};
	}
	canStartHeavyTask(options) {
		const pressureLevel = this.getPressureLevel();
		const throttled = pressureLevel === "throttle" || pressureLevel === "emergency";
		const allowOptionalPrefetch = !throttled;
		const baseMaxConcurrent = typeof options?.defaultMaxConcurrentHeavyTasks === "number" && Number.isSafeInteger(options.defaultMaxConcurrentHeavyTasks) && options.defaultMaxConcurrentHeavyTasks >= 1 ? options.defaultMaxConcurrentHeavyTasks : 2;
		const recommendedMaxConcurrentHeavyTasks = throttled ? 1 : baseMaxConcurrent;
		if (this.disposed) return {
			allowed: false,
			pressureLevel,
			throttled: true,
			allowOptionalPrefetch: false,
			recommendedMaxConcurrentHeavyTasks: 0,
			reason: "MemoryBudgetManager has been disposed."
		};
		const estimatedBytes = options?.estimatedBytes ?? 0;
		if (typeof estimatedBytes !== "number" || !Number.isFinite(estimatedBytes) || !Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) return {
			allowed: false,
			pressureLevel,
			throttled,
			allowOptionalPrefetch,
			recommendedMaxConcurrentHeavyTasks,
			reason: "Invalid estimatedBytes for heavy task admission."
		};
		if (pressureLevel === "emergency" && options?.optional) return {
			allowed: false,
			pressureLevel,
			throttled: true,
			allowOptionalPrefetch: false,
			recommendedMaxConcurrentHeavyTasks,
			reason: "Optional memory-intensive work is blocked at emergency memory pressure."
		};
		if (typeof options?.activeHeavyTasks === "number" && options.activeHeavyTasks >= recommendedMaxConcurrentHeavyTasks) return {
			allowed: false,
			pressureLevel,
			throttled,
			allowOptionalPrefetch,
			recommendedMaxConcurrentHeavyTasks,
			reason: throttled ? "Throttled memory state limits concurrent heavy processing to at most 1 task." : "Active heavy task count reached concurrency limit."
		};
		if (this.accountedBytes + estimatedBytes > this.policy.hardLimitBytes) return {
			allowed: false,
			pressureLevel,
			throttled,
			allowOptionalPrefetch,
			recommendedMaxConcurrentHeavyTasks,
			reason: `Estimated ${estimatedBytes} B exceeds remaining application budget (${this.policy.hardLimitBytes - this.accountedBytes} B).`
		};
		return {
			allowed: true,
			pressureLevel,
			throttled,
			allowOptionalPrefetch,
			recommendedMaxConcurrentHeavyTasks
		};
	}
	reserve(request) {
		if (this.disposed) throw new Error("MemoryBudgetManager has been disposed.");
		if (!request || typeof request.owner !== "string" || request.owner.trim().length === 0) throw new InvalidMemoryReservationError("Reservation owner must be a non-empty string.");
		if (request.id !== void 0) {
			if (typeof request.id !== "string" || request.id.trim().length === 0) throw new InvalidMemoryReservationError("Explicit reservation id must be a non-empty string.");
			if (this.reservations.has(request.id.trim())) throw new DuplicateMemoryAllocationIdError(request.id.trim());
		}
		if (!ALL_CATEGORIES.includes(request.category)) throw new InvalidMemoryReservationError(`Unknown memory category: ${String(request.category)}`);
		const bytes = request.bytes;
		if (typeof bytes !== "number" || !Number.isFinite(bytes) || !Number.isSafeInteger(bytes) || bytes <= 0) throw new InvalidMemoryReservationError(`Reservation bytes must be a positive safe integer, received ${String(bytes)}.`);
		const priority = request.priority ?? (request.protectedUserData ? "protected" : "normal");
		const protectedUserData = Boolean(request.protectedUserData || priority === "protected");
		const releasable = request.releasable !== void 0 ? Boolean(request.releasable) : !protectedUserData;
		const projected = this.accountedBytes + bytes;
		const currentPressure = this.getPressureLevel();
		const projectedPressure = this.getPressureLevel(projected);
		if (projectedPressure === "emergency" || currentPressure === "emergency" || projected > this.policy.hardLimitBytes) {
			const targetFreeBytes = Math.max(0, projected - this.policy.targetBytes);
			this.invokeCacheEvictionCallbacks(projectedPressure === "emergency" ? "emergency" : currentPressure, targetFreeBytes);
		}
		const postEvictionPressure = this.getPressureLevel();
		const postEvictionProjected = this.accountedBytes + bytes;
		if (priority === "optional" && postEvictionPressure === "emergency") throw new MemoryPressureError({
			message: `Rejected optional memory reservation "${request.owner}" (${bytes} B) under emergency memory pressure (${this.accountedBytes} / ${this.policy.hardLimitBytes} B).`,
			requestedBytes: bytes,
			accountedBytes: this.accountedBytes,
			hardLimitBytes: this.policy.hardLimitBytes,
			pressureLevel: postEvictionPressure
		});
		if (!Number.isSafeInteger(postEvictionProjected) || postEvictionProjected > this.policy.hardLimitBytes) throw new MemoryPressureError({
			message: `Memory reservation "${request.owner}" (${bytes} B) would exceed hard application limit (${this.accountedBytes} + ${bytes} > ${this.policy.hardLimitBytes} B).`,
			requestedBytes: bytes,
			accountedBytes: this.accountedBytes,
			hardLimitBytes: this.policy.hardLimitBytes,
			pressureLevel: postEvictionPressure
		});
		const assignedId = request.id ? request.id.trim() : `mem-res-${++this.seq}`;
		if (this.reservations.has(assignedId)) throw new DuplicateMemoryAllocationIdError(assignedId);
		const reservation = {
			id: assignedId,
			owner: request.owner.trim(),
			category: request.category,
			bytes,
			createdAt: this.now(),
			priority,
			protectedUserData,
			releasable
		};
		this.reservations.set(reservation.id, reservation);
		this.accountedBytes += bytes;
		this.categoryTotals[reservation.category] += bytes;
		if (this.accountedBytes > this.highWaterMarkBytes) this.highWaterMarkBytes = this.accountedBytes;
		return reservation;
	}
	release(reservationOrId) {
		if (!reservationOrId) return false;
		const id = typeof reservationOrId === "string" ? reservationOrId : reservationOrId.id;
		const existing = this.reservations.get(id);
		if (!existing) return false;
		this.reservations.delete(id);
		this.accountedBytes = Math.max(0, this.accountedBytes - existing.bytes);
		this.categoryTotals[existing.category] = Math.max(0, this.categoryTotals[existing.category] - existing.bytes);
		return true;
	}
	/**
	* Reconciles worker-side or cancelled-task releases by owner prefix or explicit ID list,
	* returning total reclaimed bytes without ever underflowing.
	*/
	releaseByOwner(owner) {
		const trimmed = owner.trim();
		if (!trimmed) return 0;
		let reclaimed = 0;
		for (const res of Array.from(this.reservations.values())) if (res.owner === trimmed) {
			if (this.release(res.id)) reclaimed += res.bytes;
		}
		return reclaimed;
	}
	listActiveReservations() {
		return Array.from(this.reservations.values());
	}
	getActiveAllocations() {
		return this.listActiveReservations();
	}
	/**
	* Detects active reservations older than `maxAgeMs` so leaked buffers are surfaced deterministically.
	*/
	detectLeaks(maxAgeMs, nowMs = this.now()) {
		if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return [];
		const leaks = [];
		for (const reservation of this.reservations.values()) {
			const ageMs = Math.max(0, nowMs - reservation.createdAt);
			if (ageMs >= maxAgeMs) leaks.push({
				reservation,
				ageMs
			});
		}
		return leaks;
	}
	getSnapshot() {
		const pressureLevel = this.getPressureLevel();
		const throttled = pressureLevel === "throttle" || pressureLevel === "emergency";
		return {
			accountedBytes: this.accountedBytes,
			reservationCount: this.reservations.size,
			highWaterMarkBytes: this.highWaterMarkBytes,
			hardLimitBytes: this.policy.hardLimitBytes,
			targetBytes: this.policy.targetBytes,
			throttleBytes: this.policy.throttleBytes,
			emergencyBytes: this.policy.emergencyBytes,
			availableBytes: Math.max(0, this.policy.hardLimitBytes - this.accountedBytes),
			pressureLevel,
			throttled,
			allowOptionalPrefetch: !throttled && !this.disposed,
			recommendedMaxConcurrentHeavyTasks: this.disposed ? 0 : throttled ? 1 : 2,
			evictionTriggerCount: this.evictionTriggerCount,
			disposed: this.disposed,
			byCategory: { ...this.categoryTotals },
			browserJsHeap: readBrowserJsHeapMeasurement()
		};
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.reservations.clear();
		this.evictionCallbacks.clear();
		this.accountedBytes = 0;
		for (const key of ALL_CATEGORIES) this.categoryTotals[key] = 0;
	}
	invokeCacheEvictionCallbacks(pressureLevel, targetFreeBytes) {
		if (this.isRunningEvictionCallbacks || this.evictionCallbacks.size === 0) return;
		this.isRunningEvictionCallbacks = true;
		this.evictionTriggerCount++;
		try {
			for (const cb of Array.from(this.evictionCallbacks)) try {
				cb({
					pressureLevel,
					accountedBytes: this.accountedBytes,
					targetFreeBytes
				});
			} catch {}
		} finally {
			this.isRunningEvictionCallbacks = false;
		}
	}
};
let sharedBudgetManager = null;
function getSharedMemoryBudgetManager() {
	if (!sharedBudgetManager || sharedBudgetManager.getSnapshot().disposed) sharedBudgetManager = new MemoryBudgetManager(AVAPARDAZ_MEMORY_POLICY);
	return sharedBudgetManager;
}
// src/lifecycle/ModelRepositoryContracts.ts
const MODEL_REPOSITORY_ROOT_DIR = "ai-models";
const MODEL_REGISTRY_DIR = "registry";
const MODEL_ARTIFACT_MANIFEST_FILE = "manifest.json";
const MAX_MODEL_CHUNK_BYTES = 1048576;
var ModelRepositoryError = class extends Error {
	constructor(code, message, cause) {
		super(message);
		this.name = "ModelRepositoryError";
		this.code = code;
		this.cause = cause;
	}
};
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
/**
* Validates a single OPFS path component strictly against path traversal,
* separators, null bytes, control characters, and reserved segments.
*/
function validateModelPathSegment(raw, fieldName) {
	if (typeof raw !== "string") throw new ModelRepositoryError("MODEL_PATH_INVALID", `Invalid ${fieldName}: expected non-empty string.`);
	const value = raw.trim();
	if (value.length === 0 || value === "." || value === ".." || value.includes("..") || value.includes("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) || !SAFE_SEGMENT_PATTERN.test(value)) throw new ModelRepositoryError("MODEL_PATH_INVALID", `Invalid ${fieldName} "${raw}": path traversal, separators, null bytes, or unsafe characters are forbidden.`);
	if (value.toLowerCase() === "registry") throw new ModelRepositoryError("MODEL_PATH_INVALID", `Invalid ${fieldName}: "${MODEL_REGISTRY_DIR}" is a reserved repository directory.`);
	return value;
}
function buildModelArtifactDirectory(modelId, version, generationId) {
	const combined = `${validateModelPathSegment(modelId, "modelId")}_${validateModelPathSegment(version, "version")}_${validateModelPathSegment(generationId, "generationId")}`;
	if (combined.length > 200) throw new ModelRepositoryError("MODEL_PATH_INVALID", `Artifact directory name exceeds maximum safe length (${combined.length} > 200).`);
	return combined;
}
function formatModelChunkFileName(index) {
	if (!Number.isSafeInteger(index) || index < 0 || index > 999999) throw new ModelRepositoryError("MODEL_PATH_INVALID", `Invalid chunk index: ${String(index)}.`);
	return `chunk_${String(index).padStart(4, "0")}.bin`;
}
function validateStoredModelArtifactManifest(raw, expectedStorageDirectory) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", "Stored model manifest must be a JSON object.");
	const obj = raw;
	if (obj.schemaVersion !== 1) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Unsupported model artifact manifest schemaVersion: ${String(obj.schemaVersion)}.`);
	const modelId = validateModelPathSegment(obj.modelId, "modelId");
	const version = validateModelPathSegment(obj.version, "version");
	const generationId = validateModelPathSegment(obj.generationId, "generationId");
	if (obj.architecture !== "FASTCONFORMER_CTC" && obj.architecture !== "WHISPER_SEQ2SEQ") throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Unsupported model architecture: ${String(obj.architecture)}.`);
	if (obj.storageBackend !== "OPFS") throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Unsupported model storageBackend: ${String(obj.storageBackend)}.`);
	const expectedCanonicalDir = buildModelArtifactDirectory(modelId, version, generationId);
	const storageDirectory = validateModelPathSegment(obj.storageDirectory, "storageDirectory");
	if (storageDirectory !== expectedCanonicalDir) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Manifest storageDirectory "${storageDirectory}" does not match canonical "${expectedCanonicalDir}".`);
	if (expectedStorageDirectory !== void 0 && storageDirectory !== expectedStorageDirectory) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Manifest storageDirectory "${storageDirectory}" does not match directory "${expectedStorageDirectory}".`);
	if (typeof obj.fileName !== "string" || !/^[A-Za-z0-9._-]+\.onnx$/i.test(obj.fileName) || obj.fileName.includes("..")) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Invalid model fileName: ${String(obj.fileName)}.`);
	if (typeof obj.totalBytes !== "number" || !Number.isSafeInteger(obj.totalBytes) || obj.totalBytes <= 0 || obj.totalBytes > 2147483648) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Invalid manifest totalBytes: ${String(obj.totalBytes)}.`);
	if (typeof obj.chunkSizeBytes !== "number" || !Number.isSafeInteger(obj.chunkSizeBytes) || obj.chunkSizeBytes <= 0 || obj.chunkSizeBytes > 1048576) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Invalid manifest chunkSizeBytes: ${String(obj.chunkSizeBytes)} (must be in 1..${MAX_MODEL_CHUNK_BYTES}).`);
	if (typeof obj.sha256Hex !== "string" || !SHA256_HEX_PATTERN.test(obj.sha256Hex.toLowerCase())) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", "Manifest sha256Hex must be a valid 64-character hex SHA-256 digest.");
	if (!Array.isArray(obj.chunks) || obj.chunks.length === 0) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", "Manifest chunks must be a non-empty array.");
	if (typeof obj.chunkCount !== "number" || !Number.isSafeInteger(obj.chunkCount) || obj.chunkCount !== obj.chunks.length) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Manifest chunkCount (${String(obj.chunkCount)}) does not match chunks.length (${obj.chunks.length}).`);
	if (typeof obj.committedAtMs !== "number" || !Number.isFinite(obj.committedAtMs) || obj.committedAtMs <= 0) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Invalid manifest committedAtMs: ${String(obj.committedAtMs)}.`);
	const seenIndexes = /* @__PURE__ */ new Set();
	const validatedChunks = [];
	let sumBytes = 0;
	for (let i = 0; i < obj.chunks.length; i++) {
		const rawChunk = obj.chunks[i];
		if (!rawChunk || typeof rawChunk !== "object" || Array.isArray(rawChunk)) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk entry #${i} must be an object.`);
		const c = rawChunk;
		if (typeof c.index !== "number" || !Number.isSafeInteger(c.index)) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk entry #${i} has invalid index: ${String(c.index)}.`);
		if (seenIndexes.has(c.index)) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Duplicate chunk index ${c.index} in manifest.`);
		if (c.index !== i) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Out-of-order or non-contiguous chunk index: expected ${i}, got ${c.index}.`);
		seenIndexes.add(c.index);
		if (typeof c.byteLength !== "number" || !Number.isSafeInteger(c.byteLength) || c.byteLength <= 0 || c.byteLength > 1048576) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk #${i} has invalid byteLength: ${String(c.byteLength)} (max ${MAX_MODEL_CHUNK_BYTES}).`);
		const isLast = i === obj.chunks.length - 1;
		if (!isLast && c.byteLength !== obj.chunkSizeBytes) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Non-final chunk #${i} byteLength (${c.byteLength}) must equal chunkSizeBytes (${obj.chunkSizeBytes}).`);
		if (isLast && c.byteLength > obj.chunkSizeBytes) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Final chunk #${i} byteLength (${c.byteLength}) exceeds chunkSizeBytes (${obj.chunkSizeBytes}).`);
		if (typeof c.sha256Hex !== "string" || !SHA256_HEX_PATTERN.test(c.sha256Hex.toLowerCase())) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk #${i} sha256Hex must be a valid 64-character hex SHA-256 digest.`);
		sumBytes += c.byteLength;
		validatedChunks.push({
			index: c.index,
			byteLength: c.byteLength,
			sha256Hex: c.sha256Hex.toLowerCase()
		});
	}
	if (sumBytes !== obj.totalBytes) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Manifest totalBytes (${obj.totalBytes}) does not equal sum of chunk lengths (${sumBytes}).`);
	const expectedChunkCount = Math.ceil(obj.totalBytes / obj.chunkSizeBytes);
	if (obj.chunkCount !== expectedChunkCount) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Manifest chunkCount (${obj.chunkCount}) does not match expected ${expectedChunkCount} for totalBytes=${obj.totalBytes} and chunkSizeBytes=${obj.chunkSizeBytes}.`);
	return {
		schemaVersion: 1,
		modelId,
		version,
		generationId,
		architecture: obj.architecture,
		storageBackend: "OPFS",
		storageDirectory,
		fileName: obj.fileName,
		totalBytes: obj.totalBytes,
		chunkSizeBytes: obj.chunkSizeBytes,
		chunkCount: validatedChunks.length,
		sha256Hex: obj.sha256Hex.toLowerCase(),
		chunks: validatedChunks,
		committedAtMs: obj.committedAtMs
	};
}
// src/ai-engine/asr/WebWorkerOrtRuntimeProvider.ts
const SHA256_HEX_RE$1 = /^[a-f0-9]{64}$/;
function isNotFoundError(err) {
	if (!err || typeof err !== "object") return false;
	const name = err.name;
	const msg = err.message;
	return name === "NotFoundError" || typeof msg === "string" && /not\s*found|ENOENT/i.test(msg);
}
/**
* Section 114 / AVP-MODEL-OPFS-DURABILITY-008:
* Browser Web Worker onnxruntime-web Provider & Verified Single-Allocation OPFS Chunk Assembler
*/
var WebWorkerOrtRuntimeProvider = class {
	constructor(wasmAssetsBasePath = "/ort/", customOrtWebBinding, crossOriginIsolatedOverride) {
		this.wasmAssetsBasePath = wasmAssetsBasePath;
		this.customOrtWebBinding = customOrtWebBinding;
		const isIsolated = crossOriginIsolatedOverride ?? (typeof self !== "undefined" && Boolean(self.crossOriginIsolated));
		const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
		this.configuredNumThreads = isIsolated ? Math.min(4, Math.max(1, cores - 1)) : 1;
		if (this.customOrtWebBinding) {
			this.customOrtWebBinding.env.wasm.wasmPaths = this.wasmAssetsBasePath;
			this.customOrtWebBinding.env.wasm.simd = true;
			this.customOrtWebBinding.env.wasm.numThreads = this.configuredNumThreads;
		}
	}
	createTensor(type, data, dims) {
		if (this.customOrtWebBinding) return new this.customOrtWebBinding.Tensor(type, data, dims);
		return {
			type,
			data,
			dims: [...dims]
		};
	}
	async createSession(modelBytesOrPath, executionProviders) {
		const webProviders = executionProviders.map((p) => p === "cpu" || p === "cuda" ? "wasm" : p).filter((v, i, arr) => arr.indexOf(v) === i);
		const providersToTry = webProviders.length > 0 ? webProviders : ["wasm"];
		const ortBinding = this.customOrtWebBinding ?? await this.loadDynamicOrtWeb();
		try {
			return await ortBinding.InferenceSession.create(modelBytesOrPath, {
				executionProviders: providersToTry,
				graphOptimizationLevel: "all"
			});
		} catch (err) {
			if (providersToTry.includes("webgpu")) return await ortBinding.InferenceSession.create(modelBytesOrPath, {
				executionProviders: ["wasm"],
				graphOptimizationLevel: "all"
			});
			throw err;
		}
	}
	async loadDynamicOrtWeb() {
		const ort = await import("./ort.bundle.min-DT2luF-K.js");
		ort.env.wasm.wasmPaths = this.wasmAssetsBasePath;
		ort.env.wasm.simd = true;
		ort.env.wasm.numThreads = this.configuredNumThreads;
		return ort;
	}
	/**
	* Assembles verified model chunks from `OPFS/ai-models/{storageDirectory}` into a single
	* pre-allocated Uint8Array after explicit `MemoryBudgetManager` admission, verifying:
	* - Path segment safety (`modelId`, `version`, `storageDirectory`)
	* - Committed `manifest.json` identity (when present in the artifact directory)
	* - Contiguous chunk indices and exact byte lengths
	* - Per-chunk SHA-256 integrity
	* - Complete-artifact SHA-256 integrity
	*
	* Never falls back to an unrecognized model directory.
	*/
	static async assembleModelBytesFromOpfsChunks(manifest, opfsRootOverride, options) {
		if (options?.signal?.aborted) throw new Error("OPFS_MODEL_ASSEMBLY_ABORTED");
		const safeModelId = validateModelPathSegment(manifest.modelId, "modelId");
		const safeVersion = validateModelPathSegment(manifest.version, "version");
		const targetDirName = validateModelPathSegment(manifest.storageDirectory ?? `${safeModelId}_${safeVersion}`, "storageDirectory");
		if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes <= 0 || !Array.isArray(manifest.chunks) || manifest.chunks.length === 0) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Invalid ChunkedModelManifest for "${targetDirName}": totalBytes or chunks invalid.`);
		let declaredSum = 0;
		for (let i = 0; i < manifest.chunks.length; i++) {
			const c = manifest.chunks[i];
			if (c.index !== i) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk manifest for "${targetDirName}" has out-of-order or non-contiguous index ${c.index} (expected ${i}).`);
			if (!Number.isSafeInteger(c.byteLength) || c.byteLength <= 0) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk #${i} in "${targetDirName}" has invalid byteLength ${c.byteLength}.`);
			if (typeof c.sha256Hex !== "string" || !SHA256_HEX_RE$1.test(c.sha256Hex.toLowerCase())) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk #${i} in "${targetDirName}" is missing a valid 64-hex SHA-256 digest.`);
			declaredSum += c.byteLength;
		}
		if (declaredSum !== manifest.totalBytes) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Chunk manifest byte sum (${declaredSum}) does not equal totalBytes (${manifest.totalBytes}).`);
		if (manifest.sha256Hex !== void 0 && !SHA256_HEX_RE$1.test(manifest.sha256Hex.toLowerCase())) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Manifest sha256Hex for "${targetDirName}" is not a valid 64-hex SHA-256 digest.`);
		const modelDir = await (await (opfsRootOverride ?? await navigator.storage.getDirectory()).getDirectoryHandle(MODEL_REPOSITORY_ROOT_DIR, { create: false })).getDirectoryHandle(targetDirName, { create: false });
		let storedManifest = null;
		try {
			const manifestFile = await (await modelDir.getFileHandle(MODEL_ARTIFACT_MANIFEST_FILE, { create: false })).getFile();
			storedManifest = validateStoredModelArtifactManifest(safeParseJsonWithGuards(typeof manifestFile.text === "function" ? await manifestFile.text() : new TextDecoder().decode(new Uint8Array(await manifestFile.arrayBuffer())), 4194304), targetDirName);
		} catch (err) {
			if (!isNotFoundError(err)) {
				if (err instanceof ModelRepositoryError) throw err;
				throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `Corrupted OPFS manifest.json in "${targetDirName}": ${err instanceof Error ? err.message : String(err)}`, err);
			}
		}
		if (storedManifest) {
			if (storedManifest.modelId !== safeModelId || storedManifest.version !== safeVersion || storedManifest.totalBytes !== manifest.totalBytes || storedManifest.chunkCount !== manifest.chunks.length || manifest.sha256Hex && storedManifest.sha256Hex !== manifest.sha256Hex.toLowerCase()) throw new ModelRepositoryError("MODEL_MANIFEST_INVALID", `OPFS stored manifest in "${targetDirName}" does not match requested model identity (${safeModelId}@${safeVersion}).`);
		}
		const budgetManager = options?.memoryBudgetManager ?? getSharedMemoryBudgetManager();
		const reservation = budgetManager.reserve({
			owner: `ort-model-assembly:${safeModelId}@${safeVersion}`,
			category: "model-runtime",
			bytes: manifest.totalBytes,
			priority: "normal"
		});
		let reservationTransferred = false;
		try {
			const assembled = new Uint8Array(manifest.totalBytes);
			const fullHasher = new IncrementalSha256();
			let writeOffset = 0;
			for (const chunk of manifest.chunks) {
				if (options?.signal?.aborted) throw new Error("OPFS_MODEL_ASSEMBLY_ABORTED");
				const fileName = formatModelChunkFileName(chunk.index);
				const file = await (await modelDir.getFileHandle(fileName, { create: false })).getFile();
				if (file.size !== chunk.byteLength) throw new ModelRepositoryError("MODEL_INTEGRITY_FAILURE", `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} size mismatch (${file.size} !== ${chunk.byteLength}).`);
				const chunkBuf = new Uint8Array(await file.arrayBuffer());
				if (chunkBuf.byteLength !== chunk.byteLength) throw new ModelRepositoryError("MODEL_INTEGRITY_FAILURE", `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} readback length mismatch (${chunkBuf.byteLength} !== ${chunk.byteLength}).`);
				const actualChunkSha = new IncrementalSha256().update(chunkBuf).digestHex();
				const expectedChunkSha = chunk.sha256Hex.toLowerCase();
				if (actualChunkSha !== expectedChunkSha) throw new ModelRepositoryError("MODEL_INTEGRITY_FAILURE", `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} SHA-256 mismatch (expected ${expectedChunkSha}, actual ${actualChunkSha}).`);
				if (storedManifest) {
					const manifestChunk = storedManifest.chunks[chunk.index];
					if (!manifestChunk || manifestChunk.sha256Hex !== actualChunkSha || manifestChunk.byteLength !== chunkBuf.byteLength) throw new ModelRepositoryError("MODEL_INTEGRITY_FAILURE", `OPFS_CHUNK_CORRUPTED: Chunk #${chunk.index} does not match committed manifest.json.`);
				}
				fullHasher.update(chunkBuf);
				assembled.set(chunkBuf, writeOffset);
				writeOffset += chunk.byteLength;
			}
			if (writeOffset !== manifest.totalBytes) throw new ModelRepositoryError("MODEL_INTEGRITY_FAILURE", `OPFS_MODEL_INCOMPLETE: Assembled ${writeOffset} B != expected ${manifest.totalBytes} B.`);
			const expectedFullSha = (manifest.sha256Hex ?? storedManifest?.sha256Hex)?.toLowerCase();
			if (expectedFullSha) {
				const actualFullSha = fullHasher.digestHex();
				if (actualFullSha !== expectedFullSha) throw new ModelRepositoryError("MODEL_INTEGRITY_FAILURE", `OPFS_MODEL_HASH_MISMATCH: Complete model SHA-256 mismatch (expected ${expectedFullSha}, actual ${actualFullSha}).`);
			}
			if (options?.onReservation) {
				options.onReservation(reservation);
				reservationTransferred = true;
			}
			return assembled;
		} finally {
			if (!reservationTransferred) budgetManager.release(reservation);
		}
	}
};
// src/ai-engine/workers/studio-asr.worker.ts
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
var StudioAsrWorkerRuntimeHost = class {
	constructor(options) {
		this.options = options;
		this.engine = null;
		this.activeModelSha256 = null;
		this.activeReservations = [];
		this.activeJobAborts = /* @__PURE__ */ new Map();
		this.disposed = false;
	}
	releaseModelReservations() {
		const budget = this.options?.budgetManager ?? getSharedMemoryBudgetManager();
		for (const res of this.activeReservations) budget.release(res);
		this.activeReservations = [];
	}
	async handleMessage(msg) {
		if (!msg || typeof msg !== "object" || typeof msg.requestId !== "string" || msg.requestId.trim().length === 0 || msg.requestId.length > 128 || typeof msg.jobId !== "string" || msg.jobId.trim().length === 0 || msg.jobId.length > 128 || typeof msg.command !== "string") return {
			requestId: typeof msg?.requestId === "string" ? msg.requestId : "invalid",
			jobId: typeof msg?.jobId === "string" ? msg.jobId : "invalid",
			ok: false,
			command: typeof msg?.command === "string" ? msg.command : "DISPOSE",
			errorCode: "INVALID_PROCESSING_REQUEST",
			message: "Worker message failed strict schema validation (requestId, jobId, command required)."
		};
		if (this.disposed && msg.command !== "DISPOSE") return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: msg.command,
			errorCode: "LOCAL_RUNTIME_UNAVAILABLE",
			message: "Studio ASR worker has been disposed."
		};
		try {
			switch (msg.command) {
				case "INITIALIZE_MODEL": return await this.handleInitialize(msg);
				case "DETECT_VAD": return await this.handleDetectVad(msg);
				case "TRANSCRIBE_WINDOW": return await this.handleTranscribeWindow(msg);
				case "UNLOAD_MODEL": return await this.handleUnload(msg);
				case "CANCEL_JOB": return this.handleCancelJob(msg);
				case "DISPOSE": return await this.handleDispose(msg);
				default: return {
					requestId: msg.requestId,
					jobId: msg.jobId,
					ok: false,
					command: msg.command,
					errorCode: "INVALID_PROCESSING_REQUEST",
					message: `Unknown worker command: ${String(msg.command)}`
				};
			}
		} catch (err) {
			const rawMessage = err instanceof Error ? err.message : String(err);
			const errorCode = this.classifyWorkerError(rawMessage, err);
			return {
				requestId: msg.requestId,
				jobId: msg.jobId,
				ok: false,
				command: msg.command,
				errorCode,
				message: rawMessage
			};
		}
	}
	classifyWorkerError(rawMessage, err) {
		if (err && typeof err === "object" && typeof err.code === "string") {
			const code = err.code;
			if (code === "MODEL_INTEGRITY_FAILURE" || code === "MODEL_MANIFEST_INVALID" || code === "MODEL_REGISTRY_CORRUPTED") return "LOCAL_MODEL_INTEGRITY_FAILURE";
			if (code === "MODEL_STORAGE_UNAVAILABLE") return "LOCAL_RUNTIME_UNAVAILABLE";
		}
		if (/ABORTED|CANCELLED/i.test(rawMessage)) return "PROCESSING_CANCELLED";
		if (/INTEGRITY|SHA-256|HASH_MISMATCH|CORRUPTED|MANIFEST/i.test(rawMessage)) return "LOCAL_MODEL_INTEGRITY_FAILURE";
		if (/ARCHITECTURE_UNSUPPORTED|UNSUPPORTED_ARCHITECTURE|VOCAB|DECODER_MISSING/i.test(rawMessage)) return "LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED";
		if (/NOT_LOADED|NOT_READY/i.test(rawMessage)) return "LOCAL_MODEL_NOT_READY";
		if (/MEMORY_BUDGET|QUOTA|OUT_OF_MEMORY/i.test(rawMessage)) return "PROCESSING_RESOURCE_LIMIT_EXCEEDED";
		if (/onnxruntime-web|WASM|RUNTIME_UNAVAILABLE|Cannot find module/i.test(rawMessage)) return "LOCAL_RUNTIME_UNAVAILABLE";
		return "PROCESSING_FAILED";
	}
	async handleInitialize(msg) {
		const payload = msg.initPayload;
		if (!payload) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "INITIALIZE_MODEL",
			errorCode: "INVALID_PROCESSING_REQUEST",
			message: "INITIALIZE_MODEL requires initPayload."
		};
		if (payload.architecture !== "FASTCONFORMER_CTC" && payload.architecture !== "WHISPER_SEQ2SEQ") return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "INITIALIZE_MODEL",
			errorCode: "LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED",
			message: `Unsupported ONNX ASR architecture: ${String(payload.architecture)}`
		};
		const expectedSha = payload.expectedSha256Hex.trim().toLowerCase();
		if (!SHA256_HEX_RE.test(expectedSha)) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "INITIALIZE_MODEL",
			errorCode: "LOCAL_MODEL_INTEGRITY_FAILURE",
			message: "Model expectedSha256Hex must be a valid 64-hex SHA-256 digest."
		};
		if (payload.chunkedManifest.modelId !== payload.modelId || payload.chunkedManifest.version !== payload.modelVersion) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "INITIALIZE_MODEL",
			errorCode: "LOCAL_MODEL_INTEGRITY_FAILURE",
			message: "Chunked manifest modelId/version does not match requested model identity."
		};
		if (payload.architecture === "FASTCONFORMER_CTC" && (!Array.isArray(payload.ctcVocabulary) || payload.ctcVocabulary.length === 0)) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "INITIALIZE_MODEL",
			errorCode: "LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED",
			message: "FASTCONFORMER_CTC requires a non-empty ctcVocabulary configuration."
		};
		if (payload.architecture === "WHISPER_SEQ2SEQ") {
			if (!payload.decoderChunkedManifest || !Array.isArray(payload.whisperIdToBpeTokenEntries) || payload.whisperIdToBpeTokenEntries.length === 0 || !payload.whisperSpecialTokens) return {
				requestId: msg.requestId,
				jobId: msg.jobId,
				ok: false,
				command: "INITIALIZE_MODEL",
				errorCode: "LOCAL_MODEL_ARCHITECTURE_UNSUPPORTED",
				message: "WHISPER_SEQ2SEQ requires decoderChunkedManifest, whisperIdToBpeTokenEntries, and whisperSpecialTokens."
			};
		}
		await this.unloadCurrentModel();
		const abortCtrl = new AbortController();
		this.activeJobAborts.set(msg.jobId, abortCtrl);
		const budget = this.options?.budgetManager ?? getSharedMemoryBudgetManager();
		try {
			let encoderBytes;
			if (payload.directEncoderBytes instanceof Uint8Array && payload.directEncoderBytes.byteLength > 0) {
				const digestBuf = await crypto.subtle.digest("SHA-256", payload.directEncoderBytes.buffer.slice(payload.directEncoderBytes.byteOffset, payload.directEncoderBytes.byteOffset + payload.directEncoderBytes.byteLength));
				const actualHex = Array.from(new Uint8Array(digestBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
				if (actualHex !== expectedSha) throw new Error(`MODEL_INTEGRITY_FAILURE: Direct encoder SHA-256 mismatch (expected ${expectedSha}, actual ${actualHex}).`);
				const reservation = budget.reserve({
					owner: `studio-asr-worker:direct:${payload.modelId}`,
					category: "model-runtime",
					bytes: payload.directEncoderBytes.byteLength,
					priority: "protected"
				});
				this.activeReservations.push(reservation);
				encoderBytes = payload.directEncoderBytes;
			} else encoderBytes = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks({
				...payload.chunkedManifest,
				sha256Hex: expectedSha
			}, this.options?.opfsRootOverride, {
				memoryBudgetManager: budget,
				signal: abortCtrl.signal,
				onReservation: (reservation) => {
					this.activeReservations.push(reservation);
				}
			});
			let decoderBytes;
			if (payload.architecture === "WHISPER_SEQ2SEQ" && payload.decoderChunkedManifest) {
				if (payload.directDecoderBytes instanceof Uint8Array && payload.directDecoderBytes.byteLength > 0) decoderBytes = payload.directDecoderBytes;
				else decoderBytes = await WebWorkerOrtRuntimeProvider.assembleModelBytesFromOpfsChunks(payload.decoderChunkedManifest, this.options?.opfsRootOverride, {
					memoryBudgetManager: budget,
					signal: abortCtrl.signal,
					onReservation: (reservation) => {
						this.activeReservations.push(reservation);
					}
				});
			}
			if (abortCtrl.signal.aborted) throw new Error("ASR_INITIALIZE_ABORTED");
			const ortProvider = this.options?.ortProviderFactory ? this.options.ortProviderFactory(payload.wasmAssetsBasePath) : new WebWorkerOrtRuntimeProvider(payload.wasmAssetsBasePath ?? "/ort/");
			const whisperMap = payload.whisperIdToBpeTokenEntries ? new Map(payload.whisperIdToBpeTokenEntries) : void 0;
			const engine = new UnifiedOnnxPersianAsrEngine(ortProvider, payload.architecture, {
				modelId: payload.modelId,
				modelVersion: payload.modelVersion,
				ctcVocabulary: payload.ctcVocabulary,
				whisperIdToBpeToken: whisperMap,
				whisperSpecialTokens: payload.whisperSpecialTokens
			});
			await engine.loadModels({
				encoderModelBytesOrPath: encoderBytes,
				decoderModelBytesOrPath: decoderBytes,
				executionProviders: payload.executionProviders.length > 0 ? [...payload.executionProviders] : ["wasm"]
			});
			if (!engine.isReady()) {
				await engine.unloadModels();
				throw new Error("LOCAL_MODEL_NOT_READY: ONNX session or decoder configuration incomplete.");
			}
			this.engine = engine;
			this.activeModelSha256 = expectedSha;
			return {
				requestId: msg.requestId,
				jobId: msg.jobId,
				ok: true,
				command: "INITIALIZE_MODEL",
				modelReadiness: {
					modelId: engine.modelId,
					modelVersion: engine.modelVersion,
					modelSha256: expectedSha,
					architecture: engine.architecture,
					ready: true
				}
			};
		} catch (err) {
			await this.unloadCurrentModel();
			throw err;
		} finally {
			this.activeJobAborts.delete(msg.jobId);
		}
	}
	async handleDetectVad(msg) {
		if (!this.engine || !this.engine.isReady()) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "DETECT_VAD",
			errorCode: "LOCAL_MODEL_NOT_READY",
			message: "Local ONNX ASR engine is not initialized."
		};
		if (!msg.pcm16kBuffer) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "DETECT_VAD",
			errorCode: "INVALID_PROCESSING_REQUEST",
			message: "DETECT_VAD requires pcm16kBuffer."
		};
		const sampleCount = typeof msg.pcm16kLength === "number" && msg.pcm16kLength >= 0 ? Math.min(msg.pcm16kLength, Math.floor(msg.pcm16kBuffer.byteLength / 4)) : Math.floor(msg.pcm16kBuffer.byteLength / 4);
		const pcm = new Float32Array(msg.pcm16kBuffer, 0, sampleCount);
		const vad = await this.engine.detectVoiceActivity(pcm);
		return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: true,
			command: "DETECT_VAD",
			vad
		};
	}
	async handleTranscribeWindow(msg) {
		if (!this.engine || !this.engine.isReady()) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "TRANSCRIBE_WINDOW",
			errorCode: "LOCAL_MODEL_NOT_READY",
			message: "Local ONNX ASR engine is not initialized."
		};
		if (!msg.pcm16kBuffer || !(msg.pcm16kBuffer instanceof ArrayBuffer) || msg.pcm16kBuffer.byteLength > 33554432) return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: false,
			command: "TRANSCRIBE_WINDOW",
			errorCode: "INVALID_PROCESSING_REQUEST",
			message: "TRANSCRIBE_WINDOW requires a valid pcm16kBuffer (<= 32 MiB)."
		};
		const abortCtrl = new AbortController();
		this.activeJobAborts.set(msg.jobId, abortCtrl);
		try {
			const sampleCount = typeof msg.pcm16kLength === "number" && Number.isFinite(msg.pcm16kLength) && msg.pcm16kLength >= 0 ? Math.min(Math.floor(msg.pcm16kLength), Math.floor(msg.pcm16kBuffer.byteLength / 4)) : Math.floor(msg.pcm16kBuffer.byteLength / 4);
			const pcm = new Float32Array(msg.pcm16kBuffer, 0, sampleCount);
			const words = await this.engine.transcribeWindow(pcm);
			if (abortCtrl.signal.aborted) return {
				requestId: msg.requestId,
				jobId: msg.jobId,
				ok: false,
				command: "TRANSCRIBE_WINDOW",
				errorCode: "PROCESSING_CANCELLED",
				message: "Window inference cancelled."
			};
			return {
				requestId: msg.requestId,
				jobId: msg.jobId,
				ok: true,
				command: "TRANSCRIBE_WINDOW",
				words
			};
		} finally {
			this.activeJobAborts.delete(msg.jobId);
		}
	}
	async unloadCurrentModel() {
		if (this.engine) try {
			await this.engine.unloadModels();
		} finally {
			this.engine = null;
			this.activeModelSha256 = null;
		}
		this.releaseModelReservations();
	}
	async handleUnload(msg) {
		await this.unloadCurrentModel();
		return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: true,
			command: "UNLOAD_MODEL"
		};
	}
	handleCancelJob(msg) {
		const ctrl = this.activeJobAborts.get(msg.jobId);
		if (ctrl) {
			ctrl.abort();
			this.activeJobAborts.delete(msg.jobId);
		}
		return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: true,
			command: "CANCEL_JOB"
		};
	}
	async handleDispose(msg) {
		this.disposed = true;
		for (const ctrl of this.activeJobAborts.values()) ctrl.abort();
		this.activeJobAborts.clear();
		await this.unloadCurrentModel();
		return {
			requestId: msg.requestId,
			jobId: msg.jobId,
			ok: true,
			command: "DISPOSE"
		};
	}
	getActiveModelSha256() {
		return this.activeModelSha256;
	}
};
const workerGlobal = typeof self !== "undefined" ? self : null;
if (workerGlobal && typeof workerGlobal.postMessage === "function" && typeof globalThis.window === "undefined") {
	const host = new StudioAsrWorkerRuntimeHost();
	workerGlobal.onmessage = (event) => {
		const data = event.data;
		if (!data || typeof data.requestId !== "string" || typeof data.command !== "string") return;
		host.handleMessage(data).then((response) => {
			workerGlobal.postMessage(response);
		});
	};
}
