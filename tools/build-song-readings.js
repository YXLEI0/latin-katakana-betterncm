/*
 * 生成 src/core/songs.js（**整首专属读音**表）：
 *   1. tools/vendor/sekai/musics.json 里**多词歌名**的官方读音，按词切开（自动）；
 *   2. tools/song-readings-hand.js 里的手工条目（歌名 / 歌词识别词 + 词表）——
 *      同一条歌名两边都有时以手工为准。
 *
 * 为什么需要"整首"这一档
 * ----------------------
 * 官方的读音是**整首歌名**的（`Beat Eater` -> びーといーたー），要标到词上就得切开。
 * 切法是：先按我们自己的管线给每个词一个候选读音，再在"官方整串读音"上找一条最省的
 * 切分（DP + 假名编辑距离）。切开之后只在**这一首歌**里生效 —— 万一切错了，
 * 影响面就是那一首，不会污染别的歌（这也是"整首专属"这一档存在的意义）。
 *
 * 用法：npm run build:songs
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(__dirname, "vendor", "sekai", "musics.json");
const HAND = path.join(__dirname, "song-readings-hand.js");
const OUT = path.join(ROOT, "src", "core", "songs.js");

const KANA = /^[\u30A0-\u30FF\u30FC]+$/;
const JPN = /[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF\u3005]/;

function hiraToKata(s) {
  return String(s || "").replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/** 片假名编辑距离（长音符算一个字符） */
function kanaDist(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n];
}

/**
 * 把整串官方读音切成 n 段，使第 i 段尽量像候选读音 cands[i]。
 * 返回切好的数组（拿不到合法切法返回 null）。
 */
function splitReading(cands, want) {
  const n = cands.length;
  const L = want.length;
  if (!n || L < n) return null;
  const INF = Infinity;
  // dp[i][j]：前 i 个词覆盖 want 的前 j 个字符的最小代价
  const dp = [];
  const from = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Array(L + 1).fill(INF));
    from.push(new Array(L + 1).fill(-1));
  }
  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = i; j <= L - (n - i); j++) {
      for (let k = i - 1; k < j; k++) {
        if (dp[i - 1][k] === INF) continue;
        const chunk = want.slice(k, j);
        const cost = dp[i - 1][k] + kanaDist(chunk, cands[i - 1]);
        if (cost < dp[i][j]) {
          dp[i][j] = cost;
          from[i][j] = k;
        }
      }
    }
  }
  if (dp[n][L] === INF) return null;
  const out = new Array(n);
  let j = L;
  for (let i = n; i >= 1; i--) {
    const k = from[i][j];
    out[i - 1] = want.slice(k, j);
    j = k;
  }
  return out;
}

/** 用插件自己的管线读一个词（词典 -> 罗马音 -> 规则）—— 只当切分的候选 */
function makeReader() {
  const dict = require(path.join(ROOT, "src", "core", "dict.js")).words;
  const WKReading = require(path.join(ROOT, "src", "core", "reading.js"));
  const reader = WKReading.createReader({ dict: dict });
  return function read(word) {
    const low = String(word).toLowerCase();
    if (dict[low]) return { kana: dict[low], source: "dict" };
    const r = reader.read(low);
    return r && r.kana ? { kana: r.kana, source: r.source } : null;
  };
}

/** 歌名里的词（只取字母词；`&` / `＆` 这种记号按 アンド 算） */
function titleTokens(title) {
  const out = [];
  const re = /[A-Za-z][A-Za-z']*|[&＆]/g;
  let m;
  while ((m = re.exec(title))) out.push(m[0]);
  return out;
}

function generate() {
  const rows = JSON.parse(fs.readFileSync(VENDOR, "utf8"));
  const read = makeReader();
  const entries = [];
  const report = { kept: 0, skipped: [], same: 0 };

  for (const row of rows) {
    const title = String(row.title || "");
    /* 官方读音里可能有分隔空格（`クラッシュ ザ パーティ`）：切之前去掉，否则会切出带空格的段 */
    const want = hiraToKata(String(row.pronunciation || "").replace(/[？?！!。、,.\s\u30FB]/g, ""));
    if (!want || JPN.test(title)) continue;
    const toks = titleTokens(title);
    if (toks.length < 2) continue; // 单词歌名走词典那一档（seed-words-sekai）
    if (/[0-9０-９]/.test(title)) continue; // 数字的读法（`99 Glooms`）不在这张表里管
    /*
     * 只处理"干净"的歌名：字母 + 空格 + 常见连接符。带 `@` `☆` `Ⅲ` 那种花体写法的
     * （`M@GICAL☆CURE!`、`PaⅢ.SENSATION`）分词和切分都不可靠，宁可不收 ——
     * 要收就手工写进 song-readings-hand.js。
     */
    if (!/^[A-Za-z][A-Za-z' \-×＆&!?,]*$/.test(title)) continue;
    const cands = toks.map((t) => (t === "&" || t === "＆" ? "アンド" : (read(t) || {}).kana || null));
    if (cands.some((c) => !c || !KANA.test(c))) {
      report.skipped.push([title, "有词读不出来"]);
      continue;
    }
    const mine = cands.join("");
    if (mine === want) {
      report.same++;
      continue; // 我们已经读对了：不必进这张表
    }
    const chunks = splitReading(cands, want);
    if (!chunks) {
      report.skipped.push([title, "切不开"]);
      continue;
    }
    /*
     * 切分可信度检查（宁可漏收，也不要把错的读音标到整首歌上）：
     *   ① 每段非空、不带空格、不是光一个长音符；
     *   ② 每段长度和我们候选差不超过 2 拍；
     *   ③ 每段与我们候选的编辑距离不超过"候选长度的一半 + 1"。
     */
    const bad = chunks.find((c, i) => {
      if (!c || /\s/.test(c) || /^\u30FC+$/.test(c)) return true;
      if (Math.abs(c.length - cands[i].length) > 2) return true;
      return kanaDist(c, cands[i]) > Math.floor(cands[i].length / 2) + 1;
    });
    if (bad) {
      report.skipped.push([title, "切分不可信：" + toks.map((t, i) => t + "=" + chunks[i] + "(我们 " + cands[i] + ")").join(" ")]);
      continue;
    }
    const words = {};
    toks.forEach((t, i) => {
      if (t === "&") return;
      words[t.toLowerCase()] = chunks[i];
    });
    entries.push({ title: title, marker: null, words: words });
    report.kept++;
    report.skipped.push([title, "收下：" + toks.map((t, i) => t + "=" + chunks[i]).join(" ")]);
  }

  // 手工条目优先（同一条歌名以手工为准）
  const hand = fs.existsSync(HAND) ? require(HAND) : [];
  for (const h of hand) {
    const i = entries.findIndex((e) => String(e.title) === String(h.title));
    if (i >= 0) entries.splice(i, 1);
    entries.push(h);
  }
  return { entries, report };
}

function esc(re) {
  return String(re).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function content(entries) {
  const body = entries
    .map((e) => {
      const words = Object.keys(e.words)
        .sort()
        .map((k) => JSON.stringify(k) + ": " + JSON.stringify(e.words[k]))
        .join(", ");
      const title = e.title ? "title: new RegExp(" + JSON.stringify(esc(e.title)) + ', "i"),' : "title: null,";
      const marker = e.marker ? "marker: new RegExp(" + JSON.stringify(e.marker) + ")," : "marker: null,";
      return "    { " + title + " " + marker + " words: { " + words + " } },";
    })
    .join("\n");
  return `/*
 * **整首专属读音**：这首歌里的这些词就这么读（**自动生成 + 手工条目，勿手改**）。
 *
 * 由 tools/build-song-readings.js 生成（跑 npm run build:songs）：
 *   1. tools/vendor/sekai/musics.json 里多词歌名的官方读音，按词切开（只在那一首里生效）；
 *   2. tools/song-readings-hand.js 的手工条目（歌名或歌词识别词 + 词表），同一条以手工为准。
 *
 * 结构：{ title, marker, words }
 *   title  歌名正则（播放栏那行，命中即这一首）
 *   marker 备用判据：整首歌词里出现这个词就认（歌名读不到 / 标题写法不同时用）
 *   words  小写词 -> 片假名读音
 *
 * 命中之后：这些读音排在**所有层前面**（来源 \`song\`，层序 -1，大模型也不会被咨询）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKSongs = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var list = [
${body}
  ];

  return { list: list, count: list.length };
});
`;
}

function main() {
  const g = generate();
  fs.writeFileSync(OUT, content(g.entries));
  console.log("已生成 " + path.relative(ROOT, OUT) + "：" + g.entries.length + " 条" +
    "（官方切分 " + g.report.kept + " + 手工；已读对 " + g.report.same + " 条不进表）");
  const skipped = g.report.skipped.filter((s) => s[1].indexOf("收下") !== 0);
  if (skipped.length) {
    console.log("  跳过 " + skipped.length + " 条：");
    skipped.forEach((s) => console.log("    - " + s[0] + "（" + s[1] + "）"));
  }
  console.log("  切分明细：");
  g.report.skipped.filter((s) => s[1].indexOf("收下") === 0).forEach((s) => console.log("    " + s[0] + " —— " + s[1].slice(3)));
}

if (require.main === module) main();
module.exports = { generate, content, splitReading, kanaDist, hiraToKata };
