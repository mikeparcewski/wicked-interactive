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

  test('judges run independent passes and post verdicts', async ({ page }) => {
    await gotoEditor(page);

    const a11yJudge = page.locator('.ed-judge[data-rev="a11y"]');
    await a11yJudge.scrollIntoViewIfNeeded();
    await a11yJudge.click();
    await expect(a11yJudge).toHaveClass(/is-passed/, { timeout: 10_000 });
    const verdict = page.locator('#edVerdicts .ed-verdict[data-rev="a11y"]');
    await expect(verdict).toHaveClass(/is-passed/);
    await expect(verdict).toContainText('Contrast passes WCAG AA');

    // A second judge posts its own row — verdicts accumulate independently.
    await page.locator('.ed-judge[data-rev="qe"]').click();
    await expect(page.locator('#edVerdicts .ed-verdict')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('#edVerdicts .ed-verdict[data-rev="qe"]')).toContainText(
      'Exports clean',
      { timeout: 10_000 },
    );
  });

  test('governed toggle routes the build through the crew gate; edits stay instant', async ({
    page,
  }) => {
    await gotoEditor(page);

    // Gate strip is absent in solo mode.
    await expect(page.locator('#edGate')).toBeHidden();

    // Flip governed ON — the draft rebuilds routed through the control plane.
    const govern = page.locator('#edGovern');
    await govern.scrollIntoViewIfNeeded();
    await govern.click();
    await expect(govern).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#edGate')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#edGate .ed-gate__chip').first()).toContainText('evidence');
    // …and the version history records it as a governed draft.
    await expect(page.locator('#edPips .ed-pip', { hasText: 'Governed draft' })).toBeVisible();

    // An instant point-at-block edit does NOT wait on the gate.
    await settleCanvas(page);
    await openSayBar(page, 's');
    await page.locator('.ed-say.is-open .ed-instr[data-instr="tighten"]').click();
    await expect(page.locator(BLOCK_TEXT('s'))).toHaveText('One page everyone can act on.');
    await expect(page.locator('#edGate')).toBeVisible();
    await expect(page.locator('#edCue')).toContainText(/instant edit/i);

    // Flip governed OFF — back to solo mode, gate gone, engine unchanged.
    await govern.click();
    await expect(govern).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#edGate')).toBeHidden();
  });
});
