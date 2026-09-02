import { db } from "../firebase";
import { isValidNfcUid } from "./nfc";
import { isValidInitialPin } from "./accountCards";
// 🔴 2026-08-28 P3-a — 명부 쓰기가 CF 로 넘어가며 이 파일이 쓰던 Firestore API 가 줄었다.
//    `normalizeNfcUid`·`generateInitialPin`·컬렉션 조회 계열은 이제 서버가 한다.
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp, increment } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";

// 🔴 리전 고정 — 기본값(us-central1)이라도 명시한다(boarding.js 와 같은 규약).
const functions = getFunctions(undefined, "us-central1");

// ─── 업체코드 생성 ────────────────────────────────────────
export function generatePartnerCode(companyId, partnerName) {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  const year = new Date().getFullYear();
  const slug = partnerName
    .replace(/[^a-zA-Z0-9가-힣]/g, "")
    .substring(0, 8)
    .toUpperCase();
  return `${companyId.toUpperCase()}-${slug}-${year}-${rand}`;
}

// ─── 업체코드 저장 ────────────────────────────────────────
export async function createPartnerCode({ companyId, partnerName, allowedRouteIds, memo, createdBy }) {
  const code = generatePartnerCode(companyId, partnerName);
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1년 유효

  await setDoc(doc(db, "partnerCodes", code), {
    code, companyId, partnerName,
    allowedRouteIds: allowedRouteIds || [],  // 빈 배열 = 모든 노선 허용
    memo: memo || "",
    active: true,
    createdAt: serverTimestamp(),
    // 발급한 admin uid — 제한 admin 이 본인 생성 협력사를 권한 부여 전에도 열람·관리하도록(2026-06-15).
    createdBy: createdBy || null,
    expiresAt: Timestamp.fromDate(expiresAt),
    uploadCount: 0,
    lastUploadAt: null,
  });
  return code;
}

// ─── 업체코드 검증 ────────────────────────────────────────
export async function validatePartnerCode(code) {
  const snap = await getDoc(doc(db, "partnerCodes", code.trim()));
  if (!snap.exists()) throw new Error("유효하지 않은 업체코드입니다");

  const data = snap.data();
  if (!data.active) throw new Error("비활성화된 업체코드입니다\n담당자에게 문의하세요");

  // 🔴 `expiresAt` 이 없거나 null 이면 **만료 없음**으로 본다(2026-09-02 발견).
  //    종전엔 `data.expiresAt.toDate()` 를 그냥 불러, 만료를 안 건 문서에서
  //    `Cannot read properties of null (reading 'toDate')` 가 화면에 그대로 떴다
  //    — 담당자에게는 "업체코드가 틀렸나?" 로만 보인다. 실제로 `seed_sample_partner.cjs`
  //    가 만든 시연용 거래처(`expiresAt: null`)는 이 때문에 **한 번도 로그인된 적이 없다**.
  //    `createPartnerCode` 는 늘 1년 뒤를 넣으므로 정상 발급분의 동작은 그대로다.
  const now = new Date();
  const expiresAt = typeof data.expiresAt?.toDate === "function" ? data.expiresAt.toDate() : null;
  if (expiresAt && now > expiresAt) throw new Error("만료된 업체코드입니다\n담당자에게 코드 갱신을 요청하세요");

  return data; // { companyId, partnerName, allowedRouteIds, ... }
}

// ─── 엑셀 파싱 (SheetJS) ─────────────────────────────────
export function parseEmployeeExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const XLSX = window.XLSX;
        if (!XLSX) throw new Error("엑셀 라이브러리 로딩 중입니다. 잠시 후 다시 시도해주세요.");
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

        // 헤더 행 찾기 (사번 포함된 행)
        let headerIdx = -1;
        for (let i = 0; i < Math.min(rows.length, 5); i++) {
          const row = rows[i].map(c => String(c).trim());
          if (row.some(c => c.includes("사번") || c.toLowerCase().includes("empno"))) {
            headerIdx = i;
            break;
          }
        }
        if (headerIdx === -1) throw new Error("헤더 행을 찾을 수 없습니다.\n첫 번째 행에 사번, 이름, 부서, 노선코드, 재직여부 컬럼이 있어야 합니다.");

        const headers = rows[headerIdx].map(c => String(c).trim().toLowerCase());
        const colMap = {
          empNo:  headers.findIndex(h => h.includes("사번") || h.includes("empno")),
          name:   headers.findIndex(h => h.includes("이름") || h.includes("name")),
          dept:   headers.findIndex(h => h.includes("부서") || h.includes("dept")),
          route:  headers.findIndex(h => h.includes("노선") || h.includes("route")),
          active: headers.findIndex(h => h.includes("재직") || h.includes("active")),
          // NFC 사원증 카드번호(2026-07-22·선택 컬럼). 없으면 -1 → 아무 것도 안 건드림.
          nfc:    headers.findIndex(h => h.includes("nfc") || h.includes("카드")),
          // 초기 PIN(2026-07-27·선택 컬럼). 비우면 신규 승객마다 자동 랜덤 발급.
          // "카드"(nfc)와 겹치지 않도록 pin/비밀번호 계열만 매칭한다.
          pin:    headers.findIndex(h => h.includes("pin") || h.includes("비밀번호")),
        };

        if (colMap.empNo === -1) throw new Error("사번 컬럼을 찾을 수 없습니다");
        if (colMap.name  === -1) throw new Error("이름 컬럼을 찾을 수 없습니다");

        const employees = [];
        const errors = [];

        rows.slice(headerIdx + 1).forEach((row, idx) => {
          const lineNo = headerIdx + idx + 2;
          const empNo = String(row[colMap.empNo] || "").trim();
          const name  = String(row[colMap.name]  || "").trim();
          if (!empNo && !name) return; // 빈 행 스킵

          if (!empNo) { errors.push(`${lineNo}행: 사번 없음`); return; }
          if (!name)  { errors.push(`${lineNo}행: 이름 없음 (사번: ${empNo})`); return; }

          const activeVal = colMap.active !== -1
            ? String(row[colMap.active] || "Y").trim().toUpperCase()
            : "Y";

          // NFC 카드번호 — ⚠ **셀이 비어 있으면 키 자체를 안 넣는다**.
          //   importEmployees 는 `nfcUid !== undefined` 일 때만 기록하므로, 빈 셀에
          //   ""/null 을 넣으면 이미 등록된 카드가 대량 업로드로 전부 지워진다.
          //   "값이 있을 때만 덮어쓰기" = 부분 명부 업로드로도 기존 등록 보존.
          const emp = {
            empNo,
            name,
            dept: colMap.dept !== -1 ? String(row[colMap.dept] || "").trim() : "",
            routeCode: colMap.route !== -1 ? String(row[colMap.route] || "").trim() : "",
            active: activeVal !== "N" && activeVal !== "FALSE" && activeVal !== "0",
          };
          if (colMap.nfc !== -1) {
            const rawUid = String(row[colMap.nfc] || "").trim();
            if (rawUid) {
              if (!isValidNfcUid(rawUid)) {
                errors.push(`${lineNo}행: NFC 카드번호 형식 오류 "${rawUid}" (사번: ${empNo})`);
              } else {
                emp.nfcUid = rawUid; // 정규화는 importEmployees 가 수행
              }
            }
          }
          // 초기 PIN — NFC 와 같은 규칙: **빈 셀이면 키를 아예 안 넣는다**.
          //   importEmployees 는 신규 승객에만 PIN 을 발급하므로 기존 승객의 PIN 은
          //   어느 경로로도 대량 업로드에 덮이지 않는다.
          if (colMap.pin !== -1) {
            const rawPin = String(row[colMap.pin] || "").trim();
            if (rawPin) {
              if (!isValidInitialPin(rawPin)) {
                errors.push(`${lineNo}행: 초기 PIN 형식 오류 "${rawPin}" — 숫자 4~6자리 (사번: ${empNo})`);
              } else {
                emp.initialPin = rawPin;
              }
            }
          }
          employees.push(emp);
        });

        // 🔴 사번 중복 검출 (2026-07-30 배시현 개선요청: "241명 올렸는데 238명만 등록")
        //   importEmployees 는 **사번을 문서 ID** 로 쓴다(passengers/{empNo}) → 엑셀에 같은
        //   사번이 두 번 있으면 뒤 행이 앞 행을 **조용히 덮어써** 인원이 줄어든다. 화면에
        //   이유가 안 나오면 담당자는 왜 줄었는지 알 수 없다 → 여기서 명시적으로 알린다.
        //   ⚠ 행을 버리지는 않는다(어느 쪽이 정본인지 알 수 없다) — 보고만 하고 기존
        //   덮어쓰기 동작을 유지해 담당자가 엑셀을 고쳐 다시 올릴 수 있게 한다.
        const seenEmpNo = new Map();   // empNo → 처음 나온 행 번호
        employees.forEach((e, i) => {
          const line = headerIdx + i + 2;
          if (seenEmpNo.has(e.empNo)) {
            errors.push(`사번 ${e.empNo} 중복 — ${seenEmpNo.get(e.empNo)}행과 같습니다. 뒤 행이 앞 행을 덮어써 인원이 줄어듭니다`);
          } else {
            seenEmpNo.set(e.empNo, line);
          }
        });

        resolve({ employees, errors, total: employees.length, uniqueCount: seenEmpNo.size });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다"));
    reader.readAsArrayBuffer(file);
  });
}

// ─── 직원 DB 반영 ─────────────────────────────────────────
export async function importEmployees({ companyId, partnerCode, partnerName, employees, routes, onProgress }) {
  // credentials = 이번에 **신규 발급된** 계정의 평문 PIN. 저장하지 않고 호출부(안내문
  // 인쇄)로만 돌려준다 — 화면을 벗어나면 다시 볼 수 없다(재발급 필요).
  //
  // ═══ 서버 대행(2026-08-28 P3-a) ═══════════════════════════════════════
  // 🔴 예전엔 이 함수가 클라에서 직접 명부를 썼다. PIN 해시가 `passengerSecrets`
  //    (rules read/write false)로 옮겨가면서 **클라는 그 값을 쓸 수 없다** —
  //    그게 목적이다(명부가 익명에게 열려 있어도 자격증명은 못 만지게).
  //    이제 CF `partnerImportPassengers` 가 대행하고, 여기서는 **보낼 행을 만들고
  //    조각으로 나눠 부르고 결과를 합치는 일만** 한다.
  // ⚠ 2026-08-28 오전에 넣은 클라측 배치(`documentId() in` 청크 + writeBatch)는
  //    이 전환으로 통째로 사라졌다 — 서버가 `getAll` + BulkWriter 로 같은 일을 하고
  //    왕복이 아예 없어 더 빠르다. **되돌리지 말 것**(되돌리면 해시를 못 써서 신규
  //    등록이 통째로 실패한다).
  const results = { added: 0, updated: 0, deactivated: 0, skipped: 0, errors: [], credentials: [] };

  // 노선 코드 → routeId 맵은 **클라에서** 푼다 — 노선 목록을 이미 들고 있고,
  // 서버로 보내면 그 조회를 조각마다 되풀이하게 된다.
  const routeMap = {};
  (routes || []).forEach(r => {
    if (!r) return;
    if (r.code) routeMap[String(r.code).trim()] = r.id;
    if (r.name) routeMap[String(r.name).trim()] = r.id;
  });

  const report = (phase, done, total) => { try { onProgress && onProgress({ phase, done, total }); } catch (_) {} };

  // 같은 사번이 파일에 여러 번 있으면 **뒤엣것만** 남긴다(파서가 "사번이 겹쳐서
  // N명만 등록됩니다"로 이미 알린다). 서버도 조각 안에서 같은 규칙을 쓴다.
  const byEmpNo = new Map();
  for (const emp of employees || []) {
    const n = String(emp && emp.empNo != null ? emp.empNo : "").trim();
    if (!n) { results.errors.push("사번이 비어 있는 행을 건너뜀"); continue; }
    byEmpNo.set(n, {
      empNo: n,
      name: emp.name || "",
      dept: emp.dept || "",
      routeCode: emp.routeCode || "",
      // 노선 해석 결과를 같이 보낸다(서버는 routeCode 폴백만 한다).
      routeId: emp.routeCode ? (routeMap[emp.routeCode] || emp.routeCode) : undefined,
      active: emp.active !== false,
      // 🔴 값이 없으면 **키를 아예 안 넣는다** — 서버가 `undefined` 로 보고 기존 값을
      //    보존한다(엑셀 대량 등록이 등록된 NFC 카드·PIN 잠금을 지우지 않는 규칙).
      ...(typeof emp.pinLocked === "boolean" ? { pinLocked: emp.pinLocked } : {}),
      ...(emp.nfcUid !== undefined ? { nfcUid: emp.nfcUid } : {}),
      ...(emp.initialPin ? { initialPin: emp.initialPin } : {}),
    });
  }
  const rows = [...byEmpNo.values()];
  if (!rows.length) return results;

  // 조각 크기 — 서버 상한은 1000명. 진행률이 자주 갱신되도록 500 으로 나눈다.
  const CHUNK = 500;
  const call = httpsCallable(functions, "partnerImportPassengers");
  let done = 0;
  report("write", 0, rows.length);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    try {
      const { data } = await call({ companyId, partnerCode, partnerName, employees: part });
      results.added += data.added || 0;
      results.updated += data.updated || 0;
      results.deactivated += data.deactivated || 0;
      results.skipped += data.skipped || 0;
      if (Array.isArray(data.errors)) results.errors.push(...data.errors);
      if (Array.isArray(data.credentials)) results.credentials.push(...data.credentials);
    } catch (e) {
      // 🔴 조각 하나가 실패해도 나머지는 계속 올린다 — 16,000명 업로드가 통신 한 번에
      //    통째로 무산되면 담당자는 처음부터 다시 해야 한다. 실패 구간은 사번으로 알린다.
      results.errors.push(`${part[0].empNo}~${part[part.length - 1].empNo} ${part.length}명 등록 실패: ${e.message}`);
    }
    done += part.length;
    report("write", Math.min(done, rows.length), rows.length);
  }

  // 업체코드 업로드 횟수 — 실패해도 등록 결과에는 영향이 없다(집계용).
  try {
    await updateDoc(doc(db, "partnerCodes", partnerCode), {
      uploadCount: increment(1),
      lastUploadAt: serverTimestamp(),
    });
  } catch (_) { /* 집계 실패는 무시 */ }

  return results;
}

// ─── PIN 재발급 (안내문 재출력용) ─────────────────────────
/**
 * 선택한 승객들의 PIN 을 새로 발급한다(2026-07-27).
 *
 * 평문 PIN 을 저장하지 않으므로 안내문은 발급 직후 1회만 인쇄할 수 있다. 배부물을
 * 잃어버렸거나 아직 안 뿌린 인원에게 다시 뽑아주려면 이 경로로 새 PIN 을 발급한다.
 * `pinInitial:true` 로 되돌리므로 그 승객은 다음 로그인 때 본인 PIN 설정 화면을 다시 만난다.
 *
 * ⚠ 이미 본인 PIN 으로 바꾼 사람에게 쓰면 그 사람은 로그인 못 하게 된다 —
 *   호출부가 대상(미접속자 등)을 좁히고 확인을 받는다.
 *
 * @returns {Promise<{credentials:Array, errors:string[]}>} credentials 는 importEmployees 와 동일 형식.
 */
export async function reissuePins({ companyId, partnerCode, passengers }) {
  // 🔴 2026-08-28 P3-a — 이 함수도 서버 대행이다. PIN 해시는 `passengerSecrets`
  //    (rules read/write false)에 있어 클라가 못 쓴다. CF 가 **대상이 그 거래처
  //    소속인지 확인한 뒤** 새 해시를 쓰고 평문만 돌려준다(저장하지 않는다).
  // ⚠ 반환 계약은 예전 그대로: { credentials, errors }.
  const rows = (passengers || [])
    .map((p) => ({
      empNo: String((p && (p.empNo || p.id)) || "").trim(),
      name: p.name || "", dept: p.dept || "", routeCode: p.routeCode || "",
    }))
    .filter((p) => p.empNo);
  if (!rows.length) return { credentials: [], errors: ["대상이 없습니다"] };

  const call = httpsCallable(functions, "partnerReissuePins");
  const credentials = [];
  const errors = [];
  // 서버 상한 1000명 — 미접속자 일괄 재발급은 만 명대가 될 수 있어 나눠 부른다.
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    try {
      const { data } = await call({ companyId, partnerCode, passengers: part });
      if (Array.isArray(data.credentials)) credentials.push(...data.credentials);
      if (Array.isArray(data.errors)) errors.push(...data.errors);
    } catch (e) {
      errors.push(`${part.length}명 재발급 실패: ${e.message}`);
    }
  }
  return { credentials, errors };
}

// ─── PIN 해시는 서버에만 있다(2026-08-28 P3-a) ───────────────────────
// 옛 `hashPin`(WebCrypto)은 클라가 해시를 만들어 명부에 쓰던 시절의 것이다.
// 지금은 CF `hashPinAdmin` 이 정본이고 결과는 `passengerSecrets` 에만 들어간다.
// 🔴 클라에 해시 함수를 다시 만들지 말 것 — 두 벌이 되면 salt 가 갈리는 날 전원 로그인 불가다.
// ─── 탑승 검증은 여기 없다(2026-08-28 P3-a) ─────────────────────────
// 옛 `verifyPassenger` 는 클라에서 `pinHash` 를 읽어 대조하던 함수였다. 호출부가
// 0 이었고(전수 grep), 해시가 `passengerSecrets` 로 옮겨가 원리적으로 못 읽으므로 걷었다.
// 탑승 검증 정본 = `boarding.js validateAndBoard` · CF `boardStatic`.

// ─── 샘플 엑셀 생성 ──────────────────────────────────────
export function downloadSampleExcel() {
  const XLSX = window.XLSX;
  // NFC 카드번호·초기PIN 은 **선택 컬럼** — 비워두면 기존 등록이 그대로 보존된다(지워지지 않음).
  // 초기PIN 을 비우면 신규 등록 승객은 전원 공통 `000000` 으로 발급된다(2026-08-25 way 결정).
  //   개인별로 다른 값을 주고 싶으면 이 컬럼에 직접 채워 넣으면 그 값이 이긴다.
  const ws = XLSX.utils.aoa_to_sheet([
    ["사번", "이름", "부서", "노선코드", "재직여부(Y/N)", "NFC카드번호(선택)", "초기PIN(선택)"],
    ["10001", "홍길동", "개발팀", "662", "Y", "0453CE9A", ""],
    ["10002", "김철수", "인사팀", "663", "Y", "04:1A:2B:3C", "1234"],
    ["10003", "이영희", "총무팀", "662", "N", "", ""],
  ]);
  ws["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 20 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "승객명부");
  XLSX.writeFile(wb, "BusLink_승객명부_양식.xlsx");
}
