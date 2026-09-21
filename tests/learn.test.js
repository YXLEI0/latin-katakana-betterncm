/*
 * 「学会的词」（core/learn.js）的单元测试。
 *
 * 这一层的价值是**省钱**：模型答过的词沉淀成离线词条，下次不再问。
 * 但它也很危险 —— 收错了就等于把错读音钉成"离线权威"，模型再没机会纠。
 * 所以下面的用例基本都在测"**什么情况下不收**"。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./helpers");

function newStore(opts) {
  const ctx = loadCore();
  return ctx.WKLearn.createLearned(opts || {});
}

/** 最小可用的 localStorage 桩 */
function fakeStorage(seed) {
  const map = seed ? Object.assign({}, seed) : {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => {
      map[k] = String(v);
    },
    removeItem: (k) => {
      delete map[k];
    },
    _map: map,
  };
}

test("答一次不收：要在两个不同的句子里答出同一个读音才沉淀", () => {
  const s = newStore();
  assert.strictEqual(s.note("serendipity", "セレンディピティ", "line one", "セレンディピティー"), "pending");
  assert.strictEqual(s.stats().count, 0, "只答过一次不收");
  assert.strictEqual(s.stats().pending, 1);
  assert.strictEqual(s.get("serendipity"), null);

  // 同一句里又答一次（重扫）—— 不算第二句，不重复计数
  assert.strictEqual(s.note("serendipity", "セレンディピティ", "line one", "セレンディピティー"), "pending");
  assert.strictEqual(s.stats().count, 0);

  // 换了句子、读音一致 -> 收下
  assert.strictEqual(s.note("serendipity", "セレンディピティ", "line two", "セレンディピティー"), "learned");
  assert.strictEqual(s.get("serendipity"), "セレンディピティ");
  assert.strictEqual(s.stats().count, 1);
  assert.strictEqual(s.stats().pending, 0);
});

test("本地层本来就对的不收（学了也没用）", () => {
  const s = newStore();
  assert.strictEqual(s.note("clover", "クローバー", "a", "クローバー"), "skip");
  assert.strictEqual(s.note("clover", "クローバー", "b", "クローバー"), "skip");
  assert.strictEqual(s.stats().count, 0);
  assert.strictEqual(s.get("clover"), null);
});

test("两句给了不同读音就不收：那说明这个词靠语境（read リード/レッド）", () => {
  const s = newStore();
  assert.strictEqual(s.note("read", "リード", "I read books", "レッド"), "pending");
  assert.strictEqual(s.note("read", "レッド", "I read it yesterday", "リード"), "pending");
  assert.strictEqual(s.stats().count, 0, "两次不一样 -> 不能沉淀");
  // 之后同样读音再来一次，也只是重新累计
  assert.strictEqual(s.note("read", "リード", "read me a story", "レッド"), "pending");
  assert.strictEqual(s.stats().count, 0);
});

test("模型改口：已收的词给出别的读音 -> 立刻撤销", () => {
  const s = newStore();
  s.note("muse", "ミューズ", "line one", "ムセ");
  s.note("muse", "ミューズ", "line two", "ムセ");
  assert.strictEqual(s.get("muse"), "ミューズ");
  assert.strictEqual(s.note("muse", "ミュース", "line three", "ムセ"), "drop");
  assert.strictEqual(s.get("muse"), null, "撤掉之后回到「每次都要问模型」的状态");
  assert.strictEqual(s.stats().count, 0);
});

test("读音必须是纯片假名、不能太长，词会被规范化（大小写 / 撇号）", () => {
  const s = newStore();
  assert.strictEqual(s.note("x", "完全不是片假名", "a", "エックス"), "skip");
  assert.strictEqual(s.note("x", "", "a", "エックス"), "skip");
  assert.strictEqual(s.note("x", "ア".repeat(20), "a", "エックス"), "skip");
  // 规范化：Do / D'oh 这类写法都归到同一个键
  s.note("MUSE", "ミューズ", "one", "ムセ");
  s.note("muse", "ミューズ", "two", "ムセ");
  assert.strictEqual(s.get("MUSE"), "ミューズ");
  assert.strictEqual(s.stats().count, 1, "大小写不同是同一个词");
});

test("落盘 + 重启后还在：换个实例读同一份 localStorage 也能拿到", () => {
  const storage = fakeStorage();
  const a = newStore({ storage: storage, delayMs: 0 });
  a.note("muze", "ミューズ", "one", "ムセ");
  a.note("muze", "ミューズ", "two", "ムセ");
  a.flush();
  assert.ok(storage._map["western-katakana.learned.v1"], "要落盘：" + JSON.stringify(storage._map));

  const b = newStore({ storage: storage });
  assert.strictEqual(b.get("muze"), "ミューズ", "重启后直接能用，不用再问模型");
  assert.strictEqual(b.stats().count, 1);
});

test("localStorage 里的脏数据一律忽略，不能把插件搞崩", () => {
  const KEY = "western-katakana.learned.v1";
  for (const raw of ["不是 JSON", "null", "[]", '{"words":"x"}', '{"words":{"a":{"k":"漢字"}}}', '{"words":{"b":{"k":"ア"}}}']) {
    const storage = fakeStorage({ [KEY]: raw });
    const s = newStore({ storage: storage });
    assert.doesNotThrow(() => s.get("a"));
    assert.strictEqual(s.get("a"), null, "脏数据不能被当成词条：" + raw);
  }
  // 唯一合法的那条要留下
  const ok = newStore({ storage: fakeStorage({ [KEY]: '{"words":{"b":{"k":"ア"}}}' }) });
  assert.strictEqual(ok.get("b"), "ア");
});

test("上限：超了就丢最久没用过的", async () => {
  const s = newStore({ maxWords: 2 });
  s.note("a", "ア", "one", "エー");
  s.note("a", "ア", "two", "エー");
  s.note("b", "ビ", "one", "ビー");
  s.note("b", "ビ", "two", "ビー");
  assert.strictEqual(s.stats().count, 2);
  // 让 a 变成"最近用过"（get 会刷新时间戳），再收第三个词
  await new Promise((r) => setTimeout(r, 5));
  s.get("a");
  s.note("c", "シ", "one", "シー");
  s.note("c", "シ", "two", "シー");
  assert.strictEqual(s.stats().count, 2);
  assert.strictEqual(s.get("a"), "ア", "最近用过的 a 要留下");
  assert.strictEqual(s.get("c"), "シ");
  assert.strictEqual(s.get("b"), null, "最久没用过的 b 被丢掉");
});

test("forget / clear / 本次用上了几个", () => {
  const s = newStore();
  s.note("muse", "ミューズ", "one", "ムセ");
  s.note("muse", "ミューズ", "two", "ムセ");
  assert.strictEqual(s.forget("MUSE"), true, "forget 也要认规范化后的键");
  assert.strictEqual(s.get("muse"), null);
  assert.strictEqual(s.forget("muse"), false, "没有的词返回 false");

  s.note("muse", "ミューズ", "one", "ムセ");
  s.note("muse", "ミューズ", "two", "ムセ");
  assert.strictEqual(s.get("muse"), "ミューズ");
  assert.strictEqual(s.stats().usedSession, 1, "用上过就记一笔（面板上就是「省下的请求」）");
  assert.strictEqual(s.peek("muse"), "ミューズ");
  assert.strictEqual(s.stats().usedSession, 1, "peek 是排障用的，不该记");

  assert.strictEqual(s.clear(), 1);
  assert.strictEqual(s.stats().count, 0);
  assert.strictEqual(s.get("muse"), null);
});
