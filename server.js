// agy-bridge HTTP layer: OpenAI-compatible endpoints over the worker pool.
import http from "node:http";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_BIN, HEALTH, Health, ToolParser, Worker, digestMessages,
  mapModel, readQuota, renderFull, stageImages, imagePromptAddition, cleanupDir,
  familyOf, worstForFamily, parseRetryAfter, withSwappedLogin, spawnWorkerFor, snapshotLogin,
} from "./worker.js";

const CFG_PATH = join(homedir(), "agy-bridge", "agy-bridge.json");
const cfg = JSON.parse(await fs.readFile(CFG_PATH, "utf-8"));

// snapshot CLI: bun server.js snapshot <name>
// snapshots the CURRENTLY logged-in agy account into a slot. flow:
//   1. log in globally: agy   (pick account 2 in the TUI)
//   2. bun server.js snapshot acc2
//   3. repeat per account. bridge discovers slots with zero restart.
if (process.argv[2] === "snapshot" && process.argv[3]) {
  const name = process.argv[3];
  const { mkdir } = await import("node:fs/promises");
  const dir = join(cfg.accountsDir || join(homedir(), "agy-bridge", "accounts"), name);
  await mkdir(dir, { recursive: true });
  const { name: n, email, blob } = snapshotLogin(name);
  void n;
  const { promises: fsp } = await import("node:fs");
  await fsp.writeFile(join(dir, "login.json"), blob, { mode: 0o600 });
  console.log(`slotted ${name} <${email || "unknown email"}>`);
  const { verifySlot: _v } = await import("./worker.js");
  try {
    const q = await _v(AGY_BIN, dir);
    const gs = (q.groups || []).map((g) => `${g.label.split("/")[0].trim()} ${g.remaining === null ? "?" : Math.round(g.remaining * 100) + "%"}`).join(", ");
    console.log(`verified: ${gs || q.error || "unreadable"}`);
  } catch (e) {
    console.log(`verify skipped: ${String(e.message || e).slice(0, 100)}`);
  }
  process.exit(0);
}

// onboard CLI: bun server.js onboard
// backs up the live login, clears it, and prints the 2 manual steps.
// the OAuth click itself needs a human; everything else is automatic.
if (process.argv[2] === "onboard") {
  const { mkdir } = await import("node:fs/promises");
  const { promises: fsp } = await import("node:fs");
  const { snapshotLogin: _snap, clearLiveLogin: _clear } = await import("./worker.js");
  try {
    const cur = _snap("live-backup");
    const dir = join(cfg.accountsDir || join(homedir(), "agy-bridge", "accounts"), "live-backup");
    await mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, "login.json"), cur.blob, { mode: 0o600 });
    console.log(`backed up live login <${cur.email || "unknown"}> to slot live-backup`);
  } catch {
    console.log("no live login to back up (starting fresh)");
  }
  await _clear();
  console.log("live login cleared. next:");
  console.log("  1. run: agy            (log in as the next Google account)");
  console.log("  2. run: bun server.js snapshot <name>   (saves + verifies, bridge picks it up)");
  process.exit(0);
}

// verify CLI: bun server.js verify <name>
// quota-reads a slot through a swap; live login untouched.
if (process.argv[2] === "verify" && process.argv[3]) {
  const { verifySlot } = await import("./worker.js");
  const dir = join(cfg.accountsDir || join(homedir(), "agy-bridge", "accounts"), process.argv[3]);
  const q = await verifySlot(AGY_BIN, dir);
  if (q.error) { console.log(`slot ${process.argv[3]}: UNUSABLE (${q.error})`); process.exit(1); }
  for (const g of q.groups || []) console.log(`  ${g.label}: ${g.remaining === null ? "?" : Math.round(g.remaining * 100) + "%"}  reset ${g.reset || "?"}`);
  process.exit(0);
}
// puts a slot's login live WITHOUT auto-revert, for interactive agy use.
if (process.argv[2] === "activate" && process.argv[3]) {
  const { activateLogin } = await import("./worker.js");
  const { promises: fsp } = await import("node:fs");
  const dir = join(cfg.accountsDir || join(homedir(), "agy-bridge", "accounts"), process.argv[3]);
  await activateLogin(await fsp.readFile(join(dir, "login.json"), "utf-8"));
  console.log(`live login is now slot ${process.argv[3]}`);
  process.exit(0);
}

const PORT = cfg.port ?? 8766, HOST = cfg.host ?? "127.0.0.1";
const API_KEY = cfg.apiKey || "";
const CAP = cfg.trajectoryCap ?? 239000;

const health = new Health(join(homedir(), "agy-bridge", "agy-health.json"));
await health.load();
// pool: sessionKey -> { worker, accountName, model }
// conv store: sessionKey -> { conversationId, accountName, model, updatedAt }
const CONV_PATH = join(homedir(), "agy-bridge", "agy-conv.json");
let convStore = {};
try { convStore = JSON.parse(await fs.readFile(CONV_PATH, "utf-8")); } catch {}
function saveConv() {
  fs.writeFile(CONV_PATH, JSON.stringify(convStore)).catch(() => {});
}
// usage stats: append-only JSONL for their cost tracking
const STATS_PATH = join(homedir(), "agy-bridge", "usage.jsonl");
function logUsage(rec) {
  fs.appendFile(STATS_PATH, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n").catch(() => {});
}
// live model catalog (hourly), static fallback
let catalogCache = { at: 0, ids: null };
async function modelIds() {
  if (catalogCache.ids && Date.now() - catalogCache.at < 3600 * 1000) return catalogCache.ids;
  try {
    const { spawn } = await import("node:child_process");
    const ids = await new Promise((resolve) => {
      const p = spawn(AGY_BIN, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolve(null); }, 30000);
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", () => {
        clearTimeout(kill);
        const list = out.split("\n").map((l) => l.split("\t")[0].trim()).filter((s) => /^[a-z][a-z0-9._-]*-[a-z0-9._-]+$/.test(s));
        resolve(list.length ? [...new Set(list)] : null);
      });
      p.on("error", () => { clearTimeout(kill); resolve(null); });
    });
    if (ids) { catalogCache = { at: Date.now(), ids }; return ids; }
  } catch {}
  return catalogCache.ids || ["gemini-3.8-flash", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high",
    "gemini-3.1-pro", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b",
    "flash", "pro", "sonnet", "opus", "gpt", "default"];
}
// pool: sessionKey -> { worker, accountName, model }
const pool = new Map();
// accounts: name -> { name, geminiDir, email, lockedUntil, quotaCache, quotaAt }
// Discovery is automatic: every subdir of accountsDir holding an agy login,
// plus the default ~/.gemini login, plus any explicit cfg.accounts entries.
// New logins appear with zero config and zero restart.
const accounts = new Map();

async function slotBlob(acc) {
  return fs.readFile(join(acc.slotDir, "login.json"), "utf-8");
}

async function refreshAccounts() {
  const seen = new Set();
  const add = async (name, slotDir) => {
    if (seen.has(name)) return;
    seen.add(name);
    let acc = accounts.get(name);
    if (!acc) {
      let email = null;
      try {
        const raw = await fs.readFile(join(slotDir, "login.json"), "utf-8");
        const q = (JSON.parse(raw).id_token || "").split(".")[1] || "";
        email = JSON.parse(Buffer.from(q + "=".repeat((-q.length % 4 + 4) % 4), "base64")).email || null;
      } catch {}
      acc = { name, slotDir, geminiDir: slotDir, email, lockedUntil: 0, quotaCache: null, quotaAt: 0 };
      accounts.set(name, acc);
    } else {
      acc.slotDir = slotDir; acc.geminiDir = slotDir;
    }
  };
  const root = cfg.accountsDir || join(homedir(), "agy-bridge", "accounts");
  try {
    for (const ent of await fs.readdir(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = join(root, ent.name);
      try { await fs.access(join(dir, "login.json")); await add(ent.name, dir); }
      catch {}
    }
  } catch {}
  for (const a of cfg.accounts || []) if (a && a.name && (a.slotDir || a.geminiDir)) await add(a.name, a.slotDir || a.geminiDir);
  for (const [name, acc] of accounts) {
    try { await fs.access(join(acc.slotDir, "login.json")); }
    catch { accounts.delete(name); }
  }
}

function needAuth(req, res) {
  if (!API_KEY) return true;
  const h = req.headers.authorization || "";
  if (h === `Bearer ${API_KEY}`) return true;
  return send(res, 401, { error: { message: "bad key", type: "auth", code: "bad_key" } }), false;
}
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 50 * 1024 * 1024) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

async function quotaOf(acc) {
  const now = Date.now();
  if (acc.quotaCache && now - acc.quotaAt < (cfg.quotaCacheSec ?? 60) * 1000) return acc.quotaCache;
  const { withSwappedLogin } = await import("./worker.js");
  const blob = await slotBlob(acc);
  const q = await withSwappedLogin(blob, () => readQuota(AGY_BIN, acc.geminiDir));
  acc.quotaCache = q; acc.quotaAt = now;
  return q;
}
async function pickAccount(exclude = new Set(), family = "gemini") {
  await refreshAccounts();
  const now = Date.now();
  const scored = [];
  for (const [name, acc] of accounts) {
    if (exclude.has(name)) continue;
    if (acc.lockedUntil > now) continue;
    const hs = health.score(name);
    if (hs < HEALTH.floor) continue;
    const q = await quotaOf(acc);
    const groups = (q && q.groups) || [];
    const fam = worstForFamily(groups, family);
    const fb = fam.matched ? fam : worstForFamily(groups, "gemini");
    const w = fb.matched ? fb.worst : 1;
    if (w < (cfg.minQuotaFraction ?? 0.30)) {
      const resets = groups.map((g) => Date.parse(g.reset || "")).filter(Number.isFinite);
      acc.lockedUntil = resets.length ? Math.max(...resets) : now + 6 * 3600 * 1000;
      continue;
    }
    scored.push({ name, score: hs + Math.random() * 5 + w * 10 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].name : null;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--)
    if ((messages[i].role || "user") === "user") return messages[i];
  return messages[messages.length - 1];
}

async function* runCompletion({ messages, tools, model, sessionKey, signal }) {
  // image detection: any image_url part?
  const hasImage = messages.some((m) => {
    const c = m.content;
    const items = Array.isArray(c) ? c : [c];
    return items.some((it) => it && typeof it === "object" && (it.type === "image_url" || (typeof it.url === "string" && /^(data:image|https?:)/.test(it.url))));
  });
  const { base, effort } = mapModel(model, cfg.defaultModel);
  const family = familyOf(base);
  const note = (account, u) => {
    if (u) logUsage({ account, model: base, session: sessionKey, in: u.prompt || 0, out: u.completion || 0 });
  };

  // --- image turns go one-shot (sandboxed flag), never the persistent worker
  if (hasImage) {
    const ai = await pickAccount(new Set(), "gemini");
    if (!ai) throw Object.assign(new Error("all accounts exhausted/locked"), { code: "quota" });
    const { dir, saved } = await stageImages(messages, tmpdir());
    try {
      const extra = "\n\n" + imagePromptAddition(saved);
      const full = renderFull(
        [...messages.slice(0, -1), { ...lastUserText(messages), content: (typeof lastUserText(messages).content === "string" ? lastUserText(messages).content : JSON.stringify(lastUserText(messages).content)) + extra }],
        tools
      );
      // one-shot under this account's login; image turns don't stream
      // (buffered) so the swap window stays as short as possible
      const acc = accounts.get(ai);
      const blob = await slotBlob(acc);
      const collected = await withSwappedLogin(blob, async () => {
        const w = new Worker({ agyBin: AGY_BIN, geminiDir: acc.geminiDir, model: base, effort, silenceMs: cfg.silenceTimeoutSec * 1000, absoluteMs: cfg.absoluteTimeoutSec * 1000, skipPermissions: true });
        w.loginBlob = blob;
        const out = [];
        try {
          const gen = w.runTurn(full);
          const parser = new ToolParser(new Set((tools || []).map((t) => (t.function || {}).name).filter(Boolean)));
          for await (const ev of gen) {
            if (ev.type !== "event") continue;
            const su = ev.raw.step_update;
            if (su && typeof su.text_delta === "string")
              for (const [k, v] of parser.feed(su.text_delta)) { if (k === "text") out.push({ text: v }); else if (k === "call_end") out.push({ toolcall: v }); }
          }
          for (const [k, v] of parser.finish()) { if (k === "text") out.push({ text: v }); else if (k === "call_end") out.push({ toolcall: v }); }
          out.push({ usage: null });
        } finally { w.kill(); }
        return out;
      });
      for (const e of collected) yield e;
      health.ok(ai, true, false); health.save();
      return;
    } catch (e) {
      const rate = /quota|rate.?limit|429|exhaust/i.test(e.message || "");
      health.ok(ai, false, rate); health.save();
      if (rate) { const acc0 = accounts.get(ai); if (acc0) acc0.lockedUntil = Date.now() + 3600 * 1000; return yield* runCompletion({ messages, tools, model, sessionKey }); }
      throw e;
    } finally { await cleanupDir(dir); }
  }

  // --- text turns ride the persistent worker
  const tried = new Set();
  const shortRetried = new Set();
  for (;;) {
    let slot = pool.get(sessionKey);
    if (slot && !accounts.has(slot.accountName)) { try { slot.worker.kill(); } catch {} pool.delete(sessionKey); slot = undefined; }
    if (!slot || slot.worker.dead) {
      const ai = await pickAccount(tried, family);
      if (!ai) throw Object.assign(new Error("all accounts exhausted/locked"), { code: "quota" });
      tried.add(ai);
      // restore prior conversation on the same account when possible
      const saved = convStore[sessionKey];
      const resumeId = saved && saved.accountName === ai && saved.model === base ? saved.conversationId : null;
      slot = { worker: await spawnWorkerFor({ agyBin: AGY_BIN, slotDir: accounts.get(ai).slotDir, model: base, effort, conversationId: resumeId, silenceMs: cfg.silenceTimeoutSec * 1000, absoluteMs: cfg.absoluteTimeoutSec * 1000 }), accountName: ai, model: base, effort };
      pool.set(sessionKey, slot);
      if (slot.worker.model !== base || slot.worker.effort !== effort) { slot.worker.kill(); slot.worker.model = base; slot.worker.effort = effort; }
    }
    const w = slot.worker, ai = slot.accountName;
    const digests = digestMessages(messages);
    const known = w.digests;
    let startAt = 0;
    while (startAt < known.length && startAt < digests.length && known[startAt] === digests[startAt]) startAt++;
    const fresh = startAt >= known.length && startAt >= digests.length ? [] : messages.slice(startAt);
    const promptText = w.digests.length === 0
      ? renderFull(messages, tools)
      : "New since your last reply:\n" + fresh.map((m) => `[${m.role || "user"}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n") +
        "\n\n(Tool list unchanged. Reply normally, or with <tool_call> blocks.)";
    // trajectory guard: estimate prompt + tracked history
    const est = Math.ceil(promptText.length / 4) + w.trajTokens;
    console.log(`prompt_chars=${promptText.length} est_tokens=${est} traj=${w.trajTokens} session=${sessionKey}`);
    if (est > CAP) {
      const err = new Error(`agy trajectory near ${CAP} tokens: run /compact in opencode, then retry. History is intact; this guard prevents silent truncation.`);
      err.code = "trajectory_full";
      throw err;
    }
    const parser = new ToolParser(new Set((tools || []).map((t) => (t.function || {}).name).filter(Boolean)));
    try {
      const gen = w.runTurn(promptText);
      let result = null;
      // capture generator return (result): iterate manually
      while (true) {
        const n = await gen.next();
        if (n.done) { result = n.value; break; }
        const ev = n.value;
        if (ev.type !== "event") continue;
        const su = ev.raw.step_update;
        if (su && typeof su.text_delta === "string")
          for (const [k, v] of parser.feed(su.text_delta)) { if (k === "text") yield { text: v }; else if (k === "call_start") yield { toolcall_start: v }; else if (k === "call_end") yield { toolcall: v }; }
      }
      for (const [k, v] of parser.finish()) { if (k === "text") yield { text: v }; else if (k === "call_start") yield { toolcall_start: v }; else if (k === "call_end") yield { toolcall: v }; }
      w.digests = digests;
      const u = (result && result.usage) || {};
      note(ai, u.prompt_tokens || u.input_tokens ? { prompt: u.prompt_tokens ?? u.input_tokens ?? 0, completion: (u.completion_tokens ?? u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) } : null);
      if (w.conversationId) {
        convStore[sessionKey] = { conversationId: w.conversationId, accountName: ai, model: base, updatedAt: Date.now() };
        saveConv();
      }
      yield { usage: { prompt: (u.input_tokens || 0), completion: (u.output_tokens || 0) + (u.thinking_tokens || 0) } };
      health.ok(ai, true, false); health.save();
      return;
    } catch (e) {
      if (e.code === "effort_rejected") { w.effortCap.ok = false; continue; }
      const rate = e.code === "quota" || /quota|rate.?limit|429|exhaust/i.test(e.message || "");
      const auth = e.code === "auth";
      health.ok(ai, false, rate); health.save();
      // short rate limits (<=5s): wait once and retry the SAME account
      if (rate && !shortRetried.has(ai)) {
        const wait = parseRetryAfter(e.message);
        if (wait !== null && wait <= 5) {
          shortRetried.add(ai);
          await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
          continue;
        }
      }
      if (rate || auth || e.code === "worker_dead") {
        if (rate) { const acc1 = accounts.get(ai); if (acc1) acc1.lockedUntil = Date.now() + 3600 * 1000; }
        w.kill(); pool.delete(sessionKey);
        if (tried.size >= accounts.length && rate) throw Object.assign(new Error("all accounts exhausted/locked"), { code: "quota" });
        continue; // failover: fresh worker, full prompt, next account
      }
      throw e;
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!needAuth(req, res)) return;
      const ids = await modelIds();
      return send(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "agy-bridge" })) });
    }
    if (req.method === "GET" && url.pathname === "/v1/stats") {
      if (!needAuth(req, res)) return;
      try {
        const lines = (await fs.readFile(STATS_PATH, "utf-8")).trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const by = {};
        for (const r of lines) {
          const k = `${r.account || "?"} / ${r.model || "?"}`;
          by[k] = by[k] || { turns: 0, in: 0, out: 0 };
          by[k].turns++; by[k].in += r.in || 0; by[k].out += r.out || 0;
        }
        return send(res, 200, { turns: lines.length, by });
      } catch { return send(res, 200, { turns: 0, by: {} }); }
    }
    if (req.method === "GET" && url.pathname === "/v1/quotas") {
      if (!needAuth(req, res)) return;
      await refreshAccounts();
      const out = [];
      for (const acc of accounts.values()) out.push({ name: acc.name, email: acc.email || null, quota: await quotaOf(acc), health: health.score(acc.name), lockedUntil: acc.lockedUntil || null });
      return send(res, 200, { accounts: out });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!needAuth(req, res)) return;
      const body = await readBody(req);
      const messages = body.messages || [];
      if (!messages.length) return send(res, 400, { error: { message: "no messages", type: "invalid", code: "no_messages" } });
      console.log(`tools_in=${(body.tools || []).length} model=${body.model} body_bytes=${req.headers['content-length'] || '?'}`);
      if ((body.tools || []).length > 300) return send(res, 400, { error: { message: "too many tools for text-protocol bridge (300 max)", type: "invalid", code: "too_many_tools" } });
      const sessionKey = body.user || "__default__";
      const stream = body.stream === true;
      const id = "chatcmpl-" + Date.now().toString(36);
      const created = Math.floor(Date.now() / 1000);
      const modelOut = body.model || cfg.defaultModel;
      if (!stream) {
        try {
          let text = "", calls = [], usage = null;
          for await (const ev of runCompletion({ messages, tools: body.tools, model: modelOut, sessionKey })) {
            if (ev.text) text += ev.text;
            else if (ev.toolcall) calls.push(ev.toolcall);
            else if (ev.usage) usage = ev.usage;
          }
          const msg = { role: "assistant", content: text || null };
          if (calls.length) {
            msg.tool_calls = calls.map((c, i) => ({ id: `call_${i}_${Date.now().toString(36)}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
            msg.content = msg.content || "";
          }
          return send(res, 200, { id, object: "chat.completion", created, model: modelOut, choices: [{ index: 0, message: msg, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: usage ? { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } : undefined });
        } catch (e) {
          const code = e.code === "quota" ? 429 : e.code === "trajectory_full" ? 400 : 502;
          return send(res, code, { error: { message: String(e.message).slice(0, 300), type: e.code || "bridge", code: e.code || "bridge" } });
        }
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const sendSSE = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      let callIdx = 0, usage = null, sawCall = false;
      const pending = new Map();
      const finish = (reason) => { sendSSE({ id, object: "chat.completion.chunk", created, model: modelOut, choices: [{ index: 0, delta: {}, finish_reason: reason }] }); res.write("data: [DONE]\n\n"); res.end(); };
      const mkId = (i) => `call_${i}_${Date.now().toString(36)}`;
      try {
        for await (const ev of runCompletion({ messages, tools: body.tools, model: modelOut, sessionKey })) {
          if (ev.text) sendSSE({ id, object: "chat.completion.chunk", created, model: modelOut, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] });
          else if (ev.toolcall_start) {
            const idx = callIdx++, cid = mkId(idx);
            pending.set(ev.toolcall_start.name + "#" + idx, { idx, cid });
            sawCall = true;
            sendSSE({ id, object: "chat.completion.chunk", created, model: modelOut, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: cid, type: "function", function: { name: ev.toolcall_start.name, arguments: "" } }] }, finish_reason: null }] });
          } else if (ev.toolcall) {
            let slot = null;
            for (const [k, v] of [...pending.entries()].reverse()) {
              if (k.startsWith(ev.toolcall.name + "#")) { slot = v; pending.delete(k); break; }
            }
            if (!slot) { slot = { idx: callIdx++, cid: mkId(callIdx) }; sawCall = true; }
            sendSSE({ id, object: "chat.completion.chunk", created, model: modelOut, choices: [{ index: 0, delta: { tool_calls: [{ index: slot.idx, id: slot.cid, type: "function", function: { name: ev.toolcall.name, arguments: JSON.stringify(ev.toolcall.args) } }] }, finish_reason: null }] });
          } else if (ev.usage) usage = ev.usage;
        }
        finish(sawCall ? "tool_calls" : "stop");
      } catch (e) {
        sendSSE({ id, object: "chat.completion.chunk", created, model: modelOut, choices: [{ index: 0, delta: {}, finish_reason: "error" }] });
        res.write(`data: ${JSON.stringify({ error: String(e.message).slice(0, 200) })}\n\n`);
        res.write("data: [DONE]\n\n"); res.end();
      }
      return;
    }
    return send(res, 404, { error: { message: "not found", type: "invalid", code: "not_found" } });
  } catch (e) {
    try { send(res, 500, { error: { message: String(e.message || e).slice(0, 200), type: "bridge", code: "bridge" } }); } catch {}
  }
});

server.listen(PORT, HOST, () => console.log(`agy-bridge on http://${HOST}:${PORT}`));
