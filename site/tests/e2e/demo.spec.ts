/**
 * Demo player (#vidPlayer) — the aim→explore→record→storyboard stepper.
 *
 * Timing model (from src/pages/index.astro):
 *  - An IntersectionObserver starts a 3.4s setInterval autoplay when the
 *    player scrolls into view, and stops it when it leaves.
 *  - A manual chapter click jumps immediately AND restarts the timer, so
 *    per-station assertions run inside a retried block (never fixed sleeps).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function gotoPlayer(page: Page) {
  await page.goto('/');
  const player = page.locator('#vidPlayer');
  await player.scrollIntoViewIfNeeded();
  await expect(player).toBeVisible();
}

test.describe('demo player', () => {
  test('autoplays to the next chapter once scrolled into view', async ({ page }) => {
    await gotoPlayer(page);

    // Station 0 ("Aim") is on at rest; the interval advances it within 3.4s.
    await expect(page.locator('#vS1')).toHaveClass(/is-on/);
    await expect
      .poll(() => page.locator('.vid-state.is-on').getAttribute('id'), { timeout: 20_000 })
      .not.toBe('vS1');
  });

  test('clicking a chapter jumps the playback to that chapter', async ({ page }) => {
    await gotoPlayer(page);

    // Jump to step 3 (Record) via the step ledger. The click restarts the
    // 3.4s autoplay timer, so assert the whole station inside the retry.
    const recordStep = page.locator('.vid-step[data-ledger="3"]');
    await recordStep.scrollIntoViewIfNeeded();
    await expect(async () => {
      await recordStep.click();
      await expect(page.locator('#vS3')).toHaveClass(/is-on/, { timeout: 1_500 });
      await expect(recordStep).toHaveClass(/is-active/, { timeout: 1_500 });
      await expect(page.locator('#vRecTime')).toHaveText('REC', { timeout: 1_500 });
      await expect(page.locator('#vUrl')).toHaveText('localhost:3000 · projects / new', {
        timeout: 1_500,
      });
    }).toPass({ timeout: 15_000 });

    // Jump to step 4 (Storyboard) via the timeline chapter button.
    const storyboardChapter = page.locator('#vC4');
    await expect(async () => {
      await storyboardChapter.click();
      await expect(page.locator('#vS4')).toHaveClass(/is-on/, { timeout: 1_500 });
      await expect(page.locator('#vDl')).toHaveClass(/done/, { timeout: 1_500 });
      await expect(page.locator('#vUrl')).toHaveText('storyboard.html · 4 chapters', {
        timeout: 1_500,
      });
    }).toPass({ timeout: 15_000 });
  });
});
