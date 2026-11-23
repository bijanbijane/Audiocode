# یادداشت‌های انتشار آواپرداز (Release Notes — v2.0.0-beta.1)

- **شناسه ساخت (Build ID)**: `avp-20261123-phase1ci-beta1`
- **کانال انتشار**: Controlled Beta (`Level 2 — BETA CANDIDATE`)
- **ویژگی‌های کلیدی**:
  1. معماری ورود صوت جریانی با حافظه کران‌دار $O(1)$ (`StreamingCanonicalAudioIngestion`) برای فایل‌های ۶۰ دقیقه‌ای زیر ۲۵۰ مگابایت.
  2. موتور بومی تشخیص گفتار فارسی `NativeSherpaStreamingRecognizer` با مدل `Reza2kn/Shenava-Rizeh` INT8 CTC.
  3. تجمیع‌کننده متن و خط زمانی کانونیکال `StreamingTranscriptAssembler` با دقت نمونه (Sample-Accurate) و رانش صفر در ۶۰ دقیقه.
  4. پل تدوین هوشمند غیرمخرب `NonDestructiveAudioEditingBridge` با حفظ ۱۰۰٪ فایل اصلی، Undo/Redo، تطابق کامل Preview و Export و خروجی Adobe Audition SESX.
  5. سامانه عیب‌یابی حافظ حریم خصوصی (Privacy-Safe Diagnostics) و ثبت بازخورد محلی کاربران بتا.
