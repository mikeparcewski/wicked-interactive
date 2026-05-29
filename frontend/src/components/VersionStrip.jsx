// VersionStrip.jsx — navigate every version via a dropdown (AC-20..22). Scales past the
// chip strip as history grows. Nothing is ever unreachable.
export default function VersionStrip({ manifest, viewing, onView }) {
  if (!manifest) return null;
  const versions = [...manifest.versions].sort((a, b) => a.version - b.version);
  return (
    <label className="wi-vsel" aria-label="version history">
      <span className="wi-vsel__icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 8v4l3 2" />
        </svg>
      </span>
      <select value={viewing ?? manifest.head} onChange={(e) => onView(Number(e.target.value))}>
        {versions.map((v) => (
          <option key={v.version} value={v.version}>
            v{v.version}
            {v.version === manifest.head ? " — head" : ""}
            {v.parent != null ? ` (from v${v.parent})` : " (original)"}
          </option>
        ))}
      </select>
    </label>
  );
}
