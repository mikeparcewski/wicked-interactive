/**
 * Editor simulation (#editor) — the hero's canned point-and-say engine.
 *
 * Timing model (from src/pages/index.astro):
 *  - Blocks stagger in with `.ed-block--building` (~260ms each); the engine
 *    ignores block clicks while `building` — so settle the canvas first.
 *  - An IntersectionObserver-armed auto-demo selects the HEADLINE block and
 *    applies "punchier" a few seconds after load unless the user acts first.
 *    Tests therefore interact with non-headline blocks, act early, and retry
 *    interactions until they take effect (never fixed sleeps).
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const BLOCK = (id: string) => `#edDoc .ed-block[data-id="${id}"]`;
const BLOCK_TEXT = (id: string) => `${BLOCK(id)} .ed-block__t`;

async function gotoEditor(page: Page) {
  await page.goto('/');
  const editor = page.locator('#editor');
  await editor.scrollIntoViewIfNeeded();
  await settleCanvas(page);
}

/** Wait until the staggered build animation is done (engine accepts clicks).
 *  ~1s at full speed, but generous: on a starved host the setTimeout chain
 *  can stretch far past the default expect budget. */
async function settleCanvas(page: Page) {
  await expect(page.locator('#edDoc .ed-block')).toHaveCount(4);
  await expect(page.locator('#edDoc .ed-block--building')).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Click a block until its say-bar (instruction chips) opens. Retried because
 * the engine drops clicks while building and the canned auto-demo can be
 * mid-flight on the very first interaction.
 */
async function openSayBar(page: Page, blockId: string) {
  const block = page.locator(BLOCK(blockId));
  await block.scrollIntoViewIfNeeded();
  await expect(async () => {
    await block.click();
    await expect(page.locator('.ed-say.is-open')).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
}

test.describe('editor simulation', () => {
  test('format tabs switch the editor mode', async ({ page }) => {
    await gotoEditor(page);

    const deckTab = page.locator('.ed-fmt[data-fmt="deck"]');
    await deckTab.scrollIntoViewIfNeeded();
    await deckTab.click();
    await expect(deckTab).toHaveClass(/is-active/);
    await expect(page.locator('.ed-fmt[data-fmt="brief"]')).not.toHaveClass(/is-active/);
    await expect(page.locator('#edUrl')).toContainText('seed-deck.html');
    await expect(page.locator('#edInput')).toHaveValue('Five-slide seed deck for demo day.');
    await expect(page.locator(BLOCK_TEXT('h'))).toHaveText(
      'Why we exist — the case for backing us now',
    );

    const pageTab = page.locator('.ed-fmt[data-fmt="page"]');
    await pageTab.click();
    await expect(pageTab).toHaveClass(/is-active/);
    await expect(page.locator('#edUrl')).toContainText('pricing-tool.html');
    await expect(page.locator(BLOCK_TEXT('h'))).toHaveText(
      'Pricing that finally makes sense for your team',
    );
  });

  test('prompt form builds a document in the canvas', async ({ page }) => {
    await gotoEditor(page);

    const input = page.locator('#edInput');
    await input.scrollIntoViewIfNeeded();
    await input.fill('One-page Q3 launch brief, rebuilt from the prompt.');
    await page.locator('#edPromptForm .ed-build').click();

    // The canvas rebuilds: kicker + 4 blocks, then the build cue settles.
    await expect(page.locator('#edDoc .ed-doc__kicker')).toHaveText('Q3 Launch · One-page brief');
    await expect(page.locator('#edDoc .ed-block')).toHaveCount(4);
    await settleCanvas(page);
    await expect(page.locator('#edCue')).toHaveAttribute('data-state', 'ready');
    // Typed prompt survives the rebuild (fromPrompt path).
    await expect(input).toHaveValue('One-page Q3 launch brief, rebuilt from the prompt.');
  });

  test('selecting a block shows instruction chips and reworks only that block', async ({ page }) => {
    await gotoEditor(page);

    // Use the SUBHEAD block — the auto-demo only ever touches the headline.
    await openSayBar(page, 's');
    const say = page.locator('.ed-say.is-open');
    await expect(say.locator('.ed-say__what')).toHaveText('Subhead');
    await expect(say.locator('.ed-instr')).toHaveText([
      'Punchier',
      'Warmer',
      'Add a stat',
      'Tighten',
    ]);

    await say.locator('.ed-instr[data-instr="warmer"]').click();
    await expect(page.locator(BLOCK_TEXT('s'))).toHaveText(
      'So everyone knows the plan — and feels part of it.',
    );
    // A version pip records the edit…
    await expect(page.locator('#edPips .ed-pip', { hasText: 'Warmer' })).toBeVisible();
    // …and untouched blocks held byte-for-byte.
    await expect(page.locator(BLOCK_TEXT('r1'))).toHaveText(
      'What ships: the new onboarding flow and the pricing refresh, together.',
    );
    await expect(page.locator(BLOCK_TEXT('r2'))).toHaveText(
      'Why now: renewals open in August — we want the story landed first.',
    );
  });

  test('version pips rewind to an earlier version', async ({ page }) => {
    await gotoEditor(page);

    // Make one edit so history has v0 (First draft) + v1 (the edit).
    await openSayBar(page, 'r1');
    await page.locator('.ed-say.is-open .ed-instr[data-instr="stat"]').click();
    await expect(page.locator(BLOCK_TEXT('r1'))).toHaveText(
      'What ships: two launches, one window, 40% faster onboarding.',
    );
    const editPip = page.locator('#edPips .ed-pip', { hasText: 'Add a stat' });
    await expect(editPip).toHaveClass(/is-active/);

    // Rewind via the v0 pip — the document reverts to the first draft.
    const v0 = page.locator('#edPips .ed-pip', { hasText: 'First draft' });
    await v0.scrollIntoViewIfNeeded();
    await expect(async () => {
      await v0.click();
      await expect(v0).toHaveClass(/is-active/, { timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    await expect(page.locator(BLOCK_TEXT('r1'))).toHaveText(
      'What ships: the new onboarding flow and the pricing refresh, together.',
    );
    await expect(editPip).not.toHaveClass(/is-active/);
  });
});
