// screens-login.jsx — Login screens (3 role variants)

// Admin login — split layout, dark left brand panel + clean right form
function LoginAdmin() {
  return (
    <div style={{ width: 1280, height: 800, background: '#fff', display: 'flex', fontFamily: 'var(--font-base)' }}>
      {/* Left — brand */}
      <div style={{
        flex: '0 0 520px', background: 'linear-gradient(160deg, #0B1020 0%, #0F1A3D 60%, #0066FF 140%)',
        color: '#fff', padding: '56px 56px', position: 'relative', overflow: 'hidden',
      }}>
        <BusLinkLogo size={26} color="#fff" />

        {/* faint map silhouette in background */}
        <div style={{ position: 'absolute', right: -120, top: 80, opacity: 0.10, width: 640, height: 640, pointerEvents: 'none' }}>
          <MapMock dim={0} />
        </div>

        <div style={{ position: 'relative', marginTop: 96 }}>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>For fleet operators</div>
          <h1 style={{
            fontFamily: 'var(--font-brand)', fontSize: 56, lineHeight: 1.12, letterSpacing: '-0.035em',
            fontWeight: 800, margin: 0, color: '#fff',
          }}>
            300대를 한 화면에,<br/>
            <span style={{ color: '#7AB0FF' }}>실시간으로.</span>
          </h1>
          <p style={{ marginTop: 20, fontSize: 16, lineHeight: 1.6, color: 'rgba(255,255,255,0.72)', maxWidth: 380 }}>
            동영관광이 직접 운영하며 만든 통근버스 관제 시스템. 설치 없이 링크 하나로 시작하세요.
          </p>

          <div style={{ marginTop: 56, display: 'flex', gap: 28 }}>
            <Stat n="237" label="운행 중 차량"/>
            <Stat n="98.6%" label="GPS 가동률"/>
            <Stat n="14ms" label="평균 응답"/>
          </div>
        </div>

        <div style={{ position: 'absolute', left: 56, bottom: 36, fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
          © 2026 BusLink · 동영관광
        </div>
      </div>

      {/* Right — form */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        {/* Lang toggle */}
        <div style={{ position: 'absolute', top: 24, right: 32, display: 'flex', gap: 4, padding: 4, background: '#F2F2F3', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
          <div style={{ padding: '5px 12px', borderRadius: 999, background: '#fff', color: '#171719', boxShadow: '0 1px 2px rgba(0,0,0,0.06)' }}>한국어</div>
          <div style={{ padding: '5px 12px', borderRadius: 999, color: '#7C7E83' }}>English</div>
        </div>

        <div style={{ width: 420 }}>
          <Pill tone="primary" dot style={{ marginBottom: 20 }}>관리자 로그인</Pill>
          <h2 style={{ fontSize: 32, fontWeight: 800, margin: 0, letterSpacing: '-0.025em', color: '#171719' }}>다시 오신 걸 환영합니다</h2>
          <p style={{ fontSize: 15, color: '#7C7E83', marginTop: 8, marginBottom: 32 }}>관리자 계정으로 로그인하세요.</p>

          <Field label="이메일" value="admin@dongyeongtour.co.kr" />
          <Field label="비밀번호" value="••••••••••••" type="password" trailing={<span style={{ fontSize: 13, color: '#0066FF', fontWeight: 600 }}>비밀번호 찾기</span>} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 14, color: '#46474B' }}>
            <Check checked /> 로그인 상태 유지
          </div>

          <button style={{
            width: '100%', marginTop: 24, padding: '16px', borderRadius: 12,
            background: '#0066FF', color: '#fff', fontWeight: 700, fontSize: 16, border: 'none',
            cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            관리자 콘솔로 이동 <Icon name="arrow" size={18}/>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '24px 0', color: '#AEB0B6', fontSize: 12 }}>
            <div style={{ flex: 1, height: 1, background: '#ECEDEE' }}/>
            다른 역할로 로그인
            <div style={{ flex: 1, height: 1, background: '#ECEDEE' }}/>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <RoleButton icon="bus" title="기사" sub="사번·PIN" />
            <RoleButton icon="user" title="승객" sub="사번·PIN" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ n, label }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-brand)', fontSize: 28, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>{n}</div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Field({ label, value, type = 'text', trailing }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#46474B' }}>{label}</label>
        {trailing}
      </div>
      <div style={{
        padding: '14px 16px', border: '1px solid #DBDCDF', borderRadius: 12,
        background: '#fff', fontSize: 15, color: '#171719', fontWeight: 500,
      }}>
        {type === 'password' ? value : value}
      </div>
    </div>
  );
}

function Check({ checked }) {
  return (
    <div style={{
      width: 18, height: 18, borderRadius: 5,
      background: checked ? '#0066FF' : '#fff',
      border: `1.5px solid ${checked ? '#0066FF' : '#C2C4C8'}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      {checked && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>}
    </div>
  );
}

function RoleButton({ icon, title, sub }) {
  return (
    <div style={{
      padding: '14px', borderRadius: 12, border: '1px solid #DBDCDF', background: '#fff',
      display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
    }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: '#EAF2FE', color: '#0066FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20}/>
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#171719' }}>{title}</div>
        <div style={{ fontSize: 12, color: '#7C7E83', marginTop: 1 }}>{sub}</div>
      </div>
    </div>
  );
}

// Driver / Passenger mobile login — keypad PIN
function LoginMobile({ role = 'driver' }) {
  const isDriver = role === 'driver';
  return (
    <div style={{ width: '100%', height: '100%', background: '#fff', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-base)', padding: '24px 24px 40px' }}>
      <div style={{ marginTop: 12 }}>
        <BusLinkLogo size={20} />
      </div>

      <div style={{ marginTop: 56 }}>
        <Pill tone={isDriver ? 'primary' : 'violet'} dot>
          {isDriver ? '기사 로그인' : '승객 로그인'}
        </Pill>
        <h2 style={{ fontSize: 26, fontWeight: 800, margin: '14px 0 4px', letterSpacing: '-0.025em' }}>
          {isDriver ? '오늘도 안전 운행' : '버스가 어디쯤 왔나요?'}
        </h2>
        <p style={{ fontSize: 14, color: '#7C7E83', margin: 0 }}>사번과 PIN 6자리로 로그인하세요.</p>
      </div>

      {/* Inputs */}
      <div style={{ marginTop: 32 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#46474B', marginBottom: 6 }}>사번</div>
        <div style={{ padding: '14px 16px', border: '1.5px solid #0066FF', borderRadius: 12, background: '#fff', fontSize: 17, color: '#171719', fontWeight: 600, letterSpacing: 1 }}>
          DY{isDriver ? '4821' : '2847'}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#46474B', marginBottom: 6 }}>PIN 6자리</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[1, 1, 1, 1, 0, 0].map((f, i) => (
            <div key={i} style={{
              flex: 1, aspectRatio: '1', borderRadius: 12,
              border: f ? '1.5px solid #DBDCDF' : '1.5px solid #DBDCDF',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#fff',
            }}>
              {f ? <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#171719' }}/> : null}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }}/>

      {/* Keypad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 24 }}>
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) => (
          <button key={i} disabled={!k} style={{
            padding: '18px 0', fontSize: 22, fontWeight: 600, color: '#171719',
            background: k ? '#F7F7F8' : 'transparent', border: 'none', borderRadius: 12,
            fontFamily: 'inherit', cursor: k ? 'pointer' : 'default',
          }}>{k}</button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { LoginAdmin, LoginMobile });
