import { db } from "../firebase";
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
export async function createPartnerCode({ companyId, partnerName, allowedRouteIds, memo }) {
  const code = generatePartnerCode(companyId, partnerName);
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1년 유효

  await setDoc(doc(db, "partnerCodes", code), {
    code, companyId, partnerName,
    allowedRouteIds: allowedRouteIds || [],  // 빈 배열 = 모든 노선 허용
    memo: memo || "",
    active: true,
    createdAt: serverTimestamp(),
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

          employees.push({
            empNo,
            name,
            dept: colMap.dept !== -1 ? String(row[colMap.dept] || "").trim() : "",
            routeCode: colMap.route !== -1 ? String(row[colMap.route] || "").trim() : "",
            active: activeVal !== "N" && activeVal !== "FALSE" && activeVal !== "0",
          });
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
  const results = { added: 0, updated: 0, deactivated: 0, skipped: 0, errors: [] };

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

      if (!existing.exists()) {
        // 신규: 초기 PIN 생성 (생년월일 대신 임시 PIN - 관리자가 별도 전달)
        data.pinHash = await hashPin("000000"); // 초기 PIN: 000000
        data.pinInitial = true; // 첫 로그인 시 변경 유도
        data.createdAt = serverTimestamp();
        await setDoc(ref, data);
        results.added++;
      } else {
        // 기존: 정보 업데이트 (PIN은 건드리지 않음)
        await updateDoc(ref, {
          name: emp.name, dept: emp.dept,
          routeId, routeCode: emp.routeCode,
          active: emp.active,
          partnerCode, partnerName, updatedAt: serverTimestamp(),
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
  const ws = XLSX.utils.aoa_to_sheet([
    ["사번", "이름", "부서", "노선코드", "재직여부(Y/N)"],
    ["10001", "홍길동", "개발팀", "662", "Y"],
    ["10002", "김철수", "인사팀", "663", "Y"],
    ["10003", "이영희", "총무팀", "662", "N"],
  ]);
  ws["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "직원명부");
  XLSX.writeFile(wb, "BusLink_직원명부_양식.xlsx");
}
