/* global React */
/* OwlCoda — full-screen panels: sessions, settings, MCP, onboarding. */

const OcPanels = {};

/* --- session list --- */
OcPanels.Sessions = function Sessions({ selected = 0 }) {
  const sessions = [
    { id: "conv-177", title: "Terminal redesign — ANSI-first", repo: "mionyee-hermes",  time: "now",      turns: 34, star: true },
    { id: "conv-176", title: "Fix streaming jitter in renderer", repo: "mionyee-hermes",  time: "2h ago",   turns: 12 },
    { id: "conv-175", title: "Hello world",                    repo: "test-conv",        time: "yesterday", turns: 3  },
    { id: "conv-174", title: "Integrate MCP github server",     repo: "mionyee-hermes",  time: "yesterday", turns: 28 },
    { id: "conv-173", title: "Auth flow review",                repo: "internal-api",     time: "2d ago",    turns: 47 },
    { id: "conv-172", title: "SQL migration cleanup",           repo: "mionyee-hermes",  time: "3d ago",    turns: 19 },
    { id: "conv-171", title: "README polish",                   repo: "owlcoda",          time: "4d ago",    turns:  6 },
  ];
  return (
    <div className="oc-panel">
      <div className="oc-panel-head">
        <div className="oc-panel-title">
          <span className="crumb">owlcoda</span><span className="sep">/</span>
          <span>sessions</span>
        </div>
        <div className="oc-panel-hint">
          <span className="oc-key">↑↓</span> move · <span className="oc-key">↵</span> resume · <span className="oc-key">d</span> delete · <span className="oc-key">esc</span> close
        </div>
      </div>
      <div className="oc-panel-body" style={{ padding: 0 }}>
        {sessions.map((s, i) => (
          <div key={s.id} className={`oc-sess ${i === selected ? "is-sel" : ""}`}>
            <span className="mark">{s.star ? "★" : (i === selected ? "▸" : "·")}</span>
            <span className="title"><span className="id">{s.id}</span>{s.title}</span>
            <span className="repo">{s.repo}</span>
            <span className="turns">{s.turns} turns</span>
            <span className="time">{s.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* --- settings --- */
OcPanels.Settings = function Settings() {
  return (
    <div className="oc-panel">
      <div className="oc-panel-head">
        <div className="oc-panel-title">
          <span className="crumb">owlcoda</span><span className="sep">/</span>
          <span>settings</span>
        </div>
        <div className="oc-panel-hint"><span className="oc-key">esc</span> close · <span className="oc-key">tab</span> section · <span className="oc-key">space</span> toggle</div>
      </div>
      <div className="oc-panel-body">
        <div className="oc-set">
          <div className="oc-set-group-title">Model</div>
          <div className="oc-set-row">
            <div><div className="label">Default model</div><div className="desc">Used for new sessions.</div></div>
            <div className="value">minimax-m27</div>
            <div className="hint">change</div>
          </div>
          <div className="oc-set-row">
            <div><div className="label">Thinking</div><div className="desc">Show reasoning blocks inline.</div></div>
            <div className="value">extended</div>
            <div className="hint">off · standard · extended</div>
          </div>
          <div className="oc-set-row">
            <div><div className="label">Streaming</div><div className="desc">Tokens appear as they arrive.</div></div>
            <div /><div className="toggle on"><div className="knob" /></div>
          </div>
        </div>
        <div className="oc-set">
          <div className="oc-set-group-title">Approvals</div>
          <div className="oc-set-row">
            <div><div className="label">Read files</div><div className="desc">Allow the agent to read without asking.</div></div>
            <div /><div className="toggle on"><div className="knob" /></div>
          </div>
          <div className="oc-set-row">
            <div><div className="label">Write / edit</div><div className="desc">Ask before modifying files.</div></div>
            <div /><div className="toggle"><div className="knob" /></div>
          </div>
          <div className="oc-set-row">
            <div><div className="label">Execute commands</div><div className="desc">Ask for every shell command.</div></div>
            <div /><div className="toggle"><div className="knob" /></div>
          </div>
          <div className="oc-set-row">
            <div><div className="label">Auto-approve pattern</div><div className="desc">Bash commands matching this regex skip prompts.</div></div>
            <div className="value">^(git (status|diff|log)|ls|cat|rg)</div>
            <div className="hint">edit</div>
          </div>
        </div>
        <div className="oc-set">
          <div className="oc-set-group-title">Appearance</div>
          <div className="oc-set-row">
            <div><div className="label">Theme</div><div className="desc">Slate + cyan is the only native theme.</div></div>
            <div className="value">slate-cyan</div>
            <div className="hint">built-in</div>
          </div>
          <div className="oc-set-row">
            <div><div className="label">Font</div><div className="desc">Monospace used in transcript & composer.</div></div>
            <div className="value">JetBrains Mono</div>
            <div className="hint">change</div>
          </div>
          <div className="oc-set-row">
            <div><div className="label">Density</div><div className="desc">Line-height and padding.</div></div>
            <div className="value">comfortable</div>
            <div className="hint">compact · comfortable · spacious</div>
          </div>
        </div>
      </div>
    </div>
  );
};

/* --- MCP --- */
OcPanels.Mcp = function Mcp() {
  const servers = [
    { name: "filesystem", state: "on",  desc: "Local file operations",          tools: 8 },
    { name: "github",     state: "on",  desc: "Repos, PRs, issues",              tools: 14 },
    { name: "postgres",   state: "on",  desc: "Read-only analyst@prod",          tools: 3 },
    { name: "linear",     state: "err", desc: "Auth token expired",              tools: 0 },
    { name: "slack",      state: "off", desc: "Not connected",                   tools: 0 },
  ];
  return (
    <div className="oc-panel">
      <div className="oc-panel-head">
        <div className="oc-panel-title">
          <span className="crumb">owlcoda</span><span className="sep">/</span>
          <span>mcp servers</span>
        </div>
        <div className="oc-panel-hint"><span className="oc-key">a</span> add · <span className="oc-key">r</span> reload · <span className="oc-key">esc</span> close</div>
      </div>
      <div className="oc-panel-body">
        {servers.map(s => (
          <div key={s.name} className={`oc-mcp is-${s.state}`}>
            <span className="dot" />
            <span className="name">{s.name}</span>
            <span className="desc">{s.desc}</span>
            <span className="tools">{s.tools} tools</span>
            <span className="act">{s.state === "err" ? "reconnect" : s.state === "off" ? "connect" : "manage"}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* --- Onboarding / first run --- */
OcPanels.Onboarding = function Onboarding() {
  return (
    <div className="oc-panel" style={{ background: "var(--oc-bg)" }}>
      <div className="oc-panel-body">
        <div className="oc-onboarding">
          <div className="oc-onboarding-hero">
            {window.OwlVar && <window.OwlVar.Glyph size={64} />}
            <div>
              <h1>Welcome to owlcoda.</h1>
              <p className="lede">A terminal coding agent, in your shell. Let's get you set up — takes under a minute.</p>
            </div>
          </div>
          <ol>
            <li>
              <div>
                <div className="step-title">Sign in</div>
                <div className="step-desc">Connect a local router or add a provider key. <span style={{ color: "var(--oc-accent)" }}>owlcoda models</span></div>
              </div>
            </li>
            <li>
              <div>
                <div className="step-title">Choose your approval mode</div>
                <div className="step-desc">Strict asks before every write & exec. Normal auto-approves reads. You can change this later in <span style={{ color: "var(--oc-accent)" }}>/settings</span>.</div>
              </div>
            </li>
            <li>
              <div>
                <div className="step-title">Initialize your repo (optional)</div>
                <div className="step-desc">Run <span style={{ color: "var(--oc-accent)" }}>/init</span> so the agent writes an OWLCODA.md describing your project.</div>
              </div>
            </li>
            <li>
              <div>
                <div className="step-title">Start a session</div>
                <div className="step-desc">Type your first request. Use <span style={{ color: "var(--oc-accent)" }}>@</span> to attach files, <span style={{ color: "var(--oc-accent)" }}>/</span> for commands, <span className="oc-key">Shift+Tab</span> to cycle plan / act modes.</div>
              </div>
            </li>
          </ol>
          <div style={{ marginTop: 24, color: "var(--oc-ink-dim)", fontSize: "var(--oc-fs-xs)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            Keyboard
          </div>
          <div className="hotkeys">
            <div className="row"><span className="oc-key">↵</span><span className="desc">send</span></div>
            <div className="row"><span className="oc-key">⇧↵</span><span className="desc">newline</span></div>
            <div className="row"><span className="oc-key">⌃C</span><span className="desc">interrupt</span></div>
            <div className="row"><span className="oc-key">⌃D</span><span className="desc">quit</span></div>
            <div className="row"><span className="oc-key">⌃L</span><span className="desc">clear</span></div>
            <div className="row"><span className="oc-key">⌃R</span><span className="desc">resume last</span></div>
            <div className="row"><span className="oc-key">⇧⇥</span><span className="desc">toggle plan / act</span></div>
            <div className="row"><span className="oc-key">/</span><span className="desc">command palette</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { OcPanels });
