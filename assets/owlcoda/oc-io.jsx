/* global React */
/* OwlCoda — composer, pickers, permissions, banners, rail. */

const OcIO = {};

/* --- composer --- */
OcIO.Composer = function Composer({ value = "", placeholder = "Type your message…", mode = "plan", attachments = [], queued = null, showPicker = null }) {
  return (
    <div className="oc-composer">
      {showPicker}
      {queued && (
        <div className="oc-queued-chip">
          <span className="tag">queued next</span>
          <span className="text">{queued}</span>
          <span className="dismiss">esc to cancel</span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="oc-attachments">
          {attachments.map((a, i) => (
            <span key={i} className="oc-attach">
              <span className="thumb">{a.kind === "img" ? "🖼" : a.kind === "file" ? "◰" : "@"}</span>
              <span className="name">{a.name}</span>
              {a.size && <span className="size">{a.size}</span>}
              <span className="x">×</span>
            </span>
          ))}
        </div>
      )}
      <div className="oc-composer-row">
        <span className="oc-prompt">
          <span>›</span>
          <span className="mode">{mode}</span>
        </span>
        <div style={{ color: value ? "var(--oc-ink)" : "var(--oc-ink-dim)", whiteSpace: "pre-wrap" }}>
          {value || placeholder}
          <span className="oc-cursor" />
        </div>
      </div>
    </div>
  );
};

/* --- slash picker --- */
OcIO.SlashPicker = function SlashPicker({ query = "", selected = 0 }) {
  const all = [
    { cmd: "/help",      desc: "Show commands and shortcuts",          shortcut: "?" },
    { cmd: "/model",     desc: "Switch model",                          shortcut: "" },
    { cmd: "/init",      desc: "Initialize project (OWLCODA.md)",       shortcut: "" },
    { cmd: "/clear",     desc: "Clear conversation",                    shortcut: "⌃L" },
    { cmd: "/compact",   desc: "Summarize to free up context",          shortcut: "" },
    { cmd: "/resume",    desc: "Resume a previous session",             shortcut: "" },
    { cmd: "/sessions",  desc: "Browse session history",                shortcut: "" },
    { cmd: "/settings",  desc: "Open settings",                         shortcut: "⌃," },
    { cmd: "/mcp",       desc: "Manage MCP servers",                    shortcut: "" },
    { cmd: "/cost",      desc: "Show token & cost usage",               shortcut: "" },
    { cmd: "/review",    desc: "Review pending changes",                shortcut: "" },
    { cmd: "/quit",      desc: "Exit OwlCoda",                          shortcut: "⌃D" },
  ];
  const filtered = all.filter(c => c.cmd.startsWith("/" + query));
  return (
    <div className="oc-picker">
      <div className="oc-picker-head">
        <span>slash commands {query && <span style={{ color: "var(--oc-accent)" }}>· /{query}</span>}</span>
        <span className="hint"><span className="oc-key">↑↓</span> move · <span className="oc-key">↵</span> run · <span className="oc-key">esc</span> close</span>
      </div>
      <div className="oc-picker-list">
        {filtered.map((c, i) => (
          <div key={c.cmd} className={`oc-picker-item slash ${i === selected ? "is-sel" : ""}`}>
            <span className="icon">{i === selected ? "▸" : ""}</span>
            <span className="cmd">{c.cmd}</span>
            <span className="desc">{c.desc}</span>
            <span className="shortcut">{c.shortcut}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* --- @ file picker --- */
OcIO.AtPicker = function AtPicker({ query = "", selected = 0 }) {
  const files = [
    { path: "src/terminal/App.tsx",              tag: "file" },
    { path: "src/terminal/components/Turn.tsx",  tag: "file" },
    { path: "src/terminal/theme.css",            tag: "file" },
    { path: "src-tauri/src/main.rs",             tag: "file" },
    { path: "src/terminal/",                     tag: "dir" },
    { path: "package.json",                      tag: "file" },
  ];
  return (
    <div className="oc-picker">
      <div className="oc-picker-head">
        <span>@ file reference {query && <span style={{ color: "var(--oc-accent)" }}>· {query}</span>}</span>
        <span className="hint"><span className="oc-key">↑↓</span> · <span className="oc-key">↵</span> attach · <span className="oc-key">esc</span></span>
      </div>
      <div className="oc-picker-list">
        {files.map((f, i) => (
          <div key={f.path} className={`oc-picker-item at ${i === selected ? "is-sel" : ""}`}>
            <span className="icon">{f.tag === "dir" ? "▸" : "·"}</span>
            <span className="path">
              {(() => {
                const idx = f.path.lastIndexOf("/");
                if (idx < 0) return f.path;
                return <><span className="dir">{f.path.slice(0, idx + 1)}</span>{f.path.slice(idx + 1)}</>;
              })()}
            </span>
            <span className="tag">{f.tag}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* --- model picker --- */
OcIO.ModelPicker = function ModelPicker({ selected = 1 }) {
  const models = [
    { id: "kimi-code",           label: "Kimi Code",    ctx: "128k",  cost: "key",      tag: "fast" },
    { id: "minimax-m27",         label: "MiniMax M27",  ctx: "128k",  cost: "key",      tag: "default" },
    { id: "qwen3.6-35b-a3b",     label: "Qwen 35B",     ctx: "256k",  cost: "local",    tag: "local" },
    { id: "gpt-oss-120b",        label: "GPT OSS 120B", ctx: "128k",  cost: "local",    tag: "max" },
  ];
  return (
    <div className="oc-picker">
      <div className="oc-picker-head">
        <span>select model</span>
        <span className="hint"><span className="oc-key">↑↓</span> · <span className="oc-key">↵</span> select · <span className="oc-key">esc</span></span>
      </div>
      <div className="oc-picker-list">
        {models.map((m, i) => (
          <div key={m.id} className={`oc-picker-item model ${i === selected ? "is-sel" : ""}`}>
            <span className="icon">{i === selected ? "●" : "○"}</span>
            <span className="cmd">{m.label}</span>
            <span className="desc">{m.ctx} ctx · {m.cost}</span>
            <span className="tag">{m.tag}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* --- permission / approval --- */
OcIO.Permission = function Permission({ kind = "read", action, target, risk, choices, danger = false }) {
  const cls = danger ? "is-danger" : kind === "write" ? "is-write" : kind === "exec" ? "is-exec" : "";
  const tag = danger ? "DANGEROUS" : kind.toUpperCase();
  return (
    <div className={`oc-perm ${cls}`}>
      <div className="oc-perm-head">
        <span className="oc-perm-tag">
          <span>{tag}</span>
          <span className="oc-perm-scope">requires approval</span>
        </span>
      </div>
      <div className="oc-perm-action">{action}</div>
      {target && <div className="oc-perm-target">{target}</div>}
      {risk && (
        <div className="oc-perm-risk">
          <span className="icon">⚠</span>{risk}
        </div>
      )}
      <div className="oc-perm-choices">
        {choices.map((c, i) => (
          <button key={i} className={`oc-choice ${c.primary ? "is-primary" : ""} ${c.danger ? "is-danger" : ""}`}>
            <span className="key">{c.key}</span>
            <span>{c.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

/* --- banner (error / update / rate-limit / info) --- */
OcIO.Banner = function Banner({ kind = "info", icon, title, body, actions = [] }) {
  const ic = icon || (kind === "err" ? "✗" : kind === "warn" ? "⚠" : kind === "ok" ? "✓" : "ⓘ");
  return (
    <div className={`oc-banner is-${kind}`}>
      <span className="icon">{ic}</span>
      <div>
        <div className="title">{title}</div>
        {body && <div className="body">{body}</div>}
      </div>
      <div className="actions">
        {actions.map((a, i) => (
          <button key={i} className={`oc-choice ${a.primary ? "is-primary" : ""}`}>
            {a.key && <span className="key">{a.key}</span>}
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

/* --- status rail --- */
OcIO.Rail = function Rail({ state = "ready", model = "sonnet-4.5", cwd = "~/mionyee-hermes", tokens = "8.2k/200k", cost = "$0.14", branch = "main", mcp = 3, hotkeys = ["↵ send", "⇧↵ newline", "⌃C interrupt"] }) {
  const stateLabel = {
    ready: "ready", busy: "thinking…", tool: "running tool", wait: "awaiting approval",
    queue: "task queued", err: "error", interrupt: "interrupting…",
  }[state] || state;
  const stateCls = { ready: "is-ready", busy: "is-busy", tool: "is-busy", wait: "is-warn", queue: "is-warn", err: "is-err", interrupt: "is-warn" }[state];
  return (
    <div className="oc-rail">
      <div className={`cell is-state ${stateCls}`}>
        <span className="pulse" />
        <span className="val">{stateLabel}</span>
      </div>
      <div className="cell">
        <span className="label">model</span>
        <span className="val">{model}</span>
      </div>
      <div className="cell">
        <span className="label">ctx</span>
        <span className="val">{tokens}</span>
      </div>
      <div className="cell">
        <span className="label">cost</span>
        <span className="val">{cost}</span>
      </div>
      <div className="cell">
        <span className="label">branch</span>
        <span className="val">{branch}</span>
      </div>
      <div className="cell">
        <span className="label">mcp</span>
        <span className="val" style={{ color: "var(--oc-ok)" }}>{mcp} on</span>
      </div>
      <div className="cell is-end">
        <span style={{ color: "var(--oc-ink-dim)" }}>{hotkeys.join(" · ")}</span>
      </div>
    </div>
  );
};

Object.assign(window, { OcIO });
