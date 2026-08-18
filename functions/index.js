const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
// 개선 요청 구글챗 웹훅 — 시크릿 우선(getImprovementWebhookUrl 가 env→Firestore config 순 폴백).
const GCHAT_WEBHOOK_URL = defineSecret("GCHAT_WEBHOOK_URL");
// 카카오모빌리티 길찾기 REST 키(buslink 전용 앱). 기사 길안내의 도로 경로·회전 안내용.
// ⚠ 지도 JS 키(58bf34…)와 다른 키다 — 그쪽은 브라우저용·도메인 화이트리스트, 이건 서버용.
const KAKAO_REST_KEY = defineSecret("KAKAO_REST_KEY");
const admin = require("firebase-admin");
// 외부 운수 시스템(busin.co.kr) 서버사이드 fetch 용 — CORS·비표준 cert chain 때문에
// 브라우저/클라이언트 fetch 불가, node http/https 로만 접근(rejectUnauthorized:false).
const https = require("https");
const http = require("http");
const { HOLIDAY_SET } = require("./holidays");
admin.initializeApp();

// ════════════════════════════════════════════════════════
// FCM 푸시 발송 — fcmQueue 문서 생성 시 트리거 (v2)
// ════════════════════════════════════════════════════════
exports.sendNoticeToCompany = onDocumentCreated("fcmQueue/{queueId}", async (event) => {
  const data = event.data.data();
  const { companyId, title, body, type, partnerCode } = data;
  console.log("[FCM] 발송 시작:", { companyId, title, type, partnerCode: partnerCode || "(전체)" });

  try {
    // partnerCode 있으면 해당 협력사 토큰만, 없으면 전체.
    // 기존 partnerCode 필드 없는 fcmTokens 문서는 "전체"에만 포함(특정 협력사 발송 시 제외).
    let tokensQuery = admin.firestore()
      .collection("companies").doc(companyId)
      .collection("fcmTokens");
    if (partnerCode) {
      tokensQuery = tokensQuery.where("partnerCode", "==", partnerCode);
    }
    const tokensSnap = await tokensQuery.get();

    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
    console.log("[FCM] 토큰 수:", tokens.length, partnerCode ? `(협력사=${partnerCode})` : "(전체)");

    if (tokens.length === 0) {
      await event.data.ref.update({ status: "no_tokens", totalTokens: 0, successCount: 0, failureCount: 0 });
      return;
    }

    const chunkSize = 500;
    let totalSuccess = 0, totalFail = 0;

    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);

      const message = {
        tokens: chunk,

        // ✅ notification 추가 — 시스템이 직접 알림 표시 (Android Chrome 백그라운드/종료 시 확실히 수신)
        notification: {
          title: title || "BusLink 공지",
          body: body || "",
        },

        // ✅ data 유지 — SW notificationclick에서 companyId, type 등 활용
        data: {
          type: type || "normal",
          companyId,
          title: title || "BusLink 공지",
          body: body || "",
        },

        // ✅ 항상 high priority — 절전모드에서도 즉시 수신
        android: {
          priority: "high",
          notification: {
            channelId: "default",
            sound: "default",
            defaultVibrateTimings: true,
            priority: "high",
          },
        },

        apns: {
          headers: {
            "apns-priority": "10",
            "apns-push-type": "alert",   // background → alert 로 변경
          },
          payload: {
            aps: {
              "content-available": 1,
              sound: "default",
              alert: {
                title: title || "BusLink 공지",
                body: body || "",
              },
            },
          },
        },

        webpush: {
          headers: { Urgency: "high" },
          // ★ 브랜드 아이콘: BusLink 직원앱 정본(public/icons/notification-employee.png — passenger-1024 사본).
          // ⚠ public/logo192.png 는 CRA 기본 React 로고이므로 사용 금지(과거 알림 아이콘이 React 로고로
          // 표시·상태바 silhouette 변환 실패로 Chrome 폴백되어 사용자가 "Chrome 아이콘"으로 인식한 결함, 2026-05-27).
          notification: {
            icon: "https://buslink-prod.web.app/icons/notification-employee.png",
            badge: "https://buslink-prod.web.app/icons/notification-employee.png",
          },
          fcmOptions: { link: "/p?c=" + companyId },
        },
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      totalSuccess += response.successCount;
      totalFail += response.failureCount;

      // 만료 토큰 삭제
      const deletePromises = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered") {
            const badToken = chunk[idx];
            deletePromises.push(
              admin.firestore()
                .collection("companies").doc(companyId)
                .collection("fcmTokens")
                .where("token", "==", badToken).get()
                .then(s => s.docs.forEach(d => d.ref.delete()))
            );
          }
        }
      });
      await Promise.all(deletePromises);
    }

    console.log("[FCM] 완료 — 성공:", totalSuccess, "실패:", totalFail, "총", tokens.length);
    await event.data.ref.update({
      status: "sent",
      totalTokens: tokens.length,
      successCount: totalSuccess,
      failureCount: totalFail,
    });
  } catch (e) {
    console.error("[FCM] 오류:", e.message);
    await event.data.ref.update({ status: "error", error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// 도착 임박 푸시 — dispatches 의 stopArrivals 갱신 시 트리거 (v2)
// 기사앱이 정류장 도착을 감지하면 stopArrivals.{stopId} 가 추가됨.
// 그 신호로 "내 정류장 2/1 정거장 전" 직원에게 FCM 발송.
//
// v1 단순화(후속 과제): routeId+stopId 로만 타겟 → 같은 routeId 의 다른
// 배차(shift)에도 발송될 수 있음. shift 별 정밀 타겟은 후속 과제.
// ════════════════════════════════════════════════════════

// 발송할 푸시 메시지(공지 발송과 동일한 high-priority 구조 재사용).
function buildPreArrivalMessage(tokens, { companyId, threshold, stopName, scheduleBased, minutesLeft }) {
  const title = "버스 도착 알림";
  // scheduleBased = GPS 가 끊겨 실측 도착을 못 잡을 때의 시간표 기반 폴백.
  // 정확도가 다르므로 **문구로 정직하게 구분**한다(실측인 척하면 신뢰를 잃는다).
  const body = scheduleBased
    ? `예정 시각 기준 약 ${minutesLeft}분 뒤 도착 예정입니다`
    : threshold === "pre2"
    ? "버스가 곧 도착해요 — 2 정거장 전입니다"
    : "버스가 한 정거장 앞이에요. 정류장으로 이동하세요";
  return {
    tokens,
    notification: { title, body },
    data: {
      type: "pre_arrival",
      companyId,
      threshold,            // "pre1" | "pre2"
      stopName: stopName || "",
      source: scheduleBased ? "schedule" : "gps",  // 소비측이 정확도를 구분할 수 있게
      title,
      body,
    },
    android: {
      priority: "high",
      notification: {
        channelId: "default",
        sound: "default",
        defaultVibrateTimings: true,
        priority: "high",
      },
    },
    apns: {
      headers: { "apns-priority": "10", "apns-push-type": "alert" },
      payload: {
        aps: {
          "content-available": 1,
          sound: "default",
          alert: { title, body },
        },
      },
    },
    webpush: {
      headers: { Urgency: "high" },
      // 알림 아이콘 정본 — sendNoticeToCompany 의 webpush 설명 참조.
      notification: {
        icon: "https://buslink-prod.web.app/icons/notification-employee.png",
        badge: "https://buslink-prod.web.app/icons/notification-employee.png",
      },
      fcmOptions: { link: "/p?c=" + companyId },
    },
  };
}

exports.notifyPreArrival = onDocumentUpdated(
  {
    document: "companies/{companyId}/dispatches/{date}/list/{dispatchId}",
    region: "us-central1",
  },
  async (event) => {
    const { companyId } = event.params;
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};

    const routeId = after.routeId;
    if (!routeId) return;

    // ── 1. before vs after stopArrivals diff → 새로 추가된 도착 stopId ──
    const beforeArr = before.stopArrivals || {};
    const afterArr = after.stopArrivals || {};
    const newlyArrived = Object.keys(afterArr).filter(sid => !(sid in beforeArr));
    if (newlyArrived.length === 0) return;

    const db = admin.firestore();

    // ── 2. route stops 를 order 오름차순 정렬한 배열로 구성 ──
    // raw order 값 산술(K+1)은 order 가 0,1,2,… 연속 정수라는 가정에 의존 →
    // 정류장 삭제·재정렬로 결번(예 0,1,2,4,5)이 생기면 대상 정류장을 놓침.
    // src/lib/stopSchedule.js computeStopEstimates 와 동일하게
    // "order 로 정렬한 배열에서 인덱스(position)로 순회" 한다.
    const stopsSnap = await db
      .collection("companies").doc(companyId)
      .collection("routes").doc(routeId)
      .collection("stops").get();
    if (stopsSnap.empty) return;

    const nameByStopId = {};    // stopId → name (메시지용)
    const sortedStops = stopsSnap.docs
      .map(d => {
        const v = d.data();
        nameByStopId[d.id] = v.name || "";
        return { id: d.id, order: typeof v.order === "number" ? v.order : null };
      })
      .filter(s => s.order !== null)   // 기존처럼 order 가 number 인 것만
      .sort((a, b) => a.order - b.order);
    if (sortedStops.length === 0) return;

    // stopId → 정렬 배열에서의 위치(index)
    const posByStopId = {};
    sortedStops.forEach((s, idx) => { posByStopId[s.id] = idx; });

    // 도착한 모든 정류장 중 가장 큰 배열 위치 = K (버스 실제 최전방).
    // GPS 복구 백필이 한 번에 여러 정류장을 기록할 수 있어 max 로 산출.
    let K = -Infinity;
    Object.keys(afterArr).forEach(sid => {
      const pos = posByStopId[sid];
      if (typeof pos === "number" && pos > K) K = pos;
    });
    if (K === -Infinity) return;

    // ── 3. 정렬 배열에서 한 칸 뒤 = "1 정거장 전", 두 칸 뒤 = "2 정거장 전" ──
    const targets = [
      { threshold: "pre1", stopId: (sortedStops[K + 1] || {}).id },
      { threshold: "pre2", stopId: (sortedStops[K + 2] || {}).id },
    ].filter(t => t.stopId);   // 노선 끝이라 배열 범위 밖이면 skip
    if (targets.length === 0) return;

    // ── 멱등 마커: 같은 (stopId, 임계) 조합은 배차당 1회만 ──
    // diff 기반 + 마커 2중 가드 → onDocumentUpdated 재발화·백필 다중기록에도 중복 0.
    const alreadyNotified = Array.isArray(after.preArrivalNotified)
      ? after.preArrivalNotified : [];
    const pending = targets.filter(
      t => !alreadyNotified.includes(`${t.stopId}:${t.threshold}`)
    );
    if (pending.length === 0) return;

    const newMarkers = [];
    for (const t of pending) {
      // ── 4. fcmTokens 중 routeId·stopId 매칭 + token 존재 → 멀티캐스트 ──
      const tokSnap = await db
        .collection("companies").doc(companyId)
        .collection("fcmTokens")
        .where("routeId", "==", routeId)
        .where("stopId", "==", t.stopId)
        .get();
      const tokens = tokSnap.docs.map(d => d.data().token).filter(Boolean);

      // 발송 대상이 없어도 마커는 기록 — 이후 재발화 시 재평가 비용 차단(멱등).
      newMarkers.push(`${t.stopId}:${t.threshold}`);
      if (tokens.length === 0) {
        console.log(`[도착임박] ${t.threshold} stop=${t.stopId} 대상 0명 — skip`);
        continue;
      }

      const message = buildPreArrivalMessage(tokens, {
        companyId,
        threshold: t.threshold,
        stopName: nameByStopId[t.stopId],
      });
      const resp = await admin.messaging().sendEachForMulticast(message);
      console.log(`[도착임박] ${t.threshold} stop=${t.stopId} 발송 — 성공:${resp.successCount} 실패:${resp.failureCount}`);

      // 무효 토큰 자동 삭제(sendNoticeToCompany 와 동일 처리).
      const deletePromises = [];
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered") {
            const badToken = tokens[idx];
            deletePromises.push(
              db.collection("companies").doc(companyId)
                .collection("fcmTokens")
                .where("token", "==", badToken).get()
                .then(s => s.docs.forEach(d => d.ref.delete()))
            );
          }
        }
      });
      await Promise.all(deletePromises);
    }

    // ── 5. 발송 마커를 dispatch 문서에 기록(멱등 가드 영속) ──
    if (newMarkers.length > 0) {
      await event.data.after.ref.update({
        preArrivalNotified: admin.firestore.FieldValue.arrayUnion(...newMarkers),
      });
    }
  }
);

// ════════════════════════════════════════════════════════
// (2026-07-29) 기사 길안내 — 카카오모빌리티 다중 경유지 길찾기
//
// 배경: 관리자가 손으로 찍은 `routePath` 는 점 간격 중앙값 128m 라 "여기서 우회전"을
//   근사조차 못 한다(실측: 154~174° 지그재그 노이즈가 실제 회전과 구분 안 됨).
//   도로 데이터가 있어야 하고, 그걸 주는 게 이 API.
//
// 왜 앱을 안 떠나는가: 카카오내비 **앱**은 웹에 임베드할 수 없지만, 길찾기 **API** 는
//   도로 좌표(vertexes)와 회전 안내(guides)를 JSON 으로 준다 → 우리 지도에 우리가 그리고
//   우리가 읽어준다. 외부 앱으로 나가지 않으므로 기사 폰 GPS 가 안 끊기고, 그래서
//   승객 도착 알림([[notifyPreArrival]])도 영향을 안 받는다.
//
// 🔴 **응답을 저장하지 않는다** — 카카오모빌리티 운영 정책상 결과의 자체 DB 저장·재사용이
//   금지다(공식 답변 확인, 2026-07-29). 그래서 노선당 1회 받아 캐시하는 방식을 쓰지 않고
//   요청 때마다 호출해 **그대로 돌려주기만** 한다(서버에도 클라에도 영속 저장 없음).
//   무료 쿼터 = 다중 경유지 5,000건/일. 우리 사용량은 배차 ~30건/일이라 여유가 크다.
//
// 실패해도 치명적이지 않다 — 클라이언트는 기존 `routePath` 로 자동 폴백한다.

const KAKAO_NAVI_URL = "https://apis-navi.kakaomobility.com/v1/waypoints/directions";
const KAKAO_NAVI_MAX_WAYPOINTS = 30;   // API 상한(총 1,500km 미만)
// 그린 경로 정합(2026-07-31). 300m = 옆 도로·중앙분리대를 오판하지 않으면서 "다른 길"은
// 잡아내는 값(클라 OFF_ROUTE_M 과 같은 뜻).
// 보정점 상한 12 = prod 8개 노선 실측에서 이탈 24~63% → 0~22% 로 떨어진 값(6개는 부족했다).
// 경유지 상한 30 안에서만 쓰고, 결과가 나빠지면 아래 채택 판정이 통째로 기각한다.
const DRAWN_MATCH_THRESHOLD_M = 300;
const DRAWN_MATCH_MAX_POINTS = 12;
// 보정 결과가 그린 경로보다 이만큼 길어지면 U턴이 쌓인 것으로 보고 기각한다.
const DRAWN_MATCH_MAX_LEN_RATIO = 1.25;
// 긴 우회 구간은 점 하나로 못 끌어온다 → 이만큼(km)마다 1점씩, 구간당 최대 3점.
const DRAWN_MATCH_KM_PER_POINT = 2;
const DRAWN_MATCH_MAX_PER_RUN = 3;

// ── 덤 우회 제거 (2026-08-05 과천라인 실주행 지적) ──────────────────
// 위 임계는 **그린 점이 도로에 덮이는가**만 본다(한 방향). 도로가 그린 경로에 **없는 길을
// 덤으로 갔다가 되돌아오는** 우회는 그린 점이 전부 덮인 채로 성립하므로 그 잣대에 안 잡힌다
// — 과천라인이 유턴 2개를 달고도 "이미 일치"로 판정되던 이유. 그래서 반대 방향으로도 잰다.
const DETOUR_THRESHOLD_M = 150;   // 도로 점이 그린 경로에서 이만큼 벗어나면 "그린에 없는 길"
const DETOUR_MIN_RUN_M = 100;     // 이보다 짧은 덤은 램프·측도라 건드리지 않는다
// 경유지를 뺐을 때 정류장이 도로에서 이만큼 넘게 떨어지면 그 정류장을 지나치지 않는다는
// 보장이 깨진 것 → 기각. 실측(과천라인 선바위역)은 빼도 18m 였다.
const STOP_COVER_M = 150;
const DETOUR_PRUNE_ROUNDS = 2;    // 경유지 제거 시도 라운드
const KAKAO_NAVI_MAX_CALLS = 5;   // 노선 1회 로드당 카카오 호출 상한(실측 최대 3.2초)

/** 카카오모빌리티 길찾기 POST — 응답 JSON 반환. 저장하지 않는다. */
function postKakaoNavi(body, restKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(KAKAO_NAVI_URL);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: {
        Authorization: `KakaoAK ${restKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 10000,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          // 401/403 = 키 문제, 429 = 쿼터 — 메시지에 상태코드를 남겨 진단 가능하게.
          return reject(new Error(`카카오 길찾기 HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error("응답 파싱 실패")); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("카카오 길찾기 응답 시간 초과")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── 그린 경로 정합용 기하 헬퍼 (2026-07-31) ────────────────────────
// 정류장만 경유지로 주면 그 사이 도로는 **카카오가 고른다** → 회사가 실제로 다니는 길과
// 달라진다. prod 실측(dy001): 그린 경로 점의 21~25% 가 300m 넘게 벗어났고 최대 4.9km,
// 즉 한 구간을 통째로 다른 길로 안내하고 있었다(기사 지적 "내가 그려놓은 노선대로 안내를
// 하는 것 같지 않다"). 그린 경로를 통째로 경유지에 넣으면 이탈은 0 이 되지만 도로 스냅
// U턴이 쌓여 총 거리가 55km→102km 로 부푼다(실측) → **벗어난 구간에만** 점을 꽂는다.

/** 점 → 선분 최단거리(m). 수백 m 규모라 로컬 평면 근사로 충분. */
function distToSegMeters(p, a, b) {
  const R = Math.PI / 180;
  const mLat = 111320, mLng = 111320 * Math.cos(p.lat * R);
  const px = (p.lng - a.lng) * mLng, py = (p.lat - a.lat) * mLat;
  const bx = (b.lng - a.lng) * mLng, by = (b.lat - a.lat) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - bx * t, py - by * t);
}

/** 점이 폴리라인에서 떨어진 최단거리(m). */
function distToPathMeters(p, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const d = distToSegMeters(p, poly[i - 1], poly[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 그린 경로에서 도로 경로가 `thresholdM` 이상 벗어난 **구간**을 찾아 보정 경유지를 뽑는다.
 *
 * 구간당 점을 많이 넣으면 도로 스냅 U턴으로 거리가 부푸므로 아껴 넣되(기본 1개),
 * **긴 우회 구간**(수 km)은 점 하나로는 못 끌어온다(실측 [압구정] 하교: 5.9km 이탈 구간에
 * 1점만 넣었더니 오히려 악화) → 구간 길이에 비례해 `DRAWN_MATCH_KM_PER_POINT` km 당
 * 1점씩, 구간당 최대 `DRAWN_MATCH_MAX_PER_RUN` 개까지 고르게 배치한다.
 * 그래도 나빠지면 호출부가 **결과를 통째로 기각**하므로 과감히 시도해도 안전하다.
 *
 * @returns {Array<{lat,lng,dev,idx}>} 이탈이 큰 구간 순
 */
function worstDeviationPoints(drawn, roadPath, thresholdM, limit) {
  if (!Array.isArray(drawn) || drawn.length < 2 || !Array.isArray(roadPath) || roadPath.length < 2) return [];
  const dev = drawn.map((p) => distToPathMeters(p, roadPath));
  const runs = [];
  let cur = null;
  for (let i = 0; i < dev.length; i++) {
    if (dev[i] > thresholdM) {
      if (!cur) cur = { s: i, e: i, bi: i, bd: dev[i] };
      else { cur.e = i; if (dev[i] > cur.bd) { cur.bd = dev[i]; cur.bi = i; } }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  runs.sort((a, b) => b.bd - a.bd);

  const out = [];
  for (const r of runs) {
    if (out.length >= limit) break;
    let runLen = 0;
    for (let i = r.s + 1; i <= r.e; i++) {
      runLen += distMeters(drawn[i - 1].lat, drawn[i - 1].lng, drawn[i].lat, drawn[i].lng);
    }
    const want = Math.max(1, Math.min(DRAWN_MATCH_MAX_PER_RUN,
      Math.ceil(runLen / (DRAWN_MATCH_KM_PER_POINT * 1000))));
    const n = Math.min(want, limit - out.length, r.e - r.s + 1);
    if (n === 1) {
      out.push({ ...drawn[r.bi], dev: r.bd, idx: r.bi });
      continue;
    }
    // 구간 안에서 고르게 — 양 끝은 이미 정상 구간과 맞닿아 있으니 안쪽으로 배치한다.
    for (let j = 1; j <= n; j++) {
      const idx = Math.round(r.s + ((r.e - r.s) * j) / (n + 1));
      out.push({ ...drawn[idx], dev: dev[idx], idx });
    }
  }
  return out;
}

/**
 * 그린 경로 점 중 도로 경로에서 `thresholdM` 넘게 벗어난 **비율**(0~1).
 * "이 도로 경로가 회사가 다니는 길을 얼마나 따라가는가" 의 점수 — 낮을수록 좋다.
 */
function drawnMismatchRatio(drawn, roadPath, thresholdM) {
  if (!Array.isArray(drawn) || !drawn.length || !Array.isArray(roadPath) || roadPath.length < 2) return 1;
  let off = 0;
  for (const p of drawn) if (distToPathMeters(p, roadPath) > thresholdM) off++;
  return off / drawn.length;
}

/**
 * 도로 경로 중 **그린 경로에 없는 길**(덤 우회) 구간을 길이 내림차순으로.
 *
 * `drawnMismatchRatio` 의 반대 방향이다. 유턴 우회는 나갔다 되돌아오므로 그린 점은 전부
 * 도로에 덮인 채로 성립한다 → 그 잣대로는 영원히 안 잡힌다(과천라인 실측: 이탈 0% 인데
 * 유턴 2개·덤 750m). 각 구간이 어느 leg(=section)에서 났는지 함께 담아 **원인 경유지**를
 * 짚는다 — 거리로 어림하면 엉뚱한 정류장을 지목한다(과천대로 실측).
 *
 * @param roadPath [{lat,lng}] · @param sectionOf 같은 길이의 leg 인덱스 배열
 * @returns [{meters, maxDev, sections:number[]}]
 */
function detourRuns(roadPath, sectionOf, drawn, thresholdM) {
  if (!Array.isArray(roadPath) || roadPath.length < 2 || !Array.isArray(drawn) || drawn.length < 2) return [];
  const dev = roadPath.map((p) => distToPathMeters(p, drawn));
  const runs = [];
  let cur = null;
  for (let i = 0; i < dev.length; i++) {
    if (dev[i] > thresholdM) {
      if (!cur) cur = { s: i, e: i, maxDev: dev[i] };
      else { cur.e = i; if (dev[i] > cur.maxDev) cur.maxDev = dev[i]; }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  runs.forEach((r) => {
    let m = 0;
    for (let i = r.s + 1; i <= r.e; i++) m += distMeters(roadPath[i - 1].lat, roadPath[i - 1].lng, roadPath[i].lat, roadPath[i].lng);
    r.meters = m;
    r.sections = [...new Set((sectionOf || []).slice(r.s, r.e + 1))];
  });
  return runs.sort((a, b) => b.meters - a.meters);
}

/** 덤 우회 총 길이(m). */
function detourMeters(roadPath, sectionOf, drawn, thresholdM) {
  return detourRuns(roadPath, sectionOf, drawn, thresholdM).reduce((t, r) => t + r.meters, 0);
}

/**
 * 경로 점수 — **낮을수록 좋다**. 두 방향을 함께 본다.
 *   ① 우리 길을 얼마나 안 따라가나(그린→도로 이탈 비율)
 *   ② 우리 길에 없는 길을 얼마나 덤으로 가나(도로→그린, 그린 길이로 정규화)
 * 한쪽만 보면 반대쪽이 조용히 나빠진다 — ①만 보던 게 이번 결함이었다.
 */
function naviRouteScore(drawn, drawnLenM, roadPath, sectionOf) {
  return drawnMismatchRatio(drawn, roadPath, DRAWN_MATCH_THRESHOLD_M)
    + detourMeters(roadPath, sectionOf, drawn, DETOUR_THRESHOLD_M) / Math.max(1, drawnLenM);
}

/** 모든 정류장이 도로 경로에서 `maxM` 안에 있나(= 경유지를 빼도 지나치기는 하나). */
function allStopsCovered(stops, roadPath, maxM) {
  return stops.every((s) => distToPathMeters({ lat: s.y, lng: s.x }, roadPath) <= maxM);
}

/**
 * 덤 우회를 만든 **원인 경유지 후보**(waypoints 배열 인덱스). leg i 는 waypoint i-1 에서
 * 출발해 waypoint i 로 간다(0번 leg 은 출발지에서). 우회가 난 leg 의 양 끝 경유지가 범인이다.
 * 출발지·목적지는 뺄 수 없으므로 waypoints 범위만 돌려준다.
 */
function detourSuspects(runs, waypointCount) {
  const out = [];
  runs.forEach((r) => (r.sections || []).forEach((si) => {
    [si - 1, si].forEach((wi) => { if (wi >= 0 && wi < waypointCount && !out.includes(wi)) out.push(wi); });
  }));
  return out;
}

/** 유턴 안내 개수 — 기사가 가장 싫어하는 신호라 동점일 때 갈림길로 쓴다. */
function uturnCount(guides) {
  return (guides || []).filter((g) => /유턴|U턴/.test(String(g.guidance || ""))).length;
}

/** 그린 경로 위 진행거리(m) — 경유지를 노선 진행 순서대로 정렬하는 데 쓴다. */
function progressAlongDrawn(pt, drawn, cum) {
  let best = Infinity, bp = 0;
  for (let i = 1; i < drawn.length; i++) {
    const d = distToSegMeters(pt, drawn[i - 1], drawn[i]);
    if (d < best) { best = d; bp = cum[i - 1]; }
  }
  return bp;
}

exports.getNaviRoute = onCall(
  { region: "us-central1", secrets: [KAKAO_REST_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
    const { companyId, routeId } = request.data || {};
    if (!companyId || !routeId) throw new HttpsError("invalid-argument", "companyId·routeId 가 필요합니다");

    const db = admin.firestore();
    // 호출자 검증 — 같은 회사의 기사/관리자만(익명 승객이 쿼터를 소모하지 못하게).
    const uSnap = await db.collection("users").doc(request.auth.uid).get();
    const u = uSnap.exists ? (uSnap.data() || {}) : {};
    const role = u.role;
    if (!["driver", "admin", "superadmin"].includes(role)) {
      throw new HttpsError("permission-denied", "권한이 없습니다");
    }
    if (role !== "superadmin" && u.companyId !== companyId) {
      throw new HttpsError("permission-denied", "다른 회사의 노선입니다");
    }

    const routeRef = db.collection("companies").doc(companyId).collection("routes").doc(routeId);
    const [routeSnap, stopsSnap] = await Promise.all([
      routeRef.get(),
      routeRef.collection("stops").orderBy("order").get(),
    ]);
    const pts = [];
    stopsSnap.docs.forEach((d) => {
      const ll = stopLatLng(d.data() || {});
      if (ll) pts.push({ name: (d.data() || {}).name || "", x: ll.lng, y: ll.lat });
    });
    if (pts.length < 2) throw new HttpsError("failed-precondition", "좌표가 있는 정류장이 2곳 이상이어야 합니다");

    // 관리자가 그린 노선 — 있으면 도로 경로를 여기에 맞춘다(아래 2차 호출).
    const drawn = [];
    const rawDrawn = (routeSnap.exists ? routeSnap.data() : {}).routePath;
    if (Array.isArray(rawDrawn)) {
      rawDrawn.forEach((p) => {
        const ll = stopLatLng(p);
        if (ll) drawn.push(ll);
      });
    }

    // 경유지 상한 초과 시 균등 간격으로 솎아낸다(정류장이 30개를 넘는 노선은 현재 없지만 방어).
    let mid = pts.slice(1, -1);
    if (mid.length > KAKAO_NAVI_MAX_WAYPOINTS) {
      const step = mid.length / KAKAO_NAVI_MAX_WAYPOINTS;
      mid = Array.from({ length: KAKAO_NAVI_MAX_WAYPOINTS }, (_, i) => mid[Math.floor(i * step)]);
    }

    let kakaoCalls = 0;
    /**
     * 카카오 1회 호출 → `{route, path, sectionOf, guides, waypoints, avoidUturn}`.
     * `sectionOf` 는 도로 점마다 몇 번째 leg 인지 — 덤 우회의 원인 경유지를 짚는 데 쓴다.
     * ⚠ vertexes 는 [x1,y1,…] 이고 **x=경도·y=위도**다(뒤집으면 대서양).
     */
    const callKakao = async (waypoints, avoidUturn) => {
      if (kakaoCalls >= KAKAO_NAVI_MAX_CALLS) return null;
      kakaoCalls++;
      const json = await postKakaoNavi({
        origin: pts[0],
        destination: pts[pts.length - 1],
        waypoints,
        priority: "RECOMMEND",
        car_fuel: "DIESEL",   // 버스 — 요금 추정에만 쓰이고 경로에는 영향 미미
        summary: false,       // roads(vertexes)·guides 를 받으려면 false
        // 유턴 회피는 **요청할 때만** 붙인다(기본 경로가 더 나은 노선이 있어 뒤에서 대조한다).
        ...(avoidUturn ? { avoid: ["uturn"] } : {}),
      }, KAKAO_REST_KEY.value());
      const r = (json.routes || [])[0];
      if (!r || (r.result_code !== 0 && r.result_code !== undefined)) return null;
      // speeds/states = path 와 **같은 길이**로 나란히 채운다(그 좌표가 속한 도로의 교통 정보).
      // 기사 화면이 내 위치를 경로에 투영해 얻은 segIndex 로 바로 집어 쓴다(2026-08-06 way 요청).
      const path = [], sectionOf = [], guides = [], speeds = [], states = [];
      (r.sections || []).forEach((sec, si) => {
        (sec.roads || []).forEach((rd) => {
          const v = rd.vertexes || [];
          for (let i = 0; i + 1 < v.length; i += 2) {
            const lng = Number(v[i]), lat = Number(v[i + 1]);
            if (isFinite(lat) && isFinite(lng)) {
              path.push({ lat, lng }); sectionOf.push(si);
              speeds.push(Number.isFinite(Number(rd.traffic_speed)) ? Math.round(Number(rd.traffic_speed)) : null);
              states.push(Number.isFinite(Number(rd.traffic_state)) ? Number(rd.traffic_state) : 0);
            }
          }
        });
        (sec.guides || []).forEach((g) => {
          // type 100=출발지(안내할 것 없음) · 1000=경유지(우리 정류장 — 화면 위쪽 카드가
          // 이미 크게 보여주므로 회전 안내 배너에 "경유지"가 끼면 방해만 된다) 제외.
          if (g.type === 100 || g.type === 1000) return;
          const lat = Number(g.y), lng = Number(g.x);
          if (!isFinite(lat) || !isFinite(lng)) return;
          guides.push({ lat, lng, name: g.name || "", guidance: g.guidance || "", type: g.type });
        });
      });
      return { route: r, path, sectionOf, guides, speeds, states, waypoints, avoidUturn: !!avoidUturn };
    };

    let cand;
    try {
      cand = await callKakao(mid, false);
    } catch (e) {
      console.warn(`[길안내] 카카오 호출 실패 ${companyId}/${routeId}: ${e.message}`);
      throw new HttpsError("unavailable", "길찾기를 불러오지 못했습니다");
    }
    if (!cand) throw new HttpsError("unavailable", "길찾기 결과 없음");

    let drawnLen = 0;
    for (let i = 1; i < drawn.length; i++) {
      drawnLen += distMeters(drawn[i - 1].lat, drawn[i - 1].lng, drawn[i].lat, drawn[i].lng);
    }
    const scoreOf = (c) => naviRouteScore(drawn, drawnLen, c.path, c.sectionOf);
    const usable = drawn.length >= 10 && drawnLen > 0;
    let bestScore = usable ? scoreOf(cand) : 0;
    const score0 = bestScore, u0 = uturnCount(cand.guides);
    let matchedToDrawn = false;
    const notes = [];

    // ── 2차: 그린 경로에서 **벗어난** 구간에 보정 경유지를 꽂아 다시 받는다 ────────
    // 실패하면 앞 결과를 그대로 쓴다(안내가 없는 것보다 대충이라도 있는 게 낫다).
    const room = Math.max(0, KAKAO_NAVI_MAX_WAYPOINTS - mid.length);
    if (usable && room >= 1) {
      try {
        const worst = worstDeviationPoints(drawn, cand.path, DRAWN_MATCH_THRESHOLD_M, Math.min(room, DRAWN_MATCH_MAX_POINTS));
        if (worst.length) {
          const cum = [0];
          for (let i = 1; i < drawn.length; i++) {
            cum.push(cum[i - 1] + distMeters(drawn[i - 1].lat, drawn[i - 1].lng, drawn[i].lat, drawn[i].lng));
          }
          // 정류장 + 보정점을 **노선 진행 순서대로** 섞는다(순서가 어긋나면 되돌아가는 경로가 나온다).
          const merged = [
            ...mid.map((w) => ({ w, prog: progressAlongDrawn({ lat: w.y, lng: w.x }, drawn, cum) })),
            ...worst.map((p) => ({ w: { name: "", x: p.lng, y: p.lat }, prog: progressAlongDrawn(p, drawn, cum) })),
          ].sort((a, b) => a.prog - b.prog).map((o) => o.w).slice(0, KAKAO_NAVI_MAX_WAYPOINTS);
          const better = await callKakao(merged, false);
          // 🔴 **보정을 무조건 채택하지 않는다** — 실측(2026-07-31 [압구정] 하교)에서 보정이
          //   오히려 이탈을 42%→52% 로 키운 노선이 있었다(그린 경로가 도로가 아닌 곳을
          //   지나면 보정점이 엉뚱한 도로에 붙는다). 두 결과를 같은 잣대로 재서 **더 나은
          //   쪽만** 쓴다 → 최악의 경우에도 예전 동작(정류장만)으로 남는다.
          if (better) {
            let newLen = 0;
            for (let i = 1; i < better.path.length; i++) newLen += distMeters(better.path[i - 1].lat, better.path[i - 1].lng, better.path[i].lat, better.path[i].lng);
            const sc = scoreOf(better);
            // 경유지를 강제하면 U턴이 쌓여 거리가 부풀 수 있다 → 그것도 같이 본다.
            if (sc < bestScore && newLen <= drawnLen * DRAWN_MATCH_MAX_LEN_RATIO && allStopsCovered(pts, better.path, STOP_COVER_M)) {
              cand = better; bestScore = sc; matchedToDrawn = true;
              notes.push(`보정 ${worst.length}점`);
            }
          }
        } else {
          matchedToDrawn = true; // 벗어난 곳이 없다 = 이미 그린 경로 위를 간다
        }
      } catch (e) {
        console.warn(`[길안내] 그린 경로 보정 실패(앞 결과 사용) ${companyId}/${routeId}: ${e.message}`);
      }
    }

    // ── 3차: 그린 경로에 **없는 길**(덤 우회)을 만드는 경유지를 뺀다 ──────────────
    // 정류장 좌표가 반대편 차선·측도에 붙으면 카카오는 그 지점을 물리적으로 밟으려고
    // 500m 나갔다 유턴해 돌아온다(과천라인 선바위역 실측). 그 정류장은 **그린 경로 위에
    // 있으므로 경유지에서 빼도 도로가 그 앞을 지나간다**(실측 18m) — 우회만 사라진다.
    // 빼서 정류장을 지나치게 되면(STOP_COVER_M 초과) 기각하므로 정류장 누락은 없다.
    if (usable) {
      try {
        for (let round = 0; round < DETOUR_PRUNE_ROUNDS && kakaoCalls < KAKAO_NAVI_MAX_CALLS; round++) {
          const runs = detourRuns(cand.path, cand.sectionOf, drawn, DETOUR_THRESHOLD_M)
            .filter((r) => r.meters >= DETOUR_MIN_RUN_M);
          if (!runs.length) break;
          // 원인은 **거리가 아니라 leg 경계**로 짚는다(거리로 어림하면 엉뚱한 정류장을 지목).
          const suspects = detourSuspects(runs.slice(0, 3), cand.waypoints.length);
          let improved = false;
          for (const wi of suspects) {
            if (kakaoCalls >= KAKAO_NAVI_MAX_CALLS) break;
            const pruned = await callKakao(cand.waypoints.filter((_, i) => i !== wi), cand.avoidUturn);
            if (!pruned) continue;
            const sc = scoreOf(pruned);
            if (sc < bestScore && allStopsCovered(pts, pruned.path, STOP_COVER_M)) {
              notes.push(`우회 경유지 제거(${cand.waypoints[wi].name || "이름없음"})`);
              cand = pruned; bestScore = sc; improved = true;
              break;
            }
          }
          if (!improved) break;
        }
      } catch (e) {
        console.warn(`[길안내] 덤 우회 정리 실패(앞 결과 사용) ${companyId}/${routeId}: ${e.message}`);
      }
    }

    // ── 4차: 그래도 유턴이 남으면 유턴 회피로 한 번 더 받아 본다 ────────────────
    // 유턴만 없애고 우회는 그대로인 경우가 있어(실측) **점수가 나빠지면 기각**한다.
    // 점수가 같거나 거의 같으면 유턴이 적은 쪽을 고른다 — 기사가 가장 싫어하는 신호.
    if (usable && uturnCount(cand.guides) > 0 && kakaoCalls < KAKAO_NAVI_MAX_CALLS) {
      try {
        const noU = await callKakao(cand.waypoints, true);
        if (noU) {
          const sc = scoreOf(noU);
          const fewer = uturnCount(noU.guides) < uturnCount(cand.guides);
          if (allStopsCovered(pts, noU.path, STOP_COVER_M) && (sc < bestScore || (sc <= bestScore + 0.01 && fewer))) {
            notes.push("유턴 회피");
            cand = noU; bestScore = sc;
          }
        }
      } catch (e) {
        console.warn(`[길안내] 유턴 회피 실패(앞 결과 사용) ${companyId}/${routeId}: ${e.message}`);
      }
    }

    const route = cand.route;
    const path = cand.path;
    const guides = cand.guides;
    if (path.length < 2) throw new HttpsError("unavailable", "경로 좌표를 받지 못했습니다");
    // 최종적으로 그린 경로를 얼마나 따라가는지 — 화면 문구·운영 진단용.
    if (usable && detourMeters(cand.path, cand.sectionOf, drawn, DETOUR_THRESHOLD_M) > drawnLen * 0.05) matchedToDrawn = false;

    console.log(`[길안내] ${companyId}/${routeId} 경로 ${path.length}점·안내 ${guides.length}개 (정류장 ${pts.length}·호출 ${kakaoCalls}회·그린정합 ${matchedToDrawn ? "O" : "X"}·점수 ${score0.toFixed(3)}→${bestScore.toFixed(3)}·유턴 ${u0}→${uturnCount(guides)}${notes.length ? `·${notes.join("+")}` : ""})`);
    // 저장하지 않고 그대로 반환한다(카카오 정책).
    return {
      path,
      guides,
      // path 와 같은 길이. 기사 화면이 내 위치의 segIndex 로 "지금 이 구간 22km/h·서행"을 띄운다.
      speeds: cand.speeds || [],
      states: cand.states || [],
      matchedToDrawn,   // 화면이 "그린 노선 기준"인지 기사에게 알려주는 데 쓴다
      distance: route.summary ? route.summary.distance : null,
      duration: route.summary ? route.summary.duration : null,
    };
  }
);

// ════════════════════════════════════════════════════════
// (2026-07-29) 도착 임박 알림 — 시간표 기반 폴백
//
// 문제: 위 `notifyPreArrival` 은 dispatch 의 `stopArrivals` **갱신 트리거 하나**에만 매달려
//   있고, stopArrivals 는 기사 폰 GPS 도착 감지의 산물이다. GPS 가 끊기면 도착 기록이 없고,
//   그러면 알림도 통째로 안 나간다 — 에러도 로그도 안 남는 silent 공백.
//   prod 실측(2026-07-28, dy001 최근 14일): 배차 372건 중 **281건(76%) 미발송**,
//   어떤 날은 그날 배차 전체가 미발송이었다.
//
// 해법: 정류장 `offsetMin`(87% 채워져 있음)과 노선 `departTime` 으로 **예정 도착 시각**을
//   계산해, GPS 가 죽은 배차에 한해 시간표 기준으로 발송한다. 부정확하지만 무알림보다 낫고
//   문구에 "예정 시각 기준"이라고 명시해 실측과 구분한다.
//
// 🔴 안전장치 3중(알림 폭탄이 제일 큰 위험이다):
//   ① **회사별 옵트인** — `companies/{cid}.preArrivalScheduleFallback === true` 일 때만 동작.
//      배포만으로는 아무 일도 일어나지 않는다(기본 꺼짐).
//   ② **GPS 가 살아 있으면 발송 안 함** — 실측 경로가 정상 동작 중인데 폴백이 먼저 나가면
//      정확한 알림을 부정확한 알림이 밀어낸다. 그 차량 gps 문서가 신선하면 건너뛴다.
//   ③ **멱등 마커를 실측 경로와 공유**(`{stopId}:pre1`) — 어느 쪽이 먼저 보내든 다른 쪽은
//      마커를 보고 skip 한다. 중복 0(양방향).
//
// ⚠ 마커 기록 정책이 실측 경로와 다르다: 실측은 대상 0명이어도 마커를 남기지만(재발화 비용
//   차단), 폴백은 **대상 0명이면 마커를 남기지 않는다** — 매분 도는 구조라 재평가 비용이
//   작고, 승객이 lead 창 안에서 뒤늦게 '내 정류장'을 지정해도 받을 수 있어야 하기 때문.

const PRE_ARRIVAL_LEAD_MIN_DEFAULT = 5;   // 예정 시각 몇 분 전에 보낼지
const PRE_ARRIVAL_GPS_FRESH_SEC = 180;    // 이보다 최근 좌표가 있으면 "실측이 살아 있음"

/** 노선 시간표 메타(캐시) — 좌표는 필요 없고 offsetMin 만 본다.
 *  `loadRouteMeta`(폴러용)는 좌표 없는 정류장을 버리므로 여기선 별도 로더를 쓴다. */
async function loadRouteSchedule(db, cid, routeId, cache) {
  if (!routeId) return null;
  const key = `${cid}__${routeId}`;
  if (key in cache) return cache[key];
  let meta = null;
  try {
    const rSnap = await db.collection("companies").doc(cid).collection("routes").doc(routeId).get();
    if (rSnap.exists) {
      const rv = rSnap.data() || {};
      const stopsSnap = await db.collection("companies").doc(cid)
        .collection("routes").doc(routeId).collection("stops").orderBy("order").get();
      meta = {
        departTime: rv.departTime || null,
        stops: stopsSnap.docs.map(d => {
          const v = d.data() || {};
          return {
            id: d.id,
            name: v.name || "",
            offsetMin: typeof v.offsetMin === "number" ? v.offsetMin : null,
          };
        }),
      };
    }
  } catch (e) {
    console.warn(`[도착임박:시간표] 노선 로드 실패 ${cid}/${routeId}: ${e.message}`);
  }
  cache[key] = meta;
  return meta;
}

/** 순수 판정 — 지금 알려야 할 정류장 목록. 격리 테스트 대상(scripts/test_prearrival_schedule.cjs).
 *  @returns [{stopId, name, minutesLeft, marker}]  (예정 시각이 가까운 순) */
function dueStopsBySchedule({ stops, departTime, nowMin, leadMin, notified }) {
  const dm = hhmmToMinutes(departTime);
  if (dm === null || !Array.isArray(stops)) return [];
  const lead = Number.isFinite(leadMin) && leadMin > 0 ? leadMin : PRE_ARRIVAL_LEAD_MIN_DEFAULT;
  const done = Array.isArray(notified) ? notified : [];
  const out = [];
  for (const s of stops) {
    if (!s || typeof s.offsetMin !== "number" || !isFinite(s.offsetMin)) continue; // 시간표 없는 정류장
    const planned = dm + Math.round(s.offsetMin);
    const left = planned - nowMin;
    // 이미 지난 정류장(left<=0)엔 보내지 않는다 — 배포 직후 과거분 대량 발송 차단.
    if (left <= 0 || left > lead) continue;
    const marker = `${s.id}:pre1`;
    if (done.includes(marker)) continue;
    out.push({ stopId: s.id, name: s.name || "", minutesLeft: left, marker });
  }
  return out.sort((a, b) => a.minutesLeft - b.minutesLeft);
}

exports.notifyPreArrivalBySchedule = onSchedule(
  { schedule: "* * * * *", timeZone: "Asia/Seoul", region: "us-central1" },
  async () => {
    const db = admin.firestore();
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
    const hhmm = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(now);
    const nowMin = hhmmToMinutes(hhmm);
    if (nowMin === null) return;

    const companies = await db.collection("companies").get();
    for (const c of companies.docs) {
      const cid = c.id;
      const cv = c.data() || {};
      // ① 옵트인 게이트 — 켜지 않은 회사에선 아무 일도 일어나지 않는다.
      if (cv.preArrivalScheduleFallback !== true) continue;
      const leadMin = typeof cv.preArrivalLeadMin === "number" && cv.preArrivalLeadMin > 0
        ? cv.preArrivalLeadMin : PRE_ARRIVAL_LEAD_MIN_DEFAULT;

      try {
        const dispSnap = await db.collection("companies").doc(cid)
          .collection("dispatches").doc(today).collection("list").get();
        if (dispSnap.empty) continue;

        // ② 살아 있는 GPS 차량 집합 — 회사당 1회 조회(배차마다 읽으면 비용이 배로 든다).
        const freshVeh = new Set();
        try {
          const gpsSnap = await db.collection("gps").where("companyId", "==", cid).get();
          gpsSnap.docs.forEach(g => {
            const v = g.data() || {};
            const t = v.updatedAt && typeof v.updatedAt.toMillis === "function" ? v.updatedAt.toMillis() : null;
            if (t !== null && Date.now() - t <= PRE_ARRIVAL_GPS_FRESH_SEC * 1000 && v.vehicleId) {
              freshVeh.add(v.vehicleId);
            }
          });
        } catch (e) {
          console.warn(`[도착임박:시간표] gps 조회 실패 ${cid}: ${e.message}`);
        }

        const routeCache = {};
        for (const d of dispSnap.docs) {
          const dv = d.data() || {};
          if (!dv.routeId) continue;
          // 실측 경로가 살아 있으면 폴백은 물러난다.
          if (dv.vehicleId && freshVeh.has(dv.vehicleId)) continue;

          const meta = await loadRouteSchedule(db, cid, dv.routeId, routeCache);
          if (!meta || !meta.departTime) continue;   // departTime 없는 노선 = 시간표 없음

          const due = dueStopsBySchedule({
            stops: meta.stops,
            departTime: dv.departTime || meta.departTime,  // 배차가 시각을 덮어썼으면 그쪽 우선
            nowMin,
            leadMin,
            notified: dv.preArrivalNotified,
          });
          if (due.length === 0) continue;

          const newMarkers = [];
          for (const t of due) {
            const tokSnap = await db.collection("companies").doc(cid)
              .collection("fcmTokens")
              .where("routeId", "==", dv.routeId)
              .where("stopId", "==", t.stopId)
              .get();
            const tokens = tokSnap.docs.map(x => x.data().token).filter(Boolean);
            if (tokens.length === 0) continue;   // 마커 미기록(위 주석 참조)

            const message = buildPreArrivalMessage(tokens, {
              companyId: cid,
              threshold: "pre1",
              stopName: t.name,
              scheduleBased: true,
              minutesLeft: t.minutesLeft,
            });
            const resp = await admin.messaging().sendEachForMulticast(message);
            console.log(`[도착임박:시간표] ${cid} ${dv.routeId} stop=${t.stopId} ${t.minutesLeft}분전 — 성공:${resp.successCount} 실패:${resp.failureCount}`);
            newMarkers.push(t.marker);

            // 무효 토큰 자동 삭제(실측 경로와 동일 처리).
            const dels = [];
            resp.responses.forEach((r, idx) => {
              if (r.success) return;
              const code = r.error && r.error.code;
              if (code === "messaging/invalid-registration-token" ||
                  code === "messaging/registration-token-not-registered") {
                dels.push(
                  db.collection("companies").doc(cid).collection("fcmTokens")
                    .where("token", "==", tokens[idx]).get()
                    .then(s => s.docs.forEach(x => x.ref.delete()))
                );
              }
            });
            await Promise.all(dels);
          }
          if (newMarkers.length > 0) {
            await d.ref.update({
              preArrivalNotified: admin.firestore.FieldValue.arrayUnion(...newMarkers),
            });
          }
        }
      } catch (e) {
        console.error(`[도착임박:시간표] 회사 처리 실패 ${cid}: ${e.message}`);
      }
    }
  }
);

// ════════════════════════════════════════════════════════
// (2026-06-01) 정류장 도착 기록 — onCall (DriverApp 위임 채널)
//
// 배경: 기사앱 onStopReached 콜백이 클라이언트에서 `dispatches/{date}/list/{id}` 의
// `stopArrivals.{stopId}` 를 직접 updateDoc 하던 패턴은 firestore.rules 의 driver
// 본인 검증(`get(drivers/{driverId}).data.uid == request.auth.uid` + affectedKeys
// hasOnly `[stopArrivals]`) 통과에 의존했음. 2026-06-01 사용자 진단 JSON 결과
// stopArrivals 갱신 0건·`source:"stopArrivals"` 트리거 0개 확정 — onStopReached 는
// 호출되는데(setCurrentStopIdx 갱신은 됨) updateDoc 만 silent fail. 정확한 근인은
// 추후 진단(rules 매핑·drivers.uid 누락 등) 가능성. 본질 우회 = Admin SDK 위임.
//
// 입력: { companyId, date, dispatchId, stopId, plannedAt?, delaySec?, estimated?, viaBackfill? }
// 검증:
//  1. request.auth 필수(unauthenticated).
//  2. users/{request.auth.uid} 의 companyId 일치(타 회사 dispatch 차단).
//     role admin/superadmin/driver 허용. driver 면 dispatch.driverId 가 본인
//     drivers/{driverId}.uid 와 일치하는지 추가 검증(rules 패턴 미러).
//  3. date 형식 `YYYY-MM-DD`. stopId/dispatchId/companyId non-empty.
//  4. dispatch 존재 검증. stopArrivals[stopId] 이미 있으면 alreadyExists 멱등 반환
//     (첫 도착만 기록 정책 보존 — 백필 다중 호출에도 중복 0).
// 동작:
//   Admin SDK update — dot notation 으로 `stopArrivals.{stopId}` 만 갱신.
//   { actualAt: serverTimestamp, plannedAt: plannedAt||null,
//     delaySec: typeof number ? value : null, estimated: !!viaBackfill }
// 반환: { ok:true, stopId, actualAt:"serverTimestamp" } 또는 { ok:true, alreadyExists:true }.
//
// firestore.rules 변경 없음 — Admin SDK 가 우회. 향후 클라이언트 updateDoc 경로 제거
// 후 rules 좁힘은 별도 작업(현재는 양쪽 공존 가능).
// ════════════════════════════════════════════════════════
exports.recordStopArrival = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, date, dispatchId, stopId, plannedAt, delaySec, viaBackfill } = request.data || {};

  // ── 입력 검증 ──
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "date 형식이 올바르지 않습니다(YYYY-MM-DD)");
  }
  if (!dispatchId || typeof dispatchId !== "string") {
    throw new HttpsError("invalid-argument", "dispatchId가 필요합니다");
  }
  if (!stopId || typeof stopId !== "string") {
    throw new HttpsError("invalid-argument", "stopId가 필요합니다");
  }

  const db = admin.firestore();

  // ── 호출자 권한 검증 ──
  // users/{uid} 조회 → companyId 일치 + role admin/superadmin/driver 허용.
  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  if (!userSnap.exists) {
    throw new HttpsError("permission-denied", "사용자 정보를 찾을 수 없습니다");
  }
  const userData = userSnap.data() || {};
  const userRole = userData.role || null;
  if (userData.companyId !== companyId) {
    throw new HttpsError("permission-denied", "다른 회사의 운행 정보는 기록할 수 없습니다");
  }
  if (userRole !== "admin" && userRole !== "superadmin" && userRole !== "driver") {
    throw new HttpsError("permission-denied", "권한이 없습니다");
  }

  // ── dispatch 존재 검증 ──
  const dispatchRef = db
    .collection("companies").doc(companyId)
    .collection("dispatches").doc(date)
    .collection("list").doc(dispatchId);
  const dispatchSnap = await dispatchRef.get();
  if (!dispatchSnap.exists) {
    throw new HttpsError("not-found", "배차 정보를 찾을 수 없습니다");
  }
  const dispatchData = dispatchSnap.data() || {};

  // ── 멱등 가드: 이미 도착 기록 있으면 그대로 반환 ──
  const existingArrivals = dispatchData.stopArrivals || {};
  if (existingArrivals[stopId]) {
    return { ok: true, alreadyExists: true, stopId };
  }

  // ── driver 추가 검증(보안 강화 — rules 패턴 미러) ──
  // role==="driver" 이면 dispatch.driverId 의 drivers/{driverId}.uid 가 호출자와 일치해야.
  // admin/superadmin 은 회사 전체 권한이므로 skip.
  if (userRole === "driver") {
    if (!dispatchData.driverId) {
      throw new HttpsError("permission-denied", "배차에 기사 정보가 없습니다");
    }
    const driverSnap = await db
      .collection("companies").doc(companyId)
      .collection("drivers").doc(dispatchData.driverId).get();
    if (!driverSnap.exists) {
      throw new HttpsError("permission-denied", "기사 정보를 찾을 수 없습니다");
    }
    if ((driverSnap.data() || {}).uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "본인 배차만 기록할 수 있습니다");
    }
  }

  // ── stopArrivals.{stopId} 기록(dot notation) ──
  const payload = {
    actualAt: admin.firestore.FieldValue.serverTimestamp(),
    plannedAt: (typeof plannedAt === "string" && plannedAt) ? plannedAt : null,
    delaySec: typeof delaySec === "number" ? delaySec : null,
    estimated: !!viaBackfill,
  };
  await dispatchRef.update({ [`stopArrivals.${stopId}`]: payload });

  console.log(`[stopArrival] cid=${companyId} date=${date} disp=${dispatchId} stop=${stopId} backfill=${!!viaBackfill}`);
  return { ok: true, stopId, actualAt: "serverTimestamp" };
});

// ════════════════════════════════════════════════════════
// 정적(고정) QR 탑승 — CF 위임 (2026-07-13, onCall × 2)
//
// 배경: 정적 QR(`/board?c={cid}&v={vid}`) 탑승은 오늘 배차를
//   companies/{cid}/dispatches/{today}/list where vehicleId==X 로 읽어야 하는데,
//   호출 진입점(EmployeeApp 인앱 스캐너·BoardingApp 폰카메라)이 모두 익명 인증이라
//   배차 읽기 규칙(admin/driver 한정)에서 쿼리 전체가 거부됨(Missing or insufficient permissions).
// 해결: 배차 읽기 rules 는 잠금 유지하고, 이 두 onCall(Admin SDK)이 서버에서 배차를 해석.
//   클라 boarding.js 의 resolveStaticDispatch·validateAndBoardStatic 로직을 그대로 미러.
//   익명 직원이 호출하므로 assertAdmin 류 검증은 붙이지 않음(request.auth 존재만 확인).
//
// firestore.rules 변경 없음 — Admin SDK 가 우회. 배차 admin/driver 잠금 유지가 이 방식의 핵심.
// ════════════════════════════════════════════════════════

// 오늘(KST) 이 차량 배차 해석 — 두 onCall 공용(로직 중복 0).
// 배차 없으면 failed-precondition(클라 확인/오류 화면이 그대로 메시지 표시).
// selectedRouteId(옵션, 2026-07-16 회의 #1): 승객이 앱에서 선택한 노선.
//  - 있으면 그 노선 배차만 매칭 — 불일치 시 탑승 차단(오탑승 방지·적재 노선=선택 노선 보장).
//  - 없으면(폰 기본카메라 BoardingApp 등 선택 정보 없는 진입점) 전체 배차에서 해석(하위호환).
// 같은 차량 하루 다중 배차(7:10/7:50)는 departTime 이 현재 시각과 가장 가까운 회차 선택
// (기존 docs[0] 임의 선택의 모호성 제거 — 단일 배차 차량은 결과 동일).
async function resolveStaticDispatchAdmin(db, companyId, vehicleId, selectedRouteId) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

  const listSnap = await db
    .collection("companies").doc(companyId)
    .collection("dispatches").doc(today)
    .collection("list")
    .where("vehicleId", "==", vehicleId).get();
  if (listSnap.empty) {
    throw new HttpsError("failed-precondition", "오늘 이 차량은 운행 배차가 없습니다\n관리자에게 문의하세요");
  }

  const all = listSnap.docs.map((d) => d.data() || {});
  let pool = all;
  if (selectedRouteId && typeof selectedRouteId === "string") {
    pool = all.filter((d) => d.routeId === selectedRouteId);
    if (!pool.length) {
      const names = [...new Set(all.map((d) => d.routeName || d.routeId).filter(Boolean))].join(", ");
      throw new HttpsError(
        "failed-precondition",
        `선택한 노선의 차량이 아닙니다\n이 차량의 오늘 운행 노선: ${names || "미상"}\n앱에서 노선을 확인한 뒤 다시 스캔해주세요`
      );
    }
  }

  // 다중 회차 — departTime(HH:MM)이 현재 KST 와 가장 가까운 배차. 미설정 배차는 뒤로.
  const nowHM = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
  const nowMin = hhmmToMinutes(nowHM);
  const gap = (d) => {
    const m = hhmmToMinutes(d.departTime);
    return (m === null || nowMin === null) ? Infinity : Math.abs(m - nowMin);
  };
  const disp = pool.reduce((best, d) => (gap(d) < gap(best) ? d : best), pool[0]);
  let vehicleNo = disp.vehicleNo || "";
  // 배차에 vehicleNo 없으면 vehicles/{vehicleId}.plateNo 폴백.
  if (!vehicleNo) {
    try {
      const vSnap = await db
        .collection("companies").doc(companyId)
        .collection("vehicles").doc(vehicleId).get();
      if (vSnap.exists) vehicleNo = (vSnap.data() || {}).plateNo || "";
    } catch (_) { /* 권한/네트워크 오류 → vehicleNo 빈 문자열, 탑승 자체는 진행 */ }
  }

  return {
    today,
    routeId: disp.routeId || "",
    routeName: disp.routeName || "",
    driverId: disp.driverId || "",
    vehicleNo,
  };
}

// ─── 오늘 노선 도착 기록 조회(익명 화면 위임, 2026-08-18) ─────────────────
// getRouteStopArrivals({ companyId, routeIds }) — 읽기 전용.
//
// 🔴 왜 CF 인가: `dispatches/{date}/list` 의 read 규칙은 `isAdmin || isDriverOf` 인데
//    이 데이터를 쓰는 화면(승객앱 `/bus`·직원앱 `/p`·협력사 포털)은 전부 **익명 인증**이라
//    클라이언트 쿼리가 통째로 거부된다. 거부는 에러 없이 빈 결과로 흡수되어
//    **정류장 '실제 도착시각'·'직전 정류장 도착' 인앱 알림·'운행 종료' 표기·협력사
//    노선도의 통과(✓) 가 전부 조용히 죽어 있었다**(2026-08-18 실측).
//    rules 를 익명에 열면 회사 전체 배차(기사명·차량번호·배차표)가 열리므로,
//    `resolveStaticBoarding`(2026-07-13) 선례대로 **필요한 값만** 서버가 돌려준다.
//
// 🔴 돌려주는 것은 도착 기록뿐 — 기사명·차량번호·배차 ID 는 포함하지 않는다(최소 노출).
// 병합 규칙은 **기존 클라이언트와 글자 그대로 같다**: 같은 노선 배차가 여럿이면
// 정류장마다 **가장 이른 actualAt**(먼저 도착한 차량 우선). 바꾸면 표시가 달라진다.
// ⚠ 순환(왕복) 노선에서 첫 바퀴 시각이 굳는 기존 한계도 그대로다(issues.md `[미해결]`).
//
// 반환: { date, routes: { [routeId]: { count: number, arrivals: { [stopId]: ms } } } }
//   count = 오늘 그 노선 배차 건수(0 이면 운행 없음 — `computeRunEnded` 의 hasTodayDispatch).
const STOP_ARRIVALS_MAX_ROUTES = 40; // 협력사 포털 최대 노선 수(채드윅 29) 여유분
exports.getRouteStopArrivals = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, routeIds } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  const ids = [...new Set(
    (Array.isArray(routeIds) ? routeIds : [routeIds])
      .filter((r) => typeof r === "string" && r.trim())
      .map((r) => r.trim())
  )];
  if (ids.length === 0) throw new HttpsError("invalid-argument", "routeIds가 필요합니다");
  if (ids.length > STOP_ARRIVALS_MAX_ROUTES) {
    throw new HttpsError("invalid-argument", `노선은 한 번에 ${STOP_ARRIVALS_MAX_ROUTES}개까지 조회합니다`);
  }

  const db = admin.firestore();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const routes = {};
  ids.forEach((rid) => { routes[rid] = { count: 0, arrivals: {} }; });

  // routeId 동등 필터(단일필드=자동 인덱스). `in` 은 10개씩 끊는다 —
  // 🔴 그날 배차 전체를 읽어 클라 필터하면 승객 한 명이 45문서를 읽는다(폴링과 곱해진다).
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));

  for (const chunk of chunks) {
    const snap = await db
      .collection("companies").doc(companyId)
      .collection("dispatches").doc(date)
      .collection("list")
      .where("routeId", "in", chunk)
      .get();
    snap.docs.forEach((d) => {
      const v = d.data() || {};
      const bucket = routes[v.routeId];
      if (!bucket) return;
      bucket.count += 1;
      const sa = v.stopArrivals || {};
      Object.entries(sa).forEach(([stopId, rec]) => {
        const at = rec && rec.actualAt;
        const ms = at && typeof at.toMillis === "function"
          ? at.toMillis()
          : (typeof at === "number" ? at : null);
        if (ms == null) return;
        if (bucket.arrivals[stopId] == null || ms < bucket.arrivals[stopId]) {
          bucket.arrivals[stopId] = ms;
        }
      });
    });
  }

  return { date, routes };
});

// resolveStaticBoarding({ companyId, vehicleId, selectedRouteId? }) — 읽기 전용(확인 화면 프리뷰용).
// 반환: { today, routeId, routeName, driverId, vehicleNo }.
exports.resolveStaticBoarding = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, vehicleId, selectedRouteId } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (!vehicleId || typeof vehicleId !== "string") {
    throw new HttpsError("invalid-argument", "vehicleId가 필요합니다");
  }

  const db = admin.firestore();
  return await resolveStaticDispatchAdmin(db, companyId, vehicleId, selectedRouteId);
});

// boardStatic({ companyId, vehicleId, empNo, name }) — 배차 재해석 + 멱등 boarding 생성.
// 서버가 배차를 다시 해석(클라 값 불신). 멱등 doc id = `${empNo}__${vehicleId}`.
// 반환: { ok:true, alreadyBoarded, routeName, vehicleNo, dispatchDate }.
exports.boardStatic = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, vehicleId, empNo, name, selectedRouteId } = request.data || {};
  if (!companyId || !vehicleId || !empNo || !String(empNo).trim()) {
    throw new HttpsError("invalid-argument", "사번을 입력해주세요");
  }
  const trimmedEmpNo = String(empNo).trim();

  const db = admin.firestore();

  // 오늘 배차 해석(비면 failed-precondition) — routeId/routeName/driverId/vehicleNo 확보.
  // selectedRouteId 있으면 선택 노선 매칭 강제(불일치=차단, 2026-07-16 회의 #1).
  const { today, routeId, routeName, driverId, vehicleNo } =
    await resolveStaticDispatchAdmin(db, companyId, vehicleId, selectedRouteId);

  // partnerCode 자동 채움 — passengers/{empNo}.partnerCode(협력사별 통계용).
  let partnerCode = null;
  try {
    const passSnap = await db
      .collection("companies").doc(companyId)
      .collection("passengers").doc(trimmedEmpNo).get();
    if (passSnap.exists) partnerCode = (passSnap.data() || {}).partnerCode || null;
  } catch (_) { /* 권한/네트워크 오류는 partnerCode 부재로 처리 — 탑승 기록 자체는 진행 */ }

  // 차량 GPS 위치 캡처 — 탑승 시점 좌표 보존(정류장 매핑용).
  let vehicleLat = null, vehicleLng = null, vehicleSpeed = null;
  try {
    const gpsSnap = await db.collection("gps").doc(`${companyId}_${vehicleId}`).get();
    if (gpsSnap.exists) {
      const g = gpsSnap.data() || {};
      vehicleLat = typeof g.lat === "number" ? g.lat : null;
      vehicleLng = typeof g.lng === "number" ? g.lng : null;
      vehicleSpeed = typeof g.speed === "number" ? g.speed : null;
    }
  } catch (_) { /* GPS 미수신/권한 → null 처리, 탑승 자체는 진행 */ }

  // 멱등 boarding — 결정적 doc id(직원 1인 × 차량 × 당일 1건). 이미 있으면 첫 스캔 보존.
  const boardingRef = db
    .collection("companies").doc(companyId)
    .collection("boardings").doc(today)
    .collection("list").doc(`${trimmedEmpNo}__${vehicleId}`);
  const existing = await boardingRef.get();
  if (existing.exists) {
    return { ok: true, alreadyBoarded: true, routeName, vehicleNo, dispatchDate: today };
  }

  await boardingRef.set({
    empNo: trimmedEmpNo,
    name: (name || "").trim(),
    tokenId: "",           // 정적 QR 은 토큰 없음(스키마 자리 유지)
    companyId, routeId, routeName,
    vehicleId, vehicleNo, driverId,
    stopId: "",
    stopName: "",
    partnerCode,
    vehicleLat, vehicleLng, vehicleSpeed,
    via: "static",         // 정적 QR 탑승 식별(통계 read 호환·옵셔널)
    boardedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`[boardStatic] cid=${companyId} veh=${vehicleId} emp=${trimmedEmpNo} route=${routeId}`);
  return { ok: true, alreadyBoarded: false, routeName, vehicleNo, dispatchDate: today };
});

// ════════════════════════════════════════════════════════
// NFC 사원증 탑승 (2026-07-22) — 기사앱 Web NFC 태깅 → 서버 판정
//
// 레거시 버스인3 의 "기사용 NFC 탑승"을 buslink 로 이식. 기사 폰(Android Chrome)이
// NDEFReader 로 카드 serial 을 읽어 이 함수를 호출하면 서버가 판정한다.
//
// 왜 CF 위임인가(클라 직접 조회 아님):
//  ① 미등록 카드 기록(nfcRejects)은 companies/** 하위라 write 룰이 admin 전용 —
//     기사(role=driver)는 거부된다. Admin SDK 우회가 필요.
//  ② `passengers where nfcUid ==` 를 클라가 돌리면 카드-사람 매핑 전체가 기사 단말에
//     노출될 수 있다. 서버는 매칭된 1건만 돌려준다.
//  ③ UID 정규화를 서버에서 한 번 더 강제(클라 정규화 누락 시에도 계약 유지).
//
// 입력: { companyId, vehicleId, uid, selectedRouteId? }
// 반환(정상): { ok:true, registered:true, empNo, name, alreadyBoarded, routeName, vehicleNo, dispatchDate, todayCount }
// 반환(미등록): { ok:true, registered:false, uid, routeName, vehicleNo, dispatchDate, todayCount }
//   — 미등록도 **throw 하지 않는다**. 기사 화면이 빨간 "미등록" UI 를 그려야 하고,
//     throw 로 만들면 네트워크 오류와 구분이 안 된다.
// ════════════════════════════════════════════════════════

// UID 정규화 — 클라 src/lib/nfc.js normalizeNfcUid 와 **동일 계약**(소문자 hex·구분자 제거).
// 두 곳이 어긋나면 등록값과 조회값이 안 맞아 전원 미등록으로 떨어진다(회귀 가드).
function normalizeNfcUidServer(raw) {
  if (raw == null) return "";
  return String(raw).toLowerCase().replace(/[^0-9a-f]/g, "");
}

exports.boardNfc = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, vehicleId, uid, selectedRouteId } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (!vehicleId || typeof vehicleId !== "string") {
    throw new HttpsError("invalid-argument", "vehicleId가 필요합니다");
  }
  const cleanUid = normalizeNfcUidServer(uid);
  if (!cleanUid) throw new HttpsError("invalid-argument", "카드 정보를 읽지 못했습니다");

  const db = admin.firestore();

  // 호출자 권한 — 기사 또는 관리자, 그리고 **같은 회사**. recordStopArrival 패턴 미러.
  // (익명 인증 승객이 남의 회사 카드를 긁어보는 것 차단)
  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const user = userSnap.exists ? (userSnap.data() || {}) : {};
  if (!["driver", "admin", "superadmin"].includes(user.role)) {
    throw new HttpsError("permission-denied", "기사 또는 관리자만 태깅할 수 있습니다");
  }
  if (user.role !== "superadmin" && user.companyId !== companyId) {
    throw new HttpsError("permission-denied", "다른 회사의 태깅은 허용되지 않습니다");
  }

  // 오늘 배차 해석(비면 failed-precondition) — 정적 QR 과 동일 헬퍼(로직 중복 0).
  const { today, routeId, routeName, driverId, vehicleNo } =
    await resolveStaticDispatchAdmin(db, companyId, vehicleId, selectedRouteId);

  // 카드 → 탑승자 조회. 단일 필드 동등 쿼리라 복합 인덱스 불요(자동 인덱스).
  const passSnap = await db
    .collection("companies").doc(companyId)
    .collection("passengers")
    .where("nfcUid", "==", cleanUid).limit(1).get();

  const boardingsCol = db
    .collection("companies").doc(companyId)
    .collection("boardings").doc(today).collection("list");

  // 오늘 이 차량 탑승 인원 — 기사 화면 카운터. swstagsys 는 메모리 카운트라
  // 새로고침 시 0 이 되는 약점이 있었다(그쪽 issues.md 🟡) → 서버 집계로 해소.
  const countToday = async () => {
    try {
      const agg = await boardingsCol.where("vehicleId", "==", vehicleId).count().get();
      return agg.data().count;
    } catch (_) { return null; } // 집계 실패는 화면 카운터만 생략(탑승은 이미 기록됨)
  };

  // ── 미등록 카드(부정승차) — boardings 를 오염시키지 않고 별도 기록 ──
  if (passSnap.empty) {
    try {
      await db
        .collection("companies").doc(companyId)
        .collection("nfcRejects").doc(today).collection("list").add({
          companyId, nfcUid: cleanUid,
          routeId, routeName, vehicleId, vehicleNo, driverId,
          reason: "unregistered",
          taggedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) {
      console.warn(`[boardNfc] reject 기록 실패 cid=${companyId} uid=${cleanUid}: ${e.message}`);
    }
    console.log(`[boardNfc] UNREGISTERED cid=${companyId} veh=${vehicleId} uid=${cleanUid}`);
    return {
      ok: true, registered: false, uid: cleanUid,
      routeName, vehicleNo, dispatchDate: today, todayCount: await countToday(),
    };
  }

  const pass = passSnap.docs[0].data() || {};
  const empNo = String(pass.empNo || passSnap.docs[0].id || "").trim();
  const name = String(pass.name || "").trim();

  // 비활성 탑승자도 **탑승은 기록**하되 미등록과 구분(운영자가 사후 판단).
  // 여기서 차단하면 퇴사 처리 지연 등으로 정상 출근자가 버스 앞에서 막힌다.

  // 차량 GPS 캡처 — boardStatic 과 동일(정류장 사후 매핑용).
  let vehicleLat = null, vehicleLng = null, vehicleSpeed = null;
  try {
    const gpsSnap = await db.collection("gps").doc(`${companyId}_${vehicleId}`).get();
    if (gpsSnap.exists) {
      const g = gpsSnap.data() || {};
      vehicleLat = typeof g.lat === "number" ? g.lat : null;
      vehicleLng = typeof g.lng === "number" ? g.lng : null;
      vehicleSpeed = typeof g.speed === "number" ? g.speed : null;
    }
  } catch (_) { /* GPS 미수신 → null, 탑승 자체는 진행 */ }

  // 멱등 boarding — 정적 QR 과 **동일한 결정적 doc id**(직원 1인 × 차량 × 당일 1건).
  // 같은 사람이 QR 로 이미 탔으면 NFC 태깅이 중복 적재하지 않는다(모드 간 멱등도 확보).
  const boardingRef = boardingsCol.doc(`${empNo}__${vehicleId}`);
  const existing = await boardingRef.get();
  if (existing.exists) {
    return {
      ok: true, registered: true, empNo, name, alreadyBoarded: true,
      routeName, vehicleNo, dispatchDate: today, todayCount: await countToday(),
    };
  }

  await boardingRef.set({
    empNo,
    name,
    tokenId: "",                 // NFC 는 토큰 없음(스키마 자리 유지)
    companyId, routeId, routeName,
    vehicleId, vehicleNo, driverId,
    stopId: "",
    stopName: "",
    partnerCode: pass.partnerCode || null,
    vehicleLat, vehicleLng, vehicleSpeed,
    via: "nfc",                  // 탑승 모드 식별(기존 통계 read 호환·옵셔널)
    nfcUid: cleanUid,
    boardedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`[boardNfc] cid=${companyId} veh=${vehicleId} emp=${empNo} uid=${cleanUid}`);
  return {
    ok: true, registered: true, empNo, name, alreadyBoarded: false,
    routeName, vehicleNo, dispatchDate: today, todayCount: await countToday(),
  };
});

// registerNfcCard({ companyId, empNo, uid }) — 기사앱 카드 등록 대행 (2026-07-22)
//
// 배경: 기존 사원증·출입카드를 재사용하면 회사에 UID 목록이 없다 → 카드를 한 번씩
// 읽어내야 하는데, 승객 자가등록은 iOS 웹이 NFC 를 못 읽어 불가. 기사 폰(Android)이
// 이미 NFC 리더이므로 기사가 대행 등록한다(추가 장비 0).
//
// 규칙:
//  - 같은 사람이 다른 카드로 재등록 = **허용**(카드 분실·교체. 레거시 버스인도 재태깅=재등록).
//  - 다른 사람에게 이미 등록된 카드 = **거부**. 조용히 뺏으면 원 소유자가 어느 날 갑자기
//    "미등록 카드"가 되고 원인 추적이 불가능해진다. 관리자가 포털에서 해제 후 재등록.
//  - passengers.write 룰이 isAuth() 라 클라 직접 쓰기도 가능하지만, **중복 검사와 정규화를
//    한 곳에서 강제**하려면 서버여야 한다(클라 우회 시 UID 중복 → 조회가 임의 1건 선택).
exports.registerNfcCard = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, empNo, uid } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  const trimmedEmpNo = String(empNo || "").trim();
  if (!trimmedEmpNo) throw new HttpsError("invalid-argument", "승객을 선택해주세요");

  const cleanUid = normalizeNfcUidServer(uid);
  // 클라 isValidNfcUid 와 동일 기준(8자 이상·짝수) — 잘못 읽힌 값이 등록되면
  // 그 사람은 영영 태깅이 안 되므로 등록 시점에 거른다.
  if (cleanUid.length < 8 || cleanUid.length % 2 !== 0) {
    throw new HttpsError("invalid-argument", "카드 번호를 정확히 읽지 못했습니다\n카드를 다시 태그해주세요");
  }

  const db = admin.firestore();

  const passRef = db
    .collection("companies").doc(companyId)
    .collection("passengers").doc(trimmedEmpNo);
  const passSnap = await passRef.get();
  if (!passSnap.exists) throw new HttpsError("not-found", "등록되지 않은 승객입니다");
  const pass = passSnap.data() || {};

  // ── 호출자 인증 2경로 ──────────────────────────────────────────
  // (a) 기사·관리자: users/{uid}.role + 같은 회사 (기사앱 현장 등록)
  // (b) 협력사 포털: PartnerApp 은 **익명 인증 + 업체코드 인증**이라 role 이 없다
  //     → partnerCodes/{code} 검증(exists+active+companyId 일치) + **대상 승객이
  //     그 협력사 소속인지**까지 확인해야 남의 거래처 직원 카드를 못 건드린다.
  //     (sendPartnerNotice 의 코드 인증 패턴과 동일)
  const { partnerCode } = request.data || {};
  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const user = userSnap.exists ? (userSnap.data() || {}) : {};
  const isStaff = ["driver", "admin", "superadmin"].includes(user.role);

  if (isStaff) {
    if (user.role !== "superadmin" && user.companyId !== companyId) {
      throw new HttpsError("permission-denied", "다른 회사의 등록은 허용되지 않습니다");
    }
  } else {
    const code = String(partnerCode || "").trim();
    if (!code) throw new HttpsError("permission-denied", "등록 권한이 없습니다");
    const codeSnap = await db.collection("partnerCodes").doc(code).get();
    const cd = codeSnap.exists ? (codeSnap.data() || {}) : null;
    if (!cd || cd.active === false || cd.companyId !== companyId) {
      throw new HttpsError("permission-denied", "유효하지 않은 업체코드입니다");
    }
    if ((pass.partnerCode || null) !== code) {
      throw new HttpsError("permission-denied", "이 승객은 해당 거래처 소속이 아닙니다");
    }
  }

  // 이 카드가 이미 다른 사람 것인지 — 중복 등록이면 조회(limit 1)가 임의로 한 명을
  // 고르게 되어 "어떤 날은 되고 어떤 날은 안 되는" 증상이 된다.
  const dupSnap = await db
    .collection("companies").doc(companyId)
    .collection("passengers")
    .where("nfcUid", "==", cleanUid).limit(2).get();
  const other = dupSnap.docs.find((d) => d.id !== trimmedEmpNo);
  if (other) {
    const o = other.data() || {};
    throw new HttpsError(
      "already-exists",
      `이 카드는 이미 ${o.name || "다른 승객"}(${o.empNo || other.id})에게 등록되어 있습니다\n관리자가 협력사 포털에서 해제한 뒤 다시 등록해주세요`
    );
  }

  const prevUid = pass.nfcUid || null;
  await passRef.update({
    nfcUid: cleanUid,
    nfcUidUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`[registerNfcCard] cid=${companyId} emp=${trimmedEmpNo} uid=${cleanUid} prev=${prevUid || "-"} by=${isStaff ? user.role : "partner"}`);
  return {
    ok: true,
    empNo: trimmedEmpNo,
    name: pass.name || "",
    replaced: !!prevUid && prevUid !== cleanUid, // 카드 교체였는지(화면 문구 분기용)
  };
});

// ════════════════════════════════════════════════════════
// SaaS Phase 1.4 (2026-05-29) — 협력사 공지 발송 (onCall)
//
// 협력사 인사 담당이 자기 직원에게 직접 공지 발송.
// PartnerApp 은 익명 인증 + 업체코드 인증 흐름 → notices/fcmQueue 클라이언트 직접 create
// 룰(admin only) 불가 → 이 onCall 이 Admin SDK 로 룰 우회.
//
// 옵션 A(사용자 결정): 자기 partnerCode 직원만, 1시간 5건, title 50 / body 500.
//
// 입력: { companyId, partnerCode, title, body, type? }
// 검증:
//  1. request.auth 필수(익명도 통과).
//  2. partnerCodes/{code} exists + active==true + companyId 일치.
//  3. title 1~50자, body 1~500자(trim). type ∈ {"normal","emergency"} 또는 기본 "normal".
//  4. rate-limit: partnerCodes/{code}.recentNoticeTimestamps 배열에서
//     now - 1시간 이내 항목 ≥5면 resource-exhausted (한국어 + 남은 분).
//
// 동작:
//  a. companies/{cid}/notices create — partnerCode·sender:"partner"·senderCode:code.
//  b. fcmQueue create — partnerCode 포함. 기존 sendNoticeToCompany 트리거가
//     partnerCode 필터 multicast(인프라 재사용, CF 신규 발송 로직 없음).
//  c. partnerCodes/{code}.recentNoticeTimestamps 갱신 — 1시간 초과 항목 정리
//     + now 추가(무한 증가 방지).
//
// 반환: { ok, noticeId, queueId, remainingPerHour }.
// ════════════════════════════════════════════════════════
const PARTNER_NOTICE_LIMIT_PER_HOUR = 5;
const PARTNER_NOTICE_WINDOW_MS = 60 * 60 * 1000;
const PARTNER_NOTICE_TITLE_MAX = 50;
const PARTNER_NOTICE_BODY_MAX = 500;

exports.sendPartnerNotice = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, partnerCode, title, body, type } = request.data || {};
  // ── 입력 검증 ──
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (!partnerCode || typeof partnerCode !== "string") {
    throw new HttpsError("invalid-argument", "partnerCode가 필요합니다");
  }
  const t = typeof title === "string" ? title.trim() : "";
  const b = typeof body === "string" ? body.trim() : "";
  if (!t || t.length > PARTNER_NOTICE_TITLE_MAX) {
    throw new HttpsError("invalid-argument", `제목은 1~${PARTNER_NOTICE_TITLE_MAX}자입니다`);
  }
  if (!b || b.length > PARTNER_NOTICE_BODY_MAX) {
    throw new HttpsError("invalid-argument", `본문은 1~${PARTNER_NOTICE_BODY_MAX}자입니다`);
  }
  const noticeType = (type === "emergency") ? "emergency" : "normal";

  const db = admin.firestore();

  // ── partnerCodes 검증 ──
  const codeRef = db.collection("partnerCodes").doc(partnerCode);
  const codeSnap = await codeRef.get();
  if (!codeSnap.exists) {
    throw new HttpsError("not-found", "업체코드가 존재하지 않습니다");
  }
  const codeData = codeSnap.data() || {};
  if (codeData.active === false) {
    throw new HttpsError("permission-denied", "비활성 업체코드입니다");
  }
  if (codeData.companyId !== companyId) {
    throw new HttpsError("permission-denied", "업체코드와 회사가 일치하지 않습니다");
  }

  // ── rate-limit 검증(서버 시각 기준, 클라 시각 신뢰 X) ──
  const now = Date.now();
  const cutoff = now - PARTNER_NOTICE_WINDOW_MS;
  const rawRecent = Array.isArray(codeData.recentNoticeTimestamps) ? codeData.recentNoticeTimestamps : [];
  const recentInWindow = rawRecent.filter(ts => typeof ts === "number" && ts > cutoff);

  if (recentInWindow.length >= PARTNER_NOTICE_LIMIT_PER_HOUR) {
    const oldest = Math.min(...recentInWindow);
    const remainingMs = (oldest + PARTNER_NOTICE_WINDOW_MS) - now;
    const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
    throw new HttpsError(
      "resource-exhausted",
      `시간당 ${PARTNER_NOTICE_LIMIT_PER_HOUR}건까지 발송 가능합니다. 남은 시간: ${remainingMin}분`
    );
  }

  // ── notices create ──
  const noticeRef = db.collection("companies").doc(companyId).collection("notices").doc();
  await noticeRef.set({
    title: t,
    body: b,
    type: noticeType,
    companyId,
    partnerCode,
    active: true,
    sender: "partner",
    senderCode: partnerCode,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── fcmQueue create — 기존 sendNoticeToCompany 트리거가 partnerCode 필터 발송 ──
  const queueRef = db.collection("fcmQueue").doc();
  await queueRef.set({
    companyId,
    noticeId: noticeRef.id,
    title: t,
    body: b,
    type: noticeType,
    partnerCode,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── partnerCodes.recentNoticeTimestamps 갱신(옛 항목 정리 + now 추가) ──
  const updatedRecent = [...recentInWindow, now];
  await codeRef.update({ recentNoticeTimestamps: updatedRecent });

  const remainingPerHour = PARTNER_NOTICE_LIMIT_PER_HOUR - updatedRecent.length;
  console.log(`[협력사공지] code=${partnerCode} cid=${companyId} title="${t}" remaining=${remainingPerHour}`);

  return {
    ok: true,
    noticeId: noticeRef.id,
    queueId: queueRef.id,
    remainingPerHour,
  };
});

// ════════════════════════════════════════════════════════
// 호출자 권한 검증 — users/{uid}.role 이 admin/superadmin 인지 확인
// (같은 프로젝트의 익명 인증(승객·직원)은 토큰만 보유 → role 없음 → 차단)
// ════════════════════════════════════════════════════════
async function assertAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
  const userSnap = await admin.firestore()
    .collection("users").doc(request.auth.uid).get();
  const role = userSnap.exists ? userSnap.data().role : null;
  if (role !== "admin" && role !== "superadmin") {
    throw new HttpsError("permission-denied", "관리자 권한이 필요합니다");
  }
}

// SaaS Phase 1.2 (2026-05-28) — 슈퍼관리자 전용 검증.
// 회사 생성/목록/활성 토글은 cross-company 권한이라 admin 으론 부족.
async function assertSuperAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
  const userSnap = await admin.firestore()
    .collection("users").doc(request.auth.uid).get();
  const role = userSnap.exists ? userSnap.data().role : null;
  if (role !== "superadmin") {
    throw new HttpsError("permission-denied", "슈퍼관리자 권한이 필요합니다");
  }
}

// ════════════════════════════════════════════════════════
// SaaS Phase 1.2 (2026-05-28) — 회사 관리(슈퍼관리자 전용)
//
// createCompany: companies/{cid} + Auth 계정 + users/{newUid} 3건 동기 생성.
// 실패 시 rollback(Auth 계정 생성 후 users 생성 실패면 Auth 삭제) — createDriver 패턴 미러.
// listCompanies: companies 컬렉션 list(id/name/active/createdAt).
// toggleCompanyActive: companies/{cid}.active 토글.
// ════════════════════════════════════════════════════════

exports.createCompany = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, companyName, adminEmpNo, adminEmail, adminPassword, adminName } = request.data || {};

  if (!companyId || !/^[a-z0-9]{3,20}$/.test(companyId)) {
    throw new HttpsError("invalid-argument", "companyId는 소문자·숫자 3~20자입니다");
  }
  if (!companyName || !adminEmpNo || !adminEmail || !adminPassword || !adminName) {
    throw new HttpsError("invalid-argument", "companyName/adminEmpNo/adminEmail/adminPassword/adminName 모두 필요합니다");
  }
  if (adminPassword.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }

  const db = admin.firestore();
  const companyRef = db.collection("companies").doc(companyId);
  const existing = await companyRef.get();
  if (existing.exists) {
    throw new HttpsError("already-exists", `회사 ${companyId}가 이미 존재합니다`);
  }

  // 1) companies/{cid} 도큐먼트 생성
  await companyRef.set({
    name: companyName,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 2) Auth 계정 생성
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: adminName,
    });
  } catch (e) {
    // rollback: 회사 도큐먼트 삭제
    await companyRef.delete().catch(() => {});
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 등록된 관리자 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 계정 생성 실패: ${e.message}`);
  }

  // 3) users/{newUid} 도큐먼트 생성 — role=admin (관리자 권한). 슈퍼관리자 신설은 별도.
  try {
    await db.collection("users").doc(userRecord.uid).set({
      role: "admin",
      companyId,
      empNo: adminEmpNo,
      name: adminName,
    });
  } catch (e) {
    // rollback: Auth 계정 + companies 도큐먼트 삭제
    await admin.auth().deleteUser(userRecord.uid).catch(() => {});
    await companyRef.delete().catch(() => {});
    throw new HttpsError("internal", `users 문서 생성 실패: ${e.message}`);
  }

  console.log(`[회사생성] cid=${companyId} adminUid=${userRecord.uid} 호출자=${request.auth.uid}`);
  return { ok: true, companyId, uid: userRecord.uid };
});

exports.listCompanies = onCall(async (request) => {
  await assertSuperAdmin(request);
  const db = admin.firestore();
  const snap = await db.collection("companies").get();
  const list = snap.docs.map(d => {
    const v = d.data() || {};
    return {
      id: d.id,
      name: v.name || d.id,
      active: v.active !== false,   // 기존 도큐먼트(필드 없음) = true(호환)
      createdAt: v.createdAt && v.createdAt.toDate
        ? v.createdAt.toDate().toISOString()
        : (v.createdAt || null),
    };
  });
  // 활성 우선, 그 다음 이름순 정렬(클라 UI 안정).
  list.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "");
  });
  return { companies: list };
});

exports.toggleCompanyActive = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, active } = request.data || {};
  if (!companyId) throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  if (typeof active !== "boolean") throw new HttpsError("invalid-argument", "active(boolean)가 필요합니다");

  const db = admin.firestore();
  const ref = db.collection("companies").doc(companyId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  await ref.update({ active });
  console.log(`[회사토글] cid=${companyId} active=${active} 호출자=${request.auth.uid}`);
  return { ok: true, companyId, active };
});

// ════════════════════════════════════════════════════════
// SaaS Phase 1.2+ (2026-05-29) — 회사 운영 메뉴 4종(슈퍼관리자 전용)
//
// 사용자 결정: "둘 다 제공" — 비활성(toggleCompanyActive, 기존)과 영구 삭제(deleteCompany) 양쪽.
//
// updateCompanyInfo({companyId, name})
//   companies/{cid}.name 만 update. 자기 회사 회사명 변경은 자유.
//
// resetCompanyAdminPassword({companyId, newPassword})
//   그 회사 첫 admin uid 의 Firebase Auth 비밀번호 변경. >=6자.
//
// updateCompanyAdminInfo({companyId, displayName?, email?})
//   그 회사 첫 admin 의 Auth displayName/email + users 도큐먼트 name/email 동기 변경.
//   둘 중 최소 1개 제공 필요.
//
// deleteCompany({companyId, confirmCompanyId})
//   cascade 영구 삭제:
//     companies/{cid} 하위 전체(recursiveDelete) + gpsHistory/{cid} (recursiveDelete)
//     + 최상위 컬렉션(gps/partnerCodes/boardingTokens/passengerTokens/fcmQueue) where companyId==cid 일괄 삭제
//     + users where companyId==cid 의 Auth 계정 + users 도큐먼트 삭제.
//   한계 명시(주석): etaDiagnostics 는 companyId 인덱싱 불가능 → skip(일자별 자연 정리).
//   자기 회사 보호: 호출자 users/{uid}.companyId === companyId 면 차단(자기 lockout 방지).
//   confirmCompanyId === companyId 일치 검증(오삭제 방지).
//
// 부분 실패 시 throw — 사용자 재시도하면 멱등(이미 삭제된 건 자연 skip).
// ════════════════════════════════════════════════════════

/**
 * 그 회사의 첫 admin user 도큐먼트를 찾아 반환(uid + 데이터).
 * 없으면 not-found 한국어 throw.
 */
async function findCompanyAdmin(db, companyId) {
  const snap = await db.collection("users")
    .where("companyId", "==", companyId)
    .where("role", "==", "admin")
    .limit(1)
    .get();
  if (snap.empty) {
    throw new HttpsError("not-found", "회사 관리자 계정을 찾을 수 없습니다");
  }
  const doc = snap.docs[0];
  return { uid: doc.id, data: doc.data() || {} };
}

/**
 * Firestore query 결과를 500개 청크로 batch delete.
 * 최상위 컬렉션 where companyId==cid 삭제용(gps/partnerCodes/boardingTokens/passengerTokens/fcmQueue).
 */
async function deleteQueryInBatches(db, query, label) {
  let totalDeleted = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(500).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    totalDeleted += snap.size;
    console.log(`[회사삭제] ${label} 청크 삭제: ${snap.size}건(누적 ${totalDeleted})`);
    if (snap.size < 500) break;
  }
  return totalDeleted;
}

exports.updateCompanyInfo = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, name } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > 50) {
    throw new HttpsError("invalid-argument", "회사 이름은 1~50자입니다");
  }
  const db = admin.firestore();
  const ref = db.collection("companies").doc(companyId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  await ref.update({ name: n });
  console.log(`[회사정보수정] cid=${companyId} name="${n}" 호출자=${request.auth.uid}`);
  return { ok: true, companyId, name: n };
});

exports.resetCompanyAdminPassword = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, newPassword } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }
  const db = admin.firestore();
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  const adminUser = await findCompanyAdmin(db, companyId);
  try {
    await admin.auth().updateUser(adminUser.uid, { password: newPassword });
  } catch (e) {
    throw new HttpsError("internal", `비밀번호 변경 실패: ${e.message}`);
  }
  console.log(`[관리자비번초기화] cid=${companyId} uid=${adminUser.uid} 호출자=${request.auth.uid}`);
  return { ok: true, uid: adminUser.uid, email: adminUser.data.email || null };
});

exports.updateCompanyAdminInfo = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, displayName, email } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  const hasName = typeof displayName === "string" && displayName.trim().length > 0;
  const hasEmail = typeof email === "string" && email.trim().length > 0;
  if (!hasName && !hasEmail) {
    throw new HttpsError("invalid-argument", "displayName 또는 email 중 최소 1개를 제공해야 합니다");
  }
  if (hasEmail) {
    // 간단한 이메일 형식 검증.
    const e = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      throw new HttpsError("invalid-argument", "이메일 형식이 올바르지 않습니다");
    }
  }

  const db = admin.firestore();
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  const adminUser = await findCompanyAdmin(db, companyId);

  const authPatch = {};
  const userDocPatch = {};
  if (hasName) {
    authPatch.displayName = displayName.trim();
    userDocPatch.name = displayName.trim();
  }
  if (hasEmail) {
    authPatch.email = email.trim();
    userDocPatch.email = email.trim();
  }

  try {
    await admin.auth().updateUser(adminUser.uid, authPatch);
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 등록된 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 정보 변경 실패: ${e.message}`);
  }

  try {
    await db.collection("users").doc(adminUser.uid).update(userDocPatch);
  } catch (e) {
    // users 도큐먼트 update 실패는 비치명적 — Auth 는 이미 변경됨. 경고만.
    console.warn(`[관리자정보수정] users 도큐먼트 update 실패 uid=${adminUser.uid}: ${e.message}`);
  }

  console.log(`[관리자정보수정] cid=${companyId} uid=${adminUser.uid} 변경=${JSON.stringify(authPatch)} 호출자=${request.auth.uid}`);
  return {
    ok: true,
    uid: adminUser.uid,
    displayName: authPatch.displayName || null,
    email: authPatch.email || null,
  };
});

exports.deleteCompany = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, confirmCompanyId } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (companyId !== confirmCompanyId) {
    throw new HttpsError("failed-precondition", "확인 입력값이 일치하지 않습니다");
  }

  const db = admin.firestore();

  // ── 자기 회사 보호: 호출자가 슈퍼관리자라도 자기 회사 삭제는 차단 ──
  // 슈퍼관리자가 다른 회사 소속일 수도 있으므로 본인 users 도큐먼트의 companyId 와 비교.
  const callerSnap = await db.collection("users").doc(request.auth.uid).get();
  const callerCompanyId = callerSnap.exists ? (callerSnap.data() || {}).companyId : null;
  if (callerCompanyId === companyId) {
    throw new HttpsError("permission-denied", "자기 소속 회사는 삭제할 수 없습니다");
  }

  const companyRef = db.collection("companies").doc(companyId);
  const companySnap = await companyRef.get();
  if (!companySnap.exists) {
    throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);
  }

  console.log(`[회사삭제] cid=${companyId} 시작 호출자=${request.auth.uid}`);
  const deletedCount = {};

  // ── 1. 최상위 컬렉션 where companyId==cid (gps/partnerCodes/boardingTokens/passengerTokens/fcmQueue) ──
  // 각 컬렉션은 모두 companyId 필드를 가짐(backend.md 참조). 500개씩 청크 삭제.
  const topLevelTargets = ["gps", "partnerCodes", "boardingTokens", "passengerTokens", "fcmQueue"];
  for (const col of topLevelTargets) {
    try {
      const q = db.collection(col).where("companyId", "==", companyId);
      deletedCount[col] = await deleteQueryInBatches(db, q, col);
    } catch (e) {
      console.error(`[회사삭제] ${col} 삭제 오류: ${e.message}`);
      throw new HttpsError("internal", `${col} 삭제 실패: ${e.message}`);
    }
  }

  // ── 2. gpsHistory/{cid} 하위 전체(recursiveDelete) ──
  // companyId 가 path 첫 segment.
  try {
    await admin.firestore().recursiveDelete(db.doc(`gpsHistory/${companyId}`));
    deletedCount.gpsHistory = 1;
    console.log(`[회사삭제] gpsHistory/${companyId} recursive 완료`);
  } catch (e) {
    // 없으면 무시(멱등).
    console.warn(`[회사삭제] gpsHistory 삭제 경고: ${e.message}`);
    deletedCount.gpsHistory = 0;
  }

  // ── 3. companies/{cid} 하위 전체(routes/stops/dispatches/drivers/vehicles/passengers/boardings/fcmTokens/notices) + 본 문서 ──
  try {
    await admin.firestore().recursiveDelete(companyRef);
    console.log(`[회사삭제] companies/${companyId} recursive 완료`);
  } catch (e) {
    console.error(`[회사삭제] companies recursive 오류: ${e.message}`);
    throw new HttpsError("internal", `companies 삭제 실패: ${e.message}`);
  }

  // ── 4. users where companyId==cid → Auth 계정 + users 도큐먼트 삭제 ──
  let usersDeleted = 0;
  try {
    const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
    for (const uDoc of usersSnap.docs) {
      const uid = uDoc.id;
      // Auth 계정 삭제(이미 없으면 무시 — 멱등).
      await admin.auth().deleteUser(uid).catch((e) => {
        console.warn(`[회사삭제] Auth 계정 삭제 실패(무시) uid=${uid}: ${e.message}`);
      });
      await uDoc.ref.delete().catch((e) => {
        console.warn(`[회사삭제] users 도큐먼트 삭제 실패(무시) uid=${uid}: ${e.message}`);
      });
      usersDeleted++;
    }
    deletedCount.users = usersDeleted;
    console.log(`[회사삭제] users + Auth 계정 ${usersDeleted}건 삭제 완료`);
  } catch (e) {
    console.error(`[회사삭제] users 삭제 오류: ${e.message}`);
    throw new HttpsError("internal", `users 삭제 실패: ${e.message}`);
  }

  // ── 5. (한계 명시) etaDiagnostics 는 companyId 직접 매칭 불가 → skip ──
  // runId 안에 driverId 만 포함되어 companyId 인덱싱 어려움. 진단 데이터·일자별 자연 정리.
  // 후속에서 runId 에 companyId 포함하면 cascade 가능.

  console.log(`[회사삭제] cid=${companyId} 완료 deleted=${JSON.stringify(deletedCount)}`);
  return { ok: true, companyId, deletedCount };
});

// ════════════════════════════════════════════════════════
// SaaS Phase A (2026-05-29) — admin별 협력사 권한 인프라(슈퍼관리자 전용)
//
// 한 회사 안에서 여러 담당자 admin이 각자 자기 협력사만 관리하는 모델.
// users/{uid}.allowedPartnerCodes: string[] 도입
//   - ["*"] = 회사 본부(전체 협력사 접근)
//   - ["code1","code2"] = 특정 협력사 코드 한정
//   - 필드 미존재 = 기존 admin 호환(클라이언트가 ?? ["*"]로 폴백, 마이그 불필요)
//
// 4종:
//   createCompanyAdmin         — Auth + users 동시 생성(rollback 패턴, createCompany 미러)
//   updateCompanyAdminPermissions — allowedPartnerCodes 만 update(다른 필드 보호)
//   deleteCompanyAdmin         — Auth + users 삭제, 자기 삭제 차단
//   listCompanyAdmins          — 회사 단위 admin 목록(allowedPartnerCodes 미존재 시 ["*"] 정규화)
//
// rules/indexes 변경 0 — 전부 Admin SDK 우회. users write 는 이미 superadmin 만.
// Phase B(AdminApp 협력사 필터 자동 적용) 는 별도 — 이 4종은 인프라+관리 UI 한정.
// ════════════════════════════════════════════════════════

/**
 * allowedPartnerCodes 입력 검증(공통 헬퍼).
 * - 배열이어야 함, 각 요소 string(1자 이상).
 * - 빈 배열 허용(어떤 협력사도 접근 못 하는 admin — 유효 케이스).
 * - "*" 가 들어있으면 ["*"] 로 정규화(혼합 입력 방어).
 */
function normalizeAllowedPartnerCodes(input) {
  if (!Array.isArray(input)) {
    throw new HttpsError("invalid-argument", "allowedPartnerCodes는 배열이어야 합니다");
  }
  for (const c of input) {
    if (typeof c !== "string" || c.length === 0) {
      throw new HttpsError("invalid-argument", "allowedPartnerCodes의 각 요소는 비어있지 않은 문자열이어야 합니다");
    }
  }
  if (input.includes("*")) return ["*"];
  // 중복 제거(set).
  return Array.from(new Set(input));
}

exports.createCompanyAdmin = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, empNo, email, name, password, allowedPartnerCodes } = request.data || {};

  // ── 입력 검증 ──
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (typeof empNo !== "string" || !/^[A-Za-z0-9]{1,30}$/.test(empNo)) {
    throw new HttpsError("invalid-argument", "empNo는 1~30자 영숫자여야 합니다");
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new HttpsError("invalid-argument", "이메일 형식이 올바르지 않습니다");
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }
  const nameTrim = typeof name === "string" ? name.trim() : "";
  if (!nameTrim || nameTrim.length > 30) {
    throw new HttpsError("invalid-argument", "이름은 1~30자여야 합니다");
  }
  const allowed = normalizeAllowedPartnerCodes(allowedPartnerCodes);

  const db = admin.firestore();

  // ── companies/{cid} 존재 검증 ──
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) {
    throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);
  }

  const emailTrim = email.trim();

  // ── 1) Auth 계정 생성 ──
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: emailTrim,
      password,
      displayName: nameTrim,
    });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 등록된 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 계정 생성 실패: ${e.message}`);
  }

  // ── 2) users/{newUid} 도큐먼트 생성 ──
  try {
    await db.collection("users").doc(userRecord.uid).set({
      role: "admin",
      companyId,
      empNo,
      email: emailTrim,
      name: nameTrim,
      allowedPartnerCodes: allowed,
    });
  } catch (e) {
    // rollback: Auth 계정 삭제(멱등).
    await admin.auth().deleteUser(userRecord.uid).catch(() => {});
    throw new HttpsError("internal", `users 문서 생성 실패: ${e.message}`);
  }

  console.log(`[관리자추가] cid=${companyId} uid=${userRecord.uid} empNo=${empNo} allowed=${JSON.stringify(allowed)} 호출자=${request.auth.uid}`);
  return { ok: true, uid: userRecord.uid, email: emailTrim };
});

exports.updateCompanyAdminPermissions = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { uid, allowedPartnerCodes } = request.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid가 필요합니다");
  }
  const allowed = normalizeAllowedPartnerCodes(allowedPartnerCodes);

  const db = admin.firestore();
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "사용자를 찾을 수 없습니다");
  }
  const data = snap.data() || {};
  if (data.role !== "admin") {
    throw new HttpsError("failed-precondition", "관리자 계정만 권한 변경 가능합니다");
  }

  // allowedPartnerCodes 필드만 update — 다른 필드(role/companyId/empNo/email/name) 보호.
  await ref.update({ allowedPartnerCodes: allowed });
  console.log(`[관리자권한변경] uid=${uid} allowed=${JSON.stringify(allowed)} 호출자=${request.auth.uid}`);
  return { ok: true, uid, allowedPartnerCodes: allowed };
});

// updateCompanyAdminProfile({uid, name?, email?, password?})
//   특정 uid 의 admin 로그인 정보(이름/이메일/비밀번호) 수정.
//   - updateCompanyAdminInfo 는 companyId 기준(회사 첫 admin 타겟)이라 특정 uid 수정엔 부적합 → 본 함수는 uid 기준.
//   - role/companyId/empNo/allowedPartnerCodes 절대 미변경(권한상승 벡터 차단).
//   - 대상이 role==="admin" 아니면 거부(superadmin/driver 보호).
//   - 자기 자신(uid===request.auth.uid)도 허용(슈퍼관리자가 본인 admin 정보 수정 가능).
exports.updateCompanyAdminProfile = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { uid, name, email, password } = request.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid가 필요합니다");
  }

  const hasName = typeof name === "string" && name.trim().length > 0;
  const hasEmail = typeof email === "string" && email.trim().length > 0;
  const hasPassword = typeof password === "string" && password.length > 0;
  if (!hasName && !hasEmail && !hasPassword) {
    throw new HttpsError("invalid-argument", "이름·이메일·비밀번호 중 최소 1개를 제공해야 합니다");
  }

  // ── 필드별 검증(제공된 것만) ──
  const nameTrim = hasName ? name.trim() : null;
  if (hasName && nameTrim.length > 30) {
    throw new HttpsError("invalid-argument", "이름은 1~30자여야 합니다");
  }
  const emailTrim = hasEmail ? email.trim() : null;
  if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
    throw new HttpsError("invalid-argument", "이메일 형식이 올바르지 않습니다");
  }
  if (hasPassword && password.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }

  const db = admin.firestore();
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "사용자를 찾을 수 없습니다");
  }
  const data = snap.data() || {};
  // role==="admin" 아니면 거부(superadmin/driver 보호·권한상승 차단).
  if (data.role !== "admin") {
    throw new HttpsError("failed-precondition", "관리자 계정만 정보 수정 가능합니다");
  }

  // ── 변경 제공된 것만 patch 구성 ──
  const authPatch = {};
  const userDocPatch = {};
  if (hasName) {
    authPatch.displayName = nameTrim;
    userDocPatch.name = nameTrim;
  }
  if (hasEmail) {
    authPatch.email = emailTrim;
    userDocPatch.email = emailTrim;
  }
  if (hasPassword) {
    authPatch.password = password;
  }

  // ── Auth 정보 변경(rules 우회) ──
  try {
    await admin.auth().updateUser(uid, authPatch);
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 사용 중인 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 정보 변경 실패: ${e.message}`);
  }

  // ── users 도큐먼트 update(name/email 만 — role/companyId/empNo/allowedPartnerCodes 미변경) ──
  if (Object.keys(userDocPatch).length > 0) {
    try {
      await ref.update(userDocPatch);
    } catch (e) {
      // Auth 는 이미 변경됨 — 비치명적, 경고만.
      console.warn(`[관리자정보수정] users 도큐먼트 update 실패 uid=${uid}: ${e.message}`);
    }
  }

  console.log(`[관리자정보수정] uid=${uid} cid=${data.companyId || "?"} 변경=${JSON.stringify(Object.keys(authPatch))} 호출자=${request.auth.uid}`);
  return {
    ok: true,
    uid,
    name: hasName ? nameTrim : null,
    email: hasEmail ? emailTrim : null,
    passwordChanged: hasPassword,
  };
});

exports.deleteCompanyAdmin = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { uid } = request.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid가 필요합니다");
  }
  // ── 자기 삭제 차단(이중 안전망, 클라 카드 disabled + 여기서도 거부) ──
  if (uid === request.auth.uid) {
    throw new HttpsError("permission-denied", "자기 자신은 삭제할 수 없습니다");
  }

  const db = admin.firestore();
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "사용자를 찾을 수 없습니다");
  }
  const data = snap.data() || {};
  if (data.role !== "admin") {
    throw new HttpsError("failed-precondition", "관리자 계정만 삭제 가능합니다");
  }

  // Auth 계정 삭제(이미 없으면 무시 — 멱등).
  await admin.auth().deleteUser(uid).catch((e) => {
    console.warn(`[관리자삭제] Auth 계정 삭제 실패(무시) uid=${uid}: ${e.message}`);
  });
  await ref.delete();

  console.log(`[관리자삭제] uid=${uid} cid=${data.companyId || "?"} 호출자=${request.auth.uid}`);
  return { ok: true, uid };
});

exports.listCompanyAdmins = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }

  const db = admin.firestore();
  // 회사 존재 검증(없는 회사의 admin 목록 요청은 오용).
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) {
    throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);
  }

  const snap = await db.collection("users")
    .where("companyId", "==", companyId)
    .where("role", "==", "admin")
    .get();

  const admins = snap.docs.map(d => {
    const v = d.data() || {};
    // 빈 배열([])은 "전체 해제·특정 협력사 0개"인 유효 상태이므로 그대로 보존한다.
    // ["*"] 폴백은 필드 자체가 부재(레거시 admin)일 때만 — partnerAccess.resolveAllowed 와 동일 규칙.
    // ⚠ length>0 검사로 []를 ["*"]로 바꾸면 "전체 해제 저장이 안 먹힘" 회귀 발생(2026-06-15 수정).
    const allowed = Array.isArray(v.allowedPartnerCodes)
      ? v.allowedPartnerCodes
      : ["*"];
    return {
      uid: d.id,
      empNo: v.empNo || "",
      email: v.email || "",
      name: v.name || "",
      allowedPartnerCodes: allowed,
    };
  });

  // 이름순 정렬(클라 UI 안정).
  admins.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return { companyId, admins };
});

// ════════════════════════════════════════════════════════
// 기사 등록
// ════════════════════════════════════════════════════════
exports.createDriver = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId, name, empNo, pin, vehicleId, vehicleNo, phone } = request.data;
  const email = `${empNo}@buslink.com`;
  try {
    const userRecord = await admin.auth().createUser({ email, password: pin, displayName: name });
    const driverRef = await admin.firestore()
      .collection("companies").doc(companyId).collection("drivers").add({
        name, empNo, vehicleId: vehicleId || "", vehicleNo: vehicleNo || "",
        phone: phone || "", uid: userRecord.uid, status: "대기", createdAt: new Date().toISOString(),
        createdBy: request.auth.uid,
      });
    await admin.firestore().collection("users").doc(userRecord.uid).set({
      role: "driver", companyId, empNo, name,
    });
    return { success: true, driverId: driverRef.id, uid: userRecord.uid };
  } catch (e) {
    if (e.code === "auth/email-already-exists")
      throw new HttpsError("already-exists", "이미 등록된 사번입니다");
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// 기사 삭제
// ════════════════════════════════════════════════════════
exports.deleteDriver = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId, driverId, uid } = request.data;
  try {
    if (uid) await admin.auth().deleteUser(uid);
    await admin.firestore()
      .collection("companies").doc(companyId).collection("drivers").doc(driverId).delete();
    if (uid) await admin.firestore().collection("users").doc(uid).delete().catch(() => {});
    return { success: true };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// 기사 비밀번호 변경
// ════════════════════════════════════════════════════════
exports.updateDriverPassword = onCall(async (request) => {
  await assertAdmin(request);
  const { uid, newPassword } = request.data;
  if (!uid || !newPassword) throw new HttpsError("invalid-argument", "uid와 newPassword가 필요합니다");
  if (newPassword.length < 6) throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  try {
    await admin.auth().updateUser(uid, { password: newPassword });
    return { success: true };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// 기존 기사에 Auth 계정 생성
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// 배차 일정 자동 펼침
// dispatchSchedules → 매일 새벽 KST 00:30 향후 7일치 dispatches 생성 (멱등 ID)
// 즉시 펼침: AdminApp 운영자가 onCall expandDispatchSchedulesNow 호출
// ════════════════════════════════════════════════════════

const LOOKAHEAD_DAYS = 7; // 오늘 + 6일 = 7일치(안전 마진)

/**
 * 'YYYY-MM-DD' string 을 KST 기준 yyyy-mm-dd / dayOfWeek(일=0~토=6) 로 반환.
 * Date 객체를 직접 만들지 않고 KST formatter 로만 처리(서버 UTC 영향 차단).
 */
function ymdKST(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}
function dayOfWeekKST(dateStr) {
  // 🔴 `getDay()` 는 **서버 로컬 시간대**로 요일을 계산한다. Cloud Functions 는 UTC 로 돌기
  //   때문에 KST 자정(=전날 15:00 UTC)의 `getDay()` 는 **하루 전 요일**을 돌려준다.
  //   그 결과 월요일 일정이 화요일에 펼쳐지고, 월요일에는 배차가 아예 안 생겼다
  //   (2026-07-27 "배차일정 등록 후 하루밀림" 신고의 근인. prod 실측: 토요일에 평일 배차
  //   29건 생성 / 월요일 0건).
  //   날짜 문자열의 요일은 시간대와 무관한 **달력 계산**이므로 UTC 자정 + getUTCDay 로 고정한다.
  //   ⚠ `getDay()` 로 되돌리지 말 것(동일 결함 재발).
  const dt = new Date(`${dateStr}T00:00:00Z`);
  return dt.getUTCDay(); // 0=일 ... 6=토
}

/**
 * 한 schedule + day 가 펼침 대상인지 판정.
 */
function shouldExpand(schedule, day) {
  if (schedule.startDate && day < schedule.startDate) return false;
  if (schedule.endDate && day > schedule.endDate) return false;
  if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return false;
  const dow = dayOfWeekKST(day);
  if (!schedule.weekdays.includes(dow)) return false;
  if (Array.isArray(schedule.excludeDates) && schedule.excludeDates.includes(day)) return false;
  if (schedule.excludeHolidays !== false && HOLIDAY_SET.has(day)) return false;
  return true;
}

/**
 * 단일 회사 전체 schedule 펼침. 멱등 dispatchId = `${scheduleId}_${day}`.
 * exists() 시 skip(일별 수정 보존). 결과 카운트 반환.
 */
async function expandCompany(companyId) {
  const db = admin.firestore();
  const today = new Date();
  const days = [];
  for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    days.push(ymdKST(d));
  }

  const schedSnap = await db
    .collection("companies").doc(companyId)
    .collection("dispatchSchedules")
    .where("active", "==", true)
    .get();

  let created = 0, skipped = 0;
  for (const sdoc of schedSnap.docs) {
    const schedule = sdoc.data();
    const scheduleId = sdoc.id;
    for (const day of days) {
      if (!shouldExpand(schedule, day)) continue;
      const dispatchId = `${scheduleId}_${day}`;
      const dispRef = db
        .collection("companies").doc(companyId)
        .collection("dispatches").doc(day)
        .collection("list").doc(dispatchId);
      const existing = await dispRef.get();
      if (existing.exists) { skipped++; continue; }
      await dispRef.set({
        driverId: schedule.driverId || "",
        driverName: schedule.driverName || "",
        routeId: schedule.routeId || "",
        routeName: schedule.routeName || "",
        vehicleNo: schedule.vehicleNo || "",
        vehicleId: schedule.vehicleId || "",
        departTime: schedule.departTime || "",
        date: day,
        scheduleId,
        source: "schedule",
        createdAt: new Date().toISOString(),
      });
      created++;
    }
  }
  return { companyId, schedules: schedSnap.size, created, skipped };
}

/**
 * 전체 회사 펼침. companies 컬렉션 순회(현재 dy001 1개지만 멀티테넌트 대비).
 */
async function expandAllCompanies() {
  const companiesSnap = await admin.firestore().collection("companies").get();
  const results = [];
  for (const c of companiesSnap.docs) {
    try {
      results.push(await expandCompany(c.id));
    } catch (e) {
      console.error(`[펼침] 회사 ${c.id} 오류:`, e.message);
      results.push({ companyId: c.id, error: e.message });
    }
  }
  return results;
}

// 매일 KST 00:30 자동 펼침
exports.expandDispatchSchedules = onSchedule(
  {
    schedule: "30 0 * * *",
    timeZone: "Asia/Seoul",
    region: "us-central1",
  },
  async () => {
    console.log("[배차펼침] 자동 트리거 시작");
    const results = await expandAllCompanies();
    console.log("[배차펼침] 완료:", JSON.stringify(results));
  }
);

// 운영자 즉시 펼침 — AdminApp "지금 펼치기" 버튼
exports.expandDispatchSchedulesNow = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId } = request.data || {};
  if (!companyId) throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  console.log(`[배차펼침] 즉시 트리거 회사=${companyId} 호출자=${request.auth.uid}`);
  try {
    const result = await expandCompany(companyId);
    return { success: true, ...result };
  } catch (e) {
    console.error("[배차펼침] 즉시 오류:", e.message);
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// ETA 자동 진단 조회 — 슈퍼관리자 전용(2026-05-29)
//
// etaDiagnostics/{date}/runs/{runId}/points 컬렉션을 부모(개발자)가
// gcloud/ADC 없이도 회수할 수 있도록 한 임시 진단 채널.
// 슈퍼관리자가 AdminApp 회사 관리 탭의 진단 조회 카드에서 호출 →
// JSON 텍스트로 노출 → 사용자가 복사해 채팅에 붙여넣어 부모가 분석.
//
// 보안: assertSuperAdmin 강제. Admin SDK 사용으로 firestore.rules 무관.
//
// 입력: { date?: "YYYY-MM-DD" KST, runId?: string }
// 반환:
//   runId 없을 때 → { date, runIds: string[] } (선택 드롭다운용)
//   runId 있을 때 → { date, runId, count, points: [{ id, ...point }] } (tsMs asc)
// ════════════════════════════════════════════════════════
exports.fetchEtaDiagnostic = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { date: dateInput, runId } = request.data || {};

  // 기본 날짜 = 오늘(KST). 입력 형식은 "YYYY-MM-DD" 만 허용.
  const date = (typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput))
    ? dateInput
    : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

  const db = admin.firestore();
  const runsCol = db.collection("etaDiagnostics").doc(date).collection("runs");

  // runId 미지정 → 그 날짜의 run 도큐먼트 ID 목록만 반환.
  // 문서 자체에 필드가 없을 수 있으므로 listDocuments() 사용(빈 문서 ID도 회수).
  if (!runId) {
    const runDocs = await runsCol.listDocuments();
    const runIds = runDocs.map(d => d.id).sort();
    console.log(`[진단조회] date=${date} runs=${runIds.length} 호출자=${request.auth.uid}`);
    return { date, runIds };
  }

  // runId 지정 → points 컬렉션 전체 조회(tsMs asc).
  // V1: 페이징 없이 전체 반환. 운행 1회당 ≤300 도큐먼트(30초 throttle × 시간) 전제.
  const pointsSnap = await runsCol.doc(runId).collection("points").orderBy("tsMs", "asc").get();
  const points = pointsSnap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      tsMs: data.tsMs ?? null,
      source: data.source ?? null,
      vehiclePos: data.vehiclePos ?? null,
      vehicleSpeed: data.vehicleSpeed ?? null,
      busProgress: data.busProgress ?? null,
      nextStopProgress: data.nextStopProgress ?? null,
      nextIdx: typeof data.nextIdx === "number" ? data.nextIdx : -1,
      estimates: Array.isArray(data.estimates) ? data.estimates : [],
      // 2026-06-08 — 빌드 식별·도착기록 결과 진단에 필수(이전엔 누락돼 깜깜이였음).
      appVersion: data.appVersion ?? null, // 폰 빌드 확인(옛 캐시 vs 신빌드)
      stopArrivalsLog: Array.isArray(data.stopArrivalsLog) ? data.stopArrivalsLog : null, // recordStopArrival 호출 ok/error/code
      allStopProgress: Array.isArray(data.allStopProgress) ? data.allStopProgress : null, // 정류장 routePath 투영값(감지 실패 근인 판별)
    };
  });

  console.log(`[진단조회] date=${date} runId=${runId} points=${points.length} 호출자=${request.auth.uid}`);
  return { date, runId, count: points.length, points };
});

// ════════════════════════════════════════════════════════════════
//  RQ/20260708 #2 — 유비칸 GPS 단말(busin.co.kr) 연동
//  차량별 위치 신호 방식: 📱 모바일 앱(기존 기사앱 startGPS) / 🛰️ GPS 단말(busin 서버 폴링).
//  ─────────────────────────────────────────────────────────────
//  busin GPS API (callcenter functions/index.js 정본에서 이식 — URL·파싱 로직 동일):
//   편성(번호→carId): GET https://dr.busin.co.kr:4431/api/CarAlloc.aspx?drv=1
//                     컬럼 기사명 / 차량번호 / 차량ID
//   위경도:           GET https://dr.busin.co.kr/api/CarLocationAll.aspx?carid=X&date=YYYY-MM-DD
//                     컬럼 일시 / 위도 / 경도 (HTML <table>)
//   인증 키 없음. CORS·cert chain 비표준 → 서버사이드 node fetch 만.
//
//  device 차량은 gps/{cid}_{vehicleId} 문서를 sendGPS(lib/gps.js) 와 동일 형태로 서버가
//  써서 관제(MapTab)·승객앱·직원앱이 코드 변경 0 으로 표시(gps 문서 계약 동일).
// ════════════════════════════════════════════════════════════════

/** HTTP/HTTPS GET → string (UTF-8). busin cert chain 비표준 대비 rejectUnauthorized:false. */
function fetchBusinHTML(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      timeout: 15000,
      rejectUnauthorized: false,
      headers: {
        "User-Agent": "Mozilla/5.0 (BuslinkOps Cloud Functions)",
        "Accept": "text/html,application/xhtml+xml",
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} — ${urlStr}`));
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout: " + urlStr)); });
    req.end();
  });
}

/** HTML <table> → 객체 배열 (헤더 행을 키로 사용). ASP.NET WebForm GridView 구조. */
function parseBusinTable(html) {
  if (!html) return [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const trList = [];
  let m;
  while ((m = trRe.exec(html)) !== null) trList.push(m[1]);
  if (!trList.length) return [];

  const stripHTML = (s) => String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#[0-9]+;/g, "")
    .trim();
  const extractCells = (trInner, tag) => {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
    const out = []; let m2;
    while ((m2 = re.exec(trInner)) !== null) out.push(m2[1]);
    return out;
  };

  let headers = null, dataStart = 0;
  for (let i = 0; i < trList.length; i++) {
    const ths = extractCells(trList[i], "th");
    if (ths.length) { headers = ths.map(stripHTML); dataStart = i + 1; break; }
  }
  if (!headers) {
    const tds = extractCells(trList[0], "td");
    if (tds.length) { headers = tds.map(stripHTML); dataStart = 1; }
  }
  if (!headers) return [];

  const rows = [];
  for (let i = dataStart; i < trList.length; i++) {
    const tds = extractCells(trList[i], "td");
    if (!tds.length) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = idx < tds.length ? stripHTML(tds[idx]) : ""; });
    rows.push(obj);
  }
  return rows;
}

const CAR_ALLOC_URL = "https://dr.busin.co.kr:4431/api/CarAlloc.aspx?drv=1";
const CAR_LOC_URL   = (carId, date) => `https://dr.busin.co.kr/api/CarLocationAll.aspx?carid=${encodeURIComponent(carId)}&date=${encodeURIComponent(date)}`;

/** 운행편성 → [{ name, plate, carId }] (활성/만료 무관, 매핑은 호출측). */
async function fetchCarAllocations() {
  const html = await fetchBusinHTML(CAR_ALLOC_URL);
  const rows = parseBusinTable(html);
  const out = [];
  rows.forEach(r => {
    const name  = r["기사명"] || "";
    const plate = r["차량번호"] || "";
    const carId = r["차량ID"] || r["차량Id"] || "";
    if (!name || !carId) return;
    out.push({ name: name.trim(), plate: plate.trim(), carId: String(carId).trim() });
  });
  return out;
}

/** 차량 GPS 행 → [{ time, lat, lng }] (시간 오름차순, lat/lng 0인 행 제외). */
async function fetchVehicleLocations(carId, dateStr) {
  const html = await fetchBusinHTML(CAR_LOC_URL(carId, dateStr));
  const rows = parseBusinTable(html);
  const out = [];
  rows.forEach(r => {
    const t   = r["일시"] || r["시각"] || r["기준일시"] || "";
    const lat = parseFloat(r["위도"] || r["lat"] || "0");
    const lng = parseFloat(r["경도"] || r["lng"] || "0");
    if (!t) return;
    if (!lat || !lng || lat === 0 || lng === 0) return;
    out.push({ time: t.trim(), lat, lng });
  });
  // "YYYY-MM-DD HH:mm:ss" 또는 "HH:mm:ss" 등 다양 — 문자열 정렬로 시각 순서 유지(같은 날짜 가정).
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}

/** GPS 시각 문자열에서 HH:mm 추출 — busin 한국어 12시간제("오전 12:00"=자정) 우선 파싱.
 *  callcenter extractHHMM 정본 이식. 24시간제 fallback(legacy). */
function extractHHMM(timeStr) {
  if (!timeStr) return "";
  const s = String(timeStr);
  const k = s.match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (k) {
    let h = parseInt(k[2], 10);
    if (k[1] === "오전") { if (h === 12) h = 0; }
    else                 { if (h !== 12) h += 12; }
    return `${String(h).padStart(2, "0")}:${k[3]}`;
  }
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** "HH:mm" → 분(number) 또는 null. */
function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** busin 좌표 시각 문자열 → epoch ms(KST 해석). 못 구하면 null.
 *  실제 형식: `"2026-08-18 오전 12:00:43"`(오전 12시 = 자정) · 날짜가 없으면 dateStr 로 보완.
 *  🔴 초까지 살린다 — 운행 이력에 남길 `ts` 가 이 값이다(폴 시각이 아니라 **측정 시각**). */
function parseBusinFixMs(timeStr, dateStr) {
  const s = String(timeStr || "");
  const dm = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  const dstr = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : String(dateStr || "");
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dstr);
  if (!d) return null;
  let h = null, mi = null, sec = 0;
  const k = s.match(/(오전|오후)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (k) {
    h = parseInt(k[2], 10);
    if (k[1] === "오전") { if (h === 12) h = 0; } else if (h !== 12) h += 12;
    mi = parseInt(k[3], 10);
    sec = k[4] ? parseInt(k[4], 10) : 0;
  } else {
    // 24시간제 fallback — 날짜 부분의 숫자를 시각으로 오독하지 않게 날짜를 떼고 찾는다.
    const rest = dm ? s.slice(s.indexOf(dm[0]) + dm[0].length) : s;
    const t = rest.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!t) return null;
    h = parseInt(t[1], 10); mi = parseInt(t[2], 10); sec = t[3] ? parseInt(t[3], 10) : 0;
  }
  if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60 && sec >= 0 && sec < 60)) return null;
  // KST(UTC+9) 로 해석
  return Date.UTC(+d[1], +d[2] - 1, +d[3], h - 9, mi, sec);
}

/** gpsHistory 에 새로 적재할 좌표 행 고르기(순수).
 *  - `lastFixMs` 이후 행만 — 이미 적재한 것을 다시 쓰지 않는다(같은 좌표 2배 적재 차단).
 *  - 워터마크가 없으면(운행 시작 직후·gps 문서가 정리된 뒤) **최근 backfillMin 분** 만.
 *    🔴 통째 backfill 하지 않는 이유 = 운행 창 밖(차고지 주차) 좌표까지 이력에 들어온다.
 *  - 같은 초에 여러 행이 오면 하나만(문서 ID 가 초 단위라 어차피 덮어쓴다). */
function selectNewFixRows(rows, lastFixMs, nowMs, backfillMin = 15) {
  const floor = typeof lastFixMs === "number" && Number.isFinite(lastFixMs)
    ? lastFixMs
    : nowMs - backfillMin * 60 * 1000;
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.ms !== "number" || !Number.isFinite(r.ms)) continue;
    if (r.ms <= floor) continue;
    if (r.ms > nowMs + 60 * 1000) continue; // 미래 시각 행은 버린다(원천 오류)
    const sec = Math.floor(r.ms / 1000);
    if (seen.has(sec)) continue;
    seen.add(sec);
    out.push(r);
  }
  return out.sort((a, b) => a.ms - b.ms);
}

// ════════════════════════════════════════════════════════════════
// 서버측 정류장 도착감지 유틸 (device 차량 — pollDeviceVehicleGps 에서 사용).
// 모바일 lib/gps.js 와 동일한 100m 도착 반경·좌표 coercion 을 서버에 재현.
// ════════════════════════════════════════════════════════════════

// 정류장 도착 판정 반경(m) — 모바일 gps.js STOP_ARRIVE_M 과 동일값.
const STOP_ARRIVE_M = 100;

/** haversine 거리(m). 6371000 = 지구 반경. */
function distMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 정류장 lat/lng 다중 형식(number/string/GeoPoint/{location:GeoPoint}) → {lat,lng} 또는 null.
 *  issues.md `stops lat/lng 다중 형식` 함정 — typeof==="number" 엄격 필터 금지. */
function stopLatLng(s) {
  if (!s) return null;
  const rawLat = s.lat ?? s.latitude ?? (s.location && s.location.latitude) ?? s._latitude;
  const rawLng = s.lng ?? s.longitude ?? (s.location && s.location.longitude) ?? s._longitude;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

/** 노선 departTime("HH:MM") + 정류장 offsetMin(분) → 계획 도착시각 "HH:MM" 또는 null. */
function planTimeFromDepart(departTime, offsetMin) {
  const dm = hhmmToMinutes(departTime);
  if (dm === null || typeof offsetMin !== "number" || !isFinite(offsetMin)) return null;
  let pm = dm + Math.round(offsetMin);
  if (pm < 0) return null;
  pm = ((pm % 1440) + 1440) % 1440; // 자정 넘김 방어(통근 모델상 드묾)
  const h = Math.floor(pm / 60);
  const mi = pm % 60;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** 회사·노선 메타(departTime + 좌표 유효 정류장) lazy 로드·캐시.
 *  반환 { departTime, stops:[{id,name,lat,lng,offsetMin,order}] } 또는 null(로드 실패). */
async function loadRouteMeta(db, cid, routeId, cache) {
  if (!routeId) return null;
  const key = `${cid}__${routeId}`;
  if (key in cache) return cache[key];
  let meta = null;
  try {
    const rSnap = await db
      .collection("companies").doc(cid)
      .collection("routes").doc(routeId).get();
    const rv = rSnap.exists ? (rSnap.data() || {}) : {};
    const stopsSnap = await db
      .collection("companies").doc(cid)
      .collection("routes").doc(routeId)
      .collection("stops").orderBy("order").get();
    const stops = [];
    stopsSnap.docs.forEach(sd => {
      const sv = sd.data() || {};
      const ll = stopLatLng(sv);
      if (!ll) return; // 좌표 무효 정류장 제외
      stops.push({
        id: sd.id,
        name: sv.name || "",
        lat: ll.lat,
        lng: ll.lng,
        offsetMin: typeof sv.offsetMin === "number" ? sv.offsetMin : null,
        order: typeof sv.order === "number" ? sv.order : null,
      });
    });
    // displayStart/End = 관리자가 노선에 직접 넣은 표시 시간(2026-08-05). computeGpsWindow 가
    // 이걸 최우선으로 본다 — 빠뜨리면 폴러만 파생 창을 쓰게 돼 표시와 수집이 어긋난다.
    meta = { departTime: rv.departTime || "", displayStart: rv.displayStart || "", displayEnd: rv.displayEnd || "", stops };
  } catch (e) {
    console.error(`[단말도착] 노선 로드 오류 cid=${cid} route=${routeId}:`, e.message);
    meta = null;
  }
  cache[key] = meta;
  return meta;
}

// ─── GPS 수신 시간 창 (device 차량 — pollDeviceVehicleGps 에서 사용) ───
// device(유비칸 GPS 단말)는 상시신호라 기사 운행 시작/종료(mobile) 같은 수동 on/off 가 없다.
// 노선 시간표(departTime + 정류장 offsetMin)에서 운행 시간 창을 자동 도출해, 그 밖의 시각에
// 들어오는 좌표(퇴근 후 개인 운전 등)를 관제/승객앱에서 차단한다. 15분 신선도 가드는 '정차'
// 차량만 걸러내지 '운행시간 밖 이동' 은 못 걸러 이 게이트가 보완.
// 창 = [departTime − PRE, (departTime + 마지막 정류장 offset) + POST]. 운영자는 노선 출발시각·
// 정류장 offsetMin(노선설정) 으로 이 창을 통제한다(별도 입력 필드 불필요).
const GPS_WINDOW_PRE_MIN = 30;              // 출발 전 여유(예열·조기 출발)
const GPS_WINDOW_POST_MIN = 30;             // 마지막 정류장 도착 후 여유 — 2026-07-16 회의 결정 30/30
const GPS_WINDOW_DEFAULT_DURATION_MIN = 120; // 정류장 offsetMin 이 전무할 때 기본 운행 소요

/** 노선 메타 → GPS 수신 허용 분(minute-of-day) 창 { startMin, endMin } 또는 null.
 *  null = 게이트 없음(관대한 폴백): meta 부재/로드실패 또는 departTime 미설정 시.
 *  → 노선에 출발시각을 넣기 전(레거시)에는 기존 동작(항상 허용, 신선도만) 그대로. */
function computeGpsWindow(meta, opts) {
  if (!meta) return null;

  // ① 관리자가 노선에 직접 넣은 표시 시간이 최우선(2026-08-05 회의 #2·#3).
  //    하루 4~6회 도는 노선(온세미 등)은 파생 창이 첫 회차 뒤 닫혀 오후 좌표가 통째로
  //    끊긴다 → 여기서도 명시 창을 존중해야 표시(클라)와 수집(폴러)이 어긋나지 않는다.
  //    ⚠ 클라 미러 = src/lib/routeWindow.js computeRouteWindow. 한쪽만 고치지 말 것.
  const es = hhmmToMinutes(meta.displayStart);
  const ee = hhmmToMinutes(meta.displayEnd);
  if (es !== null && ee !== null) return { startMin: es, endMin: ee };

  const dep = hhmmToMinutes(meta.departTime);
  if (dep === null) return null; // 출발시각 미설정 → 시간창 게이트 없음
  const pre = Number.isFinite(opts?.preMin) ? opts.preMin : GPS_WINDOW_PRE_MIN;
  const post = Number.isFinite(opts?.postMin) ? opts.postMin : GPS_WINDOW_POST_MIN;
  let maxOffset = 0;
  for (const st of (meta.stops || [])) {
    if (typeof st.offsetMin === "number" && isFinite(st.offsetMin) && st.offsetMin > maxOffset) {
      maxOffset = st.offsetMin;
    }
  }
  const span = maxOffset > 0 ? maxOffset : GPS_WINDOW_DEFAULT_DURATION_MIN;
  let startMin = dep - pre;
  let endMin = dep + span + post;
  if (startMin < 0) startMin = 0;          // 자정 이전 클램프
  if (endMin > 1439) endMin = 1439;        // 자정 넘김 클램프(그날 끝까지 허용)
  return { startMin, endMin };
}

/** 창 안 판정 — end < start 면 자정을 넘긴 창(예 22:00~02:00). 창 null 이면 항상 허용. */
function gpsWindowContains(win, nowMin) {
  if (!win) return true;
  if (win.startMin <= win.endMin) return nowMin >= win.startMin && nowMin <= win.endMin;
  return nowMin >= win.startMin || nowMin <= win.endMin;
}

/** 회사 문서 → { preMin, postMin }. 클라 normalizeWindowOpts 미러. */
function normalizeGpsWindowOpts(company) {
  const pick = (v, dflt) => {
    const n = Number(v);
    return isFinite(n) && n >= 0 && n <= 240 ? n : dflt;
  };
  return {
    preMin: pick(company && company.gpsWindowPreMin, GPS_WINDOW_PRE_MIN),
    postMin: pick(company && company.gpsWindowPostMin, GPS_WINDOW_POST_MIN),
  };
}

/** 오늘 여러 회차가 잡힌 차량에서 **지금 운행 중인** 배차 1건 선택 → { disp, meta } 또는 null.
 *
 *  통근/통학 차량은 한 대가 등교(오전)·하교(오후)를 모두 뛴다. 예전에는 vehicleId 를 키로 한
 *  맵에 배차를 덮어써(last-wins) **문서 ID 순으로 마지막 1건만** 남겼고, 그 1건의 노선 시간창
 *  으로만 판정해 나머지 회차는 좌표가 통째로 차단됐다(오전 관제 실종). 그래서 후보 전체를 보고
 *  **현재 시각이 시간창 안에 드는 회차**를 고른다. 창이 겹치면 출발시각이 지금에 가까운 쪽
 *  (정적 QR `resolveStaticDispatchAdmin` 의 다중 회차 선택과 같은 규칙).
 *
 *  🔴 departTime 미설정 노선(win=null=게이트 없음)은 **폴백으로만** 채택한다 — 시간창이 실제로
 *  맞는 회차가 있으면 그쪽이 우선. 게이트 없는 회차가 다른 회차의 운행 시간을 가로채면 안 된다. */
async function pickActiveDispatch(db, cid, candidates, nowMin, cache, winOpts) {
  let ungated = null;                       // 게이트 없는 회차(레거시 관대 폴백)
  let best = null, bestDist = Infinity;
  for (const disp of candidates) {
    const meta = await loadRouteMeta(db, cid, disp.routeId, cache);
    const win = computeGpsWindow(meta, winOpts);
    if (!win) {                             // departTime 미설정 → 기존 동작(항상 허용) 보존
      if (!ungated) ungated = { disp, meta };
      continue;
    }
    if (!gpsWindowContains(win, nowMin)) continue;
    const dep = hhmmToMinutes(meta.departTime);
    const dist = Math.abs((dep === null ? win.startMin : dep) - nowMin);
    if (dist < bestDist) { best = { disp, meta }; bestDist = dist; }
  }
  return best || ungated;
}

// 창 밖/미배차 device 차량의 잔존 gps 문서 삭제 — mobile clearGPS(운행 종료 버튼) 대응물.
// device 단말은 종료 버튼이 없어 문서가 영구 잔존 → 직원앱 노선탭 "N대 운행중"·홈탭 마커가
// 운행 전/후에도 계속 표시되던 결함(2026-07-16 회의 #2). source==="device" 인 문서만 삭제
// (mobile 문서 오삭제 방지 — 기사앱 운행 중 차량 보호). 문서 없으면 no-op(read 1회).
async function cleanupDeviceGpsDoc(db, companyId, vehicleId) {
  try {
    const ref = db.collection("gps").doc(`${companyId}_${vehicleId}`);
    const snap = await ref.get();
    if (snap.exists && (snap.data() || {}).source === "device") await ref.delete();
  } catch (e) {
    console.warn(`[pollDeviceVehicleGps] gps 문서 정리 실패(${companyId}_${vehicleId}): ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
// resolveBusinCarId (onCall) — 차량번호 → busin carId 조회.
// AdminApp 차량 등록/수정 폼의 "번호로 carId 조회" 버튼이 호출.
// assertAdmin + { vehicleNo } → CarAlloc fetch·parse·번호 정규화(공백/하이픈 제거) 매칭.
// 미매칭 시 { carId: null } (경고 표시용). 실패는 한국어 HttpsError.
// ════════════════════════════════════════════════════════════════
exports.resolveBusinCarId = onCall(async (request) => {
  await assertAdmin(request);
  const { vehicleNo } = request.data || {};
  if (!vehicleNo || typeof vehicleNo !== "string") {
    throw new HttpsError("invalid-argument", "차량번호가 필요합니다");
  }
  const norm = (s) => String(s || "").replace(/[\s-]/g, "");
  const target = norm(vehicleNo);
  if (!target) throw new HttpsError("invalid-argument", "차량번호가 비어있습니다");

  let allocs;
  try {
    allocs = await fetchCarAllocations();
  } catch (e) {
    throw new HttpsError("unavailable", `busin 운행편성 조회 실패: ${e.message}`);
  }
  const match = allocs.find(a => norm(a.plate) === target);
  if (!match) {
    console.log(`[carId조회] vehicleNo=${vehicleNo} 미매칭(편성 ${allocs.length}건) 호출자=${request.auth.uid}`);
    return { carId: null };
  }
  console.log(`[carId조회] vehicleNo=${vehicleNo} → carId=${match.carId} name=${match.name}`);
  return { carId: match.carId, name: match.name };
});

// ════════════════════════════════════════════════════════════════
// pollDeviceVehicleGps (onSchedule, 매 1분 KST) — GPS 단말 차량 위치 서버 폴링.
//
// companies 순회 → 각 회사 vehicles where gpsSource=="device"(+ carId 존재) →
// 오늘(KST) 배차 맵으로 routeId/routeName/driver 확보 → busin 최신 좌표를
// gps/{cid}_{vehicleId} 문서에 sendGPS 동일 필드로 write(관제·승객앱 자동 표시).
//
// 가드:
//  · 운행 시간 창(computeGpsWindow): 노선 departTime+정류장 offsetMin 에서 창 도출,
//    현재 시각이 창 밖이면 skip(상시신호 단말이 운행 전/후 이동해도 표시 안 함).
//    노선 departTime 미설정이면 게이트 없음(기존 동작 보존).
//  · 신선도: 최신 좌표 시각이 KST 현재 대비 15분 초과 과거면 skip(주차·미운행 차량이
//    어제 마지막 위치로 계속 fresh 뜨는 것 차단 — 이게 없으면 승객앱이 오도됨).
//  · 오늘 배차 없으면 skip(routeId 없으면 승객앱 표시 불가 = 미운행 취급).
//  · 좌표 0건 skip.
//  · 회사별/차량별 try/catch — 한 차량 실패가 전체 폴러를 죽이지 않게.
//
// speed 는 0(busin 미제공 — 승객앱 useAnimatedPositions 가 보간하므로 무방).
// ════════════════════════════════════════════════════════════════
exports.pollDeviceVehicleGps = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "Asia/Seoul",
    region: "us-central1",
  },
  async () => {
    const db = admin.firestore();
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
    // KST 현재 분 — UTC + 9h 후 UTC 필드 사용(host-local Date 금지).
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();

    const companiesSnap = await db.collection("companies").get();
    let targets = 0, written = 0, skipped = 0;

    for (const c of companiesSnap.docs) {
      const cid = c.id;
      // 회사 도착 감지 반경(companies/{cid}.stopArriveRadiusM). 미설정/비정상=100m(STOP_ARRIVE_M).
      // 모바일 gps.js 와 동일 설정값을 서버 감지에도 적용(단말/유비칸 차량).
      const arriveRadius = (() => {
        const v = (c.data() || {}).stopArriveRadiusM;
        return (typeof v === "number" && isFinite(v) && v > 0) ? v : STOP_ARRIVE_M;
      })();
      // 회사 기본 표시 범위(2026-08-05) — 노선에 '표시 시간'이 없을 때 쓰는 ±분.
      // 승객앱 표시 게이트(src/lib/routeWindow.js)와 같은 값을 써야 두 쪽이 어긋나지 않는다.
      const winOpts = normalizeGpsWindowOpts(c.data() || {});
      try {
        const vehSnap = await db
          .collection("companies").doc(cid)
          .collection("vehicles")
          .where("gpsSource", "==", "device")
          .get();
        if (vehSnap.empty) continue;

        // 오늘 배차 1회 조회 → vehicleId → [{dispatchId,routeId,routeName,driverId,driverName,departTime,stopArrivals}]
        // ⚠ **배열로 모은다**(1건만 남기면 안 됨) — 한 차량이 등교·하교 여러 회차를 뛴다.
        //   회차 선택은 아래 pickActiveDispatch(현재 시각이 든 시간창) 가 한다.
        const dispByVehicle = {};
        const dispSnap = await db
          .collection("companies").doc(cid)
          .collection("dispatches").doc(today)
          .collection("list").get();
        dispSnap.docs.forEach(d => {
          const v = d.data() || {};
          if (v.vehicleId) {
            (dispByVehicle[v.vehicleId] = dispByVehicle[v.vehicleId] || []).push({
              dispatchId: d.id,
              routeId: v.routeId || "",
              routeName: v.routeName || "",
              driverId: v.driverId || "",
              driverName: v.driverName || "",
              departTime: v.departTime || "",
              stopArrivals: v.stopArrivals || {},
            });
          }
        });
        // 출발시각 순 정렬 — 후보 순회를 결정적으로(문서 ID 순 우연 의존 제거).
        Object.values(dispByVehicle).forEach(list =>
          list.sort((a, b) => String(a.departTime).localeCompare(String(b.departTime))));

        // 회사별 노선 메타 캐시(이 폴 사이클 1회 로드) — device 차량 배차 routeId 한정.
        const routeMetaCache = {};

        for (const vdoc of vehSnap.docs) {
          const vehicleId = vdoc.id;
          const veh = vdoc.data() || {};
          const carId = veh.carId;
          if (!carId) continue;
          targets++;
          try {
            const candidates = dispByVehicle[vehicleId] || [];
            if (!candidates.length) {
              // 오늘 미운행 — routeId 없으면 승객앱 표시 불가. 잔존 device gps 문서가 있으면
              // 삭제(어제 창 종료 시점에 폴러가 안 돌았던 경우 등) — 없으면 no-op.
              await cleanupDeviceGpsDoc(db, cid, vehicleId);
              skipped++;
              continue;
            }

            // 운행 시간 창 게이트 — 노선 시간표 밖(운행 전/후) 상시신호 좌표 차단.
            // 회차가 여럿이면 지금 운행 중인 회차를 고른다(등교/하교 각각 자기 창에서 잡힘).
            // 어느 회차도 창 안이 아니면 = 운행 종료/전. meta 는 아래 도착감지에서 재사용.
            const active = await pickActiveDispatch(db, cid, candidates, nowMin, routeMetaCache, winOpts);
            if (!active) {
              // mobile 의 "운행 종료 → clearGPS(문서 삭제)" 대응물 — device 차량은 사람이 종료
              // 버튼을 안 누르므로 폴러가 여기서 문서를 지워야 직원/승객/관제 앱의 "운행중"
              // 표시가 꺼진다(2026-07-16 회의 #2, 소비자 코드 0 변경).
              await cleanupDeviceGpsDoc(db, cid, vehicleId);
              skipped++;
              continue; // busin 조회·gps write 모두 skip
            }
            const disp = active.disp;
            const meta = active.meta;

            const rows = await fetchVehicleLocations(carId, today);
            if (!rows.length) { skipped++; continue; } // 좌표 0건

            const latest = rows[rows.length - 1]; // 오름차순 정렬의 마지막 = 최신
            // 신선도 가드: 최신 좌표 시각이 15분 초과 과거면 skip(주차·미운행 차량 배제).
            const coordMin = hhmmToMinutes(extractHHMM(latest.time));
            if (coordMin === null || (nowMin - coordMin) > 15) { skipped++; continue; }

            // ── 운행 이력 적재 준비(2026-08-18) ────────────────────────────
            // 예전엔 폴 때마다 **최신 1행만** `ts=폴 시각`으로 add 했다. 그 결과
            //   ⓐ 원천(busin)이 2분에 한 번 주는데 폴은 1분이라 **같은 좌표가 2배로** 쌓이고
            //     (prod 실측 2026-08-18: 45점 중 22개가 동일 좌표 재기록)
            //   ⓑ 기록 시각이 **실제 측정 시각과 최대 1분 어긋나고**
            //   ⓒ 폴이 밀리면 그 사이 원천 행이 **영영 유실**됐다(원천은 하루치를 다 준다).
            // 이제 워터마크(gps 문서의 lastFixMs) 이후 행을 **측정 시각 그대로** 적재한다.
            // ⚠ 밀도 자체는 원천이 정한다(2분) — 이 수정으로 직선이 사라지지는 않는다.
            const gpsRef = db.collection("gps").doc(`${cid}_${vehicleId}`);
            let lastFixMs = null;
            try {
              const prev = await gpsRef.get();
              const v = prev.exists ? prev.data().lastFixMs : null;
              if (typeof v === "number" && Number.isFinite(v)) lastFixMs = v;
            } catch (_) { /* 못 읽으면 워터마크 없음으로 — 최근 15분만 적재 */ }
            const nowMs = Date.now();
            const rowsWithMs = rows
              .map(r => ({ ...r, ms: parseBusinFixMs(r.time, today) }))
              .filter(r => r.ms !== null);
            const latestMs = rowsWithMs.length ? rowsWithMs[rowsWithMs.length - 1].ms : null;
            const newRows = selectNewFixRows(rowsWithMs, lastFixMs, nowMs);

            // gps/{cid}_{vehicleId} — sendGPS(lib/gps.js) 와 동일 필드 + source:"device".
            // 🔴 lastFixMs 는 **이 문서에만** 추가되는 워터마크 — 소비측(관제·승객·직원앱)은
            //    안 읽는 옵셔널 필드라 표시 계약은 그대로다.
            await gpsRef.set({
              lat: latest.lat, lng: latest.lng, speed: 0, accuracy: 0,
              companyId: cid, vehicleId, vehicleNo: veh.plateNo || "",
              driverId: disp.driverId, driverName: disp.driverName,
              routeId: disp.routeId, routeName: disp.routeName,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              source: "device",
              ...(latestMs !== null ? { lastFixMs: latestMs } : {}),
            });
            // gpsHistory append — lib/gps.js 경로 그대로 미러(운행이력 유지).
            // 문서 ID = 측정 시각(초). 워터마크를 잃어도 같은 행이 두 번 쌓이지 않는다(멱등).
            if (newRows.length) {
              const batch = db.batch();
              const pcol = db.collection("gpsHistory").doc(cid)
                .collection(vehicleId).doc(today).collection("points");
              for (const r of newRows) {
                batch.set(pcol.doc(`fix_${Math.floor(r.ms / 1000)}`), {
                  lat: r.lat, lng: r.lng, speed: 0,
                  ts: admin.firestore.Timestamp.fromMillis(r.ms),
                  source: "device",
                });
              }
              await batch.commit();
            }
            written++;

            // ── 정류장 서버측 도착감지 (device 차량은 기사앱 없어 stopArrivals 미기록) ──
            // 최신 좌표와 각 정류장 거리 계산 → 아직 도착기록 없는 정류장 중 100m 이내 = 신규 도착.
            // recordStopArrival 정본과 동일 dot-notation stopArrivals write(+via:"device") →
            // notifyPreArrival 트리거 자동 발화(도착임박 푸시)·승객앱 도착시각 정상화.
            // 감지 실패가 gps write(이미 완료)나 폴러를 죽이지 않게 별도 try/catch.
            try {
              // meta 는 위 시간창 게이트에서 이미 로드(routeMetaCache) — 재사용.
              if (meta && meta.stops.length) {
                const arrivals = disp.stopArrivals || {}; // 인메모리(같은 사이클 재감지 방지)
                const updates = {};
                let detected = 0;
                for (const st of meta.stops) {
                  if (arrivals[st.id]) continue; // 멱등: 이미 도착 기록 있으면 첫 도착 보존
                  const d = distMeters(latest.lat, latest.lng, st.lat, st.lng);
                  if (d > arriveRadius) continue;
                  const plannedAt = planTimeFromDepart(meta.departTime, st.offsetMin);
                  let delaySec = null;
                  if (plannedAt) {
                    const plannedMs = Date.parse(`${today}T${plannedAt}:00+09:00`);
                    if (isFinite(plannedMs)) delaySec = Math.round((Date.now() - plannedMs) / 1000);
                  }
                  updates[`stopArrivals.${st.id}`] = {
                    actualAt: admin.firestore.FieldValue.serverTimestamp(),
                    plannedAt: plannedAt || null,
                    delaySec,
                    estimated: false,
                    via: "device",
                  };
                  arrivals[st.id] = true; // 인메모리 반영
                  detected++;
                }
                if (detected > 0) {
                  await db
                    .collection("companies").doc(cid)
                    .collection("dispatches").doc(today)
                    .collection("list").doc(disp.dispatchId)
                    .update(updates);
                  console.log(`[단말도착] cid=${cid} veh=${vehicleId} disp=${disp.dispatchId} 신규 ${detected}건`);
                }
              }
            } catch (e) {
              console.error(`[단말도착] 감지 오류 cid=${cid} veh=${vehicleId}:`, e.message);
            }
          } catch (e) {
            console.error(`[단말GPS] 차량 오류 cid=${cid} veh=${vehicleId} carId=${carId}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`[단말GPS] 회사 오류 cid=${cid}:`, e.message);
      }
    }

    console.log(`[단말GPS] 폴링 완료 — 대상 ${targets}대 · 갱신 ${written}대 · skip ${skipped}대`);
  }
);

exports.createDriverAuth = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId, driverId, empNo, name, pin } = request.data;
  const email = `${empNo}@buslink.com`;
  if (!driverId || !empNo || !pin) throw new HttpsError("invalid-argument", "driverId, empNo, pin이 필요합니다");
  if (pin.length < 6) throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  try {
    const userRecord = await admin.auth().createUser({ email, password: pin, displayName: name || empNo });
    await admin.firestore()
      .collection("companies").doc(companyId).collection("drivers").doc(driverId)
      .update({ uid: userRecord.uid });
    await admin.firestore().collection("users").doc(userRecord.uid).set({
      role: "driver", companyId, empNo, name: name || empNo,
    });
    return { success: true, uid: userRecord.uid };
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      try {
        const existing = await admin.auth().getUserByEmail(email);
        await admin.firestore()
          .collection("companies").doc(companyId).collection("drivers").doc(driverId)
          .update({ uid: existing.uid });
        await admin.auth().updateUser(existing.uid, { password: pin });
        return { success: true, uid: existing.uid };
      } catch (inner) {
        throw new HttpsError("internal", inner.message);
      }
    }
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════════════
// 개선 요청 게시판 — 구글챗 알림 (2026-07-13, YDYOPS 패턴 이식)
//
// 웹훅 URL = config/improvementBoard 문서의 gchatWebhookUrl 필드(시크릿 아님).
// 미설정(없거나 빈 문자열)이면 조용히 skip — 배포 후 슈퍼관리자 콘솔에서 입력하면
// 재배포 없이 알림 활성화. serviceAccount 불요·best-effort try/catch·throw 금지.
//
// - onImprovementRequestCreate: 새 요청 생성 시 cardsV2 카드 발송(새 스레드).
// - onImprovementRequestUpdate: history 길이 diff 로 신규 항목만 추출 → 같은
//   threadKey 답글. 완료(statusTo==='done')는 skip(YDYOPS 동일). 변동 없으면 skip.
//   두 트리거 모두 doc write 0 → 재귀 발화 없음.
// ════════════════════════════════════════════════════════════════

const IMPROVEMENT_STATUS_LABELS = {
  requested: "요청",
  reviewing: "검토",
  in_progress: "반영중",
  done: "완료",
  rejected: "반려",
};
const IMPROVEMENT_ADMIN_URL = "https://admin.buslink.co.kr";

/**
 * 알림 카드 버튼용 딥링크 — 관제 콘솔이 `?imp=<요청id>` 로 진입하면 개선 요청 탭을
 * 자동 선택하고 그 요청 상세를 연다(AdminApp `readImproveDeepLinkId` 가 소비).
 * 파라미터 없는 기존 URL 도 그대로 게시판 첫 화면이라 하위호환 100%.
 */
function improvementDeepLink(id) {
  return `${IMPROVEMENT_ADMIN_URL}/?imp=${encodeURIComponent(id)}`;
}

/** node https 로 JSON POST(웹훅 발송). 2xx 만 성공. */
function postJson(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      timeout: 15000,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Content-Length": payload.length,
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(new Error(`HTTP ${res.statusCode} — ${text.slice(0, 200)}`));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout: " + u.hostname)); });
    req.write(payload);
    req.end();
  });
}

/** config/improvementBoard.gchatWebhookUrl → http(s) URL 또는 null(미설정). */
async function getImprovementWebhookUrl(db) {
  // 우선순위: Functions 시크릿(GCHAT_WEBHOOK_URL) → Firestore config/improvementBoard.gchatWebhookUrl.
  const envUrl = (process.env.GCHAT_WEBHOOK_URL || "").trim();
  if (/^https?:\/\//.test(envUrl)) return envUrl;
  try {
    const snap = await db.collection("config").doc("improvementBoard").get();
    if (!snap.exists) return null;
    const url = (snap.data() || {}).gchatWebhookUrl;
    return (typeof url === "string" && /^https?:\/\//.test(url.trim())) ? url.trim() : null;
  } catch (e) {
    console.warn("[개선요청] 웹훅 URL 조회 실패:", e.message);
    return null;
  }
}

/** companies/{companyId}.name → 회사명(없으면 companyId). */
async function getImprovementCompanyName(db, companyId) {
  try {
    const snap = await db.collection("companies").doc(companyId).get();
    const name = snap.exists && (snap.data() || {}).name;
    return name || companyId || "-";
  } catch {
    return companyId || "-";
  }
}

/**
 * 개선요청 본문 → 웹훅 미리보기 평문. 본문이 리치 HTML(인라인 base64 <img> 포함,
 * 2026-07-13 리치텍스트 도입분)이면 태그를 벗기고 이미지는 "이미지 N장" 라벨로 치환.
 * (2026-07-16 way 신고: base64 원문이 챗 카드에 그대로 노출되어 깨져 보임.)
 * HTML 판별 정규식은 클라 정본 src/lib/richText.js looksLikeHtml 미러 — 레거시 평문은
 * 태그 판별 실패 시 기존 그대로(공백 정리 + slice)라 회귀 0.
 */
function improvementPreviewText(content, max) {
  const raw = String(content || "");
  const isHtml = /<(p|div|br|img|span|ul|ol|li|h[1-3]|blockquote|a|b|strong|em|i|u)\b/i.test(raw);
  let text = raw;
  let imgCount = 0;
  if (isHtml) {
    imgCount = (raw.match(/<img\b/gi) || []).length;
    text = raw
      .replace(/<img\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/g, "'");
  }
  text = text.replace(/\s+/g, " ").trim().slice(0, max);
  const label = imgCount > 0 ? `🖼 이미지 ${imgCount}장 첨부` : "";
  if (!text) return label || "(내용 없음)";
  return label ? `${text} · ${label}` : text;
}

/** 웹훅 URL 에 스레드 옵션 쿼리 부착. reply=true 면 같은 스레드 답글. */
function chatThreadUrl(baseUrl, reply) {
  const u = new URL(baseUrl);
  u.searchParams.set(
    "messageReplyOption",
    reply ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : "MESSAGE_REPLY_OPTION_UNSPECIFIED"
  );
  return u.toString();
}

exports.onImprovementRequestCreate = onDocumentCreated(
  { document: "improvement_requests/{id}", region: "us-central1", secrets: [GCHAT_WEBHOOK_URL] },
  async (event) => {
    try {
      const db = admin.firestore();
      const webhookUrl = await getImprovementWebhookUrl(db);
      if (!webhookUrl) { console.log("[개선요청] 웹훅 미설정 — 생성 알림 skip"); return; }

      const id = event.params.id;
      const data = event.data?.data() || {};
      const companyName = await getImprovementCompanyName(db, data.companyId);
      const statusLabel = IMPROVEMENT_STATUS_LABELS[data.status] || data.status || "요청";
      const preview = improvementPreviewText(data.content, 140);

      const body = {
        thread: { threadKey: "imp-" + id },
        cardsV2: [{
          cardId: "imp-" + id,
          card: {
            header: { title: "🚌 BusLink · 새 개선 요청", subtitle: companyName },
            sections: [{
              widgets: [
                { decoratedText: { topLabel: "제목", text: data.title || "(제목 없음)" } },
                { decoratedText: { topLabel: "요청자", text: `${data.requesterName || "-"} · 상태: ${statusLabel}` } },
                { textParagraph: { text: preview } },
                { buttonList: { buttons: [{ text: "이 요청 열기", onClick: { openLink: { url: improvementDeepLink(id) } } }] } },
              ],
            }],
          },
        }],
      };
      await postJson(chatThreadUrl(webhookUrl, false), body);
      console.log(`[개선요청] 생성 알림 발송 id=${id}`);
    } catch (e) {
      console.warn("[개선요청] 생성 알림 실패:", e.message);
    }
  }
);

exports.onImprovementRequestUpdate = onDocumentUpdated(
  { document: "improvement_requests/{id}", region: "us-central1", secrets: [GCHAT_WEBHOOK_URL] },
  async (event) => {
    try {
      const before = event.data?.before?.data() || {};
      const after = event.data?.after?.data() || {};
      const beforeHist = Array.isArray(before.history) ? before.history : [];
      const afterHist = Array.isArray(after.history) ? after.history : [];

      // history 길이 diff 로 신규 항목만(arrayUnion 말미 append). 변동 없으면 skip.
      if (afterHist.length <= beforeHist.length) return;
      const newItems = afterHist.slice(beforeHist.length);
      // 완료(done) 전이는 알림 skip(YDYOPS 동일). 코멘트/기타 상태전이는 발송.
      const notifiable = newItems.filter((h) => h && h.statusTo !== "done");
      if (notifiable.length === 0) return;

      const db = admin.firestore();
      const webhookUrl = await getImprovementWebhookUrl(db);
      if (!webhookUrl) { console.log("[개선요청] 웹훅 미설정 — 업데이트 알림 skip"); return; }

      const id = event.params.id;
      const companyName = await getImprovementCompanyName(db, after.companyId);

      for (const h of notifiable) {
        const isStatus = !!h.statusTo;
        const statusLabel = IMPROVEMENT_STATUS_LABELS[h.statusTo] || h.statusTo;
        const headerTitle = isStatus ? `🚌 BusLink · 상태 변경 → ${statusLabel}` : "🚌 BusLink · 새 댓글";
        const widgets = [
          { decoratedText: { topLabel: "제목", text: after.title || "(제목 없음)" } },
          { decoratedText: { topLabel: isStatus ? "처리" : "작성자", text: `${h.byName || "-"}` } },
        ];
        if (h.comment) widgets.push({ textParagraph: { text: String(h.comment).slice(0, 200) } });
        widgets.push({ buttonList: { buttons: [{ text: "이 요청 열기", onClick: { openLink: { url: improvementDeepLink(id) } } }] } });

        const body = {
          thread: { threadKey: "imp-" + id },
          cardsV2: [{
            cardId: `imp-${id}-${afterHist.length}`,
            card: {
              header: { title: headerTitle, subtitle: companyName },
              sections: [{ widgets }],
            },
          }],
        };
        await postJson(chatThreadUrl(webhookUrl, true), body);
      }
      console.log(`[개선요청] 업데이트 알림 발송 id=${id} 건수=${notifiable.length}`);
    } catch (e) {
      console.warn("[개선요청] 업데이트 알림 실패:", e.message);
    }
  }
);
