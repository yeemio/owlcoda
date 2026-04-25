/* global React */
/* OwlCoda — conversation primitives: user turn, assistant turn, thinking, streaming, markers. */

const OcConv = {};

/* --- user turn --- */
OcConv.UserTurn = function UserTurn({ children, attachments = [] }) {
  return (
    <div className="oc-row oc-turn-user">
      <div className="oc-row-gutter">›</div>
      <div className="oc-row-body">
        {attachments.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {attachments.map((a, i) => (
              <span key={i} style={{
                display: "inline-block", fontFamily: "var(--oc-mono)",
                fontSize: "var(--oc-fs-xs)", color: "var(--oc-ink-mute)",
                border: "1px solid var(--oc-rule)", background: "var(--oc-bg-soft)",
                padding: "1px 6px", borderRadius: 2, marginRight: 6,
              }}>
                <span style={{ color: "var(--oc-accent)" }}>@</span>{a}
              </span>
            ))}
          </div>
        )}
        <div>{children}</div>
      </div>
    </div>
  );
};

/* --- assistant turn --- */
OcConv.OcTurn = function OcTurn({ children, streaming = false }) {
  return (
    <div className="oc-row oc-turn-oc">
      <div className="oc-row-gutter">·</div>
      <div className="oc-row-body">
        {children}
        {streaming && <span className="oc-cursor" />}
      </div>
    </div>
  );
};

/* --- markdown-ish rendering shortcuts --- */
OcConv.P = ({ children }) => <p>{children}</p>;
OcConv.Code = ({ children }) => <code>{children}</code>;
OcConv.Strong = ({ children }) => <strong>{children}</strong>;
OcConv.List = ({ items, ordered = false }) => {
  const Tag = ordered ? "ol" : "ul";
  return <Tag>{items.map((x, i) => <li key={i}>{x}</li>)}</Tag>;
};

/* --- thinking block --- */
OcConv.Thinking = function Thinking({ children, duration = null, live = false, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen || live);
  return (
    <div className="oc-thinking">
      <div className="oc-thinking-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        {live ? (
          <span className="oc-thinking-live">
            <span className="dot" /> thinking
          </span>
        ) : (
          <span>thought</span>
        )}
        {duration != null && <span className="dur">{duration}s</span>}
      </div>
      {open && <div className="oc-thinking-body">{children}</div>}
    </div>
  );
};

/* --- section marker (system / interrupt / resume) --- */
OcConv.Marker = function Marker({ kind = "info", children }) {
  const cls = kind === "warn" ? "is-warn" : kind === "err" ? "is-err" : "";
  return (
    <div className="oc-row">
      <div className="oc-row-gutter" style={{ color: "var(--oc-ink-faint)" }}>—</div>
      <div className={`oc-row-body oc-marker ${cls}`} style={{
        fontSize: "var(--oc-fs-xs)", letterSpacing: "0.12em",
        textTransform: "uppercase", color: "var(--oc-ink-dim)",
      }}>
        {children}
      </div>
    </div>
  );
};

Object.assign(window, { OcConv });
