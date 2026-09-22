/*
 * 「运行期素材 → 离线词典」筛选逻辑的单元测试（tools/promote-learned.js）。
 *
 * 这一步的规矩是宁可少收：收错了就是"离线权威"，模型再没机会纠。
 * 所以下面的用例大多在测"什么情况下不收"。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { filterPromotions, MIN_LINES } = require("../tools/promote-learned.js");

const kanaOf = (res, word) => {
  const hit = res.accepted.find((a) => a.word === word);
  return hit ? hit.kana : null;
};
const whyOf = (res, word) => {
  const hit = res.skipped.find((s) => s.word === word);
  return hit ? hit.why : null;
};

test("收：已学会的词 + 缓存里一致且见过多次的命中", () => {
  const res = filterPromotions(
    {
      learned: [{ word: "serendipity", kana: "セレンディピティ" }],
      llm: [{ word: "kaleidoscope", kana: "カレイドスコープ", lines: 3, consistent: true }],
      google: [{ word: "blorf", kana: "ブローフ" }],
    },
    { hand: {}, llm: {}, blocklist: {} }
  );
  assert.strictEqual(kanaOf(res, "serendipity"), "セレンディピティ");
  assert.strictEqual(kanaOf(res, "kaleidoscope"), "カレイドスコープ");
  assert.strictEqual(kanaOf(res, "blorf"), "ブローフ");
  assert.strictEqual(res.skipped.length, 0);
});

test("不收：读音不一致 / 只见过一次 / 不是纯片假名 / 键里带非字母", () => {
  const res = filterPromotions(
    {
      llm: [
        { word: "read", kana: "リード", lines: 2, consistent: false }, // 靠语境
        { word: "once", kana: "ワンス", lines: 1, consistent: true }, // 只见过一次
        { word: "bogus", kana: "ブローフだよ", lines: 5, consistent: true }, // 不是纯片假名
        { word: "don't", kana: "ドント", lines: 5, consistent: true }, // 键里有撇号
        { word: "toolong", kana: "ア".repeat(20), lines: 5, consistent: true },
        { word: "nomiss", kana: "", lines: 5, consistent: true },
      ],
    },
    { hand: {}, llm: {}, blocklist: {} }
  );
  assert.strictEqual(res.accepted.length, 0, JSON.stringify(res.accepted));
  assert.match(whyOf(res, "read"), /不一致|靠语境/);
  assert.match(whyOf(res, "once"), new RegExp("只见过 1 次"));
  assert.match(whyOf(res, "bogus"), /不是纯片假名/);
  assert.match(whyOf(res, "don't"), /不是纯小写字母/);
  assert.match(whyOf(res, "toolong"), /太长/);
  assert.ok(MIN_LINES >= 2);
});

test("大小写混着的词按小写键收（词典键本来就是小写）", () => {
  const res = filterPromotions(
    { llm: [{ word: "MixedCase", kana: "ミックスケース", lines: 3, consistent: true }] },
    { hand: {}, llm: {}, blocklist: {} }
  );
  assert.deepStrictEqual(
    res.accepted.map((a) => a.word),
    ["mixedcase"]
  );
});

test("不收：人工词表已有的（人工优先）、黑名单里的、两可短音节", () => {
  const res = filterPromotions(
    {
      llm: [
        { word: "clover", kana: "クローバー", lines: 4, consistent: true }, // 人工词表里有
        { word: "avg", kana: "アベレージ", lines: 4, consistent: true }, // 黑名单
        { word: "me", kana: "メ", lines: 4, consistent: true }, // 两可
      ],
    },
    {
      hand: { clover: "クローバー" },
      llm: {},
      blocklist: { avg: true },
      ambiguous: (w) => w === "me",
    }
  );
  assert.strictEqual(res.accepted.length, 0);
  assert.match(whyOf(res, "clover"), /人工词表/);
  assert.match(whyOf(res, "avg"), /黑名单/);
  assert.match(whyOf(res, "me"), /两可/);
});

test("大模型词表里已有同样写法 -> 跳过；写法不同 -> 以沉淀的为准并记一笔", () => {
  const res = filterPromotions(
    {
      learned: [
        { word: "gimme", kana: "ギミー" }, // 和现有大模型词表一样
        { word: "shoo", kana: "シュー" }, // 不一样（旧的是 ショオ）
      ],
    },
    { hand: {}, llm: { gimme: "ギミー", shoo: "ショオ" }, blocklist: {} }
  );
  assert.strictEqual(kanaOf(res, "gimme"), null);
  assert.match(whyOf(res, "gimme"), /同样写法/);
  assert.strictEqual(kanaOf(res, "shoo"), "シュー");
  const updated = res.accepted.find((a) => a.word === "shoo");
  assert.strictEqual(updated.updated, "ショオ", "要记下被改掉的旧写法");
});

test("同一个词在多个来源里出现：一致就合并计数，不一致就不收", () => {
  const ok = filterPromotions(
    {
      learned: [{ word: "muze", kana: "ミューズ" }],
      llm: [{ word: "muze", kana: "ミューズ", lines: 2, consistent: true }],
    },
    { hand: {}, llm: {}, blocklist: {} }
  );
  assert.strictEqual(kanaOf(ok, "muze"), "ミューズ", "一致时合并计数照样收");

  const bad = filterPromotions(
    {
      learned: [{ word: "muze", kana: "ミューズ" }],
      llm: [{ word: "muze", kana: "ムゼ", lines: 2, consistent: true }],
    },
    { hand: {}, llm: {}, blocklist: {} }
  );
  assert.strictEqual(kanaOf(bad, "muze"), null, "两个来源不一致就不收");
  assert.match(whyOf(bad, "muze"), /不一致/);
});

test("外语自己的词一律不收：读音取决于那一行（tag / vacuum / mich 都不进词典）", () => {
  // 真机素材里就有这些：der ダー→デア、ex エックス→エクス、tag タグ→ターク、
  // vacuum バキューム→ヴァクウム、dich ディッヒ→ディヒ、immer イマー→インマー。
  // 词典是不分语言的、还排在语言引擎前面 —— 收下就在所有行上生效：
  // 英文行的 tag 会变成 ターク，德语行反而不如引擎（er- / ch / 双辅音那些规则是按德语定的）。
  // 外语行本来就有引擎和 HOMOGRAPH 兜着。
  const res = filterPromotions(
    {
      learned: [
        { word: "tag", kana: "ターク" },
        { word: "vacuum", kana: "ヴァクウム" },
        { word: "dich", kana: "ディヒ" },
        { word: "sprach", kana: "シュプレーヒ" },
      ],
      llm: [{ word: "tag", kana: "ターク", lines: 3, consistent: true }],
    },
    {
      hand: {},
      llm: { tag: "タグ", vacuum: "バキューム", dich: "ディッヒ" },
      blocklist: {},
      foreign: { tag: "德语", vacuum: "拉丁语", dich: "德语" },
    }
  );
  assert.strictEqual(res.accepted.length, 1, JSON.stringify(res.accepted));
  assert.strictEqual(kanaOf(res, "tag"), null);
  assert.match(whyOf(res, "tag"), /德语自己的词/);
  assert.strictEqual(kanaOf(res, "vacuum"), null);
  assert.match(whyOf(res, "vacuum"), /拉丁语自己的词/);
  assert.strictEqual(kanaOf(res, "dich"), null, "已有的 ディッヒ 不许被 ディヒ 盖掉");
  assert.strictEqual(kanaOf(res, "sprach"), "シュプレーヒ", "不在外语词表里的（生词）照收");
});

test("输出按词排序（生成物 diff 才稳定）", () => {
  const res = filterPromotions(
    {
      llm: [
        { word: "zebra", kana: "ゼブラ", lines: 3, consistent: true },
        { word: "alpha", kana: "アルファ", lines: 3, consistent: true },
        { word: "mango", kana: "マンゴー", lines: 3, consistent: true },
      ],
    },
    { hand: {}, llm: {}, blocklist: {} }
  );
  assert.deepStrictEqual(
    res.accepted.map((a) => a.word),
    ["alpha", "mango", "zebra"]
  );
});
