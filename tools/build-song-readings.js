/*
 * 生成 src/core/songs.js（整首专属读音表）：
 *   1. tools/vendor/sekai/musics.json 里歌名的官方读音，按词切开（自动）；
 *   2. tools/song-readings-hand.js 里的手工条目，同一条歌名两边都有时以手工为准。
 *
 * 官方读音是整首歌名的（`Beat Eater` -> びーといーたー），要标到词上就得切开：
 * 把歌名切成"西文词"和"其它"（假名 / 汉字 / 数字 / 符号当通配段，吃多少假名都行，
 * 代价 0），再在官方读音上找一条最省的切分（DP + 假名编辑距离）。切开之后只在这一首
 * 歌里生效 —— 万一切错了，影响面就是那一首，不会污染别的歌，这也是这一档存在的意义。
 *
 * 歌名可以是纯西文（`Beat Eater`）、西文 + 假名汉字（`potatoになっていく`、
 * `サンドリヨン 10th Anniversary`）、带符号（`Vampire's ∞ pathoS`），后两种靠通配段
 * 对齐，切出来还要过可信度检查，过不了就整条不要。
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
 * 整串官方读音按段切开：西文段尽量像它的候选读音，通配段吃什么都行（代价 0，
 * 也可以是空 —— 歌名里的空格 / 连字符 / 装饰符号本来就不发音）。
 * @param {Array<{cand?: string, wild?: boolean}>} segs
 * @param {string} want
 * @returns {Array<string>|null}
 */
function splitSegments(segs, want) {
  const n = segs.length;
  const L = want.length;
  if (!n) return null;
  const INF = Infinity;
  const dp = [];
  const from = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Array(L + 1).fill(INF));
    from.push(new Array(L + 1).fill(-1));
  }
  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    const seg = segs[i - 1];
    for (let j = 0; j <= L; j++) {
      for (let k = 0; k <= j; k++) {
        if (dp[i - 1][k] === INF) continue;
        const len = j - k;
        if (seg.wild) {
          // 通配段：吃任意长度（含 0），代价 0
          if (dp[i - 1][k] < dp[i][j]) {
            dp[i][j] = dp[i - 1][k];
            from[i][j] = k;
          }
        } else {
          if (len < 1) continue;
          const cost = dp[i - 1][k] + kanaDist(want.slice(k, j), seg.cand);
          if (cost < dp[i][j]) {
            dp[i][j] = cost;
            from[i][j] = k;
          }
        }
      }
    }
  }
  if (dp[n][L] === INF) return null;
  const out = new Array(n);
  let j = L;
  for (let i = n; i >= 1; i--) {
    const k = from[i][j];
    if (k < 0) return null;
    out[i - 1] = want.slice(k, j);
    j = k;
  }
  return out;
}

/** 用插件自己的管线读一个词（词典 -> 罗马音 -> 规则），只当切分的候选 */
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

/**
 * 歌名 -> 段序列。三种段：
 *   - 西文词（要读的）：候选读音来自我们自己的管线；
 *   - 假名段：读音就是它自己（平假名折成片假名），比如 `potatoになっていく` 里的
 *     `になっていく`。它把通配段的自由度收掉大半，切分才可信；
 *   - 通配段：汉字 / 数字 / 别的符号，吃多少假名都行（代价 0）。
 * 纯空白和纯标点的空隙不产生段（歌名里的空格 / 连字符不发音，有了段反而会让 DP
 * 把词的边界挪走，`from Y to Y` 的 Y 就会被切错）。`&` / `＆` 是唯一有读音的符号（アンド）。
 */
function titleSegments(title, read) {
  const segs = [];
  const re = /[A-Za-z][A-Za-z'\u2019]*|[\u3041-\u3096\u30A1-\u30FA\u30FC\u30FB]+|[\u4E00-\u9FFF\u3005]+|[0-9０-９]+|[&＆]+|[\s\S]/g;
  let m;
  while ((m = re.exec(title))) {
    const t = m[0];
    if (/^[A-Za-z]/.test(t)) {
      const r = read(t);
      segs.push({ word: t, cand: r && r.kana ? r.kana : null });
    } else if (/^[\u3041-\u3096\u30A1-\u30FA\u30FC\u30FB]+$/.test(t)) {
      const kana = hiraToKata(t).replace(/[^\u30A0-\u30FF\u30FC]/g, "");
      if (kana) segs.push({ kana: kana, cand: kana });
    } else if (/^[&＆]+$/.test(t)) {
      segs.push({ word: "&", cand: "\u30A2\u30F3\u30C9" });
    } else if (/^[0-9０-９]+$/.test(t) || /^[\u4E00-\u9FFF\u3005]+$/.test(t)) {
      segs.push({ wild: true }); // 数字 / 汉字：吃多少假名都行
    }
    // 别的（空白 / 标点 / 装饰符号）不产生段
  }
  /*
   * `10th` / `1st` 这种：数字后面那一两个字母是序数词尾巴，不是词，
   * 并进前面的数字通配段（不然会多出个 `th=テンス` 这种鬼条目）。
   */
  for (let i = segs.length - 1; i > 0; i--) {
    if (segs[i].word && segs[i].word.length <= 2 && segs[i - 1].wild) {
      segs.splice(i, 1);
    }
  }
  return segs;
}

function generate() {
  const rows = JSON.parse(fs.readFileSync(VENDOR, "utf8"));
  const read = makeReader();
  const entries = [];
  const report = { kept: 0, skipped: [], same: 0, details: [] };

  for (const row of rows) {
    const title = String(row.title || "");
    /* 官方读音里可能有分隔空格（`クラッシュ ザ パーティ`），切之前去掉，否则会切出带空格的段 */
    const want = hiraToKata(String(row.pronunciation || "").replace(/[？?！!。、,.\s\u30FB]/g, ""));
    if (!want) continue;
    const segs = titleSegments(title, read);
    const words = segs.filter((s) => s.word && s.word !== "&");
    if (words.length < 1) continue; // 一个西文词都没有：不归这张表管
    if (words.length === 1 && segs.every((s) => s.word)) continue; // 单词歌名走词典那一档
    if (words.some((w) => w.word.length === 1)) {
      report.skipped.push([title, "含单字母词（那是字母名那一档的事）"]);
      continue;
    }
    if (segs.some((s) => s.word && !s.cand)) {
      report.skipped.push([title, "有词读不出来"]);
      continue;
    }
    const cands = segs.map((s) => s.cand || "");
    const mine = words.map((w) => w.cand).join("");
    if (mine === want) {
      report.same++;
      continue; // 我们已经读对了：不必进这张表
    }
    const chunks = splitSegments(segs, want);
    if (!chunks) {
      report.skipped.push([title, "切不开"]);
      continue;
    }
    /*
     * 切分可信度检查，宁可漏收也不要把错的读音标到整首歌上：
     *   ① 每个西文词的切分非空、不带空格、不是光一个长音符；
     *   ② 首拍要和我们的候选对得上；
     *   ③ 长度和编辑距离都不能离我们的候选太远（通配段让硬凑变得太容易，这里要严）。
     */
    let bad = null;
    segs.forEach((s, i) => {
      if ((!s.word || s.word === "&") || bad) return;
      const c = chunks[i];
      if (!c || /\s/.test(c) || /^\u30FC+$/.test(c)) bad = s.word + "=" + c + "（空段/长音符）";
      else if (c.charAt(0) !== s.cand.charAt(0)) bad = s.word + "=" + c + "（首拍就对不上，我们 " + s.cand + "）";
      else if (Math.abs(c.length - s.cand.length) > 2) bad = s.word + "=" + c + "（长度差太多，我们 " + s.cand + "）";
      else if (kanaDist(c, s.cand) > Math.floor(s.cand.length / 2) + 1) bad = s.word + "=" + c + "（差太多，我们 " + s.cand + "）";
    });
    if (bad) {
      report.skipped.push([title, "切分不可信：" + bad]);
      continue;
    }
    const table = {};
    segs.forEach((s, i) => {
      if (!s.word || s.word === "&") return;
      table[s.word.toLowerCase()] = chunks[i];
    });
    entries.push({ title: title, marker: null, words: table });
    report.kept++;
    report.details.push([title, words.map((w, i) => w.word + "=" + chunks[segs.indexOf(w)]).join(" ")]);
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
 * 整首专属读音：这首歌里的这些词就这么读（自动生成 + 手工条目，勿手改）。
 *
 * 由 tools/build-song-readings.js 生成（跑 npm run build:songs）：
 *   1. tools/vendor/sekai/musics.json 的歌名官方读音，按词切开（只在那一首里生效）——
 *      纯西文、西文 + 假名汉字、带符号的都收（假名汉字符号那部分当"通配段"对齐）；
 *   2. tools/song-readings-hand.js 的手工条目，同一条以手工为准。
 *      自动切分过不了的那些（我们自己的候选读音错太多，没法自证）在这里手工切开；
 *      前提是有官方读音可查，自己按词义猜的不进表。
 *
 * 结构：{ title, marker, words }
 *   title  歌名正则（播放栏那行，命中即这一首）
 *   marker 备用判据：整首歌词里出现这个词就认（歌名读不到 / 标题写法不同时用）
 *   words  小写词 -> 片假名读音
 *
 * 命中之后：这些读音排在所有层前面（来源 \`song\`，层序 -1，大模型也不会被咨询）。
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
  const skipped = g.report.skipped;
  if (skipped.length) {
    console.log("  跳过 " + skipped.length + " 条：");
    skipped.forEach((s) => console.log("    - " + s[0] + "（" + s[1] + "）"));
  }
  console.log("  切分明细：");
  g.report.details.forEach((s) => console.log("    " + s[0] + " —— " + s[1]));
}

if (require.main === module) main();
module.exports = { generate, content, splitSegments, kanaDist, hiraToKata, titleSegments };
