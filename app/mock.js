// "예시로 둘러보기"용 가짜 데이터. Worker 없이 화면과 브라우저 음성만 시험해 볼 수 있다.

const N = t => ({ t });
const G = (t, extra = {}) => ({ t, ...extra });

function narr(id, text) {
  return { id, type: "paragraph", kind: "narration", plain: text, prefixLen: 0, runs: [N(text)], speak: text };
}
function dlg(id, who, line) {
  const plain = `${who} | ${line}`;
  return { id, type: "paragraph", kind: "dialogue", speaker: who, plain, prefixLen: who.length + 3, runs: [N(line)], speak: line.replace(/^["“]|["”]$/g, "") };
}

const episodes = {
  e0: {
    id: "e0", title: "프롤로그 | 빗소리", lastEdited: "2026-11-05T03:18:00.000Z",
    blocks: [
      { id: "b1", type: "paragraph", kind: "scene", plain: "▌ #01 | 9월 | 💬 우산 | 언덕길", runs: [G("▌ #01 | 9월 | 💬 우산 | 언덕길")], speak: "" },
      narr("b2", "우산을 두고 내렸다는 걸, 언덕을 절반쯤 오르고 나서야 알았다."),
      narr("b3", "빗줄기는 생각보다 따뜻했다. 그래서 오히려 더 이상했다."),
      dlg("b4", "하나", "\"여기까지 왔으면, 그냥 올라가.\""),
      dlg("b5", "도윤", "\"…지금 몇 시인 줄은 알아요?\""),
      { id: "b6", type: "paragraph", kind: "narration", plain: "문 너머에서 딱 하고 작은 소리가 났다.", prefixLen: 0, runs: [N("문 너머에서 "), G("딱", { i: 1 }), N(" 하고 작은 소리가 났다.")], speak: "문 너머에서 딱 하고 작은 소리가 났다." },
      { id: "b7", kind: "divider" },
      { id: "b8", type: "paragraph", kind: "scene", plain: "▌ #02 | 같은 시각 | 💬 반지 | 현관 안", runs: [G("▌ #02 | 같은 시각 | 💬 반지 | 현관 안")], speak: "" },
      narr("b9", "도윤은 와인을 따라 놓고 한 모금도 마시지 않은 채였다. 레코드판이 끝나 바늘이 헛돌기 시작했을 때, 밖에서 소리가 났다."),
      dlg("b10", "도윤", "\"하나 씨. 눈 떠 봐요. 나 봐요.\""),
      dlg("b11", "하나", "\"…도윤 씨.\""),
      narr("b12", "그 목소리에 도윤은 숨을 멈췄다. 사 년 만이었다."),
    ],
  },
  e1: {
    id: "e1", title: "1화 | 다시, 처음", lastEdited: "2026-11-05T03:32:00.000Z",
    blocks: [
      narr("c1", "눈을 뜨자 하얀 천장이 보였다."),
      dlg("c2", "하나", "\"여기… 병원이에요?\""),
      dlg("c3", "서진", "\"네. 사흘 동안 잠들어 계셨어요.\""),
      narr("c4", "창밖으로는 여전히 비가 내리고 있었다."),
    ],
  },
};

const work = {
  workId: "w1",
  title: "예시 작품",
  characters: [
    { name: "하나", color: "pink" }, { name: "도윤", color: "brown" }, { name: "서진", color: "blue" },
  ],
  routes: [{ name: "본편", color: "gray" }, { name: "도윤 루트", color: "brown" }],
  checks: ["체크박스"],
  episodes: [
    { id: "e0", title: "프롤로그 | 빗소리", no: 0, route: "본편", status: "초안", summary: "비 오는 밤, 하나는 사 년 만에 그 집 계단을 오른다.", characters: ["하나", "도윤"], checks: { 체크박스: true }, lastEdited: "2026-11-05T03:18:00.000Z" },
    { id: "e1", title: "1화 | 다시, 처음", no: 1, route: "본편", status: "완료", summary: "병실에서 눈을 뜬 하나.", characters: ["하나", "서진"], checks: { 체크박스: false }, lastEdited: "2026-11-05T03:32:00.000Z" },
    { id: "e2", title: "2화 | (기획 중)", no: 2, route: "본편", status: "기획", summary: "", characters: [], checks: { 체크박스: false }, lastEdited: "2026-11-05T03:32:00.000Z" },
  ],
};

let mockShelves = { list: [], of: {}, at: 0 };
let mockMarks = { items: [] };

export async function mockApi(path, opts = {}) {
  await new Promise(r => setTimeout(r, 120));
  const method = opts.method || "GET";
  let m;
  if (path === "/api/ping") return { ok: true, engines: { google: false, azure: false, elevenlabs: false } };
  if (path === "/api/works") return { ok: true, works: [
    { id: "w1", title: "예시 작품", icon: "🌧️", lastEdited: "2026-11-09T12:00:00.000Z" },
    { id: "w2", title: "예시 작품 2", icon: "🌙", lastEdited: "2026-11-08T12:00:00.000Z" },
    { id: "w3", title: "예시 작품 3", icon: "", lastEdited: "2026-11-01T12:00:00.000Z" },
  ] };
  if (path === "/api/marks") {
    if (method === "PUT") {
      const map = new Map(mockMarks.items.map(m => [m.id, m]));
      for (const m of opts.body.items) if (!map.has(m.id) || map.get(m.id).at < m.at) map.set(m.id, m);
      mockMarks = { items: [...map.values()] };
    }
    return { ok: true, marks: mockMarks };
  }
  if (path === "/api/shelves") {
    if (method === "PUT") mockShelves = { ...opts.body };
    return { ok: true, shelves: mockShelves };
  }
  if ((m = path.match(/^\/api\/pages\/(\w+)\/checkbox$/))) {
    const ep = work.episodes.find(e => e.id === m[1]);
    ep.checks[opts.body.prop] = opts.body.value;
    return { ok: true, prop: opts.body.prop, value: opts.body.value };
  }
  if (path === "/api/works/w1") return { ok: true, ...work };
  if ((m = path.match(/^\/api\/episodes\/(\w+)$/))) {
    const ep = episodes[m[1]];
    if (!ep) throw Object.assign(new Error("없는 회차예요"), { status: 404 });
    return { ok: true, episode: structuredClone(ep) };
  }
  if ((m = path.match(/^\/api\/blocks\/(\w+)$/)) && method === "PATCH") {
    for (const ep of Object.values(episodes)) {
      const i = ep.blocks.findIndex(b => b.id === m[1]);
      if (i < 0) continue;
      const b = ep.blocks[i];
      if (b.plain !== opts.body.oldText) throw Object.assign(new Error("그 사이 바뀌었어요"), { status: 409 });
      const body = opts.body.newText.slice(b.prefixLen || 0);
      const next = b.kind === "dialogue" ? dlg(b.id, b.speaker, body) : narr(b.id, body);
      ep.blocks[i] = next;
      return { ok: true, block: structuredClone(next) };
    }
    throw new Error("문단을 찾지 못했어요");
  }
  if (path === "/api/comments") return { ok: true, saved: true };
  if (path === "/api/presets") return { ok: true, presets: opts.body || { list: [] } };
  if (path.startsWith("/api/settings/")) return { ok: true, settings: null, common: null };
  if (path === "/api/usage") return { ok: true, usage: { month: "", stopRatio: 0.9, rows: [], eleven: null } };
  throw new Error("예시 모드에서는 쓸 수 없는 기능이에요.");
}
