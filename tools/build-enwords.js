/*
 * 生成 src/core/enwords.js：英文常用词表（给"罗马音层"打可信度用的）。
 *
 * 为什么需要它：罗马音层的判据是"整串都能切成日语音节"，于是
 * `shake`（sha-ke）、`open`（o-pe-n）、`again`（a-ga-i-n）这种英文词会被它
 * 读成日语罗马字（シャケ / オペン / アガイン），而层序里罗马音排在**大模型前面**
 * —— 一旦它答了，大模型就没机会纠正，这些词就**永远读错**。
 * （用户报的就是这个：the pretender up, … shake, shake, shake it up, it up
 *   里 `shake` 成了 シャケ。）
 *
 * 做法：拿载入时的英文词频表当"这看着像英文词"的判据。若一个词
 *   1. 能被罗马音层切开，**且**
 *   2. 在英文常用词表里（下面这个文件），**且**
 *   3. 不在离线读音词典里（词典命中本来就不会走到罗马音层）
 * 就把这个罗马音答案标成**没把握**（confident:false）。上层据此让在线层来仲裁：
 * 大模型一给结果就换掉，给不出才留着（会标成"暂定"，样式淡一点）。
 *
 * 只收"词典里没有的"，文件因此从 10000 条缩到 3000 多条（约 26KB）。
 *
 * 用法：node tools/build-enwords.js   （在项目根目录下跑）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(SRC, "core", "enwords.js");

const SOURCES = [
  "https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@master/google-10000-english.txt",
  "https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english.txt",
];

async function fetchList() {
  let lastErr = null;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } catch (e) {
      lastErr = e;
      console.warn("取词表失败，换下一个源：" + url + "（" + e.message + "）");
    }
  }
  throw lastErr || new Error("词表取不到");
}

async function main() {
  const text = await fetchList();
  const all = text
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z]{3,}$/.test(w));

  // 词典里已经有的不用收：那些词根本走不到罗马音层
  const dictSrc = fs.readFileSync(path.join(SRC, "core", "dict.js"), "utf8");
  const dict = {};
  const re = /"([a-z0-9'\-]+)":\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(dictSrc))) dict[m[1]] = m[2];

  const keep = [];
  const seen = {};
  for (const w of all) {
    if (dict[w] || seen[w]) continue;
    seen[w] = true;
    keep.push(w);
  }
  keep.sort();

  const banner =
    "/*\n" +
    " * 英文常用词表（生成物，勿手改；来源 google-10000-english，已剔除离线词典里已有的）。\n" +
    " *\n" +
    " * 用途：罗马音层遇到「看起来像英文词」的时候要标成「没把握」，好让在线层来仲裁 ——\n" +
    " * 否则 `shake` 会被切成 sha-ke 读成 シャケ、`open` 读成 オペン，\n" +
    " * 而罗马音排在在线层前面，错了也没人纠正。\n" +
    " *\n" +
    " * 重新生成：node tools/build-enwords.js\n" +
    " */\n";

  const out =
    banner +
    "(function (root, factory) {\n" +
    "  if (typeof module === \"object\" && module.exports) module.exports = factory();\n" +
    "  else root.LKEnWords = factory();\n" +
    "})(typeof globalThis !== \"undefined\" ? globalThis : this, function () {\n" +
    "  \"use strict\";\n\n" +
    "  // 空格分隔的一长串，运行时拆成一个查表对象（比写 3000 个 key 的 JS 对象小得多）\n" +
    "  var RAW = \"" + keep.join(" ") + "\";\n\n" +
    "  var words = {};\n" +
    "  var list = RAW.split(\" \");\n" +
    "  for (var i = 0; i < list.length; i++) words[list[i]] = true;\n\n" +
    "  return {\n" +
    "    words: words,\n" +
    "    count: list.length,\n" +
    "    has: function (w) {\n" +
    "      return !!(w && words[String(w).toLowerCase()]);\n" +
    "    },\n" +
    "  };\n" +
    "});\n";

  fs.writeFileSync(OUT, out);
  console.log(
    "已生成 " + path.relative(ROOT, OUT) + "：" + keep.length + " 个词（词表 " + all.length + " 条，词典已有的已剔除）"
  );
}

main().catch((e) => {
  console.error("生成失败：" + (e && e.message));
  process.exit(1);
});
