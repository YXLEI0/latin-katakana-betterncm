/*
 * 用大模型批量扩充离线读音词典：英文词 -> 片假名读音。
 *
 * 为什么要有这个工具：
 *   纯拼写规则（src/core/reading.js 里那一层）永远读不对 hello / question 这种词，
 *   实测大模型给的读音质量是碾压性的。但**运行期**再问一遍要花用户的钱、要联网、
 *   要等，而歌词里高频词其实是有限的一批 —— 那就构建期问一次，写进离线词典。
 *   运行期的词典层是同步的、离线的、零成本，命中率上去之后规则层只当兜底。
 *
 * 数据源：一份公开的英文词频表（google-10000-english）取前 N 个，
 *   加上 tools/seed-words.js 已经有人工核过的词（人工优先，不覆盖）。
 * 产物：tools/seed-words-llm.js（生成物，勿手改），由 tools/build-dict.js 合并进
 *   src/core/dict.js。
 *
 * 用法：
 *   node tools/expand-dict-llm.js --top 3000              # 取词频前 3000
 *   node tools/expand-dict-llm.js --top 3000 --dry-run    # 只打印要问哪些词
 *   node tools/expand-dict-llm.js --resume                # 接着上次的产物继续问
 *
 * key 从环境变量 DEEPSEEK_API_KEY 读；**绝不**写进仓库里的任何文件。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(__dirname, ".cache");
const CACHE_WORDS = path.join(CACHE_DIR, "google-10000-english.txt");
const OUT = path.join(__dirname, "seed-words-llm.js");
const SEED = path.join(__dirname, "seed-words.js");

/*
 * 词频表地址，按顺序试。
 * 注意 raw.githubusercontent.com 在本机是 FAIL UNABLE_TO_VERIFY_LEAF_SIGNATURE
 * （沙箱里的 TLS 中间证书问题），所以默认走 jsDelivr 镜像。
 */
const FREQ_URLS = [
  "https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@master/google-10000-english.txt",
  "https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english.txt",
];
const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";
const BATCH = 40;

// 只接受纯片假名（可带长音符与促音小写假名）
const RE_KANA = /^[\u30A1-\u30F6\u30FC]+$/;
// 词频表里的噪声：缩写、域名、非词
const JUNK = /^(www|http|https|com|org|net|html|php|asp|jsp|pdf|gif|jpg|jpeg|png|css|xml|ftp|url|uri|api|sql|xml|id|ip|pc|tv|dvd|cd|ok|oh|ah|eh|uh|um|hmm|mmm|la|na|da|ya|wa|ja|ma|ha|ta|ka|sa|ra|pa|ba|ga|za|ad|etc|vs|st|nd|rd|th|mr|mrs|ms|dr|prof|inc|ltd|co|corp|dept|univ)$/;
const RE_ALPHA = /^[a-z]+$/;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(name);

// ---------------------------------------------------------------- 词表

async function freqWords(top) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  let text;
  if (fs.existsSync(CACHE_WORDS)) {
    text = fs.readFileSync(CACHE_WORDS, "utf8");
    console.log("用缓存的词频表：" + path.relative(ROOT, CACHE_WORDS));
  } else {
    let lastErr = null;
    text = null;
    for (const url of FREQ_URLS) {
      try {
        console.log("下载词频表：" + url);
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        text = await res.text();
        break;
      } catch (e) {
        lastErr = e;
        console.log("  失败：" + (e && e.message));
      }
    }
    if (!text) throw new Error("词频表下载失败：" + (lastErr && lastErr.message));
    fs.writeFileSync(CACHE_WORDS, text);
  }
  return text
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter((w) => w.length >= 2 && w.length <= 14 && RE_ALPHA.test(w) && !JUNK.test(w))
    .slice(0, top);
}

/** 已经人工核过的词（seed-words.js）：这些不问，也不许被生成物覆盖 */
function handWords() {
  const seed = require(SEED);
  const map = {};
  for (const row of seed) if (row && row.en) map[String(row.en).toLowerCase()] = String(row.kana || "");
  return map;
}

/*
 * `src/core/reading.js` 里的 ENGLISH_EXCEPTIONS / ENGLISH_LEXICON 也是人工核过的，
 * 而且**查表顺序在词典之后**（reader: dict -> romaji -> exceptions -> lexicon -> 规则）。
 * 也就是说：如果这里给同一个词生成了读音，它会盖掉那份人工结果。
 * 所以这些词也要当"人工词"排除掉，不能让生成物把人工判断顶掉。
 */
function handWordsFromReadingJs() {
  const src = fs.readFileSync(path.join(ROOT, "src", "core", "reading.js"), "utf8");
  const out = {};
  for (const name of ["ENGLISH_EXCEPTIONS", "ENGLISH_LEXICON"]) {
    const i = src.indexOf("var " + name + " = {");
    if (i < 0) {
      console.log("提示：reading.js 里找不到 " + name + "，跳过（表结构可能变了，请人工确认）");
      continue;
    }
    const j = src.indexOf("\n  };", i);
    const body = src.slice(i, j < 0 ? src.length : j);
    const re = /^\s*([a-z][a-z'-]*)\s*:/gm;
    let m;
    while ((m = re.exec(body))) out[m[1]] = true;
  }
  const n = Object.keys(out).length;
  if (n < 50) {
    console.log("提示：从 reading.js 只认出 " + n + " 个词，可能表结构变了（照跑，但请人工确认）");
  } else {
    console.log("从 reading.js 的人工表里认出 " + n + " 个词，一并排除");
  }
  return out;
}

/** 已经问过的词（产物文件），用来支持 --resume */
function doneWords() {
  if (!fs.existsSync(OUT)) return {};
  try {
    return require(OUT).words || {};
  } catch (e) {
    console.log("产物文件读不出来（可能写坏了），从头开始：" + e.message);
    return {};
  }
}

// ---------------------------------------------------------------- 问模型

function buildPrompt(words) {
  return (
    "你是日语歌词注音助手。下面这些拉丁字母词要唱进日语歌里，请给出日语里最自然的片假名读音。\n" +
    "要求：\n" +
    "1. 只写片假名（允许长音符 ー 和小写的 ャュョッ），不要汉字、不要平假名、不要英文、不要解释；\n" +
    "2. 用日语外来语的通行写法（love → ラブ、hello → ハロー、question → クエスチョン）；\n" +
    "3. 虚词按唱出来的音写（the → ザ、of → オブ、and → アンド）；\n" +
    "4. 严格输出一个 JSON 对象，键是原词（小写），值是片假名读音，不要多余字段。\n" +
    "词表：" +
    JSON.stringify(words)
  );
}

async function ask(words, key) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: buildPrompt(words) }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error("HTTP " + res.status + ": " + body.slice(0, 200));
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("响应里没有 content");
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("输出里没有 JSON 对象：" + content.slice(0, 120));
  return { obj: JSON.parse(m[0]), usage: data.usage || {} };
}

// ---------------------------------------------------------------- 校验

function validate(word, kana) {
  if (typeof kana !== "string") return "不是字符串";
  const k = kana.trim();
  if (!k) return "空";
  if (!RE_KANA.test(k)) return "含非片假名字符：" + k;
  if (k.length > 14) return "太长：" + k;
  // 单个假名的读音，多半是模型偷懒（"e" -> "エ" 其实可以，但 2 个字母以上的词给单假名通常不对）
  if (word.length >= 4 && k.length === 1) return "词长与读音长度不匹配：" + k;
  return null;
}

// ---------------------------------------------------------------- 产物

function writeOut(all, stats, meta) {
  const keys = Object.keys(all).sort();
  const lines = [];
  lines.push("/*");
  lines.push(" * 由 tools/expand-dict-llm.js 生成 —— **不要手改**（改这里会被下次生成覆盖）。");
  lines.push(" *");
  lines.push(" * 内容是大模型（" + meta.model + "）给出的英文词 -> 片假名读音，用于扩充离线词典。");
  lines.push(" * 只保留纯片假名的结果（含长音符），模型输出非法字符的一律丢弃。");
  lines.push(" * 人工核过的词在 tools/seed-words.js 里，优先级更高，这里不会再出现。");
  lines.push(" *");
  lines.push(" * 生成时间：" + meta.at + "　词表：词频前 " + meta.top + "　成功 " + keys.length + " 条");
  lines.push(" */");
  lines.push('"use strict";');
  lines.push("");
  lines.push("module.exports = {");
  lines.push("  words: {");
  for (const k of keys) lines.push("    " + JSON.stringify(k) + ": " + JSON.stringify(all[k]) + ",");
  lines.push("  },");
  lines.push("  stats: " + JSON.stringify(stats) + ",");
  lines.push("};");
  lines.push("");
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const top = parseInt(arg("--top", "3000"), 10);
  const key = process.env.DEEPSEEK_API_KEY || "";
  const hand = handWords();
  const handFromReading = handWordsFromReadingJs();

  const freq = await freqWords(top);
  const done = hasFlag("--resume") ? doneWords() : {};
  console.log("人工核过 " + Object.keys(hand).length + " 条，已生成 " + Object.keys(done).length + " 条");

  const todo = freq.filter(
    (w) => hand[w] === undefined && handFromReading[w] !== true && done[w] === undefined
  );
  console.log("要问的候选词：" + todo.length + " 个（词频前 " + top + " 去掉人工词与已有产物）");
  if (hasFlag("--dry-run")) {
    console.log(todo.slice(0, 40).join(", ") + " …");
    return;
  }
  if (!key) {
    console.error("没有 DEEPSEEK_API_KEY 环境变量，无法调用接口。");
    process.exit(1);
  }

  const all = Object.assign({}, done);
  const stats = { asked: 0, ok: 0, bad: 0, failed: 0, badSamples: [], retried: 0, promptTokens: 0, completionTokens: 0 };
  const t0 = Date.now();

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let got = {};
    try {
      const r = await ask(batch, key);
      got = r.obj;
      stats.promptTokens += (r.usage.prompt_tokens || 0);
      stats.completionTokens += (r.usage.completion_tokens || 0);
    } catch (e) {
      console.log("[" + (i + 1) + "] 请求失败，整批重试一次：" + e.message);
      try {
        const r2 = await ask(batch, key);
        got = r2.obj;
        stats.retried++;
      } catch (e2) {
        stats.failed += batch.length;
        console.log("[" + (i + 1) + "] 仍然失败，跳过这批：" + e2.message);
        continue;
      }
    }
    stats.asked += batch.length;
    let bad = 0;
    for (const w of batch) {
      const kana = got[w];
      const err = validate(w, kana);
      if (err) {
        bad++;
        stats.badSamples.push(w + " -> " + JSON.stringify(kana) + "（" + err + "）");
        continue;
      }
      all[w] = String(kana).trim();
      stats.ok++;
    }
    stats.bad += bad;
    writeOut(all, stats, { at: new Date().toISOString(), model: MODEL, top });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(
      "[" + Math.min(i + BATCH, todo.length) + "/" + todo.length + "] ok=" + stats.ok + " bad=" + bad +
        " 累计 " + secs + "s tokens=" + (stats.promptTokens + stats.completionTokens)
    );
  }

  writeOut(all, stats, { at: new Date().toISOString(), model: MODEL, top });
  console.log("\n完成：" + path.relative(ROOT, OUT) + "，成功 " + stats.ok + " 条，非法 " + stats.bad + " 条，" +
    "失败 " + stats.failed + " 条，重试 " + stats.retried + " 批");
  console.log("token 合计：" + (stats.promptTokens + stats.completionTokens) + "（输入 " + stats.promptTokens + " / 输出 " + stats.completionTokens + "）");
  if (stats.badSamples.length) {
    console.log("非法样本（最多 20 条）：");
    for (const s of stats.badSamples.slice(0, 20)) console.log("  " + s);
  }
}

main().catch((e) => {
  console.error("出错：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
