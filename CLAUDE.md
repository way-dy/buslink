# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 동영관광(@dongyeongtour.co.kr) 통근버스 관제 시스템. 포트폴리오 아키타입 **C — Firebase Cloud Functions** + CRA SPA. Firebase 프로젝트 `buslink-prod`. 한국어 우선(UI·주석·Firestore 값). 상위 `../../CLAUDE.md`(포트폴리오 지도)도 참고.

상세 가이드는 기능별로 분리. 작업 전 관련 파일을 읽을 것:

- @.claude/architecture.md — 기술 스택, 전체 구조, 데이터 흐름, 명령어/환경변수
- @.claude/frontend.md — 컴포넌트 구조, 라우팅, 인증·상태관리 패턴
- @.claude/backend.md — Firestore 스키마, 컬렉션 구조, 보안 규칙
- @.claude/functions.md — Cloud Functions 목록, 트리거, 주의사항
- @.claude/issues.md — **중요 이슈 기록**(발견사항·버그·주의 패턴)
- @.claude/tasks.md — 현재 작업 상태 체크박스, 다음 할 일
- @.claude/redesign.md — 라이트 리스킨 요약·현재 단계(완료 0~4단계 상세는 redesign-log.md @임포트)

> `.claude/*.md`가 다른 PC 이어작업의 단일 진실원. 작업 끝나면 아래 규칙대로 갱신 후 커밋·푸시.

## 문서 유지 규칙 (작업 시 항상 적용)
- 중요 발견사항 → `.claude/issues.md` "중요 이슈 기록"에만 추가(세세한 것 말고 핵심만)
- 작업 시작/완료 → `.claude/tasks.md` 체크박스 갱신
- 아키텍처 변경 → 해당 섹션 파일만 수정
- 파일 50줄 초과 → 추가 분리(예: `frontend-routing.md`)
- 루트 CLAUDE.md는 @임포트 허브 전용, 30줄 이하 유지
