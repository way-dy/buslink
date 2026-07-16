# BusLink 사용 매뉴얼 (PDF, 모노디자인)

비개발자(직원·관리자·기사)용 A4 한국어 PDF 매뉴얼 3종. **사용법 위주·모노디자인**(무채색 + 단일 포인트색 `#0066FF`).
기존 `../manual-ppt/`(편집용 PPT 토글체인)와 **별개** — 둘 다 보존.

## 산출물 (`out/`)
- `BusLink_관리자매뉴얼.pdf` — AdminApp(`admin.buslink.co.kr`, 데스크톱)
- `BusLink_기사매뉴얼.pdf` — DriverApp(`d.buslink.co.kr`, 모바일)
- `BusLink_직원매뉴얼.pdf` — EmployeeApp(`p.buslink.co.kr`, 모바일·사번+PIN)
- `BusLink_협력사포탈가이드.pdf` — PartnerApp(`partner.buslink.co.kr`, 업체코드) **요약본**(2026-07-16 회의 #6, 최소 분량·반출 고려, 3쪽)
- `BusLink_승객앱가이드.pdf` — EmployeeApp **요약본**(동일 회의, 3쪽. 상세본=직원매뉴얼과 별개 공존)

## 소스
- `ADMIN_GUIDE.md` / `DRIVER_GUIDE.md` / `EMPLOYEE_GUIDE.md` / `PARTNER_GUIDE.md` / `PASSENGER_QUICK.md` — 매뉴얼 본문(MD)
- `_to_pdf.mjs` — MD→A4 PDF 변환(marked + 시스템 Chrome). 모노 템플릿·`#0066FF` 액센트 내장.
- 스크린샷은 **재캡처 없이** `../manual-ppt/assets/{admin,driver,employee}/*.png` 재사용.

## 재생성
```bash
cd docs/manual
npm install          # 최초 1회 (marked, playwright-core)
node _to_pdf.mjs     # out/*.pdf 재생성
```
> `.md`만 고쳐도 `node _to_pdf.mjs` 를 반드시 재실행해야 PDF 에 반영됩니다.
> 시스템 Chrome(`C:\Program Files\Google\Chrome\Application\chrome.exe`)을 사용합니다(브라우저 다운로드 없음).

## 운영 중 캡처 필요(placeholder 로 표시된 화면)
- 관리자: 배차 관리, 차량 관리
- 기사: 운행 중 화면, 탑승 QR 발급, 운행 종료 버튼
- 직원: 탑승(QR 스캔 카메라) 화면
본인 화면에서 캡처해 `../manual-ppt/assets/<role>/` 에 두고 MD 의 placeholder `<div class="ph">` 블록을 `![](assets/...)` 이미지로 교체 후 재빌드하면 반영됩니다.
