/**
 * prefers-reduced-motion: reduce — the page must load with zero pageerror
 * events and every key section visible. Both canned engines special-case
 * reduced motion (no autoplay, instant assembles), so this guards that path.
 */
import { test, expect } from './fixtures';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

test.describe('reduced motion', () => {
  test('page loads clean and every key section is visible', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await page.goto('/');

    // Hero editor renders and assembles (instantly under reduced motion).
    await expect(page.locator('#editor')).toBeVisible();
    await expect(page.locator('#edDoc .ed-block')).toHaveCount(4);
    await expect(page.locator('#edDoc .ed-block--building')).toHaveCount(0);

    // Walk the rooms — each must be present and visible.
    for (const selector of [
      '.band.demo',
      '.band.io',
      '.band.hood',
      '.band.plane',
      '.same-garden',
      '.closer',
    ]) {
      const section = page.locator(selector);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
    }

    // Demo player must NOT autoplay under reduced motion — station 1 holds.
    const player = page.locator('#vidPlayer');
    await player.scrollIntoViewIfNeeded();
    await expect(page.locator('#vS1')).toHaveClass(/is-on/);

    // Shared chrome still there.
    await expect(page.locator('.topbar')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
