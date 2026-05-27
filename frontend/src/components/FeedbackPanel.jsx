// FeedbackPanel.jsx — the form for the selected block. Lets the user EITHER write the
// exact replacement text (deterministic content-edit) OR give plain-language feedback that
// the supervising agent applies (structural-change), OR restyle it (style-edit).
import { useEffect, useState } from "react";
import { buildItem } from "../lib/feedbackStore.js";

// "Give feedback" is the default: business users describe what they want and the agent
// applies it. "Type exact text" is the literal-replace escape hatch for when you know
// precisely what it should say.
const MODES = [
  { id: "structural-change", label: "Give feedback", hint: "Describe what you want changed in your own words — the AI rewrites just this block." },
  { id: "content-edit", label: "Type exact text", hint: "Set this block to exactly what you type (no AI, instant)." },
  { id: "style-edit", label: "Restyle it", hint: "Change the text color." },
];

export default function FeedbackPanel({ selected, existing, onSubmit, onCancel }) {
  const [type, setType] = useState("structural-change");
  const [value, setValue] = useState("");
  const [color, setColor] = useState("");
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    setType(existing?.type || "structural-change");
    setValue(existing?.value ?? selected?.before ?? "");      // seed exact-text with current text
    setColor(existing?.style?.color ?? "");
    setInstruction(existing?.instruction ?? "");              // feedback starts empty
  }, [selected, existing]);

  if (!selected) return null;
  const mode = MODES.find((m) => m.id === type);

  function submit(e) {
    e.preventDefault();
    const fields = { selector: selected.selector, type, before: selected.before };
    if (type === "content-edit") fields.value = value;
    if (type === "style-edit") fields.style = color ? { color } : undefined;
    if (type === "structural-change") fields.instruction = instruction;
    onSubmit(buildItem(fields));
  }

  const canSubmit =
    (type === "content-edit" && value.trim().length > 0) ||
    (type === "structural-change" && instruction.trim().length > 0) ||
    (type === "style-edit" && !!color);

  return (
    <form className="wi-panel" onSubmit={submit}>
      <div className="wi-panel__head">
        <strong>{selected.tag}</strong> <code>{selected.selector}</code>
      </div>
      <div className="wi-panel__before">“{selected.before}”</div>

      <div className="wi-modes" role="tablist">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={type === m.id}
            className={`wi-mode${type === m.id ? " wi-mode--on" : ""}`}
            onClick={() => setType(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="wi-mode__hint">{mode?.hint}</p>

      {type === "content-edit" && (
        <label className="wi-field">
          New text
          <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} />
        </label>
      )}
      {type === "structural-change" && (
        <label className="wi-field">
          Your feedback
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={4}
            placeholder="e.g. make this punchier and cut it to one line"
          />
        </label>
      )}
      {type === "style-edit" && (
        <label className="wi-field">
          Text color
          <input type="color" value={color || "#000000"} onChange={(e) => setColor(e.target.value)} />
        </label>
      )}

      <div className="wi-panel__actions">
        <button type="submit" className="wi-btn" disabled={!canSubmit}>Add feedback</button>
        <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
