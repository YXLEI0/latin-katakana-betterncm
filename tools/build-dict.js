/*
 * 生成离线读音词典：tools/seed-words.js + tools/seed-words-llm.js -> src/core/dict.js
 *
 * 这一份**不联网**（生成过程本身也不联网，只是把两份现成的表合成一个文件）：
 *   1. tools/seed-words.js      人工核过的词（反转来的真实外来语写法 + 手工补充）
 *   2. tools/seed-words-llm.js  由 tools/expand-dict-llm.js 让大模型按词频批量生成的读音
 * 人工的优先，同一个词两边都有时保留人工那份。
 *
 * 用法：npm run build:dict
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SEED = path.join(ROOT, "tools", "seed-words.js");
const OUT = path.join(ROOT, "src", "core", "dict.js");

// 英文侧必须是纯小写字母
const RE_EN = /^[a-z]+$/;
// 读音必须是纯片假名（可带长音符）。混进汉字/平假名说明数据脏了，
// 而这种错会直接标到歌词上，必须拦下来。
const RE_KANA = /^[\u30A0-\u30FF\u30FC]+$/;

const seed = require(SEED);
if (!Array.isArray(seed) || !seed.length) {
  console.error("种子词表是空的：" + SEED);
  process.exit(1);
}

const words = {};
const problems = [];
for (const row of seed) {
  const en = String((row && row.en) || "")
    .trim()
    .toLowerCase();
  const kana = String((row && row.kana) || "").trim();
  if (!RE_EN.test(en)) {
    problems.push("英文侧不是纯小写字母：" + JSON.stringify(row));
    continue;
  }
  if (!RE_KANA.test(kana)) {
    problems.push("读音不是纯片假名：" + JSON.stringify(row));
    continue;
  }
  if (words[en] && words[en] !== kana) {
    problems.push("同一个词有两种写法（留第一个）：" + en + " -> " + words[en] + " / " + kana);
    continue;
  }
  words[en] = kana;
}

if (problems.length) {
  console.error("种子词表有问题，已中止：");
  for (const p of problems) console.error("  - " + p);
  process.exit(2);
}

const handCount = Object.keys(words).length;

/*
 * 第二份数据源：tools/seed-words-llm.js —— 由 tools/expand-dict-llm.js 让大模型
 * 按词频批量生成的读音（几千条）。**人工核过的 seed-words.js 优先**：同一个词
 * 两边都有时保留人工那份，生成物不许覆盖人工判断。
 *
 * 为什么要有这一层：纯拼写规则读不对 hello / question / shining 这类词，
 * 而歌词里高频词其实是有限的一批。构建期问一次，运行期就是纯离线查表。
 */
const LLM_SEED = path.join(__dirname, "seed-words-llm.js");
let llmWords = {};
if (fs.existsSync(LLM_SEED)) {
  const mod = require(LLM_SEED);
  llmWords = (mod && mod.words) || {};
} else {
  console.log("提示：没有 " + path.relative(ROOT, LLM_SEED) + "，只用人工词表（跑 npm run build:dict:llm 生成）");
}

let llmProblems = 0;
let llmAdded = 0;
let llmSkipped = 0;
let llmBlocked = 0;
/*
 * 生成词表里"读错义项"的黑名单 —— 见 tools/dict-blocklist.js（和测试共用一份）。
 */
const BLOCK_LLM = require(path.join(__dirname, "dict-blocklist.js"));
for (const en of Object.keys(llmWords).sort()) {
  const kana = String(llmWords[en] || "").trim();
  if (!RE_EN.test(en) || !RE_KANA.test(kana)) {
    llmProblems++;
    continue;
  }
  if (words[en] !== undefined) {
    llmSkipped++; // 人工词表里有，保留人工的
    continue;
  }
  if (BLOCK_LLM[en]) {
    llmBlocked++;
    continue;
  }
  words[en] = kana;
  llmAdded++;
}
if (llmProblems) {
  console.error("生成词表里有 " + llmProblems + " 条格式不对，已跳过（修 tools/seed-words-llm.js 或重跑生成）");
}

/*
 * 第三份数据源：tools/seed-words-learned.js —— **运行期沉淀下来的词**
 * （面板「操作 → 导出词库素材」导出的 JSON，经 tools/promote-learned.js 筛选）。
 *
 * 优先级夹在中间：人工核过的 seed-words.js **高于**它，它**高于**大模型批量生成的
 * seed-words-llm.js —— 那些词来自真机听歌的上下文（同一个词在两个句子里读音一致
 * 才收），比"按词频一次生成"更可信。
 */
const LEARNED_SEED = path.join(__dirname, "seed-words-learned.js");
let learnedAdded = 0;
let learnedSkipped = 0;
if (fs.existsSync(LEARNED_SEED)) {
  let rows = [];
  try {
    rows = require(LEARNED_SEED) || [];
  } catch (e) {
    console.error("读不了 " + path.relative(ROOT, LEARNED_SEED) + "：" + e.message + "（跳过）");
    rows = [];
  }
  for (const row of rows) {
    const en = String((row && row.en) || "").trim().toLowerCase();
    const kana = String((row && row.kana) || "").trim();
    if (!RE_EN.test(en) || !RE_KANA.test(kana)) continue;
    if (words[en] !== undefined) {
      learnedSkipped++; // 人工词表里有，人工优先
      continue;
    }
    words[en] = kana;
    learnedAdded++;
  }
}

const keys = Object.keys(words).sort();const body = keys
  .map((k) => "    " + JSON.stringify(k) + ": " + JSON.stringify(words[k]) + ",")
  .join("\n");

const out = `/*
 * 英文 -> 片假名读音词典（**自动生成，勿手改**）。
 *
 * 两份数据源，由 tools/build-dict.js 合并（跑 npm run build:dict 重新生成）：
 *   1. tools/seed-words.js      —— 人工核过（其中大部分是从 katakana-terminator 的
 *      离线词典反转来的真实外来语写法，那份本来就是"片假名外来语 -> 英文原词"）；
 *   2. tools/seed-words-llm.js  —— 大模型按英文词频批量生成的读音（${llmAdded} 条），
 *      由 tools/expand-dict-llm.js 生成，人工词表优先。
 *
 * 读音查找顺序见 core/reading.js：本词典 -> 罗马音切分 -> 英文音译规则
 * （-> 大模型校正，运行期，见 core/llm.js）。
 * 词典命中是唯一"确定对"的来源，所以常用词尽量收进这里。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKDict = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var words = {
${body}
  };

  return {
    words: words,
    count: ${keys.length},
  };
});
`;

fs.writeFileSync(OUT, out);
console.log("已生成 " + path.relative(ROOT, OUT) + "：" + keys.length + " 条" +
  "（人工 " + handCount + " 条 + 沉淀 " + learnedAdded + " 条 + 大模型 " + llmAdded + " 条，生成物里被人工覆盖 " +
  (llmSkipped + learnedSkipped) + " 条" +
  (llmBlocked ? "，黑名单拦下 " + llmBlocked + " 条" : "") + "）");
