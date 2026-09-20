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
  // she：sh -> シ，词尾 e 是默字，不补长音（参照 sljfaq：词尾 e 不发音）
  assert.strictEqual(LK.englishToKatakana("she").kana, "シ");
  // cheese：ch -> チ、ee -> イー、词尾 se 里 s + 默字 e -> セ
  // （s 在词尾读 /s/ 不是 /z/，所以是 セ 不是 ズ；/z/ 要靠词表）
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
  // ① 拼写读不出音的元音块：ow 在 now / snow 里读法不同
  //    （参照 sljfaq 的 "Conversions based on spelling" 那节）
  assert.strictEqual(LK.englishToKatakana("now").confident, false);
  // ② th：页面对 θ（-> サ行）和 ð（-> ザ行）都有明确落点，所以**读音**
  //    照规则给；但「哪个词是 θ、哪个是 ð」拼写分不出来 —— 仍然算不放心。
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

// ============================================================ 首音校验

test("首音校验：拦住拟声词/意译，不误伤默字组合", () => {
  // 用户报的：tick 注成 カチカチ（Google 的 en→ja 会把它当拟声词回）
  const V = LK.looksLikeTransliteration;
  const rejected = [
    ["tick", "カチカチ"],
    ["tick", "ダニ"], // 名词义（蜱虫）
    ["love", "アイ"], // 意译
    ["beat", "コドウ"],
    ["light", "ヒカリ"],
  ];
  for (const [w, k] of rejected) assert.strictEqual(V(w, k), false, w + " / " + k + " 该拦下");
  const accepted = [
    ["tick", "ティック"],
    ["tick", "チック"],
    ["love", "ラブ"],
    ["beat", "ビート"],
    ["knock", "ノック"],
    ["light", "ライト"],
    ["guitar", "ギター"],
    ["piano", "ピアノ"],
    ["dance", "ダンス"],
    ["zoom", "ズーム"],
    // 同一个字母有好几行的（软/硬音、默字组合）都要放行，否则会错杀正确答案
    ["think", "シンク"], // th -> サ行
    ["phone", "フォン"], // ph -> ファ行
    ["gem", "ジェム"], // 软 g -> ジ行
    ["George", "ジョージ"],
    ["giant", "ジャイアント"],
    ["chat", "チャット"], // ch -> チ
    ["city", "シティ"], // c -> サ行
    ["cat", "キャット"], // c -> カ行
    // 默字/不规则开头的组合一律不校验（宁可漏，不可错杀）
    ["knife", "ナイフ"],
    ["psychology", "サイコロジー"],
    ["write", "ライト"],
    ["hour", "アワー"],
    ["honest", "オネスト"],
    ["yell", "エール"],
    ["one", "ワン"],
  ];
  for (const [w, k] of accepted) assert.strictEqual(V(w, k), true, w + " / " + k + " 不该拦");
  // 边界：空值一律放行（不校验），别把异常输入当成"不合法答案"
  assert.strictEqual(V("", "ライト"), true);
  assert.strictEqual(V("tick", ""), true);
  assert.strictEqual(V(null, null), true);
});

// ============================================================ 缩写：词干 + 尾巴

test("缩写：'s / 're / 'll / 'd / 've / 'm / n't 都要读对", () => {
  // 用户报的：you're / I'll / it's / I'd 注不准。
  // 根因是折掉撇号之后撞上别的词条（I'll -> ill、I'd -> id），
  // 所以缩写必须排在词典前面。词典里故意塞了 ill / id 当"陷阱"。
  const r = LK.createReader({
    dict: {
      ill: "イル",
      id: "アイディー",
      i: "アイ",
      you: "ユー",
      we: "ウィー",
      they: "ゼイ",
      he: "ヒー",
      she: "シー",
      it: "イット",
      is: "イズ",
      that: "ザット",
      let: "レット",
      there: "ゼア",
      who: "フー",
      do: "ドゥー",
      ca: "シーエー",
      sarah: "サラ",
    },
  });
  const cases = [
    ["you're", "ユア"],
    ["we're", "ウィア"],
    ["they're", "ゼア"],
    ["I'll", "アイル"],
    ["you'll", "ユール"],
    ["we'll", "ウィル"],
    ["he'll", "ヒール"],
    ["it'll", "イットル"],
    ["I'd", "アイド"],
    ["you'd", "ユード"],
    ["I've", "アイブ"],
    ["I'm", "アイム"],
    ["it's", "イッツ"],
    ["that's", "ザッツ"],
    ["let's", "レッツ"],
    ["he's", "ヒーズ"],
    ["she's", "シーズ"],
    ["there's", "ゼアズ"],
    ["Sarah's", "サラズ"],
    ["don't", "ドント"],
    ["can't", "キャント"],
    ["won't", "ウォント"],
    ["isn't", "イズント"],
    ["couldn't", "クドント"],
    ["shouldn't", "シュドント"],
    ["y'all", "ヨール"],
  ];
  for (const [word, want] of cases) {
    const got = r.read(word);
    assert.ok(got, word + " 应该读得出来");
    assert.strictEqual(got.kana, want, word);
  }
  // 关键的"陷阱"：绝不能因为折掉撇号就命中 ill / id
  assert.notStrictEqual(r.read("I'll").kana, "イル");
  assert.notStrictEqual(r.read("I'd").kana, "アイディー");
  // 词干走的是哪一层，来源就记哪一层（大模型那层靠 source==="rule" 决定要不要问）
  assert.strictEqual(r.read("Sarah's").source, "dict", "词干命中词典，来源就是词典");
  assert.strictEqual(r.read("zephyr's").source, "rule", "词干是规则猜的，来源就是规则");
  assert.strictEqual(r.read("zephyr's").kana.slice(-1), "ズ");
});

test("缩写的拆分与拼接（splitContraction / mergeContraction）", () => {
  const S = LK.splitContraction;
  assert.deepStrictEqual(S("you're"), { base: "you", suffix: "re", fixed: null });
  assert.deepStrictEqual(S("I'll".replace("'", "\u2019")), { base: "I", suffix: "ll", fixed: null });
  assert.deepStrictEqual(S("don't"), { base: "do", suffix: "nt", fixed: "ドント" });
  assert.deepStrictEqual(S("y'all"), { base: null, suffix: null, fixed: "ヨール" });
  assert.strictEqual(S("light"), null, "没有撇号就不是缩写");
  assert.strictEqual(S("rock'n'roll"), null, "中间夹撇号但尾巴不认识 -> 不碰");

  const M = LK.mergeContraction;
  assert.strictEqual(M("イット", "s"), "イッツ", "t 结尾并成 ツ");
  assert.strictEqual(M("キッド", "s"), "キッズ", "d 结尾并成 ズ");
  assert.strictEqual(M("ヒー", "s"), "ヒーズ", "其它直接接 ズ");
  assert.strictEqual(M("ユー", "re"), "ユア", "长音收掉再接 ア");
  assert.strictEqual(M("アイ", "ll"), "アイル");
  assert.strictEqual(M("アイ", "d"), "アイド");
  assert.strictEqual(M("アイ", "ve"), "アイブ");
  assert.strictEqual(M("アイ", "m"), "アイム");
  assert.strictEqual(M("ド", "nt"), "ドント");
});

// ============================================================ 记号逐字母

test("记号：逐字母读（字母名），分隔符不发音、& 读 アンド", () => {
  const r = LK.createReader({ dict: {} });
  const cases = [
    ["D/N/A", "ディーエヌエー"],
    ["N/A", "エヌエー"],
    ["A.B.C", "エービーシー"],
    ["R&B", "アールアンドビー"],
    ["X-Y", "エックスワイ"],
    ["U.S.A", "ユーエスエー"],
  ];
  for (const [word, want] of cases) {
    const got = r.read(word);
    assert.ok(got, word + " 应该有读音");
    assert.strictEqual(got.kana, want, word);
    assert.strictEqual(got.source, "letters", word + " 的来源应该是 letters");
    assert.strictEqual(got.confident, true, word + " 逐字母是确定的");
  }
});

test("记号优先于词典：N/A 不能因为 na 在词典里就读成 ナ", () => {
  const r = LK.createReader({ dict: { na: "ナ", xy: "クスィ" } });
  const na = r.read("N/A");
  assert.strictEqual(na.kana, "エヌエー", "N/A 不能读成 ナ");
  assert.strictEqual(na.source, "letters");
  assert.strictEqual(r.read("X-Y").kana, "エックスワイ", "X-Y 不能读成 クスィ");
  // 普通词照旧走词典
  assert.strictEqual(r.read("na").kana, "ナ");
  assert.strictEqual(r.read("na").source, "dict");
});

test("不是记号的连字符词照旧按单词读（x-ray 不能逐字母念）", () => {
  const r = LK.createReader({ dict: {} });
  const x = r.read("x-ray");
  assert.notStrictEqual(x.source, "letters", "x-ray 是词不是记号");
  assert.notStrictEqual(x.kana, "エックスアールエーワイ");
  // 字母名表本身也要齐全、边界要挡住
  assert.strictEqual(LK.lettersToKatakana("abc"), "エービーシー");
  assert.strictEqual(LK.lettersToKatakana("a"), null, "单字母不走这条");
  assert.strictEqual(LK.lettersToKatakana("&"), null, "只有 & 不算");
  assert.strictEqual(LK.lettersToKatakana("abcdefghijklm"), null, "太长的不当记号");
});

// ============================================================ 缩写

test("全大写的无元音缩写逐字母读（LDK / TV / BGM …）", () => {
  // 用户报的：LDK 被规则拼成 ラダク、TV 拼成 タブ
  const r = LK.createReader({ dict: { cm: "シーエム" } });
  const cases = [
    ["LDK", "エルディーケー"],
    ["NHK", "エヌエイチケー"],
    ["CD", "シーディー"],
    ["TV", "ティーブイ"],
    ["BGM", "ビージーエム"],
    ["RPG", "アールピージー"],
    ["DVD", "ディーブイディー"],
  ];
  for (const [word, want] of cases) {
    const got = r.read(word);
    assert.strictEqual(got.kana, want, word);
    assert.strictEqual(got.source, "letters", word + " 应该记在 letters 这一类");
    assert.strictEqual(got.confident, true, word);
  }
  // 词典里已有的缩写仍然走词典（不冲突）
  assert.strictEqual(r.read("CM").source, "dict");
  assert.strictEqual(r.read("CM").kana, "シーエム");
});

test("逐字母缩写的判据不能误伤真词（my / sky / why / hmm / Ldk）", () => {
  const A = LK.spellOutAcronym;
  assert.strictEqual(A("LDK"), "エルディーケー");
  assert.strictEqual(A("TV"), "ティーブイ");
  /*
   * y 也算元音：my / sky / why / fly 这些是真词。
   * 有元音的缩写要多过两道闸门（不在词典里、不在英文常用词表里），
   * 所以这里把两张表都递进去 —— 真机就是这样的（reading 层从 reader 拿到它们）。
   */
  const dict = { my: "マイ", sky: "スカイ", why: "ワイ" };
  const en = { fly: true };
  assert.strictEqual(A("MY", dict, en), null);
  assert.strictEqual(A("SKY", dict, en), null);
  assert.strictEqual(A("WHY", dict, en), null);
  assert.strictEqual(A("FLY", dict, en), null, "英文词表里的也不算缩写");
  // 有元音、两张表都没有、也切不成罗马音的才是缩写（用户报的 SOS / QTE）
  assert.strictEqual(A("SOS", dict, en), "エスオーエス");
  assert.strictEqual(A("QTE", dict, en), "キューティーイー");
  // 小写感叹词不算缩写（hmm / tsk / shh）
  assert.strictEqual(A("hmm"), null);
  assert.strictEqual(A("tsk"), null);
  // 混大小写不算（缩写就是全大写写的）
  assert.strictEqual(A("Ldk"), null);
  // 长度边界：6 个字母还算缩写，7 个就不猜了
  assert.strictEqual(A("BCDFGH"), "ビーシーディーエフジーエイチ", "6 个字母还是缩写");
  assert.strictEqual(A("BCDFGHJ"), null, "7 个字母不当缩写");
  assert.strictEqual(A("A"), null, "单个字母不走这条");
  assert.strictEqual(A("D/N/A"), null, "记号有自己的路径");
});

// ============================================================ 变音符号

test("变音符号折叠：长音符 ā ē ī ō ū 折成「元音 + -」（= 长音）", () => {
  const f = LK.foldLatin;
  assert.deepStrictEqual(f("Tōkyō"), { text: "to-kyo-", pureMacron: true });
  assert.deepStrictEqual(f("kōhī"), { text: "ko-hi-", pureMacron: true });
  assert.deepStrictEqual(f("Ō"), { text: "o-", pureMacron: true });
  assert.strictEqual(f("light"), null, "没有变音符号就返回 null（走原路）");
  assert.strictEqual(f(""), null);
  // 别的变音符号折成基础字母，并且**不算** pureMacron
  assert.deepStrictEqual(f("Café"), { text: "cafe", pureMacron: false });
  assert.deepStrictEqual(f("déjà"), { text: "deja", pureMacron: false });
  assert.deepStrictEqual(f("José"), { text: "jose", pureMacron: false });
  assert.deepStrictEqual(f("äöüß"), { text: "aouss", pureMacron: false });
});

test("日语罗马字的长音符按罗马音读：Tōkyō -> トーキョー", () => {
  const r = LK.createReader({ dict: { tokyo: "トウキョウ" } });
  // 长音符是"日语罗马字"的标志，按罗马音读更贴近唱出来的音，所以排在词典前面
  assert.deepStrictEqual(r.read("Tōkyō"), { kana: "トーキョー", source: "romaji", confident: true });
  assert.deepStrictEqual(r.read("kōhī"), { kana: "コーヒー", source: "romaji", confident: true });
  assert.deepStrictEqual(r.read("arigatō"), { kana: "アリガトー", source: "romaji", confident: true });
  assert.deepStrictEqual(r.read("Ō"), { kana: "オー", source: "romaji", confident: true });
  assert.deepStrictEqual(r.read("Ōkami"), { kana: "オーカミ", source: "romaji", confident: true });
});

test("别的变音符号：词典优先，读不准的标 confident:false 交给大模型", () => {
  const r = LK.createReader({ dict: { cafe: "カフェ", jose: "ホセ" } });
  assert.deepStrictEqual(r.read("Café"), { kana: "カフェ", source: "dict", confident: true });
  assert.deepStrictEqual(r.read("José"), { kana: "ホセ", source: "dict", confident: true });

  // 词典里没有的：走罗马音/规则，但**必须**标不放心（读音取决于语种，José 是 ホセ 不是 ジョセ）
  const r2 = LK.createReader({ dict: {} });
  const deja = r2.read("déjà");
  assert.strictEqual(deja.kana, "デジャ");
  assert.strictEqual(deja.confident, false, "非长音符的变音符号要交给上层校正");
  // 关键回归：折叠写法不能再去撞"去掉非字母"那一档键（déjà -> dj -> ディージェイ）
  const r3 = LK.createReader({ dict: { dj: "ディージェイ" } });
  assert.strictEqual(r3.read("déjà").kana, "デジャ", "déjà 不能被读成 DJ");
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

// ============================================================ 首音校验

test("首音校验：th 的两种读法都放行（the ザ / think シンク），拟声词照样拦", () => {
  // 用户报的「把模型提到最前面，the 还是セ」：真模型对 the 回的就是 **ザ**（实测），
  // 但校验表里 t 开头只放了サ行（θ 的 think/three），漏了 ð 的 the/this/that/they ——
  // 于是唯一被拒的答案就是 the，回落到规则层的 セ。
  for (const [w, k] of [
    ["the", "ザ"],
    ["this", "ジ"],
    ["this", "ディス"], // 词典自己就是这么写的，绝不能拒
    ["that", "ザッ"],
    ["they", "ゼイ"],
    ["there", "ゼア"],
    ["think", "シンク"],
    ["three", "スリー"],
    ["tick", "ティック"],
    ["take", "テイク"],
  ]) {
    assert.strictEqual(LK.looksLikeTransliteration(w, k), true, w + " -> " + k + " 不该被拒");
  }
  // 词首不发音的组合：m 不发音的 mn（memo 这种正常 m 不受影响）、
  // p 不发音的 pn、Ng 开头的姓名
  for (const [w, k] of [
    ["mnemonic", "ニモニック"],
    ["pneumonia", "ニューモニア"],
    ["nguyen", "グエン"],
    ["memo", "メモ"],
    ["phone", "フォン"],
    ["psychology", "サイコロジー"],
  ]) {
    assert.strictEqual(LK.looksLikeTransliteration(w, k), true, w + " -> " + k + " 不该被拒");
  }
  // tick -> カチカチ 是拟声词/意译，仍然要拦住（这是这条校验存在的理由）
  assert.strictEqual(LK.looksLikeTransliteration("tick", "カチカチ"), false);
  assert.strictEqual(LK.looksLikeTransliteration("kaleidoscope", "ダニ"), false);
  // 没把握的首字母（h/w/y/元音）一律不校验
  assert.strictEqual(LK.looksLikeTransliteration("hour", "アワー"), true);
  assert.strictEqual(LK.looksLikeTransliteration("write", "ライト"), true);
});

// ============================================================ -ize / -yze

test("词尾 -ize / -yze：读「辅音 + イズ」，不许被罗马音层抢成 メモリゼ", () => {
  // 用户截图里的 `memorize` 被标成 メモリゼ —— 那是**罗马音层**抢答的
  // （me-mo-ri-ze 切得干净），而日语罗马字里根本没有 -ize 结尾的动词。
  // 现在罗马音层直接拒绝这种形状，交给规则层的 EN_IZE：辅音并入 a，读成「…イズ」。
  const r = LK.createReader({ dict: {}, enWords: null });
  assert.strictEqual(r.read("memorize").source, "rule", "memorize 不该走罗马音层");
  for (const [w, kana] of [
    ["memorize", "メモライズ"],
    ["memorized", "メモライズド"],
    ["memorizing", "メモライジング"],
    ["organize", "オーガナイズ"],
    ["apologize", "アポロジャイズ"], // 软音 g -> ジャ
    ["criticize", "クリティサイズ"], // 软音 c -> サ
    ["analyze", "アナライズ"],
    ["paralyze", "パラライズ"],
    ["fantasize", "ファンタサイズ"],
  ]) {
    assert.strictEqual(LK.englishToKatakana(w).kana, kana, w);
  }
  // 词干是空的（size / prize 这种词根）不走这条，免得把 s 当尾巴读出"サイズ"
  assert.ok(LK.englishToKatakana("size").kana.length > 0);
  assert.notStrictEqual(LK.englishToKatakana("size").kana, "サ\u30A4\u30BA\u30A4\u30BA");
});

// ============================================================ 缩写与元音串

test("全大写缩写：无元音的照旧，有元音但既不是词、也切不成罗马音的也逐字母", () => {
  // 用户截图里 `SOS` 被读成 ソス、`QTE` 读成 クテ —— 都错。
  // 新判据放两条进来（都要过两道闸门）：不是词典里的词、罗马音也切不出来。
  const r = LK.createReader({ dict: {} });
  for (const [w, kana] of [
    ["SOS", "エスオーエス"],
    ["QTE", "キューティーイー"],
    ["YY", "ワイワイ"],
    ["LDK", "エルディーケー"],
    ["TV", "ティーブイ"],
  ]) {
    const got = r.read(w);
    assert.strictEqual(got.kana, kana, w);
    assert.strictEqual(got.source, "letters", w + " 该走字母名那条");
  }
  // 反向：全大写但罗马音切得出来的日语罗马字（SORA / KIMI）不能念字母
  assert.strictEqual(r.read("SORA").source, "romaji", "SORA 是日语罗马字，不能念字母");
  assert.strictEqual(r.read("SORA").kana, "ソラ");
  assert.strictEqual(r.read("KIMI").kana, "キミ");
  // 全大写但词典里有这个词的（LOVE / OK）：也不念字母
  const r2 = LK.createReader({ dict: { love: "ラブ", ok: "オーケー" } });
  assert.strictEqual(r2.read("LOVE").kana, "ラブ");
  assert.strictEqual(r2.read("OK").kana, "オーケー");
});

test("同一个元音重复成串：按那个元音叠出来（AAAAA -> アアアアア）", () => {
  // 用户截图：`邪魔者は成敗いたAAAAAす！` 里的 AAAAA 一个音都没标。
  // 它是喊叫/拖长音，不是词 —— 词典里 `aaa` 是 トリプルエー、规则也会读歪。
  const r = LK.createReader({ dict: { aaa: "トリプルエー" } });
  const cases = [
    ["AAAAA", "アアアアア"],
    ["aaa", "アアア"],
    ["OOO", "オオオ"],
    ["ii", "イイ"],
  ];
  for (const [w, kana] of cases) {
    const got = r.read(w);
    assert.strictEqual(got.kana, kana, w);
    assert.strictEqual(got.source, "letters", w + " 是形态层的确定答案，不该去问模型");
  }
  // 辅音串仍然不标（XX 是打码）—— 这条在 matcher 那一层（latin.test.js 里锁着），
  // 这里的 reader 只负责"有读音就给出"，插不插到页面上由 annotate 层决定。
  assert.strictEqual(r.read("XX").kana, "エックスエックス");
});

test("词尾 -ude：读「辅音 + ウー + ド」，不许被罗马音层切成 ジュデ", () => {
  // 用户截图（Ave Mujica 的歌）：`KiLLKiSS jude...` 里的 jude 被罗马音层
  // 切成 ju-de 读成 ジュデ。英语 -ude 的 e 不发音、u 是长音
  // （jude ジュード、rude ルード、gratitude グラティテュード）。
  const r = LK.createReader({ dict: {}, enWords: null });
  assert.strictEqual(r.read("jude").source, "rule", "jude 不该走罗马音层");
  for (const [w, kana] of [
    ["jude", "ジュード"],
    ["rude", "ルード"],
    ["gratitude", "グラティテュード"],
    ["solitude", "ソリテュード"],
    ["magnitude", "マグニテュード"],
    ["interlude", "インタールード"],
  ]) {
    assert.strictEqual(LK.englishToKatakana(w).kana, kana, w);
  }
  // du / tu 按日语惯例读 デュ / テュ（dude デュード、attitude アティテュード）
  assert.strictEqual(LK.englishToKatakana("dude").kana, "デュード");
  // 词干为空的 -ize 也要能读（size / prize，词典里本来就有，规则层不能崩）
  assert.strictEqual(LK.englishToKatakana("size").kana, "サイズ");
  assert.strictEqual(LK.englishToKatakana("prize").kana, "プライズ");
});

// ============================================================ 不发音字母

test("词首不发音的字母：kn- / wr- / gn- / ps- / pn- 不许读出来", () => {
  // 用户报的 `Knock knock!` 被规则读成「ナオック」（k 是哑音）。
  // 这几组在英语里从不发音，整组丢掉首字母就对了。
  for (const [w, kana] of [
    ["knock", "ノック"],
    ["knit", "ニット"],
    ["knob", "ノブ"],
    ["knot", "ノット"],
    ["knack", "ナック"],
    ["wrap", "ラップ"],
    ["wreck", "レック"],
    ["gnat", "ナット"],
    ["gnaw", "ナウ"],
    ["wring", "リン"], // w 哑
  ]) {
    assert.strictEqual(LK.englishToKatakana(w).kana, kana, w);
  }
  // 词首那一格绝不能再出现 kn/wr/gn 的第一个音（ナ/ラ/グ 之类）
  for (const w of ["knee", "kneel", "knife", "knight", "write", "wrong", "wrist", "gnome"]) {
    const kana = LK.englishToKatakana(w).kana;
    assert.ok(!/^[クラグ]/.test(kana), w + " 的首字母是哑音，不能读出来：" + kana);
  }
});

test("词尾 -mb：b 不发音（comb / climb / lamb / bomb / thumb）", () => {
  for (const w of ["comb", "climb", "lamb", "bomb", "thumb", "tomb", "dumb", "crumb", "rhomb", "aplomb", "coomb"]) {
    const kana = LK.englishToKatakana(w).kana;
    // 词尾不能落在バ行上（老引擎的错法：bomb ボンブ、climb クルンブ）。
    // 词首的 b 该读还得读（bomb 的 ボ 是对的），所以只看结尾。
    assert.ok(!/[バビブベボ]$/.test(kana), w + " 词尾的 b 不发音，不该以バ行收尾：" + kana);
  }
  // 词中的 mb 不能一起哑掉：number / amber / timber 的 b 是发音的
  for (const [w, kana] of [
    ["number", "ヌンバー"],
    ["amber", "アンバー"],
    ["timber", "ティンバー"],
  ]) {
    assert.strictEqual(LK.englishToKatakana(w).kana, kana, w + " 词中的 b 要读出来");
  }
});

// ============================================================ 边界

test("边界：stats 初值都是 0", () => {
  const r = LK.createReader({ dict: {} });
  assert.deepStrictEqual(r.stats(), {
    dictHits: 0,
    letterHits: 0,
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

// ============================================================ 罗马音 vs 英文词

test("罗马音：在英文词表里的（shake/open）标成没把握，好让在线层仲裁", () => {
  // 罗马音层只判"整串能不能切干净"，于是 shake(sha-ke) -> シャケ、open -> オペン
  // 这种英文词会被当成日语罗马字；而层序里罗马音排在大模型前面，它一答就没人能纠。
  const enWords = { shake: true, open: true };
  const r = LK.createReader({ dict: {}, enWords: enWords });
  const got = r.read("shake");
  assert.strictEqual(got.source, "romaji");
  assert.strictEqual(got.kana, "シャケ", "读音本身还是罗马音切的（等在线层回来再换）");
  assert.strictEqual(got.confident, false, "要标成没把握");
  assert.strictEqual(r.read("open").confident, false);
});

test("罗马音：真正的日语罗马字不受影响（sekai / kaze 仍然是确定的）", () => {
  const enWords = { shake: true, open: true };
  const r = LK.createReader({ dict: {}, enWords: enWords });
  for (const w of ["sekai", "kaze", "shinjiteru"]) {
    const got = r.read(w);
    assert.strictEqual(got.source, "romaji", w);
    assert.strictEqual(got.confident, true, w + " 不该被误判成英文词");
  }
});

test("罗马音：不传英文词表时行为跟以前一样（罗马音一律算确定）", () => {
  const r = LK.createReader({ dict: {} });
  assert.strictEqual(r.read("shake").confident, true);
});

test("边界：dict 里塞了空值不会把结果读成空串", () => {
  const r = LK.createReader({ dict: { clover: "" } });
  const got = r.read("clover");
  assert.ok(got.kana.length > 0);
  assert.notStrictEqual(got.source, "dict");
});

// ============================================================ 层序（用户可调）

test("层序：默认是 dict > romaji > rule", () => {
  const r = LK.createReader({ dict: {} });
  assert.deepStrictEqual(r.getOrder(), ["dict", "romaji", "rule"]);
});

test("层序：把 romaji 提到词典前面，罗马音命中就压倒词典", () => {
  // sekai 既是合法罗马音、又在词典里 —— 正好用来看谁优先
  const dict = { sekai: "セカイデハナイ" };
  const byDict = LK.createReader({ dict: dict });
  assert.strictEqual(byDict.read("sekai").source, "dict");
  assert.strictEqual(byDict.read("sekai").kana, "セカイデハナイ");

  const byRomaji = LK.createReader({ dict: dict, order: ["romaji", "dict", "rule"] });
  const got = byRomaji.read("sekai");
  assert.strictEqual(got.source, "romaji");
  assert.strictEqual(got.kana, "セカイ");
});

test("层序：把 rule 提到最前面，规则层就压过词典和罗马音", () => {
  const r = LK.createReader({ dict: { sekai: "セカイデハナイ" }, order: ["rule", "dict", "romaji"] });
  const got = r.read("sekai");
  assert.strictEqual(got.source, "rule", "规则层排在前面就该由它说了算");
  assert.notStrictEqual(got.kana, "セカイデハナイ");
});

test("层序：rule 排最后时，词典/罗马音都给不出答案才轮到它", () => {
  const r = LK.createReader({ dict: { clover: "クローバー" }, order: ["romaji", "dict", "rule"] });
  assert.strictEqual(r.read("clover").source, "dict", "罗马音切不出来的词仍然归词典");
  assert.strictEqual(r.read("zxqwk").source, "rule", "谁都不认识才落到规则");
});

test("层序：运行时 setOrder 立刻生效，getOrder 返回副本", () => {
  const r = LK.createReader({ dict: { sekai: "セカイデハナイ" } });
  assert.strictEqual(r.read("sekai").source, "dict");
  r.setOrder(["romaji", "dict", "rule"]);
  assert.strictEqual(r.read("sekai").source, "romaji");
  const got = r.getOrder();
  got[0] = "rule";
  assert.deepStrictEqual(r.getOrder(), ["romaji", "dict", "rule"], "getOrder 不能把内部数组漏出去");
});

test("层序：脏配置不会让层变少（去重 + 缺的补在后面）", () => {
  const r = LK.createReader({ dict: {} });
  r.setOrder(["rule", "rule", "不存在的层"]);
  assert.deepStrictEqual(r.getOrder(), ["rule", "dict", "romaji"]);
  r.setOrder([]);
  assert.deepStrictEqual(r.getOrder(), ["dict", "romaji", "rule"], "空数组要退回默认顺序");
  r.setOrder(null);
  assert.deepStrictEqual(r.getOrder(), ["dict", "romaji", "rule"]);
});

test("层序：形态层（记号 / 缩写 / 长音符罗马字）不受排序影响", () => {
  // 这三类决定的不是"读音该信谁"，而是"这个词该怎么断"，永远最先
  const r = LK.createReader({ dict: { dna: "ディーエヌエー" }, order: ["rule", "romaji", "dict"] });
  assert.strictEqual(r.read("D/N/A").source, "letters", "记号永远先判");
  assert.strictEqual(r.read("D/N/A").kana, "ディーエヌエー");
  const r2 = LK.createReader({ dict: { ill: "イル" }, order: ["rule", "romaji", "dict"] });
  assert.strictEqual(r2.read("I'll").source, "rule", "缩写拆出来的词干按当轮层序读，但拆词本身先做");
  const r3 = LK.createReader({ dict: { tokyo: "トウキョウ" }, order: ["rule", "romaji", "dict"] });
  assert.strictEqual(r3.read("Tōkyō").source, "romaji", "长音符就是罗马字，先于其它层判定");
  assert.strictEqual(r3.read("Tōkyō").kana, "トーキョー");
});
