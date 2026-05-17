// screens-admin.jsx — Admin screens
// Centerpiece: RealtimeControl (map-first), then Dispatch, Routes, Drivers, Vehicles

// Sample data
const SAMPLE_BUSES = [
  { id: 'B-217', x: 24, y: 38, route: '강서-여의도 1', driver: '김민수', tone: 'primary', speed: 42 },
  { id: 'B-104', x: 38, y: 52, route: '강서-여의도 2', driver: '이정훈', tone: 'primary', speed: 38 },
  { id: 'B-298', x: 51, y: 28, route: '강북-광화문', driver: '박철민', tone: 'primary', speed: 51 },
  { id: 'B-153', x: 64, y: 46, route: '판교-삼성', driver: '최영수', tone: 'primary', speed: 44 },
  { id: 'B-076', x: 75, y: 63, route: '잠실-역삼', driver: '정태호', tone: 'primary', speed: 0 },
  { id: 'B-341', x: 18, y: 70, route: '관악-사당', driver: '김도현', tone: 'warn', speed: 12 },
  { id: 'B-189', x: 45, y: 75, route: '강남-역삼', driver: '윤상민', tone: 'primary', speed: 36 },
  { id: 'B-262', x: 82, y: 32, route: '송파-잠실', driver: '한승호', tone: 'positive', speed: 48 },
  { id: 'B-088', x: 32, y: 18, route: '마포-여의도', driver: '서지원', tone: 'primary', speed: 28 },
  { id: 'B-415', x: 70, y: 18, route: '성북-광화문', driver: '오민재', tone: 'danger', speed: 0 },
  { id: 'B-512', x: 58, y: 60, route: '삼성-역삼', driver: '강현우', tone: 'primary', speed: 33 },
  { id: 'B-330', x: 28, y: 58, route: '강서-여의도 3', driver: '신준영', tone: 'primary', speed: 41 },
];

const ADMIN_TABS = [
  { id: 'live', label: '실시간 관제', icon: 'pin' },
  { id: 'dispatch', label: '배차 관리', icon: 'grid' },
  { id: 'routes', label: '노선 관리', icon: 'route' },
  { id: 'drivers', label: '기사·차량', icon: 'user' },
  { id: 'history', label: '운행 이력', icon: 'clock' },
  { id: 'analytics', label: '탑승 분석', icon: 'chart' },
];

// ════════════════════════════════════════════════════════════════════════════
// RealtimeControl — the hero screen
// ════════════════════════════════════════════════════════════════════════════
function RealtimeControl({ selectedIdx = 0 }) {
  const selected = SAMPLE_BUSES[selectedIdx];
  return (
    <div style={{ width: 1440, height: 900, position: 'relative', overflow: 'hidden', background: '#F2EFE7', fontFamily: 'var(--font-base)' }}>
      {/* MAP */}
      <MapMock zoom={0.95}>
        {/* route polyline overlay for selected bus */}
        <svg viewBox="0 0 1440 900" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <path d="M 80 540 C 220 480 280 360 340 320 S 480 200 580 220 S 740 280 820 350" stroke="#0066FF" strokeWidth="6" fill="none" opacity="0.18" strokeLinecap="round"/>
          <path d="M 80 540 C 220 480 280 360 340 320 S 480 200 580 220 S 740 280 820 350" stroke="#0066FF" strokeWidth="3" fill="none" strokeDasharray="1 8" strokeLinecap="round"/>
        </svg>
        {SAMPLE_BUSES.map((b, i) => (
          <BusMarker key={i} x={b.x} y={b.y} num={b.id.replace('B-', '')} tone={b.tone} selected={i === selectedIdx} />
        ))}
      </MapMock>

      {/* TOP BAR — translucent */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 60,
        background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        display: 'flex', alignItems: 'center', padding: '0 24px', zIndex: 20,
      }}>
        <BusLinkLogo size={20} />
        <div style={{ height: 22, width: 1, background: '#DBDCDF', margin: '0 18px' }}/>
        <div style={{ fontSize: 13, color: '#46474B', fontWeight: 600 }}>동영관광 <span style={{ color: '#AEB0B6' }}>· dy001</span></div>

        <nav style={{ display: 'flex', gap: 2, marginLeft: 48 }}>
          {ADMIN_TABS.map((t, i) => (
            <div key={t.id} style={{
              padding: '10px 14px', fontSize: 13.5, fontWeight: 600,
              color: i === 0 ? '#0066FF' : '#46474B',
              background: i === 0 ? '#EAF2FE' : 'transparent',
              borderRadius: 8, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            }}>
              <Icon name={t.icon} size={15}/> {t.label}
            </div>
          ))}
        </nav>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#F7F7F8', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#46474B' }}>
            <Icon name="search" size={14}/> 차량·기사·노선 검색 <span style={{ color: '#AEB0B6', marginLeft: 6 }}>⌘K</span>
          </div>
          <div style={{ position: 'relative', cursor: 'pointer' }}>
            <Icon name="bell" size={18}/>
            <div style={{ position: 'absolute', top: -2, right: -2, width: 8, height: 8, borderRadius: '50%', background: '#FF7A00', border: '2px solid #fff' }}/>
          </div>
          <Avatar name="관" tone="primary" size={32}/>
        </div>
      </div>

      {/* TOP KPI STRIP — floating glass cards */}
      <div style={{ position: 'absolute', top: 84, left: 24, right: 360, display: 'flex', gap: 12, zIndex: 10 }}>
        <KpiCard label="운행 중" value="237" delta="+8" tone="positive" pulse />
        <KpiCard label="대기 / 운휴" value="63" sub="07:30 이후 출발" />
        <KpiCard label="지연 5분 +" value="3" tone="warn" sub="강서-여의도 2 외 2건" />
        <KpiCard label="GPS 음영" value="1" tone="danger" sub="B-415 · 02:14 전" />
        <KpiCard label="평균 정시율" value="98.6%" delta="+0.4%p" tone="positive" sub="지난 7일" />
      </div>

      {/* LEFT RAIL — route filter list */}
      <div style={{
        position: 'absolute', top: 184, left: 24, width: 280, maxHeight: 624,
        background: '#fff', borderRadius: 16, boxShadow: 'var(--shadow-float)',
        zIndex: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 16px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>노선 필터</div>
            <span style={{ fontSize: 11, color: '#7C7E83' }}>12/47</span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 10, background: '#F2F2F3', padding: 3, borderRadius: 8 }}>
            {['전체', '출근', '퇴근'].map((t, i) => (
              <div key={t} style={{
                flex: 1, textAlign: 'center', padding: '6px 0', fontSize: 12, fontWeight: 600,
                borderRadius: 6, color: i === 1 ? '#171719' : '#7C7E83',
                background: i === 1 ? '#fff' : 'transparent',
                boxShadow: i === 1 ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
              }}>{t}</div>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
          {[
            { name: '강서-여의도 1', buses: 8, status: 'active', stops: '12정류장 · 38km' },
            { name: '강서-여의도 2', buses: 7, status: 'delayed', stops: '12정류장 · 38km' },
            { name: '강서-여의도 3', buses: 6, status: 'active', stops: '11정류장 · 36km' },
            { name: '강남-역삼', buses: 5, status: 'active', stops: '9정류장 · 22km' },
            { name: '판교-삼성', buses: 4, status: 'active', stops: '14정류장 · 41km' },
            { name: '잠실-역삼', buses: 3, status: 'idle', stops: '10정류장 · 19km' },
            { name: '강북-광화문', buses: 4, status: 'active', stops: '11정류장 · 24km' },
          ].map((r, i) => (
            <div key={r.name} style={{
              padding: '10px 10px', borderRadius: 10, marginTop: 4,
              background: i === 0 ? '#EAF2FE' : 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: i === 0 ? '#0066FF' : 'transparent' }}/>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: i === 0 ? '#003DCC' : '#171719' }}>{r.name}</div>
                  {r.status === 'delayed' && <StatusDot tone="warn" size={6}/>}
                </div>
                <div style={{ fontSize: 11, color: '#7C7E83', marginTop: 2 }}>{r.stops}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#171719', fontFamily: 'var(--font-mono)' }}>{r.buses}</div>
                <div style={{ fontSize: 10, color: '#7C7E83' }}>대 운행</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT DETAIL — selected vehicle */}
      <div style={{
        position: 'absolute', top: 84, right: 24, width: 320, maxHeight: 792,
        background: '#fff', borderRadius: 16, boxShadow: 'var(--shadow-float)',
        zIndex: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 18px 14px', borderBottom: '1px solid #F2F2F3' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pill tone="positive" dot>운행 중</Pill>
                <span style={{ fontSize: 11, color: '#7C7E83' }}>2초 전 업데이트</span>
              </div>
              <div style={{ fontFamily: 'var(--font-brand)', fontSize: 28, fontWeight: 800, marginTop: 8, letterSpacing: '-0.02em' }}>{selected.id}</div>
              <div style={{ fontSize: 13, color: '#46474B' }}>{selected.route}</div>
            </div>
            <button style={{ width: 32, height: 32, border: 'none', background: '#F7F7F8', borderRadius: 8, cursor: 'pointer' }}>
              <Icon name="close" size={16}/>
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Btn size="sm" variant="primary" style={{ flex: 1 }}>지도에서 따라가기</Btn>
            <Btn size="sm" variant="secondary" icon={<Icon name="phone" size={14}/>}>호출</Btn>
          </div>
        </div>

        {/* Vehicle live stats */}
        <div style={{ padding: '16px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, borderBottom: '1px solid #F2F2F3' }}>
          <LiveStat label="현재 속도" value="42" unit="km/h" icon="speed"/>
          <LiveStat label="다음 정류장" value="3분" sub="강남역 4번 출구"/>
          <LiveStat label="탑승 인원" value="38" unit="/45" tone="primary"/>
          <LiveStat label="GPS 정확도" value="±4m" tone="positive"/>
        </div>

        {/* Driver */}
        <div style={{ padding: '16px 18px', borderBottom: '1px solid #F2F2F3', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={selected.driver[0]} tone="primary" size={40}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{selected.driver} 기사</div>
            <div style={{ fontSize: 12, color: '#7C7E83' }}>사번 DY4821 · 운행 18년차</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#7C7E83' }}>오늘</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#171719' }}>2/3</div>
          </div>
        </div>

        {/* Stops timeline */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#7C7E83', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>오늘 운행 · 출근편</div>
          {[
            { t: '07:00', name: '동영관광 차고지', state: 'done', sub: '정시 출발' },
            { t: '07:14', name: '강서구청역 3번 출구', state: 'done', sub: '12명 탑승' },
            { t: '07:21', name: '발산역 5번 출구', state: 'done', sub: '8명 탑승' },
            { t: '07:32', name: '강남역 4번 출구', state: 'next', sub: '도착 3분' },
            { t: '07:41', name: '역삼역 2번 출구', state: 'future', sub: '' },
            { t: '07:52', name: '삼성동 코엑스', state: 'future', sub: '' },
            { t: '08:05', name: '한국전력 본사', state: 'future', sub: '하차 종점' },
          ].map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '8px 0' }}>
              <div style={{ width: 44, fontSize: 12, color: '#7C7E83', fontFamily: 'var(--font-mono)', paddingTop: 1 }}>{s.t}</div>
              <div style={{ position: 'relative', width: 14, flexShrink: 0 }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%',
                  background: s.state === 'done' ? '#0066FF' : s.state === 'next' ? '#fff' : '#fff',
                  border: s.state === 'next' ? '2px solid #0066FF' : s.state === 'future' ? '2px solid #DBDCDF' : '2px solid #0066FF',
                  marginTop: 4,
                }}/>
                {i < 6 && <div style={{ position: 'absolute', left: 5.5, top: 18, bottom: -8, width: 2, background: s.state === 'done' ? '#0066FF' : '#ECEDEE' }}/>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: s.state === 'next' ? 700 : 600, color: s.state === 'future' ? '#7C7E83' : '#171719' }}>{s.name}</div>
                {s.sub && <div style={{ fontSize: 11, color: s.state === 'next' ? '#0066FF' : '#AEB0B6', marginTop: 1, fontWeight: s.state === 'next' ? 600 : 500 }}>{s.sub}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* MAP CONTROLS — bottom right cluster */}
      <div style={{ position: 'absolute', bottom: 24, right: 360, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 10 }}>
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: 'var(--shadow-emphasize)', overflow: 'hidden' }}>
          <div style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #F2F2F3', cursor: 'pointer', fontWeight: 700, color: '#171719' }}>+</div>
          <div style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontWeight: 700, color: '#171719' }}>−</div>
        </div>
        <div style={{ background: '#fff', borderRadius: 10, boxShadow: 'var(--shadow-emphasize)', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Icon name="pin" size={16}/>
        </div>
      </div>

      {/* BOTTOM TIMELINE — operations heatbar */}
      <div style={{ position: 'absolute', bottom: 24, left: 24, width: 280 + 12 + 540, height: 'auto', zIndex: 10 }}>
        <div style={{ background: '#fff', borderRadius: 14, padding: '12px 16px', boxShadow: 'var(--shadow-float)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>오늘의 운행 타임라인</div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#7C7E83' }}>
              <LegendDot c="#0066FF" t="운행"/>
              <LegendDot c="#FFD089" t="대기"/>
              <LegendDot c="#FF7A00" t="지연"/>
              <LegendDot c="#E52222" t="이슈"/>
            </div>
          </div>
          {/* Hour ruler */}
          <div style={{ display: 'flex', fontSize: 10, color: '#AEB0B6', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
            {['06','07','08','09','10','11','12','13','14','15','16','17','18','19','20'].map(h => (
              <div key={h} style={{ flex: 1, textAlign: 'left' }}>{h}</div>
            ))}
          </div>
          {/* Bars */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <TimeBar segs={[[2,12,'p'],[12,18,'w'],[18,30,'p'],[30,42,'w'],[42,56,'p']]}/>
            <TimeBar segs={[[3,14,'p'],[14,20,'w'],[20,32,'p'],[32,44,'w'],[44,55,'p']]}/>
            <TimeBar segs={[[1,11,'p'],[11,18,'w'],[18,30,'p'],[30,40,'w'],[40,52,'p'],[52,60,'d']]}/>
            <TimeBar segs={[[4,16,'p'],[16,22,'w'],[22,34,'p'],[34,45,'w'],[45,58,'p']]}/>
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #F2F2F3', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#46474B' }}>
            <span style={{ display: 'inline-block', width: 2, height: 14, background: '#0066FF', borderRadius: 2 }}/>
            <span style={{ fontWeight: 600 }}>지금</span>
            <span style={{ color: '#7C7E83' }}>· 07:32 · 출근편 운행 마감까지 38분</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, delta, sub, tone, pulse }) {
  const tones = {
    positive: { tag: '#E6F7EB', tagFg: '#007A29' },
    warn: { tag: '#FFF1E0', tagFg: '#B95300' },
    danger: { tag: '#FCE5E5', tagFg: '#A81818' },
  };
  return (
    <div style={{
      flex: 1, background: '#fff', padding: '14px 16px', borderRadius: 12,
      boxShadow: 'var(--shadow-float)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: '#7C7E83', letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</div>
        {pulse && <StatusDot tone="positive" size={6} pulse/>}
        {tone && tones[tone] && (
          <div style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: tones[tone].tag, color: tones[tone].tagFg, fontWeight: 700 }}>!</div>
        )}
      </div>
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <div style={{ fontFamily: 'var(--font-brand)', fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em' }}>{value}</div>
        {delta && (
          <div style={{ fontSize: 11, fontWeight: 700, color: tone === 'positive' ? '#007A29' : tone === 'warn' ? '#B95300' : '#A81818' }}>{delta}</div>
        )}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#7C7E83', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function LiveStat({ label, value, unit, sub, tone, icon }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#7C7E83', fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, marginTop: 2 }}>
        <div style={{ fontFamily: 'var(--font-brand)', fontSize: 22, fontWeight: 800, color: tone === 'primary' ? '#0066FF' : '#171719', letterSpacing: '-0.02em' }}>{value}</div>
        {unit && <div style={{ fontSize: 11, color: '#7C7E83', fontWeight: 600 }}>{unit}</div>}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#46474B', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function LegendDot({ c, t }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: c }}/>{t}</div>;
}

function TimeBar({ segs }) {
  const color = (k) => ({ p: '#0066FF', w: '#FFD089', d: '#FF7A00', i: '#E52222' }[k]);
  return (
    <div style={{ position: 'relative', height: 14, background: '#F7F7F8', borderRadius: 4, overflow: 'hidden' }}>
      {segs.map(([s, e, k], i) => (
        <div key={i} style={{
          position: 'absolute', left: `${(s / 60) * 100}%`, width: `${((e - s) / 60) * 100}%`,
          top: 0, bottom: 0, background: color(k), opacity: 0.92,
        }}/>
      ))}
      {/* now marker (07:32 → 32/60 hours from 06 = (1+32/60)/15 = 0.1022..) */}
      <div style={{ position: 'absolute', left: `${((1 + 32/60) / 14.99) * 100}%`, top: -2, bottom: -2, width: 2, background: '#171719', borderRadius: 2 }}/>
    </div>
  );
}

Object.assign(window, { RealtimeControl, SAMPLE_BUSES, ADMIN_TABS });
