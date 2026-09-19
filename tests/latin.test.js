/*
 * 拉丁词扫描器（core/latin.js）的单元测试。
 *
 * 这个模块只干一件事：在一片文本里找出"值得标读音"的拉丁词，并给出位置。
 * 位置必须准 —— 注入时靠它把原文本切成 前段/词/后段，错一个字符底字就错了。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const latin = require("../src/core/latin.js");

test("hasLatin：只认拉丁字母", () => {
  assert.strictEqual(latin.hasLatin("clover"), true);
  assert.strictEqual(latin.hasLatin("コーヒー"), false);
  assert.strictEqual(latin.hasLatin("きらめく light"), true);
  assert.strictEqual(latin.hasLatin(""), false);
  assert.strictEqual(latin.hasLatin(null), false);
});

test("scan：切出每个词和它的位置", () => {
  const src = "きらめく light と clover。";
  const toks = latin.scan(src);
  assert.strictEqual(toks.length, 2);
  // 位置必须能用来切原文：切出来的正好是那个词
  assert.strictEqual(src.slice(toks[0].start, toks[0].end), "light");
  assert.strictEqual(src.slice(toks[1].start, toks[1].end), "clover");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["light", "clover"]
  );
  // 顺手核一次下标本身（数错了注入时底字就会错位）
  assert.strictEqual(toks[0].start, src.indexOf("light"));
  assert.strictEqual(toks[1].start, src.indexOf("clover"));
});

test("scan：撇号和连字符要留在词里（don't / e-mail）", () => {
  const toks = latin.scan("don't send e-mail");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["don't", "send", "e-mail"]
  );
  // 全角撇号也认（歌词里两种都有）
  assert.deepStrictEqual(
    latin.scan("don\u2019t").map((t) => t.text),
    ["don\u2019t"]
  );
});

test("scan：词内部的 norm 去掉撇号连字符并小写", () => {
  const toks = latin.scan("Don't E-Mail");
  assert.deepStrictEqual(
    toks.map((t) => t.norm),
    ["dont", "email"]
  );
});

test("scan：连字符在词尾时不算进词里（light- 应切成 light）", () => {
  const toks = latin.scan("light-");
  assert.strictEqual(toks.length, 1);
  assert.strictEqual(toks[0].text, "light");
});

test("scan：没有拉丁字母时返回空数组", () => {
  assert.deepStrictEqual(latin.scan("きらめく"), []);
  assert.deepStrictEqual(latin.scan(""), []);
  assert.deepStrictEqual(latin.scan(null), []);
});

test("scan：连续多个词、以及换行分隔", () => {
  const toks = latin.scan("light\nclover dream");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["light", "clover", "dream"]
  );
});

test("scan：不会因为零宽匹配卡死（正则改坏时的保护）", () => {
  // 只要能在合理时间内返回就算过；这里主要是防止以后改正则引入死循环
  const toks = latin.scan("a".repeat(2000));
  assert.ok(toks.length >= 1);
});

test("looksReadable：单字母不标，两字母以上才标", () => {
  const [single, two, three] = latin.scan("a to sky");
  assert.strictEqual(latin.looksReadable(single), false, "「a」这种单字母是噪音");
  assert.strictEqual(latin.looksReadable(two), true);
  assert.strictEqual(latin.looksReadable(three), true);
});

test("hasReadable：整段里有没有值得标的词", () => {
  assert.strictEqual(latin.hasReadable("きらめく light"), true);
  assert.strictEqual(latin.hasReadable("a i u"), false, "只有单字母就不值得处理");
  assert.strictEqual(latin.hasReadable("きらめく"), false);
});

test("normalize：小写化并去掉撇号连字符", () => {
  assert.strictEqual(latin.normalize("Clover"), "clover");
  assert.strictEqual(latin.normalize("E-Mail"), "email");
  assert.strictEqual(latin.normalize("Don\u2019t"), "dont");
  assert.strictEqual(latin.normalize(""), "");
});
