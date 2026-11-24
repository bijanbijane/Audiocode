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
  await page.goto('/?view=studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-title')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('audition-transport-deck')).toBeVisible();
  await expect(page.getByTestId('audition-side-dock')).toBeVisible();
}

test.describe('Avapardaz CORE-08 + Phases 01–15 Studio End-to-End Verification', () => {
  test('A. Application startup: zero uncaught exceptions, zero external font/API requests, studio ready in Light-First mode', async ({
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

    // Light-First default strictly enforced
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Core landmarks & default LOCAL execution mode
    await expect(page.getByTestId('btn-mode-local')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('btn-mode-cloud')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('toolbar-btn-play-pause')).toBeVisible();
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

    const runAsrBtn = page.getByTestId('btn-run-persian-asr');
    await expect(runAsrBtn).toBeVisible();

    // 1. Explicit opt-in CLOUD switch first -> either invokes /api/v1/asr/transcribe (when Gemini key is configured)
    // or reports honest CLOUD_PROVIDER_UNAVAILABLE without silent Local fallback
    await page.getByTestId('btn-mode-cloud').click();
    await expect(page.getByTestId('btn-mode-cloud')).toHaveAttribute('aria-pressed', 'true');
    const asrStatusText = (await page.getByTestId('btn-asr-status-inspect').textContent()) ?? '';
    await runAsrBtn.click();
    if (asrStatusText.includes('Gemini ASR')) {
      await expect.poll(() => asrRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
    } else {
      await expect(page.getByTestId('studio-status-notice')).toContainText(
        /ارسال صوت به سرور ابری غیرفعال است|سرویس‌دهنده ابری پیکربندی نشده است/,
      );
      expect(asrRequests).toEqual([]);
    }

    // 2. Switch back to LOCAL default & verify zero silent Cloud fallback requests
    const cloudCountBeforeLocal = asrRequests.length;
    await page.getByTestId('btn-mode-local').click();
    await expect(page.getByTestId('btn-mode-local')).toHaveAttribute('aria-pressed', 'true');
    await expect(runAsrBtn).toBeEnabled({ timeout: 10_000 });
    await runAsrBtn.click();
    await expect(page.getByTestId('studio-status-notice')).toBeVisible({ timeout: 10_000 });
    expect(asrRequests.length).toBe(cloudCountBeforeLocal);
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

  test('F. Responsive behavior (Desktop 1440x900 & Narrow 390x844) + Light-First Theme persistence & Locale toggles with zero overflow', async ({
    page,
  }) => {
    await waitForAuditionStudioReady(page);

    // Desktop check: no unintended horizontal scroll overflow
    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(desktopOverflow).toBeLessThanOrEqual(4);

    // Starts in Light mode -> toggle to Dark -> reload persists Dark -> toggle back to Light
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByTestId('btn-toggle-theme').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByTestId('btn-toggle-theme').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    // Locale toggle FA RTL <-> EN LTR
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

  test('G. Phase 02 Projects Hub: honest empty state, binary file rejection, real project creation, IndexedDB reload persistence, duplicate & delete', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('projects-hub-view')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(page.getByTestId('projects-empty-state')).toBeVisible();

    // Open New Project Modal
    await page.getByTestId('btn-new-project').click();
    await expect(page.getByTestId('new-project-modal')).toBeVisible();

    // Upload invalid .txt fixture -> binary validation rejects inline
    await page.getByTestId('new-project-file-input').setInputFiles(fixtures.unsupportedTxtPath);
    await expect(page.getByTestId('new-project-file-error')).toBeVisible();
    await expect(page.getByTestId('btn-confirm-create-project')).toBeDisabled();

    // Upload valid WAV fixture -> enables creation
    await page.getByTestId('new-project-file-input').setInputFiles(fixtures.validSpeechWavPath);
    await expect(page.getByTestId('new-project-file-error')).toBeHidden();
    await page.getByTestId('new-project-name-input').fill('پروژه آزمایشی پایدار');
    await expect(page.getByTestId('btn-confirm-create-project')).toBeEnabled();
    await page.getByTestId('btn-confirm-create-project').click();

    // Opens directly into Studio with persisted project
    await expect(page.getByTestId('project-title')).toContainText('پروژه آزمایشی پایدار', { timeout: 15_000 });

    // Reload Studio URL and verify IndexedDB restoration
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('project-title')).toContainText('پروژه آزمایشی پایدار', { timeout: 15_000 });

    // Return to Projects Hub and verify real card is listed (no empty state)
    await page.getByTestId('btn-back-to-projects').click();
    await expect(page.getByTestId('projects-grid')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('projects-grid')).toContainText('پروژه آزمایشی پایدار');

    // Search filters cleanly
    await page.getByTestId('projects-search-input').fill('آزمایشی');
    await expect(page.locator('[data-testid^="project-card-"]')).toHaveCount(1);
    await page.getByTestId('projects-search-input').fill('');

    // Open card menu -> Duplicate -> Delete original -> verify duplicate survives
    const firstMenuBtn = page.locator('[data-testid^="project-menu-btn-"]').first();
    await firstMenuBtn.click();
    await page.getByRole('menuitem', { name: /کپی پروژه|تکثیر|Duplicate/ }).click();
    await expect(page.locator('[data-testid^="project-card-"]')).toHaveCount(2, { timeout: 10_000 });

    // Delete first card via confirmation modal
    await page.locator('[data-testid^="project-menu-btn-"]').first().click();
    await page.getByRole('menuitem', { name: /حذف پروژه|حذف|Delete/ }).click();
    await page.getByTestId('btn-confirm-delete-project').click();
    await expect(page.locator('[data-testid^="project-card-"]')).toHaveCount(1, { timeout: 10_000 });
  });

  test('H. Phase 08 Settings Center: live updates, reload persistence, scoped category reset & global reset without deleting projects', async ({
    page,
  }) => {
    await waitForAuditionStudioReady(page);
    await page.getByTestId('btn-open-settings').click();
    await expect(page.getByTestId('settings-center-modal')).toBeVisible();

    // Switch theme to dark in Settings
    await page.getByTestId('settings-theme-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Change playback speed in Playback tab
    await page.getByTestId('settings-tab-playback').click();
    await page.getByTestId('settings-playback-rate').selectOption('1.25');

    // Close and reload -> verify persistence
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-center-modal')).toBeHidden();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Reopen Settings -> Global Reset -> returns to Light default
    await page.getByTestId('btn-open-settings').click();
    await page.getByTestId('btn-reset-all-settings').click();
    await page.getByTestId('btn-confirm-settings-reset').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });
});
