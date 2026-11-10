import INDEX_HTML from "../public/index.html";
import FINANCE_BENTO_JS from "../public/finance-bento.js";

// kitsbase API: 팀 초대코드 가입, 이름+비밀번호 로그인, 문서 저장/동기화 (Cloudflare Workers + D1)
const COLLECTIONS = new Set(["projects", "items", "notes", "folders", "messages", "mindmaps"]);
const ID_RE = /^[A-Za-z0-9_\-.:@+~]{1,120}$/;
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const MAX_DOC_BYTES = 400_000;
const SESSION_DAYS = 30;
const COOKIE = "kb_session";
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (status, code, error) => json({ code, error }, status);

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = (bytes = 12) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));

function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
  return b64u(bits);
}

function requireConfig(env) {
  if (!env.DB) return "D1 데이터베이스(DB)가 연결되지 않았습니다.";
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) return "SESSION_SECRET이 설정되지 않았습니다.";
  if (!env.INVITE_CODE) return "INVITE_CODE가 설정되지 않았습니다.";
  return null;
}

async function sessionCookie(env, userId, url) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const sig = await hmac(env.SESSION_SECRET, `${userId}.${exp}`);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${userId}.${exp}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
const clearCookie = (url) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`;

async function currentUser(request, env) {
  const raw = (request.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [userId, exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!userId || !exp || !sig || Number(exp) < Date.now()) return null;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, `${userId}.${exp}`))) return null;
  return env.DB.prepare("SELECT id, name, role, color, created_at, updated_at FROM users WHERE id = ?").bind(userId).first();
}

const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, color: u.color, createdAt: u.created_at, updatedAt: u.updated_at });
const cleanName = (v) => (typeof v === "string" ? v.trim().slice(0, 20) : "");
const cleanText = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function readBody(request) {
  try { const b = await request.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; }
}

async function putDoc(env, collection, id, data, userId) {
  const text = JSON.stringify(data);
  if (text.length > MAX_DOC_BYTES) return fail(413, "too_large", "저장할 내용이 너무 큽니다.");
  await env.DB.prepare(
    `INSERT INTO docs (collection, id, data, deleted, seq, updated_at, updated_by)
     VALUES (?1, ?2, ?3, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM docs), ?4, ?5)
     ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, deleted = 0, seq = excluded.seq,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(collection, id, text, Date.now(), userId).run();
  return json({ ok: true });
}

async function handleApi(request, env, url) {
  const configError = requireConfig(env);
  if (configError) return fail(500, "not_configured", configError);
  const path = url.pathname, method = request.method;

  if (path === "/api/register" && method === "POST") {
    const b = await readBody(request);
    if (!b) return fail(400, "invalid_argument", "입력값을 확인해주세요.");
    if (!safeEqual(String(b.invite || "").trim(), env.INVITE_CODE)) return fail(403, "bad_invite", "초대코드가 맞지 않습니다.");
    const name = cleanName(b.name), password = String(b.password || "");
    if (!name) return fail(400, "invalid_argument", "이름을 입력해주세요.");
    if (password.length < 6) return fail(400, "invalid_argument", "비밀번호는 6자 이상이어야 합니다.");
    const max = Number(env.MAX_MEMBERS || 0);
    if (max > 0) {
      const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
      if (n >= max) return fail(403, "team_full", `팀원은 최대 ${max}명까지 등록할 수 있습니다.`);
    }
    if (await env.DB.prepare("SELECT 1 FROM users WHERE name = ?").bind(name).first()) return fail(409, "name_taken", "같은 이름의 팀원이 이미 있습니다.");
    const id = "u_" + randomId(9), salt = randomId(16), now = Date.now();
    const color = HEX_RE.test(b.color || "") ? b.color.toUpperCase() : "#DD3A2E";
    await env.DB.prepare("INSERT INTO users (id, name, role, color, pw_hash, pw_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, name, cleanText(b.role, 30), color, await hashPassword(password, salt), salt, now, now).run();
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return json({ user: publicUser(user) }, 201, { "set-cookie": await sessionCookie(env, id, url) });
  }

  if (path === "/api/login" && method === "POST") {
    const b = await readBody(request);
    const name = cleanName(b && b.name), password = String((b && b.password) || "");
    const user = name ? await env.DB.prepare("SELECT * FROM users WHERE name = ?").bind(name).first() : null;
    const ok = user && safeEqual(await hashPassword(password, user.pw_salt), user.pw_hash);
    if (!ok) return fail(401, "bad_login", "이름 또는 비밀번호가 맞지 않습니다.");
    return json({ user: publicUser(user) }, 200, { "set-cookie": await sessionCookie(env, user.id, url) });
  }

  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie(url) });

  const me = await currentUser(request, env);
  if (!me) return fail(401, "unauthenticated", "로그인이 필요합니다.");

  if (path === "/api/me" && method === "GET") return json({ user: publicUser(me) });

  if (path === "/api/password" && method === "POST") {
    const b = await readBody(request);
    const row = await env.DB.prepare("SELECT pw_hash, pw_salt FROM users WHERE id = ?").bind(me.id).first();
    if (!b || !safeEqual(await hashPassword(String(b.current || ""), row.pw_salt), row.pw_hash)) return fail(403, "bad_login", "현재 비밀번호가 맞지 않습니다.");
    if (String(b.next || "").length < 6) return fail(400, "invalid_argument", "새 비밀번호는 6자 이상이어야 합니다.");
    const salt = randomId(16);
    await env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(String(b.next), salt), salt, Date.now(), me.id).run();
    return json({ ok: true });
  }

  if (path === "/api/sync" && method === "GET") {
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    const { results } = await env.DB.prepare("SELECT collection, id, data, deleted, seq FROM docs WHERE seq > ? ORDER BY seq LIMIT 300").bind(since).all();
    const members = (await env.DB.prepare("SELECT id, name, role, color, created_at, updated_at FROM users ORDER BY created_at").all()).results.map(publicUser);
    const docs = results.map((r) => ({ collection: r.collection, id: r.id, deleted: !!r.deleted, data: r.deleted ? null : JSON.parse(r.data) }));
    return json({ docs, members, cursor: results.length ? results[results.length - 1].seq : since, more: results.length === 300, me: publicUser(me) });
  }

  const m = path.match(/^\/api\/docs\/([a-z]+)\/([^/]+)$/);
  if (m) {
    const collection = m[1], id = decodeURIComponent(m[2]);
    if (!ID_RE.test(id)) return fail(400, "invalid_argument", "잘못된 문서 이름입니다.");

    // 팀원 정보: 본인 것만 수정
    if (collection === "members") {
      if (method !== "PUT") return fail(405, "invalid_argument", "지원하지 않는 요청입니다.");
      if (id !== me.id) return fail(403, "invalid_argument", "본인 정보만 수정할 수 있습니다.");
      const b = await readBody(request);
      const name = cleanName(b && b.name);
      if (!name) return fail(400, "invalid_argument", "이름을 입력해주세요.");
      if (await env.DB.prepare("SELECT 1 FROM users WHERE name = ? AND id <> ?").bind(name, me.id).first()) return fail(409, "name_taken", "같은 이름의 팀원이 이미 있습니다.");
      const color = HEX_RE.test((b && b.color) || "") ? b.color.toUpperCase() : me.color;
      await env.DB.prepare("UPDATE users SET name = ?, role = ?, color = ?, updated_at = ? WHERE id = ?").bind(name, cleanText(b.role, 30), color, Date.now(), me.id).run();
      return json({ ok: true });
    }

    if (!COLLECTIONS.has(collection)) return fail(404, "invalid_argument", "알 수 없는 데이터 종류입니다.");
    const existingRow = await env.DB.prepare("SELECT data, deleted FROM docs WHERE collection = ? AND id = ?").bind(collection, id).first();
    const existing = existingRow && !existingRow.deleted ? JSON.parse(existingRow.data) : null;

    if (method === "GET") return existing ? json({ data: existing }) : fail(404, "not_found", "없는 문서입니다.");

    if (method === "PUT") {
      let data = await readBody(request);
      if (!data) return fail(400, "invalid_argument", "입력값을 확인해주세요.");
      if (collection === "messages") {
        if (!existing) {
          data = { ...data, from: me.id, readBy: [] };
        } else if (existing.from !== me.id) {
          // 받은 사람은 '읽음' 표시만 추가할 수 있음
          const readBy = new Set(Array.isArray(existing.readBy) ? existing.readBy : []);
          if (Array.isArray(data.readBy) && data.readBy.includes(me.id)) readBy.add(me.id);
          data = { ...existing, readBy: [...readBy] };
        } else {
          data = { ...data, from: me.id };
        }
      }
      data.id = id;
      return putDoc(env, collection, id, data, me.id);
    }

    if (method === "DELETE") {
      if (collection === "messages" && existing && existing.from !== me.id) return fail(403, "invalid_argument", "보낸 사람만 메모를 삭제할 수 있습니다.");
      await env.DB.prepare(
        `INSERT INTO docs (collection, id, data, deleted, seq, updated_at, updated_by)
         VALUES (?1, ?2, '{}', 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM docs), ?3, ?4)
         ON CONFLICT (collection, id) DO UPDATE SET data = '{}', deleted = 1, seq = excluded.seq, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).bind(collection, id, Date.now(), me.id).run();
      return json({ ok: true });
    }
  }

  return fail(404, "not_found", "없는 주소입니다.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return fail(500, "unavailable", "서버에서 요청을 처리하지 못했습니다.");
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    if (url.pathname === "/finance-bento.js") {
      return new Response(request.method === "HEAD" ? null : FINANCE_BENTO_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" },
      });
    }
    // 화면은 한 페이지(index.html)뿐이라 Worker가 직접 돌려줍니다
    return new Response(request.method === "HEAD" ? null : INDEX_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
      },
    });
  },
};
