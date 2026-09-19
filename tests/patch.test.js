/*
 * 共存补丁工具的自检。
 *
 * 补丁是打在**别人的插件**（jp-furigana）上的，锚点错了会直接中止（不写文件），
 * 但更容易出的问题是「jp-furigana 升级后锚点对不上，我们却不知道」——
 * 所以这里用一段**照抄真实源码**的样本固定住五处锚点，
 * 任何一处被改动都会在这里失败。
 *
 * 样本是自带的字符串，不读仓库外的任何文件：这个测试必须能在
 * 一台没装网易云、没有 jp-furigana 的机器上跑出确定结果。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { applyPatch, revertPatch, isPatched, MARK } = require("../tools/patch-jp-furigana.js");

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
 * 下面这一组是本项目**独有的**回归点：补丁的识别范围必须覆盖「两家」。
 *
 * 同一行上可能同时开着片假名终结者（kt-*）和本插件（lt-*）。
 * 补丁只认其中一家时，另一家的注音会让 jp-furigana 把行判脏并重建，
 * 于是那一家无限闪 —— 而且"只有它一家闪"，从现象几乎查不到原因。
 * 所以这里不只断言"helper 存在"，而是把两家的类名和两个标记位逐个钉死。
 */
test("外来节点判定同时认出两家插件（kt-* 与 lt-*，含 ov-label 变体）", () => {
  const src = applyPatch(FIXTURE).src;
  // 抠出 helper 里的类名判定源码，避免"别处碰巧出现过 kt-ruby"这种假通过
  const m = /const cls = typeof node\.className[^\n]*\n[^\n]*/.exec(src);
  assert.ok(m, "helper 里应该有外来节点类名判定");
  const clsTest = m[0];

  const families = ["kt-ruby", "kt-rt", "lt-ruby", "lt-rt"];
  const labelVariants = ["kt-ov-label", "lt-ov-label"];
  for (const name of families.concat(labelVariants)) {
    assert.ok(clsTest.indexOf(name) >= 0, `外来类名判定缺少 ${name}（那一家会开始闪）`);
  }
  // <rt> 的父节点判定也要认两家：降级渲染时 rt 的父级不是 ruby 而是这两家的包裹元素
  const rtParent = /node\.tagName === 'RT'[\s\S]{0,240}?kt-ruby\|lt-ruby/.exec(src);
  assert.ok(rtParent, "rt 父节点判定应该同时认 kt-ruby 和 lt-ruby");

  // 真正跑一遍逻辑：两家各造一个节点，都必须被判成"外来"
  const isForeign = loadHelper(src, "__ktIsForeign");
  const nodes = [
    { nodeType: 1, className: "kt-ruby", tagName: "RUBY" },
    { nodeType: 1, className: "kt-rt", tagName: "RT" },
    { nodeType: 1, className: "kt-ov-label", tagName: "SPAN" },
    { nodeType: 1, className: "lt-ruby", tagName: "RUBY" },
    { nodeType: 1, className: "lt-rt", tagName: "RT" },
    { nodeType: 1, className: "lt-ov-label", tagName: "SPAN" },
  ];
  for (const n of nodes) {
    assert.strictEqual(isForeign(n), true, `应该认出外来节点：${n.className}`);
  }
  // 我们自己的 ruby 前后带别的类名时也要认（class 列表是空白分隔的）
  assert.strictEqual(isForeign({ nodeType: 1, className: "foo lt-ruby bar", tagName: "RUBY" }), true);
  // 反向：jp-furigana 自己的节点不能被误判成外来，否则它会把自己的 wrap 数漏
  assert.strictEqual(isForeign({ nodeType: 1, className: "__fgWrap", tagName: "SPAN" }), false);
  assert.strictEqual(isForeign({ nodeType: 1, className: "", tagName: "DIV" }), false);
  assert.strictEqual(isForeign({ nodeType: 3, className: "", tagName: undefined }), false);
});

test("__ktTextIsOurs 同时接受两家的标记位（__ktOwned / __ltOwned）", () => {
  const src = applyPatch(FIXTURE).src;
  const m = /function __ktTextIsOurs\(n\) \{[\s\S]*?\n\t\}/.exec(src);
  assert.ok(m, "helper 里应该有 __ktTextIsOurs");
  const body = m[0];
  assert.ok(/n\.__ktOwned/.test(body), "__ktTextIsOurs 必须接受片假名终结者的 __ktOwned 标记");
  assert.ok(/n\.__ltOwned/.test(body), "__ktTextIsOurs 必须接受本插件的 __ltOwned 标记");
  assert.ok(/nodeType === 3/.test(body), "__ktTextIsOurs 只该认同文本节点");

  const isOurs = loadHelper(src, "__ktTextIsOurs");
  const text = (expando) => {
    const n = { nodeType: 3 };
    if (expando) n[expando] = true;
    return n;
  };
  assert.strictEqual(isOurs(text("__ktOwned")), true, "片假名终结者改写的文本节点该算我们的");
  assert.strictEqual(isOurs(text("__ltOwned")), true, "本插件改写的文本节点该算我们的");
  assert.strictEqual(isOurs(text(null)), false, "没被标记的文本节点不是我们的");
  assert.strictEqual(isOurs(null), false, "空值不能抛异常");
  // 元素节点即使有标记位也不算（它走 __ktIsForeign 那条路）
  assert.strictEqual(isOurs({ nodeType: 1, __ltOwned: true }), false);
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
 * 用一个假的 window 顶层变量喂进去 —— 这样测的是**补丁真正写进去的那份代码**，
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
