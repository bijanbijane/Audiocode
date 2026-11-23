# راهنمای نصب آواپرداز (AvaPardaz Installation Guide — v2.0.0-beta.1)

## ۱. نصب خودکار بدون نیاز به دانش برنامه‌نویسی
بسته نصبی آواپرداز شامل تمام اجزای مورد نیاز (رابط کاربری، سرویس همراه محلی Local Companion، موتور بومی تشخیص گفتار Sherpa-ONNX، مدل فارسی Shenava-Rizeh INT8 و افزونه Adobe Audition CEP) است و نیازی به اینترنت یا نصب دستی کتابخانه‌ها ندارد.

### مراحل نصب:
1. بسته نصبی `avapardaz-installer-v2.0.0-beta.1.tar.gz` را استخراج کنید.
2. اسکریپت نصب خودکار را اجرا کنید:
   - **macOS / Linux**: اجرای `./installer/install-macos.sh`
   - **CLI / Custom Path**: اجرای `node ./installer/install.mjs --target=$HOME/AvaPardaz`
3. نصاب به‌صورت خودکار یکپارچگی SHA-256 مدل فارسی و باینری‌های Native را بررسی کرده و افزونه Adobe Audition را در مسیر استاندارد سیستم قرار می‌دهد.
