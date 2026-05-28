// VersionStrip.jsx — navigate every version via a dropdown (AC-20..22). Scales past the
// chip strip as history grows. Nothing is ever unreachable.
export default function VersionStrip({ manifest, viewing, onView }) {
  if (!manifest) return null;
  const versions = [...manifest.versions].sort((a, b) => a.version - b.version);
  return (
    <label className="wi-vsel" aria-label="version history">
      Current Version
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
