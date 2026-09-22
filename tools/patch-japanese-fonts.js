/*
 * 给 JapaneseFonts（MuttonString/Furigana，网易云插件「日文字体」）打共存补丁。
 *
 * 问题
 * ----
 * 它的 pronounce() 里用**整行 innerHTML 里有没有假名**判断"这是不是日文歌"：
 *
 *     if (elem.querySelector('furigana') || /[ぁ-ヿ]/g.test(elem.innerHTML)) {
 *
 * 而本插件（西文字母片假名注音）会把读音写成 <rt> 里的**片假名**插在歌词行上。
 * 于是：一首德语 / 拉丁语 / 俄语歌，只要本插件给它注了音，那一行 innerHTML 里
 * 就有了假名 —— JapaneseFonts 判定"这是日文歌"，把用户设的日文字体套上去
 * （用户报的：「不要让这个插件把本插件的片假名当成日文歌」）。
 *
 * 补丁
 * ----
 * 把那个判据换成"**剔掉别的插件插的注音之后**再看有没有假名"：
 *   - 认 kt-（片假名终结者）、lt-（本插件改名前的前缀）、wk-（本插件现在的前缀）；
 *   - 它自己的 <ruby>/<rt>（没有类名）照旧算数，所以真的日文歌不受影响。
 *
 * 用法
 * ----
 *   node tools/patch-japanese-fonts.js                 # 打补丁（默认目录）
 *   node tools/patch-japanese-fonts.js --dir <目录>
 *   node tools/patch-japanese-fonts.js --check         # 只看状态
 *   node tools/patch-japanese-fonts.js --revert        # 还原
 *
 * 注意：对方插件升级后补丁会丢，重跑一次即可。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MARK = "/* WK-COEXIST-PATCH-1 */";

/** 原文（必须逐字节一致） */
const ANCHOR_ORIG =
  "        if (elem.querySelector('furigana') || /[\u3041-\u30FF]/g.test(elem.innerHTML)) {";
/** 打补丁之后 */
const ANCHOR_NEW =
  "        if (elem.querySelector('furigana') || /[\u3041-\u30FF]/g.test(__wkPlainText(elem))) {";

/** 注入点：pronounce 函数定义之前 */
const INJECT_AT = "function pronounce(lyricElem) {";

const HELPER = `// ${MARK} 别的插件（西文字母片假名注音 / 片假名终结者）插的注音不算"歌词原文"。
// 判断节点是不是别家插的注音：认三家前缀 ——
//   kt-  片假名终结者（片假名 -> 英文）
//   lt-  西文字母片假名注音（改名前的前缀，老版本装的还是它）
//   wk-  西文字母片假名注音（现在的前缀）
function __wkIsAnnotation(node) {
    if (!node || node.nodeType !== 1) return false;
    const cls = typeof node.className === 'string' ? node.className : '';
    if (/(^|\\s)(kt|lt|wk)-(ruby|rt|ov-label)(\\s|$)/.test(cls)) return true;
    if (node.tagName === 'RT' && node.parentNode) {
        const pc = typeof node.parentNode.className === 'string' ? node.parentNode.className : '';
        if (/(^|\\s)(kt|lt|wk)-ruby(\\s|$)/.test(pc)) return true;
    }
    return false;
}

// 这一行"自己的"文字：跳过别家插的注音（连它们里面的底字一起跳过 ——
// 那些底字是拉丁/西里尔字母，本来就不该参与"有没有假名"的判断）。
function __wkPlainText(el) {
    let s = '';
    const walk = (n) => {
        for (const c of n.childNodes) {
            if (c.nodeType === 3) { s += c.nodeValue; continue; }
            if (c.nodeType !== 1) continue;
            if (c.tagName === 'FURIGANA') continue; // 对方插件自己的标记
            if (__wkIsAnnotation(c)) continue;
            walk(c);
        }
    };
    walk(el);
    return s;
}

`;

/** 打补丁：返回 { src, applied } 或 { error: [...] } */
function applyPatch(src) {
  const error = [];
  if (typeof src !== "string" || !src) return { error: ["源码是空的"] };
  if (src.indexOf(MARK) >= 0) return { error: ["已经打过补丁了"] };
  if (src.indexOf(ANCHOR_ORIG) < 0) error.push("找不到「日文歌判据」那一行（版本变了？）");
  if (src.indexOf(INJECT_AT) < 0) error.push("找不到 pronounce() 定义");
  if (error.length) return { error };

  let out = src.replace(ANCHOR_ORIG, ANCHOR_NEW);
  out = out.replace(INJECT_AT, HELPER + INJECT_AT);
  return { src: out, applied: ["isJapanese 判据改成 __wkPlainText(elem)", "注入 __wkIsAnnotation / __wkPlainText"] };
}

/** 还原 */
function revertPatch(src) {
  let out = src;
  const at = out.indexOf("// " + MARK);
  if (at >= 0) {
    const end = out.indexOf(INJECT_AT, at);
    if (end > at) out = out.slice(0, at) + out.slice(end);
  }
  out = out.replace(ANCHOR_NEW, ANCHOR_ORIG);
  return { src: out };
}

function isPatched(src) {
  return typeof src === "string" && src.indexOf(MARK) >= 0;
}

// ---------------------------------------------------------------- 主流程

const DEFAULT_DIR = "C:/betterncm/plugins_runtime/JapaneseFonts";

function main() {
  const args = process.argv.slice(2);
  const di = args.indexOf("--dir");
  const dir = di >= 0 && args[di + 1] ? args[di + 1] : DEFAULT_DIR;
  const file = path.join(dir, "main.js");
  if (!fs.existsSync(file)) {
    console.error("找不到 " + file);
    console.error("用 --dir 指定它的解包目录（一般是 C:\\betterncm\\plugins_runtime\\JapaneseFonts）");
    process.exit(1);
  }
  const src = fs.readFileSync(file, "utf8");

  if (args.includes("--check")) {
    console.log(file);
    console.log(isPatched(src) ? "已打补丁" : "未打补丁");
    return;
  }
  if (args.includes("--revert")) {
    const r = revertPatch(src);
    fs.writeFileSync(file, r.src);
    console.log("已还原：" + file);
    return;
  }
  if (isPatched(src) && !args.includes("--force")) {
    console.log("已经打过补丁了，无需重复。（要重打请加 --force）");
    return;
  }
  const base = isPatched(src) ? revertPatch(src).src : src;
  const r = applyPatch(base);
  if (r.error) {
    console.error("锚点没找到，可能对方插件版本变了：");
    for (const m of r.error) console.error("  - " + m);
    process.exit(2);
  }
  const vm = require("vm");
  try {
    new vm.Script(r.src, { filename: "JapaneseFonts/main.js" });
  } catch (e) {
    console.error("补丁后语法检查失败，已中止（未改动文件）：" + e.message);
    process.exit(3);
  }
  fs.writeFileSync(file, r.src);
  for (const a of r.applied) console.log("已应用：" + a);
  console.log("补丁完成：" + file);
}

if (require.main === module) main();
module.exports = { applyPatch, revertPatch, isPatched, MARK, ANCHOR_ORIG, ANCHOR_NEW, HELPER };
