/*
 * 从 Project Sekai 官方主数据库（tools/vendor/sekai/musics.json）里筛出**西文歌名的
 * 官方读音**，生成 tools/seed-words-sekai.js，再由 build-dict 并进离线词典。
 *
 * 数据来源
 * --------
 *   https://pjsekai.moe/#/music/<id>   （用户给的站点，id 可换）
 *   https://sekai-world.github.io/sekai-master-db-diff/musics.json   （站点用的主数据）
 * 记的是官方读音（平假名），例如：
 *   "Forward"      -> ふぉわーど     -> フォワード
 *   "Nostalogic"   -> のすたろじっく -> ノスタロジック
 *
 * 只收**单个西文词**的歌名
 * ------------------------
 * 官方的读音是**整首歌名**的读音，多词歌名没法反推"哪个假名属于哪个词"
 * （`the EmpErroR` 官方读 ジエンペラー —— "the" 那一拍是标题里的梗，当成 the 的
 * 通用读音收进词典就毁了）。所以：
 *   - 全西文、且只有一个词（不含数字、不含点/横线那种记号）-> 收；
 *   - 多词、和日文混排 -> 跳过（数据留在 vendor 里，将来要按歌名做专属读音再说）。
 *
 * 用法：npm run build:sekai（改过 vendor/sekai/musics.json 后重跑）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(__dirname, "vendor", "sekai", "musics.json");
const OUT = path.join(__dirname, "seed-words-sekai.js");
const DICT = path.join(ROOT, "src", "core", "dict.js");

const RE_EN = /^[a-z]+$/;
const RE_KANA = /^[\u30A0-\u30FF\u30FC]+$/;
const RE_TITLE_LATIN = /^[A-Za-z][A-Za-z' ]*$/;
const KANJI_KANA = /[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF\u3005\u30FC]/;

/** 平假名 -> 片假名（官方读音是平假名，词典里统一片假名） */
function toKatakana(s) {
  return String(s || "").replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/**
 * 生成 seed 文件的内容（不写盘 —— check.js 拿它和提交进去的那份逐字节比）。
 * @returns {{content: string, keys: string[], skip: object, handHits: string[], already: string[]}}
 */
function generate() {
  const rows = JSON.parse(fs.readFileSync(VENDOR, "utf8"));
  const dict = require(DICT).words;
  const hand = require(path.join(__dirname, "seed-words.js"));
  const handSet = {};
  for (const r of hand) handSet[String((r && r.en) || "").toLowerCase()] = String((r && r.kana) || "");
  /*
   * 上一次生成的这一份要排除掉再和词典比："已经读对"的意思是**别的来源**已经读对，
   * 不然重跑一次会把上一轮自己写进去的词当成"已经读对"丢掉，seed 越跑越空。
   */
  const prevSet = {};
  if (fs.existsSync(OUT)) {
    for (const r of require(OUT) || []) prevSet[String((r && r.en) || "").toLowerCase()] = true;
  }

  const out = {};
  const skip = { multiWord: 0, mixed: 0, digits: 0, punctuation: 0, hand: 0, already: 0, bad: 0, single: 0 };
  const handHits = [];
  const already = [];

  for (const m of rows) {
    const title = String(m.title || "");
    const kana = toKatakana(String(m.pronunciation || "").replace(/[？?！!。、,.]/g, ""));
    if (!kana || !RE_KANA.test(kana)) {
      skip.bad++;
      continue;
    }
    if (/[0-9０-９]/.test(title)) {
      skip.digits++;
      continue;
    }
    if (KANJI_KANA.test(title)) {
      skip.mixed++;
      continue;
    }
    const words = title.match(/[A-Za-z][A-Za-z']*/g) || [];
    if (words.length !== 1) {
      skip.multiWord++;
      continue;
    }
    // 单个西文词：歌名里除了这个词还有别的符号（`p.h.` / `Un-Lock`）就不收 ——
    // 那种在分词里是记号，词典这一层根本轮不到
    if (!RE_TITLE_LATIN.test(title)) {
      skip.punctuation++;
      continue;
    }
    const en = words[0].toLowerCase();
    if (en.length < 2) {
      skip.single++;
      continue;
    }
    if (!RE_EN.test(en)) {
      skip.bad++;
      continue;
    }
    if (handSet[en] !== undefined) {
      skip.hand++;
      handHits.push(en + "（人工词表里已有 " + handSet[en] + "，官方是 " + kana + "）");
      continue;
    }
    if (dict[en] === kana && !prevSet[en]) {
      skip.already++;
      already.push(en);
      continue;
    }
    out[en] = kana;
  }

  const keys = Object.keys(out).sort();
  const body = keys.map((k) => '  { en: ' + JSON.stringify(k) + ", kana: " + JSON.stringify(out[k]) + " },").join("\n");
  const content = `/*
 * 官方歌名读音：Project Sekai 主数据库里**单个西文词**的歌名（\u5171 ${keys.length} 条）。
 *
 * **自动生成，勿手改** —— 由 tools/build-sekai.js 从 tools/vendor/sekai/musics.json 生成，
 * 跑 npm run build:sekai 重新生成（原始数据：sekai-world/sekai-master-db-diff 的 musics.json，
 * 见 https://pjsekai.moe/#/music/<id>）。
 *
 * 为什么收：这些是官方读音（游戏里就这么读），而我们自己的英文音译规则会读错
 * （Nostalogic -> ノサタロギス、CHAOS -> チアオス、needLe -> ネエドドル…）。
 * 只收单词歌名：多词歌名的读音没法逐词归因（the EmpErroR 官方读 ジエンペラー）。
 *
 * 优先级：人工词表（seed-words.js）> 本表 > 运行期沉淀（seed-words-learned.js）> 大模型批量（seed-words-llm.js）。
 */
"use strict";

module.exports = [
${body}
];
`;
  return { content, keys, skip, handHits, already };
}

function main() {
  const g = generate();
  fs.writeFileSync(OUT, g.content);
  console.log("已生成 " + path.relative(ROOT, OUT) + "：" + g.keys.length + " 条");
  const s = g.skip;
  console.log(
    "  跳过：多词 " + s.multiWord + " · 日文混排 " + s.mixed + " · 带数字 " + s.digits +
      " · 带记号 " + s.punctuation + " · 人工已有 " + s.hand + " · 读音已一致 " + s.already +
      " · 单字母 " + s.single + " · 数据脏 " + s.bad
  );
  if (g.handHits.length) console.log("  人工词表里已有的（官方读音不同也没改）：\n    " + g.handHits.join("\n    "));
  if (g.already.length) console.log("  我们现在已经读对的：" + g.already.join(" "));
}

if (require.main === module) main();
module.exports = { generate };
