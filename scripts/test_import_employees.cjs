// 명부 일괄등록 격리 검증 — src/lib/partner.js importEmployees (2026-08-28 게시판 m00ghlRl)
//   node scripts/test_import_employees.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0. 소스를 베끼지 않고 그대로 vm 에 태우고,
//    firestore 함수만 가짜로 갈아 끼워 **왕복 횟수까지** 센다.
//
// 왜 필요한가: 신촌세브란스병원 명부가 16,155명이 되면서 문서마다 getDoc→setDoc 을
// 순차로 왕복하던 옛 구현이 읽기만 5분 걸렸다(실측 1건 18.9ms). 배치로 바꾸면서
// 지켜야 할 것이 세 가지다 — ① 신규만 PIN 발급 ② 기존 PIN 보존
// ③ **다른 협력사에 있는 사번을 신규로 오판하지 않기**(오판하면 그 사람이 로그인 불가).
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

let n = 0, fail = 0;
const ok = (name, cond, got) => {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

// ── 가짜 Firestore ──────────────────────────────────────────────
const DOCID = "__name__";
function makeFirestore(seed, opts = {}) {
  const store = new Map(Object.entries(seed));       // empNo → data
  const stats = { getDoc: 0, getDocs: 0, batches: 0, batchOps: 0, singleWrites: 0, commitFail: 0 };
  const api = {
    db: { __db: true },
    collection: (...p) => ({ __col: p.slice(1).join("/") }),
    doc: (a, ...rest) => (a && a.__col
      ? { __ref: rest[0], col: a.__col }
      : { __ref: rest[rest.length - 1], col: rest.slice(0, -1).join("/") }),
    query: (col, ...cs) => ({ col, cs }),
    where: (f, op, v) => ({ f, op, v }),
    documentId: () => DOCID,
    serverTimestamp: () => "__ts__",
    increment: (k) => ({ __inc: k }),
    getDoc: async (ref) => { stats.getDoc++; const d = store.get(ref.__ref); return { exists: () => !!d, data: () => d }; },
    getDocs: async (q) => {
      stats.getDocs++;
      let rows = [...store.entries()].map(([id, data]) => ({ id, data: () => data }));
      for (const c of q.cs) {
        if (c.f === DOCID) rows = rows.filter((r) => c.v.includes(r.id));
        else rows = rows.filter((r) => r.data()[c.f] === c.v);
      }
      return { forEach: (fn) => rows.forEach(fn), docs: rows, size: rows.length };
    },
    setDoc: async (ref, data) => { stats.singleWrites++; store.set(ref.__ref, { ...data }); },
    updateDoc: async (ref, data) => {
      if (ref.col === "partnerCodes") return;   // 업체코드 업로드 횟수 갱신 — 검사 대상 아님
      stats.singleWrites++;
      store.set(ref.__ref, { ...(store.get(ref.__ref) || {}), ...data });
    },
    writeBatch: () => {
      const ops = [];
      return {
        set: (ref, data) => ops.push(["set", ref, data]),
        update: (ref, data) => ops.push(["update", ref, data]),
        commit: async () => {
          stats.batches++; stats.batchOps += ops.length;
          if (opts.failBatch && opts.failBatch(stats.batches)) { stats.commitFail++; throw new Error("배치 커밋 실패(모의)"); }
          for (const [kind, ref, data] of ops) {
            if (kind === "set") store.set(ref.__ref, { ...data });
            else store.set(ref.__ref, { ...(store.get(ref.__ref) || {}), ...data });
          }
        },
      };
    },
  };
  return { store, stats, api };
}

function load(fake) {
  const src = fs.readFileSync(path.join(ROOT, "src", "lib", "partner.js"), "utf8")
    .replace(/^import[\s\S]*?from\s+.[^\n]*;?$/gm, "")
    .replace(/^export /gm, "");
  const ctx = {
    console, crypto: require("crypto").webcrypto, TextEncoder,
    normalizeNfcUid: (v) => String(v).toUpperCase(),
    isValidNfcUid: () => true,
    generateInitialPin: () => "654321",
    isValidInitialPin: (v) => /^\d{6}$/.test(String(v || "")),
    Timestamp: {}, addDoc: async () => {}, deleteDoc: async () => {},
    ...fake.api,
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.importEmployees=importEmployees;", ctx);
  return ctx.importEmployees;
}

const ROUTES = [{ id: "r1", code: "662", name: "기흥 출근" }];
const emp = (empNo, over = {}) => ({ empNo, name: "이름" + empNo, dept: "부서", routeCode: "662", active: true, ...over });

(async () => {
  console.log("\n[1] 신규 등록 — 배치로 묶이고 문서별 왕복이 없다");
  {
    const fake = makeFirestore({});
    const importEmployees = load(fake);
    const rows = Array.from({ length: 1000 }, (_, i) => emp("E" + i));
    const res = await importEmployees({ companyId: "dy001", partnerCode: "PC1", partnerName: "협력사", employees: rows, routes: ROUTES });
    ok("1000명 전원 신규", res.added === 1000 && res.updated === 0, res);
    ok("문서별 getDoc 왕복 0회", fake.stats.getDoc === 0, fake.stats);
    ok("조회는 쿼리 35회로 끝난다(기존명부 1 + 30개씩 34청크)", fake.stats.getDocs === 35, fake.stats.getDocs);
    ok("쓰기는 배치 3회(450+450+100)", fake.stats.batches === 3 && fake.stats.batchOps === 1000, fake.stats);
    ok("문서별 개별 쓰기 0회", fake.stats.singleWrites === 0, fake.stats.singleWrites);
    ok("신규에만 초기 PIN·pinInitial", fake.store.get("E0").pinInitial === true && !!fake.store.get("E0").pinHash);
    ok("평문 PIN 은 저장 안 하고 반환만", fake.store.get("E0").pin === undefined && res.credentials.length === 1000);
  }

  console.log("\n[2] 기존 승객 — PIN 을 건드리지 않는다");
  {
    const fake = makeFirestore({ E1: { empNo: "E1", name: "옛이름", partnerCode: "PC1", active: true, pinHash: "OLD", pinInitial: false, routeId: "r9" } });
    const importEmployees = load(fake);
    const res = await importEmployees({ companyId: "dy001", partnerCode: "PC1", partnerName: "협력사", employees: [emp("E1", { name: "새이름" })], routes: ROUTES });
    ok("갱신으로 센다", res.updated === 1 && res.added === 0, res);
    ok("이름은 바뀐다", fake.store.get("E1").name === "새이름");
    ok("pinHash 보존", fake.store.get("E1").pinHash === "OLD", fake.store.get("E1"));
    ok("pinInitial 도 안 건드린다", fake.store.get("E1").pinInitial === false);
    ok("PIN 을 새로 발급하지 않았다", res.credentials.length === 0);
  }

  console.log("\n[3] 🔴 다른 협력사에 이미 있는 사번(이관자)을 신규로 오판하지 않는다");
  {
    const fake = makeFirestore({ E9: { empNo: "E9", name: "이관자", partnerCode: "OTHER", active: true, pinHash: "KEEP", routeId: "r9" } });
    const importEmployees = load(fake);
    const res = await importEmployees({ companyId: "dy001", partnerCode: "PC1", partnerName: "협력사", employees: [emp("E9")], routes: ROUTES });
    ok("신규가 아니라 갱신", res.added === 0 && res.updated === 1, res);
    ok("기존 PIN 이 살아 있다(로그인 유지)", fake.store.get("E9").pinHash === "KEEP", fake.store.get("E9"));
    ok("소속만 새 협력사로", fake.store.get("E9").partnerCode === "PC1");
  }

  console.log("\n[4] 같은 사번이 파일에 두 번 — 뒤엣것만 남는다");
  {
    const fake = makeFirestore({});
    const importEmployees = load(fake);
    const res = await importEmployees({ companyId: "dy001", partnerCode: "PC1", partnerName: "협력사",
      employees: [emp("E1", { name: "앞" }), emp("E1", { name: "뒤" })], routes: ROUTES });
    ok("1명으로 집계", res.added === 1, res);
    ok("뒤 행이 남는다", fake.store.get("E1").name === "뒤");
    ok("PIN 도 한 번만 발급", res.credentials.length === 1);
  }

  console.log("\n[5] 퇴사 전이 집계");
  {
    const fake = makeFirestore({ E1: { empNo: "E1", partnerCode: "PC1", active: true } });
    const importEmployees = load(fake);
    const res = await importEmployees({ companyId: "dy001", partnerCode: "PC1", partnerName: "협력사",
      employees: [emp("E1", { active: false })], routes: ROUTES });
    ok("deactivated 로 센다", res.deactivated === 1 && res.updated === 0, res);
  }

  console.log("\n[6] 🔴 배치가 실패해도 그 450명이 통째로 사라지지 않는다");
  {
    const fake = makeFirestore({}, { failBatch: (i) => i === 1 });
    const importEmployees = load(fake);
    const rows = Array.from({ length: 500 }, (_, i) => emp("E" + i));
    await importEmployees({ companyId: "dy001", partnerCode: "PC1", partnerName: "협력사", employees: rows, routes: ROUTES });
    ok("실패한 배치는 문서별로 다시 쓴다", fake.stats.singleWrites === 450, fake.stats);
    ok("500명 모두 저장됐다", fake.store.size === 500, fake.store.size);
  }

  console.log("\n[7] 사번 없는 행은 건너뛰고 알린다");
  {
    const fake = makeFirestore({});
    const importEmployees = load(fake);
    const res = await importEmployees({ companyId: "dy001", partnerCode: "PC1", partnerName: "협력사",
      employees: [emp("E1"), { name: "사번없음", active: true }], routes: ROUTES });
    ok("1명만 등록", res.added === 1, res);
    ok("건너뛴 사실을 errors 로 알린다", res.errors.some((e) => e.includes("사번")), res.errors);
  }

  console.log(`\n결과: ${n - fail} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
