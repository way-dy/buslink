// screens-mobile.jsx — Driver + Passenger mobile apps

// ════════════════════════════════════════════════════════════════════════════
// DriverApp — "오늘의 배차 자동 표시 + 1탭 운행시작"
// ════════════════════════════════════════════════════════════════════════════
function DriverApp() {
  return (
    <div data-screen-label="05 Driver App" style={{
      width: '100%', height: '100%', background: '#F4F4F5', position: 'relative',
      fontFamily: 'var(--font-base)', color: '#171719',
      paddingTop: 44, paddingBottom: 34, // iOS safe area
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '12px 20px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <BusLinkLogo size={18} sub="기사" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#46474B' }}>
          <div style={{ position: 'relative' }}>
            <Icon name="bell" size={20}/>
            <div style={{ position: 'absolute', top: -2, right: -2, width: 7, height: 7, borderRadius: '50%', background: '#FF7A00', border: '1.5px solid #F4F4F5' }}/>
          </div>
          <Avatar name="김" size={28}/>
        </div>
      </div>

      {/* Greeting */}
      <div style={{ padding: '14px 20px 0' }}>
        <div style={{ fontSize: 13, color: '#7C7E83', fontWeight: 600 }}>2026년 5월 16일 · 금요일</div>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2, letterSpacing: '-0.02em' }}>
          김민수 기사님, 안녕하세요
        </div>
      </div>

      {/* Today's dispatch — big hero card */}
      <div style={{
        margin: '16px 16px 0', padding: '20px 20px 16px', borderRadius: 20,
        background: 'linear-gradient(155deg, #0066FF 0%, #003DCC 100%)',
        color: '#fff', position: 'relative', overflow: 'hidden',
      }}>
        {/* faint bus icon */}
        <svg viewBox="0 0 100 100" style={{ position: 'absolute', right: -10, top: -10, width: 140, opacity: 0.15 }}>
          <rect x="10" y="20" width="80" height="48" rx="10" fill="#fff"/>
          <circle cx="28" cy="76" r="8" fill="#fff"/><circle cx="72" cy="76" r="8" fill="#fff"/>
        </svg>

        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Pill tone="dark" style={{ background: 'rgba(255,255,255,0.18)', color: '#fff' }} dot>
              오늘 배차
            </Pill>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>2/3 회차</div>
          </div>
          <div style={{ fontFamily: 'var(--font-brand)', fontSize: 32, fontWeight: 800, marginTop: 14, letterSpacing: '-0.025em' }}>
            강서 → 여의도 1
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 13 }}>
            <div><span style={{ color: 'rgba(255,255,255,0.6)' }}>차량 </span><span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>B-217</span></div>
            <div><span style={{ color: 'rgba(255,255,255,0.6)' }}>출발 </span><span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>07:00</span></div>
            <div><span style={{ color: 'rgba(255,255,255,0.6)' }}>예상 </span><span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>08:05</span></div>
          </div>

          {/* Stop progress */}
          <div style={{ marginTop: 18, padding: 14, background: 'rgba(255,255,255,0.10)', borderRadius: 14, backdropFilter: 'blur(10px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'rgba(255,255,255,0.8)' }}>
              <span>다음 정류장</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>3분 · 850m</span>
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, marginTop: 4 }}>강남역 4번 출구</div>
            <div style={{ marginTop: 10, height: 6, background: 'rgba(255,255,255,0.18)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: '45%', height: '100%', background: '#fff', borderRadius: 3 }}/>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: 'var(--font-mono)' }}>
              <span>3/7 정류장</span>
              <span>출발 32분 경과</span>
            </div>
          </div>
        </div>
      </div>

      {/* Live status strip */}
      <div style={{ margin: '12px 16px 0', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <MiniStat label="속도" value="42" unit="km/h"/>
        <MiniStat label="GPS" value="±4m" tone="positive"/>
        <MiniStat label="탑승" value="38" unit="/45"/>
      </div>

      {/* Big actions */}
      <div style={{ margin: '14px 16px 0', display: 'flex', gap: 10 }}>
        <button style={{
          flex: 1, padding: '18px 0', borderRadius: 14, border: 'none', background: '#fff',
          fontSize: 15, fontWeight: 700, color: '#171719', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <Icon name="qr" size={20}/> QR 표시
        </button>
        <button style={{
          flex: 1, padding: '18px 0', borderRadius: 14, border: 'none', background: '#fff',
          fontSize: 15, fontWeight: 700, color: '#171719', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <Icon name="check" size={20}/> 정류장 체크
        </button>
      </div>

      {/* Quick stop list */}
      <div style={{ margin: '14px 16px 0', background: '#fff', borderRadius: 16, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#171719' }}>오늘 운행 정류장</div>
          <div style={{ fontSize: 12, color: '#0066FF', fontWeight: 600 }}>전체 보기</div>
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {[
            { t: '07:21', n: '발산역 5번 출구', s: 'done', x: '8명 탑승' },
            { t: '07:32', n: '강남역 4번 출구', s: 'next', x: '도착 3분' },
            { t: '07:41', n: '역삼역 2번 출구', s: 'future' },
          ].map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
              <div style={{ fontSize: 11, color: '#7C7E83', fontFamily: 'var(--font-mono)', width: 38 }}>{s.t}</div>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: s.s === 'done' ? '#0066FF' : '#fff',
                border: `2px solid ${s.s === 'future' ? '#DBDCDF' : '#0066FF'}`, flexShrink: 0,
              }}/>
              <div style={{ flex: 1, fontSize: 14, fontWeight: s.s === 'next' ? 700 : 600, color: s.s === 'future' ? '#7C7E83' : '#171719' }}>
                {s.n}
              </div>
              {s.x && <div style={{ fontSize: 11, fontWeight: 600, color: s.s === 'next' ? '#0066FF' : '#7C7E83' }}>{s.x}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom emergency button row — sticky-feel */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, padding: '12px 16px', background: 'linear-gradient(to top, #F4F4F5 60%, rgba(244,244,245,0))' }}>
        <button style={{
          width: '100%', padding: '18px 0', borderRadius: 16, border: 'none',
          background: '#171719', color: '#fff', fontSize: 17, fontWeight: 800,
          fontFamily: 'inherit', boxShadow: '0 8px 20px rgba(0,0,0,0.16)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#00BF40' }}/>
          운행 중 — 종료
        </button>
      </div>
    </div>
  );
}

function MiniStat({ label, value, unit, tone }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#7C7E83', fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, justifyContent: 'center', marginTop: 2 }}>
        <span style={{ fontFamily: 'var(--font-brand)', fontSize: 17, fontWeight: 800, color: tone === 'positive' ? '#00BF40' : '#171719' }}>{value}</span>
        {unit && <span style={{ fontSize: 10, color: '#7C7E83', fontWeight: 600 }}>{unit}</span>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PassengerApp — "내 버스 어디쯤 ETA"
// ════════════════════════════════════════════════════════════════════════════
function PassengerApp() {
  return (
    <div data-screen-label="06 Passenger App" style={{
      width: '100%', height: '100%', position: 'relative',
      fontFamily: 'var(--font-base)', color: '#171719', overflow: 'hidden',
    }}>
      {/* Map fills the screen */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <MapMock zoom={1.4} panX={140} panY={150}>
          <BusMarker x={50} y={48} num="217" tone="primary" selected/>
          {/* Pickup pin */}
          <div style={{ position: 'absolute', left: '32%', top: '78%', transform: 'translate(-50%, -100%)' }}>
            <svg width="32" height="40" viewBox="0 0 32 40">
              <path d="M16 0C7 0 0 7 0 16c0 12 16 24 16 24s16-12 16-24c0-9-7-16-16-16z" fill="#171719"/>
              <circle cx="16" cy="16" r="6" fill="#fff"/>
            </svg>
          </div>
        </MapMock>
      </div>

      {/* Top status bar */}
      <div style={{ position: 'absolute', top: 50, left: 16, right: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          background: '#fff', padding: '10px 12px', borderRadius: 12,
          display: 'flex', alignItems: 'center', gap: 10, boxShadow: 'var(--shadow-emphasize)', flex: 1,
        }}>
          <Icon name="menu" size={18}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#7C7E83', fontWeight: 600 }}>오늘 출근편</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>강서 → 여의도 1 · B-217</div>
          </div>
          <Icon name="bell" size={18}/>
        </div>
      </div>

      {/* Floating ETA card — the big moment */}
      <div style={{
        position: 'absolute', left: 16, right: 16, bottom: 140,
        background: '#fff', borderRadius: 20, padding: '20px 20px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Pill tone="primary" dot>도착 카운트다운</Pill>
          <span style={{ fontSize: 11, color: '#7C7E83', marginLeft: 'auto' }}>실시간 업데이트</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 12 }}>
          <span style={{
            fontFamily: 'var(--font-brand)', fontSize: 56, fontWeight: 900,
            color: '#0066FF', letterSpacing: '-0.035em', lineHeight: 1,
          }}>3</span>
          <span style={{ fontSize: 22, fontWeight: 700, color: '#171719' }}>분</span>
          <span style={{ fontSize: 14, color: '#7C7E83', marginLeft: 8 }}>· 850m</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, color: '#46474B', fontSize: 14 }}>
          <Icon name="pin" size={16}/>
          <span><strong style={{ color: '#171719' }}>강남역 4번 출구</strong>에서 탑승</span>
        </div>

        {/* Stop progress */}
        <div style={{ marginTop: 16, height: 6, background: '#F2F2F3', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: '45%', height: '100%', background: 'linear-gradient(90deg, #0066FF, #3385FF)', borderRadius: 3, position: 'relative' }}>
            <div style={{ position: 'absolute', right: -6, top: -3, width: 12, height: 12, borderRadius: '50%', background: '#0066FF', border: '2px solid #fff' }}/>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: '#7C7E83', fontFamily: 'var(--font-mono)' }}>
          <span>출발 07:00</span>
          <span>예상 08:05</span>
        </div>

        {/* QR & contact */}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button style={{
            flex: 1, padding: '14px 0', borderRadius: 12, border: 'none', background: '#0066FF',
            color: '#fff', fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            <Icon name="qr" size={18}/> 탑승 QR
          </button>
          <button style={{
            padding: '14px 16px', borderRadius: 12, border: '1px solid #DBDCDF', background: '#fff',
            color: '#171719', fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
          }}>
            <Icon name="phone" size={18}/>
          </button>
        </div>
      </div>

      {/* Bottom mini-list — other rides */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 34,
        background: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
        padding: '14px 20px 16px', boxShadow: '0 -8px 24px rgba(0,0,0,0.06)',
      }}>
        <div style={{ width: 36, height: 4, background: '#DBDCDF', borderRadius: 2, margin: '0 auto 12px' }}/>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>오늘 다른 일정</div>
            <div style={{ fontSize: 11, color: '#7C7E83', marginTop: 1 }}>퇴근편 · 18:00 출발</div>
          </div>
          <Icon name="chev" size={18}/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { DriverApp, PassengerApp });
