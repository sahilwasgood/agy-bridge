// agy-bridge worker layer: persistent agy workers, multi-account rotation,
// tool-text protocol, trajectory guard. Zero deps (node: + bun only).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const AGY_BIN = "/home/mint/.local/bin/agy";
export const TRAJ_DEFAULT_CAP = 239000;

// ---------- prompt rendering (opencode-adapted text protocol) ----------
const OPEN = "<tool_call>", CLOSE = "</tool_call>";
const RECENT_KEPT = 8, OLD_TRUNC = 400, RESULT_CAP = 20000;

const INTRO =
  "You are running in HEADLESS INFERENCE MODE as the language model behind an OpenAI-compatible coding harness. " +
  "Your built-in host tools are disabled in this mode. The harness executes all actions itself.";

const TOOL_PROTO =
  `To act, call one of the harness tools listed below by writing a tool call block in your reply:\n${OPEN}\n{"name": "tool_name", "arguments": {"param": "value"}}\n${CLOSE}\n\nRules:\n- Exactly one JSON object per ${OPEN} block; write several blocks in a row for parallel calls.\n- "arguments" must match the tool's parameter schema.\n- Stop right after your last tool call block. The harness runs the tools and sends the real results in the next message. Never invent results.\n- If no tool is needed, answer normally in plain text.`;

function renderContent(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(renderContent).filter(Boolean).join("\n");
  if (typeof c === "object") {
    if (typeof c.text === "string") return c.text;
    if (c.type === "image_url") return ""; // handled separately (temp files)
    if (c.content !== undefined) return renderContent(c.content);
  }
  return "";
}

function roleOf(m) {
  const r = String(m.role || "user").toLowerCase();
  if (r === "developer" || r === "system") return "system";
  if (r === "function") return "tool";
  return r;
}

// Slim a JSON schema to structure+types, dropping nested prose.
// Tool descriptions live or die by names+types; nested "description" and
// "examples" strings are the bulk of the bytes and the model copes without.
export function slimSchema(node, depth = 0) {
  if (Array.isArray(node)) return node.slice(0, 20).map((v) => slimSchema(v, depth + 1));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === "description" || k === "examples" || k === "example" || k === "default") && depth > 0) continue;
      if (k === "description" && typeof v === "string" && v.length > 300) { out[k] = v.slice(0, 300) + "…"; continue; }
      out[k] = slimSchema(v, depth + 1);
    }
    return out;
  }
  if (typeof node === "string" && node.length > 200 && depth > 2) return node.slice(0, 200) + "…";
  return node;
}

function renderTools(tools) {
  if (!tools || !tools.length) return "";
  return tools.map((t) => {
    const fn = t.function || t;
    return `- ${fn.name}: ${trunc(fn.description || "", 300)}\n  parameters: ${JSON.stringify(slimSchema(fn.parameters || {}))}`;
  }).join("\n");
}

function trunc(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `…[${s.length - n} chars cut]` : s;
}

function renderMessage(m, names, toolLimit) {
  const r = roleOf(m);
  if (r === "tool") {
    const name = names.get(m.tool_call_id) || m.name || "tool";
    return `[Tool result: ${name}]\n${trunc(renderContent(m.content), toolLimit ?? RESULT_CAP)}`;
  }
  if (r === "assistant" && m.tool_calls) {
    const calls = m.tool_calls.map((tc) => {
      const fn = tc.function || {};
      return `${OPEN}\n${JSON.stringify({ name: fn.name, arguments: fn.arguments })}\n${CLOSE}`;
    }).join("\n");
    const text = renderContent(m.content);
    return (text ? text + "\n" : "") + calls;
  }
  return renderContent(m.content);
}

export function renderFull(messages, tools) {
  const secs = [INTRO];
  const ts = renderTools(tools);
  secs.push(ts ? `${TOOL_PROTO}\n\n${ts}` : "No tools are available: answer in plain text.");
  const sys = messages.filter((m) => roleOf(m) === "system").map((m) => renderContent(m.content).trim()).filter(Boolean);
  if (sys.length) secs.push("## System instructions\n" + sys.join("\n\n"));
  const dlg = messages.filter((m) => roleOf(m) !== "system");
  const last = dlg[dlg.length - 1];
  const hist = last && roleOf(last) === "user" ? dlg.slice(0, -1) : dlg;
  const names = new Map();
  for (const m of dlg) for (const tc of m.tool_calls || []) names.set(tc.id, (tc.function || {}).name);
  const toolPos = hist.map((m, i) => (roleOf(m) === "tool" ? i : -1)).filter((i) => i >= 0);
  const recent = new Set(toolPos.slice(-RECENT_KEPT));
  const rendered = hist.map((m, i) => renderMessage(m, names, recent.has(i) ? undefined : OLD_TRUNC)).filter(Boolean);
  if (rendered.length) secs.push("## Conversation so far\n\n" + rendered.join("\n\n"));
  if (last) {
    const lr = roleOf(last);
    secs.push(lr === "user" ? `## New user message\n${renderContent(last.content)}` : `## Continue\n${renderContent(last.content)}`);
  }
  secs.push("(Headless mode: built-in tools stay disabled. Call harness tools only with " + OPEN + "..." + CLOSE + " blocks, then stop.)");
  return secs.filter((s) => s && s.trim()).join("\n\n");
}

export function digestMessages(messages) {
  return messages.map((m) => createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16));
}

// ---------- tool-call stream parser (ported behavior) ----------
export class ToolParser {
  // Streaming emits: ["text", str] | ["call_start", {name}] |
  // ["call_end", {name, args}].
  // call_start fires as soon as the block's "name" is readable, so clients
  // learn WHICH tool is coming mid-stream; full arguments land at CLOSE
  // (partial JSON is never emitted — a broken fragment is worse than late).
  constructor(knownTools = new Set()) {
    this.known = knownTools;
    this.buf = ""; this.started = false; this.bare = false;
    this.sawCalls = false; this.inBlock = false; this.block = ""; this.blockName = null;
  }
  feed(text) {
    const out = [];
    if (!text && !this.buf) return out;
    this.buf += text || "";
    if (!this.started) {
      const s = this.buf.trimStart();
      if (!s) return out;
      if (s[0] === "`" && s.length < 8 && !s.includes("\n")) return out;
      this.started = true;
      this.bare = this.known.size > 0 && /^```?json?\s*\{/.test(s);
      if (this.bare) return out;
    }
    for (;;) {
      if (!this.inBlock) {
        const bi = this.buf.indexOf(OPEN);
        if (bi < 0) {
          // hold a trailing fragment that could grow into a block opener
          let hold = 0;
          for (let k = 1; k <= OPEN.length && k <= this.buf.length; k++)
            if (this.buf.endsWith(OPEN.slice(0, k))) hold = k;
          if (this.buf.endsWith("`")) hold = Math.max(hold, 1);
          const emit = hold > 0 ? this.buf.slice(0, -hold) : this.buf;
          this.buf = hold > 0 ? this.buf.slice(-hold) : "";
          if (!this.sawCalls && emit) out.push(["text", emit]);
          return out;
        }
        if (bi > 0 && !this.sawCalls) out.push(["text", this.buf.slice(0, bi)]);
        this.buf = this.buf.slice(bi + OPEN.length);
        this.inBlock = true; this.block = ""; this.blockName = null;
      }
      const ci = this.buf.indexOf(CLOSE);
      if (ci < 0) {
        this.block += this.buf; this.buf = "";
        if (!this.blockName) {
          const m = this.block.match(/"name"\s*:\s*"([^"]+)"/);
          if (m) { this.blockName = m[1]; out.push(["call_start", { name: m[1] }]); }
        }
        return out;
      }
      this.block += this.buf.slice(0, ci);
      this.buf = this.buf.slice(ci + CLOSE.length);
      const clean = this.block.trim().replace(/^```json\n?|\n?```$/g, "");
      let obj = null;
      try { obj = JSON.parse(clean); } catch {}
      if (obj && obj.name) {
        if (!this.blockName) out.push(["call_start", { name: obj.name }]);
        this.sawCalls = true;
        out.push(["call_end", { name: obj.name, args: obj.arguments ?? {} }]);
      } else if (!this.sawCalls) {
        out.push(["text", OPEN + this.block + CLOSE]);
      } else {
        out.push(["call_end", { name: this.blockName || "unknown", args: {} }]);
      }
      this.inBlock = false; this.block = ""; this.blockName = null;
    }
  }
  finish() {
    const out = [];
    // unclosed block at stream end: parse leniently, else surface as text
    if (this.inBlock && this.block.trim()) {
      const clean = this.block.trim().replace(/^```json\n?|\n?```$/g, "");
      try {
        const obj = JSON.parse(clean);
        if (obj && obj.name) {
          if (!this.blockName) out.push(["call_start", { name: obj.name }]);
          this.sawCalls = true;
          out.push(["call_end", { name: obj.name, args: obj.arguments ?? {} }]);
        } else if (!this.sawCalls) out.push(["text", this.block]);
      } catch { if (!this.sawCalls) out.push(["text", this.block]); }
      this.inBlock = false; this.block = ""; this.blockName = null;
    }
    const s = this.buf.trim(); this.buf = "";
    if (this.bare && s) {
      try {
        const arr = JSON.parse(s.replace(/^```json\n?|\n?```$/g, ""));
        for (const o of Array.isArray(arr) ? arr : [arr])
          if (o && this.known.has(o.name)) {
            this.sawCalls = true;
            out.push(["call_start", { name: o.name }]);
            out.push(["call_end", { name: o.name, args: o.arguments ?? {} }]);
          }
      } catch { if (!this.sawCalls) out.push(["text", s]); }
    } else if (s && !this.sawCalls) out.push(["text", s]);
    return out;
  }
}

// ---------- health + quota ----------
export function familyOf(base) {
  const b = String(base || "").toLowerCase();
  if (b.includes("claude")) return "claude";
  if (b.includes("gpt")) return "gpt";
  return "gemini";
}

function bucketFamily(label) {
  const l = String(label || "").toLowerCase();
  if (l.includes("claude") || l.includes("gpt") || l.includes("3p")) return ["claude", "gpt"];
  return ["gemini"];
}

export function worstForFamily(groups, family) {
  let worst = 1, matched = false;
  for (const g of groups || []) {
    if (!bucketFamily(g.label).includes(family)) continue;
    if (typeof g.remaining === "number") { worst = Math.min(worst, g.remaining); matched = true; }
  }
  return { worst, matched };
}

export function parseRetryAfter(msg) {
  const m = String(msg || "").match(/retr\w*\s+(?:after|in)\s+(\d+)\s*s/i) || String(msg || "").match(/(\d+)\s*seconds?\s+(?:before retry|to retry)/i);
  return m ? parseInt(m[1], 10) : null;
}

export const HEALTH = { initial: 70, reward: 1, rateLimitPenalty: -10, failPenalty: -20, recoverPerHour: 2, floor: 50, cap: 100 };
export class Health {
  constructor(persistPath = null) { this.m = new Map(); this.persistPath = persistPath; }
  async load() {
    if (!this.persistPath) return;
    try {
      const d = JSON.parse(await fs.readFile(this.persistPath, "utf-8"));
      for (const [k, v] of Object.entries(d)) this.m.set(Number(k), v);
    } catch {}
  }
  save() {
    if (!this.persistPath) return;
    fs.writeFile(this.persistPath, JSON.stringify(Object.fromEntries(this.m))).catch(() => {});
  }
  score(i) {
    const s = this.m.get(i);
    if (!s) return HEALTH.initial;
    const rec = Math.floor((Date.now() - s.t) / 3600000 * HEALTH.recoverPerHour);
    return Math.min(HEALTH.cap, s.v + rec);
  }
  ok(i, good, rateLimited) {
    const v = this.score(i) + (good ? HEALTH.reward : rateLimited ? HEALTH.rateLimitPenalty : HEALTH.failPenalty);
    this.m.set(i, { v: Math.max(0, Math.min(HEALTH.cap, v)), t: Date.now() });
  }
}

function findGroups(node, depth = 0) {
  if (depth > 12 || !node) return null;
  if (typeof node === "object") {
    if (Array.isArray(node.groups) && node.groups.some((g) => g && typeof g === "object")) return node.groups;
    for (const v of Object.values(node)) { const f = findGroups(v, depth + 1); if (f) return f; }
  }
  return null;
}

export async function readQuota(agyBin, geminiDir, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const p = spawn(agyBin, [`--gemini_dir=${geminiDir}`, "-p", "/usage", "--output-format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolve({ error: "timeout" }); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => {
      clearTimeout(kill);
      try {
        let root = null;
        for (const line of out.trim().split("\n")) {
          let o = null;
          try { o = JSON.parse(line); } catch { continue; }
          if (o && typeof o === "object" && (o.response !== undefined || findGroups(o))) { root = o; break; }
        }
        const payload = root;
        const groups = payload ? findGroups(payload) : null;
        if (!groups) return resolve({ error: "unparseable", raw: out.slice(0, 200) });
        // groups carry buckets[] with snake_case remaining_fraction/reset_time
        const flat = [];
        for (const g of groups) {
          const buckets = Array.isArray(g.buckets) ? g.buckets : [g];
          for (const b of buckets) {
            const rf = b.remaining_fraction ?? b.remainingFraction;
            flat.push({
              label: `${g.name || g.label || g.modelId || "group"} / ${b.name || b.window || b.id || "window"}`,
              remaining: typeof rf === "number" ? rf : null,
              reset: b.reset_time || b.resetTime || null,
            });
          }
        }
        resolve({ groups: flat });
      } catch (e) { resolve({ error: String(e).slice(0, 120) }); }
    });
    p.on("error", (e) => { clearTimeout(kill); resolve({ error: String(e).slice(0, 120) }); });
  });
}

// ---------- images → temp files → path references ----------
export async function stageImages(messages, tmpRoot) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "agy-img-"));
  const saved = [];
  const visit = async (c) => {
    const items = Array.isArray(c) ? c : [c];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const url = it.type === "image_url" ? (it.image_url?.url ?? it.image_url) : it.url;
      if (typeof url !== "string" || !url) continue;
      let buf, ext = ".png";
      if (url.startsWith("data:image/")) {
        const m = url.match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
        if (!m) continue;
        ext = m[1] === "image/jpeg" ? ".jpg" : m[1] === "image/webp" ? ".webp" : ".png";
        buf = Buffer.from(m[2], "base64");
      } else if (/^https?:\/\//.test(url)) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`image fetch ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
      } else continue;
      if (buf.length > 12 * 1024 * 1024) throw new Error("image over 12MB cap");
      const fp = path.join(dir, `${randomUUID()}${ext}`);
      await fs.writeFile(fp, buf);
      saved.push(fp);
    }
  };
  for (const m of messages) await visit(m.content);
  return { dir, saved };
}

export function imagePromptAddition(saved) {
  if (!saved.length) return "";
  return `The user attached ${saved.length} image(s) saved at these local path(s):\n${saved.join("\n")}\n\nOpen and examine each image, then answer the user's question about them.`;
}

export async function cleanupDir(dir) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
}

// ---------- multi-account credential swap (keyring-global platforms) ----------
// On desktop Linux agy's login lives in the system keyring (service "gemini",
// user "antigravity") — global, so --gemini_dir does NOT isolate accounts.
// Pattern (per antigravity-swap): snapshot each login to a slot file once,
// then swap a slot's blob into the live store only for the seconds a spawn
// or quota check needs it, restoring the previous login in a finally block.
// Long-lived workers hold their token in memory, so they survive the swap.
import { spawnSync } from "node:child_process";

const KEYRING_PY = `
import secretstorage, json, sys
bus = secretstorage.dbus_init()
col = secretstorage.get_default_collection(bus)
if col.is_locked():
    col.unlock()
`;
const LOCKDIR = join(homedir(), "agy-bridge", ".swap.lock");
const SLOTS_DIR = join(homedir(), "agy-bridge", "accounts");

function pyReadLogin() {
  const r = spawnSync("python3", ["-c",
    KEYRING_PY + `
for item in col.get_all_items():
    if item.get_attributes().get('service') == 'gemini' and item.get_attributes().get('username') == 'antigravity':
        sys.stdout.write(item.get_secret().decode())
        break
`], { encoding: "utf-8" });
  const s = (r.stdout || "").trim();
  if (!s) throw new Error("no live agy login in keyring");
  return s;
}

async function writeTmpBlob(blob) {
  const p = join(tmpdir(), `agy-blob-${process.pid}.json`);
  await fs.writeFile(p, blob);
  return p;
}

async function pyWriteLogin(blob) {
  JSON.parse(blob); // validate before touching the live store
  const tmp = await writeTmpBlob(blob);
  try {
    const r = spawnSync("python3", ["-c",
      KEYRING_PY + `
import os
blob = open(os.environ["AGY_BLOB_FILE"], encoding="utf-8").read()
found = False
for item in col.get_all_items():
    if item.get_attributes().get('service') == 'gemini' and item.get_attributes().get('username') == 'antigravity':
        item.set_secret(blob.encode())
        found = True
        break
if not found:
    col.create_item("Password for 'antigravity' on 'gemini'", {"service": "gemini", "username": "antigravity"}, blob.encode(), replace=True)
`], { encoding: "utf-8", env: { ...process.env, AGY_BLOB_FILE: tmp } });
    if (r.status !== 0) throw new Error("keyring write failed: " + (r.stderr || "").slice(0, 160));
  } finally {
    try { await fs.unlink(tmp); } catch {}
  }
}

export function snapshotLogin(name) {
  const blob = pyReadLogin();
  const d = JSON.parse(blob);
  let email = null;
  try {
    const p = String(d.id_token || "").split(".")[1] || "";
    email = JSON.parse(Buffer.from(p + "=".repeat((-p.length % 4 + 4) % 4), "base64")).email || null;
  } catch {}
  return { name, email, blob };
}

// Write a login blob live WITHOUT auto-revert (for interactive use).
export async function activateLogin(blob) {
  await pyWriteLogin(blob);
}

async function lockHolderAlive() {
  try {
    const pid = parseInt((await fs.readFile(join(LOCKDIR, "pid"), "utf-8")).trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function withLock(fn, maxWaitMs = 120000) {
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(LOCKDIR);
      await fs.writeFile(join(LOCKDIR, "pid"), String(process.pid)).catch(() => {});
      break;
    } catch {
      // stale lock from a killed process: holder dead -> break it
      if (!(await lockHolderAlive())) {
        try { await fs.rm(join(LOCKDIR), { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() - start > maxWaitMs)
        throw Object.assign(new Error("swap lock held too long; another turn may be swapping credentials"), { code: "lock_timeout" });
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try { return await fn(); }
  finally { try { await fs.rm(join(LOCKDIR), { recursive: true, force: true }); } catch {} }
}

// Delete the live login (keyring entry + token file) so `agy` prompts fresh OAuth.
export async function clearLiveLogin() {
  const r = spawnSync("python3", ["-c",
    KEYRING_PY + `
n = 0
for item in list(col.get_all_items()):
    if item.get_attributes().get('service') == 'gemini' and item.get_attributes().get('username') == 'antigravity':
        try:
            item.delete()
        except Exception:
            col.delete(item)
        n += 1
print(n)
`], { encoding: "utf-8" });
  const keyringCleared = (r.stdout || "").trim();
  if (r.status !== 0) throw new Error("keyring clear failed: " + (r.stderr || "").slice(0, 160));
  try { await fs.unlink(join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token")); } catch {}
  return { keyringCleared };
}

// Read quota for a slot's login WITHOUT disturbing the live login.
export async function verifySlot(agyBin, slotDir) {
  const blob = await fs.readFile(join(slotDir, "login.json"), "utf-8");
  JSON.parse(blob);
  return withSwappedLogin(blob, () => readQuota(agyBin, slotDir));
}
export async function withSwappedLogin(blob, fn) {
  return withLock(async () => {
    const before = pyReadLogin();
    await pyWriteLogin(blob);
    try { return await fn(); }
    finally {
      try { await pyWriteLogin(before); } catch (e) { console.error("swap restore FAILED:", e.message);
        console.error("restore manually: log back in with agy"); }
    }
  });
}
let WID = 0;

// Spawn a worker whose login is swapped in only until its init event proves
// it authenticated, then restore. The worker holds its token in memory after.
export async function spawnWorkerFor({ agyBin, slotDir, model, effort, conversationId, silenceMs, absoluteMs }) {
  const blob = await fs.readFile(join(slotDir, "login.json"), "utf-8");
  JSON.parse(blob);
  return withSwappedLogin(blob, async () => {
    const w = new Worker({ agyBin, geminiDir: slotDir, model, effort, conversationId, silenceMs, absoluteMs });
    w.loginBlob = blob;
    w.spawn();
    const start = Date.now();
    for (;;) {
      const batch = w.lines.splice(0);
      for (const line of batch) {
        w.lines.push(line); // keep for runTurn consumers
        let e = null;
        try { e = JSON.parse(line); } catch { continue; }
        if (e && e.event === "init") {
          if (e.conversation_id) w.conversationId = e.conversation_id;
          return w;
        }
        if (e && e.event === "result" && String(((e.result || {}).status) || "").toUpperCase() !== "SUCCESS")
          throw new Error("worker failed at spawn: " + String((e.result || {}).error || "").slice(0, 160));
      }
      if (w.dead) throw Object.assign(new Error("worker died during spawn"), { code: "worker_dead" });
      if (Date.now() - start > 90000) { w.kill(); throw Object.assign(new Error("worker init timeout"), { code: "worker_dead" }); }
      await new Promise((r) => setTimeout(r, 200));
    }
  });
}
export class Worker {
  constructor({ agyBin, geminiDir, model, effort, conversationId, silenceMs, absoluteMs, skipPermissions }) {
    this.id = ++WID;
    this.agyBin = agyBin; this.geminiDir = geminiDir;
    this.model = model; this.effort = effort;
    this.conversationId = conversationId || null;
    this.silenceMs = silenceMs; this.absoluteMs = absoluteMs;
    this.skipPermissions = !!skipPermissions;
    this.digests = [];
    this.trajTokens = 0;
    this.lastUse = Date.now();
    this.dead = false;
    this.effortCap = { ok: true };
    this.proc = null; this.reader = null; this.buf = "";
  }
  args() {
    const a = [`--gemini_dir=${this.geminiDir}`, "--input-format", "stream-json", "--output-format", "stream-json",
      "--disable-slash-commands", "--model", this.model];
    if (this.effort && this.effortCap.ok) a.push("--effort", this.effort);
    if (this.conversationId) a.push("--conversation", this.conversationId);
    if (this.skipPermissions) a.push("--dangerously-skip-permissions");
    return a;
  }
  spawn() {
    this.proc = spawn(this.agyBin, this.args(), { stdio: ["pipe", "pipe", "pipe"] });
    console.log(`worker#${this.id} spawned pid=${this.proc.pid} model=${this.model} acct=${this.loginBlob ? "slot" : "live"}`);
    this.proc.on("exit", (code, sig) => { this.dead = true; console.log(`worker#${this.id} exit code=${code} sig=${sig}`); });
    this.lines = [];
    let acc = "";
    this.proc.stdout.on("data", (d) => {
      acc += d.toString();
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const line = acc.slice(0, i).trim(); acc = acc.slice(i + 1);
        if (line) this.lines.push(line);
      }
    });
    this.proc.stderr.on("data", () => {});
  }
  writeTurn(text) {
    this.proc.stdin.write(JSON.stringify({ event: "user", message: { content: text } }) + "\n");
  }
  ensureSpawned() {
    // (re)spawn under this worker's own login when known; otherwise as-is
    const spawnNow = () => { this.spawn(); };
    if (!this.proc || this.dead) {
      if (this.loginBlob) return withSwappedLogin(this.loginBlob, async () => {
        spawnNow();
        const start = Date.now();
        for (;;) {
          const batch = this.lines.splice(0);
          let inited = false;
          for (const line of batch) {
            this.lines.push(line);
            try { if (JSON.parse(line).event === "init") inited = true; } catch {}
          }
          if (inited) return;
          if (this.dead) throw Object.assign(new Error("worker died during spawn"), { code: "worker_dead" });
          if (Date.now() - start > 90000) { this.kill(); throw Object.assign(new Error("worker init timeout"), { code: "worker_dead" }); }
          await new Promise((r) => setTimeout(r, 200));
        }
      });
      spawnNow();
    }
    return Promise.resolve();
  }
  async *runTurn(promptText, { toolsChanged = false } = {}) {
    await this.ensureSpawned();
    this.lastUse = Date.now();
    this.writeTurn(promptText);
    const start = Date.now();
    let seen = this.lines.length;
    let result = null, silentSince = Date.now();
    for (;;) {
      if (Date.now() - start > this.absoluteMs) throw Object.assign(new Error("turn exceeded absolute timeout"), { code: "timeout" });
      if (Date.now() - silentSince > this.silenceMs) throw Object.assign(new Error("agy silent too long"), { code: "timeout" });
      if (this.dead && this.lines.length <= seen) throw Object.assign(new Error("worker died"), { code: "worker_dead" });
      while (this.lines.length > seen) {
        const line = this.lines[seen++];
        silentSince = Date.now();
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.event === "init") { if (e.conversation_id) this.conversationId = e.conversation_id; continue; }
        if (e.event === "result") { result = e.result || e; break; }
        yield { type: "event", raw: e };
      }
      if (result) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    if (!result) throw Object.assign(new Error("no result from worker"), { code: "worker_dead" });
    const st = String(result.status || "").toUpperCase();
    if (st && st !== "SUCCESS") {
      const msg = String(result.error || result.response || "turn failed");
      const err = new Error(msg.slice(0, 400));
      err.code = /quota|rate.?limit|429|exhaust|limit/i.test(msg) ? "quota" : /auth|login|sign.?in/i.test(msg) ? "auth" : "turn_failed";
      throw err;
    }
    const u = result.usage || {};
    console.log(`turn done in=${u.input_tokens || 0} out=${u.output_tokens || 0}+${u.thinking_tokens || 0} status=${result.status}`);
    // agy reports delta-only usage on reused workers, so add the rendered
    // prompt size too: overcounting fails safe (early /compact nudge),
    // undercounting would let agy silently truncate history.
    this.trajTokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.thinking_tokens || 0) + Math.ceil(promptText.length / 4);
    return result;
  }
  kill() { try { this.proc?.kill("SIGKILL"); } catch {} this.dead = true; }
}

// ---------- model mapping ----------
export const EFFORTS = { "gemini-3.8-flash": ["low", "medium", "high"], "gemini-3.7-flash": ["low", "medium", "high"], "gemini-3.1-pro": ["low", "high"], "claude-opus-4-6-thinking": [], "claude-sonnet-4-6": [], "gpt-oss-120b": ["medium"] };
export const ALIASES = { flash: "gemini-3.8-flash", pro: "gemini-3.1-pro", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-6-thinking", gpt: "gpt-oss-120b", default: "gemini-3.8-flash" };
export function mapModel(id, def) {
  let raw = String(id || def || "");
  let effort = null;
  const m = raw.match(/^(.*)-(low|medium|high|xhigh|max)$/);
  let base = raw;
  if (m && (EFFORTS[ALIASES[m[1]] || m[1]] || []).length) { base = ALIASES[m[1]] || m[1]; effort = m[2]; }
  base = ALIASES[base] || base;
  return { base, effort };
}
