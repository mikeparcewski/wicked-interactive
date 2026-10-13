// deck-review.js — a deck's review store (DES-PRESENTATION-EDITOR-001 I-D2, the approvals half):
// per-slide decisions, the deck's audience, and an open audience proposal. One JSON file beside the
// manifest (`deck-review.json`), written atomically; the routes call these inside the doc's FIFO,
// so a write never races a version.
//
//  - A decision names the version it was given on; the slide's content hash THERE is stored with it,
//    so a later version can tell whether the slide still reads as it was approved (D5).
//  - The audience is the deck's recorded one (D8: exec / eng / customer, or custom words).
//  - A proposal is an audience change in flight (D3): the version it adapts (`base`) and the audience.
//    Kept, the audience becomes the proposal's; dropped, the caller has already restored `base`.
//    Only one is open at a time.
//
// Honest limit: under crew's `auth=off` nothing here can prove a person clicked. Studio is the only
// surface that offers these writes (approving is a human action in studio, never a plugin message).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, loadManifest, readVersionHtml } from "./fsstore.js";
import { ancestry, getVersion } from "../core/versions.js";
import { isDeckManifest } from "../core/deck.js";
import { audienceProblem, decisionProblem, decisionRow, reviewOf, slideHashes } from "../core/deck-review.js";

const FILE = "deck-review.json";
/** Decisions kept per deck: the oldest beyond this are dropped (a review record, not an audit log). */
const KEEP = 5000;

export function readStore(dir) {
  const path = join(dir, FILE);
  if (!existsSync(path)) return { decisions: [], audience: null, proposal: null };
  try {
    const s = JSON.parse(readFileSync(path, "utf-8"));
    return {
      // Only rows that read as decisions (codex r1): one damaged row never breaks the review.
      decisions: Array.isArray(s.decisions) ? s.decisions.filter((d) => decisionRow(d) !== null) : [],
      audience: typeof s.audience === "object" && s.audience !== null && typeof s.audience.preset === "string" ? s.audience : null,
      proposal: typeof s.proposal === "object" && s.proposal !== null && Number.isInteger(s.proposal.base) && typeof s.proposal.preset === "string" ? s.proposal : null,
    };
  } catch {
    // A file that cannot be read is no review: answered empty, never a crash. The next write replaces it.
    return { decisions: [], audience: null, proposal: null };
  }
}

function writeStore(dir, store) {
  atomicWrite(join(dir, FILE), JSON.stringify(store, null, 2));
}

/** `{ error, status }` when the doc is not a deck or the version is not one it has. */
function versionProblem(dir, version) {
  const manifest = loadManifest(dir);
  if (!isDeckManifest(manifest)) return { status: 409, error: "not_a_deck" };
  if (version !== undefined && getVersion(manifest, version) == null) return { status: 404, error: `version ${version} does not exist` };
  return null;
}

const audienceOut = (a) => (a === null ? null : { preset: a.preset, label: a.label ?? null, version: a.version ?? null, at: a.at ?? null });

/** The review of `version` (default: the head): every slide with its decision, the audience, the open proposal. */
export function reviewFor(dir, version) {
  const manifest = loadManifest(dir);
  if (!isDeckManifest(manifest)) return { status: 409, error: "not_a_deck" };
  const v = version ?? manifest.head;
  if (getVersion(manifest, v) == null) return { status: 404, error: `version ${v} does not exist` };
  const store = readStore(dir);
  return {
    version: v,
    head: manifest.head,
    audience: audienceOut(store.audience),
    proposal: store.proposal,
    slides: reviewOf(slideHashes(readVersionHtml(dir, v)), store.decisions, new Set(ancestry(manifest, v))),
  };
}

/** Record one decision on a slide as it reads in `version`. */
export function recordDecision(dir, body, { now = () => new Date().toISOString() } = {}) {
  const problem = decisionProblem(body);
  if (problem) return { status: 400, error: problem };
  const bad = versionProblem(dir, body.version);
  if (bad) return bad;
  const slide = slideHashes(readVersionHtml(dir, body.version)).find((s) => s.slide_id === body.slide_id);
  if (slide === undefined) return { status: 422, error: `version ${body.version} has no slide ${body.slide_id}` };
  const store = readStore(dir);
  const row = {
    slide_id: body.slide_id, version: body.version, hash: slide.hash, decision: body.decision,
    note: typeof body.note === "string" && body.note.trim() !== "" ? body.note : null,
    author: typeof body.author === "string" ? body.author.slice(0, 100) : "studio", at: now(),
  };
  store.decisions = [...store.decisions, row].slice(-KEEP);
  writeStore(dir, store);
  return { decision: row };
}

/** Record the deck's audience, as of `version`. */
export function setAudience(dir, body, { now = () => new Date().toISOString() } = {}) {
  const problem = audienceProblem(body);
  if (problem) return { status: 400, error: problem };
  if (!Number.isInteger(body.version)) return { status: 400, error: "version is required" };
  const bad = versionProblem(dir, body.version);
  if (bad) return bad;
  const store = readStore(dir);
  store.audience = { preset: body.preset, label: typeof body.label === "string" ? body.label.trim() : null, version: body.version, at: now() };
  writeStore(dir, store);
  return { audience: audienceOut(store.audience) };
}

/** Open an audience proposal: `base` is the version it adapts. One at a time (409 when one is open). */
export function openProposal(dir, body, { now = () => new Date().toISOString() } = {}) {
  const problem = audienceProblem(body);
  if (problem) return { status: 400, error: problem };
  if (!Number.isInteger(body.base)) return { status: 400, error: "base (the version to adapt) is required" };
  const bad = versionProblem(dir, body.base);
  if (bad) return bad;
  const store = readStore(dir);
  if (store.proposal !== null) return { status: 409, error: "proposal_open", proposal: store.proposal };
  store.proposal = { base: body.base, preset: body.preset, label: typeof body.label === "string" ? body.label.trim() : null, at: now() };
  writeStore(dir, store);
  return { proposal: store.proposal };
}

/**
 * Close the open proposal. `kept` records the proposal's audience as of `version` (the version kept);
 * `dropped` records nothing else (the caller restored the base first, with the fork's `expect_head`).
 */
export function closeProposal(dir, body, { now = () => new Date().toISOString() } = {}) {
  if (body?.outcome !== "kept" && body?.outcome !== "dropped") return { status: 400, error: "outcome must be kept or dropped" };
  const store = readStore(dir);
  if (store.proposal === null) return { status: 409, error: "no_proposal" };
  const p = store.proposal;
  if (body.outcome === "kept") {
    if (!Number.isInteger(body.version)) return { status: 400, error: "version (the version kept) is required" };
    const bad = versionProblem(dir, body.version);
    if (bad) return bad;
    store.audience = { preset: p.preset, label: p.label, version: body.version, at: now() };
  }
  store.proposal = null;
  writeStore(dir, store);
  return { outcome: body.outcome, proposal: p, audience: audienceOut(store.audience) };
}
