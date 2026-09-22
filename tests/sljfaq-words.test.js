/*
 * sljfaq 例子表 —— 按参考页自己的例子核对规则层。
 *
 * 参考页：sci.lang.japan FAQ
 *   How do I write an English word in Japanese?
 *   https://www.sljfaq.org/afaq/english-in-japanese.html
 *
 * 和其他测试的分工：其他测试钉「实现里的规则」，这个文件钉「参考页给的读音」。
 * 期望值抄页面上的片假名。
 *
 * 两张表不许静默跳过：页面上的例子要么在 ROWS（逐字读对），要么在 KNOWN_GAPS
 * （拼写层读不出来，附理由）。改规则后先跑这个文件，再决定某个例子该待在左边
 * 还是右边。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const WK = require("../src/core/reading.js");

// 引擎逐字读对、且读音与参考页一致的例子
const ROWS = [
  { en: "pit", kana: "ピット" }, // ɪ -> イ + 促音
  { en: "pet", kana: "ペット" }, // ɛ -> エ + 促音
  { en: "ham", kana: "ハム" }, // æ -> ア
  { en: "cap", kana: "キャップ" }, // æ after k -> キャ + 促音（参照 sljfaq）
  { en: "london", kana: "ロンドン" }, // ʌ spelt o -> オ + n 在辅音前收 ン
  { en: "socks", kana: "ソックス" }, // ɒ -> オ + 促音
  { en: "kids", kana: "キッズ" }, // dz -> ッズ（参照 sljfaq）
  { en: "cat", kana: "キャット" }, // 首页例子
  { en: "dog", kana: "ドッグ" }, // 首页例子
  { en: "car", kana: "カー" }, // ɑː -> アー（参照 sljfaq 的非重读 r）
  { en: "park", kana: "パーク" }, // 同上（老引擎读 パラク）
  { en: "card", kana: "カード" }, // 同上
  { en: "link", kana: "リンク" }, // l -> ラ行
  { en: "right", kana: "ライト" }, // r -> ラ行
  { en: "phone", kana: "フォン" }, // əʊ -> オ；f -> フォ
  { en: "love", kana: "ラブ" }, // v -> バ行（参照 sljfaq）
  { en: "vitamin", kana: "ビタミン" }, // 英式 bitamin（参照 sljfaq 首页）
  { en: "visual", kana: "ヴィジュアル" }, // v 的备选写法 ヴィ
  { en: "win", kana: "ウィン" }, // w -> ウィ
  { en: "tourette", kana: "トゥレット" }, // tu -> トゥ（新式）
  { en: "two", kana: "トゥー" }, // tu 的另一支
  { en: "video", kana: "ビデオ" }, // v -> バ行
  { en: "prince", kana: "プリンス" }, // -ce -> ス
  { en: "dance", kana: "ダンス" }, // 同上
  { en: "castle", kana: "キャッスル" }, // -Cle -> スル
  { en: "people", kana: "ピープル" }, // -Cle -> プル
  { en: "guitar", kana: "ギター" }, // ar -> アー
  { en: "coffee", kana: "コーヒー" }, // 例外表（ff 不促音）
  { en: "camera", kana: "カメラ" }, // 例外表
  { en: "music", kana: "ミュージック" }, // 例外表
  { en: "computer", kana: "コンピューター" }, // 小表
  { en: "radio", kana: "ラジオ" }, // 小表
  { en: "piano", kana: "ピアノ" }, // 小表
  { en: "violin", kana: "バイオリン" }, // 小表（v -> バ行）
  { en: "toy", kana: "トイ" }, // ɔɪ -> オイ（页面收的短的那支）
  { en: "hamburger", kana: "ハンバーガー" }, // 词尾 ə -> アー
];

/*
 * 页面有、但拼写层读不出来的例子。每条附理由。
 * 一部分是「引擎给的结果与页面不同」，一部分是「页面本身就说要查词典」。
 */
const KNOWN_GAPS = [
  {
    en: "mug",
    kana: "マグ",
    got: "ムッグ",
    reason: "促音：参照 sljfaq，多音节词只在重读音节促音，单音节词才补 ッ；mug 是单音节，规则补了 ッ，但日语实际写 マグ（属词典形）。",
  },
  {
    en: "monkey",
    kana: "モンキー",
    got: "モンケイ",
    reason: "页面用 monkey 说明「ʌ 拼作 o 时读 オ」，但没有说词尾 ey 读 イー；ey -> エイ 是规则的通例，这个例外只能查表。",
  },
  {
    en: "front",
    kana: "フロント",
    got: "フロント",
    reason: "规则已经读对，但 -nt 的促音位置与词尾 o 的长度由词典确权（这里登记是为了说明它靠的是「n 在辅音前收 ン」那条）。",
  },
  {
    en: "book",
    kana: "ブック",
    got: "ボオック",
    reason: "ʊ 在拼写上与 uː 完全同形（book / moon），oo 这一支只能查表；页面的 book 例子正是「拼写决定不了读音」的典型。",
  },
  {
    en: "about",
    kana: "アバウト",
    got: "アボウト",
    reason: "非词尾 ə「按拼写」这句只对 pilot 这类词成立；about 的首元音按拼写是 a 却读 ə，页面坦白说这类要靠词典。",
  },
  {
    en: "pilot",
    kana: "パイロット",
    got: "ピロト",
    reason: "页面把 pilot 列为「非词尾 ə 按拼写」的例子，但开音节里的 i 读 /aɪ/ 拼写看不出来；规则给 ピロト。",
  },
  {
    en: "carrier",
    kana: "キャリアー",
    got: "クアラリアー",
    reason: "词尾非重读 ə 页面写作 アー，拼写却是 -ier；ier 规则走 イア（pierce 那一支），且 ca 在开音节读 カ 与之冲突。属词典形。",
  },
  {
    en: "shield",
    kana: "シールド",
    got: "シイーラド",
    reason: "iː -> イー 的拼写里 ie/ee/ea 都能写，shield 的 ie 在本实现里按 イー + 后面的 ld 收尾，长度与促音位置要词典确权。",
  },
  {
    en: "horse",
    kana: "ホース",
    got: "ホーセ",
    reason: "or + 辅音 -> オー 已经走通，但词尾 -se 的 s 读 /s/、e 默字这一支拼写看不出来（s 在元音间读 /z/）。",
  },
  {
    en: "door",
    kana: "ドア",
    got: "ドオー",
    reason: "页面把 door 单列在 oa 行（ドア）；oo+r 与 four / tour 同形，拼写分不出来。",
  },
  {
    en: "bird",
    kana: "バード",
    got: "ビード",
    reason: "ɜː -> アー 的元音在拼写上可以是 i/e/u/o+r，bird 的 ir 应该收 アー，本实现的 ir 分支与后面的辅音收尾交互还没修好。",
  },
  {
    en: "shoe",
    kana: "シュー",
    got: "シオー",
    reason: "uː 的拼写 oe/oo/ou/ue 都能写，shoe 的 oe 在本实现里按 オ 处理；页面的 oe 行只给了 door。",
  },
  {
    en: "cube",
    kana: "キューブ",
    got: "クベ",
    reason: "juː -> ュウ 需要把 u 读成 ユ 而不是 ウ；本实现的 cu 拼块固定读 ク，词尾默字 e 的长度也没补上。",
  },
  {
    en: "day",
    kana: "デイ",
    got: "ダイ",
    reason: "eɪ 在拼写上可以是 ay/ai/ey/eigh；本实现的 ay 分支与 a 的默认读音冲突，属尚未修好的元音块顺序问题。",
  },
  {
    en: "my",
    kana: "マイ",
    got: "マイー",
    reason: "词尾 y 在 my 里读 /aɪ/（元音 + y），在 happy 里读 イー（辅音 + y）；本实现的判断顺序把 my 归到了后者。",
  },
  {
    en: "boy",
    kana: "ボーイ",
    got: "ボイ",
    reason: "页面同时收 ɔɪ -> オーイ 与 オイ 两种写法；本实现取 オイ（短的那支）。",
  },
  {
    en: "no",
    kana: "ノー",
    got: "ノ",
    reason: "词尾 o 在这个词里是长音（页面：əʊ -> オー），但单字母 o 的默认读音是短的；两者拼写相同。",
  },
  {
    en: "now",
    kana: "ナウ",
    got: "ノウ",
    reason: "aʊ 与 əʊ 都写 ow（now / snow），拼写完全分不出来 —— 本实现按 オウ 一侧取，页面按 アウ。",
  },
  {
    en: "pierce",
    kana: "ピアス",
    got: "ピアース",
    reason: "ɪə -> イア 需要 r 不发音；本实现的 ier 分支把 r 也读进了长度。",
  },
  {
    en: "hair",
    kana: "ヘア",
    got: "ハアー",
    reason: "ɛə -> エア 的 ai 在 hair 里读 /eə/，与 rain 的 /eɪ/ 同形，拼写分不出来。",
  },
  {
    en: "tour",
    kana: "ツアー",
    got: "トアー",
    reason: "ʊə -> ウアー 要求 tu 读 ツ（页面另一支）或 トゥ；our 在 four / hour / tour 里三个读音，拼写分不出来。",
  },
  {
    en: "think",
    kana: "シンク",
    got: "シインク",
    reason: "θ -> シ 走的是 EN_TH 表（页面明写 think -> シンク），但后面 i + nk 的短音长度没压住，读成了 シインク。",
  },
  {
    en: "the",
    kana: "ザ",
    got: "セ",
    reason: "ð -> ザ行 需要把 th 判成有声；θ/ð 拼写完全同形（think / the），本实现只能按元音选一支，the 落到了 セ。",
  },
  {
    en: "singer",
    kana: "シンガー",
    got: "シンゲー",
    reason: "ŋ spelt ng + 元音 -> ンガ 走通了（シンガ），但词尾 -er 在该词里读 アー 而本实现给 エー；-er 的两个读音拼写分不出来。",
  },
  {
    en: "washington",
    kana: "ワシントン",
    got: "ワシイントン",
    reason: "专有名词：首音节 a 在英式里读 /ɒ/，本实现的 a 默认读 ア 并因后面的 i 补了长度。",
  },
  {
    en: "surfing",
    kana: "サーフィン",
    got: "スーフィン",
    reason: "ur + 辅音 -> アー 应命中（页面明写 surfing -> サーフィン），本实现的 ur 分支在这里被前面的辅音块抢先。",
  },
  {
    en: "fight",
    kana: "ファイト",
    got: "フィート",
    reason: "igh -> アイ 是页面明写的规则，但 fi 拼块先被 EN_PAIR 吃成 フィ；f 行的拼块优先级还需要调。",
  },
  {
    en: "disney",
    kana: "ディズニー",
    got: "ディサネイ",
    reason: "专有名词：词中 s 读 /z/、词尾 ey 读 イー，拼写层给 ディサネイ。仓库里用例外/小表兜。",
  },
  {
    en: "goods",
    kana: "グッズ",
    got: "ゴオッズ",
    reason: "dz -> ッズ 走通了（ッズ 在末尾），但 oo 这一支取了 オウ/オ 而不是 ウ（同 book）。",
  },
  {
    en: "tourette's syndrome",
    kana: "トゥレットシンドローム",
    got: "トゥレット / シンドローム",
    reason: "专有名词；撇号与词间空白由上层分词处理，规则层只见到 tourette（已收入小表）。",
  },
];

test("sljfaq 例子：引擎逐字读对的那些（与页面一致）", () => {
  const failures = [];
  for (const row of ROWS) {
    const got = WK.englishToKatakana(row.en).kana;
    if (got !== row.kana) failures.push(row.en + "：得到 " + got + "，页面给 " + row.kana);
  }
  assert.deepStrictEqual(failures, [], "与参考页不一致：\n  " + failures.join("\n  "));
});

test("sljfaq 例子：读不出来的那些必须登记理由（不许静默跳过）", () => {
  for (const g of KNOWN_GAPS) {
    assert.strictEqual(typeof g.en, "string");
    assert.strictEqual(typeof g.kana, "string");
    assert.ok(g.reason && g.reason.length >= 12, g.en + " 的理由太短");
  }
  // 页面上的例子只允许出现在两张表之一，且不重复
  const all = ROWS.map((r) => r.en).concat(KNOWN_GAPS.map((g) => g.en));
  const seen = {};
  for (const k of all) {
    assert.ok(!seen[k], "例子重复登记：" + k);
    seen[k] = true;
  }
  // 页面自己列出的例子必须都在这里（漏登记 = 静默跳过）
  const PAGE_EXAMPLES = [
    "pit", "pet", "ham", "cap", "mug", "monkey", "front", "london", "socks", "book",
    "about", "pilot", "carrier", "hamburger", "car", "shield", "horse", "door", "bird",
    "shoe", "cube", "day", "my", "boy", "toy", "phone", "no", "now", "pierce", "hair",
    "tour", "think", "the", "right", "link", "singer", "washington", "surfing", "love",
    "vitamin", "visual", "win", "fight", "disney", "tourette", "two", "goods", "kids",
    "cat", "dog",
  ];
  const missing = PAGE_EXAMPLES.filter((w) => !seen[w]);
  assert.deepStrictEqual(missing, [], "页面上的例子漏登记：" + missing.join(", "));
});

test("sljfaq 例子：两张表里的词都吐得出纯片假名", () => {
  // 不管读得对不对，规则层的硬契约是「输出一定是能直接标注的片假名」。
  // 允许 ァ-ヶ 与长音符 ー（小写 ャュョッ 也在 ァ-ヶ 区间里）。
  const RE = /^[\u30A1-\u30F6\u30FC]+$/;
  for (const row of ROWS.concat(KNOWN_GAPS)) {
    if (row.en.indexOf(" ") >= 0 || row.en.indexOf("'") >= 0) continue; // 多词/撇号由上层分词
    const got = WK.englishToKatakana(row.en).kana;
    assert.ok(RE.test(got), row.en + " 的输出不是纯片假名：" + JSON.stringify(got));
  }
});
