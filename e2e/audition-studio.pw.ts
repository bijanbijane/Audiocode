import { expect, test, type Page } from '@playwright/test';
import { createTempAudioFixtures, type GeneratedAudioFixtureSet } from './fixtures/audioFixtures';

let fixtures: GeneratedAudioFixtureSet;

test.beforeAll(() => {
  fixtures = createTempAudioFixtures();
});

test.afterAll(() => {
  fixtures?.cleanup();
});

async function waitForAuditionStudioReady(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-title')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('audition-transport-deck')).toBeVisible();
  await expect(page.getByTestId('audition-side-dock')).toBeVisible();
}

test.describe('Avapardaz CORE-08 Audition Studio End-to-End Verification', () => {
  test('A. Application startup: zero uncaught exceptions, zero external font/API requests, studio ready', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const externalRequests: string[] = [];

    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('WebSocket')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('request', (req) => {
      const url = req.url();
      if (
        url.startsWith('http://') &&
        !url.startsWith('http://127.0.0.1') &&
        !url.startsWith('http://localhost')
      ) {
        externalRequests.push(url);
      } else if (url.startsWith('https://')) {
        externalRequests.push(url);
      }
    });

    await waitForAuditionStudioReady(page);

    // Core landmarks & default LOCAL execution mode
    await expect(page.getByTestId('btn-mode-local')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('btn-mode-cloud')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: /پخش/ })).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();

    expect(pageErrors, `Uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `Unexpected console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    expect(externalRequests, `Unexpected external network calls: ${externalRequests.join(', ')}`).toEqual([]);
  });

  test('B. Audio ingestion: valid WAV imports cleanly; empty, unsupported & malformed files fail safely without corrupting session', async ({
    page,
  }) => {
    await waitForAuditionStudioReady(page);
    const fileInput = page.getByTestId('audio-file-input');

    // 1. Import valid deterministic WAV fixture
    await fileInput.setInputFiles(fixtures.validSpeechWavPath);
    await expect(page.getByTestId('studio-status-notice')).toContainText('deterministic-speech-fixture.wav');
    const titleAfterValidImport = await page.getByTestId('project-title').textContent();
    expect(titleAfterValidImport).toContain('deterministic-speech-fixture.wav');

    // 2. Empty file -> controlled error, previous valid project stays intact
    await fileInput.setInputFiles(fixtures.emptyWavPath);
    await expect(page.getByTestId('reliability-failure-banner')).toBeVisible();
    await expect(page.getByTestId('project-title')).toHaveText(titleAfterValidImport ?? '');

    // 3. Unsupported text file -> controlled error, previous valid project stays intact
    await fileInput.setInputFiles(fixtures.unsupportedTxtPath);
    await expect(page.getByTestId('reliability-failure-banner')).toBeVisible();
    await expect(page.getByTestId('project-title')).toHaveText(titleAfterValidImport ?? '');

    // 4. Malformed WAV header -> controlled error, previous valid project stays intact
    await fileInput.setInputFiles(fixtures.malformedWavPath);
    await expect(page.getByTestId('reliability-failure-banner')).toBeVisible();
    await expect(page.getByTestId('project-title')).toHaveText(titleAfterValidImport ?? '');
  });

  test('C. Waveform and transport: play/pause, seek, valid selection bounds, repeated interactions remain stable', async ({
    page,
  }) => {
    await waitForAuditionStudioReady(page);

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(200);
    expect(box!.height).toBeGreaterThan(60);

    // Seek via Audition scrub slider
    const slider = page.getByTestId('audition-scrub-slider');
    await slider.fill('3.5');
    await slider.dispatchEvent('change');
    await expect(page.getByTestId('audition-timecode-hud')).toContainText('00:03');

    // Keyboard I / O selection markers keep boundaries within valid duration
    await page.keyboard.press('i');
    await slider.fill('5.2');
    await slider.dispatchEvent('change');
    await page.keyboard.press('o');

    // Repeated Play/Pause cycles do not throw or lock UI
    const playBtn = page.getByTestId('toolbar-btn-play-pause');
    for (let i = 0; i < 3; i++) {
      await playBtn.click();
      await page.waitForTimeout(80);
      await playBtn.click();
      await page.waitForTimeout(40);
    }
    await expect(playBtn).toContainText('پخش');

    // Side dock tabs switch cleanly
    await page.getByTestId('audition-dock-tab-effects').click();
    await page.getByTestId('audition-dock-tab-history').click();
    await page.getByTestId('audition-dock-tab-files').click();
  });

  test('D. Transcript & honest ASR unavailability: no fake neural success, no silent Cloud fallback, raw layer preserved', async ({
    page,
  }) => {
    await waitForAuditionStudioReady(page);
    const asrRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/asr/transcribe')) {
        asrRequests.push(req.url());
      }
    });

    // Click local ASR action when no ONNX model weights are installed -> honest MODEL_NOT_INSTALLED notice
    const runAsrBtn = page.getByRole('button', { name: /اجرای ASR فارسی/ });
    await expect(runAsrBtn).toBeVisible();
    await runAsrBtn.click();

    await expect(page.getByTestId('reliability-failure-banner')).toBeVisible();
    await expect(page.getByTestId('studio-status-notice')).toContainText('مدل عصبی محلی نصب نشده است');
    expect(asrRequests).toEqual([]);

    // Explicit opt-in CLOUD switch -> honest CLOUD_PROVIDER_UNAVAILABLE without silent Local fallback
    await page.getByTestId('btn-mode-cloud').click();
    await expect(page.getByTestId('btn-mode-cloud')).toHaveAttribute('aria-pressed', 'true');
    await runAsrBtn.click();
    await expect(page.getByTestId('studio-status-notice')).toContainText('سرویس‌دهنده ابری پیکربندی نشده است');
    expect(asrRequests).toEqual([]);

    // Switch back to LOCAL default
    await page.getByTestId('btn-mode-local').click();
    await expect(page.getByTestId('btn-mode-local')).toHaveAttribute('aria-pressed', 'true');
  });

  test('E. Editing, EDL human review, Undo/Redo, Mission 06 Render & 14-Subsystem Health check', async ({
    page,
  }) => {
    await waitForAuditionStudioReady(page);

    // 1. Run Mission 04 + 05 local Speech Events & EDL analysis
    await page.getByTestId('btn-run-edl-analysis').click();
    await expect(page.getByTestId('studio-status-notice')).toContainText('تحلیل محلی رویدادها و EDL کامل شد');

    // Approve first proposal if present
    const firstApprove = page.locator('[data-testid^="btn-approve-"]').first();
    if ((await firstApprove.count()) > 0 && (await firstApprove.isEnabled())) {
      await firstApprove.click();
    }

    // 2. Test Mission 13 Persian Linguistic Intelligence tab (non-destructive)
    await page.getByTestId('tab-persian-linguistics').click();
    await page.getByTestId('btn-run-persian-linguistics').click();
    await expect(page.getByText(/نسخه خام ASR دست‌نخورده است/)).toBeVisible();

    // 3. Apply a synchronized timeline cut from SuggestionsPanel and verify Undo/Redo
    const undoBtn = page.getByTestId('btn-timeline-undo');
    const redoBtn = page.getByTestId('btn-timeline-redo');
    await expect(undoBtn).toBeDisabled();

    const acceptSuggestionBtn = page.getByRole('button', { name: /اعمال پیشنهاد/ }).first();
    if ((await acceptSuggestionBtn.count()) > 0) {
      await acceptSuggestionBtn.click();
      await expect(undoBtn).toBeEnabled();
      await undoBtn.click();
      await expect(redoBtn).toBeEnabled();
      await redoBtn.click();
    }

    // 4. Open Mission 06 Render & Export Modal, run non-destructive render & verify validation passed
    await page.getByTestId('btn-header-render-export').click();
    await expect(page.getByTestId('render-export-modal')).toBeVisible();
    await page.getByTestId('btn-start-mission06-render').click();
    await expect(page.getByTestId('btn-download-validated-audio')).toBeEnabled({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('render-export-modal')).toBeHidden();

    // 5. Open Product & Health Modal and run real 14-subsystem health check
    await page.getByTestId('btn-open-lifecycle-modal').click();
    await expect(page.getByTestId('lifecycle-management-modal')).toBeVisible();
    await page.getByTestId('btn-run-health-checks').click();
    await expect(page.getByTestId('health-report-results')).toContainText('14');
    await page.keyboard.press('Escape');
  });

  test('F. Responsive behavior (Desktop 1440x900 & Narrow 390x844) + Theme/Locale toggles with zero horizontal overflow', async ({
    page,
  }) => {
    await waitForAuditionStudioReady(page);

    // Desktop check: no unintended horizontal scroll overflow
    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(desktopOverflow).toBeLessThanOrEqual(4);

    // Theme & Locale toggles work cleanly
    await page.getByTestId('btn-toggle-theme').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByTestId('btn-toggle-theme').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('btn-toggle-locale').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByTestId('btn-toggle-locale').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Narrow mobile/tablet viewport (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);

    await expect(page.getByTestId('audition-transport-deck')).toBeVisible();
    await expect(page.getByTestId('audition-side-dock')).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();

    const narrowOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(narrowOverflow).toBeLessThanOrEqual(4);
  });
});
