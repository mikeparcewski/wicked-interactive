// VersionStrip.jsx — navigate every version (AC-20..22). Nothing is ever unreachable.
export default function VersionStrip({ manifest, viewing, onView }) {
  if (!manifest) return null;
  const versions = [...manifest.versions].sort((a, b) => a.version - b.version);
  return (
    <div className="wi-strip" role="navigation" aria-label="version history">
      {versions.map((v) => {
        const classes = ["wi-chip"];
        if (v.version === viewing) classes.push("wi-chip--active");
        if (v.version === manifest.head) classes.push("wi-chip--head");
        return (
          <button
            key={v.version}
            className={classes.join(" ")}
            onClick={() => onView(v.version)}
            title={v.parent == null ? "original" : `forked/edited from v${v.parent}`}
          >
            v{v.version}
            {v.version === manifest.head && <span className="wi-chip__head">head</span>}
          </button>
        );
      })}
    </div>
  );
}
