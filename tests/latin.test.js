/*
 * 拉丁词扫描器（core/latin.js）的单元测试。
 *
 * 这个模块只干一件事：在一片文本里找出"值得标读音"的拉丁词，并给出位置。
 * 位置必须准 —— 注入时靠它把原文本切成 前段/词/后段，错一个字符底字就错了。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const latin = require("../src/core/latin.js");

test("hasLatin：只认拉丁字母", () => {
  assert.strictEqual(latin.hasLatin("clover"), true);
  assert.strictEqual(latin.hasLatin("コーヒー"), false);
  assert.strictEqual(latin.hasLatin("きらめく light"), true);
  assert.strictEqual(latin.hasLatin(""), false);
  assert.strictEqual(latin.hasLatin(null), false);
});

test("scan：切出每个词和它的位置", () => {
  const src = "きらめく light と clover。";
  const toks = latin.scan(src);
  assert.strictEqual(toks.length, 2);
  // 位置必须能用来切原文：切出来的正好是那个词
  assert.strictEqual(src.slice(toks[0].start, toks[0].end), "light");
  assert.strictEqual(src.slice(toks[1].start, toks[1].end), "clover");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["light", "clover"]
  );
  // 顺手核一次下标本身（数错了注入时底字就会错位）
  assert.strictEqual(toks[0].start, src.indexOf("light"));
  assert.strictEqual(toks[1].start, src.indexOf("clover"));
});

test("scan：撇号和连字符要留在词里（don't / e-mail）", () => {
  const toks = latin.scan("don't send e-mail");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["don't", "send", "e-mail"]
  );
  // 全角撇号也认（歌词里两种都有）
  assert.deepStrictEqual(
    latin.scan("don\u2019t").map((t) => t.text),
    ["don\u2019t"]
  );
});

test("scan：词内部的 norm 去掉撇号连字符并小写", () => {
  const toks = latin.scan("Don't E-Mail");
  assert.deepStrictEqual(
    toks.map((t) => t.norm),
    ["dont", "email"]
  );
});

test("scan：连字符在词尾时不算进词里（light- 应切成 light）", () => {
  const toks = latin.scan("light-");
  assert.strictEqual(toks.length, 1);
  assert.strictEqual(toks[0].text, "light");
});

test("scan：没有拉丁字母时返回空数组", () => {
  assert.deepStrictEqual(latin.scan("きらめく"), []);
  assert.deepStrictEqual(latin.scan(""), []);
  assert.deepStrictEqual(latin.scan(null), []);
});

test("scan：连续多个词、以及换行分隔", () => {
  const toks = latin.scan("light\nclover dream");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["light", "clover", "dream"]
  );
});

test("scan：不会因为零宽匹配卡死（正则改坏时的保护）", () => {
  // 只要能在合理时间内返回就算过；这里主要是防止以后改正则引入死循环
  const toks = latin.scan("a".repeat(2000));
  assert.ok(toks.length >= 1);
});

test("looksReadable：单字母默认不标，但 a / I 是真词要标", () => {
  // 用户报的：`Tell me a story` 里那个 a 不注音。
  // 单字母默认跳过（首字母缩写、排版噪声），可 `a` 和 `I` 是真正的英文单词，
  // 在 J-pop 歌词里满地都是，漏掉它们比标错更显眼。
  const toks = latin.scan("Tell me a story I love you x b");
  const by = {};
  for (const t of toks) by[t.text] = latin.looksReadable(t);
  assert.strictEqual(by["a"], true, "a 是英文单词，要标（ア）");
  assert.strictEqual(by["I"], true, "I 是英文单词，要标（アイ）");
  assert.strictEqual(by["x"], false, "其它单字母仍然不标");
  assert.strictEqual(by["b"], false, "其它单字母仍然不标");
  assert.strictEqual(by["Tell"], true);
  assert.strictEqual(by["me"], true);
  assert.strictEqual(by["story"], true);
  assert.strictEqual(by["love"], true);
  assert.strictEqual(by["you"], true);
});

test("记号整体算一个词：D/N/A / N/A / A.B.C / R&B / X-Y", () => {
  // 用户报的：`だって D/N/Aじゃ 騙れない`。记号不该被切成三个单字母，
  // 而是整体逐字母读（reading.js 的 notationToKatakana）。
  const cases = [
    ["D/N/A", "d/n/a"],
    ["N/A", "n/a"],
    ["A.B.C", "a.b.c"],
    ["R&B", "r&b"],
    ["X-Y", "xy"], // 连字符会在 normalize 里被吃掉 —— 所以读音层要拿**原始写法**
  ];
  for (const [raw, norm] of cases) {
    const toks = latin.scan(raw);
    assert.strictEqual(toks.length, 1, raw + " 应该是一个词，实际 " + toks.length + " 个");
    assert.strictEqual(toks[0].text, raw);
    assert.strictEqual(toks[0].notation, true, raw + " 应该被标成记号");
    assert.strictEqual(latin.looksReadable(toks[0]), true, raw + " 要标（逐字母读音）");
    if (norm) assert.strictEqual(toks[0].norm, norm);
  }
  // 反例：连字符词的每段不止一个字母，就不是记号，按普通词读
  const mail = latin.scan("e-mail")[0];
  assert.strictEqual(mail.notation, false, "e-mail 是普通词");
  const xray = latin.scan("X-ray")[0];
  assert.strictEqual(xray.notation, false, "X-ray 是普通词（不能逐字母念）");
  assert.strictEqual(xray.text, "X-ray");
});

test("带变音符号的拉丁字母要能扫到，不能把词切成两半", () => {
  // 用户报的：`Ō` 等没注音上。ASCII 正则的后果不只是漏标 —— `Tōkyō` 会被切成
  // `T` + `ky`，而 `ky` 单独命中词典读成 ケーワイ，比不标还糟。
  const cases = [
    ["Ō", ["Ō"]],
    ["Tōkyō", ["Tōkyō"]],
    ["kōhī", ["kōhī"]],
    ["arigatō", ["arigatō"]],
    ["Ōkami", ["Ōkami"]],
    ["Café", ["Café"]],
    ["déjà vu", ["déjà", "vu"]],
  ];
  for (const [line, want] of cases) {
    const got = latin.scan(line).map((t) => t.text);
    assert.deepStrictEqual(got, want, JSON.stringify(line));
  }
  // 单个带符号的字母（Ō）要标；粘着分隔符的照样不标
  const o = latin.scan("Ō")[0];
  assert.strictEqual(o.diacritic, true);
  assert.strictEqual(latin.looksReadable(o), true, "Ō 是罗马音里的长音，要标");
  assert.strictEqual(latin.hasLatin("Ō"), true, "hasLatin 也要认带符号的字母");
  assert.strictEqual(latin.looksReadable(latin.scan("&Ō&")[0]), false, "粘着分隔符的仍然不标");
});

test("粘在分隔符上的单字母不算词（D/N/A 里的 A 被注成 ア 是错的）", () => {
  // 用户报的：`だって D/N/Aじゃ 騙れない` 里那个 A 被注音了。
  // 它是标题记号的零件，不是英文冠词。
  const glued = ["だって D/N/Aじゃ 騙れない", "N/A", "A.B.C", "X-Y", "&A&"];
  for (const line of glued) {
    for (const tk of latin.scan(line)) {
      if (tk.text.length === 1) {
        assert.strictEqual(latin.looksReadable(tk), false, JSON.stringify(line) + " 里的 " + tk.text + " 不该标");
      }
    }
  }
  // 反过来：不粘分隔符的冠词/代词照旧要标
  const free = latin.scan("A story");
  assert.strictEqual(free[0].text, "A");
  assert.strictEqual(latin.looksReadable(free[0]), true, "句首的 A 是冠词，要标");
  const iTok = latin.scan("I love you")[0];
  assert.strictEqual(latin.looksReadable(iTok), true, "I 是代词，要标");
});

test("重复字母：全大写 2~3 个当缩写标，小写/长串留白", () => {
  // 来龙去脉：先是用户报 `“XX”` 被读成 エックスエックス（打码不该念），
  // 于是这类一律留白；后来用户又报 `合言葉は「YY」` —— 那个 YY 是缩写，要标。
  // 两者拼写一模一样，本地分不出来，用户选择"标"，于是：
  //   全大写 2~3 个 -> 标（YY ワイワイ、XX エックスエックス）
  //   小写 / 4 个以上 -> 留白（xx 打码、XXXX 噪声）
  for (const raw of ["YY", "XX", "XXX"]) {
    assert.strictEqual(latin.looksReadable(latin.scan(raw)[0]), true, raw + " 要标（按字母名）");
  }
  for (const raw of ["xx", "zzz", "XXXX", "yyy"]) {
    assert.strictEqual(latin.looksReadable(latin.scan(raw)[0]), false, raw + " 留白");
  }
  // 元音串照旧要标：AAAAA / OOO 是喊叫/拖长音，按那个元音叠出来
  for (const raw of ["AA", "aaa", "AAAAA", "OOO", "oo"]) {
    const tk = latin.scan(raw)[0];
    assert.strictEqual(latin.looksReadable(tk), true, raw + " 是喊叫/长音，要标");
  }
  // 反例：不同字母的缩写照旧逐字母读 —— 边界要正好落在"重复"上
  for (const raw of ["LDK", "TV", "MC", "DJ"]) {
    const tk = latin.scan(raw)[0];
    assert.strictEqual(latin.looksReadable(tk), true, raw + " 是真实缩写，要标");
  }
  // 记号优先：`X-X` / `A-A` 是记号（エックスワイ / エーエー），不能被这一刀误伤
  for (const raw of ["X-X", "A-A"]) {
    const tk = latin.scan(raw)[0];
    assert.strictEqual(tk.notation, true, raw + " 是记号");
    assert.strictEqual(latin.looksReadable(tk), true, raw + " 是记号，要标");
  }
});

test("大写单字母放行给读音层判，小写单字母仍只放 a / I", () => {
  // `(A, B)` 里的 A / B 要读字母名（エー / ビー），但 `A story` 的 A 是冠词（ア）——
  // 光看这个词分不出来，所以 matcher 放行，由 main.js 按整行判。
  assert.strictEqual(latin.looksReadable(latin.scan("B")[0]), true, "大写 B 放行（可能是字母名）");
  assert.strictEqual(latin.looksReadable(latin.scan("A")[0]), true, "大写 A 放行（冠词或字母名）");
  assert.strictEqual(latin.looksReadable(latin.scan("b")[0]), false, "小写 b 仍然不标");
  assert.strictEqual(latin.looksReadable(latin.scan("x")[0]), false, "小写 x 仍然不标");
  assert.strictEqual(latin.looksReadable(latin.scan("A.")[0]), false, "粘着标点的 A 还是不标");
});

test("波浪号是词内连接符：`feel~ing` 是一个词（norm=feeling）", () => {
  // 用户截图：`この feel~ing go~od` 原来按波浪号切成了 feel + ing / go + od，
  // 读出来是 フィールイング、ゴーオッド。波浪号是拉长音的排版写法，
  // 该按词内连接符处理（和连字符一样）。
  const cases = [
    ["feel~ing", "feel~ing", "feeling"],
    ["go~od", "go~od", "good"],
    ["feel～ing", "feel～ing", "feeling"], // 全角 ～
    ["feel〜ing", "feel〜ing", "feeling"], // 波ダッシュ 〜
  ];
  for (const [src, text, norm] of cases) {
    const toks = latin.scan(src);
    assert.strictEqual(toks.length, 1, src + " 应该是一个词：" + JSON.stringify(toks.map((t) => t.text)));
    assert.strictEqual(toks[0].text, text);
    assert.strictEqual(toks[0].norm, norm, src + " 查表用的形式要去掉波浪号");
  }
  // 结尾的波浪号不算连接符（后面没有字母）：`go~` / `love~` 还是原来的词
  assert.deepStrictEqual(latin.scan("go~ の love~").map((t) => t.text), ["go", "love"]);
  assert.deepStrictEqual(latin.scan("~go").map((t) => t.text), ["go"]);
});

test("hasReadable：整段里有没有值得标的词", () => {
  assert.strictEqual(latin.hasReadable("きらめく light"), true);
  assert.strictEqual(latin.hasReadable("x y z"), false, "只有不标的单字母就不值得处理");
  assert.strictEqual(latin.hasReadable("a"), true, "只有 a 也要处理（它是单词）");
  assert.strictEqual(latin.hasReadable("きらめく"), false);
});

test("normalize：小写化并去掉撇号连字符", () => {
  assert.strictEqual(latin.normalize("Clover"), "clover");
  assert.strictEqual(latin.normalize("E-Mail"), "email");
  assert.strictEqual(latin.normalize("Don\u2019t"), "dont");
  assert.strictEqual(latin.normalize(""), "");
});
