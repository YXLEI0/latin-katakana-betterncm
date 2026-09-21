/*
 * 把 tools/vendor/loan/*.txt 里的 sljfaq 借词表编译成 src/core/loan.js。
 *
 *   node tools/build-loan.js
 *
 * 为什么要过一道编译、而不是手工把表抄进 JS：
 *   - 借词表是**别人整理好的数据**（sci.lang.japan FAQ 的 "Which Japanese words come
 *     from X?"），抄进源码时最容易抄错/抄漏，而且没法核对是不是最新；
 *   - txt 是纯文本，diff 起来一眼能看出加了哪个词；
 *   - core/loan.js 是生成的（和 core/dict.js 一样"勿手改"），运行时只做一次解析。
 *
 * 输入格式（每个文件）：
 *   # 注释行（来源 URL、抓取日期、条目数）
 *   слово:カタカナ
 * 键可以是非 ASCII（俄语西里尔），拉丁语的键我们自己再折一次变音符号。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IN_DIR = path.join(__dirname, "vendor", "loan");
const OUT = path.join(ROOT, "src", "core", "loan.js");

/** 文件名 -> 语言 id（core/langs.js 里的 id） */
const LANGS = { de: "de", nl: "nl", pt: "pt", ru: "ru", el: "el", la: "la" };

/** 只允许片假名 + 长音符 */
const RE_KANA = /^[\u30A1-\u30F6\u30FC]+$/;

function readTable(file) {
  const raw = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const pairs = [];
  const seen = Object.create(null);
  for (const line of raw) {
    const t = line.trim();
    if (!t || t.charAt(0) === "#") continue;
    const at = t.indexOf(":");
    if (at <= 0) throw new Error(`${path.basename(file)}: 这行没有冒号：${t}`);
    const word = t.slice(0, at).trim();
    const kana = t.slice(at + 1).trim();
    if (!word) throw new Error(`${path.basename(file)}: 空的词：${t}`);
    if (!RE_KANA.test(kana)) throw new Error(`${path.basename(file)}: 读音不是纯片假名：${t}`);
    if (seen[word]) {
      // 重复键直接报错：宁可让人去 txt 里合并，也不要"后面那条悄悄赢"
      throw new Error(`${path.basename(file)}: 重复的词 ${word}`);
    }
    seen[word] = true;
    pairs.push([word, kana]);
  }
  return pairs;
}

function main() {
  if (!fs.existsSync(IN_DIR)) {
    console.error("没有 " + IN_DIR + "（借词表目录），跳过");
    process.exit(0);
  }
  const files = fs.readdirSync(IN_DIR).filter((f) => f.endsWith(".txt"));
  const tables = {};
  const counts = [];
  for (const f of files) {
    const id = LANGS[path.basename(f, ".txt")];
    if (!id) {
      console.error("跳过不认识的表：" + f);
      continue;
    }
    const pairs = readTable(path.join(IN_DIR, f));
    tables[id] = pairs;
    counts.push(id + " " + pairs.length);
  }
  if (!counts.length) {
    console.error("表都是空的，没有东西可生成");
    process.exit(0);
  }

  const lines = [];
  lines.push("/*");
  lines.push(" * 借词表（**自动生成，勿手改**）：`npm run build:loan`。");
  lines.push(" *");
  lines.push(" * 数据来源是 sci.lang.japan FAQ 的 \"Which Japanese words come from <语言>?\"");
  lines.push(" * （用户给的测试用例页面：portuguese.html / dutch.html / german.html / russian.html），");
  lines.push(" * 也就是**日语里通行的写法**。它和拼读规则是两回事：");
  lines.push(" *   规则层 = 照拼写猜（confident:false，配了 key 会交给大模型改）");
  lines.push(" *   这张表 = 日语里就是那么写的（confident:true，等同于人工词条）");
  lines.push(" * 所以外语行上**先查这张表**，连英语词典都要让路。");
  lines.push(" *");
  lines.push(" * 原始数据在 tools/vendor/loan/*.txt（带来源 URL 与抓取日期）：" + counts.join(", ") + "。");
  lines.push(" */");
  lines.push("(function (root, factory) {");
  lines.push('  if (typeof module === "object" && module.exports) module.exports = factory();');
  lines.push("  else root.LKLoan = factory();");
  lines.push('})(typeof globalThis !== "undefined" ? globalThis : this, function () {');
  lines.push('  "use strict";');
  lines.push("");
  lines.push("  /* 键已经折成小写、去掉了空格/连字符/变音符号，查表时用同一套折法 */");
  lines.push("  var RAW = {");
  for (const id of Object.keys(tables)) {
    const pairs = tables[id];
    lines.push("    " + id + ": {");
    for (const [w, k] of pairs) {
      lines.push("      " + JSON.stringify(w) + ": " + JSON.stringify(k) + ",");
    }
    lines.push("    },");
  }
  lines.push("  };");
  lines.push("");
  lines.push("  var COUNT = 0;");
  lines.push("  for (var lang in RAW) {");
  lines.push("    if (Object.prototype.hasOwnProperty.call(RAW, lang)) COUNT += Object.keys(RAW[lang]).length;");
  lines.push("  }");
  lines.push("");
  lines.push("  return {");
  lines.push("    tables: RAW,");
  lines.push("    count: COUNT,");
  lines.push("    /** 查一张表；没有这张表返回 null（调用方自己决定怎么退化） */");
  lines.push("    get: function (lang) {");
  lines.push("      return RAW[lang] || null;");
  lines.push("    },");
  lines.push("  };");
  lines.push("});");
  lines.push("");

  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log("已生成 " + path.relative(ROOT, OUT) + "：" + counts.join(", ") + "，共 " + Object.keys(tables).reduce((n, k) => n + tables[k].length, 0) + " 条");
}

main();
