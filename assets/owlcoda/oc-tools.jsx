/* global React */
/* OwlCoda — tool call components: Bash, Read, Grep, LS, Edit, Write, Todo, WebFetch.
   All sharing a head + collapsible body pattern. */

const OcTool = {};

/* --- spinner --- */
OcTool.Spinner = function Spinner() {
  const [i, setI] = React.useState(0);
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  React.useEffect(() => {
    const t = setInterval(() => setI(x => (x + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return <span className="oc-spin">{frames[i]}</span>;
};

/* --- generic tool row --- */
OcTool.Call = function Call({
  verb, arg, meta, state = "ok", duration,
  defaultOpen = false, children,
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const stIcon = state === "ok" ? "✓" : state === "err" ? "✗" : state === "run" ? <OcTool.Spinner /> : "·";
  return (
    <div className="oc-tool">
      <div className="oc-tool-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="name">
          <span className="verb">{verb}</span>
          <span className="arg">{arg}</span>
          {meta && <span style={{ color: "var(--oc-ink-dim)", marginLeft: 8, fontSize: "var(--oc-fs-xs)" }}>{meta}</span>}
        </span>
        <span className="dur">{duration ?? ""}</span>
        <span className={`st ${state}`}>{stIcon}</span>
      </div>
      {open && <div className="oc-tool-body">{children}</div>}
    </div>
  );
};

/* --- Bash --- */
OcTool.Bash = function Bash({ cmd, cwd, stdout, stderr, exit = 0, duration, state = "ok", defaultOpen = false }) {
  return (
    <OcTool.Call
      verb="bash" arg={cmd}
      meta={cwd ? <span>in <span style={{ color: "var(--oc-ink-soft)" }}>{cwd}</span></span> : null}
      state={state} duration={duration} defaultOpen={defaultOpen}
    >
      {stdout && <div className="out">{stdout}</div>}
      {stderr && <div className="out-err" style={{ marginTop: stdout ? 6 : 0 }}>{stderr}</div>}
      <div className="exit">
        exit <span className={exit === 0 ? "ok" : "err"}>{exit}</span>
        {duration && <span style={{ marginLeft: 10 }}>· {duration}</span>}
      </div>
    </OcTool.Call>
  );
};

/* --- Read --- */
OcTool.Read = function Read({ path, lines, preview, state = "ok", duration, defaultOpen = false }) {
  return (
    <OcTool.Call
      verb="read" arg={<PathSpan path={path} />}
      meta={lines ? `${lines} lines` : null}
      state={state} duration={duration} defaultOpen={defaultOpen}
    >
      {preview && <div className="out" style={{ color: "var(--oc-ink-mute)" }}>{preview}</div>}
    </OcTool.Call>
  );
};

/* --- Grep --- */
OcTool.Grep = function Grep({ pattern, path, matches = [], state = "ok", duration, defaultOpen = false }) {
  return (
    <OcTool.Call
      verb="grep"
      arg={<><span style={{ color: "var(--oc-accent-bright)" }}>"{pattern}"</span>{path && <> in <span style={{ color: "var(--oc-ink-soft)" }}>{path}</span></>}</>}
      meta={`${matches.length} matches`}
      state={state} duration={duration} defaultOpen={defaultOpen}
    >
      {matches.slice(0, 8).map((m, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 40px 1fr", gap: 8 }}>
          <span style={{ color: "var(--oc-ink-mute)" }}>{m.file}</span>
          <span style={{ color: "var(--oc-ink-dim)", textAlign: "right" }}>{m.line}</span>
          <span style={{ color: "var(--oc-ink-soft)", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>{m.text}</span>
        </div>
      ))}
      {matches.length > 8 && <div className="more">+ {matches.length - 8} more matches</div>}
    </OcTool.Call>
  );
};

/* --- LS --- */
OcTool.Ls = function Ls({ path, entries = [], state = "ok", duration, defaultOpen = false }) {
  return (
    <OcTool.Call
      verb="ls" arg={<PathSpan path={path} />}
      meta={`${entries.length} items`}
      state={state} duration={duration} defaultOpen={defaultOpen}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0 14px" }}>
        {entries.map((e, i) => (
          <span key={i} style={{ color: e.dir ? "var(--oc-accent)" : "var(--oc-ink-soft)" }}>
            {e.dir ? `${e.name}/` : e.name}
          </span>
        ))}
      </div>
    </OcTool.Call>
  );
};

/* --- Edit --- */
OcTool.Edit = function Edit({ path, plus = 0, minus = 0, diff, state = "ok", duration, defaultOpen = true }) {
  return (
    <OcTool.Call
      verb="edit" arg={<PathSpan path={path} />}
      meta={<><span style={{ color: "var(--oc-ok)" }}>+{plus}</span> <span style={{ color: "var(--oc-err)" }}>-{minus}</span></>}
      state={state} duration={duration} defaultOpen={defaultOpen}
    >
      {diff}
    </OcTool.Call>
  );
};

/* --- Write (new file) --- */
OcTool.Write = function Write({ path, lines, state = "ok", duration, defaultOpen = false }) {
  return (
    <OcTool.Call
      verb="write" arg={<PathSpan path={path} />}
      meta={<><span style={{ color: "var(--oc-ok)" }}>+{lines}</span> new file</>}
      state={state} duration={duration} defaultOpen={defaultOpen}
    />
  );
};

/* --- WebFetch --- */
OcTool.WebFetch = function WebFetch({ url, state = "ok", duration, defaultOpen = false, children }) {
  return (
    <OcTool.Call
      verb="fetch" arg={<span style={{ color: "var(--oc-accent-bright)" }}>{url}</span>}
      state={state} duration={duration} defaultOpen={defaultOpen}
    >
      {children}
    </OcTool.Call>
  );
};

/* --- Todo list --- */
OcTool.Todo = function Todo({ items = [] }) {
  const done = items.filter(i => i.state === "done").length;
  const total = items.length;
  return (
    <div className="oc-todo">
      <div className="oc-todo-head">
        <span>task list</span>
        <span className="count">{done}/{total}</span>
      </div>
      <div className="oc-todo-list">
        {items.map((it, i) => {
          const cls = it.state === "done" ? "done" : it.state === "current" ? "current" : it.state === "blocked" ? "blocked" : "";
          const box = it.state === "done" ? "◼" : it.state === "current" ? "▸" : it.state === "blocked" ? "⚠" : "◻";
          return (
            <div key={i} className={`oc-todo-item ${cls}`}>
              <span className="box">{box}</span>
              <span>{it.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* --- helper: path with dimmed directory --- */
function PathSpan({ path }) {
  if (!path) return null;
  const idx = path.lastIndexOf("/");
  if (idx < 0) return <span style={{ color: "var(--oc-ink)" }}>{path}</span>;
  return (
    <span>
      <span style={{ color: "var(--oc-ink-dim)" }}>{path.slice(0, idx + 1)}</span>
      <span style={{ color: "var(--oc-ink)" }}>{path.slice(idx + 1)}</span>
    </span>
  );
}
OcTool.PathSpan = PathSpan;

Object.assign(window, { OcTool });
