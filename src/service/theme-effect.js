// theme-effect.js — does a re-theme change anything a reader can see? (F8, e2e-1105)
//
// The theme is a BASE layer (core/theme.js): a document that sets its colours and fonts in its own
// CSS (every deck drafted before the drafting contract asked for `var(--wi-…)`) keeps them whatever
// theme it wears. Re-theming such a version only rewrites the theme block, so the bytes differ while
// the page looks identical — and the engine used to record that as "Restyled the theme, version N".
//
// So before a re-theme is recorded, both versions are rendered in headless Chromium and their PIXELS
// are compared: the whole page, at the desktop viewport and, when the document has media or container
// queries (or a media-scoped stylesheet), at a tablet and a phone viewport too (a change confined to
// another width band, or to print, is not seen). Pixels are the only comparison that agrees with a reader
// about opacity, occlusion, clipping, fonts that resolve to the same fallback, SVG paint servers, form
// controls and generated content. The render is sealed: page scripts off (a script-driven look is outside
// the theme contract), every network request refused, local assets inlined as the PDF export inlines
// them; finite CSS animations are fast-forwarded to their end and infinite ones cancelled (by Playwright's
// screenshot, which author CSS can't override), SVG animations paused at their start, the caret hidden.
// A version can't be judged, and says so, when its render isn't reproducible offline: a resource it
// references is remote or missing (or a request the render refused), it renders differently twice in a
// row at any width (an animated image), or it is too large. The PNGs of one browser's encoder carry no timestamp, so identical rasters are identical bytes.
//
// Chromium runs with its sandbox on (`WI_RENDER_NO_SANDBOX=1` opts out where a container can't
// provide one), one render at a time per process, the next starting only once the last browser is
// closed. One deadline covers the whole check, from the request's arrival (its wait in the document's
// queue and for another render included) to the last screenshot; at the deadline the browser is
// closed, which ends any render still in flight.

import { inlineHtml, launchRenderBrowser } from "./export.js";

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }];
const BAND = 4000;                  // px of page per screenshot pair: two bands in memory at a time
const MAX_HEIGHT = 200_000;         // px
const MAX_WIDTH = 20_000;           // px
const MAX_BYTES = 25 * 1024 * 1024; // inlined HTML
const RESPONSIVE = /@media\b|@container\b|<link\b[^>]*\bmedia\s*=|<style\b[^>]*\bmedia\s*=/i;

/** Thrown when the render could not run (no browser, a timeout): the change is unverified. */
export class ThemeCheckUnavailable extends Error {
  constructor(cause, hint = "wicked-interactive doctor --install") {
    super(`couldn't check that the new theme changes how this version looks: ${cause}`);
    this.code = "theme_check_unavailable";
    this.hint = hint;
  }
}
const BUSY = "try again in a moment";

/** Thrown when this version can't be rendered faithfully offline: the change can't be judged. */
export class ThemeCheckUnverifiable extends Error {
  constructor(reason) {
    super(reason);
    this.code = "theme_unverifiable";
  }
}

// One render at a time in this process: each holds a browser, and a burst of restyles across documents
// would otherwise start a browser apiece. `fn` returns `{ result, settled }`: the caller gets `result`; the
// next render starts once `settled` (this render's browser closed).
let gate = Promise.resolve();
function exclusive(fn) {
  const run = gate.then(fn);
  gate = run.then((r) => r.settled, () => {});
  return run.then((r) => r.result);
}

/** The document as the render sees it: local assets inlined; refused when anything it shows can't come along. */
function prepare(html, dir) {
  const { html: inlined, dependencies } = inlineHtml(html, { baseDir: dir, withReceipt: true });
  const missing = [...dependencies.remote, ...dependencies.unresolved];
  if (missing.length > 0) {
    throw new ThemeCheckUnverifiable(`this version uses ${missing.map((d) => d.ref).slice(0, 3).join(", ")}` +
      `${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}, which an offline render can't load, so whether ` +
      "the theme changes how it looks can't be checked");
  }
  if (Buffer.byteLength(inlined) > MAX_BYTES) throw new ThemeCheckUnverifiable("this version is too large to render for the check");
  return inlined;
}

/** Load a version into a page, settled: fonts ready, SVG animations paused, CSS animations finished; its size. */
async function load(page, html) {
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => {
    for (const svg of document.querySelectorAll("svg")) { svg.pauseAnimations?.(); svg.setCurrentTime?.(0); }
    return document.fonts.ready.then(() => undefined);
  });
  // A first capture fast-forwards finite animations, so the size is measured in their final layout.
  await page.screenshot({ animations: "disabled", caret: "hide", clip: { x: 0, y: 0, width: 1, height: 1 } });
  const size = await page.evaluate(() => ({
    width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, 1)),
    height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, 1)),
  }));
  if (size.height > MAX_HEIGHT || size.width > MAX_WIDTH) throw new ThemeCheckUnverifiable("this version is too large to render for the check");
  return size;
}

const shot = (page, y, width, height) => page.screenshot({
  fullPage: true, animations: "disabled", caret: "hide", type: "png", clip: { x: 0, y, width, height: Math.min(BAND, height - y) },
});

/** Whether two loaded pages look the same, compared band by band (two bands in memory at a time). */
async function samePixels(pageA, sizeA, pageB, sizeB) {
  if (sizeA.width !== sizeB.width || sizeA.height !== sizeB.height) return false;
  for (let y = 0; y < sizeA.height; y += BAND) {
    if (!(await shot(pageA, y, sizeA.width, sizeA.height)).equals(await shot(pageB, y, sizeB.width, sizeB.height))) return false;
  }
  return true;
}

/** Whether a version needs the tablet and phone widths too: media or container queries, a media-scoped sheet. */
export const isResponsive = (html) => RESPONSIVE.test(html);

/**
 * Whether `after` renders differently from `before`.
 * `expiresAt` (ms since epoch) is the request's own deadline, set when it arrived: time spent waiting in the
 * document's queue and for another render counts against it. Default: `deadlineMs` from now.
 * @returns {Promise<{ changed: boolean }>}
 * @throws {ThemeCheckUnverifiable} when the version can't be rendered faithfully offline
 * @throws {ThemeCheckUnavailable} when no browser can render it or the check overruns its deadline
 */
export async function themeEffect(before, after, { dir, deadlineMs = 30_000, expiresAt, launch = launchRenderBrowser, ...launchOpts } = {}) {
  const expiry = expiresAt ?? Date.now() + deadlineMs;
  if (Date.now() >= expiry) throw new ThemeCheckUnavailable("expired while waiting", BUSY);
  // Both are prepared before any browser starts: an unverifiable version costs no render.
  const a = prepare(before, dir), b = prepare(after, dir);
  // Read before and after inlining: an inlined `<link media=…>` sheet loses its `media` attribute.
  const viewports = [before, after, a, b].some(isResponsive) ? VIEWPORTS : VIEWPORTS.slice(0, 1);
  let browser = null, expired = false, timer;
  // The deadline runs from now, outside the render queue: a caller waiting for another render times out on time.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      browser?.close().catch(() => {}); // ends a render still in flight
      reject(new ThemeCheckUnavailable("the check ran past its deadline (the machine may be busy)", BUSY));
    }, Math.max(0, expiry - Date.now()));
  });
  deadline.catch(() => {});
  const checked = exclusive(async () => {
    // Checked against the clock too: the deadline's timer may not have fired yet when the gate opens.
    if (expired || Date.now() >= expiry) {
      expired = true;
      return { result: Promise.reject(new ThemeCheckUnavailable("expired while waiting", BUSY)), settled: Promise.resolve() };
    }
    const work = (async () => {
      const noSandbox = process.env.WI_RENDER_NO_SANDBOX === "1";
      try { browser = await launch({ ...launchOpts, sandbox: !noSandbox }); }
      catch (e) {
        throw new ThemeCheckUnavailable(`no browser to render it (${String(e?.message ?? e).split("\n")[0]})` +
          (noSandbox ? "" : "; where Chromium's sandbox can't run, set WI_RENDER_NO_SANDBOX=1"));
      }
      if (expired) return { changed: false }; // past the deadline: `settled` below closes it
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport, javaScriptEnabled: false });
        // Every request the inliner didn't account for is refused, and counted: a render that missed one can't be trusted.
        let refused = null;
        await context.route("**/*", (route) => {
          const url = route.request().url();
          if (/^(data|about|blob):/i.test(url)) return route.continue();
          refused ??= url;
          return route.abort();
        });
        const [pageA, pageB] = [await context.newPage(), await context.newPage()];
        const sizeA = await load(pageA, a);
        // The version against itself first, at every width: a page that renders differently twice can't be judged.
        const stable = await samePixels(pageA, sizeA, pageB, await load(pageB, a));
        const same = stable && await samePixels(pageA, sizeA, pageB, await load(pageB, b));
        await context.close();
        if (refused) throw new ThemeCheckUnverifiable(`this version loads ${refused.slice(0, 120)}, which an offline render can't, so whether the theme changes how it looks can't be checked`);
        if (!stable) throw new ThemeCheckUnverifiable("this version renders differently each time (an animated image or similar), so whether the theme changes how it looks can't be checked");
        if (!same) return { changed: true };
      }
      return { changed: false };
    })();
    // Whatever happens, a browser that launched (even after the deadline) is closed before the next render starts.
    const settled = work.catch(() => {}).finally(() => browser?.close().catch(() => {}));
    return { result: work, settled };
  });
  checked.catch(() => {}); // the race below handles it; this only keeps a late rejection from being reported
  try {
    return await Promise.race([deadline, checked]);
  } catch (e) {
    if (e instanceof ThemeCheckUnavailable || e instanceof ThemeCheckUnverifiable) throw e;
    throw new ThemeCheckUnavailable(String(e?.message ?? e).split("\n")[0]);
  } finally {
    clearTimeout(timer);
  }
}
