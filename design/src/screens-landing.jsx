// screens-landing.jsx — SaaS sales / marketing page

function LandingPage() {
  return (
    <div data-screen-label="09 Landing" style={{ width: 1440, background: '#fff', fontFamily: 'var(--font-base)', color: '#171719', overflow: 'hidden' }}>
      <LandingNav/>
      <LandingHero/>
      <LandingProof/>
      <LandingFeatures/>
      <LandingScreens/>
      <LandingPricing/>
      <LandingCTA/>
      <LandingFooter/>
    </div>
  );
}

function LandingNav() {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 50,
      background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(20px)',
      borderBottom: '1px solid rgba(0,0,0,0.05)', padding: '14px 56px',
      display: 'flex', alignItems: 'center', gap: 40,
    }}>
      <BusLinkLogo size={22}/>
      <nav style={{ display: 'flex', gap: 28, fontSize: 14, fontWeight: 600, color: '#46474B' }}>
        <span>제품</span><span>고객사</span><span>요금</span><span>도입 사례</span><span>개발자</span>
      </nav>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', gap: 4, padding: 3, background: '#F2F2F3', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
          <div style={{ padding: '4px 10px', borderRadius: 999, background: '#fff', color: '#171719', boxShadow: '0 1px 2px rgba(0,0,0,0.06)' }}>KO</div>
          <div style={{ padding: '4px 10px', borderRadius: 999, color: '#7C7E83' }}>EN</div>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#46474B' }}>로그인</div>
        <Btn size="sm" variant="primary">데모 신청</Btn>
      </div>
    </div>
  );
}

function LandingHero() {
  return (
    <section style={{ position: 'relative', padding: '88px 56px 56px', overflow: 'hidden' }}>
      {/* Grid bg */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.5,
        backgroundImage: 'linear-gradient(rgba(0,102,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,102,255,0.04) 1px, transparent 1px)',
        backgroundSize: '40px 40px', pointerEvents: 'none',
      }}/>
      <div style={{ position: 'absolute', top: -200, right: -200, width: 600, height: 600, borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,102,255,0.12), transparent 70%)', pointerEvents: 'none' }}/>

      <div style={{ position: 'relative', display: 'flex', gap: 56, alignItems: 'center' }}>
        <div style={{ flex: '0 0 580px' }}>
          <Pill tone="primary" dot style={{ fontSize: 13, padding: '7px 14px' }}>
            300대로 직접 쓰고 있습니다 · 동영관광
          </Pill>
          <h1 style={{
            fontFamily: 'var(--font-brand)', fontSize: 76, fontWeight: 900,
            letterSpacing: '-0.04em', lineHeight: 1.04, margin: '20px 0 0',
          }}>
            전세버스 회사를 위한,<br/>
            <span style={{
              background: 'linear-gradient(135deg, #0066FF 0%, #7B3FE4 100%)',
              WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
            }}>운영 OS.</span>
          </h1>
          <p style={{ fontSize: 19, lineHeight: 1.6, color: '#46474B', margin: '24px 0 36px', maxWidth: 520 }}>
            실시간 GPS 관제, 배차·노선, QR 탑승까지.
            설치 없이 링크 하나로 시작하고, 매일 300대 단위의 운행을 검증한 시스템을 그대로 씁니다.
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <Btn size="lg" variant="primary" icon={<Icon name="arrow" size={18}/>}>무료로 시작하기</Btn>
            <Btn size="lg" variant="secondary">데모 영상 1분</Btn>
          </div>
          <div style={{ marginTop: 36, display: 'flex', gap: 32, fontSize: 13, color: '#7C7E83' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="check" size={14} stroke={2.4}/> 신용카드 불필요</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="check" size={14} stroke={2.4}/> 14일 무료</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="check" size={14} stroke={2.4}/> 한국어 지원</div>
          </div>
        </div>

        {/* Hero visual — shrunken realtime view */}
        <div style={{ flex: 1, position: 'relative' }}>
          <div style={{
            borderRadius: 20, overflow: 'hidden', boxShadow: '0 24px 60px rgba(11,16,32,0.18), 0 0 0 1px rgba(0,0,0,0.06)',
            transform: 'perspective(1200px) rotateY(-6deg) rotateX(3deg)',
            transformOrigin: 'left center',
          }}>
            <div style={{ width: 780, height: 488, position: 'relative', background: '#F2EFE7' }}>
              <MapMock zoom={0.7}>
                <BusMarker x={22} y={36} num="217" tone="primary" selected/>
                <BusMarker x={42} y={48} num="104" tone="primary"/>
                <BusMarker x={62} y={28} num="298" tone="primary"/>
                <BusMarker x={28} y={68} num="341" tone="warn"/>
                <BusMarker x={72} y={56} num="153" tone="primary"/>
                <BusMarker x={52} y={75} num="189" tone="primary"/>
              </MapMock>
              {/* fake chrome top bar */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 44, background: 'rgba(255,255,255,0.92)', borderBottom: '1px solid rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12 }}>
                <BusLinkLogo size={14}/>
                <div style={{ marginLeft: 24, display: 'flex', gap: 4, fontSize: 11, fontWeight: 600 }}>
                  <span style={{ padding: '4px 8px', background: '#EAF2FE', color: '#0066FF', borderRadius: 6 }}>실시간 관제</span>
                  <span style={{ padding: '4px 8px', color: '#7C7E83' }}>배차</span>
                  <span style={{ padding: '4px 8px', color: '#7C7E83' }}>노선</span>
                </div>
              </div>
              {/* mini KPI strip */}
              <div style={{ position: 'absolute', top: 56, left: 12, right: 240, display: 'flex', gap: 8 }}>
                {[{l:'운행 중', v:'237', t:'positive'}, {l:'대기', v:'63'}, {l:'지연', v:'3', t:'warn'}].map((k,i) => (
                  <div key={i} style={{ flex: 1, background: '#fff', borderRadius: 8, padding: '8px 10px', boxShadow: '0 2px 6px rgba(0,0,0,0.06)' }}>
                    <div style={{ fontSize: 9, color: '#7C7E83', fontWeight: 600, textTransform: 'uppercase' }}>{k.l}</div>
                    <div style={{ fontFamily: 'var(--font-brand)', fontSize: 19, fontWeight: 800 }}>{k.v}</div>
                  </div>
                ))}
              </div>
              {/* mini detail card */}
              <div style={{ position: 'absolute', top: 56, right: 12, width: 220, background: '#fff', borderRadius: 10, padding: 12, boxShadow: '0 2px 6px rgba(0,0,0,0.08)' }}>
                <Pill tone="positive" dot style={{ fontSize: 10 }}>운행 중</Pill>
                <div style={{ fontFamily: 'var(--font-brand)', fontSize: 22, fontWeight: 800, marginTop: 6 }}>B-217</div>
                <div style={{ fontSize: 11, color: '#7C7E83' }}>강서-여의도 1 · 김민수</div>
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <div><div style={{ fontSize: 9, color: '#7C7E83' }}>속도</div><div style={{ fontWeight: 700, fontSize: 14 }}>42km/h</div></div>
                  <div><div style={{ fontSize: 9, color: '#7C7E83' }}>탑승</div><div style={{ fontWeight: 700, fontSize: 14 }}>38/45</div></div>
                </div>
              </div>
            </div>
          </div>

          {/* Floating mobile preview */}
          <div style={{
            position: 'absolute', right: -20, bottom: -40, width: 200,
            borderRadius: 36, boxShadow: '0 24px 50px rgba(11,16,32,0.22)',
            background: '#fff', padding: 8, transform: 'rotate(6deg)',
          }}>
            <div style={{ background: '#0066FF', borderRadius: 28, padding: '24px 16px 16px', color: '#fff', position: 'relative' }}>
              <div style={{ fontSize: 10, opacity: 0.7 }}>도착까지</div>
              <div style={{ fontFamily: 'var(--font-brand)', fontSize: 56, fontWeight: 900, lineHeight: 1 }}>3<span style={{ fontSize: 22, marginLeft: 2 }}>분</span></div>
              <div style={{ fontSize: 11, marginTop: 4, opacity: 0.85 }}>강남역 4번 출구</div>
              <div style={{ marginTop: 12, height: 4, background: 'rgba(255,255,255,0.25)', borderRadius: 2 }}>
                <div style={{ width: '45%', height: '100%', background: '#fff', borderRadius: 2 }}/>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LandingProof() {
  return (
    <section style={{ padding: '64px 56px 32px', background: '#fff' }}>
      <div style={{ textAlign: 'center', fontSize: 13, color: '#7C7E83', fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 28 }}>
        매일 검증되는 시스템 — 동영관광 통근버스 운영 기준
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, background: '#ECEDEE', borderRadius: 16, overflow: 'hidden' }}>
        {[
          { v: '300+', l: '동시 관제 차량' },
          { v: '98.6%', l: '평균 정시 운행률' },
          { v: '14ms', l: 'GPS 응답 지연' },
          { v: '4.9 ★', l: '기사·승객 평균 만족도' },
        ].map((s, i) => (
          <div key={i} style={{ padding: '36px 28px', background: '#fff', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-brand)', fontSize: 48, fontWeight: 900, color: '#0066FF', letterSpacing: '-0.03em' }}>{s.v}</div>
            <div style={{ fontSize: 14, color: '#46474B', marginTop: 8, fontWeight: 600 }}>{s.l}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LandingFeatures() {
  const features = [
    { icon: 'pin', title: '실시간 관제', desc: '300대를 한 화면에. 클릭 한 번에 차량·기사·노선·승객 정보까지.', tone: 'primary' },
    { icon: 'route', title: '배차·노선', desc: '출/퇴근편, 요일별 스케줄, 엑셀 일괄 등록·다운로드까지.', tone: 'violet' },
    { icon: 'qr', title: 'QR 탑승 체크', desc: '부정승차 방지. 사번·QR 매칭으로 탑승률 실시간 집계.', tone: 'cyan' },
    { icon: 'bell', title: '푸시 알림', desc: '기사·승객·고객사 담당자별. FCM 500개 배치로 즉시 발송.', tone: 'warn' },
    { icon: 'chart', title: '운행 일지·분석', desc: 'GPS 궤적, 정시율, 탑승률 모두 자동 집계.', tone: 'pink' },
    { icon: 'user', title: '멀티테넌트', desc: '고객사 담당자는 자사 데이터만. 슈퍼관리자는 전체.', tone: 'positive' },
  ];
  const palette = {
    primary: { bg: '#EAF2FE', fg: '#0066FF' },
    violet: { bg: '#F0ECFE', fg: '#7B3FE4' },
    cyan: { bg: '#CFF1ED', fg: '#006E66' },
    warn: { bg: '#FFE0C2', fg: '#B95300' },
    pink: { bg: '#FBD2E5', fg: '#B41867' },
    positive: { bg: '#C8F0D4', fg: '#007A29' },
  };
  return (
    <section style={{ padding: '96px 56px', background: '#F7F7F8' }}>
      <div style={{ maxWidth: 760, marginBottom: 56 }}>
        <Pill tone="neutral" style={{ marginBottom: 16, background: '#fff' }}>한 번 도입, 끝까지</Pill>
        <h2 style={{ fontFamily: 'var(--font-brand)', fontSize: 48, fontWeight: 900, letterSpacing: '-0.035em', lineHeight: 1.1, margin: 0 }}>
          전세버스 운영의 모든 순간을<br/>하나의 시스템으로.
        </h2>
        <p style={{ fontSize: 17, color: '#46474B', marginTop: 16, lineHeight: 1.6 }}>
          엑셀과 카카오톡, 종이 운행일지를 대체합니다. 6개월간 동영관광 현장에서 직접 다듬어진 흐름 그대로.
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        {features.map((f, i) => (
          <div key={i} style={{ background: '#fff', borderRadius: 20, padding: '28px 28px', border: '1px solid rgba(0,0,0,0.04)' }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: palette[f.tone].bg, color: palette[f.tone].fg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={f.icon} size={24}/>
            </div>
            <div style={{ fontFamily: 'var(--font-brand)', fontSize: 22, fontWeight: 800, marginTop: 18, letterSpacing: '-0.02em' }}>{f.title}</div>
            <div style={{ fontSize: 14, color: '#46474B', marginTop: 8, lineHeight: 1.6 }}>{f.desc}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LandingScreens() {
  return (
    <section style={{ padding: '96px 56px', background: '#0B1020', color: '#fff', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: -100, left: -100, width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,102,255,0.25), transparent 70%)' }}/>

      <div style={{ position: 'relative', maxWidth: 760 }}>
        <Pill tone="dark" style={{ background: 'rgba(255,255,255,0.10)', color: '#7AB0FF', marginBottom: 16 }} dot>역할별 인터페이스</Pill>
        <h2 style={{ fontFamily: 'var(--font-brand)', fontSize: 48, fontWeight: 900, letterSpacing: '-0.035em', margin: 0, lineHeight: 1.1, color: '#fff' }}>
          관리자·기사·승객·고객사,<br/>
          <span style={{ color: '#7AB0FF' }}>각자 보는 것만.</span>
        </h2>
        <p style={{ fontSize: 17, color: 'rgba(255,255,255,0.7)', marginTop: 16, lineHeight: 1.6 }}>
          한 코드베이스, 네 가지 앱. URL 분리로 캐시까지 분리하니 가볍고 빠릅니다.
        </p>
      </div>

      {/* Role tiles */}
      <div style={{ position: 'relative', marginTop: 56, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        {[
          { url: 'admin.buslink.kr', role: '회사 관리자', desc: '실시간 관제·배차·노선·일지', tone: '#7AB0FF' },
          { url: 'driver.buslink.kr', role: '기사', desc: 'PWA 설치·1탭 운행', tone: '#A3F0BC' },
          { url: 'bus.buslink.kr', role: '승객', desc: 'ETA·QR·푸시 알림', tone: '#FFD089' },
          { url: 'super.buslink.kr', role: '슈퍼관리자', desc: '가입사·빌링·전체 공지', tone: '#E0BFFF' },
        ].map((r, i) => (
          <div key={i} style={{
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16, padding: '24px 24px',
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: r.tone, fontWeight: 600 }}>{r.url}</div>
            <div style={{ fontFamily: 'var(--font-brand)', fontSize: 22, fontWeight: 800, marginTop: 10, color: '#fff' }}>{r.role}</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 6 }}>{r.desc}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LandingPricing() {
  const tiers = [
    { name: 'Starter', desc: '~ 30대 운영', price: '월 19만원', features: ['실시간 관제 1지점', 'QR 탑승', '운행일지 PDF', '이메일 지원'], cta: '14일 무료로 시작' },
    { name: 'Business', desc: '~ 100대 운영', price: '월 59만원', features: ['모든 Starter 기능', '멀티지점·고객사 분리', 'API 연동', '카카오톡 알림톡', '전담 매니저'], featured: true, cta: '데모 신청' },
    { name: 'Enterprise', desc: '100대 이상', price: '맞춤 견적', features: ['모든 Business 기능', '온프레미스 옵션', 'SLA 99.9%', 'SSO·감사 로그', '24/7 지원'], cta: '문의하기' },
  ];
  return (
    <section style={{ padding: '96px 56px', background: '#fff' }}>
      <div style={{ textAlign: 'center', marginBottom: 56 }}>
        <Pill tone="primary" style={{ marginBottom: 16 }}>요금</Pill>
        <h2 style={{ fontFamily: 'var(--font-brand)', fontSize: 48, fontWeight: 900, letterSpacing: '-0.035em', margin: 0, lineHeight: 1.1 }}>
          운영 규모만큼만, 투명하게.
        </h2>
        <p style={{ fontSize: 17, color: '#46474B', marginTop: 14 }}>차량 수 기준. 14일 무료 체험 후 결정하세요.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, maxWidth: 1200, margin: '0 auto' }}>
        {tiers.map((t, i) => (
          <div key={i} style={{
            background: t.featured ? '#0B1020' : '#fff',
            color: t.featured ? '#fff' : '#171719',
            borderRadius: 20, padding: '32px 32px',
            border: t.featured ? 'none' : '1px solid #ECEDEE',
            boxShadow: t.featured ? '0 20px 50px rgba(11,16,32,0.18)' : 'none',
            position: 'relative',
          }}>
            {t.featured && (
              <div style={{ position: 'absolute', top: 14, right: 14, padding: '4px 10px', background: '#0066FF', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 999 }}>
                추천
              </div>
            )}
            <div style={{ fontFamily: 'var(--font-brand)', fontSize: 26, fontWeight: 800 }}>{t.name}</div>
            <div style={{ fontSize: 13, color: t.featured ? 'rgba(255,255,255,0.6)' : '#7C7E83', marginTop: 4 }}>{t.desc}</div>
            <div style={{ marginTop: 24, fontFamily: 'var(--font-brand)', fontSize: 36, fontWeight: 900, letterSpacing: '-0.025em' }}>
              {t.price}
            </div>
            <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {t.features.map((f, j) => (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: t.featured ? 'rgba(255,255,255,0.85)' : '#46474B' }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: t.featured ? 'rgba(122,176,255,0.18)' : '#EAF2FE', color: t.featured ? '#7AB0FF' : '#0066FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="check" size={11} stroke={3}/>
                  </div>
                  {f}
                </div>
              ))}
            </div>
            <button style={{
              marginTop: 28, width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
              background: t.featured ? '#fff' : '#0066FF', color: t.featured ? '#0B1020' : '#fff',
              fontSize: 15, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
            }}>{t.cta}</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function LandingCTA() {
  return (
    <section style={{ padding: '96px 56px', background: '#F7F7F8' }}>
      <div style={{
        background: 'linear-gradient(135deg, #0066FF 0%, #003DCC 100%)',
        borderRadius: 32, padding: '72px 80px', color: '#fff', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 0.08, pointerEvents: 'none' }}>
          <MapMock dim={0.4}/>
        </div>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 40 }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-brand)', fontSize: 48, fontWeight: 900, letterSpacing: '-0.035em', margin: 0, lineHeight: 1.1, color: '#fff' }}>
              매일 검증되는 시스템을<br/>당신의 운영에도.
            </h2>
            <p style={{ fontSize: 17, color: 'rgba(255,255,255,0.78)', marginTop: 14, maxWidth: 560 }}>
              14일 무료 체험. 도입 컨설팅 무료. 데이터 이관 지원.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Btn size="lg" variant="primaryDark">데모 신청</Btn>
            <Btn size="lg" variant="ghost" style={{ color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>영업팀에 연락</Btn>
          </div>
        </div>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer style={{ padding: '56px 56px 40px', background: '#fff', borderTop: '1px solid #ECEDEE' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <BusLinkLogo size={20}/>
          <div style={{ fontSize: 12, color: '#7C7E83', marginTop: 12, maxWidth: 320 }}>
            동영관광 주식회사 · 대표 김도영 · 사업자등록번호 000-00-00000<br/>
            서울 강서구 공항대로 · 1588-0000 · help@buslink.kr
          </div>
        </div>
        <div style={{ display: 'flex', gap: 56, fontSize: 13 }}>
          <FooterCol title="제품" items={['실시간 관제', '배차·노선', '운행일지', '푸시 알림']}/>
          <FooterCol title="회사" items={['도입 사례', '블로그', '채용', '문의']}/>
          <FooterCol title="법적 고지" items={['이용약관', '개인정보처리방침', '보안', '운영정책']}/>
        </div>
      </div>
      <div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid #ECEDEE', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#7C7E83' }}>
        <div>© 2026 BusLink, all rights reserved.</div>
        <div>Made by 동영관광 · Served from Seoul</div>
      </div>
    </footer>
  );
}

function FooterCol({ title, items }) {
  return (
    <div>
      <div style={{ fontWeight: 700, color: '#171719', marginBottom: 12 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, color: '#46474B' }}>
        {items.map(i => <div key={i}>{i}</div>)}
      </div>
    </div>
  );
}

Object.assign(window, { LandingPage });
