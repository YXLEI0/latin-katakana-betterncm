/*
 * 拉丁词扫描器（core/letters.js）的单元测试。
 *
 * 这个模块只干一件事：在一片文本里找出"值得标读音"的拉丁词，并给出位置。
 * 位置必须准 —— 注入时靠它把原文本切成 前段/词/后段，错一个字符底字就错了。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const letters = require("../src/core/letters.js");

test("hasLatin：只认拉丁字母", () => {
  assert.strictEqual(letters.hasLatin("clover"), true);
  assert.strictEqual(letters.hasLatin("コーヒー"), false);
  assert.strictEqual(letters.hasLatin("きらめく light"), true);
  assert.strictEqual(letters.hasLatin(""), false);
  assert.strictEqual(letters.hasLatin(null), false);
});

test("scan：切出每个词和它的位置", () => {
  const src = "きらめく light と clover。";
  const toks = letters.scan(src);
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
  const toks = letters.scan("don't send e-mail");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["don't", "send", "e-mail"]
  );
  // 全角撇号也认（歌词里两种都有）
  assert.deepStrictEqual(
    letters.scan("don\u2019t").map((t) => t.text),
    ["don\u2019t"]
  );
});

test("scan：词内部的 norm 去掉撇号连字符并小写", () => {
  const toks = letters.scan("Don't E-Mail");
  assert.deepStrictEqual(
    toks.map((t) => t.norm),
    ["dont", "email"]
  );
});

test("scan：连字符在词尾时不算进词里（light- 应切成 light）", () => {
  const toks = letters.scan("light-");
  assert.strictEqual(toks.length, 1);
  assert.strictEqual(toks[0].text, "light");
});

test("连字符串起来的长词要拆开：Looser-Krankheit-Was 是三个词（别再压一条超长注音）", () => {
  // 用户截图：`Looser-Krankheit-` 上面压着一整条 `ルーザークランクハイトヴァス`，
  // 比底字还宽、和每个词都对不上（"有些单词超长了效果不好"）；大模型那层也把
  // `looserkrankheitwas` 当成**一个词**去问（真机缓存里就有这条键）。
  // 判据：每一段都 >= 2 个字母才拆。
  const toks = letters.scan("A-Z Looser-Krankheit-Was IS das?");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["A", "Z", "Looser", "Krankheit", "Was", "IS", "das"],
    "A-Z 是记号（逐字母读，拆成一个字母一个词），后面几个各自成词"
  );
  assert.strictEqual(toks[0].notation, true, "A 是记号零件");
  assert.strictEqual(toks[1].notation, true, "Z 是记号零件");
  // 位置要能对上原文，注音层靠它把 ruby 插在正确的位置（分隔符留成普通文本）
  for (const t of toks) assert.strictEqual("A-Z Looser-Krankheit-Was IS das?".slice(t.start, t.end), t.text);
  assert.deepStrictEqual(
    toks.slice(2, 5).map((t) => t.norm),
    ["looser", "krankheit", "was"]
  );

  // 几种连字符一个待遇（歌词里 ASCII 和 en/em dash 混着用）
  const dashes = ["Looser-Krankheit", "Looser\u2010Krankheit", "Looser\u2011Krankheit", "Looser\u2013Krankheit", "Looser\u2014Krankheit"];
  for (const s of dashes) {
    assert.deepStrictEqual(
      letters.scan(s).map((t) => t.text),
      ["Looser", "Krankheit"],
      JSON.stringify(s) + " 要拆开"
    );
  }
  assert.strictEqual(letters.scan("A\u2013Z")[0].notation, true, "en dash 的 A–Z 也是记号");

  // 有单字母段的不拆：那是**词内**的连字符（e-mail / x-ray / T-ara），拆开只会更差
  for (const s of ["e-mail", "x-ray", "T-ara", "U-turn"]) {
    assert.deepStrictEqual(
      letters.scan(s).map((t) => t.text),
      [s],
      s + " 要保持整词"
    );
  }
  // 波浪号照旧是拉长音（不拆）；well-known 这种普通连字符词也拆
  assert.deepStrictEqual(letters.scan("feel~ing").map((t) => t.text), ["feel~ing"]);
  assert.deepStrictEqual(letters.scan("well-known").map((t) => t.text), ["well", "known"]);
});

test("scan：没有拉丁字母时返回空数组", () => {
  assert.deepStrictEqual(letters.scan("きらめく"), []);
  assert.deepStrictEqual(letters.scan(""), []);
  assert.deepStrictEqual(letters.scan(null), []);
});

test("scan：连续多个词、以及换行分隔", () => {
  const toks = letters.scan("light\nclover dream");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["light", "clover", "dream"]
  );
});

test("scan：不会因为零宽匹配卡死（正则改坏时的保护）", () => {
  // 只要能在合理时间内返回就算过；这里主要是防止以后改正则引入死循环
  const toks = letters.scan("a".repeat(2000));
  assert.ok(toks.length >= 1);
});

test("looksReadable：单字母默认不标，但 a / I / o 是真词要标", () => {
  // 用户报的：`Tell me a story` 里那个 a 不注音。
  // 单字母默认跳过（首字母缩写、排版噪声），可 `a` 和 `I` 是真正的英文单词，
  // 在 J-pop 歌词里满地都是，漏掉它们比标错更显眼。
  const toks = letters.scan("Tell me a story I love you x b");
  const by = {};
  for (const t of toks) by[t.text] = letters.looksReadable(t);
  assert.strictEqual(by["a"], true, "a 是英文单词，要标（ア）");
  assert.strictEqual(by["I"], true, "I 是英文单词，要标（アイ）");
  assert.strictEqual(by["x"], false, "其它单字母仍然不标");
  assert.strictEqual(by["b"], false, "其它单字母仍然不标");
  assert.strictEqual(by["Tell"], true);
  assert.strictEqual(by["me"], true);
  assert.strictEqual(by["story"], true);
  assert.strictEqual(by["love"], true);
  assert.strictEqual(by["you"], true);

  /*
   * 拉丁语 / 意大利语里的小 o（连词 "或"、呼语）：用户截图点名它漏标了 ——
   * `tragedia o splendidae` / `fatalita o infaustae`。同一首歌里呼语用大写 `O`
   * （读 オー，见 main.js），小写这个按引擎读 オ。
   */
  const lower = letters.scan("tragedia o splendidae");
  const lo = {};
  for (const t of lower) lo[t.text] = letters.looksReadable(t);
  assert.strictEqual(lo["o"], true, "小写 o 是真词，要标");
  assert.strictEqual(lo["tragedia"], true);
});

test("记号拆成一个字母一个词：D/N/A / N/A / A.B.C / R&B / X-Y / M・I・D・I", () => {
  // 用户先报：`だって D/N/Aじゃ 騙れない` 里的 A 被读成 ア（该读字母名）。
  // 后来又报：`M·I·D·I` 上面压着一整条 `エムアイディーアイ`，
  // "能不能分别注在每个字母上" —— 于是记号**拆成一个字母一个词**，
  // 每个字母各标一个 ruby（读音由 main.js 的 lineLetterRun 判成字母名）。
  const cases = [
    ["D/N/A", ["D", "N", "A"]],
    ["N/A", ["N", "A"]],
    ["A.B.C", ["A", "B", "C"]],
    ["R&B", ["R", "&", "B"]], // `&` 是唯一有读音的分隔符（アンド），自己算一个词
    ["X-Y", ["X", "Y"]],
    ["M\u30FBI\u30FBD\u30FBI", ["M", "I", "D", "I"]],
    ["M\u00B7I\u00B7D\u00B7I", ["M", "I", "D", "I"]], // 中点三种写法都认
    ["M\u2022I\u2022D\u2022I", ["M", "I", "D", "I"]],
  ];
  for (const [raw, want] of cases) {
    const toks = letters.scan(raw);
    assert.deepStrictEqual(
      toks.map((t) => t.text),
      want,
      JSON.stringify(raw) + " 要拆成 " + JSON.stringify(want)
    );
    for (const t of toks) {
      assert.strictEqual(t.notation, true, raw + " 的零件要带 notation 标记");
      assert.strictEqual(letters.looksReadable(t), true, raw + " 的每个零件都要标");
      // 位置对得上原文（分隔符留在原地当普通文本，注音层靠 start/end 排 ruby）
      assert.strictEqual(raw.slice(t.start, t.end), t.text);
    }
  }
  const and = letters.scan("R&B")[1];
  assert.strictEqual(and.symbol, true, "& 是符号词（读 アンド）");
  assert.strictEqual(letters.scan("M\u30FBI\u30FBD\u30FBI")[0].norm, "m", "单字母的 norm 就是它自己");

  // 反例：连字符词的每段不止一个字母，就不是记号，按普通词读
  const mail = letters.scan("e-mail")[0];
  assert.strictEqual(mail.notation, false, "e-mail 是普通词");
  const xray = letters.scan("X-ray")[0];
  assert.strictEqual(xray.notation, false, "X-ray 是普通词（不能逐字母念）");
  assert.strictEqual(xray.text, "X-ray");
});

test("颜文字/装饰符号夹着的字母不标（`(#^ω^)` 里的 ω）", () => {
  // 用户截图：`勝算なくても行っちゃえ！とか(#^ω^)` 里的 ω 被标成 オメガ ——
  // 那是画脸用的，不是词。`^` `` ` `` `´` `＾` `｀` `ﾟ` `゛` `゜` 这些在日文里
  // 只出现在颜文字/装饰里，所以它们和别的分隔符一样算"粘住"。
  for (const raw of ["(#^\u03C9^)", "(\uFF9F\u0414\uFF9F)", "(\u00B4\u25BD\uFF40)", "(\uFF3E\u03C9\uFF3E)"]) {
    for (const tk of letters.scan(raw)) {
      assert.strictEqual(letters.looksReadable(tk), false, JSON.stringify(raw) + " 里的 " + tk.text + " 不该标");
    }
  }
  // 反面：只是括号里孤零零一个字母（`（Ω）`）照标 —— 那不是颜文字
  const omega = letters.scan("\uFF08\u03A9\uFF09")[0];
  assert.strictEqual(omega.text, "\u03A9");
  assert.strictEqual(letters.looksReadable(omega), true, "括号里的 Ω 是符号/单位，要标");
});

test("记号尾巴上的缩写要连成一词（`I-I-I-I-I-I-I'm` 的 `I'm`）", () => {
  // 用户截图：`I-I-I-I-I-I-I'm mine` 最后只注到 `I`，`'m` 整个丢了 ——
  // 记号在 `'` 前面就断了，剩下一个孤零零的 `m` 没人管。
  const toks = letters.scan("I-I-I-I-I-I-I'm mine");
  assert.deepStrictEqual(
    toks.map((t) => t.text),
    ["I", "I", "I", "I", "I", "I", "I'm", "mine"]
  );
  const last = toks[6];
  assert.strictEqual(last.notation, true, "还是记号零件");
  assert.strictEqual(last.norm, "im", "norm 折成 im（缩写表按这个查）");
  assert.strictEqual(letters.looksReadable(last), true);
  assert.strictEqual("I-I-I-I-I-I-I'm mine".slice(last.start, last.end), "I'm", "位置要对得上");
  // 六种缩写尾巴都认；不是缩写的（`'s` 后面还跟字母）不算
  for (const tail of ["'m", "'s", "'re", "'ll", "'ve", "'d"]) {
    const tk = letters.scan("I-I" + tail)[1];
    assert.strictEqual(tk.text, "I" + tail, "I" + tail + " 要合成一个词");
  }
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
    const got = letters.scan(line).map((t) => t.text);
    assert.deepStrictEqual(got, want, JSON.stringify(line));
  }
  // 单个带符号的字母（Ō）要标；粘着分隔符的照样不标
  const o = letters.scan("Ō")[0];
  assert.strictEqual(o.diacritic, true);
  assert.strictEqual(letters.looksReadable(o), true, "Ō 是罗马音里的长音，要标");
  assert.strictEqual(letters.hasLatin("Ō"), true, "hasLatin 也要认带符号的字母");
  assert.strictEqual(letters.looksReadable(letters.scan("&Ō&")[0]), false, "粘着分隔符的仍然不标");
});

test("记号里的单字母照标（读字母名）；孤零零粘着分隔符的单字母仍然不标", () => {
  // 用户报过：`だって D/N/Aじゃ 騙れない` 里那个 A 被读成 ア（冠词读法）。
  // 现在记号拆成一个字母一个词，每个字母都标 —— 但标的是**字母名**（エー），
  // 由 main.js 的 lineLetterRun 按整行判（见 integration 用例）。
  for (const line of ["だって D/N/Aじゃ 騙れない", "N/A", "A.B.C", "X-Y", "M\u30FBI\u30FBD\u30FBI"]) {
    for (const tk of letters.scan(line)) {
      if (tk.text.length === 1) {
        assert.strictEqual(tk.notation, true, line + " 里的 " + tk.text + " 是记号零件");
        assert.strictEqual(letters.looksReadable(tk), true, line + " 里的 " + tk.text + " 要标（字母名）");
      }
    }
  }
  // 不是记号、只是粘在分隔符上的单字母（`&A&`、句尾的 `A.`）：照旧不标
  for (const line of ["&A&", "A.", "(*A*)"]) {
    for (const tk of letters.scan(line)) {
      if (tk.text.length === 1) {
        assert.strictEqual(tk.notation, false, line + " 里的 " + tk.text + " 不是记号");
        assert.strictEqual(letters.looksReadable(tk), false, line + " 里的 " + tk.text + " 不该标");
      }
    }
  }
  // 反过来：不粘分隔符的冠词/代词照旧要标
  const free = letters.scan("A story");
  assert.strictEqual(free[0].text, "A");
  assert.strictEqual(letters.looksReadable(free[0]), true, "句首的 A 是冠词，要标");
  const iTok = letters.scan("I love you")[0];
  assert.strictEqual(letters.looksReadable(iTok), true, "I 是代词，要标");
  // 孤零零一个 `&`（you & me）根本不成分词，所以不会多出个 アンド
  assert.deepStrictEqual(
    letters.scan("you & me").map((t) => t.text),
    ["you", "me"]
  );
});

test("重复字母：全大写 2~3 个当缩写标，小写/长串留白", () => {
  // 来龙去脉：先是用户报 `“XX”` 被读成 エックスエックス（打码不该念），
  // 于是这类一律留白；后来用户又报 `合言葉は「YY」` —— 那个 YY 是缩写，要标。
  // 两者拼写一模一样，本地分不出来，用户选择"标"，于是：
  //   全大写 2~3 个 -> 标（YY ワイワイ、XX エックスエックス）
  //   小写 / 4 个以上 -> 留白（xx 打码、XXXX 噪声）
  for (const raw of ["YY", "XX", "XXX"]) {
    assert.strictEqual(letters.looksReadable(letters.scan(raw)[0]), true, raw + " 要标（按字母名）");
  }
  for (const raw of ["xx", "zzz", "XXXX", "yyy"]) {
    assert.strictEqual(letters.looksReadable(letters.scan(raw)[0]), false, raw + " 留白");
  }
  // 元音串照旧要标：AAAAA / OOO 是喊叫/拖长音，按那个元音叠出来
  for (const raw of ["AA", "aaa", "AAAAA", "OOO", "oo"]) {
    const tk = letters.scan(raw)[0];
    assert.strictEqual(letters.looksReadable(tk), true, raw + " 是喊叫/长音，要标");
  }
  // 反例：不同字母的缩写照旧逐字母读 —— 边界要正好落在"重复"上
  for (const raw of ["LDK", "TV", "MC", "DJ"]) {
    const tk = letters.scan(raw)[0];
    assert.strictEqual(letters.looksReadable(tk), true, raw + " 是真实缩写，要标");
  }
  // 记号优先：`X-X` / `A-A` 是记号（エックスワイ / エーエー），不能被这一刀误伤
  for (const raw of ["X-X", "A-A"]) {
    const tk = letters.scan(raw)[0];
    assert.strictEqual(tk.notation, true, raw + " 是记号");
    assert.strictEqual(letters.looksReadable(tk), true, raw + " 是记号，要标");
  }
});

test("大写单字母放行给读音层判，小写单字母仍只放 a / I", () => {
  // `(A, B)` 里的 A / B 要读字母名（エー / ビー），但 `A story` 的 A 是冠词（ア）——
  // 光看这个词分不出来，所以 matcher 放行，由 main.js 按整行判。
  assert.strictEqual(letters.looksReadable(letters.scan("B")[0]), true, "大写 B 放行（可能是字母名）");
  assert.strictEqual(letters.looksReadable(letters.scan("A")[0]), true, "大写 A 放行（冠词或字母名）");
  assert.strictEqual(letters.looksReadable(letters.scan("b")[0]), false, "小写 b 仍然不标");
  assert.strictEqual(letters.looksReadable(letters.scan("x")[0]), false, "小写 x 仍然不标");
  assert.strictEqual(letters.looksReadable(letters.scan("A.")[0]), false, "粘着标点的 A 还是不标");
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
    const toks = letters.scan(src);
    assert.strictEqual(toks.length, 1, src + " 应该是一个词：" + JSON.stringify(toks.map((t) => t.text)));
    assert.strictEqual(toks[0].text, text);
    assert.strictEqual(toks[0].norm, norm, src + " 查表用的形式要去掉波浪号");
  }
  // 结尾的波浪号不算连接符（后面没有字母）：`go~` / `love~` 还是原来的词
  assert.deepStrictEqual(letters.scan("go~ の love~").map((t) => t.text), ["go", "love"]);
  assert.deepStrictEqual(letters.scan("~go").map((t) => t.text), ["go"]);
});

test("hasReadable：整段里有没有值得标的词", () => {
  assert.strictEqual(letters.hasReadable("きらめく light"), true);
  assert.strictEqual(letters.hasReadable("x y z"), false, "只有不标的单字母就不值得处理");
  assert.strictEqual(letters.hasReadable("a"), true, "只有 a 也要处理（它是单词）");
  assert.strictEqual(letters.hasReadable("きらめく"), false);
});

test("normalize：小写化并去掉撇号连字符", () => {
  assert.strictEqual(letters.normalize("Clover"), "clover");
  assert.strictEqual(letters.normalize("E-Mail"), "email");
  assert.strictEqual(letters.normalize("Don\u2019t"), "dont");
  // 几种连字符都折掉（不然 en dash 的 rendez–vous 查表时键里会留一个 dash）
  assert.strictEqual(letters.normalize("Rendez\u2013Vous"), "rendezvous");
  assert.strictEqual(letters.normalize("A\u2014B"), "ab");
  assert.strictEqual(letters.normalize(""), "");
});
