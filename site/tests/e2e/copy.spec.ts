/**
 * Install copy buttons (.install__copy) — both closer install cards copy their
 * command via navigator.clipboard and confirm inline ("Copy" → "Copied",
 * reverting after ~1.4s). Clipboard access needs explicit Playwright
 * permissions in Chromium.
 */
import { test, expect } from './fixtures';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('install copy buttons', () => {
  test('both buttons write their command to the clipboard and confirm', async ({ page }) => {
    await page.goto('/');
    const buttons = page.locator('.install__copy');
    await expect(buttons).toHaveCount(2);
    await buttons.first().scrollIntoViewIfNeeded();

    // Primary: the family installer one-liner.
    await buttons.nth(0).click();
    await expect(buttons.nth(0)).toHaveText('Copied');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('npx wicked-installer');
    // …and the label reverts so it can be used again.
    await expect(buttons.nth(0)).toHaveText('Copy', { timeout: 5_000 });

    // Secondary: the direct Claude Code plugin install pair.
    await buttons.nth(1).click();
    await expect(buttons.nth(1)).toHaveText('Copied');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('/plugin install wicked-interactive');
  });
});
