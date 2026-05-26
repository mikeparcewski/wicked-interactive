// feedbackStore.js — framework-agnostic feedback state (pure functions over plain state).
// Maps the UI's pending edits onto the _v{x}.md item shape (see core/feedback-schema.js).

export const emptyFeedback = { items: [] };

/** Build a schema-shaped item from UI fields. Only the fields valid for `type` are kept. */
export function buildItem({ selector, type, before, value, style, classAdd, classRemove, instruction }) {
  const item = { selector, type };
  if (before != null) item.before = before;
  if (type === "content-edit") item.value = value;
  if (type === "style-edit") {
    if (style && Object.keys(style).length) item.style = style;
    if (classAdd && classAdd.length) item.class_add = classAdd;
    if (classRemove && classRemove.length) item.class_remove = classRemove;
  }
  if (type === "structural-change") item.instruction = instruction;
  else if (instruction) item.instruction = instruction; // optional human note on any type
  return item;
}

/** Insert or replace the item for a selector (one pending edit per block). */
export function upsertItem(state, item) {
  const items = state.items.filter((i) => i.selector !== item.selector);
  return { items: [...items, item] };
}

export function removeItem(state, selector) {
  return { items: state.items.filter((i) => i.selector !== selector) };
}

export function clearItems() {
  return { items: [] };
}

export function hasItem(state, selector) {
  return state.items.some((i) => i.selector === selector);
}

/** The POST /api/feedback body. */
export function toPayload(state) {
  return { items: state.items };
}
