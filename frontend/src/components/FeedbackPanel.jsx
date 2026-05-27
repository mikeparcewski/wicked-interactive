// FeedbackPanel.jsx — feedback for the selected block OR the whole section it sits in
// (ADR-0011). Modes: "Give feedback" (AI), "Type exact text" (literal, blocks only),
// "Restyle it" (text + background color, deterministic).
import { useEffect, useState } from "react";
import { buildItem } from "../lib/feedbackStore.js";

const MODES = [
  { id: "structural-change", label: "Give feedback", hint: "Describe what you want changed — the AI rewrites it." },
  { id: "content-edit", label: "Type exact text", hint: "Set this block to exactly what you type (no AI, instant)." },
  { id: "style-edit", label: "Restyle it", hint: "Change colors directly (no AI, instant)." },
];

export default function FeedbackPanel({ selected, existing, onSubmit, onCancel }) {
  const [target, setTarget] = useState("block");      // "block" | "section"
  const [type, setType] = useState("structural-change");
  const [value, setValue] = useState("");
  const [color, setColor] = useState("");
  const [background, setBackground] = useState("");
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    setTarget("block");
    setType(existing?.type || "structural-change");
    setValue(existing?.value ?? selected?.before ?? "");
    setColor(existing?.style?.color ?? "");
    setBackground(existing?.style?.background ?? "");
    setInstruction(existing?.instruction ?? "");
  }, [selected, existing]);

  if (!selected) return null;
  const hasSection = !!selected.section;

  // "Type exact text" would wipe a section's children — not offered for sections.
  const modes = target === "section" ? MODES.filter((m) => m.id !== "content-edit") : MODES;
  const effType = target === "section" && type === "content-edit" ? "structural-change" : type;
  const mode = modes.find((m) => m.id === effType) || modes[0];

  function submit(e) {
    e.preventDefault();
    const selector = target === "section" ? selected.section : selected.selector;
    const before = target === "section" ? null : selected.before;
    const fields = { selector, type: effType, before };
    if (effType === "content-edit") fields.value = value;
    if (effType === "style-edit") {
      const style = {};
      if (color) style.color = color;
      if (background) style.background = background;
      fields.style = Object.keys(style).length ? style : undefined;
    }
    if (effType === "structural-change") fields.instruction = instruction;
    onSubmit(buildItem(fields));
  }

  const canSubmit =
    (effType === "content-edit" && value.trim().length > 0) ||
    (effType === "structural-change" && instruction.trim().length > 0) ||
    (effType === "style-edit" && (!!color || !!background));

  return (
    <form className="wi-panel" onSubmit={submit}>
      <div className="wi-panel__head">
        <strong>{selected.tag}</strong> <code>{target === "section" ? selected.section : selected.selector}</code>
      </div>

      {hasSection && (
        <div className="wi-target" role="tablist">
          <button type="button" className={`wi-target__b${target === "block" ? " on" : ""}`} onClick={() => setTarget("block")}>This block</button>
          <button type="button" className={`wi-target__b${target === "section" ? " on" : ""}`} onClick={() => setTarget("section")}>Whole section</button>
        </div>
      )}

      {target === "block" && <div className="wi-panel__before">“{selected.before}”</div>}

      <div className="wi-modes" role="tablist">
        {modes.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={effType === m.id}
            className={`wi-mode${effType === m.id ? " wi-mode--on" : ""}`} onClick={() => setType(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="wi-mode__hint">{mode?.hint}</p>

      {effType === "content-edit" && (
        <label className="wi-field">New text
          <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} />
        </label>
      )}
      {effType === "structural-change" && (
        <label className="wi-field">Your feedback
          <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={4}
            placeholder={target === "section" ? "e.g. this is too dark — lighten the background" : "e.g. make this punchier and cut it to one line"} />
        </label>
      )}
      {effType === "style-edit" && (
        <div className="wi-field">
          <label className="wi-color">Background <input type="color" value={background || "#ffffff"} onChange={(e) => setBackground(e.target.value)} /></label>
          <label className="wi-color">Text <input type="color" value={color || "#000000"} onChange={(e) => setColor(e.target.value)} /></label>
        </div>
      )}

      <div className="wi-panel__actions">
        <button type="submit" className="wi-btn" disabled={!canSubmit}>Add this edit</button>
        <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
