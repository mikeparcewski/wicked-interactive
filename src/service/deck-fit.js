import { load } from "cheerio";
import { getVersion } from "../core/versions.js";
import { loadManifest, readVersionHtml } from "./fsstore.js";
import { classifyLayout, inlineHtml, launchRenderBrowser } from "./export.js";
import { closed, CutError } from "./demo-cut.js";

/** Inspect the same top-level slides the export paginates, one at a time at 1080p, in their authored layout. */
export async function deckFit(dir, body = {}, opts = {}) {
  closed(body, ["version", "stated"], "body");
  const manifest = loadManifest(dir);
  const version = body.version ?? manifest.head;
  if (!Number.isInteger(version) || !getVersion(manifest, version)) throw new CutError("invalid_body", "version");
  if (body.stated !== undefined && (!Number.isInteger(body.stated) || body.stated < 0)) throw new CutError("invalid_body", "stated");
  const $ = load(inlineHtml(readVersionHtml(dir, version), { baseDir: dir }));
  const layout = classifyLayout($, { style: manifest.style });
  if (layout.layout !== "deck") throw new CutError("not_a_deck", null, 409);
  layout.slides.each((index, el) => { $(el).attr("data-wi-fit-index", index); });
  // The deck's own stated count: the first element carrying it (the body, or the deck root).
  const declared = $("[data-stated-slides]").first().attr("data-stated-slides");
  const count = declared === undefined || declared.trim() === "" ? null : Number(declared);
  const stated = body.stated ?? (Number.isInteger(count) && count >= 0 ? count : null);
  // The deck as authored, as the deck editor presents it: no export decoration, whose slide rules (flex column,
  // print media) would measure a different layout than the author's grid or block.
  const html = $.html();
  const browser = await launchRenderBrowser(opts);
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(html, { waitUntil: "networkidle" });
    // A deadline over the measurement itself: authored HTML can stall fonts.ready or a getter forever, and the
    // fit holds the document queue. The finally below closes the browser either way.
    const deadlineMs = opts.deadlineMs ?? 30_000;
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new CutError("fit_timeout", null, 504)), deadlineMs); });
    const slides = await Promise.race([deadline, page.evaluate(async () => {
      await document.fonts.ready;
      const elements = [...document.querySelectorAll("[data-wi-fit-index]")];
      // Each slide keeps its own layout (grid, block, flex): its computed display is read before hiding it.
      const displays = elements.map((el) => { const d = getComputedStyle(el).display; return d === "none" ? "block" : d; });
      for (const el of elements) el.style.setProperty("display", "none", "important");
      const results = [];
      for (const [index, el] of elements.entries()) {
        for (const [key, value] of Object.entries({ display: displays[index], width: "1920px", height: "1080px",
          "min-height": "1080px", "max-height": "1080px", "min-width": "1920px", "max-width": "1920px",
          "box-sizing": "border-box", visibility: "visible", opacity: "1", transform: "none" })) {
          el.style.setProperty(key, value, "important");
        }
        const overflowPx = Math.max(0, el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth);
        // The deck's own slide id (what deckOutline and the slide ops name), else the anchor for legacy content.
        results.push({ id: el.getAttribute("data-slide-id") ?? el.getAttribute("data-wid") ?? `slide-${index}`,
          index, overflowPx, overflow: overflowPx > 2 });
        el.style.setProperty("display", "none", "important");
      }
      return results;
    })]).finally(() => clearTimeout(timer));
    const actual = slides.length;
    return { version, slides, stated, actual, ok: slides.every((s) => !s.overflow) && (stated === null || stated === actual) };
  } finally {
    await browser.close();
  }
}
