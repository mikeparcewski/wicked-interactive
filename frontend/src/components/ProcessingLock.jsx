// ProcessingLock.jsx — locks the stage while an edit is in flight (ADR-0012). Shows a
// spinner + status message, or the agent's clarifying question with option buttons.
export default function ProcessingLock({ active, message, question, options, onAnswer, onDismiss }) {
  if (!active) return null;
  return (
    <div className="wi-lock" role="alertdialog" aria-busy="true">
      <div className="wi-lock__card">
        {question ? (
          <>
            <p className="wi-lock__q">{question}</p>
            <div className="wi-lock__opts">
              {(options || []).map((o) => (
                <button key={o} className="wi-btn wi-btn--primary" onClick={() => onAnswer(o)}>{o}</button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="wi-spinner" aria-hidden="true" />
            <p className="wi-lock__msg">{message || "Working…"}</p>
          </>
        )}
        <button className="wi-lock__dismiss" onClick={onDismiss}>dismiss</button>
      </div>
    </div>
  );
}
