# فهرست کدهای مرده، غیرمتصل، نمایشی و خارج از دامنه (Phase 0 — Dead Code & Scope Register)

این سند ۲۹۲ فایل `src/`، ۶۳ فایل `backend/`، ۳۸ فایل `packages/` و مستندات ریشه را در ۶ دسته عملیاتی دسته‌بندی می‌کند تا پیش از تغییر کد مشخص شود چه بخش‌هایی حفظ، ادغام، قرنطینه یا حذف می‌شوند.

---

## دسته A — هسته فعال استودیو (حفظ و تقویت)

این ماژول‌ها اکنون در مسیر فعال `App.tsx` استفاده می‌شوند و منطق واقعی و ارزشمندی دارند:
- `src/engine/dsp.ts` (تحلیل نویز کف، Room Tone، Zero-Crossing، Equal-Power Crossfade، Pitch Plateau، Crosstalk)
- `src/engine/processingGraph.ts` (مرتب‌سازی توپولوژیک DAG، جبران تاخیر PDC، Pre-Roll Priming)
- `src/engine/resampler.ts` (فیلتر Windowed-Sinc ضد-Aliasing به 16kHz)
- `src/engine/peakPyramid.ts` (هرم LOD چهارسطحی 64/256/1024/4096)
- `src/engine/timebase.ts` و `src/contracts/timebase.contract.ts` (دقت Flicks و اندیس نمونه)
- `src/engine/lruCache.ts` و `src/workers/ioBroker.worker.ts` (پایه OPFS + کش LRU)
- `src/security/AudioSecurityGuard.ts` و `src/runtime/CrashRecoveryAndSessionLock.ts`
- کامپوننت‌های هسته تدوین: `WaveformCanvas.tsx`, `TranscriptPanel.tsx`, `SuggestionsPanel.tsx`, `DspControlRack.tsx`, `ExportModal.tsx`, `ProcessingGraphView.tsx`, `StorageBrokerView.tsx`, `AuditionTransportBar.tsx`, `AuditionSideDock.tsx`

---

## دسته B — زیرساخت‌های باکیفیت ولی غیرمتصل (اتصال در فازهای ۱ تا ۴)

این فایل‌ها یا تست دارند یا پیاده‌سازی دقیق دارند، اما به `App.tsx` متصل نیستند:
- `src/processing-core/ParallelChunkRenderCoordinator.ts` و `StreamingExportEncoder.ts` (رندر و خروجی قطعه‌ای زیر سقف حافظه)
- `packages/audio-runtime/src/DirectStudioOpfsRecorder.ts` و `StreamingPlaybackPumpController.ts`
- `src/audio-engine/SharedRingBuffer.ts` و `src/audio-engine/playback.worklet.ts`
- `src/project-core/TimelineTransactionEngine.ts` (ساختار Undo/Redo غیرمخرب روی تراکنش‌های تایم‌لاین)
- `src/ai-engine/OnnxPersianAsrAndVadAdapter.ts`, `src/ai-engine/PersianChunkedAsrWorker.ts`, `src/ai-engine/asr/UnifiedOnnxPersianAsrEngine.ts`, `src/ai-engine/workers/asr-inference.worker.ts` (نیازمند `onnxruntime-web` و وزن مدل واقعی در فاز ۲)

---

## دسته C — پوسته موازی / تکراری (`Duplicate Shell — ?shell=v12`)

- `src/ui/desktop/DesktopAudioStudioApp.tsx`
- `src/hooks/useAudioStudioController.ts`
- `src/ui/waveform/LodWaveformCanvasRenderer.ts`
- **وضعیت:** به‌طور پیش‌فرض رندر نمی‌شوند؛ در فاز ۱ و ۴ باید یا با `App.tsx` یکپارچه شوند یا بخش‌های پایدار (`SharedRingBuffer`, `LodWaveformCanvasRenderer`) به هسته اصلی منتقل شده و پوسته تکراری حذف شود.

---

## دسته D — افزونه‌های آزمایشگاهی، سازمانی و پورتال (خارج از مسیر اصلی کاربر تدوین)

این ماژول‌ها رابط اصلی تدوینگر را شلوغ کرده‌اند و نباید در Toolbar اصلی استودیو حضور داشته باشند:
- `src/components/AsrResearchLabModal.tsx`
- `src/components/DeveloperPlatformPortalModal.tsx`
- `src/components/SpeechIntelligenceModal.tsx`
- `src/components/DataFactoryModal.tsx`
- `src/components/ModelFactoryModal.tsx`
- `src/components/SpeechSecurityModal.tsx`
- سرویس‌های متناظر در `src/platform/`, `src/data-factory/`, `src/model-factory/`, `src/security/SpeechSecurity*.ts`, `src/intelligence/` و مسیرهای آن‌ها در `server.ts`.

---

## دسته E — شبیه‌سازها و Fallbackهای ساختگی (حذف یا جایگزینی در فازهای ۱ تا ۳)

- `src/engine/persianAsrTranscriber.ts:525` (`buildOfflineAcousticSegmentedTranscript`) — تولید کلمات فارسی ساختگی (`اممم`, `پادکستِ`, `بخشِ_N`)
- `src/engine/audioFixtures.ts` (تولید صوت مصنوعی به‌عنوان حالت پیش‌فرض اولیه یا Decode کامل یکجا در RAM)
- `src/asr-core/CoreAcousticCtcEngine.ts:synthesizeAcousticSpeechFromText` — صرفاً برای تست بنچمارک Node، نباید به‌عنوان خروجی تولیدی کاربر معرفی شود.
- `server.ts` مسیر `/api/v1/asr/transcribe` با `gemini-3.5-transcribe` و مسیر `/api/v1/lab/provider-transcribe`.
- خطای نحو تایپ‌اسکریپت در `src/ai-engine/asr/AsrExperimentationLabCore.ts:830` که مانع اجرای مستقیم `node server.ts` می‌شود.

---

## دسته F — بک‌اند داکر/پستگرس و مستندات منسوخ ریشه (خارج از معماری Local-Only)

- کل پوشه `/backend/` (۶۳ فایل، Fastify + PostgreSQL) و `/deploy/docker-compose.backend.yml`
- مستندات قدیمی فاز ۰ آزمایشگاه ابری (`EXECUTION-ROADMAP.md`, `RISKS-AND-BLOCKERS.md`, `ARCHITECTURE/ASR-LAB-ARCHITECTURE.md` و دایرکتوری‌های `BENCHMARK/`, `PLATFORM/`, `REVERSE-ENGINEERING/` که بر مدل‌های تجاری ابری و پورتال متمرکز بودند).
- **توجه:** مستندات قدیمی برای حفظ تاریخچه مخزن دست‌نخورده می‌مانند و مرجع رسمی آواپرداز v2.0 از این پس پوشه `docs/AVAPARDAZ/` است.
