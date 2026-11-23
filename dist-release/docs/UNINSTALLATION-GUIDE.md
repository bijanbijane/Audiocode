# راهنمای حذف نصب ایمن (Safe Uninstallation Guide)

نصاب آواپرداز دو حالت حذف نصب را پشتیبانی می‌کند:
1. **حذف استاندارد (`STANDARD` — پیش‌فرض)**:
   - دستور: `node ./installer/uninstall.mjs --target=$HOME/AvaPardaz`
   - تمام فایل‌های برنامه، موتور بومی، مدل ASR و افزونه CEP حذف می‌شوند، اما پوشه `user-data/` (پروژه‌ها و تنظیمات کاربر) حفظ می‌شود.
2. **حذف کامل (`COMPLETE`)**:
   - دستور: `node ./installer/uninstall.mjs --complete --target=$HOME/AvaPardaz`
   - علاوه بر فایل‌های برنامه، تمام داده‌های کاربری، کش‌ها و تنظیمات نیز به‌طور کامل پاک می‌شوند.
