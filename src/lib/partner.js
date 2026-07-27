import { db } from "../firebase";
import { normalizeNfcUid, isValidNfcUid } from "./nfc";
import { generateInitialPin, isValidInitialPin } from "./accountCards";
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, serverTimestamp, Timestamp
} from "firebase/firestore";

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

  const now = new Date();
  const expiresAt = data.expiresAt.toDate();
  if (now > expiresAt) throw new Error("만료된 업체코드입니다\n담당자에게 코드 갱신을 요청하세요");

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

        resolve({ employees, errors, total: employees.length });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다"));
    reader.readAsArrayBuffer(file);
  });
}

// ─── 직원 DB 반영 ─────────────────────────────────────────
export async function importEmployees({ companyId, partnerCode, partnerName, employees, routes }) {
  // credentials = 이번에 **신규 발급된** 계정의 평문 PIN. 저장하지 않고 호출부(안내문
  // 인쇄)로만 돌려준다 — 화면을 벗어나면 다시 볼 수 없다(재발급 필요).
  const results = { added: 0, updated: 0, deactivated: 0, skipped: 0, errors: [], credentials: [] };

  // 노선 코드 → routeId 맵 생성
  const routeMap = {};
  routes.forEach(r => {
    if (r.code) routeMap[r.code.trim()] = r.id;
    routeMap[r.name.trim()] = r.id;
  });

  for (const emp of employees) {
    try {
      const ref = doc(db, "companies", companyId, "passengers", emp.empNo);
      const existing = await getDoc(ref);

      // routeId 해석
      const routeId = emp.routeCode
        ? (routeMap[emp.routeCode] || emp.routeCode)
        : (existing.exists() ? existing.data().routeId : "");

      // PIN 변경 잠금(2026-07-21) — 여러 사람이 함께 쓰는 공용/통합 계정용.
      // emp 에 boolean 으로 들어올 때만 기록한다. 파일·다중 등록처럼 값을 안 넘기는
      // 경로에서는 undefined → 필드 미기록 → 기존 잠금 설정 보존(회귀 0).
      const hasPinLocked = typeof emp.pinLocked === "boolean";

      // NFC 사원증 UID(2026-07-22) — pinLocked 와 **같은 조건부 기록 규칙**.
      // 엑셀 일괄 업로드는 nfcUid 를 안 넘기므로 undefined → 필드 미기록 →
      // 이미 등록된 카드가 대량 등록으로 날아가지 않는다(회귀 0).
      // 빈 문자열/null 은 "해제" 의도로 보고 null 기록(수정 모달에서 비운 경우).
      const hasNfcUid = emp.nfcUid !== undefined;
      const nfcUidValue = emp.nfcUid ? normalizeNfcUid(emp.nfcUid) : null;

      const data = {
        empNo: emp.empNo,
        name: emp.name,
        dept: emp.dept,
        routeId,
        routeCode: emp.routeCode,
        active: emp.active,
        partnerCode,
        partnerName,
        companyId,
        updatedAt: serverTimestamp(),
      };
      if (hasPinLocked) data.pinLocked = emp.pinLocked;
      if (hasNfcUid) data.nfcUid = nfcUidValue;

      if (!existing.exists()) {
        // 신규: 초기 PIN 을 **개인별로** 발급(2026-07-27).
        //   이전엔 전원 "000000" 고정이라 사번(명부 순번)만 알면 남의 계정으로
        //   로그인해 그 사람 노선·정류장·공지를 볼 수 있었다. 인원이 늘수록 그대로 확대.
        //   관리자가 엑셀·폼으로 지정한 값이 있으면 그것, 없으면 랜덤 6자리.
        const initialPin = isValidInitialPin(emp.initialPin) ? String(emp.initialPin).trim() : generateInitialPin();
        data.pinHash = await hashPin(initialPin);
        data.pinInitial = true; // 첫 로그인 시 본인 PIN 으로 변경 강제
        data.createdAt = serverTimestamp();
        await setDoc(ref, data);
        results.added++;
        // 평문은 여기서만 존재 — 안내문 인쇄용으로 반환하고 Firestore 엔 남기지 않는다.
        results.credentials.push({ empNo: emp.empNo, name: emp.name, dept: emp.dept || "", routeCode: emp.routeCode || "", pin: initialPin });
      } else {
        // 기존: 정보 업데이트 (PIN은 건드리지 않음)
        await updateDoc(ref, {
          name: emp.name, dept: emp.dept,
          routeId, routeCode: emp.routeCode,
          active: emp.active,
          partnerCode, partnerName, updatedAt: serverTimestamp(),
          ...(hasPinLocked ? { pinLocked: emp.pinLocked } : {}),
          ...(hasNfcUid ? { nfcUid: nfcUidValue } : {}),
        });
        if (!emp.active && existing.data().active) results.deactivated++;
        else results.updated++;
      }
    } catch (e) {
      results.errors.push(`${emp.empNo} (${emp.name}): ${e.message}`);
    }
  }

  // 업체코드 업로드 횟수 업데이트
  await updateDoc(doc(db, "partnerCodes", partnerCode), {
    uploadCount: (await getDoc(doc(db, "partnerCodes", partnerCode))).data().uploadCount + 1,
    lastUploadAt: serverTimestamp(),
  });

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
export async function reissuePins({ companyId, passengers }) {
  const credentials = [];
  const errors = [];
  for (const p of passengers || []) {
    const empNo = String(p.empNo || p.id || "").trim();
    if (!empNo) { errors.push("사번 없는 항목 건너뜀"); continue; }
    try {
      const pin = generateInitialPin();
      await updateDoc(doc(db, "companies", companyId, "passengers", empNo), {
        pinHash: await hashPin(pin),
        pinInitial: true,
        updatedAt: serverTimestamp(),
      });
      credentials.push({ empNo, name: p.name || "", dept: p.dept || "", routeCode: p.routeCode || "", pin });
    } catch (e) {
      errors.push(`${empNo} (${p.name || ""}): ${e.message}`);
    }
  }
  return { credentials, errors };
}

// ─── PIN 해시 (SHA-256) ───────────────────────────────────
export async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + "buslink_salt_2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── 탑승 검증 (사번 + PIN) ──────────────────────────────
export async function verifyPassenger({ companyId, empNo, pin, routeId, tokenId }) {
  const ref = doc(db, "companies", companyId, "passengers", empNo);
  const snap = await getDoc(ref);

  if (!snap.exists()) throw new Error("등록되지 않은 사번입니다\n담당자에게 문의하세요");

  const p = snap.data();
  if (!p.active) throw new Error("비활성화된 사번입니다\n퇴사 처리되었거나 담당자에게 문의하세요");

  // PIN 검증
  const hashed = await hashPin(pin);
  if (p.pinHash !== hashed) throw new Error("PIN이 올바르지 않습니다");

  // 노선 검증 (배정된 노선과 다른 경우 경고만, 차단은 운영 정책에 따라)
  let routeWarning = null;
  if (p.routeId && routeId && p.routeId !== routeId) {
    routeWarning = `배정 노선과 다른 버스입니다\n배정: ${p.routeCode || p.routeId}`;
  }

  // 당일 중복 탑승 체크
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const boardingRef = collection(db, "companies", companyId, "boardings", today, "list");
  const dupSnap = await getDocs(query(boardingRef, where("empNo", "==", empNo)));
  if (!dupSnap.empty) {
    const firstBoarding = dupSnap.docs[0].data();
    const boardedTime = firstBoarding.boardedAt?.toDate?.()?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) || "";
    throw new Error(`오늘 이미 탑승 처리되었습니다 (${boardedTime})\n부정 탑승 의심 기록이 남습니다`);
  }

  return {
    name: p.name,
    dept: p.dept,
    routeWarning,
    pinInitial: p.pinInitial || false,
  };
}

// ─── 샘플 엑셀 생성 ──────────────────────────────────────
export function downloadSampleExcel() {
  const XLSX = window.XLSX;
  // NFC 카드번호·초기PIN 은 **선택 컬럼** — 비워두면 기존 등록이 그대로 보존된다(지워지지 않음).
  // 초기PIN 을 비우면 신규 등록 승객마다 자동으로 서로 다른 PIN 이 발급된다(권장).
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
