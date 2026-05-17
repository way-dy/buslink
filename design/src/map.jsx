// map.jsx — Kakao-map look-alike SVG: roads, river, parks, district labels, buses
// Used by realtime control screen, driver app, passenger app, landing.

// Static stylized Seoul-like roads (relative to a 800x600 viewport)
const MAP_W = 800;
const MAP_H = 600;

const MAP_ROADS = [
  // Major highway (vertical) — Olympic-도로 style
  { d: 'M 80 0 C 100 100 60 180 90 280 S 130 480 110 600', w: 14, color: '#FFE082' },
  // Major highway (horizontal) — Gangnam-daero style
  { d: 'M 0 240 C 120 230 240 260 380 250 S 600 230 800 245', w: 14, color: '#FFE082' },
  // Secondary roads
  { d: 'M 0 120 C 200 130 350 110 540 130 S 720 145 800 120', w: 7, color: '#fff' },
  { d: 'M 0 380 C 180 370 330 400 500 390 S 700 380 800 395', w: 7, color: '#fff' },
  { d: 'M 0 500 C 180 510 360 490 540 510 S 720 525 800 500', w: 7, color: '#fff' },
  { d: 'M 230 0 C 240 90 270 200 250 320 S 230 500 240 600', w: 7, color: '#fff' },
  { d: 'M 420 0 C 410 100 430 200 415 330 S 405 500 420 600', w: 7, color: '#fff' },
  { d: 'M 600 0 C 595 120 615 240 600 380 S 590 510 600 600', w: 7, color: '#fff' },
  // Tertiary roads
  { d: 'M 100 60 L 300 75 L 480 60 L 700 80', w: 3, color: '#fff' },
  { d: 'M 130 180 L 320 175 L 510 195 L 720 180', w: 3, color: '#fff' },
  { d: 'M 130 300 L 300 295 L 490 320 L 700 305', w: 3, color: '#fff' },
  { d: 'M 130 450 L 320 445 L 490 470 L 700 460', w: 3, color: '#fff' },
];

const MAP_BLOCKS = [
  // Light gray building blocks
  { x: 130, y: 80, w: 80, h: 30 }, { x: 220, y: 80, w: 70, h: 30 },
  { x: 310, y: 80, w: 90, h: 30 }, { x: 420, y: 75, w: 50, h: 30 },
  { x: 490, y: 80, w: 60, h: 28 }, { x: 620, y: 80, w: 70, h: 28 },
  { x: 130, y: 135, w: 80, h: 38 }, { x: 230, y: 135, w: 60, h: 38 },
  { x: 310, y: 140, w: 90, h: 36 }, { x: 430, y: 135, w: 50, h: 38 },
  { x: 500, y: 140, w: 70, h: 36 }, { x: 620, y: 135, w: 80, h: 36 },
  { x: 130, y: 195, w: 90, h: 38 }, { x: 240, y: 200, w: 50, h: 36 },
  { x: 310, y: 200, w: 90, h: 36 }, { x: 430, y: 200, w: 60, h: 36 },
  { x: 510, y: 195, w: 60, h: 38 }, { x: 620, y: 200, w: 70, h: 36 },
  { x: 130, y: 320, w: 80, h: 50 }, { x: 230, y: 320, w: 70, h: 50 },
  { x: 320, y: 325, w: 80, h: 48 }, { x: 430, y: 325, w: 50, h: 50 },
  { x: 500, y: 325, w: 70, h: 50 }, { x: 620, y: 320, w: 80, h: 50 },
  { x: 130, y: 405, w: 80, h: 35 }, { x: 230, y: 405, w: 70, h: 35 },
  { x: 320, y: 410, w: 80, h: 33 }, { x: 430, y: 408, w: 60, h: 35 },
  { x: 510, y: 410, w: 50, h: 33 }, { x: 620, y: 405, w: 70, h: 35 },
];

// Park (green patch)
const MAP_PARKS = [
  { cx: 380, cy: 150, rx: 30, ry: 22 },
  { cx: 640, cy: 420, rx: 38, ry: 28 },
  { cx: 180, cy: 540, rx: 36, ry: 22 },
];

// River
const MAP_RIVER = 'M -20 540 C 80 530 180 555 280 545 S 480 525 580 540 S 740 555 820 540 L 820 600 L -20 600 Z';

// Tile / district labels
const MAP_LABELS = [
  { x: 200, y: 60, t: '강서구', sub: 'Gangseo' },
  { x: 460, y: 50, t: '여의도', sub: 'Yeouido' },
  { x: 280, y: 290, t: '강남대로', sub: '' },
  { x: 540, y: 290, t: '삼성역', sub: 'Samseong' },
  { x: 660, y: 370, t: '잠실', sub: 'Jamsil' },
  { x: 180, y: 480, t: '관악', sub: 'Gwanak' },
];

// MapMock: roads + buses (children prop) overlay
function MapMock({ buses = [], stops = [], route, children, dim = 0, zoom = 1, panX = 0, panY = 0, showLabels = true }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#F6F4EE', overflow: 'hidden' }}>
      <svg viewBox={`${panX} ${panY} ${MAP_W / zoom} ${MAP_H / zoom}`} preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%', display: 'block' }}>
        <defs>
          <linearGradient id="map-bg" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#F2EFE7"/>
            <stop offset="1" stopColor="#EFEBE0"/>
          </linearGradient>
          <pattern id="map-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(0,0,0,0.025)" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width={MAP_W} height={MAP_H} fill="url(#map-bg)"/>
        <rect width={MAP_W} height={MAP_H} fill="url(#map-grid)"/>

        {/* parks */}
        {MAP_PARKS.map((p, i) => (
          <ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} fill="#D8E6C3" opacity="0.85"/>
        ))}

        {/* building blocks */}
        {MAP_BLOCKS.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx="2" fill="#fff" opacity="0.9"/>
        ))}

        {/* river */}
        <path d={MAP_RIVER} fill="#BFD8E8" opacity="0.95"/>
        <path d="M -20 540 C 80 530 180 555 280 545 S 480 525 580 540 S 740 555 820 540" stroke="#A6C5D7" strokeWidth="1" fill="none"/>

        {/* roads (cased: outer + inner) */}
        {MAP_ROADS.map((r, i) => (
          <g key={i}>
            <path d={r.d} stroke="#E0DACC" strokeWidth={r.w + 2} fill="none" strokeLinecap="round"/>
            <path d={r.d} stroke={r.color} strokeWidth={r.w} fill="none" strokeLinecap="round"/>
          </g>
        ))}

        {/* route polyline (passed as prop) */}
        {route && (
          <g>
            <path d={route} stroke="#0066FF" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.18"/>
            <path d={route} stroke="#0066FF" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 6"/>
          </g>
        )}

        {/* labels */}
        {showLabels && MAP_LABELS.map((l, i) => (
          <g key={i} style={{ pointerEvents: 'none' }}>
            <text x={l.x} y={l.y} textAnchor="middle" fontSize="11" fontWeight="700" fill="#6B6862" fontFamily="Pretendard Variable, sans-serif" letterSpacing="-0.5">{l.t}</text>
            {l.sub && <text x={l.x} y={l.y + 11} textAnchor="middle" fontSize="8" fill="#8B8780" fontFamily="Pretendard Variable, sans-serif">{l.sub}</text>}
          </g>
        ))}

        {/* stops */}
        {stops.map((s, i) => (
          <g key={i} transform={`translate(${s.x} ${s.y})`}>
            <circle r="6" fill="#fff" stroke="#0066FF" strokeWidth="2.4"/>
            <circle r="2.5" fill="#0066FF"/>
          </g>
        ))}

        {/* dim overlay */}
        {dim > 0 && <rect width={MAP_W} height={MAP_H} fill="#0B1020" opacity={dim}/>}
      </svg>
      {/* children overlay (absolutely positioned markers, controls) */}
      {children}
    </div>
  );
}

// BusMarker — pill with bus number / heading, optional pulse
function BusMarker({ x, y, num, tone = 'primary', label, dir = 0, selected, mini }) {
  const palette = {
    primary: { bg: '#0066FF', fg: '#fff', ring: 'rgba(0,102,255,0.22)' },
    positive: { bg: '#00BF40', fg: '#fff', ring: 'rgba(0,191,64,0.22)' },
    warn: { bg: '#FF7A00', fg: '#fff', ring: 'rgba(255,122,0,0.22)' },
    danger: { bg: '#E52222', fg: '#fff', ring: 'rgba(229,34,34,0.22)' },
    neutral: { bg: '#fff', fg: '#171719', ring: 'rgba(0,0,0,0.08)' },
  }[tone];
  const size = mini ? 22 : 30;
  return (
    <div style={{
      position: 'absolute', left: `${x}%`, top: `${y}%`,
      transform: 'translate(-50%, -50%)',
      zIndex: selected ? 5 : 2,
    }}>
      {selected && (
        <div style={{
          position: 'absolute', inset: -10, borderRadius: '50%',
          background: palette.ring, animation: 'blpulse 1.8s ease-out infinite',
        }}/>
      )}
      <div style={{
        position: 'relative',
        background: palette.bg, color: palette.fg,
        padding: mini ? '3px 7px' : '5px 9px',
        borderRadius: 999, fontSize: mini ? 11 : 12, fontWeight: 700,
        fontFamily: 'var(--font-mono), monospace',
        boxShadow: '0 2px 6px rgba(0,0,0,0.18), 0 0 0 2px #fff',
        whiteSpace: 'nowrap', letterSpacing: 0,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {!mini && <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" opacity=".95"><rect x="3" y="5" width="18" height="12" rx="2.5"/></svg>}
        {num}
      </div>
      {label && (
        <div style={{
          position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 4,
          background: '#fff', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
          color: '#171719', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', whiteSpace: 'nowrap',
        }}>{label}</div>
      )}
    </div>
  );
}

// inject keyframes once
if (!document.getElementById('bl-keyframes')) {
  const s = document.createElement('style');
  s.id = 'bl-keyframes';
  s.textContent = `
    @keyframes blpulse {
      0% { transform: scale(0.6); opacity: 0.7; }
      100% { transform: scale(1.8); opacity: 0; }
    }
    @keyframes blpulse2 {
      0%,100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes blshimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
  `;
  document.head.appendChild(s);
}

Object.assign(window, { MapMock, BusMarker, MAP_W, MAP_H });
