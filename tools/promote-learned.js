/*
 * 把运行期攒下来的词沉淀进离线词典 —— 筛选脚本。
 *
 * 用法：
 *   1. 网易云里听一阵歌（大模型那层多听几句），面板「操作 → 导出词库素材」
 *      （或控制台 `LK.exportWordsJson()`），把那段 JSON 存成 `data/learned.json`
 *      （`data/` 目录不存在就建一个，它不进仓库）；
 *   2. `npm run promote:learned`   —— 筛选后写进 `tools/seed-words-learned.js`
 *   3. `npm run build:dict`        —— 合并进 `src/core/dict.js`
 *
 * **筛选规矩**（宁可少收，收错了就是"离线权威"，模型再没机会纠）：
 *   - 值必须是纯片假名、长度 ≤ 14；
 *   - 词必须是小写字母（词典键的规范形式）；
 *   - 同一个词在多个来源/多个语境里读音必须**一致**，且至少见过 `MIN_LINES` 次；
 *   - 已在人工词表（tools/seed-words.js）里的：**一律不动**（人工优先）；
 *   - 已在黑名单（tools/dict-blocklist.js）里的：丢掉；
 *   - 已有大模型词表（tools/seed-words-llm.js）的：读音相同就跳过（没必要重复），
 *     不同则以这次的为准（记一笔"已更新"）—— 因为它来自真机听歌的上下文；
 *   - 两可的短音节（do/re/mi/me/mo/pi…）不收：读音取决于语境，交给大模型每句判。
 *
 * 目标宿主是网易云内置的老 CEF，所以 src/** 只用 ES5；
 * 这个脚本是构建期工具，可以用现代语法。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INPUT_DEFAULT = path.join(ROOT, "data", "learned.json");
const OUT = path.join(__dirname, "seed-words-learned.js");

/** 一个词至少要在几个不同语境/来源里被确认过才收 */
const MIN_LINES = 2;
const MAX_KANA = 14;
const RE_KANA = /^[\u30A0-\u30FF\u30FC]+$/;

function readInput(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error("读不了 " + file + "：" + e.message);
  }
}

/** 收集素材里所有 (词 -> {读音, 见过几次, 是否一致}) */
function collect(input) {
  const map = new Map();
  function add(word, kana, lines, consistent) {
    const w = String(word || "").trim().toLowerCase();
    const k = String(kana || "").trim();
    if (!w || !k) return;
    const rec = map.get(w) || { word: w, kana: k, lines: 0, consistent: true, sources: [] };
    rec.lines += Math.max(1, Number(lines) || 1);
    if (rec.kana !== k) rec.consistent = false;
    if (consistent === false) rec.consistent = false;
    if (rec.sources.indexOf(k) < 0) rec.sources.push(k);
    map.set(w, rec);
  }
  // 已学会的词：learn.js 已经过了"两个不同句子读音一致"那一关，直接算已确认
  for (const x of input.learned || []) add(x.word, x.kana, 2, true);
  // 大模型缓存：按词归并后的 { word, kana, lines, consistent }
  for (const x of input.llm || []) add(x.word, x.kana, x.lines, x.consistent);
  // 免费接口缓存：词就是键
  for (const x of input.google || []) add(x.word, x.kana, 2, true);
  return map;
}

/**
 * 筛选。返回 { accepted: [...], skipped: [{word, kana, why}] }
 * 这一步是纯函数（喂进来素材和几张表），所以能直接写单元测试。
 *
 * @param {Object} input   导出的素材（{learned, llm, google}）
 * @param {Object} tables  { hand, llm, blocklist, ambiguous }
 *                         hand/llm：词 -> 读音（现有词表）
 *                         blocklist：Set 或对象，命中的词丢掉
 *                         ambiguous(word) -> true 表示"两可"，不收
 */
function filterPromotions(input, tables) {
  const hand = tables.hand || {};
  const llmDict = tables.llm || {};
  const blocklist = tables.blocklist || {};
  const ambiguous = typeof tables.ambiguous === "function" ? tables.ambiguous : () => false;
  const accepted = [];
  const skipped = [];
  for (const rec of collect(input).values()) {
    const { word, kana } = rec;
    const push = (why) => skipped.push({ word, kana, why });
    if (!/^[a-z]+$/.test(word)) {
      push("不是纯小写字母（词典键要小写）");
      continue;
    }
    if (!RE_KANA.test(kana)) {
      push("读音不是纯片假名");
      continue;
    }
    if (kana.length > MAX_KANA) {
      push("读音太长（>" + MAX_KANA + "）");
      continue;
    }
    if (!rec.consistent) {
      push("不同语境给的读音不一致（靠语境，不收）");
      continue;
    }
    if (rec.lines < MIN_LINES) {
      push("只见过 " + rec.lines + " 次（少于 " + MIN_LINES + "）");
      continue;
    }
    if (blocklist[word]) {
      push("在黑名单里");
      continue;
    }
    if (ambiguous(word)) {
      push("两可的短音节（读音取决于语境）");
      continue;
    }
    if (hand[word] !== undefined) {
      push("人工词表里已有 " + hand[word] + "（人工优先）");
      continue;
    }
    if (llmDict[word] === kana) {
      push("大模型词表里已有同样写法");
      continue;
    }
    accepted.push({ word, kana, updated: llmDict[word] !== undefined ? llmDict[word] : null, lines: rec.lines });
  }
  accepted.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  skipped.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return { accepted, skipped };
}

/** 写生成物（每次整份重写：它就是"从素材提炼出来的那批词"） */
function writeSeed(accepted) {
  const lines = [];
  lines.push("/*");
  lines.push(" * 从运行期素材沉淀下来的词（生成物，勿手改）。");
  lines.push(" *");
  lines.push(" * 来源：面板「操作 → 导出词库素材」（或 LK.exportWordsJson()）导出的 JSON，");
  lines.push(" *      经 tools/promote-learned.js 筛选 —— 已学会的词 + 大模型/免费接口缓存的命中。");
  lines.push(" * 生成命令：npm run promote:learned && npm run build:dict");
  lines.push(" *");
  lines.push(" * 本文件条数：" + accepted.length);
  lines.push(" */");
  lines.push("module.exports = [");
  for (const a of accepted) {
    lines.push("  { en: " + JSON.stringify(a.word) + ", kana: " + JSON.stringify(a.kana) + " }," + (a.updated ? " // 原 " + a.updated : ""));
  }
  lines.push("];");
  lines.push("");
  fs.writeFileSync(OUT, lines.join("\n"));
}

function loadTables() {
  const hand = require(path.join(__dirname, "seed-words.js"));
  const llm = require(path.join(__dirname, "seed-words-llm.js"));
  const toMap = (rows) => {
    const out = {};
    for (const r of rows) if (r && r.en) out[String(r.en).toLowerCase()] = r.kana;
    return out;
  };
  let blocklist = {};
  try {
    const b = require(path.join(__dirname, "dict-blocklist.js"));
    const list = Array.isArray(b) ? b : b.list || [];
    for (const w of list) blocklist[String(w).toLowerCase()] = true;
  } catch (e) {
    /* 没有黑名单也能跑 */
  }
  /*
   * 「两可」的短音节：英文读音和唱名/罗马音节都成立（do/re/mi/me/mo/pi/po…）。
   * 判据和 src/core/reading.js 的罗马音层一致：≤3 个字母、能切成日语音节。
   * 这些词钉死一个读音只会错，交给大模型按整句判。
   */
  const ambiguous = (word) => {
    if (!/^[a-z]{1,3}$/.test(word)) return false;
    const kana = require(path.join(ROOT, "src", "core", "reading.js"));
    try {
      const r = kana.romajiToKatakana(word);
      const dictKana = toMap(hand)[word] || toMap(llm)[word];
      return !!(r && dictKana && dictKana !== r);
    } catch (e) {
      return false;
    }
  };
  return { hand: toMap(hand), llm: toMap(llm), blocklist, ambiguous };
}

function main() {
  const file = process.argv[2] || INPUT_DEFAULT;
  const input = readInput(file);
  if (!input) {
    console.error("没有素材文件：" + path.relative(ROOT, file));
    console.error("先在网易云里听一阵歌，面板「操作 → 导出词库素材」（或控制台 LK.exportWordsJson()），");
    console.error("把那段 JSON 存成 " + path.relative(ROOT, INPUT_DEFAULT) + " 再跑这个命令。");
    process.exit(1);
  }
  const tables = loadTables();
  const { accepted, skipped } = filterPromotions(input, tables);
  writeSeed(accepted);
  console.log("已生成 " + path.relative(ROOT, OUT) + "：" + accepted.length + " 个词（从 " + file + " 筛选）");
  if (accepted.length) {
    const updated = accepted.filter((a) => a.updated);
    if (updated.length) console.log("  其中 " + updated.length + " 个是改掉大模型词表里现有写法的：" + updated.map((a) => a.word + " " + a.updated + "→" + a.kana).join("、"));
  }
  if (skipped.length) {
    console.log("  跳过 " + skipped.length + " 个：");
    for (const s of skipped) console.log("    - " + s.word + "（" + s.why + "）");
  }
  console.log("下一步：npm run build:dict");
}

if (require.main === module) main();

module.exports = { filterPromotions, collect, MIN_LINES };
