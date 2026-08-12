/**
 * Phone viewport (390x844, iPhone 12 dimensions) — the documented mobile
 * fallbacks from src/styles/interactive.css and the wicked-web topbar:
 *  - ≤760px: the faux demo player is dropped (`.vid-player { display: none }`)
 *    and the readable step ledger stays, restyled as cards.
 *  - ≤900px: the editor stage stacks to one column but stays functional.
 *  - ≤640px (topbar): the inline nav collapses behind the hamburger menu.
 */
import { test, expect } from './fixtures';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.describe('mobile fallbacks', () => {
  test('demo player is replaced by the step-ledger fallback on phones', async ({ page }) => {
    await page.goto('/');
    const ledger = page.locator('.vid-step-ledger');
    await ledger.scrollIntoViewIfNeeded();

    // The faux player is documented to drop out; the step stack carries the story.
    await expect(page.locator('#vidPlayer')).toBeHidden();
    const steps = page.locator('.vid-step');
    await expect(steps).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(steps.nth(i)).toBeVisible();
    }
    // Step hints are force-shown on phones (opacity: 1 !important).
    await expect(steps.first().locator('.vs-hint')).toHaveText('Your app URL + brief.');
  });

  test('editor still renders and builds in the stacked phone layout', async ({ page }) => {
    await page.goto('/');
    const editor = page.locator('#editor');
    await editor.scrollIntoViewIfNeeded();
    await expect(editor).toBeVisible();
    await expect(page.locator('#edDoc .ed-block')).toHaveCount(4);
    await expect(page.locator('#edDoc .ed-block--building')).toHaveCount(0);
    await expect(page.locator('#edDoc .ed-block[data-id="h"] .ed-block__t')).toHaveText(
      'Our Q3 launch, explained for the whole team',
    );
  });

  test('topbar collapses the ecosystem nav behind the hamburger', async ({ page }) => {
    await page.goto('/');
    // Desktop inline dropdown is hidden at phone width…
    await expect(page.locator('#projectsBtn')).toBeHidden();
    // …and the hamburger opens the mobile menu instead.
    const menuBtn = page.locator('#menuBtn');
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
    await expect(page.locator('#mobileMenu')).toBeVisible();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
    // 7 ecosystem rows + Medium + GitHub.
    await expect(page.locator('#mobileMenu .mm-item')).toHaveCount(9);
  });
});
