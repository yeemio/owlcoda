/* global React */
/* OwlCoda — diff / patch preview in apply_patch style. */

const OcDiff = {};

OcDiff.Diff = function Diff({ path, oldPath, plus = 0, minus = 0, hunks = [] }) {
  return (
    <div className="oc-diff">
      <div className="oc-diff-head">
        <span className="path">
          <PathSpan path={path} />
          {oldPath && oldPath !== path && (
            <span style={{ color: "var(--oc-ink-dim)", marginLeft: 6 }}>← {oldPath}</span>
          )}
        </span>
        <span className="stats">
          <span className="add">+{plus}</span>
          {" "}
          <span className="del">−{minus}</span>
        </span>
      </div>
      {hunks.map((h, i) => <Hunk key={i} hunk={h} />)}
    </div>
  );
};

function Hunk({ hunk }) {
  return (
    <div className="oc-diff-hunk">
      <div className="oc-diff-hunk-head">
        @@ −{hunk.oldStart},{hunk.oldLen} +{hunk.newStart},{hunk.newLen} @@
        {hunk.context && <span style={{ color: "var(--oc-ink-mute)", marginLeft: 10 }}>{hunk.context}</span>}
      </div>
      {hunk.lines.map((l, i) => {
        const cls = l.kind === "add" ? "is-add" : l.kind === "del" ? "is-del" : "";
        const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
        return (
          <div key={i} className={`oc-diff-line ${cls}`}>
            <span className="gutter">{l.oldNo ?? ""}</span>
            <span className="gutter">{l.newNo ?? ""}</span>
            <span className="code"><span className="sign">{sign}</span>{l.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function PathSpan({ path }) {
  if (!path) return null;
  const idx = path.lastIndexOf("/");
  if (idx < 0) return <span>{path}</span>;
  return <><span className="dir">{path.slice(0, idx + 1)}</span>{path.slice(idx + 1)}</>;
}

Object.assign(window, { OcDiff });
