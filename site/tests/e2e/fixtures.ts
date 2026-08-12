/**
 * Shared test fixtures — hermetic smoke runs.
 *
 * The Base layout loads Google Fonts from fonts.googleapis.com/gstatic.com;
 * `page.goto` waits for the load event, so a slow or unreachable font CDN
 * eats the whole test budget and flakes CI. Stub both hosts: the styles
 * resolve to an empty sheet (system-font fallback) and no glyph fetches
 * happen. Everything under test — markup, widget engines, first-party CSS —
 * still comes from the real preview server.
 */
import { test as base } from '@playwright/test';

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('https://fonts.googleapis.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );
    await context.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await use(context);
  },
});

export { expect } from '@playwright/test';
