// agy-bridge unit tests: pure functions only, zero quota. run: bun test.js
import { strict as assert } from "node:assert";
import { ToolParser, Health, HEALTH, digestMessages, mapModel, renderFull, familyOf, worstForFamily, parseRetryAfter, slimSchema } from "./worker.js";
const renderToolsForTest = (params) => `- t: ${JSON.stringify(slimSchema(params))}`;

let pass = 0;
const t = (n, f) => { try { f(); pass++; console.log("PASS", n); } catch (e) { console.log("FAIL", n, "-", e.message); process.exitCode = 1; } };

// 1. tool-call block parsing
t("tool block", () => {
  const p = new ToolParser(new Set(["read_file"]));
  const out = p.feed('Let me check.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "/x"}}\n</tool_call>\n');
  assert.equal(out[0][0], "text");
  assert.equal(out[1][0], "call_start");
  assert.equal(out[2][0], "call_end");
  assert.equal(out[1][1].name, "read_file");
  assert.deepEqual(out[2][1].args, { path: "/x" });
});
// 2. text before partial block is held, not leaked
t("partial hold", () => {
  const p = new ToolParser(new Set(["a"]));
  assert.deepEqual(p.feed("hello <tool_ca"), [["text", "hello "]]);
  const out = p.feed('ll>\n{"name":"a","arguments":{}}\n</tool_call>');
  assert.ok(out.some(([k]) => k === "call_end"));
});
// 3. text after calls is dropped
t("post-call drop", () => {
  const p = new ToolParser();
  p.feed('<tool_call>\n{"name":"x","arguments":{}}\n</tool_call>\ntrailing junk');
  assert.deepEqual(p.finish(), []);
});
// 4. digests detect delta position
t("digests", () => {
  const a = [{ role: "user", content: "hi" }];
  const b = [...a, { role: "assistant", content: "yo" }, { role: "user", content: "go" }];
  const da = digestMessages(a), db = digestMessages(b);
  let i = 0;
  while (i < da.length && da[i] === db[i]) i++;
  assert.equal(i, 1);
});
// 5. health scoring
t("health", () => {
  const h = new Health();
  assert.equal(h.score(0), 70);
  h.ok(0, false, true);
  assert.equal(h.score(0), 60);
  h.ok(0, false, false);
  assert.equal(h.score(0), 40);
  assert.ok(h.score(0) < HEALTH.floor);
});
// 6. model mapping
t("models", () => {
  assert.deepEqual(mapModel("flash-high", "x"), { base: "gemini-3.8-flash", effort: "high" });
  assert.deepEqual(mapModel("sonnet", "x"), { base: "claude-sonnet-4-6", effort: null });
  assert.deepEqual(mapModel("muse-spark-1.3-contributor-free", "d"), { base: "muse-spark-1.3-contributor-free", effort: null });
});
// 7. full render separates fresh/cache + truncates old tool output
t("render", () => {
  const big = "y".repeat(5000);
  const msgs = [{ role: "user", content: "do it" }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: "assistant", content: "w" + i });
    msgs.push({ role: "tool", tool_call_id: String(i), name: "run", content: i === 0 ? big : "small" });
  }
  msgs.push({ role: "user", content: "next" });
  const out = renderFull(msgs, [{ function: { name: "run", description: "r", parameters: {} } }]);
  assert.ok(out.includes("HEADLESS INFERENCE MODE"));
  assert.ok(out.includes("chars cut"), "old tool output truncated");
  assert.ok(out.includes("## New user message"));
});
// 8. image parts don't leak base64 into text
t("image strip", () => {
  const out = renderFull([{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }], null);
  assert.ok(!out.includes("AAA"));
  assert.ok(out.includes("what is this"));
});
console.log(`${pass} passed`);
// 9. family quota routing prefers the account richest in the requested family
t("family routing", () => {
  const groups = [
    { label: "Gemini Models / Weekly", remaining: 0.1, reset: null },
    { label: "Claude and GPT models / Weekly", remaining: 0.9, reset: null },
  ];
  const c = worstForFamily(groups, "claude");
  assert.ok(c.matched && Math.abs(c.worst - 0.9) < 1e-9);
  const g = worstForFamily(groups, "gemini");
  assert.ok(g.matched && Math.abs(g.worst - 0.1) < 1e-9);
  assert.equal(familyOf("claude-sonnet-4-6"), "claude");
  assert.equal(familyOf("gpt-oss-120b"), "gpt");
  assert.equal(familyOf("gemini-3.8-flash"), "gemini");
});
// 10. retry-after parsing for short-limit retries
t("retry parse", () => {
  assert.equal(parseRetryAfter("rate limited, retry after 4s"), 4);
  assert.equal(parseRetryAfter("slow down"), null);
});
// 10b. full-length partial tag at chunk end must be held, not leaked
t("hold full prefix", () => {
  const p = new ToolParser(new Set(["a"]));
  assert.deepEqual(p.feed("xx <tool"), [["text", "xx "]]);
  const out = p.feed('_call>\n{"name":"a","arguments":{}}\n</tool_call>');
  assert.ok(out.some(([k]) => k === "call_end"), JSON.stringify(out));
});
// 11. schema slimming keeps structure, drops nested prose
t("slim", () => {
  const fat = { type: "object", description: "does things", properties: { q: { type: "string", description: "x".repeat(500), examples: ["a", "b"], default: "d" }, n: { type: "number" } }, required: ["q"], additionalProperties: false };
  const slim = JSON.parse(JSON.stringify(fat).replace(/"description":"x{500}"/, '"description":"y"'));
  void slim;
  const out = renderToolsForTest(fat);
  assert.ok(out.includes('"required":["q"]'));
  assert.ok(out.includes('"type":"number"'));
  assert.ok(!out.includes("x".repeat(100)));
  assert.ok(JSON.stringify(fat).length > out.length * 2);
});
