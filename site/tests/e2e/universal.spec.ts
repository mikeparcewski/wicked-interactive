/**
 * Universal chrome — the shared wicked-web topbar (node_modules/wicked-web):
 * theme toggle (data-theme on <html> + localStorage 'wa-theme') and the
 * ecosystem dropdown (#projectsBtn / #projectsMenu).
 */
import { test, expect } from './fixtures';

test.describe('shared chrome', () => {
  test("theme toggle flips data-theme and persists via localStorage 'wa-theme'", async ({
    page,
  }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');

    await page.locator('#themeBtn').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wa-theme')))
      .toBe('dark');

    // Persists across reload (no-flash init in Base.astro reads localStorage).
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    // And toggles back.
    await page.locator('#themeBtn').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wa-theme')))
      .toBe('light');
  });

  test('ecosystem dropdown opens on click and closes on Escape', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('#projectsBtn');
    const menu = page.locator('#projectsMenu');

    await expect(menu).toBeHidden();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');

    await btn.click();
    await expect(menu).toBeVisible();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    // Four-plane nav taxonomy (wicked-web@61396e4): 5 products across 4 planes.
    await expect(menu.locator('.dropdown-plane')).toHaveCount(4);
    await expect(menu.locator('.dropdown-item')).toHaveCount(5);
    await expect(
      menu.locator('.dropdown-item', { hasText: 'interactive' }),
    ).toHaveAttribute('href', 'https://wi.wickedagile.com');

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});
