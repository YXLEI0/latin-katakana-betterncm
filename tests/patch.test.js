/*
 * 共存补丁工具的自检。
 *
 * 补丁是打在别人的插件（jp-furigana）上的，锚点错了会直接中止（不写文件），
 * 但更容易出的问题是「jp-furigana 升级后锚点对不上，我们却不知道」——
 * 所以这里用一段照抄真实源码的样本固定住五处锚点，
 * 任何一处被改动都会在这里失败。
 *
 * 样本是自带的字符串，不读仓库外的任何文件：这个测试必须能在
 * 一台没装网易云、没有 jp-furigana 的机器上跑出确定结果。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { applyPatch, revertPatch, isPatched, isPatchedV1, MARK, MARK_V1 } = require("../tools/patch-jp-furigana.js");
const JF = require("../tools/patch-japanese-fonts.js");

/*
 * 样本：五处锚点原文必须逐字节一致。
 * 前三处来自 jp-furigana 1.1.0 / 1.0.2 的 main.js，第四处是 hostsText，第五处是 processLine。
 */
const FIXTURE = [
  "(() => {",
  "\tfunction restore(host) {",
  "\t\tconst wrap = host.__fgWrap;",
  "\t\tif (wrap && wrap.parentNode === host) {",
  "\t\t\twrap.remove();",
  "\t\t\t// 只有当 React 没有自己重建过内容时，才把原来的节点放回去",
  "\t\t\tif (!host.hasChildNodes() && host.__fgOrig && host.__fgOrig.length)",
  "\t\t\t\thost.append(...host.__fgOrig);",
  "\t\t}",
  "\t\thost.__fgWrap = null;",
  "\t}",
  "\tfunction hostsText(line) {",
  "\t\tlet out = '';",
  "\t\tfor (const h of line.__fgHosts || [])",
  "\t\t\tfor (const n of h.__fgOrig || []) out += n.textContent;",
  "\t\treturn out;",
  "\t}",
  "\tfunction isClean(line) {",
  "\t\tconst hosts = line.__fgHosts;",
  "\t\tfor (const h of hosts) {",
  "\t\t\tif (!h.isConnected) return false;",
  "\t\t\tif (h.childNodes.length !== 1) return false;",
  "\t\t}",
  "\t\treturn hostsText(line) === line.__fgText;",
  "\t}",
  "\tconst observer = new MutationObserver((records) => {",
  "\t\tlet relevant = false;",
  "\t\t\tfor (const r of records) {",
  "\t\t\t\t// 只关心文字和结构变化",
  "\t\t\t\tif (r.type !== 'characterData' && r.type !== 'childList') continue;",
  "\t\t\t\trelevant = true;",
  "\t\t\t}",
  "\t});",
  "\tfunction processLine(line) {",
  "\t\tline.__fgText = text;",
  "\t\tline.__fgHosts = hosts;",
  "\t\tline.__fgMirrors = mirrors;",
  "\t\treturn true;",
  "\t}",
  "})();",
  "",
].join("\n");

/** 五处锚点 —— 少一处就说明补丁会打不全 */
const ANCHORS = [
  "if (h.childNodes.length !== 1) return false;",
  "wrap.remove();",
  "if (r.type !== 'characterData' && r.type !== 'childList') continue;",
  "for (const n of h.__fgOrig || []) out += n.textContent;",
  "line.__fgMirrors = mirrors;",
];

/**
 * 「装上的是旧版 v1 补丁」的样本：由 v2 打过补丁的样本反推出来
 * （类名枚举退回两家、标记位退回两家、标记换成 v1）。
 * 真机上 v1 的注释文案和 v2 不同，但升级路径只认类名枚举和标记，这两样一致。
 */
const FIXTURE_PATCHED_V1 = (() => {
  let s = applyPatch(FIXTURE).src;
  s = s
    .split("(kt-ruby|kt-rt|kt-ov-label|lt-ruby|lt-rt|lt-ov-label|wk-ruby|wk-rt|wk-ov-label)")
    .join("(kt-ruby|kt-rt|kt-ov-label|lt-ruby|lt-rt|lt-ov-label)");
  s = s.split("(kt-ruby|lt-ruby|wk-ruby)").join("(kt-ruby|lt-ruby)");
  s = s.split("(n.__ktOwned || n.__ltOwned || n.__wkOwned)").join("(n.__ktOwned || n.__ltOwned)");
  s = s.split(MARK).join(MARK_V1);
  return s;
})();

test("五处锚点在样本里都能找到", () => {
  for (const a of ANCHORS) {
    assert.ok(FIXTURE.indexOf(a) >= 0, "样本缺少锚点（补丁会打不上）：" + a);
  }
});

test("五处补丁全部应用，且结果语法正确、锚点不再残留", () => {
  const r = applyPatch(FIXTURE);
  assert.strictEqual(r.error, undefined, "不该有锚点缺失：" + JSON.stringify(r.error));
  assert.strictEqual(r.applied.length, 5, "应该应用 5 处：" + JSON.stringify(r.applied));
  assert.ok(isPatched(r.src));
  // 打完补丁的代码必须是合法 JS —— 打坏别人的插件是最坏的结果
  assert.doesNotThrow(() => new vm.Script(r.src), "补丁后的代码语法必须正确");
  // 被整段替换掉的两处原文不该再出现
  // （另三处是"原地加一句"，原文本来就要留着，见下面的断言）
  for (const gone of [
    "if (h.childNodes.length !== 1) return false;",
    "for (const n of h.__fgOrig || []) out += n.textContent;",
  ]) {
    assert.strictEqual(r.src.indexOf(gone), -1, "打完补丁后不该还留着原文：" + gone);
  }
  // 原地插入：原文要留着，同时多出我们的那几行
  assert.ok(r.src.indexOf("if (__ktRecordIsOurs(r)) continue;") > 0, "observer 该忽略我们的变更");
  assert.ok(r.src.indexOf("host.__ktForeign = __ktNodes;") > 0, "restore 该暂存外来注音");
  assert.ok(r.src.indexOf("window.__ktRepairLine(line);") > 0, "重建完该同步叫我们补注音");
  // 我们的实现细节要在里面
  assert.ok(r.src.indexOf("__ktIsForeign") > 0, "应该注入 helper");
  assert.ok(r.src.indexOf("__ktRecordIsOurs") > 0, "应该注入 helper");
  assert.ok(r.src.indexOf("__ktOwnChildCount(h) !== 1") > 0, "isClean 应该换成忽略外来节点的计数");
  assert.ok(r.src.indexOf("out += plainText(n);") > 0, "hostsText 应该走 plainText 分支");
});

/*
 * 下面这一组是本项目独有的回归点：补丁的识别范围必须覆盖「三家」。
 *
 * 同一行上可能同时开着片假名终结者（kt-*）和本插件（改名前 lt-*、现在 wk-*）。
 * 补丁只认其中一家时，另一家的注音会让 jp-furigana 把行判脏并重建，
 * 于是那一家无限闪 —— 而且"只有它一家闪"，从现象几乎查不到原因。
 * 所以这里不只断言"helper 存在"，而是把三家的类名和标记位逐个钉死。
 */
test("外来节点判定同时认出三家插件（kt-* / lt-* / wk-*，含 ov-label 变体）", () => {
  const src = applyPatch(FIXTURE).src;
  // 抠出 helper 里的类名判定源码，避免"别处碰巧出现过 kt-ruby"这种假通过
  const m = /const cls = typeof node\.className[^\n]*\n[^\n]*/.exec(src);
  assert.ok(m, "helper 里应该有外来节点类名判定");
  const clsTest = m[0];

  const families = ["kt-ruby", "kt-rt", "lt-ruby", "lt-rt", "wk-ruby", "wk-rt"];
  const labelVariants = ["kt-ov-label", "lt-ov-label", "wk-ov-label"];
  for (const name of families.concat(labelVariants)) {
    assert.ok(clsTest.indexOf(name) >= 0, `外来类名判定缺少 ${name}（那一家会开始闪）`);
  }
  // <rt> 的父节点判定也要认三家：降级渲染时 rt 的父级不是 ruby 而是这三家的包裹元素
  const rtParent = /node\.tagName === 'RT'[\s\S]{0,240}?kt-ruby\|lt-ruby\|wk-ruby/.exec(src);
  assert.ok(rtParent, "rt 父节点判定应该同时认 kt-ruby / lt-ruby / wk-ruby");

  // 真正跑一遍逻辑：三家各造一个节点，都必须被判成"外来"
  const isForeign = loadHelper(src, "__ktIsForeign");
  const nodes = [
    { nodeType: 1, className: "kt-ruby", tagName: "RUBY" },
    { nodeType: 1, className: "kt-rt", tagName: "RT" },
    { nodeType: 1, className: "kt-ov-label", tagName: "SPAN" },
    { nodeType: 1, className: "lt-ruby", tagName: "RUBY" },
    { nodeType: 1, className: "lt-rt", tagName: "RT" },
    { nodeType: 1, className: "lt-ov-label", tagName: "SPAN" },
    { nodeType: 1, className: "wk-ruby", tagName: "RUBY" },
    { nodeType: 1, className: "wk-rt", tagName: "RT" },
    { nodeType: 1, className: "wk-ov-label", tagName: "SPAN" },
  ];
  for (const n of nodes) {
    assert.strictEqual(isForeign(n), true, `应该认出外来节点：${n.className}`);
  }
  // 我们自己的 ruby 前后带别的类名时也要认（class 列表是空白分隔的）
  assert.strictEqual(isForeign({ nodeType: 1, className: "foo wk-ruby bar", tagName: "RUBY" }), true);
  // 反向：jp-furigana 自己的节点不能被误判成外来，否则它会把自己的 wrap 数漏
  assert.strictEqual(isForeign({ nodeType: 1, className: "__fgWrap", tagName: "SPAN" }), false);
  assert.strictEqual(isForeign({ nodeType: 1, className: "", tagName: "DIV" }), false);
  assert.strictEqual(isForeign({ nodeType: 3, className: "", tagName: undefined }), false);
});

test("__ktTextIsOurs 同时接受三家的标记位（__ktOwned / __ltOwned / __wkOwned）", () => {
  const src = applyPatch(FIXTURE).src;
  const m = /function __ktTextIsOurs\(n\) \{[\s\S]*?\n\t\}/.exec(src);
  assert.ok(m, "helper 里应该有 __ktTextIsOurs");
  const body = m[0];
  assert.ok(/n\.__ktOwned/.test(body), "__ktTextIsOurs 必须接受片假名终结者的 __ktOwned 标记");
  assert.ok(/n\.__ltOwned/.test(body), "__ktTextIsOurs 必须接受本插件改名前的 __ltOwned 标记");
  assert.ok(/n\.__wkOwned/.test(body), "__ktTextIsOurs 必须接受本插件现在的 __wkOwned 标记");
  assert.ok(/nodeType === 3/.test(body), "__ktTextIsOurs 只该认同文本节点");

  const isOurs = loadHelper(src, "__ktTextIsOurs");
  const text = (expando) => {
    const n = { nodeType: 3 };
    if (expando) n[expando] = true;
    return n;
  };
  assert.strictEqual(isOurs(text("__ktOwned")), true, "片假名终结者改写的文本节点该算我们的");
  assert.strictEqual(isOurs(text("__ltOwned")), true, "本插件改名前的标记位该算我们的");
  assert.strictEqual(isOurs(text("__wkOwned")), true, "本插件现在的标记位该算我们的");
  assert.strictEqual(isOurs(text(null)), false, "没被标记的文本节点不是我们的");
  assert.strictEqual(isOurs(null), false, "空值不能抛异常");
  // 元素节点即使有标记位也不算（它走 __ktIsForeign 那条路）
  assert.strictEqual(isOurs({ nodeType: 1, __wkOwned: true }), false);
});

test("装上的是旧版 v1 补丁时：applyPatch 就地升级成 v2（加上 wk- 前缀）", () => {
  // 真实场景：用户的 jp-furigana 早先被 v1 补丁打过（只认 kt- / lt-），
  // 现在插件把 DOM 前缀换成了 wk-，那份 v1 补丁会让我们的注音被判脏 → 一直闪。
  // 所以不能只报"已打补丁"，必须在原地上把类名枚举升级掉。
  const v1 = FIXTURE_PATCHED_V1;
  assert.strictEqual(isPatched(v1), false, "v1 不算当前版本");
  assert.strictEqual(isPatchedV1(v1), true, "要能认出 v1");

  const r = applyPatch(v1);
  assert.ok(r.upgraded, "应该走升级路径：" + JSON.stringify(r));
  assert.strictEqual(isPatched(r.src), true, "升级后要带上 v2 标记");
  assert.strictEqual(isPatchedV1(r.src), false, "v1 标记不能再留着");
  assert.ok(r.src.indexOf("wk-ruby") >= 0, "升级后要认 wk-ruby");
  assert.ok(r.src.indexOf("__wkOwned") >= 0, "升级后要认 __wkOwned");
  assert.ok(r.src.indexOf("lt-ruby") >= 0 && r.src.indexOf("kt-ruby") >= 0, "老两家不能丢");
  // 升级是幂等的：再来一次就是 v2 了
  const again = applyPatch(r.src);
  assert.strictEqual(again.already, true);
  assert.strictEqual(again.src, r.src);
});

test("重复打补丁是幂等的（不会打两遍）", () => {
  const once = applyPatch(FIXTURE).src;
  const twice = applyPatch(once);
  assert.strictEqual(twice.already, true, "第二次应该识别出已打补丁");
  assert.strictEqual(twice.src, once, "已打补丁的内容不该被改动");
});

test("revertPatch 能逐字节还原（含 helper 块）", () => {
  const applied = applyPatch(FIXTURE).src;
  const back = revertPatch(applied, FIXTURE);
  assert.strictEqual(back.exact, true, "给了原文就应该逐字节还原");
  assert.strictEqual(back.src, FIXTURE, "还原结果必须与原文完全一致");
  assert.strictEqual(isPatched(back.src), false, "还原后不该还有补丁标记");
  assert.strictEqual(back.src.indexOf("__ktIsForeign"), -1, "helper 必须被完整摘掉");
});

test("锚点缺失时中止，不改内容也不抛异常", () => {
  const broken = FIXTURE.replace("for (const n of h.__fgOrig || []) out += n.textContent;", "for (const n of h.__fgOrig || []) out += n.innerText;");
  const r = applyPatch(broken);
  assert.ok(Array.isArray(r.error) && r.error.length === 1, "应该只报缺的那一处：" + JSON.stringify(r.error));
  assert.strictEqual(r.src, broken, "有锚点缺失时不能改动源码");
});

/**
 * 从打完补丁的源码里取出某个 helper 函数并真的执行它。
 *
 * 直接把整段打补丁后的样本丢进 vm 是跑不了的：样本里的 MutationObserver、
 * document 之类都要真实浏览器环境。所以只把 helper 块切出来编译，
 * 用一个假的 window 顶层变量喂进去 —— 这样测的是补丁真正写进去的那份代码，
 * 而不是测试里另抄一份实现（抄一份的话，实现改了测试还是绿的）。
 */
function loadHelper(patchedSrc, fnName) {
  const from = patchedSrc.indexOf("function __ktIsForeign");
  const to = patchedSrc.indexOf("function __ktRecordIsOurs");
  assert.ok(from > 0 && to > from, "helper 块没找到（补丁结构变了？）");
  const helper = patchedSrc.slice(from, to);
  assert.ok(helper.indexOf("function " + fnName) >= 0, `helper 块里应该有 ${fnName}`);
  // 沙箱的全局对象就是 vm 的上下文对象本身，取回来即可
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(helper + `\n;this.__pick = ${fnName};`, sandbox);
  const fn = sandbox.__pick;
  assert.strictEqual(typeof fn, "function", `${fnName} 应该能编译成函数`);
  return fn;
}

test("MARK 是补丁的唯一判据，且不会误伤正常源码", () => {
  assert.strictEqual(typeof MARK, "string");
  assert.ok(MARK.length > 0);
  assert.strictEqual(isPatched(FIXTURE), false, "原始源码不该被判成已打补丁");
  assert.strictEqual(isPatched(FIXTURE + MARK), true);
});

// ============================================================ JapaneseFonts 补丁

/*
 * 样本：照抄 JapaneseFonts 1.0.3（MuttonString/Furigana）main.js 的 pronounce()。
 * 它用"整行 innerHTML 里有没有假名"判断这是不是日文歌 —— 我们的片假名注音就在
 * innerHTML 里，于是外语歌也被当成日文歌（用户报的那条）。
 */
const JF_FIXTURE = [
  "/**",
  " * 给歌词注音",
  " * @param {Element[]} lyricElem 多句歌词的DOM元素",
  " */",
  "function pronounce(lyricElem) {",
  "    // const markStr = '<furigana></furigana>';",
  "",
  "    // 判断该歌是否为日文歌",
  "    let isJapanese = false;",
  "    for (const elem of lyricElem) {",
  "        if (elem.querySelector('furigana') || /[ぁ-ヿ]/g.test(elem.innerHTML)) {",
  "            isJapanese = true;",
  "            break;",
  "        }",
  "    }",
  "",
  "    if (isJapanese) {",
  "        if (config['use_jpn_font'] && !head.querySelector('#furigana-font')) {",
  "            const style = document.createElement('style');",
  "            style.id = 'furigana-font';",
  "            head.appendChild(style);",
  "        }",
  "    } else {",
  "        const style = head.querySelector('#furigana-font');",
  "        if (style) head.removeChild(style);",
  "        return;",
  "    }",
  "}",
].join("\n");

test("JapaneseFonts：补丁把「整行有没有假名」换成「剔掉别家注音再看」", () => {
  const r = JF.applyPatch(JF_FIXTURE);
  assert.ok(!r.error, "应该能打上：" + JSON.stringify(r.error));
  assert.ok(r.src.indexOf(JF.ANCHOR_NEW) > 0, "判据要换成 __wkPlainText(elem)");
  assert.strictEqual(r.src.indexOf(JF.ANCHOR_ORIG), -1, "老判据不该还在");
  assert.strictEqual(JF.isPatched(r.src), true);
  // 补丁后仍要是合法 JS（不能把别人的插件弄坏）
  new vm.Script(r.src, { filename: "JapaneseFonts/main.js" });
  // 幂等 / 还原
  assert.ok(JF.applyPatch(r.src).error, "重复打补丁应当被拒");
  assert.strictEqual(JF.revertPatch(r.src).src, JF_FIXTURE, "还原要逐字节回到原样");
});

test("JapaneseFonts：补丁后的判据不再把我们的片假名当成日文歌", () => {
  /*
   * 真的把那两个 helper 拿出来跑（不是另抄一份实现）：样本是外语行 + 我们的 ruby，
   * 以及一行真日语（对方插件自己的 ruby 没有类名，必须照旧算数）。
   */
  const sandbox = { document: new JSDOM("<!doctype html><body></body></html>").window.document };
  vm.createContext(sandbox);
  vm.runInContext(JF.HELPER + "\n;this.__plain = __wkPlainText;", sandbox);
  const plain = sandbox.__plain;
  assert.strictEqual(typeof plain, "function");

  const dom = new JSDOM(`<!doctype html><body>
    <ul>
      <li id="de">Ich <ruby class="wk-ruby">liebe<rt class="wk-rt">リーベ</rt></ruby> dich</li>
      <li id="lat">Vindicia <ruby class="lt-ruby">dolor<rt class="lt-rt">ドロル</rt></ruby></li>
      <li id="jp">今日は<ruby>歌<rt>うた</rt></ruby>う</li>
      <li id="kt">Hello <ruby class="kt-ruby">world<rt class="kt-rt">ワールド</rt></ruby></li>
    </ul></body>`);
  const doc = dom.window.document;
  const hasKana = (id) => /[ぁ-ヿ]/.test(plain(doc.getElementById(id)));

  // 外语行 + 我们的注音：判据必须看不到假名（否则会被当成日文歌套日文字体）
  assert.strictEqual(hasKana("de"), false, "德文行 + wk-ruby：" + plain(doc.getElementById("de")));
  assert.strictEqual(hasKana("lat"), false, "拉丁文行 + lt-ruby（改名前的前缀）");
  assert.strictEqual(hasKana("kt"), false, "片假名终结者的 kt-ruby");
  // 反面：真的日文歌照旧认得出来（对方插件自己的 ruby 没有类名）
  assert.strictEqual(hasKana("jp"), true, "日文行不能被误伤");
  // 而且 innerHTML 里确实还留着假名（证明测的是补丁后的判据，不是"注音没插进去"）
  assert.ok(/[ぁ-ヿ]/.test(doc.getElementById("de").innerHTML));
});
