/**
 * The experience-plane room (#platform) — the honest platform story: three
 * positioning cards (two front doors / governed generation / additive attach)
 * plus the shared wicked-web SameGarden four-plane map, on which this site is
 * the non-link "you are here" card. Also covers the IO cards that drive the
 * editor (data-load) and jump to the demo (data-goto).
 */
import { test, expect } from './fixtures';

test.describe('experience-plane story', () => {
  test('platform room renders the three positioning cards and the four-plane map', async ({
    page,
  }) => {
    await page.goto('/');
    const platform = page.locator('#platform');
    await platform.scrollIntoViewIfNeeded();
    await expect(platform).toBeVisible();
    await expect(platform.locator('.plane-grid .hood-card')).toHaveCount(3);
    await expect(platform.locator('.plane-grid')).toContainText('Governed generation');
    await expect(platform.locator('.plane-grid')).toContainText('Additive attach');

    // The shared SameGarden map: 4 planes, and this site marked "you are here"
    // (its own card never self-promotes as a link).
    const map = page.locator('.same-garden');
    await map.scrollIntoViewIfNeeded();
    await expect(map).toBeVisible();
    await expect(map.locator('.sg-plane')).toHaveCount(4);
    const here = map.locator('.sg-card--here');
    await expect(here).toHaveCount(1);
    await expect(here).toContainText('wicked-interactive');
    await expect(here.locator('.sg-here-chip')).toHaveText('you are here');
    await expect(here.locator('a')).toHaveCount(0);
  });

  test('an IO card loads its format into the editor', async ({ page }) => {
    await page.goto('/');
    const deckCard = page.locator('.io-card[data-load="deck"]');
    await deckCard.scrollIntoViewIfNeeded();
    await deckCard.click();

    // The editor switches to the deck document and scrolls back into view.
    await expect(page.locator('#edUrl')).toContainText('seed-deck.html');
    await expect(page.locator('.ed-fmt[data-fmt="deck"]')).toHaveClass(/is-active/);
    await expect(page.locator('#editor')).toBeInViewport({ timeout: 10_000 });
  });
});
