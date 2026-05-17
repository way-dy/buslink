// common.jsx — BusLink shared atoms
// - BusLinkLogo  : wordmark
// - Pill, Chip, Btn, Toggle, Avatar, StatusDot
// - MapMock      : SVG kakao-map look-alike with bus markers + roads + river
// - MiniMap      : compact route preview

const C = {
  primary: '#0066FF',
  primaryStrong: '#005EEB',
  primaryDeep: '#003DCC',
  primarySoft: '#EAF2FE',
  bg: '#FFFFFF',
  bgAlt: '#F7F7F8',
  bgSoft: '#F2F2F3',
  bgDark: '#0B1020',
  bgDarker: '#070A15',
  label: '#171719',
  labelStrong: '#000',
  labelMute: 'rgba(46,47,51,0.62)',
  labelAlt: 'rgba(46,47,51,0.40)',
  line: 'rgba(112,115,124,0.18)',
  lineSoft: 'rgba(112,115,124,0.10)',
  positive: '#00BF40',
  cautionary: '#FF7A00',
  destructive: '#E52222',
  violet: '#7B3FE4',
};

// ──────────────────────────── Logo ────────────────────────────
function BusLinkLogo({ size = 22, color, sub }) {
  const c = color || C.primary;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="2" y="4" width="20" height="14" rx="4" fill={c} />
        <rect x="5" y="7" width="6" height="5" rx="1.5" fill="#fff" opacity=".95" />
        <rect x="13" y="7" width="6" height="5" rx="1.5" fill="#fff" opacity=".95" />
        <circle cx="7" cy="20" r="2.2" fill={c} stroke="#fff" strokeWidth="1.2" />
        <circle cx="17" cy="20" r="2.2" fill={c} stroke="#fff" strokeWidth="1.2" />
        <rect x="9" y="14.5" width="6" height="1.5" rx=".7" fill="#fff" opacity=".7" />
      </svg>
      <span style={{ fontFamily: 'var(--font-brand)', fontWeight: 800, fontSize: size * 0.86, letterSpacing: '-0.03em', color: color === '#fff' ? '#fff' : '#0B1020' }}>
        Bus<span style={{ color: c }}>Link</span>
      </span>
      {sub && <span style={{ fontSize: 11, color: C.labelMute, fontWeight: 600, marginLeft: 4, letterSpacing: 0 }}>{sub}</span>}
    </div>
  );
}

// ──────────────────────────── Pills / Chips ────────────────────────────
function Pill({ tone = 'neutral', children, dot, style }) {
  const palette = {
    neutral:  { bg: C.bgSoft,       fg: C.label,      dot: C.labelMute },
    primary:  { bg: C.primarySoft,  fg: C.primaryDeep, dot: C.primary },
    positive: { bg: '#E6F7EB',      fg: '#007A29',    dot: C.positive },
    warn:     { bg: '#FFF1E0',      fg: '#B95300',    dot: C.cautionary },
    danger:   { bg: '#FCE5E5',      fg: '#A81818',    dot: C.destructive },
    violet:   { bg: '#F0ECFE',      fg: '#4E22A8',    dot: C.violet },
    dark:     { bg: 'rgba(255,255,255,0.08)', fg: '#E8EBF2', dot: '#7C8597' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: palette.bg, color: palette.fg,
      fontSize: 12, fontWeight: 600, lineHeight: 1, letterSpacing: 0.02,
      padding: '5px 10px', borderRadius: 999, ...style,
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: palette.dot }} />}
      {children}
    </span>
  );
}

function StatusDot({ tone = 'positive', size = 8, pulse }) {
  const color = { positive: C.positive, warn: C.cautionary, danger: C.destructive, neutral: C.labelMute, primary: C.primary }[tone];
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size }}>
      {pulse && <span style={{ position: 'absolute', inset: -3, borderRadius: '50%', background: color, opacity: 0.25, animation: 'blpulse 1.6s ease-out infinite' }} />}
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
    </span>
  );
}

function Btn({ variant = 'primary', size = 'md', children, icon, style, dark }) {
  const sizes = {
    sm: { padding: '6px 12px', font: 13, radius: 8, gap: 6 },
    md: { padding: '10px 16px', font: 14, radius: 10, gap: 8 },
    lg: { padding: '14px 22px', font: 16, radius: 12, gap: 10 },
  }[size];
  const variants = {
    primary: { bg: C.primary, fg: '#fff', border: 'transparent' },
    primaryDark: { bg: '#fff', fg: C.bgDark, border: 'transparent' },
    secondary: { bg: dark ? 'rgba(255,255,255,0.08)' : '#fff', fg: dark ? '#E8EBF2' : C.label, border: dark ? 'rgba(255,255,255,0.12)' : C.line },
    ghost: { bg: 'transparent', fg: dark ? '#E8EBF2' : C.label, border: 'transparent' },
    danger: { bg: '#fff', fg: C.destructive, border: '#F6C9C9' },
  }[variant];
  return (
    <button style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: sizes.gap,
      padding: sizes.padding, fontSize: sizes.font, fontWeight: 600, letterSpacing: 0,
      borderRadius: sizes.radius, background: variants.bg, color: variants.fg,
      border: `1px solid ${variants.border}`, cursor: 'pointer', whiteSpace: 'nowrap',
      fontFamily: 'inherit', ...style,
    }}>
      {icon}{children}
    </button>
  );
}

function Avatar({ name = '김', tone = 'primary', size = 32 }) {
  const palette = {
    primary: { bg: C.primarySoft, fg: C.primaryDeep },
    violet: { bg: '#F0ECFE', fg: '#4E22A8' },
    positive: { bg: '#E6F7EB', fg: '#007A29' },
    warn: { bg: '#FFF1E0', fg: '#B95300' },
    cyan: { bg: '#D8F2EF', fg: '#006E66' },
    pink: { bg: '#FCDDEA', fg: '#B41867' },
  }[tone];
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: palette.bg, color: palette.fg, fontWeight: 700, fontSize: size * 0.42,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>{name.slice(0, 1)}</div>
  );
}

// Generic icon (stroke-based, currentColor)
function Icon({ name, size = 18, stroke = 1.7 }) {
  const paths = {
    bus: <><rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M3 12h18"/><circle cx="8" cy="19" r="1.6"/><circle cx="16" cy="19" r="1.6"/></>,
    pin: <><path d="M12 22s7-7.3 7-13a7 7 0 1 0-14 0c0 5.7 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></>,
    route: <><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 6h6a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4H10a4 4 0 0 0-4 4v-2"/></>,
    user: <><circle cx="12" cy="8" r="3.5"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></>,
    bell: <><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z"/><path d="M10 19a2 2 0 0 0 4 0"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7M17 17v4M14 21h3"/></>,
    chart: <><path d="M4 19V5M4 19h16"/><path d="M8 15v-3M12 15V8M16 15v-6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    search: <><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></>,
    arrow: <><path d="M5 12h14M13 5l7 7-7 7"/></>,
    chev: <><path d="M9 6l6 6-6 6"/></>,
    check: <><path d="M5 12.5l4.5 4.5L19 7"/></>,
    play: <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>,
    pause: <><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.3-1.3L13.5 3h-3l-.7 2.4a7 7 0 0 0-2.3 1.3L5.1 5.8 3.1 9.2l2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.3l-2 1.5 2 3.4 2.3-.9c.7.6 1.5 1 2.3 1.3L10.5 21h3l.7-2.4a7 7 0 0 0 2.3-1.3l2.3.9 2-3.4-2-1.5c.1-.4.2-.9.2-1.3z"/></>,
    download: <><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></>,
    filter: <><path d="M4 5h16l-6 8v6l-4-2v-4z"/></>,
    speed: <><path d="M5 18a8 8 0 1 1 14 0"/><path d="M12 18l4-6"/></>,
    clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>,
    phone: <><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    close: <><path d="M6 6l12 12M18 6l-6 6-6 6"/></>,
    sparkle: <><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></>,
    flag: <><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {paths}
    </svg>
  );
}

// Expose
Object.assign(window, { C, BusLinkLogo, Pill, StatusDot, Btn, Avatar, Icon });
