// FeedbackPanel.jsx — the form for the selected block. Captures a schema-shaped item.
import { useEffect, useState } from "react";
import { buildItem } from "../lib/feedbackStore.js";

const TYPES = [
  { id: "content-edit", label: "Change the text" },
  { id: "style-edit", label: "Restyle it" },
  { id: "structural-change", label: "Rework it (AI)" },
];

export default function FeedbackPanel({ selected, existing, onSubmit, onCancel }) {
  const [type, setType] = useState("content-edit");
  const [value, setValue] = useState("");
  const [color, setColor] = useState("");
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    // Seed the form from the block's current state / any existing pending edit.
    setType(existing?.type || "content-edit");
    setValue(existing?.value ?? selected?.before ?? "");
    setColor(existing?.style?.color ?? "");
    setInstruction(existing?.instruction ?? "");
  }, [selected, existing]);

  if (!selected) return null;

  function submit(e) {
    e.preventDefault();
    const fields = { selector: selected.selector, type, before: selected.before };
    if (type === "content-edit") fields.value = value;
    if (type === "style-edit") fields.style = color ? { color } : undefined;
    if (type === "structural-change") fields.instruction = instruction;
    onSubmit(buildItem(fields));
  }

  return (
    <form className="wi-panel" onSubmit={submit}>
      <div className="wi-panel__head">
        <strong>{selected.tag}</strong> <code>{selected.selector}</code>
      </div>
      <div className="wi-panel__before">“{selected.before}”</div>

      <label className="wi-field">
        What do you want to change?
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>

      {type === "content-edit" && (
        <label className="wi-field">
          New text
          <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} />
        </label>
      )}
      {type === "style-edit" && (
        <label className="wi-field">
          Text color
          <input type="color" value={color || "#000000"} onChange={(e) => setColor(e.target.value)} />
        </label>
      )}
      {type === "structural-change" && (
        <label className="wi-field">
          Describe the change (AI will apply it)
          <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3}
            placeholder="e.g. make this more concise and punchy" />
        </label>
      )}

      <div className="wi-panel__actions">
        <button type="submit" className="wi-btn">Add feedback</button>
        <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
