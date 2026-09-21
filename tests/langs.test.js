/*
 * core/langs.js —— 西文各语种的拼读与"整行是什么语言"。
 *
 * 断言用的是**用户给的测试用例**（7 组：德语 / 拉丁语 / 斯瓦希里语 / 俄语），
 * 期望值是"日语里通行的写法"，不是"跑出来是什么就写什么"：
 *   - 德语：w ヴ、z ツ、sch シュ、ei アイ、ie イー、双辅音不读促音
 *   - 拉丁语：古典式（c カ行、ti ティ、v ヴ、ae アエ、-um ウム、-us ウス），
 *     用户截图里的参考答案就是这一套（Vindicia ヴィンディキア、dolor ドロル）
 *   - 斯瓦希里语：开音节语言，按音节直读（Shambulia シャンブリア）
 *   - 俄语：辅音 + 元音合成一拍（Отчизну オチズヌ），软音 е/и 走 イ 段
 * 期望值写成片假名字面量（测试跑在 Node 里，不受老 CEF 的 ES5 限制）。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

// langs.js 是 UMD：Node 分支下依赖（法语引擎 / 借词表）从 globalThis 取
globalThis.WKReading = require("../src/core/reading.js");
globalThis.WKLoan = require("../src/core/loan.js");
const L = require("../src/core/langs.js");

/** 查一个词的读音（借词表优先，然后引擎） */
function read(lang, word) {
  const loan = L.word(lang, word);
  if (loan) return loan;
  const r = L.toKatakana(lang, word);
  return r ? r.kana : null;
}

// ============================================================ 语言判定

test("语言判定：用户用例 1（德语歌词里的德语行 / 英语行要分开）", () => {
  const de = [
    "die Ruinenstadt ist immer noch schön",
    "ich warte lange Zeit auf deine Rückkehr",
    "in der Hand ein Vergissmeinnicht",
    "Regentropfen sind meine Tränen",
    "Wind ist mein Atem und meine Erzählung",
    "denn mein Körper ist in Wurzeln gehüllt",
    "wenn die Jahreszeit des Tauens kommt",
    "werde ich wach und singe ein Lied",
    "erinnerst du dich noch an den Tag Andem du mir",
    // 用户截图：这行原来表里一个词都没有（只有 mit），判不出德语 → 走英文词典，
    // `mit` 命中 **MIT**（学院缩写）被念成 エムアイティー
    "Sieh mit deinen Augen",
  ];
  for (const line of de) assert.strictEqual(L.detect(line), "de", line);

  // 同一首歌里的英文行不能被德语规则带歪
  const en = [
    "It might be just like a bird in the cage",
    "How could I reach to your heart",
    "I need you to be stronger than anyone",
    "I release my soul so you feel my song",
    "It could be the whole of the problem",
    "change your body",
    "Feel my move",
  ];
  for (const line of en) assert.strictEqual(L.detect(line), null, line);
});

test("语言判定：用户用例 2 / 5 / 7（拉丁语）", () => {
  const la = [
    "Vosmet vetat res coelica",
    "Iam premet letum vastum te",
    "Vae gnari sunt suimet quis in oculis",
    "Sapientes feroces vetitum per currunt nefas",
    "Iugis solum ipsius nihil debet",
    "Credas in nullum qua sunt edicta inutile",
    "Dominatus",
    "Vae eis simulacrum in solio inanis fixere sapientes",
    "Proditi sumus a mundo",
    "Novum mundum omnibus aequum condemus",
    "Sidus album vos suscipite",
    "Terram motam vos quatite",
    "Ex ruinis ordo novus condemus",
    "In fine ab Anastasia servati sumus, aurora orietur",
    "Igni, cinis",
    "Ex ira surget",
    "In scaena salto",
    "In hoc mundo clades indiges",
    "Votum, dolor",
    "Vae victis fortunarum",
    "Vade retro, ah vanitas",
    "Et omnia vanitas",
    "Nihilum flamma",
    "Vindicia (A: Vanitatum sentio) (B: Sentio dolor, ah dolores)",
  ];
  for (const line of la) assert.strictEqual(L.detect(line), "la", line);
  // 英文行不许被当成拉丁语（-is / -at 结尾、qu 组合在英语里也很常见）
  assert.strictEqual(L.detect("What is your question"), null);
  assert.strictEqual(L.detect("It might just work"), null);
});

test("语言判定：拉丁语歌里的短句靠「整首投票」兜底（fits）", () => {
  // `Venu` / `Resurgito` / `Illusio` 这种两三个词的短行自己分数不够，
  // 但整首都是拉丁语时应该照拉丁语读（main.js 的 lineLang 用 fits 兜）。
  for (const w of ["Resurgito", "Alluceto", "Illusio", "Visio", "Votum", "Dominatus"]) {
    assert.strictEqual(L.fits("la", w), true, w);
  }
  // 英文行不能 fits 进去（有英语常用词就一票否决）
  assert.strictEqual(L.fits("la", "Feel my move"), false);
  assert.strictEqual(L.fits("la", "how could i reach"), false);
});

test("语言判定：用户用例 3 / 4（斯瓦希里语）", () => {
  const sw = [
    "Shambulia! Beba silaha",
    "Pigana mpaka mwishowe",
    "Kwa nchi yetu tutaunguza damu yoyote",
    "Rudi kwa pambaja ya dunia",
    "Hadithi yaendelea (kama moto)",
    "Ushujaa waangaza mbingu na ardhi",
    "Milele tuwangoje, na tutawaimbia",
    "Unasafirini kwa matakwa ya watu wako",
    "Mnachagueni vita kwa majina ya shujaa",
    "Tutaimba wimbo wa mwanga moto, usiku wa giza",
    "Geuka kama alfajiri",
    "Ukuu ukuu",
  ];
  for (const line of sw) assert.strictEqual(L.detect(line), "sw", line);
  // 罗马音节行（用户报过的 `PA PI PU PE PO…`）不能被当成斯瓦希里语
  assert.strictEqual(L.detect("Yes, PA PI PU PE PO POP UP! MA MI MU ME MO MORE JUMP!"), null);
});

test("语言判定：用户用例 6（俄语）+ 希腊语看字母表", () => {
  assert.strictEqual(L.detect("Мы Отчизну отстоим и восславим себя в веках"), "ru");
  assert.strictEqual(L.detect("Виват Анастасия"), "ru");
  assert.strictEqual(L.detect("Θάλασσα και ουρανός"), "el");
  assert.strictEqual(L.scriptOf("Мы"), "ru");
  assert.strictEqual(L.scriptOf("Θάλασσα"), "el");
  assert.strictEqual(L.scriptOf("clover"), null);
});

test("语言判定：法语行、日语行、纯英文行都不会被新语种抢走", () => {
  const fr = [
    "Ah, si je pouvais vivre dans l'eau,",
    "le monde serait-il plus beau ?",
    "L'eau dans son courant fait danser nos vies.",
    "Non, le grand amour ne suffit pas.",
    "Nous pardonneras-tu, ô chère mère ?",
    "Et ça ne changera jamais, jamais..",
  ];
  for (const line of fr) assert.strictEqual(L.detect(line), "fr", line);
  assert.strictEqual(L.detect("きらめく light と clover"), null);
  assert.strictEqual(L.detect("a rose is a rose is a rose"), null);
});

// ============================================================ 德语

test("德语拼读：用户用例 1 里的词", () => {
  const want = {
    die: "ディー",
    ist: "イスト",
    immer: "イマー",
    noch: "ノッホ",
    schön: "シェーン",
    ich: "イッヒ",
    warte: "ヴァルテ",
    lange: "ランゲ",
    Zeit: "ツァイト",
    auf: "アウフ",
    deine: "ダイネ",
    Rückkehr: "リュックケーア",
    in: "イン",
    der: "デア",
    Hand: "ハント",
    ein: "アイン",
    Regentropfen: "レーゲントロプフェン",
    sind: "ズィント",
    meine: "マイネ",
    Tränen: "トレーネン",
    Wind: "ヴィント",
    mein: "マイン",
    Atem: "アーテム",
    und: "ウント",
    Erzählung: "エアツェールング",
    Zweige: "ツヴァイゲ",
    Hände: "ヘンデ",
    denn: "デン",
    Körper: "ケルパー",
    Wurzeln: "ヴルツェルン",
    wenn: "ヴェン",
    Jahreszeit: "ヤーレスツァイト",
    Tauens: "タウエンス",
    kommt: "コムト",
    werde: "ヴェルデ",
    wach: "ヴァッハ",
    singe: "ズィンゲ",
    das: "ダス",
    du: "ドゥ",
    mir: "ミア",
    gegeben: "ゲゲーベン",
    hast: "ハスト",
    dich: "ディッヒ",
    Wort: "ヴォルト",
  };
  for (const w of Object.keys(want)) {
    assert.strictEqual(read("de", w), want[w], w);
  }
});

test("德语拼读：借词表命中日语通行写法（sljfaq 德语表）", () => {
  assert.strictEqual(read("de", "Lied"), "リート");
  assert.strictEqual(read("de", "Arbeit"), "アルバイト");
  assert.strictEqual(read("de", "Thema"), "テーマ");
  // 表里没有的照旧走规则层，别乱命中
  assert.strictEqual(L.word("de", "Zweige"), null);
  assert.strictEqual(read("de", "Zweige"), "ツヴァイゲ");
  assert.ok(L.loanCount() >= 170, "借词表条数：" + L.loanCount());
});

// ============================================================ 拉丁语

test("拉丁语拼读：用户用例 2 / 5 / 7 里的词（古典式）", () => {
  const want = {
    // 用例 2
    Vosmet: "ヴォスメト",
    vetat: "ヴェタト",
    res: "レス",
    coelica: "コエリカ",
    Iam: "イアム",
    letum: "レトゥム",
    vastum: "ヴァストゥム",
    Vae: "ヴァエ",
    gnari: "グナリ",
    sunt: "スント",
    quis: "クイス",
    oculis: "オクリス",
    Sapientes: "サピエンテス",
    feroces: "フェロケス",
    currunt: "クッルント",
    nefas: "ネファス",
    tarda: "タルダ",
    necessitas: "ネケッシタス",
    gradum: "グラドゥム",
    solum: "ソルム",
    nihil: "ニヒル",
    debet: "デベト",
    qua: "クア",
    Dominatus: "ドミナトゥス",
    // 用例 5
    Proditi: "プロディティ",
    sumus: "スムス",
    mundo: "ムンド",
    Novum: "ノヴム",
    mundum: "ムンドゥム",
    omnibus: "オムニブス",
    aequum: "アエクウム",
    condemus: "コンデムス",
    Sidus: "シドゥス",
    album: "アルブム",
    Terram: "テッラム",
    quatite: "クアティテ",
    mecum: "メクム",
    tenebras: "テネブラス",
    ruinis: "ルイニス",
    ordo: "オルド",
    novus: "ノヴス",
    aurora: "アウロラ",
    orietur: "オリエトゥル",
    // 用例 7（和用户截图里的参考答案对齐）
    Igni: "イグニ",
    cinis: "キニス",
    surget: "スルゲト",
    calor: "カロル",
    scaena: "スカエナ",
    salto: "サルト",
    Resurgito: "レスルギト",
    Alluceto: "アッルケト",
    Illusio: "イッルシオ",
    tristitia: "トリスティティア",
    victis: "ヴィクティス",
    fortunarum: "フォルトゥナルム",
    ignis: "イグニス",
    fio: "フィオ",
    Vade: "ヴァデ",
    retro: "レトロ",
    vanitas: "ヴァニタス",
    omnia: "オムニア",
    Nihilum: "ニヒルム",
    flamma: "フランマ",
    Visio: "ヴィシオ",
    Vindicia: "ヴィンディキア",
    Vanitatum: "ヴァニタトゥム",
    sentio: "センティオ",
    dolor: "ドロル",
    dolores: "ドロレス",
    senta: "センタ",
    Comoeda: "コモエダ",
  };
  for (const w of Object.keys(want)) {
    assert.strictEqual(read("la", w), want[w], w);
  }
});

// ============================================================ 斯瓦希里语

test("斯瓦希里语拼读：用户用例 3 / 4 里的词", () => {
  const want = {
    Shambulia: "シャンブリア",
    Beba: "ベバ",
    silaha: "シラハ",
    Pigana: "ピガナ",
    mpaka: "ンパカ",
    Kwa: "クワ",
    yetu: "イェトゥ",
    damu: "ダム",
    dunia: "ドゥニア",
    moto: "モト",
    mbingu: "ンビング",
    ardhi: "アルディ",
    tena: "テナ",
    ndugu: "ンドゥグ",
    kifo: "キフォ",
    jamaa: "ジャマア",
    nchi: "ンチ",
    nyumbani: "ニュンバニ",
    sasa: "ササ",
    shujaa: "シュジャア",
    moto: "モト",
  };
  for (const w of Object.keys(want)) {
    assert.strictEqual(read("sw", w), want[w], w);
  }
  // mw 是"姆 + ワ"，不是拨音
  assert.strictEqual(read("sw", "mwishowe"), "ムウィショウェ");
  assert.strictEqual(read("sw", "mwanga"), "ムワンガ");
});

// ============================================================ 俄语 / 希腊语

test("俄语拼读：用户用例 6 里的词", () => {
  const want = {
    Мы: "ムイ",
    Отчизну: "オチズヌ",
    отстоим: "オトストイム",
    и: "イ",
    восславим: "ヴォスラヴィム",
    себя: "セビャ",
    в: "ヴ",
    веках: "ヴェカフ",
    Виват: "ヴィヴァト",
    Анастасия: "アナスタシヤ",
  };
  for (const w of Object.keys(want)) {
    assert.strictEqual(read("ru", w), want[w], w);
  }
  // 借词表（sljfaq 俄语表）
  assert.strictEqual(read("ru", "норма"), "ノルマ");
  assert.strictEqual(read("ru", "водка"), "ヴォトカ");
});

test("希腊语拼读：逐字母 + 二合字母", () => {
  assert.strictEqual(read("el", "Θάλασσα"), "サラッサ");
  assert.strictEqual(read("el", "ουρανός"), "ウラノス");
  assert.strictEqual(read("el", "άνθρωπος"), "アンスロポス");
  assert.strictEqual(read("el", "μουσική"), "ムシキ");
  // β 读 バ行（日语里希腊语借词的通行写法：ベータ / ビザンツ / ビオス）——
  // 用户截图 `《βίος》` 原来读成 ヴィオス（那个词日语里是 ビオス）
  assert.strictEqual(read("el", "βίος"), "ビオス");
  assert.strictEqual(read("el", "βιβλίο"), "ビブリオ");
});

// ============================================================ 葡 / 荷 / 拼音

test("葡萄牙语拼读：鼻元音与二合字母", () => {
  assert.strictEqual(read("pt", "coração"), "コラサン");
  assert.strictEqual(read("pt", "não"), "ナン");
  assert.strictEqual(read("pt", "minha"), "ミニャ");
  assert.strictEqual(read("pt", "filho"), "フィリョ");
  // 借词表（sljfaq 葡萄牙语表）
  assert.strictEqual(read("pt", "pao"), "パン");
  assert.strictEqual(read("pt", "tabaco"), "タバコ");
});

test("荷兰语拼读：ij / oe / ui / g", () => {
  assert.strictEqual(read("nl", "tijd"), "タイト");
  assert.strictEqual(read("nl", "goed"), "フート");
  assert.strictEqual(read("nl", "huis"), "ハウス");
  assert.strictEqual(read("nl", "nacht"), "ナハト");
  // 借词表（sljfaq 荷兰语表）
  assert.strictEqual(read("nl", "bier"), "ビール");
  assert.strictEqual(read("nl", "koffie"), "コーヒー");
});

test("汉语拼音：声母韵母拼读（近似）", () => {
  assert.strictEqual(read("pinyin", "wǒ"), "ウォ");
  assert.strictEqual(read("pinyin", "nǐ"), "ニ");
  assert.strictEqual(read("pinyin", "zhōng"), "ジョン");
  assert.strictEqual(read("pinyin", "xiè"), "シェ");
  assert.strictEqual(read("pinyin", "shàng"), "シャン");
  assert.strictEqual(read("pinyin", "liú"), "リュウ");
  assert.strictEqual(read("pinyin", "yuè"), "ユエ");
  assert.strictEqual(read("pinyin", "shì"), "シ");
});

test("借词表只在该语言的行上生效（cross-language 不串味）", () => {
  // 同一个词在不同语言的行上读法不同：德语 Lied リート，而英语行不该拿这张表
  assert.strictEqual(L.word("de", "Lied"), "リート");
  assert.strictEqual(L.word("nl", "Lied"), null);
  assert.strictEqual(L.word("pt", "Lied"), null);
});

test("外语引擎的输入容错：空值 / 别的字母表都返回 null，不抛异常", () => {
  for (const id of ["de", "la", "pt", "nl", "sw", "pinyin", "ru", "el"]) {
    assert.strictEqual(L.toKatakana(id, ""), null, id);
    assert.strictEqual(L.toKatakana(id, "コーヒー"), null, id);
    assert.strictEqual(L.toKatakana(id, null), null, id);
  }
  assert.strictEqual(L.toKatakana("xx", "hello"), null);
});
