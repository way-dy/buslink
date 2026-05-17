// app.jsx — Design canvas wiring

function BusLinkCanvas() {
  return (
    <DesignCanvas>
      <DCSection id="overview" title="BusLink · 디자인 리뉴얼" subtitle="동영관광 · 통근버스 SaaS 관제 시스템 — 풀 패키지 영업자료">
        <DCArtboard id="cover" label="00 · Cover" width={1280} height={720}>
          <CoverArt/>
        </DCArtboard>
      </DCSection>

      <DCSection id="auth" title="01 · 로그인" subtitle="역할별 인증 — 관리자(이메일) / 기사·승객(사번+PIN)">
        <DCArtboard id="login-admin" label="관리자 — Desktop" width={1280} height={800}>
          <div data-screen-label="01 Login Admin"><LoginAdmin/></div>
        </DCArtboard>
        <DCArtboard id="login-driver" label="기사 — Mobile" width={390} height={844}>
          <div data-screen-label="02 Login Driver">
            <IOSDevice width={390} height={844}>
              <LoginMobile role="driver"/>
            </IOSDevice>
          </div>
        </DCArtboard>
        <DCArtboard id="login-pax" label="승객 — Mobile" width={390} height={844}>
          <div data-screen-label="03 Login Passenger">
            <IOSDevice width={390} height={844}>
              <LoginMobile role="passenger"/>
            </IOSDevice>
          </div>
        </DCArtboard>
      </DCSection>

      <DCSection id="live" title="02 · 실시간 관제 (메인 대시보드)" subtitle="맵 퍼스트 IA — 떠 있는 패널, 실시간 KPI, 운행 타임라인">
        <DCArtboard id="live-main" label="실시간 관제 — 맵 퍼스트" width={1440} height={900}>
          <div data-screen-label="04 Realtime Control">
            <RealtimeControl/>
          </div>
        </DCArtboard>
      </DCSection>

      <DCSection id="mobile" title="03 · 모바일 (기사·승객)" subtitle="현장 UX — 큰 타깃, 한 화면 한 결정">
        <DCArtboard id="driver" label="기사 앱" width={390} height={844}>
          <div data-screen-label="05 Driver App">
            <IOSDevice width={390} height={844}>
              <DriverApp/>
            </IOSDevice>
          </div>
        </DCArtboard>
        <DCArtboard id="pax" label="승객 앱" width={390} height={844}>
          <div data-screen-label="06 Passenger App">
            <IOSDevice width={390} height={844}>
              <PassengerApp/>
            </IOSDevice>
          </div>
        </DCArtboard>
      </DCSection>

      <DCSection id="landing" title="04 · 랜딩 / 영업 페이지" subtitle="300대로 직접 쓰고 있습니다 — SaaS 영업 메시지">
        <DCArtboard id="landing-home" label="Landing — Home" width={1440} height={2400}>
          <LandingPage/>
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

// ─── Cover art ────────────────────────────────────────────────────────────────
function CoverArt() {
  return (
    <div style={{
      width: '100%', height: '100%', background: 'linear-gradient(135deg, #0B1020 0%, #0F1A3D 50%, #0066FF 140%)',
      color: '#fff', position: 'relative', overflow: 'hidden', fontFamily: 'var(--font-base)',
      padding: '80px 96px', display: 'flex', flexDirection: 'column',
    }}>
      {/* Faint map silhouette */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.08, pointerEvents: 'none' }}>
        <MapMock/>
      </div>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <BusLinkLogo size={28} color="#fff"/>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontWeight: 600 }}>2026 · 동영관광</div>
      </div>

      <div style={{ position: 'relative', marginTop: 'auto' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#7AB0FF', letterSpacing: 1, textTransform: 'uppercase' }}>Design Renewal · 풀 패키지</div>
        <h1 style={{
          fontFamily: 'var(--font-brand)', fontSize: 88, fontWeight: 900,
          letterSpacing: '-0.04em', lineHeight: 1.04, margin: '16px 0 0',
        }}>
          전세버스 관제,<br/>
          <span style={{ color: '#7AB0FF' }}>이제 상업적으로.</span>
        </h1>
        <div style={{ marginTop: 32, display: 'flex', gap: 40, fontSize: 14, color: 'rgba(255,255,255,0.72)' }}>
          <div><span style={{ color: '#fff', fontWeight: 700 }}>9 screens</span> · 로그인 → 관제 → 모바일 → 랜딩</div>
          <div><span style={{ color: '#fff', fontWeight: 700 }}>Wanted DS</span> · Pretendard / #0066FF</div>
          <div><span style={{ color: '#fff', fontWeight: 700 }}>KO / EN</span></div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<BusLinkCanvas/>);
