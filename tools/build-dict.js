/*
 * 生成离线读音词典：tools/seed-words.js -> src/core/dict.js
 *
 * 和 katakana-terminator 的 build-dict.js 不同，这一份**不联网** ——
 * 读音数据来自种子词表（反转来的真实外来语写法 + 手工补充），
 * 生成出来只是为了让插件不必在运行时解析一份 400 条的数组。
 *
 * 用法：npm run build:dict
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SEED = path.join(ROOT, "tools", "seed-words.js");
const OUT = path.join(ROOT, "src", "core", "dict.js");

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
  if (!/^[a-z]+$/.test(en)) {
    problems.push("英文侧不是纯小写字母：" + JSON.stringify(row));
    continue;
  }
  // 读音必须是纯片假名（可带长音符）。混进汉字/平假名说明数据脏了，
  // 而这种错会直接标到歌词上，必须拦下来。
  if (!/^[\u30A0-\u30FF\u30FC]+$/.test(kana)) {
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

const keys = Object.keys(words).sort();
const body = keys
  .map((k) => "    " + JSON.stringify(k) + ": " + JSON.stringify(words[k]) + ",")
  .join("\n");

const out = `/*
 * 英文 -> 片假名读音词典（**自动生成，勿手改**）。
 *
 * 数据源：tools/seed-words.js（改词表后跑 npm run build:dict）。
 * 其中大部分是从 katakana-terminator 的离线词典反转来的真实外来语写法
 * （那份词典本来就是"片假名外来语 -> 英文原词"），其余是手工补的歌词高频词。
 *
 * 读音查找顺序见 core/reading.js：本词典 -> 罗马音切分 -> 英文音译规则。
 * 词典命中是唯一"确定对"的来源，所以常用词尽量收进这里。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LKDict = factory();
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
console.log("已生成 " + path.relative(ROOT, OUT) + "：" + keys.length + " 条");
