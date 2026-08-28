// 명부 일괄 반영 — **판정만** 하는 순수 모듈 (2026-08-28 P3-a)
//
// 🔴 왜 따로 뺐나: 이 판정이 틀리면 ⓐ 이미 쓰던 사람의 PIN 이 새로 발급돼 **로그인 불가**가
//    되거나 ⓑ 남의 거래처 사람 문서를 덮어쓴다. 그런데 `index.js` 는 `defineSecret`·
//    `initializeApp` 이 있어 격리 테스트로 태울 수 없다(아키타입 C playbook).
//    그래서 **Firestore 를 만지지 않는 결정 부분만** 여기 두고, 실행(getAll·BulkWriter)은
//    index.js 가 한다. 테스트는 이 파일을 그대로 태운다 — 규칙을 복제하지 않는다.
//
// 계약: 입력은 평범한 객체뿐이고 출력도 그렇다. 여기서 시각·난수·네트워크를 만들지 않는다
//      (`now`·`makePin`·`hashPin` 은 호출부가 주입한다 — 그래야 테스트가 결정적이다).

/** 사번 정규화 — 문서 ID 이자 유일 키. 공백만 있으면 빈 문자열. */
function normEmpNo(v) {
  return String(v == null ? "" : v).trim();
}

/**
 * 조각 안에서 같은 사번이 여러 번 나오면 **뒤엣것만** 남긴다.
 * (엑셀 파서가 "사번이 겹쳐서 N명만 등록됩니다"로 이미 알린다 — 여기서 행을 버리지 않고
 *  마지막 값을 정본으로 삼는 것은 옛 순차 처리의 동작과 같다.)
 */
function dedupeRows(rows, errors) {
  const byEmpNo = new Map();
  for (const emp of Array.isArray(rows) ? rows : []) {
    const n = normEmpNo(emp && emp.empNo);
    if (!n) { errors.push("사번이 비어 있는 행을 건너뜀"); continue; }
    byEmpNo.set(n, Object.assign({}, emp, { empNo: n }));
  }
  return [...byEmpNo.values()];
}

/**
 * 무엇을 쓸지 정한다. Firestore 접근 0.
 *
 * @param {object}  a
 * @param {Array}   a.rows      클라가 보낸 행
 * @param {Map}     a.existing  empNo → 기존 문서 데이터(**문서 ID 로 직접 조회한 것**.
 *                              협력사로 좁혀 조회하면 이관자를 신규로 오판한다)
 * @param {string}  a.code      업체코드(서버가 검증한 값)
 * @param {*}       a.now       serverTimestamp 센티널
 * @param {func}    a.makePin   () => "123456"
 * @param {func}    a.hashPin   (pin) => hash
 * @param {func}    a.validPin  (v) => boolean  관리자 지정 초기 PIN 이 쓸 만한가
 * @param {func}    [a.normNfc] (uid) => 정규화 UID
 */
function planRosterWrites({ rows, existing, code, companyId, partnerName, now, makePin, hashPin, validPin, normNfc }) {
  const results = { added: 0, updated: 0, deactivated: 0, skipped: 0, errors: [], credentials: [] };
  const list = dedupeRows(rows, results.errors);
  const ops = [];

  for (const emp of list) {
    const prev = existing.get(emp.empNo) || null;
    // 노선은 클라가 이미 해석해 보낸다(routeId). 없으면 코드 그대로, 그것도 없으면 기존 값 유지.
    const routeId = emp.routeCode ? (emp.routeId || emp.routeCode) : (prev ? prev.routeId : "");

    const base = {
      empNo: emp.empNo,
      name: emp.name || "",
      dept: emp.dept || "",
      routeId: routeId || "",
      routeCode: emp.routeCode || "",
      active: emp.active !== false,
      partnerCode: code,
      partnerName: partnerName || null,
      companyId,
      updatedAt: now,
    };
    // 🔴 값을 **안 보냈으면 키를 넣지 않는다** — 엑셀 대량 등록이 이미 등록된 NFC 카드나
    //    PIN 잠금을 지우지 않게 하는 규칙(2026-07-22 부터의 계약).
    if (typeof emp.pinLocked === "boolean") base.pinLocked = emp.pinLocked;
    if (emp.nfcUid !== undefined) base.nfcUid = emp.nfcUid ? (normNfc ? normNfc(emp.nfcUid) : emp.nfcUid) : null;

    if (!prev) {
      const pin = validPin(emp.initialPin) ? String(emp.initialPin).trim() : makePin();
      ops.push({
        kind: "set",
        empNo: emp.empNo,
        data: Object.assign({}, base, { pinInitial: true, createdAt: now }),
        // 🔴 해시는 명부가 아니라 secrets 로. 이 한 줄이 P3-a 의 전부다.
        secret: { companyId, empNo: emp.empNo, pinHash: hashPin(pin), updatedAt: now },
      });
      results.added++;
      // 평문은 여기서만 존재 — 안내문 인쇄용으로 돌려주고 저장하지 않는다.
      results.credentials.push({
        empNo: emp.empNo, name: base.name, dept: base.dept,
        routeCode: base.routeCode, pin,
      });
    } else {
      const patch = {
        name: base.name, dept: base.dept, routeId: base.routeId, routeCode: base.routeCode,
        active: base.active, partnerCode: code, partnerName: base.partnerName, updatedAt: now,
      };
      if (typeof emp.pinLocked === "boolean") patch.pinLocked = emp.pinLocked;
      if (emp.nfcUid !== undefined) patch.nfcUid = base.nfcUid;
      ops.push({ kind: "update", empNo: emp.empNo, data: patch });
      // 🔴 기존 사람에게는 PIN 을 **절대 새로 발급하지 않는다**(그 순간 로그인이 끊긴다).
      if (base.active === false && prev.active) results.deactivated++;
      else results.updated++;
    }
  }
  return { ops, results };
}

/**
 * PIN 재발급 계획. **대상이 그 거래처 소속인지**를 여기서 가른다 —
 * 안 가르면 업체코드 하나로 남의 거래처 사람 PIN 을 갈아치울 수 있다.
 */
function planReissue({ rows, owned, code, companyId, now, makePin, hashPin }) {
  const credentials = [];
  const errors = [];
  const ops = [];
  for (const p of Array.isArray(rows) ? rows : []) {
    const empNo = normEmpNo(p && (p.empNo || p.id));
    if (!empNo) { errors.push("사번 없는 항목 건너뜀"); continue; }
    const cur = owned.get(empNo);
    if (!cur) { errors.push(empNo + ": 명부에 없습니다"); continue; }
    if ((cur.partnerCode || null) !== code) { errors.push(empNo + ": 이 거래처 소속이 아닙니다"); continue; }
    const pin = makePin();
    ops.push({
      empNo,
      secret: { companyId, empNo, pinHash: hashPin(pin), updatedAt: now },
      // 명부에는 상태만. 옛 해시가 남아 있으면 이 기회에 걷는다(폴백 경로로 계속 먹히지 않게).
      patch: { pinInitial: true, deletePinHash: true, updatedAt: now },
    });
    credentials.push({
      empNo, name: p.name || cur.name || "", dept: p.dept || cur.dept || "",
      routeCode: p.routeCode || cur.routeCode || "", pin,
    });
  }
  return { ops, credentials, errors };
}

module.exports = { normEmpNo, dedupeRows, planRosterWrites, planReissue };
