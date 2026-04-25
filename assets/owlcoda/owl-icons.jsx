/* global React */
/* OwlCoda — owl icon variants. 4 approaches for the welcome / branding mark.
   All colors driven by CSS vars so they adapt to the theme. */

const OwlVar = {};

/* ---------- Variant A: Braille owl at icon sizes ----------
   Same Braille form as the welcome banner, just smaller. Pass one of
   16 / 20 / 24 / 32 as `size`; rendered via font-size so the shape
   stays pixel-perfect and identical to the large version. */
OwlVar.Glyph = function Glyph({ size = 20, eye = "var(--oc-accent)", ink = "var(--oc-accent)" }) {
  return <OwlVar.Ascii ink={ink} eye={eye} scale={size / 14} />;
};

/* ---------- Variant B: Braille owl (verbatim port from owlcoda/src/native/tui/welcome.ts)
   Shape — and the "eye dot" animation — are the real CLI source, not a guess.
   The dot (⬤) travels across row 3 at columns {3, 5, 7, 10, 12}, forming the
   eye blink cycle. We keep the shape character-for-character; only the
   rendering host (React + monospace) differs. */
OwlVar.Ascii = function Ascii({
  ink = "var(--oc-ink-soft)",
  eye = "var(--oc-accent)",
  scale = 1,
  frame = "dot-left",   // 'dot-left' | 'dot-left-mid' | 'dot-mid' | 'dot-right-mid' | 'dot-right'
  animate = false,      // cycle through the 5 frames every 700ms
}) {
  // Exact 8 rows from welcome.ts · renderLogo()
  const baseRows = [
    "⢦⣤⣀⣠⣤⣤⣤⣀ ⣠⣶⣿⣿⣿⣶⣄⣤⡶",
    " ⣻⣿⣿⠿⠿⢿⣿⣿⣿⡿⠛⠛⠛⢿⣿⣿⠄",
    "⢠⣿⡟⠁   ⠙⣿⣿⠁    ⠉⠁ ",
    "⢸⣿⡁     ⣿⣷        ",
    "⠸⣿⣇     ⣿⣿⣦⣀ ⢀⣴⣿⣦ ",
    " ⢻⣿⣷⣄⣀⣀⣀⡈⠻⢿⣿⣿⣿⣿⠟⠁ ",
    "  ⠙⢿⣿⣿⣿⣿⣿⣿⣶⣦⣤⡤⠖   ",
    "    ⠙⠻⠿⣿⣿⣿⡛⠛⠂     ",
  ];
  const dotPositions = {
    "dot-left":      [3, 3],
    "dot-left-mid":  [3, 5],
    "dot-mid":       [3, 7],
    "dot-right-mid": [3, 10],
    "dot-right":     [3, 12],
  };
  const order = ["dot-left", "dot-left-mid", "dot-mid", "dot-right-mid", "dot-right"];
  const [currentFrame, setCurrentFrame] = React.useState(frame);
  React.useEffect(() => {
    if (!animate) { setCurrentFrame(frame); return; }
    let i = order.indexOf(frame);
    if (i < 0) i = 0;
    const id = setInterval(() => {
      i = (i + 1) % order.length;
      setCurrentFrame(order[i]);
    }, 700);
    return () => clearInterval(id);
  }, [animate, frame]);

  const [dotRow, dotCol] = dotPositions[currentFrame] || dotPositions["dot-left"];
  const rows = baseRows.map((row, idx) => {
    if (idx !== dotRow) return row;
    const chars = Array.from(row);
    chars[dotCol] = "⬤";
    return chars.join("");
  });

  const fs = 14 * scale;
  return (
    <pre
      style={{
        margin: 0, padding: 0,
        fontFamily: "var(--oc-mono)",
        fontSize: `${fs}px`,
        lineHeight: 1,
        color: ink,
        whiteSpace: "pre",
        letterSpacing: 0,
      }}
    >
      {rows.map((row, i) => (
        <div key={i}>
          {Array.from(row).map((ch, j) => {
            if (ch === "⬤") return <span key={j} style={{ color: eye, fontWeight: 700 }}>⬤</span>;
            return <React.Fragment key={j}>{ch}</React.Fragment>;
          })}
        </div>
      ))}
    </pre>
  );
};

/* ---------- Variant C: Monogram [ oc ] — bracket wordmark ---------- */
OwlVar.Monogram = function Monogram({ size = 22, ink = "var(--oc-ink)", eye = "var(--oc-accent)" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 0,
        fontFamily: "var(--oc-mono)",
        fontSize: `${size}px`,
        fontWeight: 500,
        lineHeight: 1,
        letterSpacing: "-0.02em",
      }}
    >
      <span style={{ color: "var(--oc-ink-dim)" }}>[</span>
      <span style={{ color: ink, padding: "0 1px" }}>o</span>
      <span style={{
        display: "inline-block",
        width: `${size * 0.18}px`, height: `${size * 0.18}px`,
        background: eye, borderRadius: "50%",
        transform: `translateY(-${size * 0.28}px)`,
        margin: `0 1px`,
      }} />
      <span style={{ color: ink, padding: "0 1px" }}>c</span>
      <span style={{ color: "var(--oc-ink-dim)" }}>]</span>
    </span>
  );
};

/* ---------- Variant D: Inline unicode glyph (ω with eye dot) ---------- */
OwlVar.Inline = function Inline({ size = 14, ink = "currentColor", eye = "var(--oc-accent)" }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 2, color: ink, fontFamily: "var(--oc-mono)", fontSize: size }}>
      <span>◉</span>
    </span>
  );
};

/* ---------- Welcome banner (composes Variant A + wordmark) ---------- */
OwlVar.Welcome = function Welcome({ version = "0.12.27" }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "auto 1fr",
      gap: 16,
      alignItems: "center",
      padding: "6px 0 14px",
    }}>
      <OwlVar.Glyph size={42} />
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ color: "var(--oc-ink)", fontSize: 15, fontWeight: 500, letterSpacing: "-0.005em" }}>
          owlcoda <span style={{ color: "var(--oc-ink-dim)", fontWeight: 400 }}>v{version}</span>
        </div>
        <div style={{ color: "var(--oc-ink-mute)", fontSize: 12 }}>
          <span style={{ color: "var(--oc-accent)" }}>/help</span> for commands
          <span style={{ color: "var(--oc-ink-faint)", margin: "0 8px" }}>·</span>
          <span style={{ color: "var(--oc-accent)" }}>@</span>
          <span> for files</span>
          <span style={{ color: "var(--oc-ink-faint)", margin: "0 8px" }}>·</span>
          <span style={{ color: "var(--oc-accent)" }}>Shift+Tab</span>
          <span> for plan</span>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { OwlVar });
