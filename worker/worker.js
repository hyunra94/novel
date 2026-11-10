/* =========================================================
   NovelReader Worker
   - 노션의 "○○ — 소설 기획" 페이지 → "회차 목록" DB → 회차 본문을 읽어 앱에 전달
   - 오타 고치기(노션 문단 직접 수정), 메모 남기기(노션 댓글)
   - 클라우드 TTS(Google / Azure / ElevenLabs)로 문단별 mp3를 만들어 R2에 저장
     · 같은 엔진·목소리·문장은 한 번만 만든다(내용 해시로 저장) → 다시 듣기는 무료 한도에서 빠지지 않음
     · 엔진별 이번 달 사용량을 KV에 세고, 무료 한도의 QUOTA_STOP_RATIO(기본 90%)에서 멈춘다
   - 모든 API는 앱 키(APP_KEY)가 있어야 쓸 수 있다

   비밀값(wrangler secret put): NOTION_TOKEN, APP_KEY,
     GOOGLE_TTS_KEY, AZURE_TTS_KEY, ELEVENLABS_KEY (TTS 키는 쓰는 것만)
========================================================= */

const NOTION_VERSION = "2025-09-03";
const ENGINES = ["google", "azure", "elevenlabs"];
const MAX_TTS_CHARS = 1800;
// 엔진별로 소리를 줄이는 정도 (1단계 = 1.5dB). 소리가 너무 커서 깨지는 것을 막는다.
// 바꾸면 그 엔진 음성은 새로 만들어진다(저장 키가 달라짐). wrangler.toml [vars]의 GAIN_STEPS_엔진으로 덮어쓸 수 있다.
const GAIN_STEPS = { google: 0, azure: 0, elevenlabs: 6 }; // 시험: ElevenLabs가 Google·Azure보다 약 9dB 커서 피크가 0.93까지 감

export { mp3Gain };
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "");
      const method = request.method;
      checkAuth(request, env);
      let m;

      if (path === "/api/ping") return json({ ok: true, engines: enginesAvailable(env) }, 200, cors);
      if (path === "/api/works" && method === "GET") return json({ ok: true, works: await listWorks(env) }, 200, cors);
      if ((m = path.match(/^\/api\/works\/([\w-]+)$/)) && method === "GET") {
        return json({ ok: true, ...(await getWork(env, m[1])) }, 200, cors);
      }
      if ((m = path.match(/^\/api\/episodes\/([\w-]+)$/)) && method === "GET") {
        return json({ ok: true, episode: await getEpisode(env, m[1]) }, 200, cors);
      }
      if ((m = path.match(/^\/api\/blocks\/([\w-]+)$/)) && method === "PATCH") {
        return json({ ok: true, block: await editBlock(env, m[1], await readJson(request)) }, 200, cors);
      }
      if (path === "/api/comments" && method === "POST") {
        return json({ ok: true, ...(await addComment(env, await readJson(request))) }, 200, cors);
      }
      if ((m = path.match(/^\/api\/settings\/([\w-]+)$/))) {
        if (method === "GET") return json({ ok: true, settings: await getSettings(env, m[1]), common: m[1] === COMMON_ID ? null : await getSettings(env, COMMON_ID) }, 200, cors);
        if (method === "PUT") return json({ ok: true, settings: await saveSettings(env, m[1], await readJson(request)) }, 200, cors);
      }
      if (path === "/api/voices" && method === "GET") {
        return json({ ok: true, voices: await listVoices(env, url.searchParams.get("engine")) }, 200, cors);
      }
      if (path === "/api/progress") {
        if (method === "GET") return json({ ok: true, progress: await getProgress(env) }, 200, cors);
        if (method === "PUT") return json({ ok: true, progress: await mergeProgress(env, await readJson(request)) }, 200, cors);
      }
      if ((m = path.match(/^\/api\/pages\/([\w-]+)\/checkbox$/)) && method === "PATCH") {
        return json({ ok: true, ...(await setCheckbox(env, m[1], await readJson(request))) }, 200, cors);
      }
      if (path === "/api/marks") {
        if (method === "GET") return json({ ok: true, marks: await getMarks(env) }, 200, cors);
        if (method === "PUT") return json({ ok: true, marks: await mergeMarks(env, await readJson(request)) }, 200, cors);
      }
      if (path === "/api/shelves") {
        if (method === "GET") return json({ ok: true, shelves: await getShelves(env) }, 200, cors);
        if (method === "PUT") return json({ ok: true, shelves: await saveShelves(env, await readJson(request)) }, 200, cors);
      }
      if (path === "/api/usage" && method === "GET") return json({ ok: true, usage: await getUsage(env) }, 200, cors);
      if (path === "/api/tts" && method === "POST") return json({ ok: true, ...(await tts(env, await readJson(request))) }, 200, cors);
      if ((m = path.match(/^\/api\/chunk\/([a-f0-9]{64})$/)) && method === "GET") return await getChunk(env, m[1], cors);

      return json({ ok: false, error: "Not found", path }, 404, cors);
    } catch (err) {
      const status = err.status || 500;
      return json({ ok: false, error: err.message || "Worker error", code: err.code }, status, cors);
    }
  },
};

/* ---------------- 공통 ---------------- */

function corsHeaders(request, env) {
  const allowed = String(env.CORS_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0] || "");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

async function readJson(request) {
  try { return await request.json(); } catch { throw httpError(400, "요청 형식이 잘못됐어요."); }
}

function checkAuth(request, env) {
  if (!env.APP_KEY) throw httpError(500, "Worker에 APP_KEY 비밀값이 없어요.");
  const got = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(got, env.APP_KEY)) throw httpError(401, "앱 키가 맞지 않아요.", "AUTH");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function enginesAvailable(env) {
  return {
    google: Boolean(env.GOOGLE_TTS_KEY),
    azure: Boolean(env.AZURE_TTS_KEY),
    elevenlabs: Boolean(env.ELEVENLABS_KEY),
  };
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function kv(env) {
  if (!env.NR_KV) throw httpError(500, "NR_KV(KV)가 연결되지 않았어요.");
  return env.NR_KV;
}

/* ---------------- Notion ---------------- */

async function notion(env, path, method = "GET", body) {
  if (!env.NOTION_TOKEN) throw httpError(500, "Worker에 NOTION_TOKEN 비밀값이 없어요.");
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 404 ? " (노션 통합이 이 페이지에 연결돼 있는지 확인해 주세요)" : "";
    throw httpError(502, `노션 오류 ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function notionQueryAll(env, dataSourceId, body = {}) {
  const results = [];
  let cursor;
  do {
    const data = await notion(env, `/data_sources/${dataSourceId}/query`, "POST", {
      page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}),
    });
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function listChildren(env, blockId) {
  const results = [];
  let cursor;
  do {
    const q = `page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const data = await notion(env, `/blocks/${blockId}/children?${q}`);
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function readTitle(props) {
  for (const v of Object.values(props || {})) if (v?.type === "title") return v.title.map(t => t.plain_text).join("").trim();
  return "";
}

function readProp(props, name) {
  const v = props?.[name];
  if (!v) return null;
  switch (v.type) {
    case "number": return v.number;
    case "select": return v.select?.name || "";
    case "status": return v.status?.name || "";
    case "multi_select": return (v.multi_select || []).map(x => x.name);
    case "rich_text": return v.rich_text.map(t => t.plain_text).join("").trim();
    case "checkbox": return v.checkbox;
    default: return null;
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* ---------------- 회차 체크박스 ---------------- */

async function setCheckbox(env, pageId, body) {
  const prop = String(body?.prop || "");
  if (!prop || typeof body?.value !== "boolean") throw httpError(400, "prop, value가 필요해요.");
  const page = await notion(env, `/pages/${pageId}`);
  if (page.properties?.[prop]?.type !== "checkbox") throw httpError(400, "그 이름의 체크박스가 이 회차에 없어요.");
  const updated = await notion(env, `/pages/${pageId}`, "PATCH", { properties: { [prop]: { checkbox: body.value } } });
  return { prop, value: Boolean(updated.properties?.[prop]?.checkbox), lastEdited: updated.last_edited_time };
}

/* ---------------- 작품 분류 (앱에서 정하는 책장, KV) ---------------- */

async function getShelves(env) {
  return (await kv(env).get("shelves", "json")) || { list: [], of: {}, at: 0 };
}

async function saveShelves(env, body) {
  const list = [...new Set((Array.isArray(body?.list) ? body.list : []).map(x => String(x).trim().slice(0, 20)).filter(Boolean))].slice(0, 30);
  const of = {};
  for (const [id, names] of Object.entries(body?.of || {})) {
    if (!/^[\w-]{1,40}$/.test(id)) continue;
    const keep = [...new Set([].concat(names).filter(n => list.includes(n)))];
    if (keep.length) of[id] = keep;
  }
  const data = { list, of, at: Number(body?.at) || Date.now() };
  await kv(env).put("shelves", JSON.stringify(data));
  return data;
}

/* ---------------- 책갈피 (기기끼리 합치기) ----------------
   { items: [{ id, workId, epId, blockId, i, text, epTitle, workTitle, at, del }] }
   같은 id는 at이 늦은 쪽이 이긴다. 지운 책갈피는 del로 남겨서 다른 기기에서도 지워지게 한다.
------------------------------------------------------------ */

async function getMarks(env) {
  return (await kv(env).get("marks", "json")) || { items: [] };
}

async function mergeMarks(env, body) {
  const cur = await getMarks(env);
  const map = new Map(cur.items.map(m => [m.id, m]));
  const str = (v, n) => String(v ?? "").slice(0, n);
  for (const m of Array.isArray(body?.items) ? body.items.slice(0, 1000) : []) {
    if (!m || !/^[\w-]{4,40}$/.test(String(m.id))) continue;
    const at = Number(m.at) || 0;
    const old = map.get(m.id);
    if (old && (old.at || 0) >= at) continue;
    map.set(m.id, m.del ? { id: m.id, del: true, at } : {
      id: m.id, workId: str(m.workId, 40), epId: str(m.epId, 40), blockId: str(m.blockId, 40), i: Number(m.i) || 0,
      text: str(m.text, 120), epTitle: str(m.epTitle, 100), workTitle: str(m.workTitle, 100), at,
    });
  }
  // 지운 표시는 90일 지나면 버린다
  const cutoff = Date.now() - 90 * 864e5;
  const items = [...map.values()].filter(m => !m.del || m.at > cutoff).sort((a, b) => b.at - a.at).slice(0, 1000);
  const data = { items };
  await kv(env).put("marks", JSON.stringify(data));
  return data;
}

/* ---------------- 작품 · 회차 ---------------- */

async function listWorks(env) {
  if (!env.NOTION_WORKS_DS_ID) throw httpError(500, "NOTION_WORKS_DS_ID가 설정되지 않았어요.");
  const keyword = env.WORK_TITLE_KEYWORD || "소설 기획";
  const titleProp = env.WORK_TITLE_PROP || "이름";
  const pages = await notionQueryAll(env, env.NOTION_WORKS_DS_ID, {
    filter: { property: titleProp, title: { contains: keyword } },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  const tail = new RegExp(`\\s*[—–-]?\\s*${escapeRe(keyword)}\\s*$`);
  return pages
    .filter(p => !p.in_trash && !p.archived)
    .map(p => {
      const full = readTitle(p.properties);
      return {
        id: p.id,
        title: full.replace(tail, "").trim() || full,
        icon: p.icon?.type === "emoji" ? p.icon.emoji : "",
        lastEdited: p.last_edited_time,
      };
    });
}

function epNumber(value, title) {
  if (typeof value === "number") return value;
  const m = title.match(/(d+(?:.d+)?)s*화/);
  if (m) return Number(m[1]);
  if (/프롤로그/.test(title)) return 0;
  return null;
}

function epProps(env) {
  return {
    no: env.EP_NO_PROP || "화",
    route: env.EP_ROUTE_PROP || "루트",
    status: env.EP_STATUS_PROP || "상태",
    summary: env.EP_SUMMARY_PROP || "한 줄 요약",
    chars: env.EP_CHARS_PROP || "등장인물",
  };
}

async function findEpisodeDataSource(env, workId) {
  const children = await listChildren(env, workId);
  const dbs = children.filter(b => b.type === "child_database");
  if (!dbs.length) return null;
  const want = env.EPISODE_DB_TITLE || "회차";
  const pick = dbs.find(b => (b.child_database?.title || "").includes(want)) || dbs[0];
  const db = await notion(env, `/databases/${pick.id}`);
  return db.data_sources?.[0]?.id || null;
}

async function getWork(env, workId) {
  const store = kv(env);
  const cacheKey = `epds:${workId}`;
  let dsId = await store.get(cacheKey);
  let ds = null;
  if (dsId) {
    try { ds = await notion(env, `/data_sources/${dsId}`); } catch { dsId = null; }
  }
  if (!dsId) {
    dsId = await findEpisodeDataSource(env, workId);
    if (!dsId) throw httpError(404, "이 작품 페이지 안에서 회차 DB를 찾지 못했어요.");
    await store.put(cacheKey, dsId);
    ds = await notion(env, `/data_sources/${dsId}`);
  }

  const P = epProps(env);
  // 회차 DB의 체크박스 속성(이름은 DB마다 다를 수 있음)
  // 회차 번호 칸: "화"가 없으면 DB의 다른 숫자 칸(예: "숫자"), 그것도 없으면 제목의 "N화"
  const dsProps = ds?.properties || {};
  const noProp = dsProps[P.no]?.type === "number" ? P.no : Object.entries(dsProps).find(([, v]) => v?.type === "number")?.[0] || null;
  const checks = Object.entries(ds?.properties || {}).filter(([, v]) => v?.type === "checkbox").map(([name]) => name);
  const pages = await notionQueryAll(env, dsId, {});
  const episodes = pages
    .filter(p => !p.in_trash && !p.archived)
    .map(p => ({
      id: p.id,
      title: readTitle(p.properties),
      no: epNumber(noProp ? readProp(p.properties, noProp) : null, readTitle(p.properties)),
      route: readProp(p.properties, P.route) || "",
      status: readProp(p.properties, P.status) || "",
      summary: readProp(p.properties, P.summary) || "",
      characters: readProp(p.properties, P.chars) || [],
      checks: Object.fromEntries(checks.map(name => [name, Boolean(p.properties?.[name]?.checkbox)])),
      lastEdited: p.last_edited_time,
    }))
    .sort((a, b) => {
      const an = typeof a.no === "number" ? a.no : Infinity;
      const bn = typeof b.no === "number" ? b.no : Infinity;
      return an - bn || a.title.localeCompare(b.title, "ko");
    });

  const charProp = ds?.properties?.[P.chars];
  const characters = (charProp?.multi_select?.options || []).map(o => ({ name: o.name, color: o.color }));
  const routeProp = ds?.properties?.[P.route];
  const routes = (routeProp?.select?.options || []).map(o => ({ name: o.name, color: o.color }));
  return { workId, characters, routes, checks, episodes };
}

async function getEpisode(env, pageId) {
  const page = await notion(env, `/pages/${pageId}`);
  const blocks = await listChildren(env, pageId);
  return {
    id: page.id,
    title: readTitle(page.properties),
    lastEdited: page.last_edited_time,
    blocks: parseBlocks(blocks),
  };
}

/* ---------------- 본문 분석 ----------------
   작성 규칙(소설 기획 페이지 6번)에 맞춰 나눈다.
   - 장면 헤더: "▌ #01 | 날짜 | …" → scene (읽지 않음, 잠깐 쉼)
   - 대사: "**이름** | "대사"" → dialogue (speaker = 이름)
   - 이전 화 / 다음 화 링크 줄 → 건너뜀
   - 구분선 → divider (잠깐 쉼)
   - 콜아웃 → note (화면에만 흐리게, 읽지 않음)
   - 그 밖의 글 → narration
------------------------------------------- */

const TEXT_TYPES = ["paragraph", "quote", "heading_1", "heading_2", "heading_3",
  "bulleted_list_item", "numbered_list_item", "callout", "toggle"];

function parseBlocks(raw) {
  const out = [];
  for (const b of raw) {
    const parsed = parseBlock(b);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseBlock(b) {
  const t = b.type;
  if (t === "divider") return { id: b.id, kind: "divider" };
  if (!TEXT_TYPES.includes(t)) return null;
  const runs = b[t]?.rich_text || [];
  const plain = runs.map(r => r.plain_text).join("");
  if (!plain.trim()) return null;
  const base = { id: b.id, type: t, plain };

  if (isNavLine(runs, plain)) return null;
  if (/^\s*▌/.test(plain)) return { ...base, kind: "scene", runs: simplifyRuns(runs, 0), speak: "" };
  if (t === "callout") return { ...base, kind: "note", runs: simplifyRuns(runs, 0), speak: "" };

  const dlg = matchDialogue(runs, plain);
  if (dlg) {
    return {
      ...base, kind: "dialogue", speaker: dlg.speaker, prefixLen: dlg.prefixLen,
      runs: simplifyRuns(runs, dlg.prefixLen), speak: cleanSpeak(plain.slice(dlg.prefixLen), true),
    };
  }
  const kind = t.startsWith("heading") ? "heading" : "narration";
  return { ...base, kind, prefixLen: 0, runs: simplifyRuns(runs, 0), speak: cleanSpeak(plain, false) };
}

function isNavLine(runs, plain) {
  if (!/(이전\s*화|다음\s*화)/.test(plain)) return false;
  return runs.some(r => r.type === "mention" || r.text?.link) || plain.length < 40;
}

function matchDialogue(runs, plain) {
  const m = plain.match(/^(\s*)([^|"“”「」\n]{1,20}?)\s*\|\s*/);
  if (!m) return null;
  const speaker = m[2].trim();
  if (!speaker) return null;
  const firstRun = runs.find(r => r.plain_text.trim());
  const bold = Boolean(firstRun?.annotations?.bold);
  if (!bold && !/^[가-힣A-Za-z0-9·]{1,10}$/.test(speaker)) return null;
  return { speaker, prefixLen: m[0].length };
}

function cleanSpeak(text, isDialogue) {
  let s = text
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (isDialogue) s = s.replace(/^["“”']+|["“”']+$/g, "").trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

// 화면 표시용으로 서식만 남긴 글 조각. skip = 앞에서 잘라낼 글자 수(대사 이름 부분)
function simplifyRuns(runs, skip) {
  const out = [];
  let left = skip;
  for (const r of runs) {
    let t = r.plain_text;
    if (left > 0) {
      const cut = Math.min(left, t.length);
      t = t.slice(cut);
      left -= cut;
    }
    if (!t) continue;
    const a = r.annotations || {};
    const run = { t };
    if (a.bold) run.b = 1;
    if (a.italic) run.i = 1;
    if (a.strikethrough) run.s = 1;
    if (a.underline) run.u = 1;
    out.push(run);
  }
  return out;
}

/* ---------------- 오타 고치기 ---------------- */

async function editBlock(env, blockId, body) {
  const oldText = String(body.oldText ?? "");
  const newText = String(body.newText ?? "");
  if (!newText.trim()) throw httpError(400, "빈 문단으로는 바꿀 수 없어요. 지우려면 노션에서 지워 주세요.");
  if (oldText === newText) throw httpError(400, "바뀐 내용이 없어요.");

  const block = await notion(env, `/blocks/${blockId}`);
  const t = block.type;
  const runs = block[t]?.rich_text;
  if (!Array.isArray(runs)) throw httpError(400, "글 문단만 고칠 수 있어요.");
  const current = runs.map(r => r.plain_text).join("");
  if (current !== oldText) throw httpError(409, "그 사이 노션에서 이 문단이 바뀌었어요. 새로고침한 뒤 다시 고쳐 주세요.", "CONFLICT");

  // 바뀐 구간만 찾는다 (앞뒤 같은 부분 제외)
  let a = 0;
  while (a < oldText.length && a < newText.length && oldText[a] === newText[a]) a++;
  let e1 = oldText.length, e2 = newText.length;
  while (e1 > a && e2 > a && oldText[e1 - 1] === newText[e2 - 1]) { e1--; e2--; }
  // 이모지 같은 2칸짜리 글자를 반으로 자르지 않게
  if (a > 0 && isHighSurrogate(oldText.charCodeAt(a - 1))) a--;
  if (e1 < oldText.length && isLowSurrogate(oldText.charCodeAt(e1))) { e1++; e2++; }

  const nextRuns = applyEdit(runs, a, e1, newText.slice(a, e2));
  const updated = await notion(env, `/blocks/${blockId}`, "PATCH", { [t]: { rich_text: nextRuns } });
  return parseBlock(updated);
}

function isHighSurrogate(c) { return c >= 0xD800 && c <= 0xDBFF; }
function isLowSurrogate(c) { return c >= 0xDC00 && c <= 0xDFFF; }

function applyEdit(runs, start, end, insert) {
  let pos = 0;
  const spans = runs.map(r => { const s = pos; pos += r.plain_text.length; return { r, s, e: pos }; });

  let touched;
  if (start === end) {
    const inside = spans.find(x => x.s <= start && start < x.e);
    const before = [...spans].reverse().find(x => x.e === start);
    touched = [inside || before || spans[spans.length - 1]];
  } else {
    touched = spans.filter(x => x.s < end && x.e > start);
  }
  if (!touched.length || touched.some(x => x.r.type !== "text")) {
    throw httpError(400, "링크나 멘션이 걸린 부분은 노션에서 직접 고쳐 주세요.");
  }

  const first = touched[0];
  const last = touched[touched.length - 1];
  const merged = first.r.plain_text.slice(0, Math.max(0, start - first.s)) + insert + last.r.plain_text.slice(Math.max(0, end - last.s));
  const firstIdx = spans.indexOf(first);
  const lastIdx = spans.indexOf(last);

  const out = [];
  spans.forEach((x, i) => {
    if (i < firstIdx || i > lastIdx) out.push(toInputRun(x.r));
    else if (i === firstIdx && merged) {
      out.push({ type: "text", text: { content: merged, link: first.r.text?.link || null }, annotations: first.r.annotations });
    }
  });
  return splitLongRuns(out);
}

function toInputRun(r) {
  if (r.type === "text") return { type: "text", text: { content: r.text.content, link: r.text.link || null }, annotations: r.annotations };
  if (r.type === "mention") return { type: "mention", mention: r.mention, annotations: r.annotations };
  if (r.type === "equation") return { type: "equation", equation: r.equation, annotations: r.annotations };
  return r;
}

// 노션은 글 조각 하나에 2000자까지
function splitLongRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (r.type !== "text" || r.text.content.length <= 2000) { out.push(r); continue; }
    for (let i = 0; i < r.text.content.length; i += 2000) {
      out.push({ ...r, text: { ...r.text, content: r.text.content.slice(i, i + 2000) } });
    }
  }
  return out;
}

async function addComment(env, body) {
  const pageId = String(body.pageId || "");
  const text = String(body.text || "").trim();
  if (!pageId || !text) throw httpError(400, "메모 내용이 비어 있어요.");
  try {
    await notion(env, "/comments", "POST", {
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }],
    });
  } catch (err) {
    if (/403/.test(err.message)) {
      throw httpError(403, "노션 통합에 '댓글 삽입' 권한이 없어요. 노션 통합 설정의 기능(Capabilities)에서 켜 주세요.");
    }
    throw err;
  }
  return { saved: true };
}

/* ---------------- 목소리 설정 (작품별) ----------------
   voices:_common = 모든 작품 공통 인물 목소리. 작품에서 따로 정하지 않은 인물은 이걸 쓴다 (서술은 작품마다 정함)
------------------------------------------------------- */
const COMMON_ID = "_common";

async function getSettings(env, workId) {
  return (await kv(env).get(`voices:${workId}`, "json")) || null;
}

async function saveSettings(env, workId, body) {
  const pick = v => (v && ENGINES.includes(v.engine) && typeof v.voice === "string" && v.voice)
    ? { engine: v.engine, voice: v.voice, label: String(v.label || "").slice(0, 80) } : null;
  const characters = {};
  for (const [name, v] of Object.entries(body.characters || {})) {
    const p = pick(v);
    if (p) characters[String(name).slice(0, 30)] = p;
  }
  const settings = {
    narrator: pick(body.narrator),
    dialogue: pick(body.dialogue),
    fallback: pick(body.fallback),
    characters,
    updatedAt: new Date().toISOString(),
  };
  await kv(env).put(`voices:${workId}`, JSON.stringify(settings));
  return settings;
}

/* ---------------- 읽은 기록 (기기끼리 동기화) ----------------
   read: 다 읽은 회차 id 목록 / pos: 회차별 읽은 위치 {block, pct, at} / last: 마지막으로 연 회차
   기기마다 보내 온 것을 합친다: read는 합집합, pos·last는 더 최근(at) 것
------------------------------------------------------------ */

async function getProgress(env) {
  return (await kv(env).get("progress", "json")) || { read: [], pos: {}, last: null };
}

async function mergeProgress(env, body) {
  const cur = await getProgress(env);
  const read = new Set([...(cur.read || []), ...(Array.isArray(body.read) ? body.read : [])].map(String));
  const pos = { ...(cur.pos || {}) };
  for (const [id, v] of Object.entries(body.pos || {})) {
    if (!v || typeof v !== "object") continue;
    const at = Number(v.at) || 0;
    if (at > (pos[id]?.at || 0)) pos[id] = { block: Number(v.block) || 0, pct: Math.min(100, Number(v.pct) || 0), at };
  }
  let last = cur.last;
  if (body.last?.epId && (Number(body.last.at) || 0) > (last?.at || 0)) {
    const l = body.last;
    last = { workId: String(l.workId || ""), epId: String(l.epId), workTitle: String(l.workTitle || "").slice(0, 100), epTitle: String(l.epTitle || "").slice(0, 200), at: Number(l.at) };
  }
  const next = { read: [...read].slice(-5000), pos, last };
  await kv(env).put("progress", JSON.stringify(next));
  return next;
}

/* ---------------- 목소리 목록 ---------------- */

async function listVoices(env, engine) {
  if (!ENGINES.includes(engine)) throw httpError(400, "엔진 이름이 잘못됐어요.");
  if (!enginesAvailable(env)[engine]) throw httpError(400, `${engine} API 키가 Worker에 없어요.`);
  const store = kv(env);
  const cacheKey = `voicelist:${engine}`;
  const cached = await store.get(cacheKey, "json");
  if (cached) return cached;

  let voices = [];
  if (engine === "google") {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=ko-KR&key=${env.GOOGLE_TTS_KEY}`);
    const data = await res.json();
    if (!res.ok) throw httpError(502, `Google 목소리 목록 오류: ${data.error?.message || res.status}`);
    voices = (data.voices || [])
      .filter(v => (v.languageCodes || []).includes("ko-KR"))
      .map(v => ({ id: v.name, name: v.name.replace(/^ko-KR-/, ""), gender: v.ssmlGender, family: googleFamily(v.name) }))
      .sort((a, b) => familyRank(a.family) - familyRank(b.family) || a.name.localeCompare(b.name));
  } else if (engine === "azure") {
    const region = env.AZURE_TTS_REGION || "koreacentral";
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
      headers: { "Ocp-Apim-Subscription-Key": env.AZURE_TTS_KEY },
    });
    if (!res.ok) throw httpError(502, `Azure 목소리 목록 오류: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    voices = data
      .filter(v => v.Locale === "ko-KR")
      .map(v => ({ id: v.ShortName, name: `${v.LocalName || ""} (${v.ShortName.replace(/^ko-KR-/, "")})`, gender: v.Gender, family: "all" }));
  } else {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": env.ELEVENLABS_KEY } });
    const data = await res.json();
    if (!res.ok) throw httpError(502, `ElevenLabs 목소리 목록 오류: ${JSON.stringify(data.detail || data).slice(0, 200)}`);
    voices = (data.voices || []).map(v => ({
      id: v.voice_id, name: v.name, gender: v.labels?.gender || "", family: elevenModel(env),
      desc: [v.labels?.age, v.labels?.accent, v.labels?.description].filter(Boolean).join(" · "),
    }));
  }
  await store.put(cacheKey, JSON.stringify(voices), { expirationTtl: 60 * 60 * 12 });
  return voices;
}

function googleFamily(name) {
  const n = String(name);
  if (/Chirp3-HD/i.test(n)) return "Chirp3-HD";
  if (/Chirp-HD/i.test(n)) return "Chirp-HD";
  if (/Neural2/i.test(n)) return "Neural2";
  if (/Wavenet/i.test(n)) return "Wavenet";
  if (/Studio/i.test(n)) return "Studio";
  return "Standard";
}

function familyRank(f) {
  return ["Chirp3-HD", "Chirp-HD", "Neural2", "Wavenet", "Standard", "Studio"].indexOf(f);
}

function elevenModel(env) { return env.ELEVENLABS_MODEL || "eleven_multilingual_v2"; }
function elevenMultiplier(model) { return /flash|turbo/i.test(model) ? 0.5 : 1; }

/* ---------------- 사용량 · 무료 한도 ---------------- */

function monthKey() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7); // 한국 시간 기준 월
}

function limitFor(env, engine, family) {
  if (engine === "google") {
    let table = {};
    try { table = JSON.parse(env.GOOGLE_FREE_LIMITS || "{}"); } catch { /* 기본값 사용 */ }
    const defaults = { "Chirp3-HD": 1000000, "Chirp-HD": 1000000, Neural2: 1000000, Wavenet: 1000000, Standard: 4000000, Studio: 100000 };
    return Number(table[family] ?? defaults[family] ?? 0);
  }
  if (engine === "azure") return Number(env.AZURE_FREE_CHARS || 500000);
  return Number(env.ELEVENLABS_FREE_CREDITS || 10000);
}

function stopRatio(env) {
  const r = Number(env.QUOTA_STOP_RATIO || 0.9);
  return r > 0 && r <= 1 ? r : 0.9;
}

function usageKey(engine, family) { return `usage:${monthKey()}:${engine}:${family}`; }

async function checkQuota(env, engine, family, cost) {
  const used = Number(await kv(env).get(usageKey(engine, family)) || 0);
  const limit = limitFor(env, engine, family);
  if (used + cost > limit * stopRatio(env)) {
    throw httpError(429, `${engineLabel(engine)}${family !== "all" ? `(${family})` : ""} 이번 달 무료 한도에 거의 다 찼어요. (${used.toLocaleString()} / ${limit.toLocaleString()})`, "QUOTA");
  }
}

async function addUsage(env, engine, family, cost) {
  const key = usageKey(engine, family);
  const used = Number(await kv(env).get(key) || 0);
  await kv(env).put(key, String(used + cost), { expirationTtl: 60 * 60 * 24 * 70 });
}

function engineLabel(e) { return { google: "Google", azure: "Azure", elevenlabs: "ElevenLabs" }[e] || e; }

async function getUsage(env) {
  const month = monthKey();
  const list = await kv(env).list({ prefix: `usage:${month}:` });
  const rows = [];
  for (const k of list.keys) {
    const [, , engine, family] = k.name.split(":");
    const used = Number(await kv(env).get(k.name) || 0);
    rows.push({ engine, family, used, limit: limitFor(env, engine, family) });
  }
  let eleven = null;
  if (env.ELEVENLABS_KEY) {
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": env.ELEVENLABS_KEY } });
      if (res.ok) {
        const d = await res.json();
        eleven = { used: d.character_count, limit: d.character_limit, resetAt: d.next_character_count_reset_unix };
      }
    } catch { /* 표시만 생략 */ }
  }
  return { month, stopRatio: stopRatio(env), rows, eleven, engines: enginesAvailable(env) };
}

/* ---------------- TTS ---------------- */

async function tts(env, body) {
  const engine = String(body.engine || "");
  const voice = String(body.voice || "");
  const text = String(body.text || "").trim();
  if (!ENGINES.includes(engine)) throw httpError(400, "엔진 이름이 잘못됐어요.");
  if (!voice) throw httpError(400, "목소리를 골라 주세요.");
  if (!text) throw httpError(400, "읽을 글이 없어요.");
  if (text.length > MAX_TTS_CHARS) throw httpError(400, `한 번에 ${MAX_TTS_CHARS}자까지만 만들 수 있어요.`);
  if (!env.AUDIO) throw httpError(500, "AUDIO(R2 버킷)가 연결되지 않았어요.");
  if (!enginesAvailable(env)[engine]) throw httpError(400, `${engineLabel(engine)} API 키가 Worker에 없어요.`);

  const model = engine === "elevenlabs" ? elevenModel(env) : "";
  const steps = gainSteps(env, engine);
  const hash = await sha256hex(`${engine}\n${voice}\n${model}\n${text}${steps ? `\ng${steps}` : ""}`);
  const key = `chunks/${hash}.mp3`;
  if (await env.AUDIO.head(key)) return { key: hash, cached: true };

  const family = engine === "google" ? googleFamily(voice) : (engine === "elevenlabs" ? model : "all");
  const cost = engine === "elevenlabs" ? Math.ceil(text.length * elevenMultiplier(model)) : text.length;
  await checkQuota(env, engine, family, cost);

  const audio = mp3Gain(await synth(env, engine, voice, model, text), -steps);
  if (!audio || audio.byteLength < 100) throw httpError(502, `${engineLabel(engine)}에서 빈 음성이 왔어요.`);
  await env.AUDIO.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { engine, voice } });
  await addUsage(env, engine, family, cost);
  return { key: hash, cached: false, cost };
}

function gainSteps(env, engine) {
  const v = Number(env[`GAIN_STEPS_${engine.toUpperCase()}`]);
  return Number.isFinite(v) && v >= 0 && v <= 12 ? Math.round(v) : GAIN_STEPS[engine] || 0;
}

/* mp3 소리 크기 바꾸기 (mp3gain과 같은 방식)
   다시 인코딩하지 않고 프레임마다 global_gain 값만 고친다. 1 = 1.5dB. 프레임 길이는 그대로라 이어 붙이기에 영향 없음 */
const MP3_BITRATE = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Gain(buf, delta) {
  if (!delta || !buf?.length) return buf;
  const b = new Uint8Array(buf);
  const readBits = (pos, n) => { let v = 0; for (let i = 0; i < n; i++) { const p = pos + i; v = (v << 1) | ((b[p >> 3] >> (7 - (p & 7))) & 1); } return v; };
  const writeBits = (pos, n, v) => { for (let i = 0; i < n; i++) { const p = pos + i; const bit = (v >> (n - 1 - i)) & 1; b[p >> 3] = (b[p >> 3] & ~(1 << (7 - (p & 7)))) | (bit << (7 - (p & 7))); } };
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f)); // ID3v2 건너뜀
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (b[i + 1] >> 3) & 3;          // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
    const layer = (b[i + 1] >> 1) & 3;        // 1: Layer III
    const prot = b[i + 1] & 1;                // 0이면 CRC 2바이트
    const bri = (b[i + 2] >> 4) & 15, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    const mode = (b[i + 3] >> 6) & 3;          // 3: 모노
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { i++; continue; }
    const mpeg1 = ver === 3;
    const br = MP3_BITRATE[mpeg1 ? 1 : 2][bri] * 1000, sr = MP3_RATE[ver][sri];
    const len = Math.floor((mpeg1 ? 144 : 72) * br / sr) + pad;
    if (len < 8 || i + len > b.length) break;
    const nch = mode === 3 ? 1 : 2;
    let pos = (i + 4 + (prot ? 0 : 2)) * 8;
    let blocks, size;
    if (mpeg1) { pos += 9 + (nch === 1 ? 5 : 3) + 4 * nch; blocks = 2 * nch; size = 59; }
    else { pos += 8 + (nch === 1 ? 1 : 2); blocks = nch; size = 63; }
    for (let k = 0; k < blocks; k++) {
      const at = pos + k * size + 21;           // part2_3_length(12) + big_values(9) 다음이 global_gain(8)
      const g = readBits(at, 8);
      if (g > 0) writeBits(at, 8, Math.max(1, Math.min(255, g + delta)));
    }
    i += len;
  }
  return b;
}

// 세 엔진 모두 24kHz 모노 mp3로 받는다 → 앱에서 이어 붙일 수 있음
async function synth(env, engine, voice, model, text) {
  if (engine === "google") {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "ko-KR", name: voice },
        audioConfig: { audioEncoding: "MP3", sampleRateHertz: 24000 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error?.message || String(res.status);
      if (res.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(msg)) throw httpError(429, `Google 한도 초과: ${msg}`, res.status === 429 ? "RATE" : "QUOTA");
      throw httpError(502, `Google TTS 오류: ${msg}`);
    }
    const bin = atob(data.audioContent || "");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  if (engine === "azure") {
    const region = env.AZURE_TTS_REGION || "koreacentral";
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": env.AZURE_TTS_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "NovelReader",
      },
      body: ssml,
    });
    if (!res.ok) {
      const msg = (await res.text()).slice(0, 200);
      if (res.status === 429) throw httpError(429, "Azure 요청이 너무 많아요. 잠시 뒤 다시 시도해요.", "RATE");
      if (res.status === 403 && /quota/i.test(msg)) throw httpError(429, "Azure 이번 달 무료 한도를 다 썼어요.", "QUOTA");
      throw httpError(502, `Azure TTS 오류 ${res.status}: ${msg}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_24000_48`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) {
    const raw = await res.text();
    let detail = raw;
    try { const d = JSON.parse(raw).detail; detail = typeof d === "string" ? d : JSON.stringify(d); } catch { /* 원문 사용 */ }
    if (/quota_exceeded|credits/i.test(detail)) throw httpError(429, "ElevenLabs 이번 달 무료 크레딧을 다 썼어요.", "QUOTA");
    if (res.status === 429) throw httpError(429, "ElevenLabs 요청이 너무 많아요. 잠시 뒤 다시 시도해요.", "RATE");
    if (/moderat|policy|safety|violat|blocked|flagged/i.test(detail)) throw httpError(422, "ElevenLabs가 이 문장을 거절했어요.", "REFUSED");
    throw httpError(502, `ElevenLabs 오류 ${res.status}: ${detail.slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

async function getChunk(env, hash, cors) {
  if (!env.AUDIO) throw httpError(500, "AUDIO(R2 버킷)가 연결되지 않았어요.");
  const obj = await env.AUDIO.get(`chunks/${hash}.mp3`);
  if (!obj) throw httpError(404, "음성 조각을 찾지 못했어요.");
  return new Response(obj.body, {
    status: 200,
    headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=31536000, immutable" },
  });
}
