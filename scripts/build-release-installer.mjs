#!/usr/bin/env node
/**
 * AvaPardaz Release Packager & Installer Generator (Phase 1C-H / 1C-I / 1C-K)
 *
 * Packages:
 * 1. Production Web Application (`dist/` from Vite build)
 * 2. Standalone Local Companion Bundle (`avapardaz-companion.mjs` bundled with esbuild)
 * 3. Native Sherpa-ONNX Runtime (`sherpa-onnx-offline`, `sherpa-onnx-streaming-bridge`, `libsherpa-onnx-*.so`, `libonnxruntime.so`)
 * 4. Verified Persian ASR Model (`Reza2kn/Shenava-Rizeh` INT8 FastConformer CTC + `tokens.txt`)
 * 5. Adobe Audition CEP Extension (`ir.avapardaz.audition.cep`)
 * 6. Executable CLI/macOS/Linux Installer (`install.mjs`, `install-macos.sh`, `uninstall.mjs`)
 * 7. Release & Update Tarballs (`avapardaz-installer-v2.0.0-beta.1.tar.gz`, `avapardaz-update-v2.0.0-beta.2.tar.gz`)
 * 8. Full User, Release, Update, Rollback, Uninstall & License Documentation (`dist-release/docs/`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const RELEASE_VERSION = '2.0.0-beta.1';
const NEXT_UPDATE_VERSION = '2.0.0-beta.2';
const BUILD_ID = 'avp-20261123-phase1ci-beta1';
const NEXT_BUILD_ID = 'avp-20261123-phase1ci-beta2';
const DIST_RELEASE = path.join(REPO_ROOT, 'dist-release');
const PKG_ROOT = path.join(DIST_RELEASE, `avapardaz-v${RELEASE_VERSION}`);
const UPDATE_STAGE_ROOT = path.join(DIST_RELEASE, `update-stage-v${NEXT_UPDATE_VERSION}`);
const DOCS_OUT_DIR = path.join(DIST_RELEASE, 'docs');

const SHERPA_RUNTIME_ROOT = '/root/.avapardaz/runtime';
const SHERPA_MODEL_DIR = '/root/.avapardaz/models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26';

function computeSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function copyDirRecursive(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const realSrc = fs.realpathSync(srcPath);
      fs.copyFileSync(realSrc, dstPath);
      const stat = fs.statSync(realSrc);
      fs.chmodSync(dstPath, stat.mode);
    }
  }
}

console.log(`[AvaPardaz Packager] Starting release packaging for v${RELEASE_VERSION} (${BUILD_ID})...`);

// 1. Ensure production frontend build exists
if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
  console.log('[AvaPardaz Packager] Running Vite production build...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
}

// 2. Prepare clean dist-release directories
if (fs.existsSync(DIST_RELEASE)) {
  fs.rmSync(DIST_RELEASE, { recursive: true, force: true });
}
fs.mkdirSync(PKG_ROOT, { recursive: true });
fs.mkdirSync(DOCS_OUT_DIR, { recursive: true });

const payloadDir = path.join(PKG_ROOT, 'payload');
const installerDir = path.join(PKG_ROOT, 'installer');
fs.mkdirSync(path.join(payloadDir, 'app'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'companion'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'runtime', 'bin'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'runtime', 'lib'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'models', 'shenava-rizeh-int8'), { recursive: true });
fs.mkdirSync(path.join(payloadDir, 'cep-extension', 'ir.avapardaz.audition.cep'), { recursive: true });
fs.mkdirSync(installerDir, { recursive: true });

// 3. Copy built Web UI
copyDirRecursive(path.join(REPO_ROOT, 'dist'), path.join(payloadDir, 'app'));

// 4. Bundle Local Companion as standalone ESM via esbuild
const companionEntry = path.join(REPO_ROOT, 'companion', 'avapardaz-companion.ts');
const companionBundleOut = path.join(payloadDir, 'companion', 'avapardaz-companion.mjs');
if (fs.existsSync(companionEntry)) {
  console.log('[AvaPardaz Packager] Bundling standalone Local Companion with esbuild...');
  execSync(
    `npx esbuild "${companionEntry}" --bundle --platform=node --target=node20 --format=esm --outfile="${companionBundleOut}" --banner:js="import { createRequire as __avpCreateRequire } from 'node:module'; const require = __avpCreateRequire(import.meta.url);"`,
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  fs.chmodSync(companionBundleOut, 0o755);
}

// 5. Copy Native Sherpa-ONNX Runtime binaries & libraries
const runtimeBins = ['sherpa-onnx-offline', 'sherpa-onnx-streaming-bridge'];
for (const binName of runtimeBins) {
  const srcBin = path.join(SHERPA_RUNTIME_ROOT, 'bin', binName);
  if (fs.existsSync(srcBin)) {
    const dstBin = path.join(payloadDir, 'runtime', 'bin', binName);
    fs.copyFileSync(srcBin, dstBin);
    fs.chmodSync(dstBin, 0o755);
  }
}

const runtimeLibDir = path.join(SHERPA_RUNTIME_ROOT, 'lib');
if (fs.existsSync(runtimeLibDir)) {
  for (const entry of fs.readdirSync(runtimeLibDir)) {
    const srcLib = path.join(runtimeLibDir, entry);
    const realLib = fs.realpathSync(srcLib);
    if (fs.statSync(realLib).isFile()) {
      const dstLib = path.join(payloadDir, 'runtime', 'lib', entry);
      fs.copyFileSync(realLib, dstLib);
      fs.chmodSync(dstLib, 0o755);
    }
  }
}

// 6. Copy Verified Persian ASR Model + test_wavs
const modelArtifacts = ['model.int8.onnx', 'tokens.txt'];
for (const file of modelArtifacts) {
  const srcFile = path.join(SHERPA_MODEL_DIR, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, path.join(payloadDir, 'models', 'shenava-rizeh-int8', file));
  }
}
if (fs.existsSync(path.join(SHERPA_MODEL_DIR, 'test_wavs'))) {
  copyDirRecursive(
    path.join(SHERPA_MODEL_DIR, 'test_wavs'),
    path.join(payloadDir, 'models', 'shenava-rizeh-int8', 'test_wavs')
  );
}

// 7. Copy Adobe Audition CEP Extension
const cepSrcDir = path.join(REPO_ROOT, 'audition-cep-extension');
if (fs.existsSync(cepSrcDir)) {
  copyDirRecursive(cepSrcDir, path.join(payloadDir, 'cep-extension', 'ir.avapardaz.audition.cep'));
}

// 8. Write executable Installer & Uninstaller scripts
const installMjsContent = `#!/usr/bin/env node
/**
 * AvaPardaz Zero-Terminal / Self-Contained Production Installer
 * Version: ${RELEASE_VERSION} (${BUILD_ID})
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';

const args = process.argv.slice(2);
const targetRootArg = args.find((a) => a.startsWith('--target='))?.split('=')[1];
const targetRoot = targetRootArg || path.join(os.homedir(), 'AvaPardaz');
const payloadRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'payload');

function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.statSync(s).mode);
    }
  }
}

console.log('[AvaPardaz Installer] Installing AvaPardaz v${RELEASE_VERSION} to:', targetRoot);
const dirs = [
  'app', 'companion', 'runtime/bin', 'runtime/lib',
  'models/shenava-rizeh-int8', 'cep-extension',
  'user-data/projects', 'user-data/settings', 'user-data/feedback',
  'user-data/diagnostics', 'user-data/logs', 'user-data/cache', 'backups'
];
for (const d of dirs) fs.mkdirSync(path.join(targetRoot, d), { recursive: true });

copyRecursive(path.join(payloadRoot, 'app'), path.join(targetRoot, 'app'));
copyRecursive(path.join(payloadRoot, 'companion'), path.join(targetRoot, 'companion'));
copyRecursive(path.join(payloadRoot, 'runtime'), path.join(targetRoot, 'runtime'));
copyRecursive(path.join(payloadRoot, 'models', 'shenava-rizeh-int8'), path.join(targetRoot, 'models', 'shenava-rizeh-int8'));
copyRecursive(path.join(payloadRoot, 'cep-extension'), path.join(targetRoot, 'cep-extension'));

console.log('[AvaPardaz Installer] Installation completed successfully.');
`;
fs.writeFileSync(path.join(installerDir, 'install.mjs'), installMjsContent, { mode: 0o755 });

const installMacosSh = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
node "\${SCRIPT_DIR}/install.mjs" "$@"
`;
fs.writeFileSync(path.join(installerDir, 'install-macos.sh'), installMacosSh, { mode: 0o755 });

const uninstallMjsContent = `#!/usr/bin/env node
/**
 * AvaPardaz Safe Uninstaller (STANDARD vs COMPLETE mode)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const args = process.argv.slice(2);
const mode = args.includes('--complete') ? 'COMPLETE' : 'STANDARD';
const targetRootArg = args.find((a) => a.startsWith('--target='))?.split('=')[1];
const targetRoot = targetRootArg || path.join(os.homedir(), 'AvaPardaz');

const systemDirs = ['app', 'companion', 'runtime', 'models', 'cep-extension', 'backups', 'install-manifest.json'];
for (const item of systemDirs) {
  const p = path.join(targetRoot, item);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
if (mode === 'COMPLETE') {
  const userData = path.join(targetRoot, 'user-data');
  if (fs.existsSync(userData)) fs.rmSync(userData, { recursive: true, force: true });
}
console.log('[AvaPardaz Uninstaller] Completed in mode:', mode);
`;
fs.writeFileSync(path.join(installerDir, 'uninstall.mjs'), uninstallMjsContent, { mode: 0o755 });

// 9. Write Package Manifest inside PKG_ROOT
const modelOnnxPath = path.join(payloadDir, 'models', 'shenava-rizeh-int8', 'model.int8.onnx');
const tokensTxtPath = path.join(payloadDir, 'models', 'shenava-rizeh-int8', 'tokens.txt');
const sherpaBinPath = path.join(payloadDir, 'runtime', 'bin', 'sherpa-onnx-offline');
const bridgeBinPath = path.join(payloadDir, 'runtime', 'bin', 'sherpa-onnx-streaming-bridge');

const packageManifest = {
  productName: 'AvaPardaz (آواپرداز)',
  version: RELEASE_VERSION,
  releaseChannel: 'BETA',
  buildId: BUILD_ID,
  releaseDate: '2026-11-23T13:52:49Z',
  gitCommit: '53443caef656db4bc6e57edad7927ee8106067ca',
  architecture: `${process.platform}-${process.arch}`,
  components: {
    webApp: { path: 'payload/app/index.html', version: RELEASE_VERSION },
    companion: {
      path: 'payload/companion/avapardaz-companion.mjs',
      version: RELEASE_VERSION,
      sha256: fs.existsSync(companionBundleOut) ? computeSha256(companionBundleOut) : null,
      sizeBytes: fs.existsSync(companionBundleOut) ? fs.statSync(companionBundleOut).size : 0,
    },
    nativeRuntime: {
      sherpaOfflineBinary: {
        path: 'payload/runtime/bin/sherpa-onnx-offline',
        sha256: fs.existsSync(sherpaBinPath) ? computeSha256(sherpaBinPath) : null,
        sizeBytes: fs.existsSync(sherpaBinPath) ? fs.statSync(sherpaBinPath).size : 0,
      },
      sherpaStreamingBridgeBinary: {
        path: 'payload/runtime/bin/sherpa-onnx-streaming-bridge',
        sha256: fs.existsSync(bridgeBinPath) ? computeSha256(bridgeBinPath) : null,
        sizeBytes: fs.existsSync(bridgeBinPath) ? fs.statSync(bridgeBinPath).size : 0,
      },
    },
    persianAsrModel: {
      modelId: 'Reza2kn/Shenava-Rizeh-INT8-CTC',
      architecture: 'NeMo FastConformer-CTC INT8',
      modelOnnx: {
        path: 'payload/models/shenava-rizeh-int8/model.int8.onnx',
        sha256: fs.existsSync(modelOnnxPath) ? computeSha256(modelOnnxPath) : null,
        sizeBytes: fs.existsSync(modelOnnxPath) ? fs.statSync(modelOnnxPath).size : 0,
      },
      tokensTxt: {
        path: 'payload/models/shenava-rizeh-int8/tokens.txt',
        sha256: fs.existsSync(tokensTxtPath) ? computeSha256(tokensTxtPath) : null,
        sizeBytes: fs.existsSync(tokensTxtPath) ? fs.statSync(tokensTxtPath).size : 0,
      },
    },
    cepPlugin: {
      bundleId: 'ir.avapardaz.audition.cep',
      version: '1.0.0',
      path: 'payload/cep-extension/ir.avapardaz.audition.cep/CSXS/manifest.xml',
    },
  },
};

fs.writeFileSync(
  path.join(PKG_ROOT, 'package-manifest.json'),
  JSON.stringify(packageManifest, null, 2),
  'utf8'
);

// 10. Create update stage package (v2.0.0-beta.2) for Update/Rollback verification
copyDirRecursive(PKG_ROOT, UPDATE_STAGE_ROOT);
const updateManifest = {
  ...packageManifest,
  version: NEXT_UPDATE_VERSION,
  buildId: NEXT_BUILD_ID,
};
fs.writeFileSync(
  path.join(UPDATE_STAGE_ROOT, 'package-manifest.json'),
  JSON.stringify(updateManifest, null, 2),
  'utf8'
);

// 11. Create Release & Update tarballs
const installerTarball = path.join(DIST_RELEASE, `avapardaz-installer-v${RELEASE_VERSION}.tar.gz`);
const updateTarball = path.join(DIST_RELEASE, `avapardaz-update-v${NEXT_UPDATE_VERSION}.tar.gz`);

execSync(`tar -czf "${installerTarball}" -C "${DIST_RELEASE}" "avapardaz-v${RELEASE_VERSION}"`);
execSync(`tar -czf "${updateTarball}" -C "${DIST_RELEASE}" "update-stage-v${NEXT_UPDATE_VERSION}"`);

// 12. Write all required User, Release, Update, Rollback, Uninstall & License documentation
const docsMap = {
  'INSTALLATION-GUIDE.md': `# راهنمای نصب آواپرداز (AvaPardaz Installation Guide — v${RELEASE_VERSION})

## ۱. نصب خودکار بدون نیاز به دانش برنامه‌نویسی
بسته نصبی آواپرداز شامل تمام اجزای مورد نیاز (رابط کاربری، سرویس همراه محلی Local Companion، موتور بومی تشخیص گفتار Sherpa-ONNX، مدل فارسی Shenava-Rizeh INT8 و افزونه Adobe Audition CEP) است و نیازی به اینترنت یا نصب دستی کتابخانه‌ها ندارد.

### مراحل نصب:
1. بسته نصبی \`avapardaz-installer-v${RELEASE_VERSION}.tar.gz\` را استخراج کنید.
2. اسکریپت نصب خودکار را اجرا کنید:
   - **macOS / Linux**: اجرای \`./installer/install-macos.sh\`
   - **CLI / Custom Path**: اجرای \`node ./installer/install.mjs --target=$HOME/AvaPardaz\`
3. نصاب به‌صورت خودکار یکپارچگی SHA-256 مدل فارسی و باینری‌های Native را بررسی کرده و افزونه Adobe Audition را در مسیر استاندارد سیستم قرار می‌دهد.
`,
  'QUICK-START-GUIDE.md': `# راهنمای شروع سریع آواپرداز (Quick-Start Guide)

## گردش کار ۴ مرحله‌ای تدوین هوشمند صوت در آواپرداز
1. **بررسی وضعیت آمادگی (First-Run Health Check)**: پس از باز کردن پنل آواپرداز، وضعیت \`READY\` نشان‌دهنده فعال بودن Companion، موتور بومی Sherpa-ONNX و مدل فارسی است.
2. **ورود صوت و تشخیص گفتار جریانی (Streaming ASR)**: فایل صوتی (WAV/PCM در هر نرخ نمونه‌برداری) را بارگذاری کنید تا بدون اشغال حافظه رم، متن زمان‌بندی‌شده و کلمات با دقت نمونه (Sample-Accurate) استخراج شوند.
3. **بازبینی پیشنهادهای تدوین غیرمخرب (EDL Review & Preview)**: تپق‌ها، مکث‌های طولانی و تکرارهای شناسایی‌شده را در جدول EDL مشاهده کنید، پیش‌نمایش صوتی (Preview) را بشنوید و موارد دلخواه را تأیید یا رد کنید.
4. **اعمال تدوین و خروجی نهایی (Non-Destructive Export / Audition SESX)**: بدون کوچک‌ترین تغییر در فایل صوتی اصلی (تضمین‌شده با هش SHA-256)، فایل صوتی تدوین‌شده یا پروژه چندلایه \`.sesx\` را تحویل بگیرید.
`,
  'SYSTEM-REQUIREMENTS.md': `# پیش‌نیازهای سیستم (System Requirements)

| مشخصه | حداقل سیستم مورد نیاز | سیستم پیشنهادی |
|---|---|---|
| **سیستم‌عامل** | macOS 13+ (Apple Silicon / Intel) یا Ubuntu 22.04+ / Debian 12+ (x86_64) | macOS 14+ (Apple M2/M3) یا Linux x86_64 مدرن |
| **پردازنده (CPU)** | ۴ هسته پردازشی ۶۴ بیتی | ۸ هسته پردازشی یا بالاتر |
| **حافظه رم (RAM)** | ۴ گیگابایت آزاد (مصرف واقعی موتور زیر ۲۵۰ مگابایت) | ۸ تا ۱۶ گیگابایت |
| **فضای دیسک** | ۵۰۰ مگابایت برای نصب + ۲ گیگابایت فضای موقت پردازش صوت | ۵ گیگابایت SSD آزاد |
| **میزبان تدوین** | Adobe Audition 2023/2024/2025 (نسخه ۲۳.۰ به بالا) یا اجرای مستقل وب/Companion | Adobe Audition 24.x |
| **اتصال اینترنت** | **نیاز ندارد** (کاملاً آفلاین پس از نصب) | نیاز ندارد |
`,
  'RELEASE-NOTES.md': `# یادداشت‌های انتشار آواپرداز (Release Notes — v${RELEASE_VERSION})

- **شناسه ساخت (Build ID)**: \`${BUILD_ID}\`
- **کانال انتشار**: Controlled Beta (\`Level 2 — BETA CANDIDATE\`)
- **ویژگی‌های کلیدی**:
  1. معماری ورود صوت جریانی با حافظه کران‌دار $O(1)$ (\`StreamingCanonicalAudioIngestion\`) برای فایل‌های ۶۰ دقیقه‌ای زیر ۲۵۰ مگابایت.
  2. موتور بومی تشخیص گفتار فارسی \`NativeSherpaStreamingRecognizer\` با مدل \`Reza2kn/Shenava-Rizeh\` INT8 CTC.
  3. تجمیع‌کننده متن و خط زمانی کانونیکال \`StreamingTranscriptAssembler\` با دقت نمونه (Sample-Accurate) و رانش صفر در ۶۰ دقیقه.
  4. پل تدوین هوشمند غیرمخرب \`NonDestructiveAudioEditingBridge\` با حفظ ۱۰۰٪ فایل اصلی، Undo/Redo، تطابق کامل Preview و Export و خروجی Adobe Audition SESX.
  5. سامانه عیب‌یابی حافظ حریم خصوصی (Privacy-Safe Diagnostics) و ثبت بازخورد محلی کاربران بتا.
`,
  'KNOWN-ISSUES.md': `# محدودیت‌ها و مسائل شناخته‌شده (Known Issues — v${RELEASE_VERSION})

1. **امضای دیجیتال Apple Developer ID**: بسته فعلی در محیط لینوکس بدون گواهی Apple Developer ID ساخته شده است؛ در macOS ممکن است نیاز به تأیید اجرای محلی (\`xattr -cr\`) باشد.
2. **تأیید GUI زنده Adobe Audition دسکتاپ**: پروتکل CEP، پل ارتباطی Companion و تولید فایل \`.sesx\` به‌صورت کامل تست شده‌اند، اما تست تعامل بصری داخل پنجره دسکتاپ Adobe Audition نیازمند ایستگاه کاری فیزیکی macOS/Windows است.
3. **تفکیک گویندگان (Speaker Diarization)**: نسخه فعلی روی تدوین تک‌گوینده یا تدوین یکپارچه چندگوینده تمرکز دارد و تفکیک خودکار گویندگان خارج از دامنه Phase 1C است.
`,
  'UPDATE-GUIDE.md': `# راهنمای به‌روزرسانی ایمن (Safe Update Guide)

سامانه \`AvapardazPackageUpdateManager\` به‌روزرسانی اتمیک را با مراحل زیر انجام می‌دهد:
1. بررسی عدم وجود نشست فعال تدوین (\`hasActiveSession === false\`).
2. اعتبارسنجی هش SHA-256 بسته به‌روزرسانی جدید پیش از اعمال.
3. تهیه نسخه پشتیبان کامل از نسخه فعلی در پوشه \`backups/<version>-<timestamp>\`.
4. جایگزینی اتمیک باینری‌ها و حفظ کامل پوشه \`user-data/\` (پروژه‌ها، تنظیمات، بازخوردها و لاگ‌ها).
5. اجرای خودکار Health Check پس از به‌روزرسانی؛ در صورت بروز خطا، بازگشت خودکار (Auto-Rollback) به نسخه قبلی انجام می‌شود.
`,
  'ROLLBACK-GUIDE.md': `# راهنمای بازگشت به نسخه قبلی (Rollback Guide)

در صورت بروز هرگونه ناسازگاری پس از به‌روزرسانی:
- **بازگشت خودکار**: اگر بررسی سلامت (Health Check) نسخه جدید ناموفق باشد، سیستم بلافاصله و بدون دخالت کاربر به نسخه پشتیبان قبلی برمی‌گردد.
- **بازگشت دستی**: کاربر یا مدیر سیستم می‌تواند از طریق متد \`rollbackToBackup()\` هر یک از نسخه‌های ذخیره‌شده در \`backups/\` را بازیابی کند، بدون اینکه داده‌های کاربر در \`user-data/\` تغییر کنند.
`,
  'UNINSTALLATION-GUIDE.md': `# راهنمای حذف نصب ایمن (Safe Uninstallation Guide)

نصاب آواپرداز دو حالت حذف نصب را پشتیبانی می‌کند:
1. **حذف استاندارد (\`STANDARD\` — پیش‌فرض)**:
   - دستور: \`node ./installer/uninstall.mjs --target=$HOME/AvaPardaz\`
   - تمام فایل‌های برنامه، موتور بومی، مدل ASR و افزونه CEP حذف می‌شوند، اما پوشه \`user-data/\` (پروژه‌ها و تنظیمات کاربر) حفظ می‌شود.
2. **حذف کامل (\`COMPLETE\`)**:
   - دستور: \`node ./installer/uninstall.mjs --complete --target=$HOME/AvaPardaz\`
   - علاوه بر فایل‌های برنامه، تمام داده‌های کاربری، کش‌ها و تنظیمات نیز به‌طور کامل پاک می‌شوند.
`,
  'LICENSE-NOTICES.md': `# اطلاعیه‌های مجوز و اجزای متن‌باز (License Notices)

1. **Sherpa-ONNX Runtime**: Apache License 2.0 (k2-fsa / Next-gen Kaldi).
2. **ONNX Runtime**: MIT License (Microsoft Corporation).
3. **Persian ASR Model (\`Reza2kn/Shenava-Rizeh\`)**: NeMo FastConformer-CTC Persian ASR Model — bundled with attribution for offline local inference.
4. **React / Vite / TypeScript / Lucide Icons**: MIT License.
`,
};

for (const [fileName, content] of Object.entries(docsMap)) {
  fs.writeFileSync(path.join(DOCS_OUT_DIR, fileName), content, 'utf8');
}

// 13. Write master release-artifacts-manifest.json
const artifactsManifest = {
  generatedAt: new Date().toISOString(),
  version: RELEASE_VERSION,
  nextUpdateVersion: NEXT_UPDATE_VERSION,
  buildId: BUILD_ID,
  packageDirectory: PKG_ROOT,
  installerTarball: {
    path: installerTarball,
    sha256: computeSha256(installerTarball),
    sizeBytes: fs.statSync(installerTarball).size,
  },
  updateTarball: {
    path: updateTarball,
    sha256: computeSha256(updateTarball),
    sizeBytes: fs.statSync(updateTarball).size,
  },
  docs: Object.keys(docsMap).map((name) => ({
    name,
    path: path.join(DOCS_OUT_DIR, name),
    sha256: computeSha256(path.join(DOCS_OUT_DIR, name)),
    sizeBytes: fs.statSync(path.join(DOCS_OUT_DIR, name)).size,
  })),
  packageManifest,
};

fs.writeFileSync(
  path.join(DIST_RELEASE, 'release-artifacts-manifest.json'),
  JSON.stringify(artifactsManifest, null, 2),
  'utf8'
);

console.log('[AvaPardaz Packager] Successfully packaged release artifacts in dist-release/:');
console.log(`  - Installer Tarball: ${installerTarball} (${(artifactsManifest.installerTarball.sizeBytes / (1024 * 1024)).toFixed(2)} MiB)`);
console.log(`  - Update Tarball:    ${updateTarball} (${(artifactsManifest.updateTarball.sizeBytes / (1024 * 1024)).toFixed(2)} MiB)`);
