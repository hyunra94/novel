import { assemble } from "./mp3.js";
import { mockApi } from "./mock.js";

/* =========================================================
   소설 서재 — 노션 소설 읽기 + 듣기
   화면: #/ 작품 목록 · #/work/:id 회차 목록 · #/ep/:workId/:epId 본문
         #/voices/:workId 목소리 설정 · #/settings 앱 설정
========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 공간 부족 */ } },
  del(k) { localStorage.removeItem(k); },
};

const DEFAULT_API = "https://novelreader.hyunra94.workers.dev";
let cfg = LS.get("nr.cfg", { apiBase: "", apiKey: "" });
const prefs = Object.assign({
  fontSize: 18, lineHeight: 1.9, theme: "paper", font: "gowun", showNames: true,
  hidePlanned: true, autoNext: true, follow: true, speed: 1, mode: "auto",
}, LS.get("nr.prefs", {}));
const savePrefs = () => LS.set("nr.prefs", prefs);

const FONTS = {
  gowun: { label: "고운바탕", css: '"Gowun Batang", serif', url: "https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap" },
  nanum: { label: "나눔명조", css: '"Nanum Myeongjo", serif', url: "https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700&display=swap" },
  noto: { label: "본명조", css: '"Noto Serif KR", serif', url: "https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap" },
  sans: { label: "고딕", css: 'var(--ui)', url: "" },
};
const THEMES = { paper: "종이", white: "흰색", dark: "어두움", black: "검정" };
const NOTION_COLORS = { default: "#8a8a8a", gray: "#8a8a8a", brown: "#9a6b4f", orange: "#d9730d", yellow: "#b8920a", green: "#448361", blue: "#337ea9", purple: "#9065b0", pink: "#c14c8a", red: "#d44c47" };
const ENGINE_LABEL = { google: "Google", azure: "Azure", elevenlabs: "ElevenLabs" };

const view = $("#view");
const audio = $("#audio");
const state = { engines: null, works: null, work: {}, ep: {}, voiceLists: {} };

/* ---------------- 데이터 보관 (Cache API) ---------------- */

const DATA_CACHE = "nr-data";
async function dataGet(key) {
  try {
    const c = await caches.open(DATA_CACHE);
    const r = await c.match(`/__data/${encodeURIComponent(key)}`);
    return r ? await r.json() : null;
  } catch { return null; }
}
async function dataSet(key, value) {
  try {
    const c = await caches.open(DATA_CACHE);
    await c.put(`/__data/${encodeURIComponent(key)}`, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
  } catch { /* 무시 */ }
}

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  if (cfg.apiBase === "mock") return mockApi(path, opts);
  let res;
  try {
    res = await fetch(cfg.apiBase.replace(/\/+$/, "") + path, {
      method: opts.method || "GET",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    const e = new Error("인터넷에 연결되지 않았어요.");
    e.offline = true;
    throw e;
  }
  if (opts.raw) {
    if (!res.ok) throw new Error(`불러오지 못했어요 (${res.status})`);
    return res;
  }
  const data = await res.json().catch(() => ({ ok: false, error: `응답 오류 (${res.status})` }));
  if (!res.ok || data.ok === false) {
    const e = new Error(data.error || `오류 (${res.status})`);
    e.status = res.status;
    e.code = data.code;
    if (data.code === "AUTH") {
      // 앱 키가 바뀌었거나 틀림 → 연결 화면으로
      cfg = { apiBase: cfg.apiBase, apiKey: "" };
      LS.set("nr.cfg", { ...cfg, apiBase: "" });
      cfg.apiBase = "";
      toast("앱 키가 맞지 않아요. 다시 넣어 주세요.", 4000);
      setTimeout(route, 0);
    }
    throw e;
  }
  return data;
}

/* ---------------- 공통 UI ---------------- */

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function setHeader(title, { back = null, actions = "" } = {}) {
  $("#title").textContent = title;
  const b = $("#back");
  b.style.visibility = back ? "visible" : "hidden";
  b.onclick = () => { if (back) goUp(back); };
  $("#actions").innerHTML = actions;
  $("#top").classList.remove("hide");
  setProgress(0);
}

function setProgress(p) { $("#progress i").style.width = `${Math.max(0, Math.min(100, p))}%`; }

function openDialog(html, onMount) {
  const d = $("#dlg");
  d.innerHTML = html;
  d.showModal();
  d.onclick = e => { if (e.target === d) d.close(); };
  d.querySelectorAll("[data-close]").forEach(b => b.onclick = () => d.close());
  onMount?.(d);
  return d;
}

function applyLook() {
  document.documentElement.dataset.theme = prefs.theme === "paper" ? "" : prefs.theme;
  const root = document.documentElement.style;
  root.setProperty("--fs", `${prefs.fontSize}px`);
  root.setProperty("--lh", prefs.lineHeight);
  const f = FONTS[prefs.font] || FONTS.gowun;
  root.setProperty("--font", f.css);
  if ($("#fontlink").getAttribute("href") !== f.url) $("#fontlink").setAttribute("href", f.url);
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]').setAttribute("content", bg || "#f7f3ec");
}

function timeAgo(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.round(m / 60)}시간 전`;
  if (m < 43200) return `${Math.round(m / 1440)}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}

function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------------- 라우팅 ---------------- */

window.addEventListener("hashchange", route);

/* ---------- 뒤로 가기 ----------
   회차끼리 이동(이전·다음 화, 자동 다음 화, 책갈피)은 기록을 쌓지 않고 바꿔치기한다.
   그래서 뒤로 가기(휴대폰 뒤로 버튼, ‹)를 누르면 거쳐 온 회차들이 아니라 회차 목록 → 메인으로 나간다.
---------------------------------- */
const navStack = [];
let navReplace = false;
const curHash = () => location.hash || "#/";

function trackNav() {
  const h = curHash();
  if (navReplace) { navReplace = false; navStack[Math.max(0, navStack.length - 1)] = h; return; }
  if (navStack[navStack.length - 2] === h) { navStack.pop(); return; }
  if (navStack[navStack.length - 1] !== h) navStack.push(h);
}

function go(path, { replace = false } = {}) {
  if (replace) { navReplace = true; location.replace(`#${path}`); }
  else location.hash = path;
}

// 위 화면으로: 바로 앞 기록이 그 화면이면 진짜 뒤로 가기, 아니면 바꿔치기
function goUp(path) {
  if (navStack[navStack.length - 2] === `#${path}`) history.back();
  else go(path, { replace: true });
}

const onEpRoute = () => curHash().startsWith("#/ep/");

// 앱을 회차 화면에서 바로 열었을 때도 뒤로 가기가 목록 → 메인으로 가게 기록을 깔아 둔다
(function seedHistory() {
  const h0 = location.hash;
  const p = h0.slice(1).split("/").filter(Boolean);
  // 새로 고침할 때마다 기록을 또 깔지 않게, 이 창에서 한 번만
  if (!p.length || p[0] === "setup" || sessionStorage.getItem("nr.seeded")) return;
  sessionStorage.setItem("nr.seeded", "1");
  history.replaceState(null, "", "#/");
  navStack.push("#/");
  if (p[0] === "ep" && p[1]) {
    history.pushState(null, "", `#/work/${p[1]}`);
    navStack.push(`#/work/${p[1]}`);
  }
  history.pushState(null, "", h0);
})();
async function route() {
  trackNav();
  pageRefresh = null;
  hideBubble();
  $("#epinfo")?.classList.remove("show");
  $("#epnav")?.classList.remove("show");
  const parts = (location.hash.slice(1) || "/").split("/").filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (!cfg.apiBase || parts[0] === "setup") return viewSetup();
  try {
    if (!parts.length) return await viewWorks();
    if (parts[0] === "work") return await viewWork(parts[1]);
    if (parts[0] === "ep") return await viewReader(parts[1], parts[2], parts[3] != null ? Number(parts[3]) : null);
    if (parts[0] === "voices") return await viewVoices(parts[1]);
    if (parts[0] === "settings") return viewSettings();
    location.hash = "/";
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">다시 시도</button></div>`;
  }
}

/* ---------------- 처음 연결 ---------------- */

// 연결 바꾸기·예시로 둘러보기를 눌러도 원래 연결(앱 키)은 nr.cfgPrev에 남겨 두고, 취소·예시 끝내기로 돌아간다
const realCfg = () => (cfg.apiBase && cfg.apiBase !== "mock" ? cfg : LS.get("nr.cfgPrev", null)) || { apiBase: "", apiKey: "" };
function useCfg(next) {
  cfg = next;
  LS.set("nr.cfg", cfg);
  LS.del("nr.cfgPrev");
  state.works = null; state.work = {}; state.ep = {};
  location.replace("#/");
  route();
}

function exitMock() {
  const prev = LS.get("nr.cfgPrev", null);
  if (prev?.apiBase && prev.apiKey) useCfg(prev);
  else go("/setup");
}

function viewSetup() {
  const was = realCfg();
  setHeader("소설 서재", cfg.apiBase ? { back: "/" } : {});
  view.innerHTML = `
    <div class="card stack" style="margin-top:20px">
      <h3 style="margin:0">연결하기</h3>
      <p class="muted">Worker 주소와 앱 키(APP_KEY)를 넣어 주세요. 한 번만 넣으면 이 기기에 저장돼요.</p>
      <div class="field"><label>Worker 주소</label><input id="sBase" placeholder="https://novelreader.○○○.workers.dev" value="${esc(was.apiBase || DEFAULT_API)}"></div>
      <div class="field" style="margin-top:10px"><label>앱 키</label><input id="sKey" type="password" value="${esc(was.apiKey || "")}"></div>
      <div class="row end" style="margin-top:14px">
        <button class="btn" id="sMock">예시로 둘러보기</button>
        <button class="btn primary" id="sGo">연결</button>
      </div>
    </div>`;
  $("#sGo").onclick = async () => {
    const next = { apiBase: $("#sBase").value.trim(), apiKey: $("#sKey").value.trim() };
    if (!/^https?:\/\//.test(next.apiBase)) return toast("Worker 주소를 https://로 시작하게 넣어 주세요.");
    const prev = cfg;
    cfg = next;
    try {
      const r = await api("/api/ping");
      state.engines = r.engines;
      toast("연결됐어요");
      useCfg(next);
    } catch (e) {
      cfg = prev;
      toast(e.message, 4000);
    }
  };
  $("#sMock").onclick = () => {
    if (cfg.apiBase && cfg.apiBase !== "mock") LS.set("nr.cfgPrev", cfg);
    cfg = { apiBase: "mock", apiKey: "" };
    LS.set("nr.cfg", cfg);
    state.works = null; state.work = {}; state.ep = {};
    location.replace("#/");
    route();
  };
}

/* ---------------- 작품 목록 ---------------- */

async function viewWorks() {
  setHeader("소설 서재", { actions: `<button class="icon" id="rfBtn" aria-label="노션에서 새로 불러오기">⟳</button><button class="icon" id="goSettings" aria-label="설정">⚙</button>` });
  $("#goSettings").onclick = () => location.hash = "/settings";

  const render = works => {
    if (works) lastWorks = works;
    const last = LS.get("nr.last", null);
    const cont = last ? `
      <div class="card link continue" data-go="#/ep/${last.workId}/${last.epId}">
        <div class="emoji">📖</div>
        <div class="grow"><div class="muted">이어 읽기</div><div class="name">${esc(last.workTitle)}</div><div class="muted">${esc(last.epTitle)}</div></div>
      </div>` : "";
    const card = w => `
      <div class="card link" data-go="#/work/${w.id}">
        <div class="emoji">${esc(w.icon || "📘")}</div>
        <div class="grow"><div class="name">${esc(w.title)}</div><div class="muted">${timeAgo(w.lastEdited)} 수정${shelvesOf(w.id).length ? ` · ${esc(shelvesOf(w.id).join(", "))}` : ""}</div></div>
        <button class="icon more" data-more="${w.id}" aria-label="분류 정하기">⋯</button>
      </div>`;
    const all = works || [];
    const NONE = "\u0000none";
    let filter = LS.get("nr.shelfFilter", "전체");
    if (filter !== "전체" && filter !== NONE && !shelves.list.includes(filter)) filter = "전체";
    const inShelf = name => all.filter(w => name === NONE ? !shelvesOf(w.id).length : shelvesOf(w.id).includes(name));
    const unsorted = inShelf(NONE);
    const chips = `<div class="chips">
      <button class="chip ${filter === "전체" ? "on" : ""}" data-f="전체">전체 ${all.length}</button>
      ${shelves.list.map(n => `<button class="chip ${filter === n ? "on" : ""}" data-f="${esc(n)}">${esc(n)} ${inShelf(n).length}</button>`).join("")}
      ${shelves.list.length && unsorted.length ? `<button class="chip ${filter === NONE ? "on" : ""}" data-f="${NONE}">분류 없음 ${unsorted.length}</button>` : ""}
      <button class="chip add" id="shelfEdit">${shelves.list.length ? "✎ 분류 편집" : "＋ 분류 만들기"}</button>
    </div>`;
    let body;
    if (!works) body = '<div class="empty">불러오는 중…</div>';
    else if (!all.length) body = '<div class="empty">작품이 없어요</div>';
    else if (filter !== "전체") body = inShelf(filter).map(card).join("") || '<div class="empty">이 분류에 작품이 없어요. 작품 오른쪽 ⋯로 넣어 보세요.</div>';
    else if (!shelves.list.length) body = all.map(card).join("");
    else body = [...shelves.list, NONE].map(n => {
      const ws = inShelf(n);
      return ws.length ? `<h2 class="sec">${n === NONE ? "분류 없음" : esc(n)}</h2>${ws.map(card).join("")}` : "";
    }).join("");
    const mockBar = cfg.apiBase === "mock" ? `<div class="card mock-bar"><div class="grow"><b>예시로 둘러보는 중</b><div class="muted">진짜 소설이 아니에요</div></div><button class="btn primary small" id="mockExit">예시 끝내기</button></div>` : "";
    view.innerHTML = mockBar + cont + (works ? `<h2 class="sec">작품</h2>${chips}` : "") + body;
    $("#mockExit")?.addEventListener("click", exitMock);
    view.querySelectorAll("[data-go]").forEach(el => el.onclick = e => {
      if (e.target.closest("[data-more]")) return;
      const p = el.dataset.go.slice(1);
      const m = p.match(/^\/ep\/([^/]+)\//);
      // 메인에서 바로 회차로 가도 뒤로 가기는 그 작품 회차 목록(상위)으로
      if (m) { history.pushState(null, "", `#/work/${m[1]}`); navStack.push(`#/work/${m[1]}`); }
      location.hash = p;
    });
    view.querySelectorAll("[data-more]").forEach(el => el.onclick = () => openShelfPicker(el.dataset.more, () => render(lastWorks)));
    view.querySelectorAll("[data-f]").forEach(el => el.onclick = () => { LS.set("nr.shelfFilter", el.dataset.f); render(lastWorks); });
    if ($("#shelfEdit")) $("#shelfEdit").onclick = () => openShelfEditor(() => render(lastWorks));
  };

  const fetchWorks = async () => {
    const r = await api("/api/works");
    state.works = r.works;
    dataSet("works", r.works);
    if (location.hash.slice(1) === "/" || !location.hash) render(r.works);
  };
  setRefresh(async () => { await Promise.all([fetchWorks(), pullShelves()]); render(lastWorks); toast("노션에서 새로 불러왔어요"); });

  render(state.works);
  if (!state.works) { const saved = await dataGet("works"); if (saved) render(saved); }
  pullShelves().then(changed => { if (changed && (location.hash.slice(1) === "/" || !location.hash)) render(lastWorks); });
  try {
    await fetchWorks();
  } catch (e) {
    if (!state.works) toast(e.message);
  }
}

/* ---------------- 회차 목록 ---------------- */

async function loadWork(workId, { fresh = false } = {}) {
  if (!fresh && state.work[workId]) return state.work[workId];
  const cached = await dataGet(`work:${workId}`);
  if (cached && !fresh) {
    state.work[workId] = cached;
    refreshWork(workId);
    return cached;
  }
  return refreshWork(workId);
}

async function refreshWork(workId, { strict = false } = {}) {
  try {
    const r = await api(`/api/works/${workId}`);
    const title = (state.works || await dataGet("works") || []).find(w => w.id === workId);
    const work = { ...r, title: title?.title || state.work[workId]?.title || "", icon: title?.icon || "" };
    state.work[workId] = work;
    dataSet(`work:${workId}`, work);
    return work;
  } catch (e) {
    if (state.work[workId] && !strict) return state.work[workId];
    throw e;
  }
}

/* ---------- 읽은 기록 (기기끼리 Worker로 동기화) ---------- */

function markRead(epId) {
  const read = new Set(LS.get("nr.read", []));
  if (read.has(epId)) return;
  read.add(epId);
  LS.set("nr.read", [...read]);
  queueSync();
}

function localProgress() {
  const pos = {};
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("nr.pos.")) continue;
    const v = LS.get(k, null);
    if (v?.at) pos[k.slice(7)] = { block: v.block || 0, pct: v.pct || 0, at: v.at };
  }
  return { read: LS.get("nr.read", []), pos, last: LS.get("nr.last", null) };
}

function applyProgress(p) {
  if (!p) return;
  LS.set("nr.read", [...new Set([...LS.get("nr.read", []), ...(p.read || [])])]);
  for (const [id, v] of Object.entries(p.pos || {})) {
    const cur = LS.get(`nr.pos.${id}`, {});
    if ((v.at || 0) > (cur.at || 0)) LS.set(`nr.pos.${id}`, { ...cur, block: v.block, pct: v.pct, at: v.at });
  }
  const last = LS.get("nr.last", null);
  if (p.last?.epId && (p.last.at || 0) > (last?.at || 0)) {
    LS.set("nr.last", p.last);
    if (p.last.workId) LS.set(`nr.lastep.${p.last.workId}`, p.last.epId);
  }
}

let syncTimer;
const canSync = () => cfg.apiBase && cfg.apiBase !== "mock" && cfg.apiKey;
function queueSync() {
  if (!canSync()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushProgress, 3000);
}
async function pushProgress() {
  clearTimeout(syncTimer);
  if (!canSync()) return;
  try { applyProgress((await api("/api/progress", { method: "PUT", body: localProgress() })).progress); } catch { /* 다음에 다시 */ }
}
async function pullProgress() {
  if (!canSync()) return;
  try { applyProgress((await api("/api/progress")).progress); } catch { /* 오프라인 */ }
}

function epProgress(epId) {
  const p = LS.get(`nr.pos.${epId}`, null);
  return p ? p.pct || 0 : null; // null = 한 번도 안 연 회차
}

async function viewWork(workId) {
  setHeader("", { back: "/", actions: `<button class="icon" id="wMarks" aria-label="책갈피">🔖</button><button class="icon" id="rfBtn" aria-label="노션에서 새로 불러오기">⟳</button><button class="icon" id="goVoices" aria-label="목소리">🎙</button>` });
  $("#wMarks").onclick = () => openMarksDialog(workId);
  $("#goVoices").onclick = () => location.hash = `/voices/${workId}`;
  view.innerHTML = '<div class="empty">불러오는 중…</div>';
  let filter = LS.get(`nr.filter.${workId}`, "전체");

  const render = work => {
    $("#title").textContent = work.title || "회차";
    const read = new Set(LS.get("nr.read", []));
    const routes = ["전체", ...work.routes.map(r => r.name)];
    let eps = work.episodes.filter(e => !(prefs.hidePlanned && e.status === "기획"));
    if (filter !== "전체") eps = eps.filter(e => e.route === filter);
    const hidden = work.episodes.filter(e => e.status === "기획").length;
    const last = LS.get(`nr.lastep.${workId}`, null);
    const lastEp = last && work.episodes.find(e => e.id === last);
    view.innerHTML = `
      ${lastEp ? `<div class="card link continue" id="cont"><div class="emoji">📖</div><div class="grow"><div class="muted">이어 읽기${epProgress(lastEp.id) && !read.has(lastEp.id) ? ` · ${epProgress(lastEp.id)}%` : ""}</div><div class="name">${esc(lastEp.title)}</div></div></div>` : ""}
      ${routes.length > 2 ? `<div class="chips">${routes.map(r => `<button class="chip ${r === filter ? "on" : ""}" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>` : ""}
      <div>${eps.map(e => {
        const pct = epProgress(e.id);
        const isRead = read.has(e.id);
        const reading = !isRead && pct != null;
        const isLast = lastEp && lastEp.id === e.id;
        const cks = (work.checks || []).map(name => `<button class="ck ${e.checks?.[name] ? "on" : ""}" data-ck="${esc(name)}" data-ep="${e.id}" aria-label="${esc(name)}"><b></b>${(work.checks.length > 1 || name !== "체크박스") ? `<small>${esc(name)}</small>` : ""}</button>`).join("");
        return `<div class="ep ${isRead ? "read" : ""} ${reading ? "reading" : ""} ${isLast ? "here" : ""}" data-id="${e.id}">
          <div class="no">${typeof e.no === "number" ? e.no : "·"}${isRead ? '<small>✓</small>' : ""}</div>
          <div class="grow">
            <div class="t">${esc(e.title)}</div>
            ${e.summary ? `<div class="s">${esc(e.summary)}</div>` : ""}
            <div class="meta">${isLast ? '<span class="tag here">📖 여기까지 읽음</span>' : ""}${isRead ? '<span class="tag readtag">✓ 다 읽음</span>' : ""}${reading ? `<span class="tag readtag">${pct ? `${pct}% 읽음` : "열어 봄"}</span>` : ""}${e.route && e.route !== "본편" ? `<span class="tag">${esc(e.route)}</span>` : ""}</div>
            ${reading ? `<div class="bar-mini"><i style="width:${pct}%"></i></div>` : ""}
          </div>${cks ? `<div class="cks">${cks}</div>` : ""}</div>`;
      }).join("") || '<div class="empty">회차가 없어요</div>'}</div>
      ${hidden ? `<p class="muted" style="text-align:center;margin-top:16px"><button class="btn small" id="togglePlanned">${prefs.hidePlanned ? `기획 중인 회차 ${hidden}개 보기` : "기획 중인 회차 숨기기"}</button></p>` : ""}`;
    view.querySelectorAll(".ep").forEach(el => el.onclick = e => {
      if (e.target.closest("[data-ck]")) return;
      location.hash = `/ep/${workId}/${el.dataset.id}`;
    });
    view.querySelectorAll("[data-ck]").forEach(b => b.onclick = e => { e.stopPropagation(); toggleCheck(workId, b.dataset.ep, b.dataset.ck, b); });
    view.querySelectorAll("[data-r]").forEach(el => el.onclick = () => { filter = el.dataset.r; LS.set(`nr.filter.${workId}`, filter); render(work); });
    if ($("#cont")) $("#cont").onclick = () => location.hash = `/ep/${workId}/${lastEp.id}`;
    if ($("#togglePlanned")) $("#togglePlanned").onclick = () => { prefs.hidePlanned = !prefs.hidePlanned; savePrefs(); render(work); };
  };

  setRefresh(async () => {
    const w = await refreshWork(workId, { strict: true });
    if (location.hash.slice(1) === `/work/${workId}`) render(w);
    toast(`노션에서 새로 불러왔어요 · ${w.episodes.length}화`);
  });
  const work = await loadWork(workId);
  render(work);
  const fresh = await refreshWork(workId).catch(() => null);
  if (fresh && location.hash.slice(1) === `/work/${workId}`) render(fresh);
}

/* ---------------- 본문 ---------------- */

async function loadEpisode(epId, { fresh = false } = {}) {
  if (!fresh && state.ep[epId]) return state.ep[epId];
  if (!fresh) {
    const cached = await dataGet(`ep:${epId}`);
    if (cached) { state.ep[epId] = cached; return cached; }
  }
  const r = await api(`/api/episodes/${epId}`);
  state.ep[epId] = r.episode;
  dataSet(`ep:${epId}`, r.episode);
  return r.episode;
}

function runsHtml(runs) {
  return (runs || []).map(r => {
    let h = esc(r.t).replace(/\n/g, "<br>");
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.s) h = `<s>${h}</s>`;
    if (r.u) h = `<u>${h}</u>`;
    return h;
  }).join("");
}

function charColor(work, name) {
  const c = work?.characters?.find(x => x.name === name);
  return NOTION_COLORS[c?.color] || "var(--accent)";
}

function blockHtml(b, i, work) {
  const attr = `data-i="${i}"`;
  switch (b.kind) {
    case "divider": return `<hr ${attr}>`;
    case "scene": return `<div class="scene" ${attr}>${esc(b.plain.replace(/^\s*▌\s*/, ""))}</div>`;
    case "note": return `<p class="note" ${attr}>${runsHtml(b.runs)}</p>`;
    case "heading": return `<h2 ${attr}>${runsHtml(b.runs)}</h2>`;
    case "dialogue": return `<p class="dlg" ${attr}><span class="who" style="color:${charColor(work, b.speaker)}">${esc(b.speaker)}</span>${runsHtml(b.runs)}</p>`;
    default: return `<p class="nar" ${attr}>${runsHtml(b.runs)}</p>`;
  }
}

const reader = { workId: null, epId: null, saveTimer: null, prev: null, next: null };

async function viewReader(workId, epId, jumpBlock = null) {
  reader.workId = workId;
  reader.epId = epId;
  setHeader("", {
    back: `/work/${workId}`,
    actions: `<button class="icon" id="rMarks" aria-label="책갈피">🔖</button><button class="icon" id="rListen" aria-label="듣기">🎧</button><button class="icon" id="rLook" aria-label="글자 설정">Aa</button><button class="icon" id="rReload" aria-label="새로고침">⟳</button>`,
  });
  view.innerHTML = '<div class="empty">불러오는 중…</div>';

  const work = await loadWork(workId).catch(() => null);
  let ep = await loadEpisode(epId);
  renderReader(work, ep, jumpBlock == null, jumpBlock);
  if (jumpBlock != null) { blockEl(jumpBlock)?.classList.add("flash"); history.replaceState(null, "", `#/ep/${workId}/${epId}`); navStack[navStack.length - 1] = curHash(); }
  $("#rMarks").onclick = () => openMarksDialog(workId);
  setTimeout(() => { if (reader.epId === epId) saveReadPos(); }, 600);

  $("#rLook").onclick = openLookPanel;
  $("#rListen").onclick = () => startListening(workId, epId, firstVisibleBlock());
  setRefresh(async () => {
    const fresh = await loadEpisode(epId, { fresh: true });
    renderReader(work, fresh, false, firstVisibleBlock());
    toast("노션에서 새로 불러왔어요");
  }, "#rReload");

  const ctx = LS.get("nr.last", {});
  LS.set("nr.last", { ...ctx, workId, epId, workTitle: work?.title || "", epTitle: ep.title, at: Date.now() });
  LS.set(`nr.lastep.${workId}`, epId);
  queueSync();

  // 노션에서 바뀌었으면 조용히 새로 고침
  if (cfg.apiBase !== "mock") {
    api(`/api/episodes/${epId}`).then(r => {
      if (r.episode.lastEdited !== ep.lastEdited && reader.epId === epId) {
        state.ep[epId] = r.episode;
        dataSet(`ep:${epId}`, r.episode);
        renderReader(work, r.episode, false, firstVisibleBlock());
      }
    }).catch(() => {});
  }
}

function renderReader(work, ep, restore, keepBlock) {
  if (reader.epId !== ep.id) return;
  $("#title").textContent = ep.title;
  const eps = (work?.episodes || []).filter(e => !(prefs.hidePlanned && e.status === "기획") || e.id === ep.id);
  const idx = eps.findIndex(e => e.id === ep.id);
  const prev = idx > 0 ? eps[idx - 1] : null;
  const next = idx >= 0 && idx < eps.length - 1 ? eps[idx + 1] : null;
  reader.prev = prev;
  reader.next = next;
  view.innerHTML = `
    <div class="ep-top">
      <button class="btn small" id="tPrev" ${prev ? "" : "disabled"}>‹ 이전 화</button>
      <button class="btn small" id="tList">목록</button>
      <button class="btn small" id="tNext" ${next ? "" : "disabled"}>다음 화 ›</button>
    </div>
    <article class="reader ${prefs.showNames ? "" : "nonames"}" id="art">
      <h1>${esc(ep.title)}</h1>
      ${ep.blocks.map((b, i) => blockHtml(b, i, work)).join("")}
    </article>
    ${(work?.checks || []).length ? `<div class="ep-checks">${work.checks.map(name => {
      const on = work.episodes.find(e => e.id === ep.id)?.checks?.[name];
      return `<button class="ck big ${on ? "on" : ""}" data-ck="${esc(name)}" data-ep="${ep.id}"><b></b><span>${esc(name)}</span></button>`;
    }).join("")}</div>` : ""}
    <div class="ep-nav">
      <button class="btn" id="pPrev" ${prev ? "" : "disabled"}>◀ 이전 화</button>
      <button class="btn primary" id="pNext" ${next ? "" : "disabled"}>다음 화 ▶</button>
    </div>`;
  if (prev) $("#pPrev").onclick = $("#tPrev").onclick = () => goEp("prev");
  if (next) $("#pNext").onclick = $("#tNext").onclick = () => goEp("next");
  $("#tList").onclick = () => goEp("list");
  view.querySelectorAll(".ep-checks [data-ck]").forEach(b => b.onclick = () => toggleCheck(reader.workId, b.dataset.ep, b.dataset.ck, b));
  $("#art").onclick = onArticleTap;

  if (keepBlock != null) scrollToBlock(keepBlock, false);
  else if (restore) {
    const pos = LS.get(`nr.pos.${ep.id}`, null);
    if (pos?.block > 0) scrollToBlock(pos.block, false);
  }
  if (player.epId === ep.id) markSpeaking(player.curBlock, false);
  paintMarks();
}

function blockEl(i) { return document.querySelector(`#art [data-i="${i}"]`); }

function scrollToBlock(i, smooth = true) {
  const el = blockEl(i);
  if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.3;
  window.scrollTo({ top: Math.max(0, y), behavior: smooth ? "smooth" : "auto" });
}

function firstVisibleBlock() {
  const els = document.querySelectorAll("#art [data-i]");
  for (const el of els) if (el.getBoundingClientRect().bottom > 70) return Number(el.dataset.i);
  return 0;
}

// 읽은 위치 저장. 한 번 연 회차는 스크롤하지 않아도 "몇 % 읽음"이 남는다.
// 퍼센트는 지금까지 가장 많이 읽은 값을 남기고(위로 다시 올려도 줄지 않게), 위치는 지금 위치.
function saveReadPos() {
  if (!$("#art") || !reader.epId) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const pct = Math.round(max > 0 ? (window.scrollY / max) * 100 : 100);
  const prev = LS.get(`nr.pos.${reader.epId}`, {});
  LS.set(`nr.pos.${reader.epId}`, { ...prev, block: firstVisibleBlock(), pct: Math.max(pct, prev.pct || 0), at: Date.now() });
  if (pct > 97) markRead(reader.epId);
  queueSync();
}

// 스크롤: 읽은 위치 저장, 진행 막대, 위쪽 바 숨기기
let lastY = 0;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  if (!reader.epId || !$("#art")) { lastY = y; return; }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const pct = max > 0 ? (y / max) * 100 : 100;
  setProgress(pct);
  if (Math.abs(y - lastY) > 8) {
    $("#top").classList.toggle("hide", y > lastY && y > 120);
    $("#epnav")?.classList.remove("show");
  }
  lastY = y;
  hideBubble();
  userScrolledAt = Date.now();
  clearTimeout(reader.saveTimer);
  reader.saveTimer = setTimeout(saveReadPos, 400);
}, { passive: true });

/* ---------------- 글자 설정 ---------------- */

function openLookPanel() {
  const seg = (key, items) => `<div class="seg">${Object.entries(items).map(([k, v]) => `<button data-k="${key}" data-v="${k}" class="${String(prefs[key]) === k ? "on" : ""}">${v}</button>`).join("")}</div>`;
  const d = openDialog(`
    <div class="stack">
      <h3>글자 · 화면</h3>
      <div class="field"><label>글자 크기</label><div class="stepper"><button class="btn small" data-step="fontSize:-1">가−</button><b id="vFs">${prefs.fontSize}</b><button class="btn small" data-step="fontSize:1">가+</button></div></div>
      <div class="field"><label>줄 간격</label><div class="stepper"><button class="btn small" data-step="lineHeight:-0.1">좁게</button><b id="vLh">${prefs.lineHeight.toFixed(1)}</b><button class="btn small" data-step="lineHeight:0.1">넓게</button></div></div>
      <div class="field"><label>글꼴</label>${seg("font", Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.label])))}</div>
      <div class="field"><label>배경</label>${seg("theme", THEMES)}</div>
      <div class="field"><label>대사 위에 이름</label>${seg("showNames", { true: "보이기", false: "숨기기" })}</div>
      <div class="row end"><button class="btn primary" data-close>닫기</button></div>
    </div>`);
  d.querySelectorAll("[data-step]").forEach(b => b.onclick = () => {
    const [k, v] = b.dataset.step.split(":");
    const lim = k === "fontSize" ? [13, 30] : [1.4, 2.6];
    prefs[k] = Math.round(Math.min(lim[1], Math.max(lim[0], prefs[k] + Number(v))) * 10) / 10;
    savePrefs(); applyLook();
    $("#vFs").textContent = prefs.fontSize;
    $("#vLh").textContent = prefs.lineHeight.toFixed(1);
  });
  d.querySelectorAll(".seg button").forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    prefs[k] = k === "showNames" ? b.dataset.v === "true" : b.dataset.v;
    savePrefs(); applyLook();
    b.parentElement.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    $("#art")?.classList.toggle("nonames", !prefs.showNames);
  });
}

/* ---------------- 문단 눌렀을 때: 듣기 · 고치기 · 메모 ---------------- */

let picked = null;
// 본문을 누르면 위쪽 바와 함께 "몇 화 | 제목 · 작품 · 읽은 %"를 잠깐 보여 준다
let infoTimer;
function showEpInfo() {
  const ep = state.ep[reader.epId];
  if (!ep) return;
  $("#top").classList.remove("hide");
  const work = state.work[reader.workId];
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const pct = max > 0 ? Math.round((window.scrollY / max) * 100) : 100;
  let pill = $("#epinfo");
  if (!pill) { pill = document.createElement("div"); pill.id = "epinfo"; document.body.appendChild(pill); }
  pill.innerHTML = `<b>${esc(ep.title)}</b><span>${esc(work?.title || "")}${work?.title ? " · " : ""}${pct}% 읽음</span>`;
  pill.classList.add("show");
  clearTimeout(infoTimer);
  showEpNav();
  infoTimer = setTimeout(() => { pill.classList.remove("show"); $("#epnav")?.classList.remove("show"); }, 3500);
}

function goEp(where) {
  if (where === "list") goUp(`/work/${reader.workId}`);
  else if (reader[where]) go(`/ep/${reader.workId}/${reader[where].id}`, { replace: true });
}

// 본문을 누르면 아래쪽에 "이전 화 · 목록 · 다음 화"가 잠깐 뜬다
function showEpNav() {
  let nav = $("#epnav");
  if (!nav) {
    nav = document.createElement("div");
    nav.id = "epnav";
    nav.onclick = e => {
      const b = e.target.closest("[data-go]");
      if (!b) return;
      e.stopPropagation();
      nav.classList.remove("show");
      goEp(b.dataset.go);
    };
    document.body.appendChild(nav);
  }
  nav.innerHTML = `
    <button data-go="prev" ${reader.prev ? "" : "disabled"}>‹ 이전 화</button>
    <button data-go="list">목록</button>
    <button data-go="next" ${reader.next ? "" : "disabled"}>다음 화 ›</button>`;
  nav.classList.toggle("above", !$("#player").hidden);
  nav.classList.add("show");
}

function onArticleTap(e) {
  if (window.getSelection()?.toString()) return;
  showEpInfo();
  const el = e.target.closest("[data-i]");
  if (!el || el.tagName === "HR") return hideBubble();
  const i = Number(el.dataset.i);
  if (picked === i) return hideBubble();
  showBubble(el, i);
}

function showBubble(el, i) {
  hideBubble();
  picked = i;
  el.classList.add("picked");
  const ep = state.ep[reader.epId];
  const b = ep.blocks[i];
  const canEdit = b.kind !== "divider";
  const bub = $("#bubble");
  bub.innerHTML = `
    <button data-a="listen">▶ 여기서부터 듣기</button>
    <button data-a="mark">${markAt(i) ? "🔖 책갈피 빼기" : "🔖 책갈피"}</button>
    ${canEdit ? '<button data-a="edit">✏️ 고치기</button><button data-a="memo">💬 메모</button>' : ""}`;
  bub.hidden = false;
  const r = el.getBoundingClientRect();
  const top = r.top + window.scrollY - bub.offsetHeight - 8;
  bub.style.top = `${top < window.scrollY + 60 ? r.bottom + window.scrollY + 8 : top}px`;
  bub.style.left = `${Math.max(8, Math.min(window.innerWidth - bub.offsetWidth - 8, r.left + r.width / 2 - bub.offsetWidth / 2))}px`;
  bub.querySelectorAll("button").forEach(btn => btn.onclick = ev => {
    ev.stopPropagation();
    hideBubble();
    if (btn.dataset.a === "listen") startListening(reader.workId, reader.epId, i);
    if (btn.dataset.a === "edit") openEditDialog(i);
    if (btn.dataset.a === "memo") openMemoDialog(i);
    if (btn.dataset.a === "mark") toggleMark(i);
  });
}

function hideBubble() {
  $("#bubble").hidden = true;
  document.querySelectorAll(".picked").forEach(x => x.classList.remove("picked"));
  picked = null;
}

function openEditDialog(i) {
  const epId = reader.epId;
  const ep = state.ep[epId];
  const b = ep.blocks[i];
  const prefix = b.plain.slice(0, b.prefixLen || 0);
  const body = b.plain.slice(b.prefixLen || 0);
  const kindLabel = b.kind === "dialogue" ? `${b.speaker}의 대사` : b.kind === "scene" ? "장면 머리말" : "서술";
  const d = openDialog(`
    <div class="stack">
      <h3>오타 고치기</h3>
      <p class="muted">${esc(kindLabel)} · 저장하면 노션에 바로 반영돼요. 굵게·기울임은 고친 부분만 앞 글자 서식을 따라가요.</p>
      <textarea id="eText">${esc(body)}</textarea>
      <div class="row end"><button class="btn" data-close>취소</button><button class="btn primary" id="eSave">저장</button></div>
    </div>`);
  const ta = $("#eText", d);
  ta.focus();
  $("#eSave", d).onclick = async () => {
    const newPlain = prefix + ta.value.replace(/\r/g, "");
    if (newPlain === b.plain) return d.close();
    $("#eSave", d).disabled = true;
    try {
      const r = await api(`/api/blocks/${b.id}`, { method: "PATCH", body: { oldText: b.plain, newText: newPlain } });
      if (r.block) ep.blocks[i] = r.block; else ep.blocks.splice(i, 1);
      dataSet(`ep:${epId}`, ep);
      d.close();
      toast("노션에 고쳐 두었어요");
      if (reader.epId === epId) renderReader(state.work[reader.workId], ep, false, i);
    } catch (e) {
      $("#eSave", d).disabled = false;
      toast(e.message, 4000);
    }
  };
}

function openMemoDialog(i) {
  const epId = reader.epId;
  const b = state.ep[epId].blocks[i];
  const snippet = (b.plain || "").slice(0, 120);
  const d = openDialog(`
    <div class="stack">
      <h3>메모 남기기</h3>
      <p class="muted">이 회차 노션 페이지에 댓글로 남겨요. 나중에 노션에서 한꺼번에 고칠 때 좋아요.</p>
      <div class="quote">${esc(snippet)}${b.plain.length > 120 ? "…" : ""}</div>
      <textarea id="mText" placeholder="예: '갈색'을 '회갈색'으로" style="min-height:90px"></textarea>
      <div class="row end"><button class="btn" data-close>취소</button><button class="btn primary" id="mSave">남기기</button></div>
    </div>`);
  $("#mText", d).focus();
  $("#mSave", d).onclick = async () => {
    const memo = $("#mText", d).value.trim();
    if (!memo) return toast("메모를 적어 주세요.");
    $("#mSave", d).disabled = true;
    try {
      await api("/api/comments", { method: "POST", body: { pageId: epId, text: `✏️ 수정 메모\n「${snippet}」\n→ ${memo}` } });
      d.close();
      toast("노션에 메모를 남겼어요");
    } catch (e) {
      $("#mSave", d).disabled = false;
      toast(e.message, 4000);
    }
  };
}

/* =========================================================
   듣기
   - cloud: 문단별 mp3를 Worker에서 받아 한 파일로 이어 붙여 <audio>로 재생
            (화면을 꺼도 계속 재생, 잠금화면 조작 가능)
   - browser: 기기의 음성 합성(speechSynthesis). 무료지만 화면을 끄면 멈출 수 있음
========================================================= */

const player = {
  mode: null, workId: null, epId: null, segs: [], meta: null, url: null,
  index: 0, curBlock: -1, playing: false, token: 0, timer: null,
  sleepAt: 0, sleepEp: false, prefetched: {},
};
let userScrolledAt = 0;

function splitText(text, max) {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?…。]+[.!?…。]*["”’」』)]*\s*/g) || [text];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { out.push(cur.trim()); cur = ""; }
    if (s.length > max) {
      for (let k = 0; k < s.length; k += max) out.push(s.slice(k, k + max).trim());
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function voiceFor(b, vs) {
  if (!vs) return null;
  if (b.kind === "dialogue") return vs.characters?.[b.speaker] || vs.dialogue || vs.narrator;
  return vs.narrator;
}

function browserVoiceSettings(workId) {
  return LS.get(`nr.bv.${workId}`, { narrator: "", dialogue: "", pitch: {} });
}

const AUTO_PITCH = [1.15, 0.85, 1.3, 0.75, 1.05, 0.95, 1.22, 0.8];
function pitchFor(b, bv, work) {
  if (b.kind !== "dialogue") return 1;
  if (bv.pitch?.[b.speaker] != null) return bv.pitch[b.speaker];
  const idx = (work?.characters || []).findIndex(c => c.name === b.speaker);
  return AUTO_PITCH[(idx >= 0 ? idx : b.speaker.length) % AUTO_PITCH.length];
}

function buildSegments(ep, mode, vs, bv, work) {
  const segs = [];
  let pause = 0;
  ep.blocks.forEach((b, bi) => {
    if (b.kind === "divider") { pause = Math.max(pause, 1.1); return; }
    if (b.kind === "scene") { pause = Math.max(pause, 0.8); return; }
    if (!b.speak) return;
    const parts = splitText(b.speak, mode === "cloud" ? 1500 : 220);
    parts.forEach((text, k) => {
      const prevKind = segs[segs.length - 1]?.kind;
      const gap = k > 0 ? 0.1 : Math.max(pause, prevKind && prevKind !== b.kind ? 0.45 : 0.35);
      const seg = { bi, text, kind: b.kind, speaker: b.speaker || "", gap };
      if (mode === "cloud") Object.assign(seg, voiceFor(b, vs) || {});
      else seg.pitch = pitchFor(b, bv, work);
      segs.push(seg);
      pause = 0;
    });
  });
  if (segs[0]) segs[0].gap = 0.2;
  return segs;
}

async function getVoiceSettings(workId) {
  if (cfg.apiBase === "mock") return LS.get(`nr.vs.${workId}`, null);
  try {
    const r = await api(`/api/settings/${workId}`);
    LS.set(`nr.vs.${workId}`, r.settings);
    return r.settings;
  } catch {
    return LS.get(`nr.vs.${workId}`, null);
  }
}

async function getEngines() {
  if (state.engines) return state.engines;
  try { state.engines = (await api("/api/ping")).engines; LS.set("nr.engines", state.engines); }
  catch { state.engines = LS.get("nr.engines", {}); }
  return state.engines;
}

async function decideMode(workId) {
  if (prefs.mode === "browser") return { mode: "browser" };
  const engines = await getEngines();
  const any = engines && Object.values(engines).some(Boolean);
  const vs = any ? await getVoiceSettings(workId) : null;
  if (vs?.narrator) return { mode: "cloud", vs };
  if (prefs.mode === "cloud") {
    toast(any ? "이 작품의 목소리를 먼저 정해 주세요. 지금은 브라우저 음성으로 읽어요." : "Worker에 TTS 키가 없어서 브라우저 음성으로 읽어요.", 4000);
  }
  return { mode: "browser" };
}

async function startListening(workId, epId, fromBlock = null, { autoplay = true, forceMode = null } = {}) {
  stopPlayback(false);
  const token = ++player.token;
  const work = await loadWork(workId).catch(() => null);
  const ep = await loadEpisode(epId);
  const decided = forceMode ? { mode: forceMode, vs: forceMode === "cloud" ? await getVoiceSettings(workId) : null } : await decideMode(workId);
  const bv = browserVoiceSettings(workId);
  Object.assign(player, { mode: decided.mode, workId, epId, work, ep, index: 0, curBlock: -1, meta: null, sleepEp: player.sleepEp });
  player.segs = buildSegments(ep, decided.mode, decided.vs, bv, work);
  if (!player.segs.length) return toast("읽을 글이 없어요.");

  const saved = LS.get(`nr.pos.${epId}`, {});
  const startBlock = fromBlock ?? saved.listenBlock ?? saved.block ?? 0;
  let startIdx = player.segs.findIndex(s => s.bi >= startBlock);
  if (startIdx < 0) startIdx = 0;

  showPlayer();
  setMediaSession();

  if (decided.mode === "browser") {
    player.index = startIdx;
    setStatus("브라우저 음성");
    if (autoplay) browserPlay();
    else updatePlayButton();
    return;
  }

  try {
    setStatus("음성 준비 중…");
    const meta = await prepareCloud(ep, player.segs, decided.vs, (done, total, phase) => {
      if (token === player.token) setStatus(`${phase === "make" ? "음성 만드는 중" : "받는 중"} ${done}/${total}`);
    });
    if (token !== player.token) return;
    player.meta = meta;
    if (player.url) URL.revokeObjectURL(player.url);
    player.url = URL.createObjectURL(meta.blob);
    audio.src = player.url;
    audio.playbackRate = prefs.speed;
    audio.preservesPitch = true;
    const t = fromBlock == null && saved.listenTime ? saved.listenTime : meta.starts[startIdx] || 0;
    await new Promise(r => { audio.onloadedmetadata = r; setTimeout(r, 1500); });
    audio.currentTime = Math.max(0, t - 0.15);
    setStatus(meta.refused ? `거절된 대사 ${meta.refused}줄은 대신 읽어요` : "");
    if (autoplay) await audio.play().catch(() => updatePlayButton());
    updatePlayButton();
  } catch (e) {
    if (token !== player.token) return;
    setStatus("멈춤");
    cloudFailed(e, workId, epId, startBlock);
  }
}

function cloudFailed(e, workId, epId, fromBlock) {
  const quota = e.code === "QUOTA";
  openDialog(`
    <div class="stack">
      <h3>${quota ? "이번 달 무료 한도" : "음성을 만들지 못했어요"}</h3>
      <p>${esc(e.message)}</p>
      ${quota ? '<p class="muted">이미 만든 부분은 저장돼 있어서, 다음 달에 이어서 만들면 돼요. 그동안은 브라우저 음성으로 들을 수 있어요(화면을 끄면 멈출 수 있어요).</p>' : ""}
      <div class="row end"><button class="btn" data-close>닫기</button><button class="btn primary" id="fbBrowser">브라우저 음성으로 듣기</button></div>
    </div>`, d => {
    $("#fbBrowser", d).onclick = () => { d.close(); startListening(workId, epId, fromBlock, { forceMode: "browser" }); };
  });
}

/* ---------- 클라우드 음성 만들기 ---------- */

async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function pool(items, size, fn) {
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch (e) { failed = failed || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failed) throw failed;
}

async function ttsOnce(engine, voice, text) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await api("/api/tts", { method: "POST", body: { engine, voice, text } })).key;
    } catch (e) {
      if (e.code === "RATE" && attempt < 4) { await sleep(1500 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

async function chunkBytes(key) {
  const c = await caches.open("nr-chunks");
  const url = `/__chunk/${key}`;
  let r = await c.match(url);
  if (!r) {
    const res = await api(`/api/chunk/${key}`, { raw: true });
    await c.put(url, res.clone());
    r = res;
  }
  return new Uint8Array(await r.arrayBuffer());
}

async function audioCacheGet(epId, sig) {
  const meta = LS.get(`nr.am.${epId}`, null);
  if (!meta || meta.sig !== sig) return null;
  const c = await caches.open("nr-audio");
  const r = await c.match(`/__audio/${epId}`);
  if (!r) return null;
  return { ...meta, blob: await r.blob() };
}

async function audioCacheSet(epId, blob, meta) {
  const c = await caches.open("nr-audio");
  await c.put(`/__audio/${epId}`, new Response(blob, { headers: { "Content-Type": "audio/mpeg" } }));
  LS.set(`nr.am.${epId}`, meta);
}

async function prepareCloud(ep, segs, vs, onProgress = () => {}) {
  if (cfg.apiBase === "mock") throw new Error("예시 모드에서는 클라우드 음성을 쓸 수 없어요.");
  const missing = segs.find(s => !s.engine || !s.voice);
  if (missing) throw new Error("목소리가 정해지지 않은 부분이 있어요. 목소리 설정을 확인해 주세요.");
  const sig = await sha1(JSON.stringify(segs.map(s => [s.engine, s.voice, s.text, s.gap])));
  const cached = await audioCacheGet(ep.id, sig);
  if (cached) return cached;

  const keys = [];
  let done = 0;
  let refused = 0;
  await pool(segs, 3, async (s, i) => {
    try {
      keys[i] = await ttsOnce(s.engine, s.voice, s.text);
    } catch (e) {
      if (e.code !== "REFUSED") throw e;
      const fb = vs?.fallback || vs?.narrator;
      if (!fb || (fb.engine === s.engine && fb.voice === s.voice)) throw e;
      keys[i] = await ttsOnce(fb.engine, fb.voice, s.text);
      refused++;
    }
    onProgress(++done, segs.length, "make");
  });

  const bytes = [];
  done = 0;
  await pool(keys, 4, async (k, i) => { bytes[i] = await chunkBytes(k); onProgress(++done, keys.length, "down"); });
  const { blob, starts, ends, duration } = assemble(segs.map((s, i) => ({ bytes: bytes[i], gap: s.gap })));
  const meta = { sig, starts, ends, duration, refused };
  await audioCacheSet(ep.id, blob, meta);
  return { ...meta, blob };
}

/* ---------- 브라우저 음성 ---------- */

let sysVoices = [];
function loadSysVoices() {
  if (!("speechSynthesis" in window)) return [];
  sysVoices = speechSynthesis.getVoices().filter(v => /^ko/i.test(v.lang));
  return sysVoices;
}
if ("speechSynthesis" in window) {
  loadSysVoices();
  speechSynthesis.onvoiceschanged = loadSysVoices;
}

function pickSysVoice(seg, bv) {
  const uri = seg.kind === "dialogue" ? (bv.dialogue || bv.narrator) : bv.narrator;
  return sysVoices.find(v => v.voiceURI === uri) || sysVoices[0] || null;
}

function browserPlay() {
  if (!("speechSynthesis" in window)) return toast("이 브라우저는 음성 읽기를 지원하지 않아요.");
  speechSynthesis.cancel();
  player.playing = true;
  updatePlayButton();
  const tok = ++player.token;
  const bv = browserVoiceSettings(player.workId);
  const step = () => {
    if (tok !== player.token || !player.playing) return;
    if (checkSleep()) return;
    const s = player.segs[player.index];
    if (!s) return onEpisodeEnd();
    onSegment(player.index);
    player.timer = setTimeout(() => {
      if (tok !== player.token) return;
      const u = new SpeechSynthesisUtterance(s.text);
      u.lang = "ko-KR";
      const v = pickSysVoice(s, bv);
      if (v) u.voice = v;
      u.rate = prefs.speed;
      u.pitch = s.pitch || 1;
      const next = () => { if (tok !== player.token) return; player.index++; step(); };
      u.onend = next;
      u.onerror = ev => { if (ev.error === "interrupted" || ev.error === "canceled") return; next(); };
      speechSynthesis.speak(u);
    }, (s.gap * 1000) / prefs.speed);
  };
  step();
}

function browserPause() {
  player.playing = false;
  player.token++;
  clearTimeout(player.timer);
  speechSynthesis.cancel();
  updatePlayButton();
}

/* ---------- 재생 공통 ---------- */

function showPlayer() {
  $("#player").hidden = false;
  $("#plTitle").textContent = player.ep?.title || "";
  updatePlayButton();
}

function setStatus(s) {
  const extra = player.sleepAt ? ` · ⏾ ${Math.max(0, Math.ceil((player.sleepAt - Date.now()) / 60000))}분` : player.sleepEp ? " · ⏾ 이 화까지" : "";
  $("#plStatus").textContent = (s || (player.mode === "browser" ? "브라우저 음성" : "")) + extra;
}

function isPlaying() {
  return player.mode === "cloud" ? !audio.paused : player.playing;
}

function updatePlayButton() {
  $("#plPlay").textContent = isPlaying() ? "❚❚" : "▶";
  $("#plSpeed").textContent = `${Number.isInteger(prefs.speed) ? prefs.speed.toFixed(1) : prefs.speed}×`;
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying() ? "playing" : "paused";
}

function togglePlay() {
  if (!player.epId) {
    if (reader.epId) startListening(reader.workId, reader.epId, firstVisibleBlock());
    return;
  }
  if (player.mode === "cloud") {
    if (!audio.src) return;
    if (audio.paused) audio.play(); else audio.pause();
  } else {
    if (player.playing) browserPause(); else browserPlay();
  }
}

function stopPlayback(hide = true) {
  player.token++;
  clearTimeout(player.timer);
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  player.playing = false;
  audio.pause();
  if (hide) {
    $("#player").hidden = true;
    markSpeaking(-1);
    player.epId = null;
  }
}

function seekBy(sec) {
  if (player.mode === "cloud") {
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + sec));
  } else {
    player.index = Math.max(0, Math.min(player.segs.length - 1, player.index + (sec > 0 ? 1 : -1)));
    if (player.playing) browserPlay(); else onSegment(player.index);
  }
}

function onSegment(idx) {
  const s = player.segs[idx];
  if (!s) return;
  player.index = idx;
  if (s.bi !== player.curBlock) markSpeaking(s.bi, true);
  const pos = LS.get(`nr.pos.${player.epId}`, {});
  pos.listenBlock = s.bi;
  if (player.mode === "cloud") pos.listenTime = audio.currentTime;
  LS.set(`nr.pos.${player.epId}`, pos);
  if (player.mode === "browser") $("#plBar").style.width = `${(idx / player.segs.length) * 100}%`;
}

function markSpeaking(bi, follow = true) {
  player.curBlock = bi;
  document.querySelectorAll(".speaking").forEach(x => x.classList.remove("speaking"));
  if (reader.epId !== player.epId || bi < 0) return;
  const el = blockEl(bi);
  if (!el) return;
  el.classList.add("speaking");
  if (follow && prefs.follow && Date.now() - userScrolledAt > 4000) {
    const r = el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight - 120) {
      scrollToBlock(bi);
      setTimeout(() => { userScrolledAt = 0; }, 800);
    }
  }
}

function segAtTime(t) {
  const st = player.meta?.starts || [];
  let lo = 0, hi = st.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (st[mid] <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

audio.addEventListener("timeupdate", () => {
  if (player.mode !== "cloud" || !player.meta) return;
  const t = audio.currentTime;
  const idx = segAtTime(t);
  if (idx !== player.index || player.curBlock < 0) onSegment(idx);
  const d = player.meta.duration || audio.duration || 1;
  $("#plBar").style.width = `${(t / d) * 100}%`;
  if (!$("#plStatus").dataset.lock) setStatus(`${fmtTime(t / 1)} / ${fmtTime(d)}`);
  checkSleep();
  maybePrefetch(t / d);
  if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && isFinite(d)) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: audio.playbackRate }); } catch { /* 무시 */ }
  }
});
audio.addEventListener("play", updatePlayButton);
audio.addEventListener("pause", updatePlayButton);
audio.addEventListener("ended", () => { if (player.mode === "cloud") onEpisodeEnd(); });

function nextEpisodeOf(workId, epId) {
  const work = state.work[workId];
  if (!work) return null;
  const eps = work.episodes.filter(e => !(prefs.hidePlanned && e.status === "기획"));
  const i = eps.findIndex(e => e.id === epId);
  return i >= 0 ? eps[i + 1] || null : null;
}

function onEpisodeEnd() {
  const { workId, epId } = player;
  markRead(epId);
  queueSync();
  const pos = LS.get(`nr.pos.${epId}`, {});
  delete pos.listenBlock; delete pos.listenTime;
  LS.set(`nr.pos.${epId}`, pos);
  player.playing = false;
  updatePlayButton();
  if (player.sleepEp) { player.sleepEp = false; setStatus("⏾ 이 화까지 듣고 멈췄어요"); return; }
  const next = prefs.autoNext ? nextEpisodeOf(workId, epId) : null;
  if (!next) { setStatus("끝까지 들었어요"); return; }
  if (reader.epId === epId) go(`/ep/${workId}/${next.id}`, { replace: true });
  startListening(workId, next.id, 0);
}

async function maybePrefetch(ratio) {
  if (ratio < 0.3 || player.mode !== "cloud") return;
  const next = nextEpisodeOf(player.workId, player.epId);
  if (!next || player.prefetched[next.id]) return;
  player.prefetched[next.id] = true;
  try {
    const ep = await loadEpisode(next.id);
    const vs = await getVoiceSettings(player.workId);
    if (!vs?.narrator) return;
    const segs = buildSegments(ep, "cloud", vs, null, player.work);
    await prepareCloud(ep, segs, vs);
  } catch { /* 다음 화는 들을 때 다시 시도 */ }
}

function checkSleep() {
  if (player.sleepAt && Date.now() >= player.sleepAt) {
    player.sleepAt = 0;
    if (player.mode === "cloud") audio.pause(); else browserPause();
    setStatus("⏾ 타이머로 멈췄어요");
    return true;
  }
  return false;
}

function setMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: player.ep?.title || "",
    artist: player.work?.title || "소설 서재",
    album: "소설 서재",
    artwork: [{ src: new URL("icon-512.png", location.href).href, sizes: "512x512", type: "image/png" }],
  });
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* 지원 안 함 */ } };
  set("play", () => togglePlay());
  set("pause", () => togglePlay());
  set("seekbackward", () => seekBy(-15));
  set("seekforward", () => seekBy(15));
  set("seekto", d => { if (player.mode === "cloud" && d.seekTime != null) audio.currentTime = d.seekTime; });
  set("nexttrack", () => { const n = nextEpisodeOf(player.workId, player.epId); if (n) startListening(player.workId, n.id, 0); });
  set("previoustrack", () => {
    const s = player.segs[player.index];
    const prev = player.segs.findLastIndex((x, i) => i < player.index && x.bi !== s?.bi);
    if (player.mode === "cloud") audio.currentTime = player.meta.starts[Math.max(0, prev)] || 0;
    else { player.index = Math.max(0, prev); if (player.playing) browserPlay(); }
  });
}

$("#plPlay").onclick = togglePlay;
$("#plBack").onclick = () => seekBy(-15);
$("#plFwd").onclick = () => seekBy(15);
$("#plSpeed").onclick = () => {
  const steps = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  prefs.speed = steps[(steps.indexOf(prefs.speed) + 1) % steps.length] || 1;
  savePrefs();
  audio.playbackRate = prefs.speed;
  if (player.mode === "browser" && player.playing) browserPlay();
  updatePlayButton();
};
$(".pl-bar").onclick = e => {
  if (player.mode !== "cloud" || !player.meta) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * player.meta.duration;
};
$(".pl-info").onclick = e => {
  if (e.target.closest(".pl-bar")) return;
  if (player.epId && reader.epId !== player.epId) go(`/ep/${player.workId}/${player.epId}`, { replace: onEpRoute() });
  else if (player.curBlock >= 0) { userScrolledAt = 0; scrollToBlock(player.curBlock); }
};
$("#plMore").onclick = () => {
  const seg = (name, items, cur) => `<div class="seg">${items.map(([v, l]) => `<button data-n="${name}" data-v="${v}" class="${String(cur) === String(v) ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const sleepCur = player.sleepEp ? "ep" : player.sleepAt ? "on" : "0";
  const d = openDialog(`
    <div class="stack">
      <h3>듣기 설정</h3>
      <div class="field"><label>수면 타이머</label>${seg("sleep", [["0", "끄기"], ["15", "15분"], ["30", "30분"], ["60", "1시간"], ["ep", "이 화까지"]], sleepCur === "on" ? "" : sleepCur)}</div>
      <div class="field"><label>목소리</label>${seg("mode", [["auto", "자동"], ["cloud", "클라우드"], ["browser", "브라우저"]], prefs.mode)}<p class="muted" style="margin:6px 0 0">자동: 목소리를 정해 둔 작품은 클라우드 음성, 아니면 브라우저 음성</p></div>
      <div class="field"><label>다 들으면 다음 화</label>${seg("autoNext", [["true", "이어서 듣기"], ["false", "멈추기"]], prefs.autoNext)}</div>
      <div class="field"><label>읽는 곳 따라가기</label>${seg("follow", [["true", "켜기"], ["false", "끄기"]], prefs.follow)}</div>
      <div class="row end"><button class="btn" id="plStop">듣기 끝내기</button><button class="btn primary" data-close>닫기</button></div>
    </div>`);
  d.querySelectorAll(".seg button").forEach(b => b.onclick = () => {
    const { n, v } = b.dataset;
    b.parentElement.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    if (n === "sleep") {
      player.sleepEp = v === "ep";
      player.sleepAt = v !== "ep" && v !== "0" ? Date.now() + Number(v) * 60000 : 0;
      setStatus("");
      toast(v === "0" ? "타이머를 껐어요" : v === "ep" ? "이 화까지 듣고 멈춰요" : `${v}분 뒤에 멈춰요`);
    } else if (n === "mode") {
      prefs.mode = v; savePrefs();
      if (player.epId) startListening(player.workId, player.epId, player.curBlock >= 0 ? player.curBlock : null, { autoplay: isPlaying() });
    } else {
      prefs[n] = v === "true"; savePrefs();
    }
  });
  $("#plStop", d).onclick = () => { d.close(); stopPlayback(true); };
};
setInterval(() => { if (player.sleepAt && isPlaying()) { checkSleep(); if (player.mode === "browser") setStatus(""); } }, 15000);

/* ---------------- 목소리 설정 ---------------- */

async function voiceList(engine) {
  if (state.voiceLists[engine]) return state.voiceLists[engine];
  const r = await api(`/api/voices?engine=${engine}`);
  state.voiceLists[engine] = r.voices;
  return r.voices;
}

async function viewVoices(workId) {
  setHeader("목소리", { back: `/work/${workId}` });
  view.innerHTML = '<div class="empty">불러오는 중…</div>';
  const work = await loadWork(workId);
  $("#title").textContent = `${work.title} · 목소리`;
  const engines = await getEngines();
  const available = Object.entries(engines || {}).filter(([, on]) => on).map(([k]) => k);
  const vs = (await getVoiceSettings(workId)) || { narrator: null, dialogue: null, fallback: null, characters: {} };
  const bv = browserVoiceSettings(workId);

  const rows = [
    { key: "narrator", name: "서술 (내레이션)", hint: "회색 글씨 부분", required: true },
    ...work.characters.map(c => ({ key: `c:${c.name}`, name: c.name, color: NOTION_COLORS[c.color] })),
    { key: "dialogue", name: "그 밖의 인물 대사", hint: "비워 두면 서술 목소리" },
    { key: "fallback", name: "대사가 거절됐을 때", hint: "ElevenLabs가 거절한 줄만 이 목소리로 (비워 두면 서술 목소리)" },
  ];
  const getV = key => key.startsWith("c:") ? vs.characters?.[key.slice(2)] : vs[key];

  const usageHtml = await usageBlock().catch(() => "");
  const cloudHtml = available.length ? `
    <h2 class="sec">클라우드 음성 · 화면을 꺼도 들려요</h2>
    <div class="card">${usageHtml}
      <p class="muted">인물마다 엔진과 목소리를 골라요. 대사만 ElevenLabs로 읽고 서술은 Google로 읽는 식으로 섞어 쓸 수 있어요. ▶ 미리 듣기도 무료 한도에서 조금 빠져요.</p>
      ${rows.map(r => `
        <div class="voice-row" data-key="${esc(r.key)}">
          <div class="who-name">${r.color ? `<span class="dot" style="background:${r.color}"></span>` : ""}${esc(r.name)} ${r.hint ? `<span class="muted">${esc(r.hint)}</span>` : ""}</div>
          <div class="sel">
            <select class="eng"><option value="">${r.required ? "엔진 선택" : r.key.startsWith("c:") ? "그 밖의 인물과 같게" : "서술과 같게"}</option>${available.map(e => `<option value="${e}" ${getV(r.key)?.engine === e ? "selected" : ""}>${ENGINE_LABEL[e]}</option>`).join("")}</select>
            <select class="voi"><option value="">—</option></select>
            <button class="btn small try" title="미리 듣기">▶</button>
          </div>
        </div>`).join("")}
      <div class="row end" style="margin-top:14px"><button class="btn primary" id="vsSave">저장</button></div>
    </div>` : `
    <h2 class="sec">클라우드 음성</h2>
    <div class="card muted">Worker에 TTS API 키를 넣으면 여기서 인물별 목소리를 고를 수 있어요. 그 전에는 브라우저 음성으로 읽어요.</div>`;

  const sysOpts = sel => `<option value="">기본 목소리</option>${loadSysVoices().map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === sel ? "selected" : ""}>${esc(v.name)}</option>`).join("")}`;
  const browserHtml = `
    <h2 class="sec">브라우저 음성 · 무료, 이 기기에만 저장</h2>
    <div class="card">
      <p class="muted">기기에 깔린 한국어 목소리로 읽어요. 목소리가 1~2개뿐인 기기가 많아서 인물마다 높낮이를 다르게 해서 구분해요. 휴대폰에서는 화면을 끄면 멈출 수 있어요.</p>
      <div class="voice-row"><div class="who-name">서술</div><div class="sel two"><select id="bvN">${sysOpts(bv.narrator)}</select><button class="btn small" data-btry="narr">▶</button></div></div>
      <div class="voice-row"><div class="who-name">대사</div><div class="sel two"><select id="bvD">${sysOpts(bv.dialogue)}</select><button class="btn small" data-btry="dlg">▶</button></div></div>
      ${work.characters.map((c, i) => {
        const p = bv.pitch?.[c.name] ?? AUTO_PITCH[i % AUTO_PITCH.length];
        return `<div class="voice-row"><div class="who-name"><span class="dot" style="background:${NOTION_COLORS[c.color]}"></span>${esc(c.name)} <span class="muted">높낮이 <b data-pv="${esc(c.name)}">${p.toFixed(2)}</b></span></div>
          <div class="sel two"><input type="range" min="0.5" max="1.6" step="0.05" value="${p}" data-pitch="${esc(c.name)}"><button class="btn small" data-btry="c:${esc(c.name)}">▶</button></div></div>`;
      }).join("")}
    </div>`;

  view.innerHTML = cloudHtml + browserHtml;

  // 클라우드: 엔진 고르면 목소리 목록 채우기
  const fillVoices = async row => {
    const eng = $(".eng", row).value;
    const sel = $(".voi", row);
    if (!eng) { sel.innerHTML = '<option value="">—</option>'; return; }
    sel.innerHTML = "<option>불러오는 중…</option>";
    try {
      const list = await voiceList(eng);
      const cur = getV(row.dataset.key);
      const gname = g => ({ FEMALE: "여", MALE: "남", Female: "여", Male: "남", female: "여", male: "남" }[g] || "");
      sel.innerHTML = list.map(v => `<option value="${esc(v.id)}" ${cur?.voice === v.id ? "selected" : ""}>${esc(v.name)}${gname(v.gender) ? ` · ${gname(v.gender)}` : ""}${eng === "google" ? ` · ${v.family}` : ""}</option>`).join("");
    } catch (e) {
      sel.innerHTML = '<option value="">불러오지 못함</option>';
      toast(e.message, 4000);
    }
  };
  view.querySelectorAll(".voice-row[data-key]").forEach(row => {
    $(".eng", row).onchange = () => fillVoices(row);
    if ($(".eng", row).value) fillVoices(row);
    $(".try", row).onclick = async () => {
      const engine = $(".eng", row).value;
      const voice = $(".voi", row).value;
      if (!engine || !voice) return toast("엔진과 목소리를 먼저 골라 주세요.");
      const who = row.dataset.key.startsWith("c:") ? row.dataset.key.slice(2) : "";
      const text = who ? `안녕하세요, 저는 ${who}이에요. 오늘 밤은 비가 많이 오네요.` : "우산은 택시에 두고 내렸다. 그걸 언덕을 절반쯤 오르고 나서야 알았다.";
      try {
        const key = await ttsOnce(engine, voice, text);
        const bytes = await chunkBytes(key);
        const a = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })));
        a.play();
      } catch (e) { toast(e.message, 4000); }
    };
  });

  $("#vsSave") && ($("#vsSave").onclick = async () => {
    const next = { narrator: null, dialogue: null, fallback: null, characters: {} };
    for (const row of view.querySelectorAll(".voice-row[data-key]")) {
      const engine = $(".eng", row).value;
      const voice = $(".voi", row).value;
      const v = engine && voice ? { engine, voice, label: $(".voi", row).selectedOptions[0]?.textContent || "" } : null;
      const k = row.dataset.key;
      if (k.startsWith("c:")) { if (v) next.characters[k.slice(2)] = v; } else next[k] = v;
    }
    if (!next.narrator) return toast("서술 목소리는 꼭 골라 주세요.");
    try {
      const r = cfg.apiBase === "mock" ? { settings: next } : await api(`/api/settings/${workId}`, { method: "PUT", body: next });
      LS.set(`nr.vs.${workId}`, r.settings);
      toast("저장했어요");
    } catch (e) { toast(e.message, 4000); }
  });

  // 브라우저 음성
  const saveBv = () => LS.set(`nr.bv.${workId}`, bv);
  $("#bvN").onchange = e => { bv.narrator = e.target.value; saveBv(); };
  $("#bvD").onchange = e => { bv.dialogue = e.target.value; saveBv(); };
  view.querySelectorAll("[data-pitch]").forEach(inp => inp.oninput = () => {
    bv.pitch = bv.pitch || {};
    bv.pitch[inp.dataset.pitch] = Number(inp.value);
    view.querySelector(`[data-pv="${CSS.escape(inp.dataset.pitch)}"]`).textContent = Number(inp.value).toFixed(2);
    saveBv();
  });
  view.querySelectorAll("[data-btry]").forEach(btn => btn.onclick = () => {
    if (!("speechSynthesis" in window)) return toast("이 브라우저는 음성 읽기를 지원하지 않아요.");
    const k = btn.dataset.btry;
    const isChar = k.startsWith("c:");
    const name = isChar ? k.slice(2) : "";
    const seg = { kind: k === "narr" ? "narration" : "dialogue", speaker: name };
    const u = new SpeechSynthesisUtterance(isChar ? `안녕하세요, 저는 ${name}이에요.` : k === "narr" ? "우산은 택시에 두고 내렸다." : "오늘 밤은 비가 많이 오네요.");
    u.lang = "ko-KR";
    const v = pickSysVoice(seg, bv);
    if (v) u.voice = v;
    u.pitch = isChar ? pitchFor({ kind: "dialogue", speaker: name }, bv, work) : 1;
    u.rate = prefs.speed;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

async function usageBlock() {
  if (cfg.apiBase === "mock") return "";
  const { usage } = await api("/api/usage");
  const rows = usage.rows.map(r => ({ label: `${ENGINE_LABEL[r.engine]}${r.family !== "all" ? ` ${r.family}` : ""}`, used: r.used, limit: r.limit }));
  if (usage.eleven) rows.push({ label: "ElevenLabs (실제 계정)", used: usage.eleven.used, limit: usage.eleven.limit });
  if (!rows.length) return `<p class="muted">${usage.month} 사용량: 아직 없음</p>`;
  return `<div class="usage"><div class="muted">${usage.month} 무료 한도 사용량 (${Math.round(usage.stopRatio * 100)}%에서 멈춤)</div>${rows.map(r => {
    const pct = r.limit ? Math.min(100, (r.used / r.limit) * 100) : 0;
    return `<div class="u">${esc(r.label)} · ${r.used.toLocaleString()} / ${r.limit.toLocaleString()}자<div class="bar-mini"><i style="width:${pct}%"></i></div></div>`;
  }).join("")}</div>`;
}

/* ---------------- 앱 설정 ---------------- */

function viewSettings() {
  setHeader("설정", { back: "/" });
  view.innerHTML = `
    <h2 class="sec">연결</h2>
    <div class="card">
      <div class="muted">${cfg.apiBase === "mock" ? "예시 데이터로 보는 중" : esc(cfg.apiBase)}</div>
      <div class="row" style="margin-top:10px"><button class="btn small" id="stRe">${cfg.apiBase === "mock" ? "예시 끝내기" : "연결 바꾸기"}</button></div>
    </div>
    <h2 class="sec">앱 잠금</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">${lockOn() ? "켜짐 · 앱을 열 때와 1분 넘게 다른 화면에 있다 돌아올 때 비밀번호를 물어요." : "꺼짐 · 이 기기에서 앱을 열 때마다 물어볼 비밀번호를 정할 수 있어요."}</p>
      <div class="row">${lockOn()
        ? '<button class="btn small" id="lkChange">비밀번호 바꾸기</button><button class="btn small" id="lkOff">잠금 끄기</button>'
        : '<button class="btn small primary" id="lkOn">비밀번호 정하기</button>'}</div>
    </div>
    <h2 class="sec">앱 설치</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">${isStandalone() ? "앱으로 설치해서 쓰고 있어요." : "홈 화면에 설치하면 주소창 없이 앱처럼 열려요."}</p>
      ${isStandalone() ? "" : '<button class="btn small primary" id="stInstall">앱으로 설치</button>'}
    </div>
    <h2 class="sec">저장 공간</h2>
    <div class="card">
      <p class="muted" id="stUse">계산 중…</p>
      <div class="row"><button class="btn small" id="stClearAudio">저장된 음성 지우기</button><button class="btn small" id="stClearText">저장된 본문 지우기</button></div>
    </div>
    <h2 class="sec">사용량</h2>
    <div class="card" id="stUsage"><p class="muted">불러오는 중…</p></div>`;
  $("#stRe").onclick = () => cfg.apiBase === "mock" ? exitMock() : go("/setup");
  $("#stClearAudio").onclick = async () => {
    await caches.delete("nr-audio"); await caches.delete("nr-chunks");
    Object.keys(localStorage).filter(k => k.startsWith("nr.am.")).forEach(k => localStorage.removeItem(k));
    toast("저장된 음성을 지웠어요 (서버에 만든 음성은 남아 있어서 다시 받을 때 무료예요)"); viewSettings();
  };
  $("#stClearText").onclick = async () => { await caches.delete(DATA_CACHE); state.ep = {}; toast("저장된 본문을 지웠어요"); viewSettings(); };
  if ($("#lkOn")) $("#lkOn").onclick = () => openPinDialog("set");
  if ($("#lkChange")) $("#lkChange").onclick = () => openPinDialog("change");
  if ($("#lkOff")) $("#lkOff").onclick = () => openPinDialog("off");
  if ($("#stInstall")) $("#stInstall").onclick = installApp;
  navigator.storage?.estimate?.().then(({ usage }) => { $("#stUse").textContent = `이 기기에 저장된 양: 약 ${(usage / 1048576).toFixed(1)}MB`; }).catch(() => {});
  usageBlock().then(h => { $("#stUsage").innerHTML = h || '<p class="muted">예시 모드에서는 사용량이 없어요.</p>'; }).catch(e => { $("#stUsage").innerHTML = `<p class="muted">${esc(e.message)}</p>`; });
}

/* ---------------- 앱 잠금 ----------------
   이 기기에서만 쓰는 비밀번호. 해시만 저장한다.
   (본문을 가리는 화면 잠금이고, 진짜 보호는 Worker의 앱 키)
------------------------------------------- */

const LOCK_KEY = "nr.lock";
const RELOCK_MS = 60 * 1000;
const lockOn = () => Boolean(LS.get(LOCK_KEY, null));
let hiddenAt = 0;

// 잠금을 푼 뒤 새로고침·자동 업데이트로 다시 열릴 때는 다시 묻지 않는다.
// 같은 창에서만 기억하고(sessionStorage), 앱을 닫았다 열거나 1분 넘게 비우면 다시 잠근다.
const AWAKE_KEY = "nr.awake";
const markAwake = () => { if (!document.body.classList.contains("locked")) sessionStorage.setItem(AWAKE_KEY, String(Date.now())); };
const stillAwake = () => Date.now() - Number(sessionStorage.getItem(AWAKE_KEY) || 0) < RELOCK_MS;
window.addEventListener("pagehide", markAwake);

async function pinHash(pin, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${pin}`));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function pinMatches(pin) {
  const lock = LS.get(LOCK_KEY, null);
  return Boolean(lock) && (await pinHash(pin, lock.salt)) === lock.hash;
}

async function savePin(pin) {
  const salt = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
  LS.set(LOCK_KEY, { salt, hash: await pinHash(pin, salt), len: pin.length });
}

// 휴대폰 잠금화면 같은 숫자 키패드. cfg.len을 알면 그 자리 수를 다 누르는 순간 확인한다.
function pinPad(host, cfg) {
  let pin = "", busy = false;
  const keyHandler = e => {
    if (!host.isConnected || document.querySelector("dialog[open]")) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("del");
    else if (e.key === "Enter") press("ok");
  };
  const pad = {
    step(next) { cfg = next; pin = ""; render(); },
    fail(msg) {
      pin = "";
      drawDots();
      setSub(msg, true);
      const d = $(".pin-dots", host);
      d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake");
      navigator.vibrate?.(60);
    },
    close() { document.removeEventListener("keydown", keyHandler); host.remove(); },
  };
  function render() {
    host.innerHTML = `
      ${cfg.cancel ? '<button class="pin-cancel" data-cancel>취소</button>' : ""}
      <div class="pin">
        <img src="icon.svg" alt="" width="56" height="56">
        <h2>${esc(cfg.title)}</h2>
        <p class="pin-sub"></p>
        <div class="pin-dots"></div>
        <div class="pin-pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-n="${n}">${n}</button>`).join("")}
          ${cfg.len ? "<span></span>" : '<button class="pin-ok" data-ok>확인</button>'}
          <button data-n="0">0</button>
          <button class="pin-del" data-del aria-label="지우기">⌫</button>
        </div>
        ${cfg.foot || ""}
      </div>`;
    setSub(cfg.sub || "");
    drawDots();
    host.querySelectorAll("[data-n]").forEach(b => b.onclick = () => press(b.dataset.n));
    $("[data-del]", host).onclick = () => press("del");
    if ($("[data-ok]", host)) $("[data-ok]", host).onclick = () => press("ok");
    if ($("[data-cancel]", host)) $("[data-cancel]", host).onclick = () => { pad.close(); cfg.cancel(); };
    cfg.mount?.(host, pad);
  }
  function setSub(t, err = false) {
    const s = $(".pin-sub", host);
    s.textContent = t;
    s.classList.toggle("err", err);
  }
  function drawDots() {
    const n = cfg.len || Math.max(4, pin.length);
    $(".pin-dots", host).innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < pin.length ? "on" : ""}"></i>`).join("");
    const ok = $("[data-ok]", host);
    if (ok) ok.disabled = pin.length < 4;
  }
  function press(k) {
    if (busy) return;
    if ($(".pin-sub.err", host)) setSub(cfg.sub || "");
    if (k === "ok") { if (!cfg.len && pin.length >= 4) submit(); return; }
    if (k === "del") pin = pin.slice(0, -1);
    else if (pin.length < (cfg.len || 12)) pin += k;
    drawDots();
    if (cfg.len && pin.length === cfg.len) submit();
  }
  async function submit() {
    busy = true;
    const p = pin;
    await new Promise(r => setTimeout(r, 120)); // 마지막 점이 채워지는 게 보이게
    try { await cfg.onPin(p, pad); } finally { busy = false; }
  }
  document.addEventListener("keydown", keyHandler);
  render();
  return pad;
}

function forgotDialog() {
  openDialog(`
    <div class="stack">
      <h3>비밀번호를 잊었어요</h3>
      <p>이 기기에 저장된 앱 데이터(연결 정보, 저장된 본문과 음성, 읽던 위치, 잠금)를 모두 지우고 처음부터 시작해요. 노션의 소설은 그대로예요. 다시 쓰려면 앱 키를 넣어야 해요.</p>
      <div class="row end"><button class="btn" data-close>취소</button><button class="btn primary" id="lkReset">모두 지우기</button></div>
    </div>`, d => {
    $("#lkReset", d).onclick = async () => {
      Object.keys(localStorage).filter(k => k.startsWith("nr.")).forEach(k => localStorage.removeItem(k));
      for (const name of ["nr-data", "nr-audio", "nr-chunks"]) await caches.delete(name);
      location.reload();
    };
  });
}

function showLock() {
  if (!lockOn() || document.getElementById("lock")) return Promise.resolve();
  if (stillAwake()) { markAwake(); return Promise.resolve(); }
  sessionStorage.removeItem(AWAKE_KEY);
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.id = "lock";
    document.body.appendChild(el);
    document.body.classList.add("locked");
    let fails = 0;
    let waitUntil = 0;
    pinPad(el, {
      title: "소설 서재",
      sub: "비밀번호를 눌러 주세요",
      len: LS.get(LOCK_KEY, {}).len || null,
      foot: '<button class="pin-link" id="lkForgot">비밀번호를 잊었어요</button>',
      mount: h => { $("#lkForgot", h).onclick = forgotDialog; },
      onPin: async (pin, pad) => {
        if (Date.now() < waitUntil) return pad.fail(`${Math.ceil((waitUntil - Date.now()) / 1000)}초 뒤에 다시 해 주세요`);
        if (await pinMatches(pin)) {
          pad.close();
          document.body.classList.remove("locked");
          markAwake();
          resolve();
          return;
        }
        fails++;
        if (fails >= 5) { waitUntil = Date.now() + 30000; fails = 0; pad.fail("5번 틀려서 30초 동안 기다려야 해요"); }
        else pad.fail(`비밀번호가 달라요 (${fails}/5)`);
      },
    });
  });
}

// 설정 → 앱 잠금: 정하기 / 바꾸기 / 끄기도 같은 키패드 화면으로
function openPinDialog(mode) {
  const el = document.createElement("div");
  el.id = "pinsheet";
  document.body.appendChild(el);
  const cancel = () => {};
  const done = msg => { pad.close(); toast(msg); viewSettings(); };
  const newCfg = () => ({
    title: mode === "set" ? "잠금 비밀번호 정하기" : "새 비밀번호",
    sub: "숫자 4~12자리를 누르고 확인",
    cancel,
    onPin: first => pad.step({
      title: "한 번 더",
      sub: "같은 비밀번호를 다시 눌러 주세요",
      len: first.length,
      cancel,
      onPin: async second => {
        if (second !== first) { pad.step(newCfg()); pad.fail("두 번 누른 비밀번호가 달라요. 처음부터 다시 정해 주세요"); return; }
        await savePin(second);
        done(mode === "set" ? "잠금을 켰어요" : "비밀번호를 바꿨어요");
      },
    }),
  });
  const pad = pinPad(el, mode === "set" ? newCfg() : {
    title: "지금 비밀번호",
    sub: mode === "off" ? "잠금을 끄려면 지금 비밀번호를 눌러 주세요" : "바꾸기 전에 지금 비밀번호를 눌러 주세요",
    len: LS.get(LOCK_KEY, {}).len || null,
    cancel,
    onPin: async (pin, p) => {
      if (!(await pinMatches(pin))) return p.fail("비밀번호가 달라요");
      if (mode === "off") { LS.del(LOCK_KEY); done("잠금을 껐어요"); }
      else p.step(newCfg());
    },
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    markAwake();
    pushProgress();
    if (lockOn()) document.body.classList.add("veil"); // 최근 앱 화면에 본문이 보이지 않게
    return;
  }
  document.body.classList.remove("veil");
  if (lockOn() && hiddenAt && Date.now() - hiddenAt > RELOCK_MS) { hideBubble(); showLock(); }
});

/* ---------------- 앱 설치 ---------------- */

let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; });
window.addEventListener("appinstalled", () => { installPrompt = null; toast("앱으로 설치했어요"); });

function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    return;
  }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openDialog(`
    <div class="stack">
      <h3>앱으로 설치하기</h3>
      ${ios
        ? "<p>Safari 아래쪽 <b>공유 버튼(□↑)</b> → <b>홈 화면에 추가</b> → <b>추가</b>를 눌러 주세요. (iPhone은 Safari에서만 설치돼요)</p>"
        : "<p>브라우저 메뉴(⋮)에서 <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 눌러 주세요.</p>"}
      <div class="row end"><button class="btn primary" data-close>확인</button></div>
    </div>`);
}

/* ---------------- 책갈피 ----------------
   문단마다 여러 개. Worker KV `marks`로 기기끼리 합친다(지운 것도 전달).
------------------------------------------ */

let marks = LS.get("nr.marks", { items: [] });
const liveMarks = () => marks.items.filter(m => !m.del);
let marksTimer;

function markAt(i) {
  const b = state.ep[reader.epId]?.blocks[i];
  return liveMarks().find(m => m.epId === reader.epId && (b?.id ? m.blockId === b.id : m.i === i));
}

function markIndex(m, ep) {
  if (!ep) return m.i;
  const j = m.blockId ? ep.blocks.findIndex(b => b.id === m.blockId) : -1;
  return j >= 0 ? j : Math.min(m.i, ep.blocks.length - 1);
}

function saveMarks() {
  LS.set("nr.marks", marks);
  clearTimeout(marksTimer);
  marksTimer = setTimeout(pushMarks, 800);
}

async function pushMarks() {
  try {
    const r = await api("/api/marks", { method: "PUT", body: marks });
    marks = r.marks;
    LS.set("nr.marks", marks);
  } catch { /* 다음에 다시 보냄 */ }
}

async function pullMarks() {
  try {
    const r = await api("/api/marks");
    const map = new Map(r.marks.items.map(m => [m.id, m]));
    let mine = false;
    for (const m of marks.items) {
      const o = map.get(m.id);
      if (!o || (o.at || 0) < (m.at || 0)) { map.set(m.id, m); mine = true; }
    }
    marks = { items: [...map.values()] };
    LS.set("nr.marks", marks);
    if (mine) pushMarks();
    if (reader.epId && $("#art")) paintMarks();
  } catch { /* 오프라인이면 기기 저장본 */ }
}

function toggleMark(i) {
  const old = markAt(i);
  if (old) {
    Object.assign(old, { del: true, at: Date.now() });
    toast("책갈피를 뺐어요");
  } else {
    const ep = state.ep[reader.epId];
    const work = state.work[reader.workId];
    const b = ep.blocks[i];
    marks.items.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      workId: reader.workId, epId: ep.id, blockId: b.id || "", i,
      text: (b.plain || "").replace(/^\s*▌\s*/, "").slice(0, 80) || "(구분선)",
      epTitle: ep.title, workTitle: work?.title || "", at: Date.now(),
    });
    toast("🔖 책갈피에 넣었어요");
  }
  saveMarks();
  paintMarks();
}

function paintMarks() {
  document.querySelectorAll("#art .marked").forEach(el => el.classList.remove("marked"));
  const ep = state.ep[reader.epId];
  for (const m of liveMarks()) if (m.epId === reader.epId) blockEl(markIndex(m, ep))?.classList.add("marked");
}

function openMarksDialog(workId) {
  const draw = d => {
    const list = liveMarks().filter(m => m.workId === workId).sort((a, b) => b.at - a.at);
    $("#mkList", d).innerHTML = list.length ? list.map(m => `
      <div class="mark-row" data-go="${m.id}">
        <div class="grow"><div class="t">${esc(m.epTitle)}</div><div class="s">${esc(m.text)}</div><div class="muted">${timeAgo(new Date(m.at).toISOString())}</div></div>
        <button class="icon" data-del="${m.id}" aria-label="지우기">✕</button>
      </div>`).join("") : '<p class="muted">아직 책갈피가 없어요. 본문에서 문단을 누르고 🔖 책갈피를 눌러 보세요.</p>';
    d.querySelectorAll("[data-del]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      const m = marks.items.find(x => x.id === b.dataset.del);
      Object.assign(m, { del: true, at: Date.now() });
      saveMarks();
      paintMarks();
      draw(d);
    });
    d.querySelectorAll("[data-go]").forEach(row => row.onclick = async () => {
      const m = marks.items.find(x => x.id === row.dataset.go);
      d.close();
      const ep = m.epId === reader.epId ? state.ep[m.epId] : await loadEpisode(m.epId).catch(() => null);
      const idx = markIndex(m, ep);
      if (m.epId === reader.epId && $("#art")) { scrollToBlock(idx); const el = blockEl(idx); el?.classList.remove("flash"); void el?.offsetWidth; el?.classList.add("flash"); }
      else go(`/ep/${m.workId}/${m.epId}/${idx}`, { replace: onEpRoute() });
    });
  };
  const d = openDialog(`<div class="stack"><h3>🔖 책갈피</h3><div id="mkList" class="mark-list"></div>
    <div class="row end"><button class="btn primary" data-close>닫기</button></div></div>`);
  draw(d);
  pullMarks().then(() => { if (d.open) draw(d); });
}

/* ---------------- 회차 체크박스 (노션에 바로 저장) ---------------- */

async function toggleCheck(workId, epId, prop, btn) {
  const work = state.work[workId];
  const ep = work?.episodes.find(e => e.id === epId);
  if (!ep) return;
  const value = !ep.checks?.[prop];
  const apply = v => {
    ep.checks = { ...ep.checks, [prop]: v };
    btn?.classList.toggle("on", v);
    dataSet(`work:${workId}`, work);
  };
  apply(value);
  btn && (btn.disabled = true);
  try {
    await api(`/api/pages/${epId}/checkbox`, { method: "PATCH", body: { prop, value } });
  } catch (e) {
    apply(!value);
    toast(e.status === 403 || /permission|권한/i.test(e.message) ? "노션 통합에 '콘텐츠 업데이트' 권한이 필요해요" : e.message);
  } finally {
    btn && (btn.disabled = false);
  }
}

/* ---------------- 작품 분류 (책장) ----------------
   앱에서 정하는 분류. Worker KV에 저장해서 기기끼리 같다. 노션은 건드리지 않는다.
--------------------------------------------------- */

let shelves = normShelves(LS.get("nr.shelves", null));

// 예전에는 작품마다 분류 하나(문자열)였다 → 배열로
function normShelves(x) {
  const out = { list: [], of: {}, at: 0, ...(x || {}) };
  out.of = Object.fromEntries(Object.entries(out.of || {}).map(([id, v]) => [id, [].concat(v).filter(n => out.list.includes(n))]).filter(([, v]) => v.length));
  return out;
}
const shelvesOf = id => shelves.of[id] || [];
let lastWorks = null;

async function pullShelves() {
  try {
    const r = await api("/api/shelves");
    if ((r.shelves?.at || 0) <= (shelves.at || 0) && shelves.at) {
      if ((r.shelves?.at || 0) < shelves.at) pushShelves();
      return false;
    }
    shelves = normShelves(r.shelves);
    LS.set("nr.shelves", shelves);
    return true;
  } catch { return false; }
}

function saveShelvesLocal() {
  shelves.at = Date.now();
  LS.set("nr.shelves", shelves);
  pushShelves();
}

async function pushShelves() {
  try { await api("/api/shelves", { method: "PUT", body: shelves }); }
  catch (e) { if (!e.offline) toast(e.message); }
}

function openShelfPicker(workId, onDone) {
  const w = (lastWorks || []).find(x => x.id === workId);
  const sel = new Set(shelvesOf(workId));
  const d = openDialog(`
    <div class="stack">
      <h3>${esc(w?.title || "작품")} 분류</h3>
      <p class="muted" style="margin:0">여러 개 고를 수 있어요.</p>
      <div class="shelf-pick" id="shPick"></div>
      <div class="row"><input id="shNew" placeholder="새 분류 이름 (예: 연재 중)" maxlength="20"><button class="btn" id="shAdd">추가</button></div>
      <div class="row end"><button class="btn primary" id="shDone">완료</button></div>
    </div>`);
  const draw = () => {
    $("#shPick", d).innerHTML = shelves.list.length
      ? shelves.list.map(n => `<button class="chip ${sel.has(n) ? "on" : ""}" data-s="${esc(n)}">${sel.has(n) ? "✓ " : ""}${esc(n)}</button>`).join("")
      : '<span class="muted">아직 분류가 없어요. 아래에서 만들어 주세요.</span>';
    d.querySelectorAll("[data-s]").forEach(b => b.onclick = () => {
      const n = b.dataset.s;
      sel.has(n) ? sel.delete(n) : sel.add(n);
      draw();
    });
  };
  draw();
  $("#shAdd", d).onclick = () => {
    const name = $("#shNew", d).value.trim();
    if (!name) return;
    if (!shelves.list.includes(name)) shelves.list.push(name);
    sel.add(name);
    $("#shNew", d).value = "";
    draw();
  };
  $("#shNew", d).onkeydown = e => { if (e.key === "Enter") $("#shAdd", d).click(); };
  $("#shDone", d).onclick = () => {
    const names = shelves.list.filter(n => sel.has(n));
    if (names.length) shelves.of[workId] = names; else delete shelves.of[workId];
    saveShelvesLocal();
    d.close();
    onDone();
  };
}

function openShelfEditor(onDone) {
  // orig: 원래 이름 (이름을 바꿔도 그 분류에 넣어 둔 작품이 따라가게)
  const items = shelves.list.map(n => ({ name: n, orig: n }));
  const d = openDialog(`<div class="stack"><h3>분류 편집</h3><div id="shList"></div>
    <div class="row"><input id="shNew" placeholder="새 분류 이름" maxlength="20"><button class="btn" id="shAdd">추가</button></div>
    <p class="muted" style="margin:0">작품 목록에서 작품 오른쪽 ⋯를 누르면 분류를 정할 수 있어요. 노션은 바뀌지 않아요.</p>
    <div class="row end"><button class="btn" data-close>취소</button><button class="btn primary" id="shSave">저장</button></div></div>`);
  const draw = () => {
    $("#shList", d).innerHTML = items.length ? items.map((it, i) => `
      <div class="shelf-row">
        <input value="${esc(it.name)}" data-i="${i}" maxlength="20">
        <button class="icon" data-up="${i}" ${i ? "" : "disabled"} aria-label="위로">↑</button>
        <button class="icon" data-down="${i}" ${i < items.length - 1 ? "" : "disabled"} aria-label="아래로">↓</button>
        <button class="icon" data-del="${i}" aria-label="지우기">✕</button>
      </div>`).join("") : '<p class="muted">아직 분류가 없어요.</p>';
    d.querySelectorAll("#shList input").forEach(inp => inp.oninput = () => { items[inp.dataset.i].name = inp.value; });
    d.querySelectorAll("[data-up]").forEach(b => b.onclick = () => { const i = +b.dataset.up; [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); });
    d.querySelectorAll("[data-down]").forEach(b => b.onclick = () => { const i = +b.dataset.down; [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); });
    d.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { items.splice(+b.dataset.del, 1); draw(); });
  };
  draw();
  $("#shAdd", d).onclick = () => {
    const n = $("#shNew", d).value.trim();
    if (n && !items.some(it => it.name === n)) items.push({ name: n, orig: null });
    $("#shNew", d).value = "";
    draw();
  };
  $("#shNew", d).onkeydown = e => { if (e.key === "Enter") $("#shAdd", d).click(); };
  $("#shSave", d).onclick = () => {
    const clean = items.map(it => String(it.name).trim().slice(0, 20));
    if (clean.some(n => !n)) return toast("빈 이름이 있어요");
    if (new Set(clean).size !== clean.length) return toast("같은 이름이 두 개 있어요");
    const of = {};
    for (const [id, names] of Object.entries(shelves.of)) {
      const kept = [].concat(names).map(name => items.findIndex(it => it.orig === name)).filter(i => i >= 0).map(i => clean[i]);
      if (kept.length) of[id] = [...new Set(kept)];
    }
    shelves.list = clean;
    shelves.of = of;
    saveShelvesLocal();
    d.close();
    onDone();
  };
}

/* ---------------- 노션에서 새로 불러오기 ----------------
   목록·본문은 저장본을 먼저 보여 주고 뒤에서 조용히 새로 받는다.
   ⟳ 버튼이나 맨 위에서 아래로 당기면 지금 바로 노션에서 다시 받는다.
---------------------------------------------------------- */

let pageRefresh = null;
let refreshing = false;

function setRefresh(fn, btnSel = "#rfBtn") {
  pageRefresh = fn;
  const btn = $(btnSel);
  if (btn) btn.onclick = runRefresh;
}

async function runRefresh() {
  if (!pageRefresh || refreshing) return;
  const fn = pageRefresh;
  refreshing = true;
  document.body.classList.add("refreshing");
  ptrEl().classList.add("spin");
  try { await fn(); }
  catch (e) { toast(e.message || "불러오지 못했어요"); }
  finally {
    refreshing = false;
    document.body.classList.remove("refreshing");
    ptrEl().classList.remove("spin");
  }
}

function ptrEl() {
  let el = $("#ptr");
  if (!el) { el = document.createElement("div"); el.id = "ptr"; el.innerHTML = "<span>⟳</span>"; document.body.appendChild(el); }
  return el;
}

const PTR_GO = 80;
let ptr = null;
document.addEventListener("touchstart", e => {
  if (!pageRefresh || refreshing || window.scrollY > 0 || e.touches.length !== 1) return;
  if (document.body.classList.contains("locked") || document.querySelector("dialog[open], #pinsheet")) return;
  ptr = { y: e.touches[0].clientY, d: 0 };
}, { passive: true });
document.addEventListener("touchmove", e => {
  if (!ptr) return;
  ptr.d = window.scrollY > 0 ? 0 : Math.max(0, e.touches[0].clientY - ptr.y);
  const el = ptrEl();
  const d = Math.min(ptr.d, 130);
  el.style.setProperty("--pull", `${d * 0.6}px`);
  el.style.setProperty("--turn", `${d * 3}deg`);
  el.classList.toggle("pulling", d > 4);
  el.classList.toggle("ready", ptr.d > PTR_GO);
}, { passive: true });
document.addEventListener("touchend", () => {
  if (!ptr) return;
  const go = ptr.d > PTR_GO && window.scrollY <= 0;
  ptr = null;
  const el = ptrEl();
  el.classList.remove("pulling", "ready");
  el.style.removeProperty("--pull");
  el.style.removeProperty("--turn");
  if (go) { navigator.vibrate?.(15); runRefresh(); }
});

/* ---------------- 시작 ---------------- */

applyLook();
document.addEventListener("click", e => { if (!e.target.closest("#bubble") && !e.target.closest("#art")) hideBubble(); });
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  // 새 버전이 올라오면 바로 새로 열어서 옛 화면이 남지 않게 (듣는 중이면 멈춘 뒤에)
  const hadController = Boolean(navigator.serviceWorker.controller);
  let updateReady = false;
  const reloadIfIdle = () => { if (updateReady && !isPlaying() && !document.querySelector("dialog[open]")) location.reload(); };
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) { updateReady = true; reloadIfIdle(); } });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
    reloadIfIdle();
  });
  window.addEventListener("hashchange", reloadIfIdle);
}
showLock().then(async () => {
  route();
  // 다른 기기에서 읽은 기록을 받아 오고, 목록 화면이면 다시 그린다
  pullMarks();
  await pullProgress();
  if (!location.hash.startsWith("#/ep/") && cfg.apiBase) route();
});

/* ---------- 확대 막기 ----------
   viewport의 user-scalable=no를 무시하는 브라우저(아이폰 Safari 등)를 위해
   두 손가락 확대와 Ctrl+휠 확대를 직접 막는다(두 번 탭 확대는 CSS touch-action으로). 글자 크기는 설정에서 바꾼다.
-------------------------------- */
document.addEventListener("gesturestart", e => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
document.addEventListener("wheel", e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
