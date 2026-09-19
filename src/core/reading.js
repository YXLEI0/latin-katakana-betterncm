/*
 * Latin Katakana for BetterNCM —— 读音引擎
 *
 * 把歌词里的拉丁字母转成片假名读音。两条完全不同的路子：
 *
 *   romajiToKatakana()   日式罗马音（sekai / shinjiteru / gakkou）。
 *                        音节表是封闭的，所以可以要求「整串都切得干净」，
 *                        切不干净就返回 null，让上层换英文规则——宁可判错也不瞎拼。
 *   englishToKatakana()  英文单词（clover / light / dream）。
 *                        发音不规则，但歌词注音必须有东西可显示，所以约定
 *                        「永远返回非空片假名」，把握不足时用 confident:false 报出来。
 *
 * 挂到 globalThis.LKReading。既能在老 CEF 里按 <script> 加载，也能在 Node 里
 * require（UMD 那套壳，见文件末尾）。目标宿主是网易云内置的老 CEF，
 * 所以这里只用 ES5：var、function、字符串拼接，不用箭头函数/let/const/
 * 模板字符串/解构/可选链。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LKReading = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 片假名区段 + 长音符 + 半角片假名/半角长音符。
  // 和 matcher.js 的 RE_KATAKANA 同口径（ァ-ヶ ヽヾ），另外放行 ー 与半角那一档。
  var RE_KATAKANA = /^[\u30A1-\u30F6\u30FC\uFF66-\uFF9D\uFF70]+$/;

  // 拉丁字母（只有这个才算「词」）
  var RE_LATIN = /[A-Za-z]/;

  // 英文音译里「辅音 + l/r」的连缀折法。第一项是「前面的辅音怎么读」，
  // 第二项是「l/r 那截跟着元音走」。
  //   clover -> c=ク + l+o=ロ      => クロ（再靠词尾 -er -> アー 收成 クローバー）
  //   story  -> st=ス + ト + r+i=リ => ストリ（词尾 y -> イー）
  // 不做这张表的话，c/l 会各带一个元音读成「クロ」里多冒一个音。
  var CLUSTER_HEAD = {
    b: "ブ",
    c: "ク",
    d: "ド",
    f: "フ",
    g: "グ",
    k: "ク",
    p: "プ",
    s: "ス",
    t: "ト",
  };
  var CLUSTER_TAIL = { l: true, r: true };

  // 算「辅音连缀」用的辅音集合。englishToKatakana 靠它数连缀长度，
  // 超过 4 个就认为没把握（confident:false）。
  var RE_CONSONANT = /[bcdfghjklmnpqrstvwxyz]/;

  // ------------------------------------------------------------ 罗马音表

  /*
   * 基本音节。覆盖任务要求的全部行：
   *   a i u e o / ka ki ku ke ko / sa shi su se so / ta chi tsu te to /
   *   na ni nu ne no / ha hi fu he ho / ma mi mu me mo / ya yu yo /
   *   ra ri ru re ro / wa wo n / ga gi gu ge go / za ji zu ze zo /
   *   da di du de do / ba bi bu be bo / pa pi pu pe po
   * 外加下面单列的拗音（小写 ャュョ）。
   */
  var ROMAJI = {
    a: "\u30A2", // ア
    i: "\u30A4", // イ
    u: "\u30A6", // ウ
    e: "\u30A8", // エ
    o: "\u30AA", // オ

    ka: "\u30AB", // カ
    ki: "\u30AD", // キ
    ku: "\u30AF", // ク
    ke: "\u30B1", // ケ
    ko: "\u30B3", // コ

    sa: "\u30B5", // サ
    shi: "\u30B7", // シ
    su: "\u30B9", // ス
    se: "\u30BB", // セ
    so: "\u30BD", // ソ

    ta: "\u30BF", // タ
    chi: "\u30C1", // チ
    tsu: "\u30C4", // ツ
    te: "\u30C6", // テ
    to: "\u30C8", // ト

    na: "\u30CA", // ナ
    ni: "\u30CB", // ニ
    nu: "\u30CC", // ヌ
    ne: "\u30CD", // ネ
    no: "\u30CE", // ノ

    ha: "\u30CF", // ハ
    hi: "\u30D2", // ヒ
    fu: "\u30D5", // フ
    he: "\u30D8", // ヘ
    ho: "\u30DB", // ホ

    ma: "\u30DE", // マ
    mi: "\u30DF", // ミ
    mu: "\u30E0", // ム
    me: "\u30E1", // メ
    mo: "\u30E2", // モ

    ya: "\u30E4", // ヤ
    yu: "\u30E6", // ユ
    yo: "\u30E8", // ヨ

    ra: "\u30E9", // ラ
    ri: "\u30EA", // リ
    ru: "\u30EB", // ル
    re: "\u30EC", // レ
    ro: "\u30ED", // ロ

    wa: "\u30EF", // ワ
    wo: "\u30F2", // ヲ
    n: "\u30F3", // ン

    ga: "\u30AC", // ガ
    gi: "\u30AE", // ギ
    gu: "\u30B0", // グ
    ge: "\u30B2", // ゲ
    go: "\u30B4", // ゴ

    za: "\u30B6", // ザ
    ji: "\u30B8", // ジ
    zu: "\u30BA", // ズ
    ze: "\u30BC", // ゼ
    zo: "\u30BE", // ゾ

    da: "\u30C0", // ダ
    di: "\u30C2", // ヂ（ウィキ式の di。英語の di は英語側の担当）
    du: "\u30C5", // ヅ
    de: "\u30C7", // デ
    do: "\u30C9", // ド

    ba: "\u30D0", // バ
    bi: "\u30D3", // ビ
    bu: "\u30D6", // ブ
    be: "\u30D9", // ベ
    bo: "\u30DC", // ボ

    pa: "\u30D1", // パ
    pi: "\u30D4", // ピ
    pu: "\u30D7", // プ
    pe: "\u30DA", // ペ
    po: "\u30DD", // ポ

    // ---- 拗音：辅音 + ya/yu/yo -> 小写 ャュョ
    kya: "\u30AD\u30E3", // キャ
    kyu: "\u30AD\u30E5", // キュ
    kyo: "\u30AD\u30E7", // キョ

    sha: "\u30B7\u30E3", // シャ
    shu: "\u30B7\u30E5", // シュ
    sho: "\u30B7\u30E7", // ショ

    cha: "\u30C1\u30E3", // チャ
    chu: "\u30C1\u30E5", // チュ
    cho: "\u30C1\u30E7", // チョ

    nya: "\u30CB\u30E3", // ニャ
    nyu: "\u30CB\u30E5", // ニュ
    nyo: "\u30CB\u30E7", // ニョ

    hya: "\u30D2\u30E3", // ヒャ
    hyu: "\u30D2\u30E5", // ヒュ
    hyo: "\u30D2\u30E7", // ヒョ

    mya: "\u30DF\u30E3", // ミャ
    myu: "\u30DF\u30E5", // ミュ
    myo: "\u30DF\u30E7", // ミョ

    rya: "\u30EA\u30E3", // リャ
    ryu: "\u30EA\u30E5", // リュ
    ryo: "\u30EA\u30E7", // リョ

    gya: "\u30AE\u30E3", // ギャ
    gyu: "\u30AE\u30E5", // ギュ
    gyo: "\u30AE\u30E7", // ギョ

    ja: "\u30B8\u30E3", // ジャ
    ju: "\u30B8\u30E5", // ジュ
    jo: "\u30B8\u30E7", // ジョ

    bya: "\u30D3\u30E3", // ビャ
    byu: "\u30D3\u30E5", // ビュ
    byo: "\u30D3\u30E7", // ビョ

    pya: "\u30D4\u30E3", // ピャ
    pyu: "\u30D4\u30E5", // ピュ
    pyo: "\u30D4\u30E7", // ピョ
  };

  // 促音（っ）的引子：这些双辅音后面还有元音时，第一个只留一个「ッ」。
  //   gakkou -> ガッコウ / matte -> マッテ / zasshi -> ザッシ
  var GEMINATION = {
    kk: true,
    tt: true,
    pp: true,
    ss: true,
    cc: true,
    bb: true,
    dd: true,
    ff: true,
    gg: true,
    jj: true,
    ll: true,
    mm: true,
    rr: true,
    vv: true,
    zz: true,
  };

  // 长音合并规则（这条是任务里定死的，写在这里当唯一依据）：
  //   ou -> オウ、oo -> オー、uu -> ウー、aa -> アー、ee -> エー、单独的 ei -> エイ
  //   kyou -> キョ + ウ = キョウ、gakkou -> ガッコ + ウ = ガッコウ
  // 「统一用 ー」和「常见写法」两种诉求在这里是冲突的，所以按上面这条固定下来：
  // ou 保留成 オウ（看得见原来的 u），oo/uu/aa/ee 才并成长音符 ー。
  //
  // 注意这里的值替换的是「这两个字符一起」的读音：ou/oo/uu/ee 都自带开头的元音，
  // 所以写成 オウ/オー/ウー/アー/エー 而不是光一个 ー。
  //
  // 已知取舍：这六个长音对目前只在「扫描指针正好落在第一个元音上」时命中，
  // 词首（aa -> アー、aasan -> アーサン）没问题，但跟在别的音节后面会各读各的
  // （okaasan -> オカアサン）。真实歌词里 okaasan 这种写法很少见，
  // 而 ou/oo 这两种长音在词尾一样能命中（gakkou -> ガッコウ、kyou -> キョウ），
  // 所以先这样，改动前请先看 tests 里那条「aa 系列只在词首合并」的用例。
  var ROMAJI_VOWEL_PAIR = {
    ou: "\u30AA\u30A6", // オウ
    oo: "\u30AA\u30FC", // オー
    uu: "\u30A6\u30FC", // ウー
    aa: "\u30A2\u30FC", // アー
    ee: "\u30A8\u30FC", // エー
    ei: "\u30A8\u30A4", // エイ
  };

  /**
   * 严格罗马音切分。整串必须都能切开且不留尾巴，否则返回 null。
   *
   * 逐位从左到右扫：每个位置先试 4/3/2 字符的条目（拗音最长，必须优先，
   * 否则 shi 会被拆成 s + hi），都不中再试 1 字符；还不行就整串判负。
   * 顺序上只有三条特判，都在 tryRomajiToken 里：
   *   ① 促音（kk/tt/...）
   *   ② 长音对（ou/oo/...）
   *   ③ 拨音 n（后面不是元音或 y 时收 ン）
   * 词尾的 - 是罗马音里常见的长音符写法，原样保留成 ー。
   *
   * @returns {string|null}
   */
  function romajiToKatakana(s) {
    if (typeof s !== "string") return null;
    // 先切掉首尾空白；连字符（长音符）留在串里参与扫描，别的字符一律判负
    var text = s.replace(/^\s+|\s+$/g, "").toLowerCase();
    if (!text) return null;
    // 只认小写字母、连字符、撇号。混进数字或标点就说明这不像罗马音，
    // 交给英文规则去读（"e-mail" 就是这么落到 rule 分支的）。
    if (!/^[a-z\-']+$/.test(text)) return null;
    // 必须至少有一个元音或能单独成拍的 n：
    // 否则 "----" / "bcdfg" 这种会切出一串空拍或一串光秃秃的 ー。
    if (!/[aiueon]/.test(text)) return null;
    // 4 个以上元音连写不是任何罗马音写法（"aaaa" 这种），
    // 长音对只认两拍，硬切会切出一整串 ー。判负，交给英文规则。
    if (/[aiueo]{4,}/.test(text)) return null;

    var out = "";
    var i = 0;
    var n = text.length;

    while (i < n) {
      var hit = romajiToken(text, i);
      if (!hit) return null;
      out += hit.kana;
      i += hit.len;
    }

    return out;
  }

  /** 从下标 i 取一个罗马音音节，取不到返回 null。 */
  function romajiToken(s, i) {
    // 注意变量名：这里千万别用 n 存「前一个字符」——
    // 下面的「最长优先」循环要靠 len 当边界，两个都叫 n 的话
    // var 提升会让 len 被字符串盖掉，音节切分直接错乱。
    var len = s.length;

    // 词尾的长音符：原样留着（saka- -> サカー）
    if (s.charAt(i) === "-") return { kana: "\u30FC", len: 1 };

    // ① 促音：两个相同辅音（nn 不算，那是 ン；这里只在后面还有东西时收 ッ）
    var c0 = s.charAt(i);
    var c1 = s.charAt(i + 1);
    if (c1 !== "" && c1 !== undefined && c0 === c1 && GEMINATION[c0 + c1] === true) {
      if (i + 2 < len) return { kana: "\u30C3", len: 1 };
    }

    /*
     * ② 长音对。必须排在普通条目前面，而且不能拿 ROMAJI[pair] 当条件：
     *    "ou" 在 ROMAJI 表里被拆成了 o + u，正好命中，一命中的话这条就永远
     *    轮不上，gakkou 会读成 ガッコ + ウ 的另一种切法、okaasan 会读成 オーカ…。
     *    只对 ou/ oo / uu / aa / ee / ei 这六个组合动手，别的元音连写
     *    （oi / ae 之类）保持各读各的。
     */
    var pair = s.substr(i, 2);
    if (ROMAJI_VOWEL_PAIR[pair] !== undefined) {
      return { kana: ROMAJI_VOWEL_PAIR[pair], len: 2 };
    }

    // ③ 拨音 n：后面不是元音、也不是 y（nya 之类）时，n 自己成 ン
    if (c0 === "n") {
      var after = s.charAt(i + 1);
      var isVowel = after === "a" || after === "i" || after === "u" || after === "e" || after === "o";
      if (after === "" || (!isVowel && after !== "y")) return { kana: "\u30F3", len: 1 };
    }

    // 普通条目：最长优先
    var k = Math.min(4, len - i);
    while (k >= 1) {
      var piece = s.substr(i, k);
      if (ROMAJI[piece] !== undefined) return { kana: ROMAJI[piece], len: k };
      k--;
    }
    return null;
  }

  // ------------------------------------------------------------ 英文音译

  /*
   * 不规则例外表：拼写和读音对不上、或者规则一定会读错的词。
   * 命中就走这里，confident 一律 true（都是人工核过的读音）。
   * 形状：小写英文 -> 片假名
   */
  var ENGLISH_EXCEPTIONS = {
    // ---- 任务点名的 31 个
    light: "\u30E9\u30A4\u30C8", // ライト
    night: "\u30CA\u30A4\u30C8", // ナイト
    right: "\u30E9\u30A4\u30C8", // ライト
    high: "\u30CF\u30A4", // ハイ
    through: "\u30B9\u30EB\u30FC", // スルー
    though: "\u30BE\u30A6", // ゾウ
    enough: "\u30A4\u30CA\u30D5", // イナフ
    love: "\u30E9\u30D6", // ラブ
    one: "\u30EF\u30F3", // ワン
    two: "\u30C8\u30A5\u30FC", // トゥー
    eight: "\u30A8\u30A4\u30C8", // エイト
    heart: "\u30CF\u30FC\u30C8", // ハート
    world: "\u30EF\u30FC\u30EB\u30C9", // ワールド
    dream: "\u30C9\u30EA\u30FC\u30E0", // ドリーム
    school: "\u30B9\u30AF\u30FC\u30EB", // スクール
    blue: "\u30D6\u30EB\u30FC", // ブルー
    eyes: "\u30A2\u30A4\u30BA", // アイズ
    time: "\u30BF\u30A4\u30E0", // タイム
    shine: "\u30B7\u30E3\u30A4\u30F3", // シャイン
    sky: "\u30B9\u30AB\u30A4", // スカイ
    star: "\u30B9\u30BF\u30FC", // スター
    snow: "\u30B9\u30CE\u30A6", // スノウ
    flow: "\u30D5\u30ED\u30A6", // フロウ
    know: "\u30CE\u30A6", // ノウ
    why: "\u30DB\u30EF\u30A4", // ホワイ
    fall: "\u30D5\u30A9\u30FC\u30EB", // フォール
    call: "\u30B3\u30FC\u30EB", // コール
    wall: "\u30A6\u30A9\u30FC\u30EB", // ウォール
    girl: "\u30AC\u30FC\u30EB", // ガール
    summer: "\u30B5\u30DE\u30FC", // サマー
    winter: "\u30A6\u30A3\u30F3\u30BF\u30FC", // ウィンター

    // ---- 规则一定会读错的高频词（不补就会变成 コッヒー / カメラ 读成 カメラ 以外的东西）
    coffee: "\u30B3\u30FC\u30D2\u30FC", // コーヒー（ff 会被读成 ッフ，接 ee 就成了 コッヒー）
    camera: "\u30AB\u30E1\u30E9", // カメラ
    dance: "\u30C0\u30F3\u30B9", // ダンス（词尾不发音的 e，规则会猜成 ダンシー 之类）
    people: "\u30D4\u30FC\u30D7\u30EB", // ピープル
    water: "\u30A6\u30A9\u30FC\u30BF\u30FC", // ウォーター
    flower: "\u30D5\u30E9\u30EF\u30FC", // フラワー
    power: "\u30D1\u30EF\u30FC", // パワー
    tower: "\u30BF\u30EF\u30FC", // タワー
    hour: "\u30A2\u30EF\u30FC", // アワー
    your: "\u30E8\u30A2", // ヨア
    very: "\u30D9\u30EA\u30FC", // ベリー
    every: "\u30A8\u30D6\u30EA\u30A4", // エブリイ
    again: "\u30A2\u30B2\u30A4\u30F3", // アゲイン
    answer: "\u30A2\u30F3\u30B5\u30FC", // アンサー
    island: "\u30A2\u30A4\u30E9\u30F3\u30C9", // アイランド
    listen: "\u30EA\u30B9\u30F3", // リスン
    castle: "\u30AD\u30E3\u30C3\u30B9\u30EB", // キャッスル
    who: "\u30D5\u30FC", // フー
    whole: "\u30DB\u30FC\u30EB", // ホール
    once: "\u30EF\u30F3\u30B9", // ワンス
    eye: "\u30A2\u30A4", // アイ
    music: "\u30DF\u30E5\u30FC\u30B8\u30C3\u30AF", // ミュージック
    magic: "\u30DE\u30B8\u30C3\u30AF", // マジック
    voice: "\u30DC\u30A4\u30B9", // ボイス
    prince: "\u30D7\u30EA\u30F3\u30B9", // プリンス
    since: "\u30B7\u30F3\u30B9", // シンス
    science: "\u30B5\u30A4\u30A8\u30F3\u30B9", // サイエンス
    quiet: "\u30AF\u30EF\u30A4\u30A8\u30C3\u30C8", // クワイエット
    young: "\u30E4\u30F3\u30B0", // ヤング
    double: "\u30C0\u30D6\u30EB", // ダブル
    trouble: "\u30C8\u30E9\u30D6\u30EB", // トラブル
    country: "\u30AB\u30F3\u30C8\u30EA\u30FC", // カントリー
    journey: "\u30B8\u30E3\u30FC\u30CB\u30FC", // ジャーニー
  };

  /*
   * 常见外来语小表（英文 -> 片假名）。
   *
   * 和上面的 ENGLISH_EXCEPTIONS 分开放，因为性质不同：
   *   ENGLISH_EXCEPTIONS 是「拼写本来就不规则」（light / through / love）。
   *   ENGLISH_LEXICON   是「拼写规则，但规则会读歪/读土」的高频外来语。
   * 后者的存在是诚实记账：不写进来的话，clover 会读成 クロヴェー、
   * computer 会读成 コマプテー 这类，人工核过的写法只能靠这张表兜。
   *
   * 查表顺序：ENGLISH_EXCEPTIONS -> ENGLISH_LEXICON -> 规则。
   */
  var ENGLISH_LEXICON = {
    clover: "\u30AF\u30ED\u30FC\u30D0\u30FC", // クローバー（规则给 クロヴェー）
    over: "\u30AA\u30FC\u30D0\u30FC", // オーバー（规则给 オヴェー）
    computer: "\u30B3\u30F3\u30D4\u30E5\u30FC\u30BF\u30FC", // コンピューター（规则给 コマプテー）
    story: "\u30B9\u30C8\u30FC\u30EA\u30FC", // ストーリー（规则给 サトライ）
    melody: "\u30E1\u30ED\u30C7\u30A3\u30FC", // メロディー（规则给 メロダイ）
    camera: "\u30AB\u30E1\u30E9", // カメラ（规则会以为词尾 e 不发音，给 カメラー）
    diorama: "\u30B8\u30AA\u30E9\u30DE", // ジオラマ（罗马音表里 di 是 ヂ，外来语要 ジ）
    radio: "\u30E9\u30B8\u30AA", // ラジオ（规则给 ラディオ）
    piano: "\u30D4\u30A2\u30CE", // ピアノ
    guitar: "\u30AE\u30BF\u30FC", // ギター（规则给 ギター 但一定会标不放心，这里确权）
    color: "\u30AB\u30E9\u30FC", // カラー
    colour: "\u30AB\u30E9\u30FC", // カラー
    heaven: "\u30D8\u30D6\u30F3", // ヘブン
    seven: "\u30BB\u30D6\u30F3", // セブン
    eleven: "\u30A4\u30EC\u30D6\u30F3", // イレブン
    open: "\u30AA\u30FC\u30D7\u30F3", // オープン
    lemon: "\u30EC\u30E2\u30F3", // レモン
    season: "\u30B7\u30FC\u30BA\u30F3", // シーズン
    reason: "\u30EA\u30FC\u30BA\u30F3", // リーズン
    person: "\u30D1\u30FC\u30BD\u30F3", // パーソン
    lesson: "\u30EC\u30C3\u30B9\u30F3", // レッスン
    message: "\u30E1\u30C3\u30BB\u30FC\u30B8", // メッセージ
    silence: "\u30B5\u30A4\u30EC\u30F3\u30B9", // サイレンス
    distance: "\u30C7\u30A3\u30B9\u30BF\u30F3\u30B9", // ディスタンス
    balance: "\u30D0\u30E9\u30F3\u30B9", // バランス
    present: "\u30D7\u30EC\u30BC\u30F3\u30C8", // プレゼント
    moment: "\u30E2\u30FC\u30E1\u30F3\u30C8", // モーメント
    diamond: "\u30C0\u30A4\u30E4\u30E2\u30F3\u30C9", // ダイヤモンド
    planet: "\u30D7\u30E9\u30CD\u30C3\u30C8", // プラネット
    crystal: "\u30AF\u30EA\u30B9\u30BF\u30EB", // クリスタル
    secret: "\u30B7\u30FC\u30AF\u30EC\u30C3\u30C8", // シークレット
    spirit: "\u30B9\u30D4\u30EA\u30C3\u30C8", // スピリット
    future: "\u30D5\u30E5\u30FC\u30C1\u30E3\u30FC", // フューチャー
    nature: "\u30CD\u30A4\u30C1\u30E3\u30FC", // ネイチャー
    picture: "\u30D4\u30AF\u30C1\u30E3\u30FC", // ピクチャー
    culture: "\u30AB\u30EB\u30C1\u30E3\u30FC", // カルチャー
    queen: "\u30AF\u30A4\u30FC\u30F3", // クイーン（规则给 クエエン）
    jazz: "\u30B8\u30E3\u30BA", // ジャズ（规则给 ジャッザ）
    piano: "\u30D4\u30A2\u30CE", // ピアノ（规则会读成 ピアノー，因为词尾 o 在规则里是长音）
    digital: "\u30C7\u30B8\u30BF\u30EB", // デジタル
    letter: "\u30EC\u30BF\u30FC", // レター
    better: "\u30D9\u30BF\u30FC", // ベター
    mirror: "\u30DF\u30E9\u30FC", // ミラー
    error: "\u30A8\u30E9\u30FC", // エラー
    horror: "\u30DB\u30E9\u30FC", // ホラー
    dinner: "\u30C7\u30A3\u30CA\u30FC", // ディナー
    city: "\u30B7\u30C6\u30A3", // シティ（规则给 シタイ）
    party: "\u30D1\u30FC\u30C6\u30A3\u30FC", // パーティー
    pretty: "\u30D7\u30EA\u30C6\u30A3", // プリティ
    happy: "\u30CF\u30C3\u30D4\u30FC", // ハッピー（规则给 ハッパイ）
    lucky: "\u30E9\u30C3\u30AD\u30FC", // ラッキー
    lady: "\u30EC\u30C7\u30A3", // レディ
    sign: "\u30B5\u30A4\u30F3", // サイン（词尾 gn 的 g 不发音，规则会读成 シン）
    design: "\u30C7\u30B6\u30A4\u30F3", // デザイン（同上）
  };

  // 英文短元音/长元音的默认读音（按字母尾那套来读）
  var EN_VOWEL = {
    a: "\u30A2", // ア
    i: "\u30A4", // イ
    u: "\u30A6", // ウ
    e: "\u30A8", // エ
    o: "\u30AA", // オ
  };

  // 元音连写（两个及三个字母）。顺序靠「先长后短」在 scanEnglish 里保证。
  var EN_VOWEL_FIX = {
    // 三字母
    igh: "\u30A2\u30A4", // アイ
    eau: "\u30FC", // ー
    // 两个字母
    ee: "\u30A4\u30FC", // イー
    ea: "\u30A4\u30FC", // イー
    oo: "\u30A6\u30FC", // ウー
    ou: "\u30A2\u30A6", // アウ
    ow: "\u30A2\u30A6", // アウ
    oa: "\u30AA\u30A6", // オウ
    ai: "\u30A8\u30A4", // エイ
    ay: "\u30A8\u30A4", // エイ
    ey: "\u30A8\u30A4", // エイ
    oi: "\u30AA\u30A4", // オイ
    oy: "\u30AA\u30A4", // オイ
    au: "\u30AA\u30FC", // オー
    aw: "\u30AA\u30FC", // オー
    ie: "\u30A4\u30FC", // イー
  };

  // 双辅音字母组合。这些必须先于单字母处理，否则 sh 会被拆成 s + h。
  var EN_DIGRAPH = {
    sh: "\u30B7", // シ（セットの sha は下の 2 字母ルールで シャ になる）
    ch: "\u30C1", // チ
    th: "\u30B5", // サ（有声のときは ザ にしたいが、綴りだけでは決まらない：
    //               think は シンク ではなく サ になる。下の confident:false で報せる）
    ph: "\u30D5", // フ
    wh: "\u30EF", // ワ
    ck: "\u30C3\u30AF", // ック
    ng: "\u30F3\u30B0", // ング
    ss: "\u30B9", // ス（question 的 ss 读 ス，不加 ッ）
    gh: "\u30FC", // ー（light は例外表。ここへ来るのは規則だけのとき）
    qu: "\u30AF\u30EF", // クワ
    wr: "\u30E9", // ラ（write -> ライト の w は黙字）
    kn: "\u30CA", // ナ（know は例外表）
  };

  // 「辅音 + 元音」两字母拼块。查不到就退回单字母辅音的默认元音。
  var EN_PAIR = {
    ba: "\u30D0", // バ
    be: "\u30D9", // ベ
    bi: "\u30D3", // ビ
    bo: "\u30DC", // ボ
    bu: "\u30D6", // ブ
    ca: "\u30AB", // カ
    ce: "\u30BB", // セ
    ci: "\u30B7", // シ
    co: "\u30B3", // コ
    cu: "\u30AF", // ク
    da: "\u30C0", // ダ
    de: "\u30C7", // デ
    di: "\u30C7\u30A3", // ディ
    do: "\u30C9", // ド
    du: "\u30C9\u30A5", // ドゥ
    fa: "\u30D5\u30A1", // ファ
    fe: "\u30D5\u30A7", // フェ
    fi: "\u30D5\u30A3", // フィ
    fo: "\u30D5\u30A9", // フォ
    fu: "\u30D5", // フ
    ga: "\u30AC", // ガ
    ge: "\u30B2", // ゲ
    gi: "\u30AE", // ギ
    go: "\u30B4", // ゴ
    gu: "\u30B0", // グ
    ha: "\u30CF", // ハ
    he: "\u30D8", // ヘ
    hi: "\u30D2", // ヒ
    ho: "\u30DB", // ホ
    hu: "\u30D5", // フ
    ja: "\u30B8\u30E3", // ジャ
    je: "\u30B8\u30A7", // ジェ
    ji: "\u30B8", // ジ
    jo: "\u30B8\u30E7", // ジョ
    ju: "\u30B8\u30E5", // ジュ
    ka: "\u30AB", // カ
    ke: "\u30B1", // ケ
    ki: "\u30AD", // キ
    ko: "\u30B3", // コ
    ku: "\u30AF", // ク
    la: "\u30E9", // ラ
    le: "\u30EC", // レ
    li: "\u30EA", // リ
    lo: "\u30ED", // ロ
    lu: "\u30EB", // ル
    ma: "\u30DE", // マ
    me: "\u30E1", // メ
    mi: "\u30DF", // ミ
    mo: "\u30E2", // モ
    mu: "\u30E0", // ム
    na: "\u30CA", // ナ
    ne: "\u30CD", // ネ
    ni: "\u30CB", // ニ
    no: "\u30CE", // ノ
    nu: "\u30CC", // ヌ
    pa: "\u30D1", // パ
    pe: "\u30DA", // ペ
    pi: "\u30D4", // ピ
    po: "\u30DD", // ポ
    pu: "\u30D7", // プ
    ra: "\u30E9", // ラ
    re: "\u30EC", // レ
    ri: "\u30EA", // リ
    ro: "\u30ED", // ロ
    ru: "\u30EB", // ル
    sa: "\u30B5", // サ
    se: "\u30BB", // セ
    si: "\u30B7", // シ
    so: "\u30BD", // ソ
    su: "\u30B9", // ス
    ta: "\u30BF", // タ
    te: "\u30C6", // テ
    ti: "\u30C6\u30A3", // ティ
    to: "\u30C8", // ト
    tu: "\u30C8\u30A5", // トゥ
    va: "\u30F4\u30A1", // ヴァ
    ve: "\u30F4\u30A7", // ヴェ
    vi: "\u30F4\u30A3", // ヴィ
    vo: "\u30F4\u30A9", // ヴォ
    vu: "\u30F4", // ヴ
    wa: "\u30EF", // ワ
    we: "\u30A6\u30A7", // ウェ
    wi: "\u30A6\u30A3", // ウィ
    wo: "\u30A6\u30A9", // ウォ
    ya: "\u30E4", // ヤ
    ye: "\u30A4\u30A7", // イェ
    yo: "\u30E8", // ヨ
    yu: "\u30E6", // ユ
    za: "\u30B6", // ザ
    ze: "\u30BC", // ゼ
    zi: "\u30B8", // ジ
    zo: "\u30BE", // ゾ
    zu: "\u30BA", // ズ
  };

  // 单字母辅音单独出现时补的「读出来的元音」。
  // 日语没有单独辅音（ン 和 ッ 除外），所以必须补一个元音，这就是不准确的主要来源。
  // 元音的选择：
  //   - 唇音 b/m/p/f/v 补 u（バ行/マ行/パ行/ファ行/ヴァ行 的 u 段，口型最接近）
  //   - 齿龈音 d/t/s/z/l/r/n 补 u
  //   - 软腭音 k/g 补 u
  //   - 喉音 h 补 a（ha 行）
  //   - j 补 i、w 补 u、y 补 i
  //   - v 走 ヴァ行（ヴ 而不是 バ）：老 CEF 字体对 ヴ 支持没问题，
  //     而且 ヴ 能保住「v 不是 b」这个信息。代价是「ヴァイオリン」这类
  //     现在通行的写法其实常写 バイオリン，两种都能见到，这里选 ヴァ 一侧。
  var EN_CONSONANT = {
    b: "\u30D0",
    c: "\u30AF",
    d: "\u30C0",
    f: "\u30D5\u30A1",
    g: "\u30B0",
    h: "\u30CF",
    j: "\u30B8",
    k: "\u30AF",
    l: "\u30E9",
    m: "\u30DE",
    n: "\u30CA",
    p: "\u30D1",
    q: "\u30AF",
    r: "\u30E9",
    s: "\u30B5",
    t: "\u30BF",
    v: "\u30F4\u30A1",
    w: "\u30A6",
    x: "\u30AF\u30B9",
    y: "\u30A4",
    z: "\u30B6",
  };

  // 词尾单个辅音的收尾读法（l -> ル、r -> ー 是任务里定死的）
  var EN_FINAL_CONSONANT = {
    b: "\u30D6", // ブ
    c: "\u30AF", // ク
    d: "\u30C9", // ド
    f: "\u30D5", // フ
    g: "\u30B0", // グ
    h: "\u30FC", // ー（h 结尾在英文里基本不发音）
    k: "\u30AF", // ク
    l: "\u30EB", // ル
    m: "\u30E0", // ム
    n: "\u30F3", // ン
    p: "\u30D7", // プ
    r: "\u30FC", // ー（over -> オーバー）
    s: "\u30B9", // ス
    t: "\u30C8", // ト
    v: "\u30F4", // ヴ
    x: "\u30C3\u30AF\u30B9", // ックス
    z: "\u30BA", // ズ
  };

  // 词尾元音 + r 的 r 化：-er / -ar / -or -> アー / アー / オー
  var EN_FINAL_R = {
    er: "\u30A2\u30FC", // アー
    ar: "\u30A2\u30FC", // アー
    or: "\u30AA\u30FC", // オー
  };

  // 这些组合在英文里发音不唯一，碰到就标 confident:false
  var EN_UNSURE = {
    th: true, // サ/ザ 只能猜
    wh: true, // ワ/ホ 只能猜
    gh: true, // 黙字か f か
  };

  /** 单个元音字母的读音。词尾的 e 在调用处先处理掉，不会走到这里。 */
  function enVowel(ch) {
    if (EN_VOWEL[ch] !== undefined) return EN_VOWEL[ch];
    if (ch === "y") return "\u30A4"; // イ（happy 之类）
    return "";
  }

  /**
   * 能不能往 kana 尾巴上再拍一个长音符 ー。
   * 已经以 ー 结尾（或还是空的）就不再拍：一串元音接一个词尾辅音
   * （"aaaa...a" 这种）会一路拍出几十个 ー 来，那不是读音。
   */
  function canLengthen(kana) {
    if (!kana) return false;
    return kana.charAt(kana.length - 1) !== "\u30FC";
  }

  /** 这两个字母能不能拼成一截「辅音 + l/r」连缀（clover 的 cl、story 的 st 不算） */
  function isClusterHead(ch) {
    return typeof ch === "string" && CLUSTER_HEAD[ch] !== undefined;
  }

  /**
   * 英文规则音译。返回 { kana, confident }，kana 一定非空。
   *
   * 扫描顺序（顺序本身就是规则，乱了就会读错）：
   *   1. 词尾不发音的 e（只有前面还有可拉长的假名时才补 ー）
   *   2. 三字母元音（igh）
   *   3. 两字母块，按「越具体越先」排：
   *      -tion/-sion -> 元音连写 -> 辅音连缀 Cl/Cr -> 辅音 + 元音
   *      -> 双辅音字母 -> 词尾 Er/Ar/Or
   *   4. 单字母：元音 / 词尾 r / 双写辅音 / 词尾辅音 / 辅音
   * 任何一步都推不动，就跳过这个字符并标不放心，
   * 保证不会死循环、也不会吐空字符串。
   */
  function convertEnglish(word) {
    var kana = "";
    var confident = true;
    var i = 0;
    var len = word.length;

    while (i < len) {
      var ch = word.charAt(i);
      var rest = len - i;

      // ---- 1. 词尾不发音的 e
      if (ch === "e" && rest === 1 && i > 0) {
        var before = word.charAt(i - 1);
        if ("aiueo".indexOf(before) >= 0) {
          // 元音 + e：e 是多余的，前面那个元音已经写过了，直接丢掉
          // （"see" 走例外表；这里是兜规则没收录的拼法，不能一路拍 ー）
        } else if (canLengthen(kana)) {
          // 辅音 + e：多数是前面的元音发长音（dance 类型读 ス、time 类型读 ム），
          // 光看拼写定不下来，统一按「拉长前面那一拍」处理并标不放心。
          kana += "\u30FC"; // ー
          confident = false;
        } else {
          // 前面已经是 ー 或还没有假名：没法再拉长，e 直接丢掉
        }
        i++;
        continue;
      }

      // ---- 2. 三字母元音
      if (rest >= 3) {
        var t3 = word.substr(i, 3);
        if (EN_VOWEL_FIX[t3] !== undefined) {
          kana += EN_VOWEL_FIX[t3];
          i += 3;
          continue;
        }
      }

      // ---- 3a. -tion / -sion 读 ション。不限于词尾：
      //          nation / national / television 都要吃这一段。
      if (rest >= 4 && (word.substr(i, 4) === "tion" || word.substr(i, 4) === "sion")) {
        kana += "\u30B7\u30E7\u30F3"; // ション
        i += 4;
        continue;
      }

      // ---- 3b. 元音连写（必须排在 3d 的辅音连缀前面：
      //          "croak" 是 c + r + oa + k，oa 得先被吃掉，不然 cr 会抢走 c）
      if (rest >= 2) {
        var vp = word.substr(i, 2);
        if (EN_VOWEL_FIX[vp] !== undefined) {
          kana += EN_VOWEL_FIX[vp];
          i += 2;
          continue;
        }
      }

      // ---- 3d. 辅音 + l/r 连缀
      if (rest >= 2 && isClusterHead(ch) && CLUSTER_TAIL[word.charAt(i + 1)] === true) {
        kana += CLUSTER_HEAD[ch];
        i++;
        continue;
      }

      // ---- 3f. 辅音 + 元音
      if (rest >= 2 && EN_PAIR[word.substr(i, 2)] !== undefined) {
        kana += EN_PAIR[word.substr(i, 2)];
        i += 2;
        continue;
      }

      // ---- 3f. 双辅音字母组合（sh/ch/th/ck/ng/ss/...）
      //          这些是「一个音用两个字母写」，本身不再促音化：
      //          cheese 的 ch 是 チ、question 的 ss 是 ス，都不能加 ッ。
      if (rest >= 2 && EN_DIGRAPH[word.substr(i, 2)] !== undefined) {
        var dg = word.substr(i, 2);
        kana += EN_DIGRAPH[dg];
        if (EN_UNSURE[dg] === true) confident = false;
        i += 2;
        continue;
      }

      // ---- 3g. 词尾元音 + r 的 r 化
      if (rest === 2 && EN_FINAL_R[word.substr(i, 2)] !== undefined) {
        kana += EN_FINAL_R[word.substr(i, 2)];
        i += 2;
        continue;
      }

      // ---- 4a. 元音（含 y 当元音）
      if ("aiueoy".indexOf(ch) >= 0) {
        kana += enVowel(ch);
        i++;
        continue;
      }

      // ---- 4b. 词尾 r -> ー。前面必须已经有假名可拉长
      //          （而且不能已经是 ー），否则退回 ル，
      //          免得吐一个孤零零的 ー 或一串 ー。
      if (ch === "r" && rest === 1) {
        kana += canLengthen(kana) ? "\u30FC" : "\u30EB";
        i++;
        continue;
      }

      // ---- 4c. 双写辅音 -> ッ + 后半截（coffee 的 ff、summer 的 mm）
      if (rest >= 2 && ch === word.charAt(i + 1) && RE_CONSONANT.test(ch)) {
        kana += "\u30C3" + (EN_CONSONANT[ch] || "");
        i += 2;
        continue;
      }

      // ---- 4d. 词尾辅音
      if (rest === 1 && EN_FINAL_CONSONANT[ch] !== undefined) {
        kana += EN_FINAL_CONSONANT[ch];
        i++;
        continue;
      }

      // ---- 4e. 单字母辅音
      if (EN_CONSONANT[ch] !== undefined) {
        kana += EN_CONSONANT[ch];
        i++;
        continue;
      }

      // ---- 兜底：认不出的字符（数字、撇号等）。跳过，并标不放心。
      confident = false;
      i++;
    }

    if (!kana) kana = "\u30A2"; // ア：输入太空时至少给一个音节，保证非空
    return { kana: kana, confident: confident };
  }

  /**
   * 英文词 -> 片假名读音。永远返回 { kana, confident }，kana 一定非空。
   *
   * 层序：例外表 -> 规则。
   * （不在这里查 dict/online，那是 createReader 的活；这两个函数是纯函数，
   *   方便单独测、也方便上层换词表。）
   */
  function englishToKatakana(s) {
    if (typeof s !== "string") return { kana: "\u30A2", confident: false }; // ア
    // 只留下拉丁字母：连字符、撇号、数字都当作词内噪声去掉
    var word = s.toLowerCase().replace(/[^a-z]/g, "");
    if (!word) return { kana: "\u30A2", confident: false }; // ア

    // 超长词（URL、ID 之类混进歌词）先截断，免得规则在几千个字符上空转
    if (word.length > 24) word = word.substr(0, 24);

    // 双元音连在一起、或超过 4 个辅音连缀：这两类拼写规则最靠不住，先标上
    var confident = !(hasVowelRun(word) || hasLongConsonantRun(word));

    if (ENGLISH_EXCEPTIONS[word] !== undefined) {
      return { kana: ENGLISH_EXCEPTIONS[word], confident: true };
    }
    if (ENGLISH_LEXICON[word] !== undefined) {
      return { kana: ENGLISH_LEXICON[word], confident: true };
    }

    var res = convertEnglish(word);
    return { kana: res.kana, confident: confident && res.confident };
  }

  /**
   * 有没有「拿不准」的元音连写。
   * 注意只在连写的第一个元音上判断一次：否则 "clover" 走到 o 的时候会把
   * "lo" 当成一个元音对来查，白白标成没把握。
   */
  function hasVowelRun(word) {
    var run = 0;
    for (var i = 0; i < word.length; i++) {
      if ("aiueo".indexOf(word.charAt(i)) >= 0) {
        run++;
        // 三个及以上元音连写（beau 这种例外表没收录的）算没把握；
        // 两个的只要在 EN_VOWEL_FIX 里就放过，否则也算没把握。
        if (run >= 3) return true;
        if (run === 2 && EN_VOWEL_FIX[word.substr(i - 1, 2)] === undefined) return true;
      } else {
        run = 0;
      }
    }
    return false;
  }

  /** 连续 5 个及以上辅音。 */
  function hasLongConsonantRun(word) {
    var run = 0;
    for (var i = 0; i < word.length; i++) {
      if (RE_CONSONANT.test(word.charAt(i))) {
        run++;
        if (run >= 5) return true;
      } else {
        run = 0;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ 规范化

  /**
   * 小写化 + 去掉首尾非字母字符。
   * 中间的字符不动（"e-mail" 还是 "e-mail"，查表时会另做一次「只留字母」的尝试）。
   */
  function normalize(s) {
    if (typeof s !== "string") return "";
    return s.toLowerCase().replace(/^[^a-z]+/, "").replace(/[^a-z]+$/, "");
  }

  /** 去掉所有非字母字符（"e-mail" -> "email"）。只给查表用。 */
  function stripNonLetters(s) {
    return s.replace(/[^a-z]/g, "");
  }

  // ------------------------------------------------------------ reader

  /**
   * 建一个读音器。
   *
   * @param {Object} opts
   *   opts.dict 英文小写 -> 片假名 的离线词表（可以是空对象或 undefined）
   *   opts.log  可选，(msg) => void，只用来报调试信息，正常路径不调用
   * @returns {Object} { read, addOnline, stats }
   */
  function createReader(opts) {
    var options = opts || {};
    // 词表可能直接传进来，也可能什么都没传
    var dict = options.dict && typeof options.dict === "object" ? options.dict : {};
    // 联网校正结果只放内存，进程退出就没了（下次联网再学一遍）
    var online = {};
    var log = typeof options.log === "function" ? options.log : null;

    var stat = { dictHits: 0, romajiHits: 0, ruleHits: 0, onlineHits: 0, missed: 0 };

    /** 只在这里打日志，方便上层开开关排查 */
    function trace(msg) {
      if (log) log(msg);
    }

    /**
     * 一次查找要试的键，按优先级：原样 -> 小写(去首尾标点) -> 去掉所有非字母。
     * 两张表（dict / online）用同一套键，免得出「查的时候折了、存的时候没折」
     * 这种一边能命中一边命不中的毛病（"e-mail" 就是这种情况）。
     */
    function keysFor(raw, shown) {
      var keys = [raw];
      if (shown && shown !== raw) keys.push(shown);
      var stripped = stripNonLetters(shown);
      if (stripped && stripped !== shown && stripped !== raw) keys.push(stripped);
      return keys;
    }

    /**
     * 一次查找的完整判定顺序：
     *   ① dict：原样 -> 小写 -> 去掉非字母
     *   ② romajiToKatakana（切不干净会返回 null，自然落到 ③）
     *   ③ englishToKatakana
     * 查不到返回 null（输入为空、或规范化后没有拉丁字母，也走这条路）。
     */
    function lookup(raw) {
      if (typeof raw !== "string") return null;

      // 去掉首尾标点后再判断「有没有拉丁字母」。
      // 纯标点（"..."）和空串都在这里被挡掉。
      var shown = normalize(raw);
      if (!shown || !RE_LATIN.test(shown)) return null;

      var keys = keysFor(raw, shown);
      var i;
      var key;

      // ① 词典
      for (i = 0; i < keys.length; i++) {
        key = keys[i];
        if (dict[key] !== undefined && dict[key]) {
          trace("dict 命中：" + key);
          return { kana: dict[key], source: "dict", confident: true };
        }
      }

      // 联网学到的读音排在词典之后：词典是人工核过的，联网结果可能会漂
      for (i = 0; i < keys.length; i++) {
        key = keys[i];
        if (online[key] !== undefined) {
          trace("online 命中：" + key);
          return { kana: online[key], source: "online", confident: true };
        }
      }

      // ② 罗马音。这里用 shown（已小写、去了首尾标点）而不是 stripNonLetters，
      //    因为 "saka-" 词尾的连字符是长音符，不能被吃掉。
      var kana = romajiToKatakana(shown);
      if (kana) {
        trace("romaji 命中：" + shown + " -> " + kana);
        return { kana: kana, source: "romaji", confident: true };
      }

      // ③ 英文规则。永远有结果（最差也是个不 confident 的读音）。
      var res = englishToKatakana(shown);
      trace("rule 命中：" + shown + " -> " + res.kana + "（confident=" + res.confident + "）");
      return { kana: res.kana, source: "rule", confident: res.confident };
    }

    /** 公开的 read：负责计一次数 */
    function read(word) {
      var res = lookup(word);
      if (!res) {
        stat.missed++;
        return null;
      }
      if (res.source === "dict") stat.dictHits++;
      else if (res.source === "romaji") stat.romajiHits++;
      else if (res.source === "online") stat.onlineHits++;
      else stat.ruleHits++;
      return res;
    }

    /**
     * 把联网校正的结果写进内存。
     * 只收「全是片假名/长音符」的读音——联网返回里混进英文、汉字、
     * 或者干脆是个句子的时候，宁可丢掉，也不要把脏数据灌进词表。
     * 空串、非字符串一律拒绝。
     *
     * @returns {boolean} 收下了返回 true，拒绝了返回 false
     */
    function addOnline(word, kana) {
      if (typeof word !== "string" || typeof kana !== "string") return false;
      var key = normalize(word);
      if (!key) return false;
      if (!RE_KATAKANA.test(kana)) {
        trace("addOnline 拒绝（不是纯片假名）：" + kana);
        return false;
      }
      // 按 lookup 会试的那几种键都存一份："e-mail" 存进去之后，
      // 以后再读 "email" / "E-Mail" 都要能命中。
      var keys = keysFor(key, key);
      for (var i = 0; i < keys.length; i++) online[keys[i]] = kana;
      trace("addOnline 收下：" + keys.join(" / ") + " -> " + kana);
      return true;
    }

    /** 计数快照（给测试和调试面板用；直接返回内部对象，调用方别改） */
    function stats() {
      return {
        dictHits: stat.dictHits,
        romajiHits: stat.romajiHits,
        ruleHits: stat.ruleHits,
        onlineHits: stat.onlineHits,
        missed: stat.missed,
      };
    }

    return { read: read, addOnline: addOnline, stats: stats };
  }

  return {
    romajiToKatakana: romajiToKatakana,
    englishToKatakana: englishToKatakana,
    createReader: createReader,
    normalize: normalize,
    // 下面这些是给上层/测试翻表用的，不在任务要求的四个 API 里，但不多余
    ENGLISH_EXCEPTIONS: ENGLISH_EXCEPTIONS,
    RE_KATAKANA: RE_KATAKANA,
  };
});
