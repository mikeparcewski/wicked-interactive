// EditSceneModal.jsx — edit the intent of an existing demo scene.
//
// Shows the current scene title and lets the user describe what should change.
// On submit the caller posts the request to chat so the agent updates demo.spec.mjs.
import { useEffect, useRef, useState } from "react";

export default function EditSceneModal({ open, scene, onSubmit, onCancel }) {
  const [description, setDescription] = useState("");
  const textRef = useRef(null);

  useEffect(() => {
    if (open) {
      setDescription("");
      setTimeout(() => textRef.current?.focus(), 40);
    }
  }, [open]);

  if (!open || !scene) return null;

  const trimmed = description.trim();

  function submit(e) {
    e.preventDefault();
    if (!trimmed) return;
    onSubmit({ scene, description: trimmed });
  }

  return (
    <div className="wi-modal-overlay" onClick={onCancel}>
      <div className="wi-modal wi-modal--scene" onClick={(e) => e.stopPropagation()}>
        <h3 className="wi-modal__title">Edit scene</h3>
        <p className="wi-modal__scene-label">
          <span className="wi-modal__scene-n">{String(scene.index + 1).padStart(2, "0")}</span>
          {scene.title}
        </p>
        <form onSubmit={submit}>
          <label className="wi-modal__field">
            What should change?
            <textarea
              ref={textRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. After clicking Sign in, wait for the dashboard to fully load before moving on"
              rows={4}
              style={{ fontFamily: "var(--wi-font-sans)", fontSize: "13px", resize: "vertical" }}
            />
          </label>
          <div className="wi-modal__actions">
            <button type="submit" className="wi-btn wi-btn--primary" disabled={!trimmed}>
              Update scene
            </button>
            <button type="button" className="wi-btn wi-btn--ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
