/*
 * 生成词典的数据纪律（core/dict.js）。
 *
 * 词典是**生成物**（tools/build-dict.js 合并 tools/seed-words.js 与
 * tools/seed-words-llm.js），几千条数据靠人眼看是不可能的，所以用测试把几条
 * 硬纪律钉死：
 *   1. 键必须是小写英文、值必须是纯片假名 —— 一旦混进汉字，错的读音会直接
 *      标到歌词上（"love -> 愛" 这种）；
 *   2. 规则层对**词典里每一个词**都必须吐得出纯片假名。这条不是形式主义：
 *      规则层里一旦留下 "##R##" / "@@" 这种占位符没清掉，只有走规则路径的词
 *      才会露馅，而现在的词典命中率很高，漏到线上就很难发现；
 *   3. 生成词表（tools/seed-words-llm.js）和词典必须同步 —— 忘了重新生成
 *      dict.js 时，这里要报出来；
 *   4. 常见歌词词必须在词典里（否则就会掉进规则层，读成 ヘッラオ 那种）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { loadCore } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const RE_EN = /^[a-z]+$/;
// 平假名、汉字、拉丁字母、@ # 这类占位符都算"不是片假名"
const RE_KANA = /^[\u30A0-\u30FF\u30FC]+$/;

const ctx = loadCore("<!doctype html><html><body></body></html>", { reader: false });
const DICT = ctx.WKDict ? ctx.WKDict.words : {};
const KEYS = Object.keys(DICT);

test("词典非空，而且规模够大（生成物被截断/写坏时要报出来）", () => {
  assert.ok(KEYS.length >= 4000, "词典只有 " + KEYS.length + " 条，像是生成坏了");
  assert.strictEqual(ctx.WKDict.count, KEYS.length, "count 字段和实际条数对不上");
});

test("词典的键都是小写英文、值都是纯片假名", () => {
  const bad = [];
  for (const k of KEYS) {
    if (!RE_EN.test(k)) bad.push("键 " + JSON.stringify(k));
    else if (!RE_KANA.test(DICT[k])) bad.push(k + " -> " + JSON.stringify(DICT[k]));
    if (bad.length > 10) break;
  }
  assert.deepStrictEqual(bad, [], "词典里有脏数据");
});

test("规则层对词典里每个词都吐得出纯片假名（占位符/异常字符的兜底检查）", () => {
  const bad = [];
  for (const k of KEYS) {
    const r = ctx.WKReading.englishToKatakana(k);
    if (!r || typeof r.kana !== "string" || !r.kana) bad.push(k + " -> 空");
    else if (!RE_KANA.test(r.kana)) bad.push(k + " -> " + JSON.stringify(r.kana));
    if (bad.length > 30) break;
  }
  assert.deepStrictEqual(bad, [], "规则层吐出了非片假名（多半是占位符没清干净）");
});

test("生成词表和词典同步：忘了跑 build:dict 会在这里露馅", () => {
  const seedLlm = path.join(ROOT, "tools", "seed-words-llm.js");
  assert.ok(fs.existsSync(seedLlm), "生成词表不存在");
  const mod = require(seedLlm);
  const words = (mod && mod.words) || {};
  // 黑名单里的词是**故意**不进词典的（大模型把缩写展开成了整词，见 tools/dict-blocklist.js）
  const blocked = require(path.join(ROOT, "tools", "dict-blocklist.js"));
  const missing = Object.keys(words).filter((w) => DICT[w] === undefined && blocked[w] === undefined);
  assert.deepStrictEqual(
    missing.slice(0, 10),
    [],
    "有 " + missing.length + " 条生成词没进词典，跑一次 npm run build:dict"
  );
});

test("常见歌词词都能「确定地」读出纯片假名（不许掉进猜的规则里）", () => {
  // 词典 / 罗马音 / reading.js 里人工核过的例外表与外来语小表都算"确定"，
  // 只有拼写规则那一层是猜的（confident:false 或者结果明显是拼出来的）。
  const reader = ctx.WKReading.createReader({ dict: DICT });
  const must = [
    // 英文外来语
    "hello", "question", "shining", "dancing", "forever", "tomorrow", "believe",
    "treasure", "rainbow", "moonlight", "destiny", "chocolate", "sandwich",
    "memory", "silence", "distance", "sunshine", "season", "reason", "balance",
    "crystal", "diamond", "journey", "shadow", "simple", "table", "little", "cake",
    "river", "finger", "teacher",
    // 虚词：歌词里也会出现，注音要按唱出来的音
    "the", "of", "and", "you", "me", "we", "my", "your", "love", "kiss",
    // 单字母词：a / I 是真正的英文单词，必须有确定读音
    "a", "i",
    // 常见缩写（用户报的 Mr. / Dr.）：日语里念整个词，不是字母名
    "mr", "mrs", "ms", "dr", "prof", "jr", "sr",
    // Ave（拉丁语的"万福"）：不能被当成 avenue 的缩写展开
    "ave",
    // Georgette：专有名词，规则拼不出来（用户报的 ゲオーゲターテ）
    "georgette",
  ];
  const bad = [];
  for (const w of must) {
    const r = reader.read(w);
    if (!r || !r.kana || !RE_KANA.test(r.kana)) bad.push(w + " -> " + JSON.stringify(r && r.kana));
    else if (r.confident !== true) bad.push(w + " -> " + r.kana + "（没把握，来源 " + r.source + "）");
  }
  assert.deepStrictEqual(bad, [], "这些常见词没被确定地读出来");
});
