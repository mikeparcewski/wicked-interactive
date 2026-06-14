// AddSceneModal.jsx — "Add a scene" dialog for demo docs.
//
// Two modes:
//   append  — add a new step to demo.spec.mjs and re-record only that scene
//   rerecord — rewrite the full demo.spec.mjs and re-record from the beginning
//
// On submit the caller posts the request to chat (which wakes the agent) and
// opens the conversation widget so the user sees progress.
import { useEffect, useRef, useState } from "react";

export default function AddSceneModal({ open, onSubmit, onCancel }) {
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState("append");
  const textRef = useRef(null);

  useEffect(() => {
    if (open) {
      setDescription("");
      setMode("append");
      setTimeout(() => textRef.current?.focus(), 40);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = description.trim();
  const canSubmit = trimmed.length > 0;

  function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({ description: trimmed, mode });
  }

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal wi-modal--scene" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">Add a scene</h3>
        <p className="wi-modal__hint">
          Describe what you want to show in this scene — a feature, a flow, a specific moment.
          The agent will write the steps and record it.
        </p>
        <form onSubmit={submit}>
          <label className="wi-modal__field">
            What should this scene demonstrate?
            <textarea
              ref={textRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Show how a user creates a new project from the dashboard and sets the team members"
              rows={4}
              style={{ fontFamily: "var(--wi-font-sans)", fontSize: "13px", resize: "vertical" }}
            />
          </label>

          <fieldset className="wi-scene-mode">
            <legend className="wi-scene-mode__legend">Recording mode</legend>
            <label className={`wi-scene-mode__opt${mode === "append" ? " is-on" : ""}`}>
              <input
                type="radio" name="scene-mode" value="append"
                checked={mode === "append"} onChange={() => setMode("append")}
              />
              <span className="wi-scene-mode__icon">＋</span>
              <span className="wi-scene-mode__body">
                <strong>Add as a new scene</strong>
                <span>Appends this scene to the end of the recording. Faster — the rest stays as-is.</span>
              </span>
            </label>
            <label className={`wi-scene-mode__opt${mode === "rerecord" ? " is-on" : ""}`}>
              <input
                type="radio" name="scene-mode" value="rerecord"
                checked={mode === "rerecord"} onChange={() => setMode("rerecord")}
              />
              <span className="wi-scene-mode__icon">↺</span>
              <span className="wi-scene-mode__body">
                <strong>Re-record from the beginning</strong>
                <span>Rewrites the full demo with this scene woven in. Takes longer but keeps everything cohesive.</span>
              </span>
            </label>
          </fieldset>

          <div className="wi-modal__actions">
            <button type="submit" className="wi-btn wi-btn--primary" disabled={!canSubmit}>
              Get to work
            </button>
            <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
