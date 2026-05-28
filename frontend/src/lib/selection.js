// selection.js — map a clicked/hovered node in the (same-origin) document iframe back to
// its data-wid anchor (ADR-0001). DOM-agnostic: works on anything with getAttribute +
// parentElement + textContent, so it unit-tests without a browser.

/** Walk up from a node to the nearest ancestor carrying a data-wid. */
export function nearestReviewable(node) {
  let el = node;
  while (el) {
    if (typeof el.getAttribute === "function" && el.getAttribute("data-wid")) return el;
    el = el.parentElement || el.parentNode || null;
  }
  return null;
}

const normText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The nearest ancestor section/container anchor (data-wid="section-N"), or null. */
export function nearestSection(el) {
  let cur = el?.parentElement || el?.parentNode || null;
  while (cur) {
    if (typeof cur.getAttribute === "function") {
      const w = cur.getAttribute("data-wid");
      if (w && w.startsWith("section-")) return w;
    }
    cur = cur.parentElement || cur.parentNode || null;
  }
  return null;
}

/** True if this element nests other wid-anchored elements — i.e. it's a composite
 *  (card, container) rather than a leaf (h2, p, single chip). `Change text` is a
 *  destructive replace, so the UI hides it for composites where the merged inner
 *  text isn't a meaningful edit target.
 */
function isComposite(el) {
  if (!el || typeof el.querySelector !== "function") return false;
  return el.querySelector("[data-wid]") != null;
}

/** Describe a reviewable element for the feedback panel + the `before` snapshot (AC-10). */
export function describe(el) {
  if (!el || typeof el.getAttribute !== "function") return null;
  const selector = el.getAttribute("data-wid");
  if (!selector) return null;
  return {
    selector,
    tag: String(el.tagName || "").toLowerCase(),
    before: normText(el.textContent),
    section: nearestSection(el),
    composite: isComposite(el),
  };
}
