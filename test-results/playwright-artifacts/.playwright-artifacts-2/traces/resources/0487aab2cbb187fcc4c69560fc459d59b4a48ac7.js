import { flicksToSamples, msToFlicks, samplesToFlicks } from "/src/engine/timebase.ts";
/**
* Group A DSP & Persian Acoustic/Prosodic Boundary Engine (v1.2)
* Operates at zero-second Cold Start without requiring heavy ASR models.
*/
export function extractAcousticProfile(assetId, samples, sampleRate) {
	const frameLen = Math.max(1, Math.round(sampleRate * .02));
	const frameRmsList = [];
	for (let i = 0; i + frameLen <= samples.length; i += frameLen) {
		let sumSq = 0;
		for (let j = 0; j < frameLen; j++) {
			const s = samples[i + j];
			sumSq += s * s;
		}
		frameRmsList.push({
			idx: i,
			rms: Math.sqrt(sumSq / frameLen)
		});
	}
	if (frameRmsList.length === 0) {
		return {
			assetId,
			noiseFloorDbfs: -60,
			roomToneRms: .001,
			roomToneSample: new Float32Array(Math.round(sampleRate * .5)),
			sampleRate
		};
	}
	// Noise floor is estimated from the 10th percentile quietest frames across the full signal
	// (including digital-zero pauses so gated/synthetic silence is not ignored in favor of speech).
	const sorted = [...frameRmsList].sort((a, b) => a.rms - b.rms);
	const p10All = sorted[Math.floor(sorted.length * .1)];
	const nonZero = sorted.filter((f) => f.rms > 1e-6);
	let roomToneRms;
	if (p10All.rms <= 1e-6) {
		roomToneRms = 5e-4;
	} else {
		const targetPool = nonZero.length > 0 ? nonZero : sorted;
		const p10 = targetPool[Math.floor(targetPool.length * .1)];
		roomToneRms = Math.max(p10.rms, 5e-4);
	}
	const noiseFloorDbfs = 20 * Math.log10(Math.max(roomToneRms, 1e-6));
	// Extract up to 0.5 seconds of quiet room tone without leaking active speech into roomToneSample
	const desiredLen = Math.round(sampleRate * .5);
	const roomToneSample = new Float32Array(desiredLen);
	const quietPool = nonZero.filter((f) => f.rms <= Math.max(roomToneRms * 3, .015));
	const quietFrames = quietPool.slice(0, Math.min(25, quietPool.length));
	let writeOffset = 0;
	let frameCursor = 0;
	while (writeOffset < desiredLen && quietFrames.length > 0) {
		const srcStart = quietFrames[frameCursor % quietFrames.length].idx;
		const copyLen = Math.min(frameLen, desiredLen - writeOffset, samples.length - srcStart);
		for (let k = 0; k < copyLen; k++) {
			roomToneSample[writeOffset + k] = samples[srcStart + k];
		}
		writeOffset += copyLen;
		frameCursor++;
	}
	return {
		assetId,
		noiseFloorDbfs,
		roomToneRms,
		roomToneSample,
		sampleRate
	};
}
/** Synthesizes natural Room Tone fill of targetLength samples with phase-continuous ping-pong wrapping */
export function synthesizeRoomToneFill(profile, targetLength, startOffsetSamples = 0) {
	const out = new Float32Array(targetLength);
	const src = profile.roomToneSample;
	if (src.length === 0) return out;
	const cycle = src.length * 2;
	const baseOffset = (Math.trunc(startOffsetSamples) % cycle + cycle) % cycle;
	for (let i = 0; i < targetLength; i++) {
		// Ping-pong wrap prevents discontinuity clicks when looping short room-tone samples
		const pos = (baseOffset + i) % cycle;
		const idx = pos < src.length ? pos : cycle - pos - 1;
		out[i] = src[idx];
	}
	return out;
}
/** Searches ±searchWindowMs around candidateSample for the Minimum RMS Energy Valley */
export function findMinimumRmsValley(samples, sampleRate, candidateSample, searchWindowMs = 35) {
	const halfSearch = Math.round(sampleRate * searchWindowMs / 1e3);
	const rmsWin = Math.max(16, Math.round(sampleRate * .008));
	const minCenter = Math.max(rmsWin, candidateSample - halfSearch);
	const maxCenter = Math.min(samples.length - rmsWin - 1, candidateSample + halfSearch);
	if (minCenter >= maxCenter) {
		return Math.max(0, Math.min(samples.length - 1, candidateSample));
	}
	let bestIdx = candidateSample;
	let bestEnergy = Number.POSITIVE_INFINITY;
	const step = Math.max(1, Math.round(sampleRate * .001));
	for (let c = minCenter; c <= maxCenter; c += step) {
		let sumSq = 0;
		const halfW = Math.floor(rmsWin / 2);
		for (let k = c - halfW; k < c + halfW; k++) {
			const s = samples[k];
			sumSq += s * s;
		}
		if (sumSq < bestEnergy) {
			bestEnergy = sumSq;
			bestIdx = c;
		}
	}
	return bestIdx;
}
/** Snaps sample index to nearest positive-going zero crossing within ±maxShiftSamples */
export function snapToZeroCrossing(samples, sampleIdx, maxShiftSamples = 240) {
	if (samples.length === 0) {
		return {
			index: 0,
			adjusted: false
		};
	}
	if (samples.length < 3) {
		return {
			index: Math.max(0, Math.min(samples.length - 1, Math.round(sampleIdx))),
			adjusted: false
		};
	}
	const clamped = Math.max(1, Math.min(samples.length - 2, Math.round(sampleIdx)));
	if (Math.abs(samples[clamped]) < 1e-5) {
		return {
			index: clamped,
			adjusted: false
		};
	}
	for (let delta = 0; delta <= maxShiftSamples; delta++) {
		const right = clamped + delta;
		if (right < samples.length - 1) {
			if (samples[right] <= 0 && samples[right + 1] > 0 || samples[right] >= 0 && samples[right + 1] < 0) {
				return {
					index: right,
					adjusted: delta > 0
				};
			}
		}
		const left = clamped - delta;
		if (left > 0) {
			if (samples[left] <= 0 && samples[left + 1] > 0 || samples[left] >= 0 && samples[left + 1] < 0) {
				return {
					index: left,
					adjusted: delta > 0
				};
			}
		}
	}
	return {
		index: clamped,
		adjusted: false
	};
}
/**
* Equal-Power Micro-Crossfade (5-15ms cosine/sine curve) between leftTail and rightHead.
* Eliminates splice clicks while maintaining constant perceived power (cos^2 + sin^2 = 1).
*/
export function applyEqualPowerMicroCrossfade(leftTail, rightHead) {
	const len = Math.min(leftTail.length, rightHead.length);
	const out = new Float32Array(len);
	if (len === 0) return out;
	if (len === 1) {
		out[0] = (leftTail[0] + rightHead[0]) * .5;
		return out;
	}
	for (let i = 0; i < len; i++) {
		const t = i / (len - 1);
		const fadeOut = Math.cos(t * Math.PI * .5);
		const fadeIn = Math.sin(t * Math.PI * .5);
		out[i] = leftTail[i] * fadeOut + rightHead[i] * fadeIn;
	}
	return out;
}
/**
* Detects Pitch/Formant Plateau (sustained vowel stretch like «رفتیممممم» or «بههههه»)
* where no RMS silence valley exists because the vowel is continuously voiced.
* Uses short-time autocorrelation periodicity + RMS envelope flatness.
*/
export function detectPitchPlateauSegments(samples, sampleRate, minDurationMs = 260) {
	if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
		return [];
	}
	const frameLen = Math.max(2, Math.round(sampleRate * .03));
	const hopLen = Math.max(1, Math.round(sampleRate * .015));
	const minLag = Math.max(1, Math.floor(sampleRate / 320));
	const maxLag = Math.max(minLag, Math.floor(sampleRate / 75));
	const features = [];
	for (let pos = 0; pos + frameLen <= samples.length; pos += hopLen) {
		let sumSq = 0;
		for (let i = 0; i < frameLen; i++) {
			const s = samples[pos + i];
			sumSq += s * s;
		}
		const rms = Math.sqrt(sumSq / frameLen);
		if (rms < .015) {
			features.push({
				start: pos,
				rms,
				f0Hz: 0,
				periodicity: 0
			});
			continue;
		}
		let bestLag = minLag;
		let bestCorr = -1;
		for (let lag = minLag; lag <= maxLag && lag < frameLen; lag++) {
			let num = 0;
			let normA = 0;
			let normB = 0;
			for (let i = 0; i < frameLen - lag; i++) {
				const a = samples[pos + i];
				const b = samples[pos + i + lag];
				num += a * b;
				normA += a * a;
				normB += b * b;
			}
			const denom = Math.sqrt(normA * normB);
			const corr = denom > 1e-8 ? num / denom : 0;
			if (corr > bestCorr) {
				bestCorr = corr;
				bestLag = lag;
			}
		}
		features.push({
			start: pos,
			rms,
			f0Hz: bestCorr > .72 ? sampleRate / bestLag : 0,
			periodicity: bestCorr
		});
	}
	const results = [];
	const minFrames = Math.ceil(minDurationMs / 15);
	let runStart = -1;
	for (let i = 1; i < features.length; i++) {
		const prev = features[i - 1];
		const curr = features[i];
		const isStableVoiced = curr.periodicity > .78 && prev.periodicity > .78 && curr.f0Hz > 0 && prev.f0Hz > 0 && Math.abs(curr.f0Hz - prev.f0Hz) <= 6 && Math.abs(curr.rms - prev.rms) / Math.max(prev.rms, 1e-5) < .25;
		if (isStableVoiced) {
			if (runStart === -1) runStart = i - 1;
		} else {
			if (runStart !== -1 && i - runStart >= minFrames) {
				const avgF0 = features.slice(runStart, i).reduce((acc, f) => acc + f.f0Hz, 0) / (i - runStart);
				results.push({
					startSample: features[runStart].start,
					endSample: features[i - 1].start + frameLen,
					confidence: Math.min(.96, .74 + (i - runStart) * .015),
					f0Hz: Math.round(avgF0)
				});
			}
			runStart = -1;
		}
	}
	if (runStart !== -1 && features.length - runStart >= minFrames) {
		const avgF0 = features.slice(runStart).reduce((acc, f) => acc + f.f0Hz, 0) / (features.length - runStart);
		results.push({
			startSample: features[runStart].start,
			endSample: features[features.length - 1].start + frameLen,
			confidence: Math.min(.96, .74 + (features.length - runStart) * .015),
			f0Hz: Math.round(avgF0)
		});
	}
	return results;
}
/** Group A Silence/Pause detector based on adaptive noise floor */
export function detectLongPauses(samples, sampleRate, profile, minPauseMs = 650) {
	if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
		return [];
	}
	const frameLen = Math.max(1, Math.round(sampleRate * .025));
	const threshold = Math.max(profile.roomToneRms * 2.2, .008);
	const pauses = [];
	let silentStart = -1;
	for (let i = 0; i + frameLen <= samples.length; i += frameLen) {
		let sumSq = 0;
		for (let j = 0; j < frameLen; j++) {
			const s = samples[i + j];
			sumSq += s * s;
		}
		const rms = Math.sqrt(sumSq / frameLen);
		if (rms <= threshold) {
			if (silentStart === -1) silentStart = i;
		} else if (silentStart !== -1) {
			const durMs = (i - silentStart) * 1e3 / sampleRate;
			if (durMs >= minPauseMs) {
				pauses.push({
					startSample: silentStart,
					endSample: i,
					durationMs: Math.round(durMs)
				});
			}
			silentStart = -1;
		}
	}
	if (silentStart !== -1) {
		const durMs = (samples.length - silentStart) * 1e3 / sampleRate;
		if (durMs >= minPauseMs) {
			pauses.push({
				startSample: silentStart,
				endSample: samples.length,
				durationMs: Math.round(durMs)
			});
		}
	}
	return pauses;
}
/**
* Computes full Persian Acoustic & Prosodic Boundary Detail for a candidate cut range.
*/
export function refinePersianCutBoundary(samples, sampleRate, rawRange, options = {}) {
	const microCrossfadeMs = options.microCrossfadeMs ?? 10;
	if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
		const safeStart = Math.max(0, rawRange.startFlicks);
		const safeEnd = Math.max(safeStart, rawRange.endFlicks);
		return {
			rawRange,
			snappedRange: {
				startFlicks: safeStart,
				endFlicks: safeEnd
			},
			rmsValleyShiftMs: 0,
			zeroCrossingAdjusted: false,
			microCrossfadeMs,
			pitchPlateauDetected: Boolean(options.pitchPlateauDetected),
			trailingEzafeRisk: Boolean(options.trailingEzafeRisk),
			trailingEzafeWord: options.trailingEzafeWord,
			reasonFa: "تراز شده با مرز خام (بافر صوتی در دسترس نبود)"
		};
	}
	const rawStartSample = flicksToSamples(rawRange.startFlicks, sampleRate);
	const rawEndSample = flicksToSamples(rawRange.endFlicks, sampleRate);
	const valleyStart = options.pitchPlateauDetected ? rawStartSample : findMinimumRmsValley(samples, sampleRate, rawStartSample, 30);
	const valleyEnd = findMinimumRmsValley(samples, sampleRate, rawEndSample, 30);
	const zcStart = snapToZeroCrossing(samples, valleyStart);
	const zcEnd = snapToZeroCrossing(samples, valleyEnd);
	const minSpanSamples = Math.min(samples.length, Math.round(sampleRate * .04));
	const snappedStart = Math.max(0, Math.min(zcStart.index, zcEnd.index - minSpanSamples));
	const snappedEnd = Math.min(samples.length, Math.max(zcEnd.index, snappedStart + minSpanSamples));
	const shiftMs = Math.round((snappedStart - rawStartSample) * 1e3 / sampleRate);
	let reasonFa = "تراز شده با دره انرژی (Minimum RMS) و عبور از صفر (Zero-Crossing)";
	if (options.pitchPlateauDetected) {
		reasonFa = "تشخیص کشیدگی واکه (Pitch/Formant Plateau) بدون دره سکوت میانی + قفل عبور از صفر";
	}
	if (options.trailingEzafeRisk && options.trailingEzafeWord) {
		reasonFa = `هشدار دنباله کسره اضافه روی «${options.trailingEzafeWord}» — اعمال هم‌پوشانی نرم ${microCrossfadeMs}ms`;
	}
	return {
		rawRange,
		snappedRange: {
			startFlicks: samplesToFlicks(snappedStart, sampleRate),
			endFlicks: samplesToFlicks(snappedEnd, sampleRate)
		},
		rmsValleyShiftMs: shiftMs,
		zeroCrossingAdjusted: zcStart.adjusted || zcEnd.adjusted,
		microCrossfadeMs,
		pitchPlateauDetected: Boolean(options.pitchPlateauDetected),
		trailingEzafeRisk: Boolean(options.trailingEzafeRisk),
		trailingEzafeWord: options.trailingEzafeWord,
		reasonFa
	};
}
/** Detects Mic Bleed / Crosstalk where Track B carries attenuated bleed of active Track A */
export function detectCrosstalkBleed(primarySamples, secondarySamples, sampleRate, range) {
	const start = Math.max(0, flicksToSamples(range.startFlicks, sampleRate));
	const end = Math.min(primarySamples.length, secondarySamples.length, flicksToSamples(range.endFlicks, sampleRate));
	if (end <= start) return {
		isCrosstalk: false,
		bleedRatioDb: 0
	};
	let sumA = 0;
	let sumB = 0;
	for (let i = start; i < end; i++) {
		sumA += primarySamples[i] * primarySamples[i];
		sumB += secondarySamples[i] * secondarySamples[i];
	}
	const rmsA = Math.sqrt(sumA / (end - start));
	const rmsB = Math.sqrt(sumB / (end - start));
	const ratioDb = 20 * Math.log10(Math.max(rmsB, 1e-6) / Math.max(rmsA, 1e-6));
	// If primary track is speaking strongly and secondary track is 12dB..34dB quieter in exact window -> mic bleed
	const isCrosstalk = rmsA > .04 && ratioDb <= -12 && ratioDb >= -36;
	return {
		isCrosstalk,
		bleedRatioDb: Number(ratioDb.toFixed(1))
	};
}
export function clampMicroCrossfadeFlicks(ms) {
	return msToFlicks(Math.max(5, Math.min(15, ms)));
}

//# sourceMappingURL=data:application/json;base64,eyJtYXBwaW5ncyI6IkFBQ0EsU0FBUyxpQkFBaUIsWUFBWSx1QkFBdUI7Ozs7O0FBTzdELE9BQU8sU0FBUyx1QkFDZCxTQUNBLFNBQ0EsWUFDaUI7Q0FDakIsTUFBTSxXQUFXLEtBQUssSUFBSSxHQUFHLEtBQUssTUFBTSxhQUFhLEdBQUksQ0FBQztDQUMxRCxNQUFNLGVBQStDLENBQUM7Q0FFdEQsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLFlBQVksUUFBUSxRQUFRLEtBQUssVUFBVTtFQUM3RCxJQUFJLFFBQVE7RUFDWixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksVUFBVSxLQUFLO0dBQ2pDLE1BQU0sSUFBSSxRQUFRLElBQUk7R0FDdEIsU0FBUyxJQUFJO0VBQ2Y7RUFDQSxhQUFhLEtBQUs7R0FBRSxLQUFLO0dBQUcsS0FBSyxLQUFLLEtBQUssUUFBUSxRQUFRO0VBQUUsQ0FBQztDQUNoRTtDQUVBLElBQUksYUFBYSxXQUFXLEdBQUc7RUFDN0IsT0FBTztHQUNMO0dBQ0EsZ0JBQWdCLENBQUM7R0FDakIsYUFBYTtHQUNiLGdCQUFnQixJQUFJLGFBQWEsS0FBSyxNQUFNLGFBQWEsRUFBRyxDQUFDO0dBQzdEO0VBQ0Y7Q0FDRjs7O0NBSUEsTUFBTSxTQUFTLENBQUMsR0FBRyxZQUFZLENBQUMsQ0FBQyxNQUFNLEdBQUcsTUFBTSxFQUFFLE1BQU0sRUFBRSxHQUFHO0NBQzdELE1BQU0sU0FBUyxPQUFPLEtBQUssTUFBTSxPQUFPLFNBQVMsRUFBRztDQUNwRCxNQUFNLFVBQVUsT0FBTyxRQUFRLE1BQU0sRUFBRSxNQUFNLElBQUk7Q0FFakQsSUFBSTtDQUNKLElBQUksT0FBTyxPQUFPLE1BQU07RUFDdEIsY0FBYztDQUNoQixPQUFPO0VBQ0wsTUFBTSxhQUFhLFFBQVEsU0FBUyxJQUFJLFVBQVU7RUFDbEQsTUFBTSxNQUFNLFdBQVcsS0FBSyxNQUFNLFdBQVcsU0FBUyxFQUFHO0VBQ3pELGNBQWMsS0FBSyxJQUFJLElBQUksS0FBSyxJQUFNO0NBQ3hDO0NBQ0EsTUFBTSxpQkFBaUIsS0FBSyxLQUFLLE1BQU0sS0FBSyxJQUFJLGFBQWEsSUFBSSxDQUFDOztDQUdsRSxNQUFNLGFBQWEsS0FBSyxNQUFNLGFBQWEsRUFBRztDQUM5QyxNQUFNLGlCQUFpQixJQUFJLGFBQWEsVUFBVTtDQUNsRCxNQUFNLFlBQVksUUFBUSxRQUFRLE1BQU0sRUFBRSxPQUFPLEtBQUssSUFBSSxjQUFjLEdBQUcsSUFBSyxDQUFDO0NBQ2pGLE1BQU0sY0FBYyxVQUFVLE1BQU0sR0FBRyxLQUFLLElBQUksSUFBSSxVQUFVLE1BQU0sQ0FBQztDQUVyRSxJQUFJLGNBQWM7Q0FDbEIsSUFBSSxjQUFjO0NBQ2xCLE9BQU8sY0FBYyxjQUFjLFlBQVksU0FBUyxHQUFHO0VBQ3pELE1BQU0sV0FBVyxZQUFZLGNBQWMsWUFBWSxPQUFPLENBQUM7RUFDL0QsTUFBTSxVQUFVLEtBQUssSUFBSSxVQUFVLGFBQWEsYUFBYSxRQUFRLFNBQVMsUUFBUTtFQUN0RixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksU0FBUyxLQUFLO0dBQ2hDLGVBQWUsY0FBYyxLQUFLLFFBQVEsV0FBVztFQUN2RDtFQUNBLGVBQWU7RUFDZjtDQUNGO0NBRUEsT0FBTztFQUNMO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRjtBQUNGOztBQUdBLE9BQU8sU0FBUyx1QkFDZCxTQUNBLGNBQ0EscUJBQXFCLEdBQ1A7Q0FDZCxNQUFNLE1BQU0sSUFBSSxhQUFhLFlBQVk7Q0FDekMsTUFBTSxNQUFNLFFBQVE7Q0FDcEIsSUFBSSxJQUFJLFdBQVcsR0FBRyxPQUFPO0NBRTdCLE1BQU0sUUFBUSxJQUFJLFNBQVM7Q0FDM0IsTUFBTSxjQUFlLEtBQUssTUFBTSxrQkFBa0IsSUFBSSxRQUFTLFNBQVM7Q0FDeEUsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLGNBQWMsS0FBSzs7RUFFckMsTUFBTSxPQUFPLGFBQWEsS0FBSztFQUMvQixNQUFNLE1BQU0sTUFBTSxJQUFJLFNBQVMsTUFBTSxRQUFRLE1BQU07RUFDbkQsSUFBSSxLQUFLLElBQUk7Q0FDZjtDQUNBLE9BQU87QUFDVDs7QUFHQSxPQUFPLFNBQVMscUJBQ2QsU0FDQSxZQUNBLGlCQUNBLGlCQUFpQixJQUNUO0NBQ1IsTUFBTSxhQUFhLEtBQUssTUFBTyxhQUFhLGlCQUFrQixHQUFJO0NBQ2xFLE1BQU0sU0FBUyxLQUFLLElBQUksSUFBSSxLQUFLLE1BQU0sYUFBYSxJQUFLLENBQUM7Q0FDMUQsTUFBTSxZQUFZLEtBQUssSUFBSSxRQUFRLGtCQUFrQixVQUFVO0NBQy9ELE1BQU0sWUFBWSxLQUFLLElBQUksUUFBUSxTQUFTLFNBQVMsR0FBRyxrQkFBa0IsVUFBVTtDQUVwRixJQUFJLGFBQWEsV0FBVztFQUMxQixPQUFPLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxRQUFRLFNBQVMsR0FBRyxlQUFlLENBQUM7Q0FDbEU7Q0FFQSxJQUFJLFVBQVU7Q0FDZCxJQUFJLGFBQWEsT0FBTztDQUN4QixNQUFNLE9BQU8sS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNLGFBQWEsSUFBSyxDQUFDO0NBRXZELEtBQUssSUFBSSxJQUFJLFdBQVcsS0FBSyxXQUFXLEtBQUssTUFBTTtFQUNqRCxJQUFJLFFBQVE7RUFDWixNQUFNLFFBQVEsS0FBSyxNQUFNLFNBQVMsQ0FBQztFQUNuQyxLQUFLLElBQUksSUFBSSxJQUFJLE9BQU8sSUFBSSxJQUFJLE9BQU8sS0FBSztHQUMxQyxNQUFNLElBQUksUUFBUTtHQUNsQixTQUFTLElBQUk7RUFDZjtFQUNBLElBQUksUUFBUSxZQUFZO0dBQ3RCLGFBQWE7R0FDYixVQUFVO0VBQ1o7Q0FDRjtDQUVBLE9BQU87QUFDVDs7QUFHQSxPQUFPLFNBQVMsbUJBQ2QsU0FDQSxXQUNBLGtCQUFrQixLQUNvQjtDQUN0QyxJQUFJLFFBQVEsV0FBVyxHQUFHO0VBQ3hCLE9BQU87R0FBRSxPQUFPO0dBQUcsVUFBVTtFQUFNO0NBQ3JDO0NBQ0EsSUFBSSxRQUFRLFNBQVMsR0FBRztFQUN0QixPQUFPO0dBQ0wsT0FBTyxLQUFLLElBQUksR0FBRyxLQUFLLElBQUksUUFBUSxTQUFTLEdBQUcsS0FBSyxNQUFNLFNBQVMsQ0FBQyxDQUFDO0dBQ3RFLFVBQVU7RUFDWjtDQUNGO0NBQ0EsTUFBTSxVQUFVLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxRQUFRLFNBQVMsR0FBRyxLQUFLLE1BQU0sU0FBUyxDQUFDLENBQUM7Q0FDL0UsSUFBSSxLQUFLLElBQUksUUFBUSxRQUFRLElBQUksTUFBTTtFQUNyQyxPQUFPO0dBQUUsT0FBTztHQUFTLFVBQVU7RUFBTTtDQUMzQztDQUVBLEtBQUssSUFBSSxRQUFRLEdBQUcsU0FBUyxpQkFBaUIsU0FBUztFQUNyRCxNQUFNLFFBQVEsVUFBVTtFQUN4QixJQUFJLFFBQVEsUUFBUSxTQUFTLEdBQUc7R0FDOUIsSUFBSyxRQUFRLFVBQVUsS0FBSyxRQUFRLFFBQVEsS0FBSyxLQUFPLFFBQVEsVUFBVSxLQUFLLFFBQVEsUUFBUSxLQUFLLEdBQUk7SUFDdEcsT0FBTztLQUFFLE9BQU87S0FBTyxVQUFVLFFBQVE7SUFBRTtHQUM3QztFQUNGO0VBQ0EsTUFBTSxPQUFPLFVBQVU7RUFDdkIsSUFBSSxPQUFPLEdBQUc7R0FDWixJQUFLLFFBQVEsU0FBUyxLQUFLLFFBQVEsT0FBTyxLQUFLLEtBQU8sUUFBUSxTQUFTLEtBQUssUUFBUSxPQUFPLEtBQUssR0FBSTtJQUNsRyxPQUFPO0tBQUUsT0FBTztLQUFNLFVBQVUsUUFBUTtJQUFFO0dBQzVDO0VBQ0Y7Q0FDRjtDQUVBLE9BQU87RUFBRSxPQUFPO0VBQVMsVUFBVTtDQUFNO0FBQzNDOzs7OztBQU1BLE9BQU8sU0FBUyw4QkFDZCxVQUNBLFdBQ2M7Q0FDZCxNQUFNLE1BQU0sS0FBSyxJQUFJLFNBQVMsUUFBUSxVQUFVLE1BQU07Q0FDdEQsTUFBTSxNQUFNLElBQUksYUFBYSxHQUFHO0NBQ2hDLElBQUksUUFBUSxHQUFHLE9BQU87Q0FDdEIsSUFBSSxRQUFRLEdBQUc7RUFDYixJQUFJLE1BQU0sU0FBUyxLQUFLLFVBQVUsTUFBTTtFQUN4QyxPQUFPO0NBQ1Q7Q0FFQSxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxLQUFLO0VBQzVCLE1BQU0sSUFBSSxLQUFLLE1BQU07RUFDckIsTUFBTSxVQUFVLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBSyxFQUFHO0VBQzFDLE1BQU0sU0FBUyxLQUFLLElBQUksSUFBSSxLQUFLLEtBQUssRUFBRztFQUN6QyxJQUFJLEtBQUssU0FBUyxLQUFLLFVBQVUsVUFBVSxLQUFLO0NBQ2xEO0NBQ0EsT0FBTztBQUNUOzs7Ozs7QUFPQSxPQUFPLFNBQVMsMkJBQ2QsU0FDQSxZQUNBLGdCQUFnQixLQUNnRTtDQUNoRixJQUFJLFFBQVEsV0FBVyxLQUFLLENBQUMsT0FBTyxTQUFTLFVBQVUsS0FBSyxjQUFjLEdBQUc7RUFDM0UsT0FBTyxDQUFDO0NBQ1Y7Q0FDQSxNQUFNLFdBQVcsS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNLGFBQWEsR0FBSSxDQUFDO0NBQzFELE1BQU0sU0FBUyxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU0sYUFBYSxJQUFLLENBQUM7Q0FDekQsTUFBTSxTQUFTLEtBQUssSUFBSSxHQUFHLEtBQUssTUFBTSxhQUFhLEdBQUcsQ0FBQztDQUN2RCxNQUFNLFNBQVMsS0FBSyxJQUFJLFFBQVEsS0FBSyxNQUFNLGFBQWEsRUFBRSxDQUFDO0NBUzNELE1BQU0sV0FBMkIsQ0FBQztDQUVsQyxLQUFLLElBQUksTUFBTSxHQUFHLE1BQU0sWUFBWSxRQUFRLFFBQVEsT0FBTyxRQUFRO0VBQ2pFLElBQUksUUFBUTtFQUNaLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxVQUFVLEtBQUs7R0FDakMsTUFBTSxJQUFJLFFBQVEsTUFBTTtHQUN4QixTQUFTLElBQUk7RUFDZjtFQUNBLE1BQU0sTUFBTSxLQUFLLEtBQUssUUFBUSxRQUFRO0VBQ3RDLElBQUksTUFBTSxNQUFPO0dBQ2YsU0FBUyxLQUFLO0lBQUUsT0FBTztJQUFLO0lBQUssTUFBTTtJQUFHLGFBQWE7R0FBRSxDQUFDO0dBQzFEO0VBQ0Y7RUFFQSxJQUFJLFVBQVU7RUFDZCxJQUFJLFdBQVcsQ0FBQztFQUNoQixLQUFLLElBQUksTUFBTSxRQUFRLE9BQU8sVUFBVSxNQUFNLFVBQVUsT0FBTztHQUM3RCxJQUFJLE1BQU07R0FDVixJQUFJLFFBQVE7R0FDWixJQUFJLFFBQVE7R0FDWixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksV0FBVyxLQUFLLEtBQUs7SUFDdkMsTUFBTSxJQUFJLFFBQVEsTUFBTTtJQUN4QixNQUFNLElBQUksUUFBUSxNQUFNLElBQUk7SUFDNUIsT0FBTyxJQUFJO0lBQ1gsU0FBUyxJQUFJO0lBQ2IsU0FBUyxJQUFJO0dBQ2Y7R0FDQSxNQUFNLFFBQVEsS0FBSyxLQUFLLFFBQVEsS0FBSztHQUNyQyxNQUFNLE9BQU8sUUFBUSxPQUFPLE1BQU0sUUFBUTtHQUMxQyxJQUFJLE9BQU8sVUFBVTtJQUNuQixXQUFXO0lBQ1gsVUFBVTtHQUNaO0VBQ0Y7RUFFQSxTQUFTLEtBQUs7R0FDWixPQUFPO0dBQ1A7R0FDQSxNQUFNLFdBQVcsTUFBTyxhQUFhLFVBQVU7R0FDL0MsYUFBYTtFQUNmLENBQUM7Q0FDSDtDQUVBLE1BQU0sVUFBMEYsQ0FBQztDQUNqRyxNQUFNLFlBQVksS0FBSyxLQUFLLGdCQUFnQixFQUFFO0NBQzlDLElBQUksV0FBVyxDQUFDO0NBRWhCLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxTQUFTLFFBQVEsS0FBSztFQUN4QyxNQUFNLE9BQU8sU0FBUyxJQUFJO0VBQzFCLE1BQU0sT0FBTyxTQUFTO0VBQ3RCLE1BQU0saUJBQ0osS0FBSyxjQUFjLE9BQ25CLEtBQUssY0FBYyxPQUNuQixLQUFLLE9BQU8sS0FDWixLQUFLLE9BQU8sS0FDWixLQUFLLElBQUksS0FBSyxPQUFPLEtBQUssSUFBSSxLQUFLLEtBQ25DLEtBQUssSUFBSSxLQUFLLE1BQU0sS0FBSyxHQUFHLElBQUksS0FBSyxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUk7RUFFN0QsSUFBSSxnQkFBZ0I7R0FDbEIsSUFBSSxhQUFhLENBQUMsR0FBRyxXQUFXLElBQUk7RUFDdEMsT0FBTztHQUNMLElBQUksYUFBYSxDQUFDLEtBQUssSUFBSSxZQUFZLFdBQVc7SUFDaEQsTUFBTSxRQUNKLFNBQVMsTUFBTSxVQUFVLENBQUMsQ0FBQyxDQUFDLFFBQVEsS0FBSyxNQUFNLE1BQU0sRUFBRSxNQUFNLENBQUMsS0FBSyxJQUFJO0lBQ3pFLFFBQVEsS0FBSztLQUNYLGFBQWEsU0FBUyxTQUFTLENBQUM7S0FDaEMsV0FBVyxTQUFTLElBQUksRUFBRSxDQUFDLFFBQVE7S0FDbkMsWUFBWSxLQUFLLElBQUksS0FBTSxPQUFRLElBQUksWUFBWSxJQUFLO0tBQ3hELE1BQU0sS0FBSyxNQUFNLEtBQUs7SUFDeEIsQ0FBQztHQUNIO0dBQ0EsV0FBVyxDQUFDO0VBQ2Q7Q0FDRjtDQUVBLElBQUksYUFBYSxDQUFDLEtBQUssU0FBUyxTQUFTLFlBQVksV0FBVztFQUM5RCxNQUFNLFFBQ0osU0FBUyxNQUFNLFFBQVEsQ0FBQyxDQUFDLFFBQVEsS0FBSyxNQUFNLE1BQU0sRUFBRSxNQUFNLENBQUMsS0FDMUQsU0FBUyxTQUFTO0VBQ3JCLFFBQVEsS0FBSztHQUNYLGFBQWEsU0FBUyxTQUFTLENBQUM7R0FDaEMsV0FBVyxTQUFTLFNBQVMsU0FBUyxFQUFFLENBQUMsUUFBUTtHQUNqRCxZQUFZLEtBQUssSUFBSSxLQUFNLE9BQVEsU0FBUyxTQUFTLFlBQVksSUFBSztHQUN0RSxNQUFNLEtBQUssTUFBTSxLQUFLO0VBQ3hCLENBQUM7Q0FDSDtDQUVBLE9BQU87QUFDVDs7QUFHQSxPQUFPLFNBQVMsaUJBQ2QsU0FDQSxZQUNBLFNBQ0EsYUFBYSxLQUNxRDtDQUNsRSxJQUFJLFFBQVEsV0FBVyxLQUFLLENBQUMsT0FBTyxTQUFTLFVBQVUsS0FBSyxjQUFjLEdBQUc7RUFDM0UsT0FBTyxDQUFDO0NBQ1Y7Q0FDQSxNQUFNLFdBQVcsS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNLGFBQWEsSUFBSyxDQUFDO0NBQzNELE1BQU0sWUFBWSxLQUFLLElBQUksUUFBUSxjQUFjLEtBQUssSUFBSztDQUMzRCxNQUFNLFNBQTJFLENBQUM7Q0FFbEYsSUFBSSxjQUFjLENBQUM7Q0FDbkIsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLFlBQVksUUFBUSxRQUFRLEtBQUssVUFBVTtFQUM3RCxJQUFJLFFBQVE7RUFDWixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksVUFBVSxLQUFLO0dBQ2pDLE1BQU0sSUFBSSxRQUFRLElBQUk7R0FDdEIsU0FBUyxJQUFJO0VBQ2Y7RUFDQSxNQUFNLE1BQU0sS0FBSyxLQUFLLFFBQVEsUUFBUTtFQUN0QyxJQUFJLE9BQU8sV0FBVztHQUNwQixJQUFJLGdCQUFnQixDQUFDLEdBQUcsY0FBYztFQUN4QyxPQUFPLElBQUksZ0JBQWdCLENBQUMsR0FBRztHQUM3QixNQUFNLFNBQVUsSUFBSSxlQUFlLE1BQVE7R0FDM0MsSUFBSSxTQUFTLFlBQVk7SUFDdkIsT0FBTyxLQUFLO0tBQUUsYUFBYTtLQUFhLFdBQVc7S0FBRyxZQUFZLEtBQUssTUFBTSxLQUFLO0lBQUUsQ0FBQztHQUN2RjtHQUNBLGNBQWMsQ0FBQztFQUNqQjtDQUNGO0NBRUEsSUFBSSxnQkFBZ0IsQ0FBQyxHQUFHO0VBQ3RCLE1BQU0sU0FBVSxRQUFRLFNBQVMsZUFBZSxNQUFRO0VBQ3hELElBQUksU0FBUyxZQUFZO0dBQ3ZCLE9BQU8sS0FBSztJQUNWLGFBQWE7SUFDYixXQUFXLFFBQVE7SUFDbkIsWUFBWSxLQUFLLE1BQU0sS0FBSztHQUM5QixDQUFDO0VBQ0g7Q0FDRjtDQUVBLE9BQU87QUFDVDs7OztBQUtBLE9BQU8sU0FBUyx5QkFDZCxTQUNBLFlBQ0EsVUFDQSxVQUtJLENBQUMsR0FDbUI7Q0FDeEIsTUFBTSxtQkFBbUIsUUFBUSxvQkFBb0I7Q0FDckQsSUFBSSxRQUFRLFdBQVcsS0FBSyxDQUFDLE9BQU8sU0FBUyxVQUFVLEtBQUssY0FBYyxHQUFHO0VBQzNFLE1BQU0sWUFBWSxLQUFLLElBQUksR0FBRyxTQUFTLFdBQVc7RUFDbEQsTUFBTSxVQUFVLEtBQUssSUFBSSxXQUFXLFNBQVMsU0FBUztFQUN0RCxPQUFPO0dBQ0w7R0FDQSxjQUFjO0lBQUUsYUFBYTtJQUFXLFdBQVc7R0FBUTtHQUMzRCxrQkFBa0I7R0FDbEIsc0JBQXNCO0dBQ3RCO0dBQ0Esc0JBQXNCLFFBQVEsUUFBUSxvQkFBb0I7R0FDMUQsbUJBQW1CLFFBQVEsUUFBUSxpQkFBaUI7R0FDcEQsbUJBQW1CLFFBQVE7R0FDM0IsVUFBVTtFQUNaO0NBQ0Y7Q0FFQSxNQUFNLGlCQUFpQixnQkFBZ0IsU0FBUyxhQUFhLFVBQVU7Q0FDdkUsTUFBTSxlQUFlLGdCQUFnQixTQUFTLFdBQVcsVUFBVTtDQUVuRSxNQUFNLGNBQWMsUUFBUSx1QkFDeEIsaUJBQ0EscUJBQXFCLFNBQVMsWUFBWSxnQkFBZ0IsRUFBRTtDQUNoRSxNQUFNLFlBQVkscUJBQXFCLFNBQVMsWUFBWSxjQUFjLEVBQUU7Q0FFNUUsTUFBTSxVQUFVLG1CQUFtQixTQUFTLFdBQVc7Q0FDdkQsTUFBTSxRQUFRLG1CQUFtQixTQUFTLFNBQVM7Q0FFbkQsTUFBTSxpQkFBaUIsS0FBSyxJQUFJLFFBQVEsUUFBUSxLQUFLLE1BQU0sYUFBYSxHQUFJLENBQUM7Q0FDN0UsTUFBTSxlQUFlLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxRQUFRLE9BQU8sTUFBTSxRQUFRLGNBQWMsQ0FBQztDQUN0RixNQUFNLGFBQWEsS0FBSyxJQUN0QixRQUFRLFFBQ1IsS0FBSyxJQUFJLE1BQU0sT0FBTyxlQUFlLGNBQWMsQ0FDckQ7Q0FFQSxNQUFNLFVBQVUsS0FBSyxPQUFRLGVBQWUsa0JBQWtCLE1BQVEsVUFBVTtDQUVoRixJQUFJLFdBQVc7Q0FDZixJQUFJLFFBQVEsc0JBQXNCO0VBQ2hDLFdBQVc7Q0FDYjtDQUNBLElBQUksUUFBUSxxQkFBcUIsUUFBUSxtQkFBbUI7RUFDMUQsV0FBVyxnQ0FBZ0MsUUFBUSxrQkFBa0IsMEJBQTBCLGlCQUFpQjtDQUNsSDtDQUVBLE9BQU87RUFDTDtFQUNBLGNBQWM7R0FDWixhQUFhLGdCQUFnQixjQUFjLFVBQVU7R0FDckQsV0FBVyxnQkFBZ0IsWUFBWSxVQUFVO0VBQ25EO0VBQ0Esa0JBQWtCO0VBQ2xCLHNCQUFzQixRQUFRLFlBQVksTUFBTTtFQUNoRDtFQUNBLHNCQUFzQixRQUFRLFFBQVEsb0JBQW9CO0VBQzFELG1CQUFtQixRQUFRLFFBQVEsaUJBQWlCO0VBQ3BELG1CQUFtQixRQUFRO0VBQzNCO0NBQ0Y7QUFDRjs7QUFHQSxPQUFPLFNBQVMscUJBQ2QsZ0JBQ0Esa0JBQ0EsWUFDQSxPQUNnRDtDQUNoRCxNQUFNLFFBQVEsS0FBSyxJQUFJLEdBQUcsZ0JBQWdCLE1BQU0sYUFBYSxVQUFVLENBQUM7Q0FDeEUsTUFBTSxNQUFNLEtBQUssSUFBSSxlQUFlLFFBQVEsaUJBQWlCLFFBQVEsZ0JBQWdCLE1BQU0sV0FBVyxVQUFVLENBQUM7Q0FDakgsSUFBSSxPQUFPLE9BQU8sT0FBTztFQUFFLGFBQWE7RUFBTyxjQUFjO0NBQUU7Q0FFL0QsSUFBSSxPQUFPO0NBQ1gsSUFBSSxPQUFPO0NBQ1gsS0FBSyxJQUFJLElBQUksT0FBTyxJQUFJLEtBQUssS0FBSztFQUNoQyxRQUFRLGVBQWUsS0FBSyxlQUFlO0VBQzNDLFFBQVEsaUJBQWlCLEtBQUssaUJBQWlCO0NBQ2pEO0NBQ0EsTUFBTSxPQUFPLEtBQUssS0FBSyxRQUFRLE1BQU0sTUFBTTtDQUMzQyxNQUFNLE9BQU8sS0FBSyxLQUFLLFFBQVEsTUFBTSxNQUFNO0NBQzNDLE1BQU0sVUFBVSxLQUFLLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxJQUFJLElBQUksS0FBSyxJQUFJLE1BQU0sSUFBSSxDQUFDOztDQUczRSxNQUFNLGNBQWMsT0FBTyxPQUFRLFdBQVcsQ0FBQyxNQUFNLFdBQVcsQ0FBQztDQUNqRSxPQUFPO0VBQUU7RUFBYSxjQUFjLE9BQU8sUUFBUSxRQUFRLENBQUMsQ0FBQztDQUFFO0FBQ2pFO0FBRUEsT0FBTyxTQUFTLDBCQUEwQixJQUFvQjtDQUM1RCxPQUFPLFdBQVcsS0FBSyxJQUFJLEdBQUcsS0FBSyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUM7QUFDakQiLCJuYW1lcyI6W10sInNvdXJjZXMiOlsiZHNwLnRzIl0sInZlcnNpb24iOjMsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEFjb3VzdGljUHJvZmlsZSwgRmxpY2tSYW5nZSwgUHJvc29kaWNCb3VuZGFyeURldGFpbCB9IGZyb20gJy4uL2NvbnRyYWN0cy92MV8yJztcbmltcG9ydCB7IGZsaWNrc1RvU2FtcGxlcywgbXNUb0ZsaWNrcywgc2FtcGxlc1RvRmxpY2tzIH0gZnJvbSAnLi90aW1lYmFzZSc7XG5cbi8qKlxuICogR3JvdXAgQSBEU1AgJiBQZXJzaWFuIEFjb3VzdGljL1Byb3NvZGljIEJvdW5kYXJ5IEVuZ2luZSAodjEuMilcbiAqIE9wZXJhdGVzIGF0IHplcm8tc2Vjb25kIENvbGQgU3RhcnQgd2l0aG91dCByZXF1aXJpbmcgaGVhdnkgQVNSIG1vZGVscy5cbiAqL1xuXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEFjb3VzdGljUHJvZmlsZShcbiAgYXNzZXRJZDogc3RyaW5nLFxuICBzYW1wbGVzOiBGbG9hdDMyQXJyYXksXG4gIHNhbXBsZVJhdGU6IG51bWJlcixcbik6IEFjb3VzdGljUHJvZmlsZSB7XG4gIGNvbnN0IGZyYW1lTGVuID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChzYW1wbGVSYXRlICogMC4wMikpOyAvLyAyMG1zIGZyYW1lc1xuICBjb25zdCBmcmFtZVJtc0xpc3Q6IHsgaWR4OiBudW1iZXI7IHJtczogbnVtYmVyIH1bXSA9IFtdO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpICsgZnJhbWVMZW4gPD0gc2FtcGxlcy5sZW5ndGg7IGkgKz0gZnJhbWVMZW4pIHtcbiAgICBsZXQgc3VtU3EgPSAwO1xuICAgIGZvciAobGV0IGogPSAwOyBqIDwgZnJhbWVMZW47IGorKykge1xuICAgICAgY29uc3QgcyA9IHNhbXBsZXNbaSArIGpdO1xuICAgICAgc3VtU3EgKz0gcyAqIHM7XG4gICAgfVxuICAgIGZyYW1lUm1zTGlzdC5wdXNoKHsgaWR4OiBpLCBybXM6IE1hdGguc3FydChzdW1TcSAvIGZyYW1lTGVuKSB9KTtcbiAgfVxuXG4gIGlmIChmcmFtZVJtc0xpc3QubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFzc2V0SWQsXG4gICAgICBub2lzZUZsb29yRGJmczogLTYwLFxuICAgICAgcm9vbVRvbmVSbXM6IDAuMDAxLFxuICAgICAgcm9vbVRvbmVTYW1wbGU6IG5ldyBGbG9hdDMyQXJyYXkoTWF0aC5yb3VuZChzYW1wbGVSYXRlICogMC41KSksXG4gICAgICBzYW1wbGVSYXRlLFxuICAgIH07XG4gIH1cblxuICAvLyBOb2lzZSBmbG9vciBpcyBlc3RpbWF0ZWQgZnJvbSB0aGUgMTB0aCBwZXJjZW50aWxlIHF1aWV0ZXN0IGZyYW1lcyBhY3Jvc3MgdGhlIGZ1bGwgc2lnbmFsXG4gIC8vIChpbmNsdWRpbmcgZGlnaXRhbC16ZXJvIHBhdXNlcyBzbyBnYXRlZC9zeW50aGV0aWMgc2lsZW5jZSBpcyBub3QgaWdub3JlZCBpbiBmYXZvciBvZiBzcGVlY2gpLlxuICBjb25zdCBzb3J0ZWQgPSBbLi4uZnJhbWVSbXNMaXN0XS5zb3J0KChhLCBiKSA9PiBhLnJtcyAtIGIucm1zKTtcbiAgY29uc3QgcDEwQWxsID0gc29ydGVkW01hdGguZmxvb3Ioc29ydGVkLmxlbmd0aCAqIDAuMSldO1xuICBjb25zdCBub25aZXJvID0gc29ydGVkLmZpbHRlcigoZikgPT4gZi5ybXMgPiAxZS02KTtcblxuICBsZXQgcm9vbVRvbmVSbXM6IG51bWJlcjtcbiAgaWYgKHAxMEFsbC5ybXMgPD0gMWUtNikge1xuICAgIHJvb21Ub25lUm1zID0gMC4wMDA1O1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHRhcmdldFBvb2wgPSBub25aZXJvLmxlbmd0aCA+IDAgPyBub25aZXJvIDogc29ydGVkO1xuICAgIGNvbnN0IHAxMCA9IHRhcmdldFBvb2xbTWF0aC5mbG9vcih0YXJnZXRQb29sLmxlbmd0aCAqIDAuMSldO1xuICAgIHJvb21Ub25lUm1zID0gTWF0aC5tYXgocDEwLnJtcywgMC4wMDA1KTtcbiAgfVxuICBjb25zdCBub2lzZUZsb29yRGJmcyA9IDIwICogTWF0aC5sb2cxMChNYXRoLm1heChyb29tVG9uZVJtcywgMWUtNikpO1xuXG4gIC8vIEV4dHJhY3QgdXAgdG8gMC41IHNlY29uZHMgb2YgcXVpZXQgcm9vbSB0b25lIHdpdGhvdXQgbGVha2luZyBhY3RpdmUgc3BlZWNoIGludG8gcm9vbVRvbmVTYW1wbGVcbiAgY29uc3QgZGVzaXJlZExlbiA9IE1hdGgucm91bmQoc2FtcGxlUmF0ZSAqIDAuNSk7XG4gIGNvbnN0IHJvb21Ub25lU2FtcGxlID0gbmV3IEZsb2F0MzJBcnJheShkZXNpcmVkTGVuKTtcbiAgY29uc3QgcXVpZXRQb29sID0gbm9uWmVyby5maWx0ZXIoKGYpID0+IGYucm1zIDw9IE1hdGgubWF4KHJvb21Ub25lUm1zICogMywgMC4wMTUpKTtcbiAgY29uc3QgcXVpZXRGcmFtZXMgPSBxdWlldFBvb2wuc2xpY2UoMCwgTWF0aC5taW4oMjUsIHF1aWV0UG9vbC5sZW5ndGgpKTtcblxuICBsZXQgd3JpdGVPZmZzZXQgPSAwO1xuICBsZXQgZnJhbWVDdXJzb3IgPSAwO1xuICB3aGlsZSAod3JpdGVPZmZzZXQgPCBkZXNpcmVkTGVuICYmIHF1aWV0RnJhbWVzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBzcmNTdGFydCA9IHF1aWV0RnJhbWVzW2ZyYW1lQ3Vyc29yICUgcXVpZXRGcmFtZXMubGVuZ3RoXS5pZHg7XG4gICAgY29uc3QgY29weUxlbiA9IE1hdGgubWluKGZyYW1lTGVuLCBkZXNpcmVkTGVuIC0gd3JpdGVPZmZzZXQsIHNhbXBsZXMubGVuZ3RoIC0gc3JjU3RhcnQpO1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgY29weUxlbjsgaysrKSB7XG4gICAgICByb29tVG9uZVNhbXBsZVt3cml0ZU9mZnNldCArIGtdID0gc2FtcGxlc1tzcmNTdGFydCArIGtdO1xuICAgIH1cbiAgICB3cml0ZU9mZnNldCArPSBjb3B5TGVuO1xuICAgIGZyYW1lQ3Vyc29yKys7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGFzc2V0SWQsXG4gICAgbm9pc2VGbG9vckRiZnMsXG4gICAgcm9vbVRvbmVSbXMsXG4gICAgcm9vbVRvbmVTYW1wbGUsXG4gICAgc2FtcGxlUmF0ZSxcbiAgfTtcbn1cblxuLyoqIFN5bnRoZXNpemVzIG5hdHVyYWwgUm9vbSBUb25lIGZpbGwgb2YgdGFyZ2V0TGVuZ3RoIHNhbXBsZXMgd2l0aCBwaGFzZS1jb250aW51b3VzIHBpbmctcG9uZyB3cmFwcGluZyAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bnRoZXNpemVSb29tVG9uZUZpbGwoXG4gIHByb2ZpbGU6IEFjb3VzdGljUHJvZmlsZSxcbiAgdGFyZ2V0TGVuZ3RoOiBudW1iZXIsXG4gIHN0YXJ0T2Zmc2V0U2FtcGxlcyA9IDAsXG4pOiBGbG9hdDMyQXJyYXkge1xuICBjb25zdCBvdXQgPSBuZXcgRmxvYXQzMkFycmF5KHRhcmdldExlbmd0aCk7XG4gIGNvbnN0IHNyYyA9IHByb2ZpbGUucm9vbVRvbmVTYW1wbGU7XG4gIGlmIChzcmMubGVuZ3RoID09PSAwKSByZXR1cm4gb3V0O1xuXG4gIGNvbnN0IGN5Y2xlID0gc3JjLmxlbmd0aCAqIDI7XG4gIGNvbnN0IGJhc2VPZmZzZXQgPSAoKE1hdGgudHJ1bmMoc3RhcnRPZmZzZXRTYW1wbGVzKSAlIGN5Y2xlKSArIGN5Y2xlKSAlIGN5Y2xlO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHRhcmdldExlbmd0aDsgaSsrKSB7XG4gICAgLy8gUGluZy1wb25nIHdyYXAgcHJldmVudHMgZGlzY29udGludWl0eSBjbGlja3Mgd2hlbiBsb29waW5nIHNob3J0IHJvb20tdG9uZSBzYW1wbGVzXG4gICAgY29uc3QgcG9zID0gKGJhc2VPZmZzZXQgKyBpKSAlIGN5Y2xlO1xuICAgIGNvbnN0IGlkeCA9IHBvcyA8IHNyYy5sZW5ndGggPyBwb3MgOiBjeWNsZSAtIHBvcyAtIDE7XG4gICAgb3V0W2ldID0gc3JjW2lkeF07XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFNlYXJjaGVzIMKxc2VhcmNoV2luZG93TXMgYXJvdW5kIGNhbmRpZGF0ZVNhbXBsZSBmb3IgdGhlIE1pbmltdW0gUk1TIEVuZXJneSBWYWxsZXkgKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTWluaW11bVJtc1ZhbGxleShcbiAgc2FtcGxlczogRmxvYXQzMkFycmF5LFxuICBzYW1wbGVSYXRlOiBudW1iZXIsXG4gIGNhbmRpZGF0ZVNhbXBsZTogbnVtYmVyLFxuICBzZWFyY2hXaW5kb3dNcyA9IDM1LFxuKTogbnVtYmVyIHtcbiAgY29uc3QgaGFsZlNlYXJjaCA9IE1hdGgucm91bmQoKHNhbXBsZVJhdGUgKiBzZWFyY2hXaW5kb3dNcykgLyAxMDAwKTtcbiAgY29uc3Qgcm1zV2luID0gTWF0aC5tYXgoMTYsIE1hdGgucm91bmQoc2FtcGxlUmF0ZSAqIDAuMDA4KSk7IC8vIDhtcyBSTVMgd2luZG93XG4gIGNvbnN0IG1pbkNlbnRlciA9IE1hdGgubWF4KHJtc1dpbiwgY2FuZGlkYXRlU2FtcGxlIC0gaGFsZlNlYXJjaCk7XG4gIGNvbnN0IG1heENlbnRlciA9IE1hdGgubWluKHNhbXBsZXMubGVuZ3RoIC0gcm1zV2luIC0gMSwgY2FuZGlkYXRlU2FtcGxlICsgaGFsZlNlYXJjaCk7XG5cbiAgaWYgKG1pbkNlbnRlciA+PSBtYXhDZW50ZXIpIHtcbiAgICByZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2FtcGxlcy5sZW5ndGggLSAxLCBjYW5kaWRhdGVTYW1wbGUpKTtcbiAgfVxuXG4gIGxldCBiZXN0SWR4ID0gY2FuZGlkYXRlU2FtcGxlO1xuICBsZXQgYmVzdEVuZXJneSA9IE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcbiAgY29uc3Qgc3RlcCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoc2FtcGxlUmF0ZSAqIDAuMDAxKSk7IC8vIDFtcyBzdGVwXG5cbiAgZm9yIChsZXQgYyA9IG1pbkNlbnRlcjsgYyA8PSBtYXhDZW50ZXI7IGMgKz0gc3RlcCkge1xuICAgIGxldCBzdW1TcSA9IDA7XG4gICAgY29uc3QgaGFsZlcgPSBNYXRoLmZsb29yKHJtc1dpbiAvIDIpO1xuICAgIGZvciAobGV0IGsgPSBjIC0gaGFsZlc7IGsgPCBjICsgaGFsZlc7IGsrKykge1xuICAgICAgY29uc3QgcyA9IHNhbXBsZXNba107XG4gICAgICBzdW1TcSArPSBzICogcztcbiAgICB9XG4gICAgaWYgKHN1bVNxIDwgYmVzdEVuZXJneSkge1xuICAgICAgYmVzdEVuZXJneSA9IHN1bVNxO1xuICAgICAgYmVzdElkeCA9IGM7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGJlc3RJZHg7XG59XG5cbi8qKiBTbmFwcyBzYW1wbGUgaW5kZXggdG8gbmVhcmVzdCBwb3NpdGl2ZS1nb2luZyB6ZXJvIGNyb3NzaW5nIHdpdGhpbiDCsW1heFNoaWZ0U2FtcGxlcyAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNuYXBUb1plcm9Dcm9zc2luZyhcbiAgc2FtcGxlczogRmxvYXQzMkFycmF5LFxuICBzYW1wbGVJZHg6IG51bWJlcixcbiAgbWF4U2hpZnRTYW1wbGVzID0gMjQwLCAvLyDCsTVtcyBhdCA0OGtIelxuKTogeyBpbmRleDogbnVtYmVyOyBhZGp1c3RlZDogYm9vbGVhbiB9IHtcbiAgaWYgKHNhbXBsZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgaW5kZXg6IDAsIGFkanVzdGVkOiBmYWxzZSB9O1xuICB9XG4gIGlmIChzYW1wbGVzLmxlbmd0aCA8IDMpIHtcbiAgICByZXR1cm4ge1xuICAgICAgaW5kZXg6IE1hdGgubWF4KDAsIE1hdGgubWluKHNhbXBsZXMubGVuZ3RoIC0gMSwgTWF0aC5yb3VuZChzYW1wbGVJZHgpKSksXG4gICAgICBhZGp1c3RlZDogZmFsc2UsXG4gICAgfTtcbiAgfVxuICBjb25zdCBjbGFtcGVkID0gTWF0aC5tYXgoMSwgTWF0aC5taW4oc2FtcGxlcy5sZW5ndGggLSAyLCBNYXRoLnJvdW5kKHNhbXBsZUlkeCkpKTtcbiAgaWYgKE1hdGguYWJzKHNhbXBsZXNbY2xhbXBlZF0pIDwgMWUtNSkge1xuICAgIHJldHVybiB7IGluZGV4OiBjbGFtcGVkLCBhZGp1c3RlZDogZmFsc2UgfTtcbiAgfVxuXG4gIGZvciAobGV0IGRlbHRhID0gMDsgZGVsdGEgPD0gbWF4U2hpZnRTYW1wbGVzOyBkZWx0YSsrKSB7XG4gICAgY29uc3QgcmlnaHQgPSBjbGFtcGVkICsgZGVsdGE7XG4gICAgaWYgKHJpZ2h0IDwgc2FtcGxlcy5sZW5ndGggLSAxKSB7XG4gICAgICBpZiAoKHNhbXBsZXNbcmlnaHRdIDw9IDAgJiYgc2FtcGxlc1tyaWdodCArIDFdID4gMCkgfHwgKHNhbXBsZXNbcmlnaHRdID49IDAgJiYgc2FtcGxlc1tyaWdodCArIDFdIDwgMCkpIHtcbiAgICAgICAgcmV0dXJuIHsgaW5kZXg6IHJpZ2h0LCBhZGp1c3RlZDogZGVsdGEgPiAwIH07XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGxlZnQgPSBjbGFtcGVkIC0gZGVsdGE7XG4gICAgaWYgKGxlZnQgPiAwKSB7XG4gICAgICBpZiAoKHNhbXBsZXNbbGVmdF0gPD0gMCAmJiBzYW1wbGVzW2xlZnQgKyAxXSA+IDApIHx8IChzYW1wbGVzW2xlZnRdID49IDAgJiYgc2FtcGxlc1tsZWZ0ICsgMV0gPCAwKSkge1xuICAgICAgICByZXR1cm4geyBpbmRleDogbGVmdCwgYWRqdXN0ZWQ6IGRlbHRhID4gMCB9O1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IGluZGV4OiBjbGFtcGVkLCBhZGp1c3RlZDogZmFsc2UgfTtcbn1cblxuLyoqXG4gKiBFcXVhbC1Qb3dlciBNaWNyby1Dcm9zc2ZhZGUgKDUtMTVtcyBjb3NpbmUvc2luZSBjdXJ2ZSkgYmV0d2VlbiBsZWZ0VGFpbCBhbmQgcmlnaHRIZWFkLlxuICogRWxpbWluYXRlcyBzcGxpY2UgY2xpY2tzIHdoaWxlIG1haW50YWluaW5nIGNvbnN0YW50IHBlcmNlaXZlZCBwb3dlciAoY29zXjIgKyBzaW5eMiA9IDEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlFcXVhbFBvd2VyTWljcm9Dcm9zc2ZhZGUoXG4gIGxlZnRUYWlsOiBGbG9hdDMyQXJyYXksXG4gIHJpZ2h0SGVhZDogRmxvYXQzMkFycmF5LFxuKTogRmxvYXQzMkFycmF5IHtcbiAgY29uc3QgbGVuID0gTWF0aC5taW4obGVmdFRhaWwubGVuZ3RoLCByaWdodEhlYWQubGVuZ3RoKTtcbiAgY29uc3Qgb3V0ID0gbmV3IEZsb2F0MzJBcnJheShsZW4pO1xuICBpZiAobGVuID09PSAwKSByZXR1cm4gb3V0O1xuICBpZiAobGVuID09PSAxKSB7XG4gICAgb3V0WzBdID0gKGxlZnRUYWlsWzBdICsgcmlnaHRIZWFkWzBdKSAqIDAuNTtcbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsZW47IGkrKykge1xuICAgIGNvbnN0IHQgPSBpIC8gKGxlbiAtIDEpO1xuICAgIGNvbnN0IGZhZGVPdXQgPSBNYXRoLmNvcyh0ICogTWF0aC5QSSAqIDAuNSk7XG4gICAgY29uc3QgZmFkZUluID0gTWF0aC5zaW4odCAqIE1hdGguUEkgKiAwLjUpO1xuICAgIG91dFtpXSA9IGxlZnRUYWlsW2ldICogZmFkZU91dCArIHJpZ2h0SGVhZFtpXSAqIGZhZGVJbjtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIERldGVjdHMgUGl0Y2gvRm9ybWFudCBQbGF0ZWF1IChzdXN0YWluZWQgdm93ZWwgc3RyZXRjaCBsaWtlIMKr2LHZgdiq24zZhdmF2YXZhdmFwrsgb3IgwqvYqNmH2YfZh9mH2YfCuylcbiAqIHdoZXJlIG5vIFJNUyBzaWxlbmNlIHZhbGxleSBleGlzdHMgYmVjYXVzZSB0aGUgdm93ZWwgaXMgY29udGludW91c2x5IHZvaWNlZC5cbiAqIFVzZXMgc2hvcnQtdGltZSBhdXRvY29ycmVsYXRpb24gcGVyaW9kaWNpdHkgKyBSTVMgZW52ZWxvcGUgZmxhdG5lc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RQaXRjaFBsYXRlYXVTZWdtZW50cyhcbiAgc2FtcGxlczogRmxvYXQzMkFycmF5LFxuICBzYW1wbGVSYXRlOiBudW1iZXIsXG4gIG1pbkR1cmF0aW9uTXMgPSAyNjAsXG4pOiB7IHN0YXJ0U2FtcGxlOiBudW1iZXI7IGVuZFNhbXBsZTogbnVtYmVyOyBjb25maWRlbmNlOiBudW1iZXI7IGYwSHo6IG51bWJlciB9W10ge1xuICBpZiAoc2FtcGxlcy5sZW5ndGggPT09IDAgfHwgIU51bWJlci5pc0Zpbml0ZShzYW1wbGVSYXRlKSB8fCBzYW1wbGVSYXRlIDw9IDApIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgY29uc3QgZnJhbWVMZW4gPSBNYXRoLm1heCgyLCBNYXRoLnJvdW5kKHNhbXBsZVJhdGUgKiAwLjAzKSk7IC8vIDMwbXNcbiAgY29uc3QgaG9wTGVuID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChzYW1wbGVSYXRlICogMC4wMTUpKTsgLy8gMTVtc1xuICBjb25zdCBtaW5MYWcgPSBNYXRoLm1heCgxLCBNYXRoLmZsb29yKHNhbXBsZVJhdGUgLyAzMjApKTsgLy8gbWF4IDMyMEh6IEYwXG4gIGNvbnN0IG1heExhZyA9IE1hdGgubWF4KG1pbkxhZywgTWF0aC5mbG9vcihzYW1wbGVSYXRlIC8gNzUpKTsgLy8gbWluIDc1SHogRjBcblxuICBpbnRlcmZhY2UgRnJhbWVGZWF0dXJlIHtcbiAgICBzdGFydDogbnVtYmVyO1xuICAgIHJtczogbnVtYmVyO1xuICAgIGYwSHo6IG51bWJlcjtcbiAgICBwZXJpb2RpY2l0eTogbnVtYmVyO1xuICB9XG5cbiAgY29uc3QgZmVhdHVyZXM6IEZyYW1lRmVhdHVyZVtdID0gW107XG5cbiAgZm9yIChsZXQgcG9zID0gMDsgcG9zICsgZnJhbWVMZW4gPD0gc2FtcGxlcy5sZW5ndGg7IHBvcyArPSBob3BMZW4pIHtcbiAgICBsZXQgc3VtU3EgPSAwO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZnJhbWVMZW47IGkrKykge1xuICAgICAgY29uc3QgcyA9IHNhbXBsZXNbcG9zICsgaV07XG4gICAgICBzdW1TcSArPSBzICogcztcbiAgICB9XG4gICAgY29uc3Qgcm1zID0gTWF0aC5zcXJ0KHN1bVNxIC8gZnJhbWVMZW4pO1xuICAgIGlmIChybXMgPCAwLjAxNSkge1xuICAgICAgZmVhdHVyZXMucHVzaCh7IHN0YXJ0OiBwb3MsIHJtcywgZjBIejogMCwgcGVyaW9kaWNpdHk6IDAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBsZXQgYmVzdExhZyA9IG1pbkxhZztcbiAgICBsZXQgYmVzdENvcnIgPSAtMTtcbiAgICBmb3IgKGxldCBsYWcgPSBtaW5MYWc7IGxhZyA8PSBtYXhMYWcgJiYgbGFnIDwgZnJhbWVMZW47IGxhZysrKSB7XG4gICAgICBsZXQgbnVtID0gMDtcbiAgICAgIGxldCBub3JtQSA9IDA7XG4gICAgICBsZXQgbm9ybUIgPSAwO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmcmFtZUxlbiAtIGxhZzsgaSsrKSB7XG4gICAgICAgIGNvbnN0IGEgPSBzYW1wbGVzW3BvcyArIGldO1xuICAgICAgICBjb25zdCBiID0gc2FtcGxlc1twb3MgKyBpICsgbGFnXTtcbiAgICAgICAgbnVtICs9IGEgKiBiO1xuICAgICAgICBub3JtQSArPSBhICogYTtcbiAgICAgICAgbm9ybUIgKz0gYiAqIGI7XG4gICAgICB9XG4gICAgICBjb25zdCBkZW5vbSA9IE1hdGguc3FydChub3JtQSAqIG5vcm1CKTtcbiAgICAgIGNvbnN0IGNvcnIgPSBkZW5vbSA+IDFlLTggPyBudW0gLyBkZW5vbSA6IDA7XG4gICAgICBpZiAoY29yciA+IGJlc3RDb3JyKSB7XG4gICAgICAgIGJlc3RDb3JyID0gY29ycjtcbiAgICAgICAgYmVzdExhZyA9IGxhZztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmZWF0dXJlcy5wdXNoKHtcbiAgICAgIHN0YXJ0OiBwb3MsXG4gICAgICBybXMsXG4gICAgICBmMEh6OiBiZXN0Q29yciA+IDAuNzIgPyBzYW1wbGVSYXRlIC8gYmVzdExhZyA6IDAsXG4gICAgICBwZXJpb2RpY2l0eTogYmVzdENvcnIsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCByZXN1bHRzOiB7IHN0YXJ0U2FtcGxlOiBudW1iZXI7IGVuZFNhbXBsZTogbnVtYmVyOyBjb25maWRlbmNlOiBudW1iZXI7IGYwSHo6IG51bWJlciB9W10gPSBbXTtcbiAgY29uc3QgbWluRnJhbWVzID0gTWF0aC5jZWlsKG1pbkR1cmF0aW9uTXMgLyAxNSk7XG4gIGxldCBydW5TdGFydCA9IC0xO1xuXG4gIGZvciAobGV0IGkgPSAxOyBpIDwgZmVhdHVyZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBwcmV2ID0gZmVhdHVyZXNbaSAtIDFdO1xuICAgIGNvbnN0IGN1cnIgPSBmZWF0dXJlc1tpXTtcbiAgICBjb25zdCBpc1N0YWJsZVZvaWNlZCA9XG4gICAgICBjdXJyLnBlcmlvZGljaXR5ID4gMC43OCAmJlxuICAgICAgcHJldi5wZXJpb2RpY2l0eSA+IDAuNzggJiZcbiAgICAgIGN1cnIuZjBIeiA+IDAgJiZcbiAgICAgIHByZXYuZjBIeiA+IDAgJiZcbiAgICAgIE1hdGguYWJzKGN1cnIuZjBIeiAtIHByZXYuZjBIeikgPD0gNi4wICYmXG4gICAgICBNYXRoLmFicyhjdXJyLnJtcyAtIHByZXYucm1zKSAvIE1hdGgubWF4KHByZXYucm1zLCAxZS01KSA8IDAuMjU7XG5cbiAgICBpZiAoaXNTdGFibGVWb2ljZWQpIHtcbiAgICAgIGlmIChydW5TdGFydCA9PT0gLTEpIHJ1blN0YXJ0ID0gaSAtIDE7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChydW5TdGFydCAhPT0gLTEgJiYgaSAtIHJ1blN0YXJ0ID49IG1pbkZyYW1lcykge1xuICAgICAgICBjb25zdCBhdmdGMCA9XG4gICAgICAgICAgZmVhdHVyZXMuc2xpY2UocnVuU3RhcnQsIGkpLnJlZHVjZSgoYWNjLCBmKSA9PiBhY2MgKyBmLmYwSHosIDApIC8gKGkgLSBydW5TdGFydCk7XG4gICAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgc3RhcnRTYW1wbGU6IGZlYXR1cmVzW3J1blN0YXJ0XS5zdGFydCxcbiAgICAgICAgICBlbmRTYW1wbGU6IGZlYXR1cmVzW2kgLSAxXS5zdGFydCArIGZyYW1lTGVuLFxuICAgICAgICAgIGNvbmZpZGVuY2U6IE1hdGgubWluKDAuOTYsIDAuNzQgKyAoaSAtIHJ1blN0YXJ0KSAqIDAuMDE1KSxcbiAgICAgICAgICBmMEh6OiBNYXRoLnJvdW5kKGF2Z0YwKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBydW5TdGFydCA9IC0xO1xuICAgIH1cbiAgfVxuXG4gIGlmIChydW5TdGFydCAhPT0gLTEgJiYgZmVhdHVyZXMubGVuZ3RoIC0gcnVuU3RhcnQgPj0gbWluRnJhbWVzKSB7XG4gICAgY29uc3QgYXZnRjAgPVxuICAgICAgZmVhdHVyZXMuc2xpY2UocnVuU3RhcnQpLnJlZHVjZSgoYWNjLCBmKSA9PiBhY2MgKyBmLmYwSHosIDApIC9cbiAgICAgIChmZWF0dXJlcy5sZW5ndGggLSBydW5TdGFydCk7XG4gICAgcmVzdWx0cy5wdXNoKHtcbiAgICAgIHN0YXJ0U2FtcGxlOiBmZWF0dXJlc1tydW5TdGFydF0uc3RhcnQsXG4gICAgICBlbmRTYW1wbGU6IGZlYXR1cmVzW2ZlYXR1cmVzLmxlbmd0aCAtIDFdLnN0YXJ0ICsgZnJhbWVMZW4sXG4gICAgICBjb25maWRlbmNlOiBNYXRoLm1pbigwLjk2LCAwLjc0ICsgKGZlYXR1cmVzLmxlbmd0aCAtIHJ1blN0YXJ0KSAqIDAuMDE1KSxcbiAgICAgIGYwSHo6IE1hdGgucm91bmQoYXZnRjApLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8qKiBHcm91cCBBIFNpbGVuY2UvUGF1c2UgZGV0ZWN0b3IgYmFzZWQgb24gYWRhcHRpdmUgbm9pc2UgZmxvb3IgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RMb25nUGF1c2VzKFxuICBzYW1wbGVzOiBGbG9hdDMyQXJyYXksXG4gIHNhbXBsZVJhdGU6IG51bWJlcixcbiAgcHJvZmlsZTogQWNvdXN0aWNQcm9maWxlLFxuICBtaW5QYXVzZU1zID0gNjUwLFxuKTogeyBzdGFydFNhbXBsZTogbnVtYmVyOyBlbmRTYW1wbGU6IG51bWJlcjsgZHVyYXRpb25NczogbnVtYmVyIH1bXSB7XG4gIGlmIChzYW1wbGVzLmxlbmd0aCA9PT0gMCB8fCAhTnVtYmVyLmlzRmluaXRlKHNhbXBsZVJhdGUpIHx8IHNhbXBsZVJhdGUgPD0gMCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBjb25zdCBmcmFtZUxlbiA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoc2FtcGxlUmF0ZSAqIDAuMDI1KSk7IC8vIDI1bXNcbiAgY29uc3QgdGhyZXNob2xkID0gTWF0aC5tYXgocHJvZmlsZS5yb29tVG9uZVJtcyAqIDIuMiwgMC4wMDgpO1xuICBjb25zdCBwYXVzZXM6IHsgc3RhcnRTYW1wbGU6IG51bWJlcjsgZW5kU2FtcGxlOiBudW1iZXI7IGR1cmF0aW9uTXM6IG51bWJlciB9W10gPSBbXTtcblxuICBsZXQgc2lsZW50U3RhcnQgPSAtMTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgKyBmcmFtZUxlbiA8PSBzYW1wbGVzLmxlbmd0aDsgaSArPSBmcmFtZUxlbikge1xuICAgIGxldCBzdW1TcSA9IDA7XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCBmcmFtZUxlbjsgaisrKSB7XG4gICAgICBjb25zdCBzID0gc2FtcGxlc1tpICsgal07XG4gICAgICBzdW1TcSArPSBzICogcztcbiAgICB9XG4gICAgY29uc3Qgcm1zID0gTWF0aC5zcXJ0KHN1bVNxIC8gZnJhbWVMZW4pO1xuICAgIGlmIChybXMgPD0gdGhyZXNob2xkKSB7XG4gICAgICBpZiAoc2lsZW50U3RhcnQgPT09IC0xKSBzaWxlbnRTdGFydCA9IGk7XG4gICAgfSBlbHNlIGlmIChzaWxlbnRTdGFydCAhPT0gLTEpIHtcbiAgICAgIGNvbnN0IGR1ck1zID0gKChpIC0gc2lsZW50U3RhcnQpICogMTAwMCkgLyBzYW1wbGVSYXRlO1xuICAgICAgaWYgKGR1ck1zID49IG1pblBhdXNlTXMpIHtcbiAgICAgICAgcGF1c2VzLnB1c2goeyBzdGFydFNhbXBsZTogc2lsZW50U3RhcnQsIGVuZFNhbXBsZTogaSwgZHVyYXRpb25NczogTWF0aC5yb3VuZChkdXJNcykgfSk7XG4gICAgICB9XG4gICAgICBzaWxlbnRTdGFydCA9IC0xO1xuICAgIH1cbiAgfVxuXG4gIGlmIChzaWxlbnRTdGFydCAhPT0gLTEpIHtcbiAgICBjb25zdCBkdXJNcyA9ICgoc2FtcGxlcy5sZW5ndGggLSBzaWxlbnRTdGFydCkgKiAxMDAwKSAvIHNhbXBsZVJhdGU7XG4gICAgaWYgKGR1ck1zID49IG1pblBhdXNlTXMpIHtcbiAgICAgIHBhdXNlcy5wdXNoKHtcbiAgICAgICAgc3RhcnRTYW1wbGU6IHNpbGVudFN0YXJ0LFxuICAgICAgICBlbmRTYW1wbGU6IHNhbXBsZXMubGVuZ3RoLFxuICAgICAgICBkdXJhdGlvbk1zOiBNYXRoLnJvdW5kKGR1ck1zKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBwYXVzZXM7XG59XG5cbi8qKlxuICogQ29tcHV0ZXMgZnVsbCBQZXJzaWFuIEFjb3VzdGljICYgUHJvc29kaWMgQm91bmRhcnkgRGV0YWlsIGZvciBhIGNhbmRpZGF0ZSBjdXQgcmFuZ2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZpbmVQZXJzaWFuQ3V0Qm91bmRhcnkoXG4gIHNhbXBsZXM6IEZsb2F0MzJBcnJheSxcbiAgc2FtcGxlUmF0ZTogbnVtYmVyLFxuICByYXdSYW5nZTogRmxpY2tSYW5nZSxcbiAgb3B0aW9uczoge1xuICAgIHBpdGNoUGxhdGVhdURldGVjdGVkPzogYm9vbGVhbjtcbiAgICB0cmFpbGluZ0V6YWZlUmlzaz86IGJvb2xlYW47XG4gICAgdHJhaWxpbmdFemFmZVdvcmQ/OiBzdHJpbmc7XG4gICAgbWljcm9Dcm9zc2ZhZGVNcz86IG51bWJlcjtcbiAgfSA9IHt9LFxuKTogUHJvc29kaWNCb3VuZGFyeURldGFpbCB7XG4gIGNvbnN0IG1pY3JvQ3Jvc3NmYWRlTXMgPSBvcHRpb25zLm1pY3JvQ3Jvc3NmYWRlTXMgPz8gMTA7XG4gIGlmIChzYW1wbGVzLmxlbmd0aCA9PT0gMCB8fCAhTnVtYmVyLmlzRmluaXRlKHNhbXBsZVJhdGUpIHx8IHNhbXBsZVJhdGUgPD0gMCkge1xuICAgIGNvbnN0IHNhZmVTdGFydCA9IE1hdGgubWF4KDAsIHJhd1JhbmdlLnN0YXJ0RmxpY2tzKTtcbiAgICBjb25zdCBzYWZlRW5kID0gTWF0aC5tYXgoc2FmZVN0YXJ0LCByYXdSYW5nZS5lbmRGbGlja3MpO1xuICAgIHJldHVybiB7XG4gICAgICByYXdSYW5nZSxcbiAgICAgIHNuYXBwZWRSYW5nZTogeyBzdGFydEZsaWNrczogc2FmZVN0YXJ0LCBlbmRGbGlja3M6IHNhZmVFbmQgfSxcbiAgICAgIHJtc1ZhbGxleVNoaWZ0TXM6IDAsXG4gICAgICB6ZXJvQ3Jvc3NpbmdBZGp1c3RlZDogZmFsc2UsXG4gICAgICBtaWNyb0Nyb3NzZmFkZU1zLFxuICAgICAgcGl0Y2hQbGF0ZWF1RGV0ZWN0ZWQ6IEJvb2xlYW4ob3B0aW9ucy5waXRjaFBsYXRlYXVEZXRlY3RlZCksXG4gICAgICB0cmFpbGluZ0V6YWZlUmlzazogQm9vbGVhbihvcHRpb25zLnRyYWlsaW5nRXphZmVSaXNrKSxcbiAgICAgIHRyYWlsaW5nRXphZmVXb3JkOiBvcHRpb25zLnRyYWlsaW5nRXphZmVXb3JkLFxuICAgICAgcmVhc29uRmE6ICfYqtix2KfYsiDYtNiv2Ycg2KjYpyDZhdix2LIg2K7Yp9mFICjYqNin2YHYsSDYtdmI2KrbjCDYr9ixINiv2LPYqtix2LMg2YbYqNmI2K8pJyxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcmF3U3RhcnRTYW1wbGUgPSBmbGlja3NUb1NhbXBsZXMocmF3UmFuZ2Uuc3RhcnRGbGlja3MsIHNhbXBsZVJhdGUpO1xuICBjb25zdCByYXdFbmRTYW1wbGUgPSBmbGlja3NUb1NhbXBsZXMocmF3UmFuZ2UuZW5kRmxpY2tzLCBzYW1wbGVSYXRlKTtcblxuICBjb25zdCB2YWxsZXlTdGFydCA9IG9wdGlvbnMucGl0Y2hQbGF0ZWF1RGV0ZWN0ZWRcbiAgICA/IHJhd1N0YXJ0U2FtcGxlXG4gICAgOiBmaW5kTWluaW11bVJtc1ZhbGxleShzYW1wbGVzLCBzYW1wbGVSYXRlLCByYXdTdGFydFNhbXBsZSwgMzApO1xuICBjb25zdCB2YWxsZXlFbmQgPSBmaW5kTWluaW11bVJtc1ZhbGxleShzYW1wbGVzLCBzYW1wbGVSYXRlLCByYXdFbmRTYW1wbGUsIDMwKTtcblxuICBjb25zdCB6Y1N0YXJ0ID0gc25hcFRvWmVyb0Nyb3NzaW5nKHNhbXBsZXMsIHZhbGxleVN0YXJ0KTtcbiAgY29uc3QgemNFbmQgPSBzbmFwVG9aZXJvQ3Jvc3Npbmcoc2FtcGxlcywgdmFsbGV5RW5kKTtcblxuICBjb25zdCBtaW5TcGFuU2FtcGxlcyA9IE1hdGgubWluKHNhbXBsZXMubGVuZ3RoLCBNYXRoLnJvdW5kKHNhbXBsZVJhdGUgKiAwLjA0KSk7XG4gIGNvbnN0IHNuYXBwZWRTdGFydCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHpjU3RhcnQuaW5kZXgsIHpjRW5kLmluZGV4IC0gbWluU3BhblNhbXBsZXMpKTtcbiAgY29uc3Qgc25hcHBlZEVuZCA9IE1hdGgubWluKFxuICAgIHNhbXBsZXMubGVuZ3RoLFxuICAgIE1hdGgubWF4KHpjRW5kLmluZGV4LCBzbmFwcGVkU3RhcnQgKyBtaW5TcGFuU2FtcGxlcyksXG4gICk7XG5cbiAgY29uc3Qgc2hpZnRNcyA9IE1hdGgucm91bmQoKChzbmFwcGVkU3RhcnQgLSByYXdTdGFydFNhbXBsZSkgKiAxMDAwKSAvIHNhbXBsZVJhdGUpO1xuXG4gIGxldCByZWFzb25GYSA9ICfYqtix2KfYsiDYtNiv2Ycg2KjYpyDYr9ix2Ycg2KfZhtix2pjbjCAoTWluaW11bSBSTVMpINmIINi52KjZiNixINin2LIg2LXZgdixIChaZXJvLUNyb3NzaW5nKSc7XG4gIGlmIChvcHRpb25zLnBpdGNoUGxhdGVhdURldGVjdGVkKSB7XG4gICAgcmVhc29uRmEgPSAn2KrYtNiu24zYtSDaqdi024zYr9qv24wg2YjYp9qp2YcgKFBpdGNoL0Zvcm1hbnQgUGxhdGVhdSkg2KjYr9mI2YYg2K/YsdmHINiz2qnZiNiqINmF24zYp9mG24wgKyDZgtmB2YQg2LnYqNmI2LEg2KfYsiDYtdmB2LEnO1xuICB9XG4gIGlmIChvcHRpb25zLnRyYWlsaW5nRXphZmVSaXNrICYmIG9wdGlvbnMudHJhaWxpbmdFemFmZVdvcmQpIHtcbiAgICByZWFzb25GYSA9IGDZh9i02K/Yp9ixINiv2YbYqNin2YTZhyDaqdiz2LHZhyDYp9i22KfZgdmHINix2YjbjCDCqyR7b3B0aW9ucy50cmFpbGluZ0V6YWZlV29yZH3CuyDigJQg2KfYudmF2KfZhCDZh9mF4oCM2b7ZiNi02KfZhtuMINmG2LHZhSAke21pY3JvQ3Jvc3NmYWRlTXN9bXNgO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICByYXdSYW5nZSxcbiAgICBzbmFwcGVkUmFuZ2U6IHtcbiAgICAgIHN0YXJ0RmxpY2tzOiBzYW1wbGVzVG9GbGlja3Moc25hcHBlZFN0YXJ0LCBzYW1wbGVSYXRlKSxcbiAgICAgIGVuZEZsaWNrczogc2FtcGxlc1RvRmxpY2tzKHNuYXBwZWRFbmQsIHNhbXBsZVJhdGUpLFxuICAgIH0sXG4gICAgcm1zVmFsbGV5U2hpZnRNczogc2hpZnRNcyxcbiAgICB6ZXJvQ3Jvc3NpbmdBZGp1c3RlZDogemNTdGFydC5hZGp1c3RlZCB8fCB6Y0VuZC5hZGp1c3RlZCxcbiAgICBtaWNyb0Nyb3NzZmFkZU1zLFxuICAgIHBpdGNoUGxhdGVhdURldGVjdGVkOiBCb29sZWFuKG9wdGlvbnMucGl0Y2hQbGF0ZWF1RGV0ZWN0ZWQpLFxuICAgIHRyYWlsaW5nRXphZmVSaXNrOiBCb29sZWFuKG9wdGlvbnMudHJhaWxpbmdFemFmZVJpc2spLFxuICAgIHRyYWlsaW5nRXphZmVXb3JkOiBvcHRpb25zLnRyYWlsaW5nRXphZmVXb3JkLFxuICAgIHJlYXNvbkZhLFxuICB9O1xufVxuXG4vKiogRGV0ZWN0cyBNaWMgQmxlZWQgLyBDcm9zc3RhbGsgd2hlcmUgVHJhY2sgQiBjYXJyaWVzIGF0dGVudWF0ZWQgYmxlZWQgb2YgYWN0aXZlIFRyYWNrIEEgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RDcm9zc3RhbGtCbGVlZChcbiAgcHJpbWFyeVNhbXBsZXM6IEZsb2F0MzJBcnJheSxcbiAgc2Vjb25kYXJ5U2FtcGxlczogRmxvYXQzMkFycmF5LFxuICBzYW1wbGVSYXRlOiBudW1iZXIsXG4gIHJhbmdlOiBGbGlja1JhbmdlLFxuKTogeyBpc0Nyb3NzdGFsazogYm9vbGVhbjsgYmxlZWRSYXRpb0RiOiBudW1iZXIgfSB7XG4gIGNvbnN0IHN0YXJ0ID0gTWF0aC5tYXgoMCwgZmxpY2tzVG9TYW1wbGVzKHJhbmdlLnN0YXJ0RmxpY2tzLCBzYW1wbGVSYXRlKSk7XG4gIGNvbnN0IGVuZCA9IE1hdGgubWluKHByaW1hcnlTYW1wbGVzLmxlbmd0aCwgc2Vjb25kYXJ5U2FtcGxlcy5sZW5ndGgsIGZsaWNrc1RvU2FtcGxlcyhyYW5nZS5lbmRGbGlja3MsIHNhbXBsZVJhdGUpKTtcbiAgaWYgKGVuZCA8PSBzdGFydCkgcmV0dXJuIHsgaXNDcm9zc3RhbGs6IGZhbHNlLCBibGVlZFJhdGlvRGI6IDAgfTtcblxuICBsZXQgc3VtQSA9IDA7XG4gIGxldCBzdW1CID0gMDtcbiAgZm9yIChsZXQgaSA9IHN0YXJ0OyBpIDwgZW5kOyBpKyspIHtcbiAgICBzdW1BICs9IHByaW1hcnlTYW1wbGVzW2ldICogcHJpbWFyeVNhbXBsZXNbaV07XG4gICAgc3VtQiArPSBzZWNvbmRhcnlTYW1wbGVzW2ldICogc2Vjb25kYXJ5U2FtcGxlc1tpXTtcbiAgfVxuICBjb25zdCBybXNBID0gTWF0aC5zcXJ0KHN1bUEgLyAoZW5kIC0gc3RhcnQpKTtcbiAgY29uc3Qgcm1zQiA9IE1hdGguc3FydChzdW1CIC8gKGVuZCAtIHN0YXJ0KSk7XG4gIGNvbnN0IHJhdGlvRGIgPSAyMCAqIE1hdGgubG9nMTAoTWF0aC5tYXgocm1zQiwgMWUtNikgLyBNYXRoLm1heChybXNBLCAxZS02KSk7XG5cbiAgLy8gSWYgcHJpbWFyeSB0cmFjayBpcyBzcGVha2luZyBzdHJvbmdseSBhbmQgc2Vjb25kYXJ5IHRyYWNrIGlzIDEyZEIuLjM0ZEIgcXVpZXRlciBpbiBleGFjdCB3aW5kb3cgLT4gbWljIGJsZWVkXG4gIGNvbnN0IGlzQ3Jvc3N0YWxrID0gcm1zQSA+IDAuMDQgJiYgcmF0aW9EYiA8PSAtMTIgJiYgcmF0aW9EYiA+PSAtMzY7XG4gIHJldHVybiB7IGlzQ3Jvc3N0YWxrLCBibGVlZFJhdGlvRGI6IE51bWJlcihyYXRpb0RiLnRvRml4ZWQoMSkpIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGFtcE1pY3JvQ3Jvc3NmYWRlRmxpY2tzKG1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gbXNUb0ZsaWNrcyhNYXRoLm1heCg1LCBNYXRoLm1pbigxNSwgbXMpKSk7XG59XG4iXX0=