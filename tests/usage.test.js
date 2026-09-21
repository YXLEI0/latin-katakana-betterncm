/*
 * 用量统计（core/usage.js）的单元测试。
 *
 * 这一层是**纯记账**：把两层在线接口（大模型 / 免费接口）的请求数、词数、字符数、
 * token 数记成三份账 —— 本次（会话内）/ 今天 / 累计，后两份落 localStorage。
 * 契约里最要紧的三条：
 *   1. 两层分开记，不能混；
 *   2. 跨天只清「今天」，累计不动；
 *   3. localStorage 里的脏数据不许让它崩，也不许把负数/字符串灌进账本。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./helpers");

/** 内存版 localStorage */
function fakeStorage(initial) {
  const mem = Object.assign({}, initial || {});
  return {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => {
      mem[k] = String(v);
    },
    _dump: () => mem,
  };
}

function newUsage(opts) {
  // 用 loadCore 的默认注入清单（helpers.js 会顺便建 reader，所以不能只注入 usage.js）
  const ctx = loadCore("<!doctype html><html><body></body></html>");
  const usage = ctx.window.LKUsage.createUsage(opts);
  return { usage, LKUsage: ctx.window.LKUsage, window: ctx.window };
}

test("记账：两层分开记，三份账（本次 / 今天 / 累计）同时涨", () => {
  const { usage, window } = newUsage({ storage: fakeStorage() });
  usage.add("llm", { requests: 1, ok: 1, words: 8, chars: 40, promptTokens: 220, completionTokens: 60 });
  usage.add("llm", { requests: 1, ok: 1, words: 2, chars: 9, promptTokens: 100, completionTokens: 20 });
  usage.add("google", { requests: 1, ok: 1, words: 5, chars: 31 });

  const s = usage.snapshot();
  for (const bucket of ["session", "today", "total"]) {
    assert.strictEqual(s[bucket].llm.requests, 2, bucket + " 大模型请求数");
    assert.strictEqual(s[bucket].llm.words, 10, bucket + " 词数");
    assert.strictEqual(s[bucket].llm.promptTokens, 320, bucket + " 输入 token");
    assert.strictEqual(s[bucket].llm.completionTokens, 80, bucket + " 输出 token");
    assert.strictEqual(s[bucket].llm.chars, 49, bucket + " 字符数");
    assert.strictEqual(s[bucket].google.requests, 1, bucket + " 免费接口请求数（不能混进大模型）");
    assert.strictEqual(s[bucket].google.promptTokens, 0, bucket + " 免费接口没有 token");
  }
  window.close();
});

test("记账：只认认识的字段，字符串 / 负数 / NaN 一律不记", () => {
  const { usage, window } = newUsage({ storage: fakeStorage() });
  usage.add("llm", { requests: 1, words: "8", chars: -5, promptTokens: NaN, 乱七八糟: 99 });
  const llm = usage.snapshot().session.llm;
  assert.strictEqual(llm.requests, 1);
  assert.strictEqual(llm.words, 0, "字符串不该被记账");
  assert.strictEqual(llm.chars, 0, "负数不该被记账");
  assert.strictEqual(llm.promptTokens, 0, "NaN 不该被记账");
  assert.strictEqual(llm["乱七八糟"], undefined, "不认识的字段不该进账本");
  // 不认识的 kind 也要被忽略
  usage.add("openai", { requests: 5 });
  assert.deepStrictEqual(Object.keys(usage.snapshot().session).sort(), ["google", "llm"]);
  window.close();
});

test("落盘：重启（新建实例）后「今天 / 累计」还在，「本次」归零", () => {
  const storage = fakeStorage();
  const first = newUsage({ storage });
  first.usage.add("llm", { requests: 2, ok: 2, words: 3, promptTokens: 500, completionTokens: 100 });
  first.window.close();

  const second = newUsage({ storage });
  const s = second.usage.snapshot();
  assert.strictEqual(s.total.llm.requests, 2, "累计要跨重启");
  assert.strictEqual(s.total.llm.promptTokens, 500);
  assert.strictEqual(s.today.llm.requests, 2, "同一天的话「今天」也要在");
  assert.strictEqual(s.session.llm.requests, 0, "「本次」是会话内的，重启就归零");
  second.window.close();
});

test("跨天：「今天」自动归零，累计不动", () => {
  const storage = fakeStorage();
  let when = new Date(2026, 8, 20, 23, 30); // 2026-09-20
  const a = newUsage({ storage, now: () => when });
  a.usage.add("llm", { requests: 3, ok: 3 });
  assert.strictEqual(a.usage.snapshot().today.llm.requests, 3);
  a.window.close();

  // 第二天再打开（还在同一个进程里也行 —— 账本自己会发现跨天了）
  when = new Date(2026, 8, 21, 0, 10);
  const b = newUsage({ storage, now: () => when });
  const s = b.usage.snapshot();
  assert.strictEqual(s.today.llm.requests, 0, "新的一天从 0 开始");
  assert.strictEqual(s.total.llm.requests, 3, "累计不许被清掉");
  assert.strictEqual(s.day, "2026-09-21", "账本要跟着换日期键");
  b.window.close();
});

test("跨天：同一个实例里跨天也会归零（长开着不重启的情况）", () => {
  let when = new Date(2026, 8, 20, 23, 59);
  const { usage, window } = newUsage({ storage: fakeStorage(), now: () => when });
  usage.add("llm", { requests: 2, ok: 2 });
  when = new Date(2026, 8, 21, 0, 1);
  usage.add("llm", { requests: 1, ok: 1 });
  const s = usage.snapshot();
  assert.strictEqual(s.today.llm.requests, 1, "新的一天只算新的那一笔");
  assert.strictEqual(s.total.llm.requests, 3, "累计是三笔");
  window.close();
});

test("清零：session / today / all 三种粒度", () => {
  const { usage, window } = newUsage({ storage: fakeStorage() });
  usage.add("llm", { requests: 4, ok: 4 });
  usage.reset("session");
  assert.strictEqual(usage.snapshot().session.llm.requests, 0);
  assert.strictEqual(usage.snapshot().today.llm.requests, 4, "清本次不动今天");

  usage.reset("today");
  let s = usage.snapshot();
  assert.strictEqual(s.today.llm.requests, 0);
  assert.strictEqual(s.total.llm.requests, 4, "清今天不动累计");

  usage.reset("all");
  s = usage.snapshot();
  assert.strictEqual(s.total.llm.requests, 0, "清累计");
  assert.strictEqual(s.session.llm.requests, 0);
  window.close();
});

test("脏数据：localStorage 里是坏 JSON / 负数 / 别的形状，都不许崩", () => {
  const cases = [
    "{ 这不是 json",
    JSON.stringify(null),
    JSON.stringify({ version: 1, day: "2026-09-20", today: { llm: { requests: -5, foo: 1 } }, total: "nope" }),
    JSON.stringify({ version: 1, today: { 别的层: { requests: 9 } } }),
  ];
  for (const raw of cases) {
    const storage = fakeStorage({ "western-katakana.usage": raw });
    const { usage, window } = newUsage({ storage });
    const s = usage.snapshot();
    assert.strictEqual(typeof s.total.llm.requests, "number", "坏数据也要给出可用的账本");
    usage.add("llm", { requests: 1, ok: 1 });
    assert.strictEqual(usage.snapshot().total.llm.requests >= 1, true, "坏数据之后还能继续记账");
    window.close();
  }
});

test("花费：按元/百万 token 估算，只算大模型", () => {
  const { usage, window } = newUsage({ storage: fakeStorage() });
  usage.add("llm", { requests: 1, ok: 1, promptTokens: 1e6, completionTokens: 5e5 });
  usage.add("google", { requests: 3, words: 9, chars: 40 });
  const bucket = usage.snapshot().total;
  // 输入 2 元/百万、输出 8 元/百万 -> 2 + 4 = 6 元
  assert.strictEqual(usage.cost(bucket, 2, 8), 6);
  assert.strictEqual(usage.cost(bucket, 0, 0), 0, "单价 0 = 不算钱");
  assert.strictEqual(usage.cost(bucket, 2, -1), 2, "负的单价当 0（只有输入那半算钱）");
  assert.strictEqual(usage.cost(bucket, "2", 8), 4, "字符串单价当 0（面板总会传数字，这里只是别炸）");
  window.close();
});

test("没有 localStorage（老环境）也能用，只是不落盘", () => {
  const { usage, window } = newUsage({ storage: null });
  usage.add("llm", { requests: 1, ok: 1 });
  assert.strictEqual(usage.snapshot().session.llm.requests, 1);
  assert.doesNotThrow(() => usage.flush());
  window.close();
});
