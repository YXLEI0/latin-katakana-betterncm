/*
 * core/reading.js —— 读音引擎（罗马音切分 / 英文音译 / 读音器）。
 *
 * 断言全部对齐 reading.js 注释里写死的那几条规则，不是「跑出来是什么就断言什么」：
 *   - 长音：ou -> オウ、oo -> オー、uu -> ウー、aa -> アー、ee -> エー、ei -> エイ
 *   - 促音：kk/tt/pp/ss/cc -> ッ
 *   - 拨音：n 在辅音前或词尾 -> ン
 *   - 英文：l 结尾 ル、r 结尾 ー、词尾 e 不发音、v 走 ヴァ行
 * 断言的期望值写成 \uXXXX 会和实现一样难读，所以这里直接用片假名字面量
 * （测试文件跑在 Node 里，不像老 CEF 那样受限制）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const LK = require("../src/core/reading.js");

// ============================================================ normalize

test("normalize：小写化 + 去掉首尾标点", () => {
  assert.strictEqual(LK.normalize("Clover"), "clover");
  assert.strictEqual(LK.normalize("  ...Clover!! "), "clover");
  assert.strictEqual(LK.normalize("SEKAI"), "sekai");
});

test("normalize：中间的连字符保留，交给查表时再折", () => {
  assert.strictEqual(LK.normalize("e-mail"), "e-mail");
});

test("normalize：空输入与非字符串都返回空串", () => {
  assert.strictEqual(LK.normalize(""), "");
  assert.strictEqual(LK.normalize("!!!"), "");
  assert.strictEqual(LK.normalize(undefined), "");
  assert.strictEqual(LK.normalize(null), "");
  assert.strictEqual(LK.normalize(123), "");
});

// ============================================================ romajiToKatakana

test("罗马音：基本行（a 段到 p 段）", () => {
  assert.strictEqual(LK.romajiToKatakana("a"), "ア");
  assert.strictEqual(LK.romajiToKatakana("i"), "イ");
  assert.strictEqual(LK.romajiToKatakana("u"), "ウ");
  assert.strictEqual(LK.romajiToKatakana("e"), "エ");
  assert.strictEqual(LK.romajiToKatakana("o"), "オ");
  assert.strictEqual(LK.romajiToKatakana("ka"), "カ");
  assert.strictEqual(LK.romajiToKatakana("ki"), "キ");
  assert.strictEqual(LK.romajiToKatakana("ku"), "ク");
  assert.strictEqual(LK.romajiToKatakana("ke"), "ケ");
  assert.strictEqual(LK.romajiToKatakana("ko"), "コ");
});

test("罗马音：sa 行用 shi，ta 行用 chi/tsu", () => {
  assert.strictEqual(LK.romajiToKatakana("sa"), "サ");
  assert.strictEqual(LK.romajiToKatakana("shi"), "シ");
  assert.strictEqual(LK.romajiToKatakana("su"), "ス");
  assert.strictEqual(LK.romajiToKatakana("se"), "セ");
  assert.strictEqual(LK.romajiToKatakana("so"), "ソ");
  assert.strictEqual(LK.romajiToKatakana("ta"), "タ");
  assert.strictEqual(LK.romajiToKatakana("chi"), "チ");
  assert.strictEqual(LK.romajiToKatakana("tsu"), "ツ");
  assert.strictEqual(LK.romajiToKatakana("te"), "テ");
  assert.strictEqual(LK.romajiToKatakana("to"), "ト");
});

test("罗马音：ha 行用 fu 而不是 hu", () => {
  assert.strictEqual(LK.romajiToKatakana("ha"), "ハ");
  assert.strictEqual(LK.romajiToKatakana("hi"), "ヒ");
  assert.strictEqual(LK.romajiToKatakana("fu"), "フ");
  assert.strictEqual(LK.romajiToKatakana("he"), "ヘ");
  assert.strictEqual(LK.romajiToKatakana("ho"), "ホ");
});

test("罗马音：ya 行只有 ya/yu/yo", () => {
  assert.strictEqual(LK.romajiToKatakana("ya"), "ヤ");
  assert.strictEqual(LK.romajiToKatakana("yu"), "ユ");
  assert.strictEqual(LK.romajiToKatakana("yo"), "ヨ");
});

test("罗马音：浊音行 ga/za/da/ba/pa", () => {
  assert.strictEqual(LK.romajiToKatakana("ga"), "ガ");
  assert.strictEqual(LK.romajiToKatakana("ji"), "ジ");
  assert.strictEqual(LK.romajiToKatakana("zu"), "ズ");
  assert.strictEqual(LK.romajiToKatakana("da"), "ダ");
  assert.strictEqual(LK.romajiToKatakana("de"), "デ");
  assert.strictEqual(LK.romajiToKatakana("ba"), "バ");
  assert.strictEqual(LK.romajiToKatakana("bo"), "ボ");
  assert.strictEqual(LK.romajiToKatakana("pa"), "パ");
  assert.strictEqual(LK.romajiToKatakana("po"), "ポ");
});

test("罗马音：wa 行与单独成拍的 n", () => {
  assert.strictEqual(LK.romajiToKatakana("wa"), "ワ");
  assert.strictEqual(LK.romajiToKatakana("wo"), "ヲ");
  assert.strictEqual(LK.romajiToKatakana("n"), "ン");
});

test("罗马音：拗音用小的 ャュョ", () => {
  assert.strictEqual(LK.romajiToKatakana("kya"), "キャ");
  assert.strictEqual(LK.romajiToKatakana("kyu"), "キュ");
  assert.strictEqual(LK.romajiToKatakana("kyo"), "キョ");
  assert.strictEqual(LK.romajiToKatakana("sha"), "シャ");
  assert.strictEqual(LK.romajiToKatakana("shu"), "シュ");
  assert.strictEqual(LK.romajiToKatakana("sho"), "ショ");
  assert.strictEqual(LK.romajiToKatakana("cha"), "チャ");
  assert.strictEqual(LK.romajiToKatakana("chu"), "チュ");
  assert.strictEqual(LK.romajiToKatakana("cho"), "チョ");
  assert.strictEqual(LK.romajiToKatakana("nya"), "ニャ");
  assert.strictEqual(LK.romajiToKatakana("hya"), "ヒャ");
  assert.strictEqual(LK.romajiToKatakana("mya"), "ミャ");
  assert.strictEqual(LK.romajiToKatakana("rya"), "リャ");
  assert.strictEqual(LK.romajiToKatakana("gya"), "ギャ");
  assert.strictEqual(LK.romajiToKatakana("ja"), "ジャ");
  assert.strictEqual(LK.romajiToKatakana("bya"), "ビャ");
  assert.strictEqual(LK.romajiToKatakana("pya"), "ピャ");
});

// ---- 任务点名的 10 个直接用例

test("罗马音：task 点名的 10 个词", () => {
  assert.strictEqual(LK.romajiToKatakana("sekai"), "セカイ");
  assert.strictEqual(LK.romajiToKatakana("watashi"), "ワタシ");
  assert.strictEqual(LK.romajiToKatakana("shinjiteru"), "シンジテル");
  assert.strictEqual(LK.romajiToKatakana("tsuki"), "ツキ");
  assert.strictEqual(LK.romajiToKatakana("matte"), "マッテ");
  // gakkou 的 ou 按规则读 オウ（不是长音符）
  assert.strictEqual(LK.romajiToKatakana("gakkou"), "ガッコウ");
  assert.strictEqual(LK.romajiToKatakana("shinbun"), "シンブン");
  assert.strictEqual(LK.romajiToKatakana("zasshi"), "ザッシ");
  assert.strictEqual(LK.romajiToKatakana("kyou"), "キョウ");
  assert.strictEqual(LK.romajiToKatakana("toire"), "トイレ");
});

test("罗马音：促音 kk/tt/ss 只留一个 ッ", () => {
  assert.strictEqual(LK.romajiToKatakana("kekkon"), "ケッコン");
  assert.strictEqual(LK.romajiToKatakana("issho"), "イッショ");
  assert.strictEqual(LK.romajiToKatakana("zannen"), "ザンネン");
});

test("罗马音：n 在辅音前或词尾读 ン", () => {
  assert.strictEqual(LK.romajiToKatakana("nihon"), "ニホン");
  assert.strictEqual(LK.romajiToKatakana("zannen"), "ザンネン");
  assert.strictEqual(LK.romajiToKatakana("shinbun"), "シンブン");
  // n 后面是 y 时要连读，不能收 ン
  assert.strictEqual(LK.romajiToKatakana("nyan"), "ニャン");
});

test("罗马音：长音规则（注释里定死的那条）", () => {
  // ou -> オウ
  assert.strictEqual(LK.romajiToKatakana("ou"), "オウ");
  assert.strictEqual(LK.romajiToKatakana("kyou"), "キョウ");
  assert.strictEqual(LK.romajiToKatakana("ryokou"), "リョコウ");
  // oo -> オー
  assert.strictEqual(LK.romajiToKatakana("oo"), "オー");
  // aa -> アー
  assert.strictEqual(LK.romajiToKatakana("aa"), "アー");
  assert.strictEqual(LK.romajiToKatakana("aasan"), "アーサン");
  // uu -> ウー
  assert.strictEqual(LK.romajiToKatakana("uu"), "ウー");
  // ee -> エー
  assert.strictEqual(LK.romajiToKatakana("ee"), "エー");
  // ei -> エイ（不是长音）
  assert.strictEqual(LK.romajiToKatakana("ei"), "エイ");
  assert.strictEqual(LK.romajiToKatakana("sensei"), "センセイ");
});

test("罗马音：aa 系列只在词首合并（已知取舍，见实现注释）", () => {
  // 这一条记的是已知行为，不是理想行为：aa 出现在词首时并成长音，
  // 出现在别的音节后面时目前是各读各的（okaasan -> オカアサン）。
  // 之所以断言出来，是为了让以后改这块逻辑时能看见影响面。
  assert.strictEqual(LK.romajiToKatakana("aa"), "アー");
  assert.strictEqual(LK.romajiToKatakana("aasan"), "アーサン");
  assert.strictEqual(LK.romajiToKatakana("okaasan"), "オカアサン");
});

test("罗马音：词尾的 - 原样保留成长音符", () => {
  assert.strictEqual(LK.romajiToKatakana("saka-"), "サカー");
  assert.strictEqual(LK.romajiToKatakana("kya-"), "キャー");
});

test("罗马音：大小写和首尾空白都能吃", () => {
  assert.strictEqual(LK.romajiToKatakana("SEKAI"), "セカイ");
  assert.strictEqual(LK.romajiToKatakana("  sekai  "), "セカイ");
});

test("罗马音：整串切不干净就返回 null（英文词不能当罗马音）", () => {
  assert.strictEqual(LK.romajiToKatakana("clover"), null); // cl 不是合法音节
  assert.strictEqual(LK.romajiToKatakana("light"), null); // l 起头
  assert.strictEqual(LK.romajiToKatakana("rhythm"), null); // y 不能单独做音节
  assert.strictEqual(LK.romajiToKatakana("xyzzy"), null);
});

test("罗马音：空输入、纯标点、混标点都返回 null", () => {
  assert.strictEqual(LK.romajiToKatakana(""), null);
  assert.strictEqual(LK.romajiToKatakana("   "), null);
  assert.strictEqual(LK.romajiToKatakana("!!!"), null);
  assert.strictEqual(LK.romajiToKatakana("sekai!"), null); // 混了标点就不算纯罗马音
  assert.strictEqual(LK.romajiToKatakana("----"), null);
  assert.strictEqual(LK.romajiToKatakana("bcdfg"), null);
  assert.strictEqual(LK.romajiToKatakana(undefined), null);
  assert.strictEqual(LK.romajiToKatakana(null), null);
});

test("罗马音：超长元音串不吐一串 ー，判负交给英文规则", () => {
  assert.strictEqual(LK.romajiToKatakana("aaaaaaaa-"), null);
  assert.strictEqual(LK.romajiToKatakana("aaaaaaaaaaaaaaaaaaaaaaaa"), null);
});

// ============================================================ englishToKatakana

test("英文：例外表逐字对上（任务点名的 31 个）", () => {
  assert.strictEqual(LK.englishToKatakana("light").kana, "ライト");
  assert.strictEqual(LK.englishToKatakana("night").kana, "ナイト");
  assert.strictEqual(LK.englishToKatakana("right").kana, "ライト");
  assert.strictEqual(LK.englishToKatakana("high").kana, "ハイ");
  assert.strictEqual(LK.englishToKatakana("through").kana, "スルー");
  assert.strictEqual(LK.englishToKatakana("though").kana, "ゾウ");
  assert.strictEqual(LK.englishToKatakana("enough").kana, "イナフ");
  assert.strictEqual(LK.englishToKatakana("love").kana, "ラブ");
  assert.strictEqual(LK.englishToKatakana("one").kana, "ワン");
  assert.strictEqual(LK.englishToKatakana("two").kana, "トゥー");
  assert.strictEqual(LK.englishToKatakana("eight").kana, "エイト");
  assert.strictEqual(LK.englishToKatakana("heart").kana, "ハート");
  assert.strictEqual(LK.englishToKatakana("world").kana, "ワールド");
  assert.strictEqual(LK.englishToKatakana("dream").kana, "ドリーム");
  assert.strictEqual(LK.englishToKatakana("school").kana, "スクール");
  assert.strictEqual(LK.englishToKatakana("blue").kana, "ブルー");
  assert.strictEqual(LK.englishToKatakana("eyes").kana, "アイズ");
  assert.strictEqual(LK.englishToKatakana("time").kana, "タイム");
  assert.strictEqual(LK.englishToKatakana("shine").kana, "シャイン");
  assert.strictEqual(LK.englishToKatakana("sky").kana, "スカイ");
  assert.strictEqual(LK.englishToKatakana("star").kana, "スター");
  assert.strictEqual(LK.englishToKatakana("snow").kana, "スノウ");
  assert.strictEqual(LK.englishToKatakana("flow").kana, "フロウ");
  assert.strictEqual(LK.englishToKatakana("know").kana, "ノウ");
  assert.strictEqual(LK.englishToKatakana("why").kana, "ホワイ");
  assert.strictEqual(LK.englishToKatakana("fall").kana, "フォール");
  assert.strictEqual(LK.englishToKatakana("call").kana, "コール");
  assert.strictEqual(LK.englishToKatakana("wall").kana, "ウォール");
  assert.strictEqual(LK.englishToKatakana("girl").kana, "ガール");
  assert.strictEqual(LK.englishToKatakana("summer").kana, "サマー");
  assert.strictEqual(LK.englishToKatakana("winter").kana, "ウィンター");
});

test("英文：例外表一律 confident:true", () => {
  assert.strictEqual(LK.englishToKatakana("light").confident, true);
  assert.strictEqual(LK.englishToKatakana("through").confident, true);
  assert.strictEqual(LK.englishToKatakana("world").confident, true);
  assert.strictEqual(LK.englishToKatakana("girl").confident, true);
});

test("英文：任务点名的外来语靠规则/小表读对", () => {
  assert.strictEqual(LK.englishToKatakana("clover").kana, "クローバー");
  assert.strictEqual(LK.englishToKatakana("diorama").kana, "ジオラマ");
  assert.strictEqual(LK.englishToKatakana("guitar").kana, "ギター");
  assert.strictEqual(LK.englishToKatakana("coffee").kana, "コーヒー");
  assert.strictEqual(LK.englishToKatakana("camera").kana, "カメラ");
  assert.strictEqual(LK.englishToKatakana("radio").kana, "ラジオ");
  assert.strictEqual(LK.englishToKatakana("melody").kana, "メロディー");
  assert.strictEqual(LK.englishToKatakana("computer").kana, "コンピューター");
  assert.strictEqual(LK.englishToKatakana("story").kana, "ストーリー");
});

test("英文：sh/ch/ck/ng 这些字母组合", () => {
  assert.strictEqual(LK.englishToKatakana("she").kana, "シー");
  assert.strictEqual(LK.englishToKatakana("cheese").kana, "チイーセ");
  assert.strictEqual(LK.englishToKatakana("box").kana, "ボックス");
  assert.strictEqual(LK.englishToKatakana("six").kana, "シックス");
});

test("英文：词尾 l -> ル、词尾 r -> ー", () => {
  assert.strictEqual(LK.englishToKatakana("school").kana, "スクール");
  assert.strictEqual(LK.englishToKatakana("girl").kana, "ガール");
  assert.strictEqual(LK.englishToKatakana("over").kana, "オーバー");
  assert.strictEqual(LK.englishToKatakana("star").kana, "スター");
});

test("英文：l 结尾一律 ル（规则路径也算）", () => {
  // 这两个没进表，走规则；断言的是规则里「词尾 l -> ル」那条
  assert.strictEqual(LK.englishToKatakana("novel").kana.slice(-1), "ル");
  assert.strictEqual(LK.englishToKatakana("hotel").kana.slice(-1), "ル");
});

test("英文：永远返回非空片假名", () => {
  const samples = ["clover", "zzxqw", "a", "x", "", "!!!", "12345", "e-mail", "qqqq", "b", "n"];
  for (let i = 0; i < samples.length; i++) {
    const res = LK.englishToKatakana(samples[i]);
    assert.strictEqual(typeof res.kana, "string", samples[i]);
    assert.ok(res.kana.length > 0, "空结果：" + samples[i]);
    assert.strictEqual(typeof res.confident, "boolean", samples[i]);
  }
});

test("英文：非字符串输入也给一个安全的空读音", () => {
  assert.deepStrictEqual(LK.englishToKatakana(undefined), { kana: "ア", confident: false });
  assert.deepStrictEqual(LK.englishToKatakana(null), { kana: "ア", confident: false });
});

test("英文：confident:false 的判定条件", () => {
  // ① 词尾不发音的 e（辅音 + e 结尾）：拼写定不下来
  assert.strictEqual(LK.englishToKatakana("orange").confident, false);
  // ② th 这种发音不唯一的二合字母
  assert.strictEqual(LK.englishToKatakana("the").confident, false);
  assert.strictEqual(LK.englishToKatakana("think").confident, false);
  // ③ 元音连写不在表里 / 三个元音连写
  assert.strictEqual(LK.englishToKatakana("beautiful").confident, false);
  // ④ 连缀过长、拼不出音
  assert.strictEqual(LK.englishToKatakana("rhythm").confident, false);
  // ⑤ 压根没元音（不是词）
  assert.strictEqual(LK.englishToKatakana("zzxqw").confident, false);
  // 反例：规则能读顺的不该被标
  assert.strictEqual(LK.englishToKatakana("hello").confident, true);
  assert.strictEqual(LK.englishToKatakana("world").confident, true);
});

// ============================================================ createReader

test("reader：dict 命中优先于罗马音和规则", () => {
  const r = LK.createReader({ dict: { clover: "クローバー" } });
  const got = r.read("Clover");
  assert.strictEqual(got.source, "dict");
  assert.strictEqual(got.kana, "クローバー");
  assert.strictEqual(got.confident, true);
});

test("reader：dict 查表顺序是 原样 -> 小写 -> 去非字母", () => {
  // 原样命中
  const r1 = LK.createReader({ dict: { "E-Mail": "イーメール" } });
  assert.strictEqual(r1.read("E-Mail").source, "dict");
  assert.strictEqual(r1.read("E-Mail").kana, "イーメール");
  // 去掉非字母后命中
  const r2 = LK.createReader({ dict: { email: "イーメール" } });
  const got = r2.read("E-mail!");
  assert.strictEqual(got.source, "dict");
  assert.strictEqual(got.kana, "イーメール");
});

test("reader：dict 命中会计进 dictHits", () => {
  const r = LK.createReader({ dict: { clover: "クローバー" } });
  r.read("clover");
  r.read("clover");
  assert.strictEqual(r.stats().dictHits, 2);
});

test("reader：dict 为空时 sekai 走 romaji", () => {
  const r = LK.createReader({ dict: {} });
  const got = r.read("sekai");
  assert.strictEqual(got.source, "romaji");
  assert.strictEqual(got.kana, "セカイ");
  assert.strictEqual(got.confident, true);
});

test("reader：dict 为 undefined 也能建起来", () => {
  const r = LK.createReader();
  assert.strictEqual(r.read("sekai").source, "romaji");
  const r2 = LK.createReader({ dict: undefined, log: undefined });
  assert.strictEqual(r2.read("hello").source, "rule");
});

test("reader：罗马音切不干净时落到 rule，且不抛异常", () => {
  const r = LK.createReader({ dict: {} });
  const got = r.read("zzxqw");
  assert.strictEqual(got.source, "rule");
  assert.strictEqual(typeof got.kana, "string");
  assert.ok(got.kana.length > 0);
});

test("reader：英文词的来源是 rule（不是 romaji）", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.read("clover").source, "rule");
  assert.strictEqual(r.read("clover").kana, "クローバー");
  assert.strictEqual(r.read("light").source, "rule");
  assert.strictEqual(r.read("light").kana, "ライト");
});

test("reader：空输入 / 纯标点 / 无拉丁字母都返回 null", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.read(""), null);
  assert.strictEqual(r.read("   "), null);
  assert.strictEqual(r.read("..."), null);
  assert.strictEqual(r.read("！？"), null);
  assert.strictEqual(r.read("こんにちは"), null);
  assert.strictEqual(r.read("１２３"), null);
  assert.strictEqual(r.read(undefined), null);
  assert.strictEqual(r.read(null), null);
  assert.strictEqual(r.read(123), null);
});

test("reader：missed 会计上返回 null 的次数", () => {
  const r = LK.createReader({ dict: {} });
  r.read("");
  r.read("...");
  r.read("光");
  assert.strictEqual(r.stats().missed, 3);
});

test("reader：stats 五种计数各自独立", () => {
  const r = LK.createReader({ dict: { clover: "クローバー" } });
  r.read("clover"); // dict
  r.read("sekai"); // romaji
  r.read("light"); // rule
  r.addOnline("sorairo", "ソライロ");
  r.read("sorairo"); // online
  r.read(""); // missed
  const s = r.stats();
  assert.strictEqual(s.dictHits, 1);
  assert.strictEqual(s.romajiHits, 1);
  assert.strictEqual(s.ruleHits, 1);
  assert.strictEqual(s.onlineHits, 1);
  assert.strictEqual(s.missed, 1);
});

test("reader：stats 返回副本，改它不影响内部计数", () => {
  const r = LK.createReader({ dict: {} });
  r.read("sekai");
  const s = r.stats();
  s.romajiHits = 999;
  assert.strictEqual(r.stats().romajiHits, 1);
});

test("reader：log 只在传了函数时才调用", () => {
  const seen = [];
  const r = LK.createReader({
    dict: {},
    log: function (msg) {
      seen.push(msg);
    },
  });
  r.read("sekai");
  assert.ok(seen.length > 0);
  assert.ok(seen.join(" ").indexOf("romaji") >= 0);
  // 没传 log 时不能炸
  const r2 = LK.createReader({ dict: {} });
  assert.doesNotThrow(function () {
    r2.read("sekai");
  });
});

// ============================================================ addOnline

test("addOnline：接受纯片假名，之后 read 返回 online", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.addOnline("clover", "クローバー"), true);
  const got = r.read("clover");
  assert.strictEqual(got.source, "online");
  assert.strictEqual(got.kana, "クローバー");
  assert.strictEqual(got.confident, true);
});

test("addOnline：接受带长音符的片假名", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.addOnline("computer", "コンピューター"), true);
  assert.strictEqual(r.read("computer").source, "online");
  assert.strictEqual(r.read("computer").kana, "コンピューター");
});

test("addOnline：拒绝非片假名（英文、汉字、混排）", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.addOnline("clover", "clover"), false);
  assert.strictEqual(r.addOnline("clover", "光"), false);
  assert.strictEqual(r.addOnline("clover", "アabc"), false);
  assert.strictEqual(r.addOnline("clover", "クローバー!"), false);
  assert.strictEqual(r.addOnline("clover", "クロ バー"), false);
  // 被拒绝的不能留在表里
  assert.notStrictEqual(r.read("clover").source, "online");
});

test("addOnline：拒绝空串和非法 word", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.addOnline("", "ア"), false);
  assert.strictEqual(r.addOnline("   ", "ア"), false);
  assert.strictEqual(r.addOnline("...", "ア"), false);
  assert.strictEqual(r.addOnline("clover", ""), false);
  assert.strictEqual(r.addOnline(undefined, "ア"), false);
  assert.strictEqual(r.addOnline("clover", undefined), false);
});

test("addOnline：查表也能折掉非字母（e-mail -> email）", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.addOnline("email", "イーメール"), true);
  assert.strictEqual(r.read("email").source, "online");
  assert.strictEqual(r.read("email").kana, "イーメール");
  // word 里的连字符在 addOnline 里会被折掉，所以写进去之后
  // 读 "email" 和读 "e-mail" 都能命中同一个读音
  const r2 = LK.createReader({ dict: {} });
  assert.strictEqual(r2.addOnline("e-mail", "イーメール"), true);
  assert.strictEqual(r2.read("email").source, "online");
  assert.strictEqual(r2.read("e-mail").kana, "イーメール");
  assert.strictEqual(r2.read("E-Mail!").source, "online");
});

test("addOnline：dict 命中仍然优先于 online", () => {
  const r = LK.createReader({ dict: { clover: "クローバー" } });
  r.addOnline("clover", "クロバー");
  const got = r.read("clover");
  assert.strictEqual(got.source, "dict");
  assert.strictEqual(got.kana, "クローバー");
});

test("addOnline：写成片假名后读同一处的次数会累加", () => {
  const r = LK.createReader({ dict: {} });
  r.addOnline("sorairo", "ソライロ");
  r.read("sorairo");
  r.read("SORAIRO");
  assert.strictEqual(r.stats().onlineHits, 2);
});

// ============================================================ 边界

test("边界：带连字符的词不抛异常", () => {
  const r = LK.createReader({ dict: {} });
  const samples = ["e-mail", "x-ray", "-", "-a-", "a--b", "co-op", "don't", "rock'n'roll"];
  for (let i = 0; i < samples.length; i++) {
    assert.doesNotThrow(function () {
      r.read(samples[i]);
    }, samples[i]);
    assert.doesNotThrow(function () {
      LK.englishToKatakana(samples[i]);
    }, samples[i]);
    assert.doesNotThrow(function () {
      LK.romajiToKatakana(samples[i]);
    }, samples[i]);
  }
});

test("边界：超长词不抛异常、不死循环、有结果", () => {
  const long = new Array(500).join("a");
  const r = LK.createReader({ dict: {} });
  const got = r.read(long);
  assert.ok(got !== null);
  assert.ok(got.kana.length > 0);
  assert.doesNotThrow(function () {
    LK.romajiToKatakana(long);
  });
  const longEn = "pneumonoultramicroscopicsilicovolcanoconiosis";
  assert.doesNotThrow(function () {
    LK.englishToKatakana(longEn);
  });
  assert.ok(LK.englishToKatakana(longEn).kana.length > 0);
});

test("边界：数字、符号、空格混排", () => {
  const r = LK.createReader({ dict: {} });
  const samples = ["123", "12ab34", "!!!", " ", "\t", "@#$%", "ａｂｃ"];
  for (let i = 0; i < samples.length; i++) {
    assert.doesNotThrow(function () {
      r.read(samples[i]);
    }, samples[i]);
  }
  // 混了字母的仍然要有读音
  assert.ok(r.read("12ab34").kana.length > 0);
  // 全角字母不是 [A-Za-z]，读不到就返回 null，不能硬拼
  assert.strictEqual(r.read("ａｂｃ"), null);
});

test("边界：stats 初值都是 0", () => {
  const r = LK.createReader({ dict: {} });
  assert.deepStrictEqual(r.stats(), {
    dictHits: 0,
    romajiHits: 0,
    ruleHits: 0,
    onlineHits: 0,
    missed: 0,
  });
});

test("边界：多个 reader 之间互不干扰", () => {
  const a = LK.createReader({ dict: { clover: "クローバー" } });
  const b = LK.createReader({ dict: {} });
  a.addOnline("clover", "クロバー");
  // a 有 dict，仍然是 dict 优先；b 没 dict，走规则
  assert.strictEqual(a.read("clover").source, "dict");
  assert.strictEqual(b.read("clover").source, "rule");
  // online 表也是各自独立的
  a.addOnline("xylophone", "シロフォン");
  assert.strictEqual(a.read("xylophone").source, "online");
  assert.strictEqual(b.read("xylophone").source, "rule");
  assert.strictEqual(a.stats().onlineHits, 1);
  assert.strictEqual(b.stats().onlineHits, 0);
});

test("边界：dict 里塞了空值不会把结果读成空串", () => {
  const r = LK.createReader({ dict: { clover: "" } });
  const got = r.read("clover");
  assert.ok(got.kana.length > 0);
  assert.notStrictEqual(got.source, "dict");
});
