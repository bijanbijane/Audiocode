# نقشه جامع مهندسی و فهرست یکپارچه مخزن (Master Repository Architecture Map)

این سند نقشه دقیق ۱۵۷ بخش پیاده‌سازی‌شده پلتفرم هوشمند تدوین و پردازش صوت فارسی (**آواپرداز — نسخه ۱.۲**) را منطبق با ساختار واقعی فایل‌های موجود در مخزن نشان می‌دهد.

## ۱. لایه استقرار، زیرساخت و CI/CD
- `vite.config.ts` — تنظیم هدرهای `COOP/COEP` در محیط توسعه برای فعال‌سازی `SharedArrayBuffer`
- `vitest.config.ts` — پیکربندی تست‌های انتشار و گیت‌های کیفیت (`**/*.spec.ts`)
- `deploy/Dockerfile`، `backend/Dockerfile` و `deploy/docker-compose.backend.yml` — ساخت چندمرحله‌ای (`Rust WASM + Vite Web + Hardened Nginx`) و کانتینر تولیدی Backend همراه با PostgreSQL 16 و Prometheus
- `deploy/nginx/nginx.conf` و `deploy/nginx/security-headers.conf` — پیکربندی CSP با `wasm-unsafe-eval`، `COOP/COEP` و سروینگ `Byte-Range` برای قطعات ۸ مگابایتی مدل‌ها
- `deploy/monorepo/pnpm-workspace.yaml` و `deploy/monorepo/package.monorepo.json` — الگوی بسته‌بندی Monorepo
- `.github/workflows/ci-quality-gate.yml` — خط لوله ممیزی مجوزهای تجاری، SBOM، تست‌های واحد، Vitest و بیلد نهایی

## ۲. قراردادها و مدل‌های پایه (`src/contracts/`)
- `src/contracts/timebase.contract.ts` — مرجع زمانی `Flicks` (`705,600,000 Hz`) و عملیات دقیق `TimeMath`
- `src/contracts/storage-broker.contract.ts` — قرارداد `Seek Table`، هرم Peak و کش OPFS
- `src/contracts/persian-editing.contract.ts` — قرارداد برش آوایی فارسی و هشدارهای کسره اضافه
- `src/contracts/project-schema.contract.ts` — مدل داده پروژه، ترک‌ها، کلیپ‌ها، پیشنهادها و تراکنش‌ها
- `src/contracts/RuntimeAbstractionLayer.ts` — لایه انتزاعی مستقل از Runtime برای Web/Desktop/Cloud
- `src/contracts/PlatformErrorCatalog.ts` — کاتالوگ ۱۰ دسته خطا و راهکارهای بازیابی

## ۳. هسته بومی Rust و رانتایم صوتی بلادرنگ (`wasm-audio-core/`, `src/audio-engine/`, `packages/audio-runtime/src/`)
- `wasm-audio-core/Cargo.toml` و `wasm-audio-core/deny.toml` — سپر ممانعت از مجوزهای غیرتجاری (GPL/AGPL) روی Symphonia و Rubato
- `wasm-audio-core/src/lib.rs` و `wasm-audio-core/src/streaming_decoder.rs` — دیکدر جریانی مقاوم به فریم خراب، گارد Decompression Bomb و سازنده `WasmSeekTableEntry`
- `src/audio-engine/SharedRingBuffer.ts`، `src/audio-engine/playback.worklet.ts` و `packages/audio-runtime/src/StreamingPlaybackPumpController.ts` — بافر حلقوی Lock-Free، پردازشگر `AudioWorklet` بدون GC و پمپ پخش جریانی غیرمخرب تایم‌لاین از OPFS با Seek اتمیک
- `src/audio-engine/PersianAcousticSnapper.ts` — اسنپ دره انرژی، Zero-Crossing همفاز و Room Tone
- `src/audio-engine/LoudnessAndMasteringEngine.ts` — استاندارد `ITU-R BS.1770-4` (`-16 LUFS`) و محدودکننده `True-Peak`
- `packages/audio-runtime/src/RecordingQualityAdvisorEngine.ts` — تشخیص هوم برق ۵۰ هرتز (Goertzel)، پاپ‌های «پ/ب/ت» و تیزی صفیری
- `packages/audio-runtime/src/ChannelAndPhaseAlignmentEngine.ts` — تشخیص وارونگی قطبیت ۱۸۰ درجه و هم‌فازسازی میکروفون‌ها
- `packages/audio-runtime/src/MultiRecorderClockDriftAligner.ts` — تشخیص آفست اولیه و حذف رانش کلاک دو ضبط‌کننده مستقل (`Clock Drift PPM`) با درون‌یابی مکعبی Catmull-Rom
- `packages/audio-runtime/src/SmartSplicePreviewEngine.ts` — پیش‌شنوایی A/B همراه با Pre-Roll
- `packages/audio-runtime/src/SpeechReconstructionAndWatermarkEngine.ts` — تطبیق طیف ۴بانده صدای `Punch-In` و واترمارک نامحسوس `19 kHz` (`-66 dBFS`)
- `packages/audio-runtime/src/SensitiveContentAndPiiRedactorEngine.ts` — شناسایی اطلاعات شخصی حساس (شماره موبایل، کد ملی و کلمات محرمانه) و پوشاندن صوتی (`1kHz Bleep` / `Muffle` / `Room Tone`)
- `packages/audio-runtime/src/VocalAndMusicStemSeparatorEngine.ts` — تفکیک صدای گوینده مرکز (`Isolated Vocal Stem`) از بستر موسیقی استریوی پس‌زمینه (`Isolated Music Bed Stem`) با ماسک نرم زمان-فرکانس
- `packages/audio-runtime/src/AudioBusAndRoutingMatrixEngine.ts` و `Parametric8BandBiquadEq.ts` — کنسول میکس چندمسیره (`Submix Buses` + `Sidechain`) و اکوالایزر پارامتریک ۸ بانده ۶۴ بیتی با محاسبه پاسخ فرکانسی Z-Plane
- `packages/audio-runtime/src/SpectralWienerDenoiserEngine.ts` — حذف نویز طیفی با فیلتر وینر دو مرحله‌ای (`Decision-Directed`) و پنجره‌گذاری ۵۰٪ همپوشان
- `packages/audio-runtime/src/DirectStudioOpfsRecorder.ts` — ضبط استودیویی بدون فیلتر مکالمه و فلاش ۵ ثانیه‌ای مقاوم به کرش در OPFS
- `packages/audio-runtime/src/TimeStretchWsolaEngine.ts` — تغییر سرعت گفتار بدون تغییر زیر و بمی صدا با الگوریتم `WSOLA`
- `packages/audio-runtime/src/PriorityWorkerPoolDispatcher.ts` و `WebGpuAcceleratedKernelRunner.ts` — مدیر استخر کارگرهای وب با ۴ سطح اولویت (`P0` تا `P3`) و اجراکننده شیدرهای محاسباتی `WGSL` WebGPU با برش‌زنی ضد TDR (`Sliced Dispatches`)
- `packages/audio-runtime/src/MidSideVocalSpaceCarverEngine.ts` — تبدیل ماتریسی بی‌افت `Mid/Side` و حفره‌ساز طیفی پویا (`300Hz-3500Hz`) برای صدای گوینده فارسی در میکس موسیقی استریو
- `packages/audio-runtime/src/AcousticTranslationSimulatorEngine.ts` — شبیه‌ساز محیط‌های شنیداری دنیای واقعی پیش از انتشار (اسپیکر مونو موبایل، کابین خودرو در ترافیک و اسپیکر لپ‌تاپ)
- `packages/audio-runtime/src/LongRunningChaosAndStabilitySuite.ts` — تست استرس طولانی‌مدت و ردیاب نشت حافظه با رگرسیون OLS

## ۴. موتور هوش مصنوعی و زبان‌شناسی فارسی (`src/ai-engine/`, `src/platform/`)
- `src/ai-engine/AntiAliasedResampler.ts` — فیلتر FIR Blackman-Sinc برای تبدیل نمونه به `16kHz Mono`
- `src/ai-engine/OnnxPersianAsrAndVadAdapter.ts`، `src/ai-engine/asr/PersianCtcPrefixBeamSearchDecoder.ts`، `src/ai-engine/asr/CompactPersianLanguageModelScorer.ts`، `src/ai-engine/asr/SentencePieceAndWhisperBridge.ts`، `src/ai-engine/asr/SileroVadOnnxRunner.ts`، `src/ai-engine/asr/UnifiedOnnxPersianAsrEngine.ts`، `src/ai-engine/asr/DynamicLengthBatchedCtcRunner.ts`، `src/ai-engine/asr/PreAsrInputSanityValidator.ts`، `src/ai-engine/asr/StreamingLivePersianAsrEngine.ts`، `src/ai-engine/asr/PersianPostAsrSpellingAndCompoundRestorer.ts`، `src/ai-engine/asr/WhisperKvCacheAutoregressiveOptimizer.ts`، `src/ai-engine/asr/SpeakerEmbeddingOnnxRunner.ts`، `src/ai-engine/asr/WebWorkerOrtRuntimeProvider.ts`، `src/ai-engine/workers/asr-inference.worker.ts`، `src/ai-engine/asr/WhisperPlusCtcTwoStageAligner.ts`، `src/ai-engine/asr/WhisperCrossAttentionDtwAligner.ts`، `src/ai-engine/asr/ContextBiasingTrieCtcScorer.ts`، `src/ai-engine/asr/PersianFastConformerRnntAndTdtDecoder.ts`، `src/ai-engine/asr/IntegratedPersianAsrService.ts`، `src/ai-engine/asr/PersianPhoneticConfusionCorrector.ts`، `src/ai-engine/asr/PersianNBestLatticeAndWhisperPromptEngine.ts`، `src/ai-engine/asr/WhisperBeamSearchAndTempFallbackEngine.ts`، `src/ai-engine/asr/PreAsrMusicAndJingleBoundaryFilter.ts`، `src/ai-engine/asr/PersianAsrConfidenceCalibrator.ts`، `src/ai-engine/asr/PersianSyntacticAcousticEndpointDetector.ts`، `src/ai-engine/asr/SpeakerTurnBoundaryWordAligner.ts`، `src/ai-engine/asr/PersianTopicAndKeywordIndexer.ts`، `src/ai-engine/asr/PraatTextGridAndLinguisticExporter.ts` و `src/ai-engine/asr/PersianRoverMultiModelEnsembleEngine.ts` — زنجیره کامل ASR بومی فارسی شامل بازرس سلامت سیگنال پیش‌ازASR (حذف DC Offset، کشف سکوت و Clipping)، Log-Mel 80، CTC Beam Search، استنتاج دسته‌ای پویا بر اساس طول قطعات (`DynamicLengthBatchedCtcRunner`)، مدل زبان باینری `PLM1`، SentencePiece، Silero VAD v5، FastConformer-CTC/RNN-T/TDT، Whisper با KV-Cache و Beam Search + LZ77 Fallback، استخراج زمان ۲۰ میلی‌ثانیه‌ای کلمات با Cross-Attention DTW، هم‌ترازساز دومرحله‌ای Whisper+CTC، ترکیب چندمدلی ROVER با رأی‌گیری وزن‌دار زمانی (`PersianRoverMultiModelEnsembleEngine`)، خروجی استاندارد زبان‌شناسی Praat TextGrid و NIST CTM، تقویت واژگان تخصصی با Trie، تصحیح هم‌آواهای فارسی با زمینه دوطرفه، شبکه کلمات N-Best Sausage Lattice، فیلتر موسیقی تیتراژ، کالیبراسیون اطمینان Platt Scaling (ECE)، تشخیص هوشمند پایان جمله زنده (Syntactic + $F_0$ Endpointing)، هم‌ترازگر دقیق مرز کلمات و نوبت گویندگان (SpeakerTurnBoundaryWordAligner) و استخراج کلیدواژه چندکلمه‌ای RAKE فارسی (PersianTopicAndKeywordIndexer)
- `src/ai-engine/PersianTextNormalizer.ts`، `PersianNumeralAndCurrencyNormalizer.ts`، `PersianProsodicPunctuationRestorer.ts` و `PersianColloquialAndDialectNormalizer.ts` — نرمال‌ساز سه‌لایه متن فارسی (`original`، `normalized`، `display`)، تبدیل دوطرفه اعداد و مبالغ پولی، علامت‌گذاری نگارشی خودکار بر اساس خیز/افت `F0 Pitch Contour` و تبدیل دوطرفه گفتار محاوره‌ای به فارسی معیار با حفظ ردیابی به متن اصلی
- `src/ai-engine/PersianChunkedAsrWorker.ts` — اجرای پنجره‌ای ASR با همپوشانی و ادغام مرزی
- `src/ai-engine/PersianCtcForcedAligner.ts` — هم‌ترازی اجباری واج و کلمه فارسی با الگوریتم ویتِربی CTC
- `src/ai-engine/PersianDisfluencyEngine.ts` — تشخیص تپق، تکرار عبارات و مکث‌های غیرطبیعی
- `src/ai-engine/PersianSemanticRepetitionEngine.ts` — تشخیص برداشت‌های تکراری معنایی (`Retakes`)
- `src/ai-engine/MultiSpeakerDiarizationAndCrosstalkEngine.ts` — تفکیک گویندگان و تشخیص نشت میکروفون (`Crosstalk`)
- `src/ai-engine/CustomPersianLexiconManager.ts` — واژه‌نامه اختصاصی و اسکلت آوایی همآواها
- `src/ai-engine/PersianPhoneticTranscriptSearchEngine.ts` — موتور جستجوی فوری همآوا، نیم‌فاصله‌پذیر و عبارتی
- `src/ai-engine/PersianProsodyAndPacingAnalyzer.ts` — تحلیل سرعت تکلم (`WPM` خالص / هجا) و یکنواختی لحن (`Semitones`)
- `src/ai-engine/PersianChapterAndTopicSegmenter.ts` — فصل‌بندی خودکار موضوعی (`TextTiling + Acoustic Pause + TF-IDF`)
- `src/ai-engine/ScriptToAudioDeviationDetector.ts` — تطبیق متن کتاب با صدای گوینده (`Needleman-Wunsch`) برای کنترل کیفیت کتاب صوتی
- `src/ai-engine/PersianShowNotesAndTextRankEngine.ts` و `PersianPodcastTeaserGeneratorEngine.ts` — استخراج خودکار نکات کلیدی اپیزود با الگوریتم `TextRank`، نمایه‌ساز موجودیت‌های نام‌دار و تولیدکننده تیزر ابتدای پادکست (`Cold Open Hooks`)
- `src/ai-engine/NonVerbalVocalEventDetector.ts` — تشخیص سرفه/صاف کردن گلو (`REPLACE_WITH_ROOM_TONE`) و نفس‌های تند پیش از جمله (`ATTENUATE_GAIN_10DB`)
- `src/ai-engine/evaluation/PersianSpeechEvaluationCorpusBuilder.ts` و `src/ai-engine/evaluation/DetailedAsrErrorBreakdownEvaluator.ts` — چارچوب مدیریت و ممیزی ۱۲ محور الزامی دیتاست ارزیابی گفتار فارسی (بخش ۳۹) و تحلیل‌گر تفکیکی خطاهای `WER` (`Hits/Substitutions/Deletions/Insertions`) و `CER` (بخش ۱۵۴)
- `src/ai-engine/ExternalApiGovernanceGateway.ts` — دروازه ۱۰ قانون استقلال از API خارجی
- `src/platform/ChunkedModelDelivery.ts` — دانلود تکه‌تکه ۸ مگابایتی با Resume بومی

## ۵. هسته پردازش، پروژه و امنیت (`src/processing-core/`, `src/project-core/`, `src/runtime/`, `src/security/`)
- `src/processing-core/AudioRestorationEngine.ts` — حذف تقه دهان (TKEO De-Click)، De-Clip و De-Reverb
- `src/processing-core/ProcessingGraphEngine.ts`، `MerkleDagCacheManager.ts`، `ProcessingNodeVersionRegistry.ts` و `ParallelChunkRenderCoordinator.ts` — کامپایلر گراف DAG، جبران خودکار تأخیر (PDC)، مدیر کش درخت مرکل با ابطال انتخابی زیرگراف (بخش ۳۲)، رجیستری مهاجرت نسخه پارامترهای گره‌ها (بخش ۲۸) و هماهنگ‌کننده رندر موازی چندنخی با نوشتن مرتب در OPFS
- `src/processing-core/StreamingExportEncoder.ts` و `StreamingExportEncoderWorker.ts` — انکود جریانی WAV با TPDF Dither و WebVTT فارسی
- `src/processing-core/ExportValidator.ts` — اعتبارسنجی خروجی و صدور `RenderManifest`
- `src/project-core/TimelineTransactionEngine.ts`، `TimelineAutomationEngine.ts`، `MultiSpeakerTurnLevelerEngine.ts` و `LiveMarkerAndAnnotationManager.ts` — تدوین غیرمخرب، حفظ سینک چندترک، Auto-Ducking، هم‌سطح‌سازی خودکار بلندی صدای گویندگان (`S-Curve Gain Leveling`) و نشانه‌گذاری زنده با جبران زمان واکنش انسان (`550ms Lookback`) و همگام‌سازی Ripple
- `src/project-core/evaluation/EditQualityVsModelQualityEvaluator.ts` — ارزیاب مستقل کیفیت تشخیص مدل (`WER/F1/DER`) در برابر کیفیت تدوین نهایی صوت (`Zero-Click Continuity / Cadence / Room Tone Seam`) طبق قانون طلایی ۲۶ و بخش ۳۹
- `src/project-core/PostEditValidationEngine.ts` — اعتبارسنجی و ترمیم تایم‌لاین پس از تدوین
- `src/project-core/ProjectLifecycleAndMigrationEngine.ts`، `GranularDataDeletionManager.ts` و `BackupAndEnvironmentRestoreManager.ts` — مهاجرت نسخه، بازیابی رسانه، حذف ۸ سطحی و پشتیبان‌گیری سه‌گانه
- `src/project-core/ProjectPackageBinaryArchiver.ts` و `DawTimelineInterchangeExporter.ts` — آرشیو باینری `.paudio` (`PAPK`) و خروجی استاندارد Audition (`.sesx`) و Reaper (`.rpp`)
- `src/project-core/JobSchedulerAndConcurrencyController.ts` و `BatchProcessingOrchestrator.ts` — زمان‌بند هم‌زمانی و پردازش دسته‌ای با حافظه کراندار و رعایت کنترل کاربر
- `src/project-core/ProjectThreeWayMergeEngine.ts`، `ProjectVersionDiffEngine.ts`، `UserDecisionHistoryLedger.ts` و `ReleaseAndFeatureMaturityManager.ts` — ادغام سه‌طرفه (`3-Way Merge`)، مقایسه نسخه‌ها و بازگردانی انتخابی برش‌های قدیمی (`Cherry-Pick Restore`)، دفتر کل تاریخچه تصمیم‌های کاربر بدون آموزش خودکار مدل (بخش ۳۷) و مدیریت بلوغ قابلیت‌ها
- `src/runtime/CrashRecoveryAndSessionLock.ts`، `HardwareBenchmarkProfiler.ts` و `ResilientAiRuntime.ts` — قفل تب Web Locks، کالیبراسیون سخت‌افزار و بازگشت خودکار از `GPUDevice.lost`
- `src/security/AudioSecurityGuard.ts` و `OfflineCryptoVerifier.ts` — گارد Magic Bytes، مهار Decompression Bomb و پاک‌سازی لاگ‌های حریم خصوصی

## ۶. رابط کاربری استودیو، آفلاین-فرست، سرویس‌های Backend و دروازه‌های کیفیت (`src/ui/`, `src/components/`, `src/hooks/`, `src/sw/`, `src/quality-gate/`, `backend/`, `src/harness/`)
- `src/main.tsx` و `src/ui/bootstrap/StudioRootBootstrapper.tsx` — بوت‌استرپر کالیبراسیون سخت‌افزار و مسیریاب تطبیقی دسکتاپ/موبایل
- `src/sw/OfflineFirstServiceWorker.ts` و `public/sw.js` — سرویس‌ورکر آفلاین با تضمین هدرهای `COOP/COEP/CORP` و قفل به‌روزرسانی ایمن
- `src/components/WaveformCanvas.tsx`، `src/hooks/useAudioStudioController.ts` و `src/ui/waveform/LodWaveformCanvasRenderer.ts` — همگام‌ساز 60fps بدون Re-render، رندر هرم LOD در Canvas و نوار تشخیص انحراف زمانی و هم‌ترازسازی آنی (`Nudge / Align`)
- `src/ui/processing/InteractiveProcessingAndEqPanel.tsx` — پنل تعاملی اکوالایزر پارامتریک ۸ بانده با منحنی پاسخ فرکانسی زنده روی Canvas و تفکیک `Ephemeral Gesture` از `Committed Transaction`
- `src/ui/workspace/PersianTranscriptWorkspace.tsx` و `src/ui/desktop/DesktopAudioStudioApp.tsx` — محیط کاربری RTL دسکتاپ
- `src/ui/mobile/MobileCompanionWorkspace.tsx` — محیط تک‌دستی موبایل با مدیریت بودجه حافظه
- `src/ui/accessibility/AccessibleAudioStudioNavigator.ts` — ناوبری صفحه‌خوان فارسی (`ARIA Live`) و اسکراب شنیداری ۶۰ میلی‌ثانیه‌ای برای تدوینگران نابینا و کم‌بینا
- `src/ui/governance/ProvenanceAndSupportAuditPanel.tsx` — پنل شناسنامه منشأ AI و ممیزی گزارش پشتیبانی (بخش ۴۲)
- `src/ui/export/PersianAudiogramCanvasRenderer.ts` — رندر محلی قاب‌های ویدیویی ویدیو/موج صوتی و زیرنویس کارائوکه فارسی (`1080x1920` / `1080x1080`)
- `backend/db/schema.sql`، `migration_002_payments.sql`، `migration_003_cloud_jobs.sql`، `migration_004_model_rollout.sql`، `migration_005_outbox.sql`، `migration_006_enterprise_keys.sql`، `migration_007_billing_invoices.sql`، `backend/src/db/DatabaseMigrationRunner.ts`، `backend/src/PlatformLicenseService.ts`، `PlatformBackendServices.ts`، `BackendAuthAndPaymentService.ts`، `BackendLicenseAndModelRevocationService.ts`، `BackendApplicationFactory.ts`، `server.ts`، `auth/EnterpriseApiKeyAndQuotaManager.ts`، `billing/BackendBillingInvoiceAndUsageLedger.ts`، `security/ServerSideEncryptedModelVault.ts`، `asr-worker/NodeOnnxAsrBenchmarkRunner.ts`، `asr-worker/NodeStreamingAudioIngestTranscoder.ts`، `asr-worker/AsrWorkerSupervisorAndWatchdog.ts`، `asr-worker/NodeAsrModelSessionPool.ts`، `queue/BackendAsrJobQueueAndPool.ts`، `gateway/BackendExternalApiProxyService.ts`، `gateway/WebSocketLiveAsrGateway.ts`، `gateway/BackendBatchHttpSubmissionController.ts`، `cache/BackendReadThroughCacheAndMetrics.ts`، `rollout/BackendModelCanaryRolloutService.ts`، `ops/BackendJobOutboxAndAdvisoryLockService.ts`، `ops/BackendBackgroundCronDaemon.ts`، `ops/BackendAsrStageLatencyProfiler.ts`، `delivery/BackendTranscriptFormatterAndWebhookService.ts`، `analytics/ModelDeliveryEconomicsAnalyzer.ts` و ابزارهای CLI (`model-chunker-signer-cli.ts`، `BackendModelGateValidatorAndPublisher.ts`، `batch-persian-corpus-benchmark-cli.ts`، `AsrRegressionDiffRunner.ts`) — کارخانه یکپارچه Backend (`buildBackendApplication`)، موتور مهاجرت خودکار PostgreSQL با قفل مشورتی و کنترل Checksum، دیمن نگهداری پس‌زمینه، دروازه استریم زنده WebSocket با تراز بایت‌های فرد Int16 و Backpressure، کنترلر REST کارهای دسته‌ای سازمانی، استخر نشست‌های ONNX پیش‌گرم‌شده با شمارنده ارجاع و تخلیه LRU، گاوصندوق رمزنگاری پوششی وزن‌های مدل (`AES-256-GCM Envelope Encryption`)، پروفایلر صدک‌های تأخیر مراحل استنتاج (`P50/P95/P99`)، کلیدهای سازمانی B2B با کسر اتمیک سهمیه، دفتر کل فاکتورهای مالی تغییرناپذیر با مهر SHA-256، ناظر Watchdog کارگرهای استنتاج، صف، کش Single-Flight، انتشار تدریجی Canary، الگوی Transactional Outbox و تحویل خروجی `.srt`، `.TextGrid`، `.ctm` و Webhook امضاشده
- `src/core/VerticalSliceOrchestrator.ts` و `src/harness/SyntheticVerticalSliceHarness.ts` — ارکستراتور سرتاسری ۸ حوزه معماری و موتور اجرای آزمایشی سرتاسری کل زنجیره با صوت ترکیبی در حافظه
- `src/quality-gate/AutomatedQualityGateRunner.ts`، `EndToEndArchitectureComplianceSuite.ts`، `ReleaseReadinessSignOffAuditor.ts` و `src/quality-gate/__tests__/full-pipeline.spec.ts` — دروازه‌های کیفیت خودکار (۳۲ گیت)، ممیز نهایی آمادگی انتشار (بخش ۶۱ و ۶۵) و آزمون انطباق با ۳۲ قانون طلایی



