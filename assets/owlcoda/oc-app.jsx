/* global React, OcConv, OcTool, OcDiff, OcIO, OcPanels, OwlVar, DC, DCSection, DCArtboard */

/* ================== Scenes — each a self-contained artboard ==================
   Artboards are static pure-CLI frames. No window chrome.
   Sized to feel like a real terminal at reasonable zoom. */

const TerminalFrame = ({ children, label }) => (
  <div className="oc-art">
    {label && <div className="oc-art-label">{label}</div>}
    <div className="oc-term">{children}</div>
  </div>
);

/* ---------- Scene 1: First-run onboarding ---------- */
function SceneOnboarding() {
  return (
    <TerminalFrame label="First run">
      <OcPanels.Onboarding />
      <OcIO.Rail state="ready" model="—" tokens="0/200k" cost="$0.00" branch="—" mcp={0} hotkeys={["type to begin"]} />
    </TerminalFrame>
  );
}

/* ---------- Scene 2: Ready / welcome ---------- */
function SceneReady() {
  return (
    <TerminalFrame label="Ready — empty session">
      <div className="oc-transcript">
        <OwlVar.Welcome version="0.12.27" />
        <OcConv.Marker>cwd ~/code/mionyee-hermes · branch main · no pending changes</OcConv.Marker>
      </div>
      <OcIO.Composer placeholder="Type your message, or / for commands, @ to attach a file" mode="plan" />
      <OcIO.Rail state="ready" />
    </TerminalFrame>
  );
}

/* ---------- Scene 3: Thinking + streaming ---------- */
function SceneThinking() {
  return (
    <TerminalFrame label="Streaming + thinking">
      <div className="oc-transcript">
        <OcConv.UserTurn>refactor the renderer to avoid re-mounting the transcript on every token</OcConv.UserTurn>
        <OcConv.Thinking live defaultOpen>
          <div className="paragraph">The transcript re-mounts because <code>key</code> on the outer list changes whenever a streaming chunk arrives. I should look at where the stream reducer lives and whether it emits a new array reference per token…</div>
          <div className="paragraph">Let me check the reducer first, then the memoization.</div>
        </OcConv.Thinking>
        <OcConv.OcTurn streaming>
          <p>Looking at this, the issue is almost certainly in <code>useConversation</code> — it rebuilds the array on every token instead of mutating the last</p>
        </OcConv.OcTurn>
      </div>
      <OcIO.Composer placeholder="Type to queue your next message…" mode="act" />
      <OcIO.Rail state="busy" tokens="14.8k/200k" cost="$0.22" />
    </TerminalFrame>
  );
}

/* ---------- Scene 4: Tool calls (Bash + Read + Grep + LS) ---------- */
function SceneTools() {
  return (
    <TerminalFrame label="Tool calls — read-only recon">
      <div className="oc-transcript">
        <OcConv.UserTurn>find every place we call `postMessage` and summarize by file</OcConv.UserTurn>
        <OcConv.OcTurn>
          <p>Scanning the codebase now.</p>
        </OcConv.OcTurn>
        <OcTool.Grep
          pattern="postMessage\\(" path="src/"
          duration="0.4s"
          matches={[
            { file: "src/host/bridge.ts",       line: 42,  text: "  iframe.contentWindow.postMessage({type: '__ready'}, '*')" },
            { file: "src/host/bridge.ts",       line: 88,  text: "  frame.postMessage({type: '__edit_mode_activate'}, '*')" },
            { file: "src/terminal/App.tsx",     line: 118, text: "  window.parent.postMessage({type: 'slideChanged', n}, '*')" },
            { file: "src/terminal/Tweaks.tsx",  line: 54,  text: "  window.parent.postMessage({type: '__edit_mode_set_keys', edits}, '*')" },
          ]}
          defaultOpen
        />
        <OcTool.Ls
          path="src/terminal/"
          duration="0.08s"
          entries={[
            { name: "components", dir: true },
            { name: "hooks", dir: true },
            { name: "theme", dir: true },
            { name: "App.tsx" },
            { name: "Tweaks.tsx" },
            { name: "index.ts" },
          ]}
        />
        <OcTool.Read path="src/terminal/App.tsx" lines={284} duration="0.05s" />
        <OcTool.Bash
          cmd="git status --short"
          cwd="~/code/owlcoda"
          duration="0.12s"
          stdout={" M src/terminal/App.tsx\n M src/terminal/theme.css\n?? src/terminal/Tweaks.tsx"}
          defaultOpen
        />
        <OcConv.OcTurn>
          <p>Four call sites, all in <code>src/host/bridge.ts</code> and <code>src/terminal</code>. The bridge owns the host→iframe direction; the terminal uses them for edit-mode announcements and slide-sync.</p>
        </OcConv.OcTurn>
      </div>
      <OcIO.Composer placeholder="" mode="act" value="" />
      <OcIO.Rail state="tool" tokens="22.1k/200k" cost="$0.38" />
    </TerminalFrame>
  );
}

/* ---------- Scene 5: Diff preview (edit tool w/ inline diff) ---------- */
function SceneDiff() {
  const diff = (
    <OcDiff.Diff
      path="src/terminal/useConversation.ts" plus={6} minus={3}
      hunks={[
        {
          oldStart: 48, oldLen: 9, newStart: 48, newLen: 12,
          context: "useConversation",
          lines: [
            { oldNo: 48, newNo: 48, text: "export function useConversation() {" },
            { oldNo: 49, newNo: 49, text: "  const [turns, setTurns] = useState<Turn[]>([]);" },
            { oldNo: 50, newNo: 50, text: "" },
            { oldNo: 51, kind: "del", text: "  const appendToken = (tok: string) => {" },
            { oldNo: 52, kind: "del", text: "    setTurns(ts => [...ts.slice(0,-1), { ...ts.at(-1)!, text: ts.at(-1)!.text + tok }]);" },
            { oldNo: 53, kind: "del", text: "  };" },
            { newNo: 51, kind: "add", text: "  const appendToken = useCallback((tok: string) => {" },
            { newNo: 52, kind: "add", text: "    setTurns(ts => {" },
            { newNo: 53, kind: "add", text: "      const last = ts[ts.length - 1];" },
            { newNo: 54, kind: "add", text: "      last.text += tok;        // mutate — React's not a fan, but " },
            { newNo: 55, kind: "add", text: "      return [...ts];          // identity change is what we want" },
            { newNo: 56, kind: "add", text: "    });" },
            { newNo: 57, kind: "add", text: "  }, []);" },
            { oldNo: 54, newNo: 58, text: "" },
            { oldNo: 55, newNo: 59, text: "  return { turns, appendToken };" },
            { oldNo: 56, newNo: 60, text: "}" },
          ],
        },
      ]}
    />
  );
  return (
    <TerminalFrame label="Edit + diff preview">
      <div className="oc-transcript">
        <OcConv.UserTurn>apply the fix</OcConv.UserTurn>
        <OcConv.OcTurn>
          <p>Patching <code>useConversation.ts</code> — swapping the spread-per-token for a stable callback that mutates and re-references.</p>
        </OcConv.OcTurn>
        <OcTool.Edit path="src/terminal/useConversation.ts" plus={6} minus={3} duration="0.03s" diff={diff} defaultOpen />
        <OcTool.Bash cmd="pnpm typecheck" cwd="~/code/owlcoda" duration="3.8s" exit={0} stdout="✓ no errors (284 files)" />
        <OcConv.OcTurn>
          <p>Types pass. Want me to run the renderer tests next?</p>
        </OcConv.OcTurn>
      </div>
      <OcIO.Composer placeholder="" mode="act" />
      <OcIO.Rail state="ready" tokens="28.4k/200k" cost="$0.47" />
    </TerminalFrame>
  );
}

/* ---------- Scene 6: Todo list + running tasks ---------- */
function SceneTodo() {
  return (
    <TerminalFrame label="Planning — todo list">
      <div className="oc-transcript">
        <OcConv.UserTurn>add streaming cancellation — user should be able to Ctrl+C mid-response</OcConv.UserTurn>
        <OcConv.OcTurn>
          <p>Here's the plan. I'll work top-down.</p>
        </OcConv.OcTurn>
        <OcTool.Todo items={[
          { state: "done",    text: "Audit where the SSE stream is read" },
          { state: "done",    text: "Add an AbortController in useConversation" },
          { state: "current", text: "Wire Ctrl+C keyboard handler to abort()" },
          { state: "todo",    text: "Show \"interrupted\" marker in transcript" },
          { state: "todo",    text: "Preserve partial assistant text on abort" },
          { state: "blocked", text: "Add retry affordance — blocked on ux approval" },
        ]} />
        <OcConv.OcTurn streaming>
          <p>Opening the keybindings file now</p>
        </OcConv.OcTurn>
      </div>
      <OcIO.Composer placeholder="" mode="act" />
      <OcIO.Rail state="busy" tokens="31.8k/200k" cost="$0.52" />
    </TerminalFrame>
  );
}

/* ---------- Scene 7: Permission prompts (three tiers) ---------- */
function ScenePermissions() {
  return (
    <TerminalFrame label="Permissions — read / write / danger">
      <div className="oc-transcript">
        <OcConv.UserTurn>review the migration file and apply it</OcConv.UserTurn>

        <OcIO.Permission
          kind="read"
          action="Read file"
          target="db/migrations/2026-04-22-drop-legacy-sessions.sql"
          choices={[
            { key: "y", label: "Allow once", primary: true },
            { key: "a", label: "Allow always for this session" },
            { key: "n", label: "Deny" },
          ]}
        />

        <OcIO.Permission
          kind="write"
          action="Write file"
          target="db/migrations/2026-04-22-drop-legacy-sessions.sql (+42 lines, 1 new file)"
          risk="Creates a new migration. Will run on next deploy."
          choices={[
            { key: "y", label: "Apply", primary: true },
            { key: "e", label: "Edit first" },
            { key: "n", label: "Skip" },
          ]}
        />

        <OcIO.Permission
          kind="exec"
          danger
          action="Execute shell command"
          target="$ psql -d production -f drop-legacy-sessions.sql"
          risk="Irreversible. Runs against production database. Drops 2 tables."
          choices={[
            { key: "y", label: "Run anyway", danger: true },
            { key: "d", label: "Dry-run instead", primary: true },
            { key: "n", label: "Cancel", primary: false },
          ]}
        />
      </div>
      <OcIO.Composer placeholder="" mode="act" />
      <OcIO.Rail state="wait" tokens="18.2k/200k" cost="$0.31" />
    </TerminalFrame>
  );
}

/* ---------- Scene 8: Slash picker ---------- */
function SceneSlash() {
  return (
    <TerminalFrame label="Slash command palette">
      <div className="oc-transcript">
        <OcConv.UserTurn>thanks, that worked</OcConv.UserTurn>
        <OcConv.OcTurn>
          <p>Glad it's sorted. Anything else?</p>
        </OcConv.OcTurn>
        <div style={{ height: 60 }} />
      </div>
      <OcIO.Composer
        value="/"
        mode="act"
        showPicker={<OcIO.SlashPicker query="" selected={1} />}
      />
      <OcIO.Rail state="ready" tokens="42.0k/200k" cost="$0.71" />
    </TerminalFrame>
  );
}

/* ---------- Scene 9: @ file picker + attachments ---------- */
function SceneAt() {
  return (
    <TerminalFrame label="@ file reference + attachments">
      <div className="oc-transcript">
        <OcConv.UserTurn attachments={["src/terminal/App.tsx", "src/terminal/theme.css"]}>
          compare how these two files import the theme tokens — there's a mismatch somewhere
        </OcConv.UserTurn>
        <OcConv.OcTurn>
          <p>Reading both now.</p>
        </OcConv.OcTurn>
        <div style={{ height: 60 }} />
      </div>
      <OcIO.Composer
        value="check @src/terminal/App"
        mode="plan"
        attachments={[
          { kind: "img", name: "screenshot.png", size: "284 KB" },
          { kind: "file", name: "stack-trace.log", size: "12 KB" },
        ]}
        showPicker={<OcIO.AtPicker query="src/terminal/App" selected={0} />}
      />
      <OcIO.Rail state="ready" tokens="9.4k/200k" cost="$0.18" />
    </TerminalFrame>
  );
}

/* ---------- Scene 10: Model picker ---------- */
function SceneModel() {
  return (
    <TerminalFrame label="Model picker (/model)">
      <div className="oc-transcript">
        <OcConv.UserTurn>/model</OcConv.UserTurn>
        <div style={{ height: 80 }} />
      </div>
      <OcIO.Composer value="/model" mode="plan" showPicker={<OcIO.ModelPicker selected={1} />} />
      <OcIO.Rail state="ready" />
    </TerminalFrame>
  );
}

/* ---------- Scene 11: Session list ---------- */
function SceneSessions() {
  return (
    <TerminalFrame label="Session history (/sessions)">
      <OcPanels.Sessions selected={0} />
      <OcIO.Rail state="ready" hotkeys={["↵ resume", "d delete", "esc close"]} />
    </TerminalFrame>
  );
}

/* ---------- Scene 12: Settings ---------- */
function SceneSettings() {
  return (
    <TerminalFrame label="Settings (/settings)">
      <OcPanels.Settings />
      <OcIO.Rail state="ready" hotkeys={["tab section", "space toggle", "esc close"]} />
    </TerminalFrame>
  );
}

/* ---------- Scene 13: MCP servers ---------- */
function SceneMcp() {
  return (
    <TerminalFrame label="MCP servers (/mcp)">
      <OcPanels.Mcp />
      <OcIO.Rail state="ready" hotkeys={["a add", "r reload", "esc close"]} />
    </TerminalFrame>
  );
}

/* ---------- Scene 14: Errors (rate-limit + retry + update + interrupt) ---------- */
function SceneSystem() {
  return (
    <TerminalFrame label="System messages — errors, retries, updates">
      <div className="oc-transcript">
        <OcConv.UserTurn>deploy to staging</OcConv.UserTurn>

        <OcIO.Banner kind="warn" title="Rate limited" body="Provider rate limit reached. Retrying in 12s with exponential backoff."
          actions={[{ key: "r", label: "Retry now", primary: true }, { key: "x", label: "Cancel" }]} />

        <OcIO.Banner kind="err" title="Tool failed: bash" body="`pnpm build` exited with code 2. stderr attached below."
          actions={[{ key: "r", label: "Retry" }, { key: "s", label: "Skip" }]} />

        <OcTool.Bash cmd="pnpm build" cwd="~/code/owlcoda" duration="12.4s" exit={2} state="err" defaultOpen
          stderr={"src/host/bridge.ts:42:15 - error TS2345: Argument of type '{ type: string; }'\n    is not assignable to parameter of type 'HostMessage'.\n\n1 error in 284 files."} />

        <OcConv.Marker kind="warn">↯ interrupted by user · 0.4s into tool call</OcConv.Marker>

        <OcIO.Banner kind="info" title="Update available — v0.12.28" body="• Faster cold start on Linux   • /review now shows unstaged diff   • MCP: new postgres server template"
          actions={[{ key: "u", label: "Update & restart", primary: true }, { key: "n", label: "Later" }]} />

        <OcIO.Banner kind="ok" title="Connected to MCP: github" body="14 tools registered · authenticated as @yeemie" />
      </div>
      <OcIO.Composer placeholder="" mode="act" />
      <OcIO.Rail state="err" tokens="6.8k/200k" cost="$0.11" />
    </TerminalFrame>
  );
}

/* ---------- Scene 15: End-to-end flow ---------- */
function SceneFlow() {
  const diffMini = (
    <OcDiff.Diff path="src/keybindings.ts" plus={4} minus={0}
      hunks={[{
        oldStart: 12, oldLen: 5, newStart: 12, newLen: 9,
        lines: [
          { oldNo: 12, newNo: 12, text: "export const bindings: Binding[] = [" },
          { oldNo: 13, newNo: 13, text: "  { keys: ['enter'],          cmd: 'send' }," },
          { oldNo: 14, newNo: 14, text: "  { keys: ['shift','enter'],  cmd: 'newline' }," },
          { newNo: 15, kind: "add", text: "  { keys: ['ctrl','c'],       cmd: 'interrupt',  when: 'tool.running' }," },
          { newNo: 16, kind: "add", text: "  { keys: ['ctrl','c'],       cmd: 'abort',      when: 'stream.active' }," },
          { newNo: 17, kind: "add", text: "  { keys: ['ctrl','c','ctrl','c'], cmd: 'quit',  when: 'idle' }," },
          { newNo: 18, kind: "add", text: "" },
          { oldNo: 15, newNo: 19, text: "];" },
        ],
      }]}
    />
  );
  return (
    <TerminalFrame label="End-to-end session">
      <div className="oc-transcript">
        <OwlVar.Welcome version="0.12.27" />

        <OcConv.UserTurn>add ctrl+c cancellation for streaming responses</OcConv.UserTurn>

        <OcConv.Thinking duration={2.4}>
          <div className="paragraph">Need to find the existing keybinding system, add an AbortController to the stream, and make sure partial text is kept.</div>
        </OcConv.Thinking>

        <OcConv.OcTurn>
          <p>Planning this as three steps.</p>
        </OcConv.OcTurn>

        <OcTool.Todo items={[
          { state: "done",    text: "Locate keybinding registry" },
          { state: "current", text: "Add ctrl+c handler with context-aware routing" },
          { state: "todo",    text: "Thread AbortSignal through the stream" },
          { state: "todo",    text: "Preserve partial assistant text on abort" },
        ]} />

        <OcTool.Grep pattern="keys:\\s*\\[" path="src/" duration="0.2s"
          matches={[{ file: "src/keybindings.ts", line: 13, text: "{ keys: ['enter'], cmd: 'send' }," }]} />

        <OcTool.Edit path="src/keybindings.ts" plus={4} minus={0} duration="0.03s" diff={diffMini} defaultOpen />

        <OcTool.Bash cmd="pnpm typecheck" cwd="~/code/owlcoda" duration="3.8s" exit={0} stdout="✓ no errors" />

        <OcConv.OcTurn streaming>
          <p>Keybinding in place. Next I'll wire the signal into <code>useConversation</code> and the SSE reader</p>
        </OcConv.OcTurn>
      </div>
      <OcIO.Composer placeholder="Type to queue your next message…" mode="act" queued="write tests for the abort path" />
      <OcIO.Rail state="busy" tokens="46.2k/200k" cost="$0.78" branch="feat/cancel-stream" />
    </TerminalFrame>
  );
}

/* ================== Canvas ================== */

function App() {
  return (
    <DesignCanvas title="OwlCoda — Terminal" subtitle="Full CLI redesign · slate + cyan · component-level spec for engineering handoff">
      <DCSection id="core" title="Core states" subtitle="Baseline screens you see every session">
        <DCArtboard id="onboarding" label="01 · First run / onboarding" width={1100} height={760}><SceneOnboarding /></DCArtboard>
        <DCArtboard id="ready"      label="02 · Ready (empty session)"   width={1100} height={760}><SceneReady /></DCArtboard>
        <DCArtboard id="thinking"   label="03 · Thinking + streaming"    width={1100} height={760}><SceneThinking /></DCArtboard>
      </DCSection>

      <DCSection id="tools" title="Tool calls" subtitle="Every tool renders head-collapsed by default; click to expand">
        <DCArtboard id="tools"     label="04 · Read / Grep / LS / Bash"  width={1100} height={900}><SceneTools /></DCArtboard>
        <DCArtboard id="diff"      label="05 · Edit with inline diff"    width={1100} height={900}><SceneDiff /></DCArtboard>
        <DCArtboard id="todo"      label="06 · Todo / planning"          width={1100} height={760}><SceneTodo /></DCArtboard>
      </DCSection>

      <DCSection id="approval" title="Approvals & input" subtitle="Permission tiers, pickers, attachments">
        <DCArtboard id="perms"    label="07 · Permission prompts (read/write/danger)" width={1100} height={900}><ScenePermissions /></DCArtboard>
        <DCArtboard id="slash"    label="08 · Slash command palette"     width={1100} height={760}><SceneSlash /></DCArtboard>
        <DCArtboard id="at"       label="09 · @ file picker + attachments" width={1100} height={760}><SceneAt /></DCArtboard>
        <DCArtboard id="model"    label="10 · Model picker"              width={1100} height={760}><SceneModel /></DCArtboard>
      </DCSection>

      <DCSection id="panels" title="Full-screen panels" subtitle="Sessions, settings, MCP">
        <DCArtboard id="sessions" label="11 · Session history / resume"  width={1100} height={760}><SceneSessions /></DCArtboard>
        <DCArtboard id="settings" label="12 · Settings"                  width={1100} height={760}><SceneSettings /></DCArtboard>
        <DCArtboard id="mcp"      label="13 · MCP servers"               width={1100} height={760}><SceneMcp /></DCArtboard>
      </DCSection>

      <DCSection id="system" title="System & errors" subtitle="Rate-limits, retries, interrupts, updates">
        <DCArtboard id="system"   label="14 · Errors / rate-limit / update" width={1100} height={900}><SceneSystem /></DCArtboard>
      </DCSection>

      <DCSection id="e2e" title="End-to-end" subtitle="A single session showing most components working together">
        <DCArtboard id="flow"     label="15 · Complete session flow"     width={1100} height={1000}><SceneFlow /></DCArtboard>
      </DCSection>

      <DCSection id="brand" title="Owl icon — variants" subtitle="Four takes on the mark, all tuned to slate + cyan">
        <DCArtboard id="icons" label="16 · Icon variants" width={1100} height={420}>
          <div style={{
            background: "var(--oc-bg)", color: "var(--oc-ink)",
            padding: "32px 40px", height: "100%",
            display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24,
            fontFamily: "var(--oc-mono)",
          }}>
            {[
              { title: "A · Geometric SVG", sub: "16 / 24 / 48 — the primary mark", render: () => (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 20 }}>
                  <OwlVar.Glyph size={16} /><OwlVar.Glyph size={24} /><OwlVar.Glyph size={48} />
                </div>
              )},
              { title: "B · ASCII block", sub: "Welcome banner / splash", render: () => <OwlVar.Ascii /> },
              { title: "C · Monogram [oc]", sub: "Wordmark with eye dot", render: () => (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                  <OwlVar.Monogram size={14} />
                  <OwlVar.Monogram size={22} />
                  <OwlVar.Monogram size={34} />
                </div>
              )},
              { title: "D · Inline glyph", sub: "Status-bar / breadcrumb use", render: () => (
                <div style={{ fontSize: 14 }}>
                  <OwlVar.Inline /> owlcoda <span style={{ color: "var(--oc-ink-dim)" }}>/ thinking</span>
                </div>
              )},
            ].map((v, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 16, border: "1px solid var(--oc-rule)", padding: 20, borderRadius: 3 }}>
                <div>
                  <div style={{ color: "var(--oc-ink)", fontSize: 13 }}>{v.title}</div>
                  <div style={{ color: "var(--oc-ink-mute)", fontSize: 11, marginTop: 2 }}>{v.sub}</div>
                </div>
                <div style={{ flex: 1, display: "flex", alignItems: "center" }}>{v.render()}</div>
              </div>
            ))}
          </div>
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
