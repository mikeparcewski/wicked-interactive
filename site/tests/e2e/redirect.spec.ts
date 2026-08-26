import { test, expect } from '@playwright/test';

/**
 * wi.wickedagile.com is a redirect now.
 *
 * The seven specs this replaces exercised a builder UI — an editor simulation, a demo player,
 * install-copy buttons — that no longer lives here. Keeping them green would have meant keeping a
 * page that sends visitors to a front door which does not open: the service itself answers a direct
 * visitor with "This is the wicked-interactive bridge — it serves the API, not the UI."
 *
 * What must hold now is narrower and load-bearing: the page states where the thing went, sends you
 * there by more than one mechanism, and does NOT imply the package was retired — it is still the
 * engine wicked-crew spawns, and telling people otherwise would strand a live dependency.
 */
const TARGET = 'https://ws.wickedagile.com';

test.describe('the redirect page', () => {
  test('points every mechanism at studio: canonical, refresh, and a real link', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', TARGET);
    // A meta-refresh alone strands anyone who blocks it, and a link alone strands anyone who
    // does not read. Both, plus canonical so the old URL stops competing in search.
    const refresh = page.locator('meta[http-equiv="refresh"]');
    await expect(refresh).toHaveAttribute('content', new RegExp(`url=${TARGET}$`));
    await expect(page.locator('a.go')).toHaveAttribute('href', TARGET);
  });

  test('says where it went, in the heading, not only in a redirect header', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('wicked-studio');
  });

  test('does NOT claim the package is retired — it is still the engine crew runs', async ({ page }) => {
    await page.goto('/');
    const body = await page.locator('body').innerText();
    // The distinction the whole page exists to make: the UI moved, the engine did not. Asserted
    // POSITIVELY — the first cut blacklisted the word "retired", which failed on the page's own
    // sentence "is not retired". Denying a claim plants it, so the copy states the fact instead
    // and the test checks the fact.
    expect(body).toMatch(/continues as the engine/i);
    expect(body).toMatch(/wicked-crew runs it/i);
  });

  test('the CTA is reachable by keyboard and visibly focusable', async ({ page }) => {
    await page.goto('/');
    const cta = page.locator('a.go');
    await cta.focus();
    await expect(cta).toBeFocused();
  });
});
