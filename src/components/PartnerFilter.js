// 협력사 필터 공통 컴포넌트
// AdminApp 여러 탭(DispatchTab / DispatchScheduleTab / HistoryTab / DashboardTab / NoticeTab)에서 재사용.
// 회사 단위 안에 여러 협력사(KT·삼성 등) 운영을 분리·집계하기 위한 UI 일관성 + 코드 중복 제거.
// 데이터 소스: top-level `partnerCodes` where companyId == X (PartnerTab 등록분).
// active 필터는 호출부에서 제어(공지·관리는 active만, 이력은 비활성 포함 선택지).

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../firebase";

/**
 * @param {Object} props
 * @param {string} props.companyId
 * @param {string} props.value          현재 선택값 ("전체" | partnerCode)
 * @param {(code:string)=>void} props.onChange
 * @param {boolean} [props.activeOnly]  true=active만(기본), false=전체
 * @param {string}  [props.allLabel]    "전체 협력사" 등 라벨 변경
 * @param {Object}  [props.style]       추가 인라인 스타일
 * @param {boolean} [props.compact]     true=mini (필터바용), false=풀폭 (폼용)
 * @param {string[]} [props.allowedCodes]  Phase B(2026-06-08) — 로그인 admin 의 협력사 권한 범위.
 *   미지정 또는 ["*"] 포함 = 무제한(기존 동작 100% 동일). 그 외 = 옵션을 그 코드들로만 제한.
 *   [](빈 배열) = 접근 가능한 협력사 없음(안내 표시).
 */
export function PartnerFilter({ companyId, value, onChange, activeOnly = true, allLabel = "전체 협력사", style, compact = true, allowedCodes }) {
  const [partners, setPartners] = useState([]);

  useEffect(() => {
    if (!companyId) return;
    const q = activeOnly
      ? query(collection(db, "partnerCodes"), where("companyId", "==", companyId), where("active", "==", true))
      : query(collection(db, "partnerCodes"), where("companyId", "==", companyId));
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // partnerName 가나다순
      list.sort((a, b) => (a.partnerName || "").localeCompare(b.partnerName || ""));
      setPartners(list);
    }, err => console.warn("[PartnerFilter] 구독 오류:", err.message));
  }, [companyId, activeOnly]);

  // Phase B 권한 제한. allowedCodes 미지정/["*"] = 무제한(기존 동작 — 회귀 0).
  const restricted = Array.isArray(allowedCodes) && !allowedCodes.includes("*");
  const visiblePartners = restricted
    ? partners.filter(p => allowedCodes.includes(p.code || p.id))
    : partners;

  const base = compact
    ? { background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 8, padding: "5px 10px", color: "var(--color-label)", fontSize: 12, outline: "none", fontFamily: "inherit", width: "auto", minWidth: 110, maxWidth: 180 }
    : { background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 8, padding: "10px 14px", color: "var(--color-label)", fontSize: 14, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" };

  // 빈 권한(접근 가능한 협력사 0개) — 드롭다운 대신 안내.
  if (restricted && allowedCodes.length === 0) {
    return (
      <span style={{ fontSize: compact ? 12 : 13, color: "var(--color-label-alt)", fontStyle: "italic" }}>
        접근 가능한 협력사 없음
      </span>
    );
  }

  // 제한 admin 의 "전체" = 내 협력사 전체(allowedCodes 합집합). 라벨로 의미 명시.
  // 단일 협력사여도 "전체"(=그 1개) 옵션 유지 — value 일관성·데이터 필터는 호출부가 allowed 로 적용.
  const allOptionLabel = restricted ? "내 협력사 전체" : allLabel;

  return (
    <select value={value || "전체"} onChange={e => onChange(e.target.value)} style={{ ...base, ...(style || {}) }}>
      <option value="전체">{allOptionLabel}</option>
      {visiblePartners.map(p => (
        <option key={p.code || p.id} value={p.code || p.id}>{p.partnerName || p.code}</option>
      ))}
    </select>
  );
}

export default PartnerFilter;
