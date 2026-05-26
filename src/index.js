// wicked-interactive — public API for the core engine (increment 1).
// Service, React frontend, LLM structural path, and export layer arrive in later increments.

export { instrument, collectWids, DEFAULT_REVIEWABLE } from "./core/instrument.js";
export { parseFeedback, serializeFeedback, TYPES } from "./core/feedback-schema.js";
export { regenerate, Inv2Error } from "./core/regenerate.js";
export { initManifest, addVersion, fork, getVersion, ancestry, allVersions } from "./core/versions.js";
