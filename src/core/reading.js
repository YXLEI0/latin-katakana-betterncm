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

  /*
   * 词尾不发音的字母组合（knock / wrap / gnome / psalm / pneumonia）。
   * 这几组在英语里没有例外，见 convertEnglish 里的第 0 条。
   */
  var EN_SILENT_HEAD = /^(kn|wr|gn|ps|pn)/;

  /*
   * 词尾 -ize / -yze：英语里这一律读 /aɪz/（memorize・organize・analyze・realize），
   * 所以整块读「辅音 + アイズ」，**前面的辅音要拉到 a 上**（memorize = メモ + ライズ）。
   *
   * 为什么单列一条：规则层原本把 -ize 当普通拼读，读成「ゼ」
   * （用户截图里 `memorize` 被标成 メモリゼ，那还是**罗马音层**抢先给的），
   * 一整类词（organize オーガニゼ、apologize アポロギゼ、analyze アナライゼ…）
   * 全错。软音 g/c 要按 ジャ/サ 走（apologize アポロジャイズ、criticize クリティサイズ）。
   */
  var EN_IZE = /^([a-z]*?)([bcdfghjklmnpqrstvwxyz])(iz|yz)(e[sd]?|ing)$/;

  /** 同一个形状，但用来在罗马音层**拒绝**它（词干可以是空的：size / prize） */
  var RE_ENGLISH_IZE = /^[a-z]*[bcdfghjklmnpqrstvwxyz](iz|yz)(e[sd]?|ing)$/;

  /*
   * 词尾 -ude（jude / rude / nude / dude / gratitude / solitude / interlude…）：
   * 那个 e 不发音，u 是 /uː/（jude ジュード、rude ルード），辅音并入 u 那一拍。
   *
   * 为什么单列：罗马音层会把 `jude` 切成 ju-de 读成 ジュデ（用户截图里的
   * `KiLLKiSS jude...`），规则层也会把 gratitude 读成 グラティトゥデ。
   * 英语里 du/tu 的惯例读法是 デュ/テュ（dude デュード、attitude アティテュード），
   * 所以这两个辅音单独指定；别的走"辅音 + u"的默认行（rude ルード、nude ヌード）。
   */
  var EN_UDE = /^([a-z]*)([bcdfghjklmnpqrstvwxyz])ude$/;

  /** 同一个形状，用来在罗马音层拒绝它（词干可以是空的：jude / size） */
  var RE_ENGLISH_UDE = /^[a-z]*[bcdfghjklmnpqrstvwxyz]ude$/;

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
  //
  // 拼写规则的依据是 sci.lang.japan FAQ 的
  //   How do I write an English word in Japanese?
  //   https://www.sljfaq.org/afaq/english-in-japanese.html
  // 下面每条规则/每张表都注了「参照 sljfaq：…」，指的是该页的哪一条约定。
  // 该页的总纲是：日语借词优先采用**英式发音**（vitamin -> ビタミン 而不是
  // バイタミン），所以下面的规则（尤其是非重读 r）都按英式（不卷舌）写。
  //
  // convertEnglish 的扫描顺序（顺序本身就是规则，乱了就会读错）：
  //   1. 词尾不发音的 e（-ce / -ge / -Cle 这些固定收尾除外）
  //   2. r 化元音：元音 + r +（词尾或辅音）-> 长音。参照 sljfaq 的非重读 r：
  //      park -> パーク、bird -> バード、horse -> ホース。
  //      **必须排在「辅音 + 元音」两字母块前面**，否则 park 会读成 パラク。
  //   3. 词尾 y -> イー / -Cle / -ce -ge / -ous / -ds
  //   4. -ture / -tion / -sion / -ious
  //   5. 四/三/两字母元音块（igh / ier / ee / ea / ...）
  //   6. θ（th）、ŋ（ng / nk / nc）、ts、辅音 + l/r 连缀、二合字母
  //   7. c 在 e/i/y 前、辅音 + 元音两字母块（含 ca 的 キャ）
  //   8. 双辅音促音、m/n 在辅音前收 ン、词尾元音 + r
  //   9. 单字母（元音 / 词尾 r / 词尾辅音 / 辅音）
  //  10. 单音节词的词尾塞音补促音 ッ（参照 sljfaq：hot -> ホット）
  // 每一步都至少吃掉一个字符，认不出就跳过并标 confident:false，
  // 保证不死循环、不吐空串。

  /*
   * 不规则例外表：拼写和读音对不上、或者规则一定会读错的词。
   * 命中就走这里，confident 一律 true（都是人工核过的读音）。
   * 形状：小写英文 -> 片假名
   */
  var ENGLISH_EXCEPTIONS = {
    // ---- 任务点名的 31 个
    light: "\u30E9\u30A4\u30C8", // ライト（参照 sljfaq：igh -> アイ，gh 是默字）
    night: "\u30CA\u30A4\u30C8", // ナイト（同上）
    right: "\u30E9\u30A4\u30C8", // ライト（同上）
    high: "\u30CF\u30A4", // ハイ（同上）
    through: "\u30B9\u30EB\u30FC", // スルー（ough 读 /uː/，拼写定不下来）
    though: "\u30BE\u30A6", // ゾウ（ough 读 /əʊ/，同上）
    enough: "\u30A4\u30CA\u30D5", // イナフ（ough 读 /ʌf/，同上）
    love: "\u30E9\u30D6", // ラブ（参照 sljfaq：v -> バ行）
    one: "\u30EF\u30F3", // ワン（o 读 /wʌ/）
    two: "\u30C8\u30A5\u30FC", // トゥー（参照 sljfaq：tu -> トゥ（新式）或 ツ）
    eight: "\u30A8\u30A4\u30C8", // エイト
    heart: "\u30CF\u30FC\u30C8", // ハート（ear 这里读 /ɑː/）
    world: "\u30EF\u30FC\u30EB\u30C9", // ワールド（wor 读 /wɜː/）
    dream: "\u30C9\u30EA\u30FC\u30E0", // ドリーム
    school: "\u30B9\u30AF\u30FC\u30EB", // スクール（oo 读 /uː/）
    blue: "\u30D6\u30EB\u30FC", // ブルー（ue 读 /uː/）
    eyes: "\u30A2\u30A4\u30BA", // アイズ
    time: "\u30BF\u30A4\u30E0", // タイム（词尾默字 e = 前面的元音是长音）
    shine: "\u30B7\u30E3\u30A4\u30F3", // シャイン（同上）
    sky: "\u30B9\u30AB\u30A4", // スカイ（词尾 y 读 /aɪ/）
    star: "\u30B9\u30BF\u30FC", // スター（参照 sljfaq：ar + 词尾 -> アー）
    snow: "\u30B9\u30CE\u30A6", // スノウ（ow 读 /əʊ/，与 now 的 /aʊ/ 拼写分不开）
    flow: "\u30D5\u30ED\u30A6", // フロウ（同上）
    know: "\u30CE\u30A6", // ノウ（同上，kn 的 k 是默字）
    why: "\u30DB\u30EF\u30A4", // ホワイ（wh 读 /w/）
    fall: "\u30D5\u30A9\u30FC\u30EB", // フォール（al + 辅音读 /ɔːl/）
    call: "\u30B3\u30FC\u30EB", // コール（同上）
    wall: "\u30A6\u30A9\u30FC\u30EB", // ウォール（同上）
    girl: "\u30AC\u30FC\u30EB", // ガール（参照 sljfaq：ir + r -> アー）
    summer: "\u30B5\u30DE\u30FC", // サマー（参照 sljfaq：词尾 -er -> アー；mm 不促音）
    winter: "\u30A6\u30A3\u30F3\u30BF\u30FC", // ウィンター（参照 sljfaq：m/n 在辅音前收 ン + -er -> アー）

    // ---- 规则一定会读错的其它高频词
    coffee: "\u30B3\u30FC\u30D2\u30FC", // コーヒー（ff 不该促音，接 ee 规则会读成 コッヒー）
    camera: "\u30AB\u30E1\u30E9", // カメラ（词尾默字 e，标准写法就是 カメラ）
    dance: "\u30C0\u30F3\u30B9", // ダンス（-ce -> ス 走规则，长音判断人工确权）
    people: "\u30D4\u30FC\u30D7\u30EB", // ピープル（-ple -> プル 走规则，长音确权）
    water: "\u30A6\u30A9\u30FC\u30BF\u30FC", // ウォーター
    flower: "\u30D5\u30E9\u30EF\u30FC", // フラワー（ow 读 /aʊə/）
    power: "\u30D1\u30EF\u30FC", // パワー（同上）
    tower: "\u30BF\u30EF\u30FC", // タワー（同上）
    hour: "\u30A2\u30EF\u30FC", // アワー（our 读 /aʊə/）
    your: "\u30E8\u30A2", // ヨア
    very: "\u30D9\u30EA\u30FC", // ベリー（v -> バ行 + 词尾 y -> イー）
    every: "\u30A8\u30D6\u30EA\u30A4", // エブリイ（词尾 y 这里是短 イ）
    again: "\u30A2\u30B2\u30A4\u30F3", // アゲイン
    answer: "\u30A2\u30F3\u30B5\u30FC", // アンサー
    island: "\u30A2\u30A4\u30E9\u30F3\u30C9", // アイランド（s 是默字）
    listen: "\u30EA\u30B9\u30F3", // リスン（t 是默字）
    castle: "\u30AD\u30E3\u30C3\u30B9\u30EB", // キャッスル（t 是默字）
    who: "\u30D5\u30FC", // フー（wh 在这里读 /h/）
    whole: "\u30DB\u30FC\u30EB", // ホール（w 是默字）
    once: "\u30EF\u30F3\u30B9", // ワンス
    eye: "\u30A2\u30A4", // アイ
    music: "\u30DF\u30E5\u30FC\u30B8\u30C3\u30AF", // ミュージック（-sic 的 s 读 /z/）
    magic: "\u30DE\u30B8\u30C3\u30AF", // マジック（g 在 i 前读 /dʒ/）
    voice: "\u30DC\u30A4\u30B9", // ボイス
    prince: "\u30D7\u30EA\u30F3\u30B9", // プリンス
    since: "\u30B7\u30F3\u30B9", // シンス
    science: "\u30B5\u30A4\u30A8\u30F3\u30B9", // サイエンス（sc 在 i 前读 /s/）
    quiet: "\u30AF\u30EF\u30A4\u30A8\u30C3\u30C8", // クワイエット
    young: "\u30E4\u30F3\u30B0", // ヤング（ou 读 /ʌ/）
    double: "\u30C0\u30D6\u30EB", // ダブル（-ble -> ブル 走规则）
    trouble: "\u30C8\u30E9\u30D6\u30EB", // トラブル（同上，ou 读 /ʌ/）
    country: "\u30AB\u30F3\u30C8\u30EA\u30FC", // カントリー（ou 读 /ʌ/）
    journey: "\u30B8\u30E3\u30FC\u30CB\u30FC", // ジャーニー（our 读 /ɜː/）
  };

  /*
   * 常见外来语小表（英文 -> 片假名）。
   *
   * 和 ENGLISH_EXCEPTIONS 分开放，因为性质不同：
   *   ENGLISH_EXCEPTIONS 是「拼写本来就不规则」（light / through / love）。
   *   ENGLISH_LEXICON   是「拼写规则，但规则会读歪/读土」的高频外来语。
   * 参照 sljfaq：「有现成外来语写法的词就沿用那个写法」（black coffee ->
   * ブラックコーヒー，哪怕 kōhii 本来来自荷兰语）。所以这张表在规则之上。
   * 每条注释写明「规则现在给什么」，方便以后规则变强时判断能不能删。
   */
  var ENGLISH_LEXICON = {
    clover: "\u30AF\u30ED\u30FC\u30D0\u30FC", // クローバー（规则：クローバー，-er 确权）
    over: "\u30AA\u30FC\u30D0\u30FC", // オーバー（参照 sljfaq：v -> バ行）
    computer: "\u30B3\u30F3\u30D4\u30E5\u30FC\u30BF\u30FC", // コンピューター（规则：コンピュータ + 长音）
    story: "\u30B9\u30C8\u30FC\u30EA\u30FC", // ストーリー（规则：ストーリー，-y 长度确权）
    melody: "\u30E1\u30ED\u30C7\u30A3\u30FC", // メロディー（规则：メロディー）
    diorama: "\u30B8\u30AA\u30E9\u30DE", // ジオラマ（规则：ディオラマ。外来语里 dia 缩成 ジ）
    radio: "\u30E9\u30B8\u30AA", // ラジオ（规则：ラディオ，同上）
    piano: "\u30D4\u30A2\u30CE", // ピアノ（规则：ピアノー，词尾 o 的长度）
    guitar: "\u30AE\u30BF\u30FC", // ギター（规则：ギター，参照 sljfaq 的 ar -> アー）
    color: "\u30AB\u30E9\u30FC", // カラー（规则：カラー）
    colour: "\u30AB\u30E9\u30FC", // カラー（同上，英式拼写）
    heaven: "\u30D8\u30D6\u30F3", // ヘブン
    seven: "\u30BB\u30D6\u30F3", // セブン
    eleven: "\u30A4\u30EC\u30D6\u30F3", // イレブン
    open: "\u30AA\u30FC\u30D7\u30F3", // オープン
    lemon: "\u30EC\u30E2\u30F3", // レモン
    season: "\u30B7\u30FC\u30BA\u30F3", // シーズン
    reason: "\u30EA\u30FC\u30BA\u30F3", // リーズン
    person: "\u30D1\u30FC\u30BD\u30F3", // パーソン（参照 sljfaq 的 er -> アー）
    lesson: "\u30EC\u30C3\u30B9\u30F3", // レッスン（参照 sljfaq 的促音那条）
    message: "\u30E1\u30C3\u30BB\u30FC\u30B8", // メッセージ（同上，-ge -> ジ）
    silence: "\u30B5\u30A4\u30EC\u30F3\u30B9", // サイレンス（规则：シレンス，i 的长度）
    distance: "\u30C7\u30A3\u30B9\u30BF\u30F3\u30B9", // ディスタンス（参照 sljfaq：ti/di -> ティ/ディ）
    balance: "\u30D0\u30E9\u30F3\u30B9", // バランス
    present: "\u30D7\u30EC\u30BC\u30F3\u30C8", // プレゼント
    moment: "\u30E2\u30FC\u30E1\u30F3\u30C8", // モーメント
    diamond: "\u30C0\u30A4\u30E4\u30E2\u30F3\u30C9", // ダイヤモンド
    planet: "\u30D7\u30E9\u30CD\u30C3\u30C8", // プラネット
    crystal: "\u30AF\u30EA\u30B9\u30BF\u30EB", // クリスタル（规则：クリスタル）
    secret: "\u30B7\u30FC\u30AF\u30EC\u30C3\u30C8", // シークレット（ee 的长度）
    spirit: "\u30B9\u30D4\u30EA\u30C3\u30C8", // スピリット
    future: "\u30D5\u30E5\u30FC\u30C1\u30E3\u30FC", // フューチャー（参照 sljfaq：-ture -> チャー）
    nature: "\u30CD\u30A4\u30C1\u30E3\u30FC", // ネイチャー（同上）
    picture: "\u30D4\u30AF\u30C1\u30E3\u30FC", // ピクチャー（同上）
    culture: "\u30AB\u30EB\u30C1\u30E3\u30FC", // カルチャー（同上）
    queen: "\u30AF\u30A4\u30FC\u30F3", // クイーン（规则：クイーン，长音确权）
    jazz: "\u30B8\u30E3\u30BA", // ジャズ（zz 促音 + 词尾默字 e）
    digital: "\u30C7\u30B8\u30BF\u30EB", // デジタル（规则：ディジタル，外来语取 デジ）
    letter: "\u30EC\u30BF\u30FC", // レター（参照 sljfaq：tt 不促音 + -er -> アー）
    better: "\u30D9\u30BF\u30FC", // ベター（同上）
    mirror: "\u30DF\u30E9\u30FC", // ミラー（同上，rr 不促音）
    error: "\u30A8\u30E9\u30FC", // エラー（同上）
    horror: "\u30DB\u30E9\u30FC", // ホラー（同上）
    dinner: "\u30C7\u30A3\u30CA\u30FC", // ディナー（同上，nn 收 ン）
    city: "\u30B7\u30C6\u30A3", // シティ（规则：シティー，但外来语习惯不加长音）
    party: "\u30D1\u30FC\u30C6\u30A3\u30FC", // パーティー（规则：パーティー）
    pretty: "\u30D7\u30EA\u30C6\u30A3", // プリティ
    happy: "\u30CF\u30C3\u30D4\u30FC", // ハッピー（规则：ハッピー）
    lucky: "\u30E9\u30C3\u30AD\u30FC", // ラッキー（规则：ラキー，u 是短 /ʌ/）
    lady: "\u30EC\u30C7\u30A3", // レディ
    sign: "\u30B5\u30A4\u30F3", // サイン（词尾 gn 的 g 是默字）
    design: "\u30C7\u30B6\u30A4\u30F3", // デザイン（同上）

    // ---- 拼写型转写（参照 sljfaq 的 "Conversions based on spelling" 那节：
    //      「拼写有时压过发音」，这些词的写法只能按拼写习惯定）
    phone: "\u30D5\u30A9\u30F3", // フォン（词尾默字 e 的长度分不出来；ph -> フォ 走规则）
    sugar: "\u30B7\u30E5\u30AC\u30FC", // シュガー（s 在 u 前读 /ʃ/）
    visual: "\u30F4\u30A3\u30B8\u30E5\u30A2\u30EB", // ヴィジュアル（参照 sljfaq：v 的备选写法就是 ヴィ）
    visualise: "\u30F4\u30A3\u30B8\u30E5\u30A2\u30E9\u30A4\u30BA", // ヴィジュアライズ（同上）
    visualize: "\u30F4\u30A3\u30B8\u30E5\u30A2\u30E9\u30A4\u30BA", // ヴィジュアライズ（同上）
    violin: "\u30D0\u30A4\u30AA\u30EA\u30F3", // バイオリン（参照 sljfaq：v 的首选是 バ行）
    vitamin: "\u30D3\u30BF\u30DF\u30F3", // ビタミン（参照 sljfaq 首页例子：英式 bitamin）
    video: "\u30D3\u30C7\u30AA", // ビデオ（参照 sljfaq：v -> バ行）
    tourette: "\u30C8\u30A5\u30EC\u30C3\u30C8", // トゥレット（参照 sljfaq：tu -> トゥ（新式））
    moon: "\u30E0\u30FC\u30F3", // ムーン（oo 读 /uː/）
    moonlight: "\u30E0\u30FC\u30F3\u30E9\u30A4\u30C8", // ムーンライト（同上，n + l 要拆开）
    sunshine: "\u30B5\u30F3\u30B7\u30E3\u30A4\u30F3", // サンシャイン（u 在 /n/ 前是 /ʌ/ + sh -> シャ）
    destiny: "\u30C7\u30B9\u30C6\u30A3\u30CB\u30FC", // デスティニー（参照 sljfaq：ti -> ティ）
    goodbye: "\u30B0\u30C3\u30D0\u30A4", // グッバイ（d 在 b 前不发音）
    remember: "\u30EA\u30E1\u30F3\u30D0\u30FC", // リメンバー（b 在 m 后不发音 + -er -> アー）
    together: "\u30C8\u30A5\u30B2\u30B6\u30FC", // トゥゲザー（参照 sljfaq：ð -> ザ行）
    second: "\u30BB\u30AB\u30F3\u30C9", // セカンド（c 在 e 前读 /k/）
    button: "\u30DC\u30BF\u30F3", // ボタン（tt 不促音 + 词尾默字 e）
    cotton: "\u30B3\u30C3\u30C8\u30F3", // コットン（tt 促音）
    common: "\u30B3\u30E2\u30F3", // コモン（mm 不促音）
    hamburger: "\u30CF\u30F3\u30D0\u30FC\u30AC\u30FC", // ハンバーガー（参照 sljfaq：m/n 收 ン + ə 按拼写 ar -> アー）
  };

  // 英文短元音/长元音的默认读音（按字母尾那套来读）
  var EN_VOWEL = {
    a: "\u30A2", // ア
    i: "\u30A4", // イ
    u: "\u30A6", // ウ
    e: "\u30A8", // エ
    o: "\u30AA", // オ
  };

  // r 化元音表：**英式（不卷舌）** 里「元音 + r + 辅音或词尾」的 r 不发音，
  // 只把前面的元音拉长。参照 sljfaq 的 Long vowels 各行：
  //   ɑː -> アー（car）、ɜː -> アー（bird）、ɔː -> オー（horse）。
  // 该页首页也明说 "the two different vowels in fur and far both get turned
  // into Japanese ファー"，所以 er/ir/ur 和 ar 一样收到 アー。
  // 命中条件（在 2 号规则里）：r 后面是词尾或辅音；r 后面是元音时
  // r 归下一个音节（story 的 or-y、care 的词尾 e），不算。
  var EN_R_VOWEL = {
    ar: "\u30A2\u30FC", // アー：car -> カー、park -> パーク、star -> スター
    er: "\u30A2\u30FC", // アー：her -> ハー、person -> パーソン、winter -> ウィンター
    ir: "\u30A2\u30FC", // アー：bird -> バード、girl -> ガール、shirt -> シャート
    ur: "\u30A2\u30FC", // アー：turn -> ターン、hurt -> ハート、surfing -> サーフィン
    or: "\u30AA\u30FC", // オー：horse -> ホース、north -> ノース、short -> ショート
    yr: "\u30A2\u30FC", // アー（yr 只在 myrtle 这类词里出现，和 ir 同音）
  };

  // 元音连写（两、三、四个字母），参照 sljfaq 的 Diphthongs / Long vowels 行：
  //   eɪ -> エイ（day）、aɪ -> アイ（my）、ɔɪ -> オイ（toy）、
  //   əʊ -> オ（no 的 ノー）、aʊ -> アウ（now）、ɪə -> イア（pierce）、
  //   ʊə -> ウアー（tour）、uː -> ウー（shoe）、iː -> イー（shield）。
  // 读音不唯一的拼法（ow / oo / ou / ea ...）由 EN_UNSURE_RE 标 confident:false。
  var EN_VOWEL_FIX = {
    // 四字母
    igh: "\u30A2\u30A4", // アイ：light -> ライト（参照 sljfaq 的 igh）
    eau: "\u30FC", // ー：beautiful -> ビューティフル
    // 三字母
    ier: "\u30A4\u30A2", // イア：pierce -> ピアス（参照 sljfaq：ɪə -> イア；r 不发音）
    our: "\u30A2\u30A6\u30A2\u30FC", // アウアー：hour -> アウアー
    // 两字母
    ee: "\u30A4\u30FC", // イー：shield -> シールド
    ea: "\u30A4\u30FC", // イー：dream(例外表) 之外，sea 这类也是这样
    oo: "\u30A6\u30FC", // ウー：shoe -> シュー
    ou: "\u30A2\u30A6", // アウ：about -> アバウト
    ow: "\u30A2\u30A6", // アウ：now -> ナウ（snow 是例外表）
    oa: "\u30AA\u30A6", // オウ：road -> ロウド
    oe: "\u30AA\u30FC", // オー：toe -> トー
    ai: "\u30A8\u30A4", // エイ：rain -> レイン
    ay: "\u30A8\u30A4", // エイ：day -> デイ
    ey: "\u30A8\u30A4", // エイ：they -> ゼイ
    oi: "\u30AA\u30A4", // オイ：boy -> ボイ（参照 sljfaq：ɔɪ -> オイ 或 オーイ）
    oy: "\u30AA\u30A4", // オイ：toy -> トイ
    au: "\u30AA\u30FC", // オー：because 的 au（参照 sljfaq：ɔː -> オー）
    aw: "\u30AA\u30FC", // オー：saw -> ソー
    ie: "\u30A4\u30FC", // イー：field -> フィールド（pierce 的 イア 由 ier 先吃）
    ue: "\u30A6\u30FC", // ウー：blue(例外表) 之外，true -> トゥルー
    ew: "\u30E6\u30FC", // ュー：new -> ニュー
    ui: "\u30A6\u30A4", // ウイ：guide 的 u 是默字
  };

  // 词尾「辅音 + 词尾 y」-> 那个辅音 + イー。
  // 参照 sljfaq：「A consonant + word-final y reads イー（happy -> ハッピー,
  // city -> シティ, lucky -> ラッキー）」。前面是元音的词尾 y（ay/ey/oy）
  // 由 EN_VOWEL_FIX 先吃，走不到这里。
  var EN_FINAL_CONSONANT_Y = "\u30A4\u30FC"; // イー

  // 双辅音字母组合。必须先于单字母处理，否则 sh 会被拆成 s + h。
  // θ 的 th 要看后面那个元音才能定（参照 sljfaq：θ -> サ行，
  // think -> シンク 而不是 サインク），所以 th 不在本表里，查 EN_TH。
  // ng 也不在本表里：它要看后面有没有元音（见 6b）。
  var EN_DIGRAPH = {
    sh: "\u30B7", // シ（参照 sljfaq：sh -> シャ行；后面的元音由 EN_PAIR 补）
    ch: "\u30C1", // チ（参照 sljfaq：ch -> チ）
    ph: "\u30D5", // フ（参照 sljfaq：f -> ファ行，ph 同音）
    wh: "\u30EF", // ワ（参照 sljfaq：w -> ウィ；wh 同音，h 不发音）
    ck: "\u30C3\u30AF", // ック：book -> ブック（k 一个音）
    ss: "\u30B9", // ス（question 的 ss 读 ス，不加 ッ）
    gh: "\u30FC", // ー（gh 大多是默字：light 走例外表，这里兜漏网）
    qu: "\u30AF\u30EF", // クワ（参照 sljfaq 的 special combinations）
    wr: "\u30E9", // ラ（write 的 w 是默字）
    kn: "\u30CA", // ナ（know 的 k 是默字，例外表里有；这里兜底）
  };

  // θ 的サ行，按后面接的元音选哪一段。参照 sljfaq：
  //   θ -> シャ/シ/シュ/シェ/ショ（サ行），think -> シンク。
  // th + 词尾 / th + 辅音 -> ス（参照 sljfaq：north -> ノース）。
  // 键是 th 后面那个元音字母，没有元音时用空串。
  var EN_TH = {
    a: "\u30B5", // サ
    i: "\u30B7", // シ：think -> シンク
    u: "\u30B7\u30E5", // シュ：thumb -> シュム 一侧
    e: "\u30BB", // セ：theatre -> セアター
    o: "\u30BD", // ソ：thought -> ソート
    "": "\u30B9", // ス：north -> ノース、birth -> バース
  };

  // ŋ 的两种写法。参照 sljfaq：
  //   ŋ 拼作 ng，后面有元音 -> ンガ行（singer -> シンガー）
  //   ŋ 拼作 ng，后面没有元音 -> ン（Washington -> ワシントン、surfing -> サーフィン）
  //   ŋ 拼作 nk/nc -> ン + 后面的 k/c（sink -> シンク）
  var EN_NG = {
    a: "\u30F3\u30AC", // ンガ
    i: "\u30F3\u30AE", // ンギ
    u: "\u30F3\u30B0", // ング
    e: "\u30F3\u30B2", // ンゲ
    o: "\u30F3\u30B4", // ンゴ
    y: "\u30F3\u30AE", // ンギ（angy 这类少见拼法）
  };

  // -Cle 收尾：辅音 + le 时是「那个辅音 + ル」。
  // 参照 sljfaq：simple -> シンプル、table -> テーブル、people -> ピープル。
  // 键是 le 前面那个辅音（前面是 ng 时取 g：single -> シングル）。
  var EN_FINAL_LE = {
    b: "\u30D6\u30EB", // ブル：table -> テーブル
    c: "\u30AF\u30EB", // クル：circle -> サークル
    d: "\u30C9\u30EB", // ドル：middle -> ミドル（dd 由促音规则补 ッ）
    f: "\u30D5\u30EB", // フル：shuffle -> シャッフル
    g: "\u30B0\u30EB", // グル：single -> シングル
    k: "\u30AF\u30EB", // クル：sparkle -> スパークル
    m: "\u30E0\u30EB", // ムル
    n: "\u30F3\u30EB", // ンル（ngle 取 g，所以很少走到）
    p: "\u30D7\u30EB", // プル：apple -> アップル、simple -> シンプル
    r: "\u30EB\u30EB", // ルル（rl 少见）
    s: "\u30B9\u30EB", // スル：castle -> キャッスル（t 是默字，例外表确权）
    t: "\u30C8\u30EB", // トル：little -> リトル（tt 补 ッ）
    v: "\u30D6\u30EB", // ブル（v 并入 バ行）
    x: "\u30AF\u30B9\u30EB", // クスル：axle -> アクスル
    z: "\u30BA\u30EB", // ズル：puzzle -> パズル
  };

  // 词尾 -ous -> アス（参照 sljfaq：-ous -> アス）。-ious / -eous 里前面的
  // i/e 已经由普通元音规则处理，所以这里只吃 ous。
  var EN_FINAL_OUS = "\u30A2\u30B9"; // アス

  // 词尾 -ce -> ス（dance -> ダンス）、词尾 -ge -> ジ（orange -> オレンジ）。
  // 参照 sljfaq 的词尾辅音约定：词尾只留一个辅音拍，默字 e 不再补 ー。
  var EN_FINAL_CE = "\u30B9"; // ス
  var EN_FINAL_GE = "\u30B8"; // ジ

  // 词尾元音 + r 的 r 化兜底（EN_R_VOWEL 漏掉时用）。
  // 参照 sljfaq 的非重读 r：-ar/-er/-ir/-ur -> アー、-or -> オー。
  var EN_FINAL_R = {
    er: "\u30A2\u30FC", // アー
    ar: "\u30A2\u30FC", // アー
    or: "\u30AA\u30FC", // オー
    ur: "\u30A2\u30FC", // アー
    ir: "\u30A2\u30FC", // アー
  };

  // 发音不唯一的拼法：命中就标 confident:false（上层据此走联网校正）。
  // 参照 sljfaq 的拼写型转写那节：θ/ð 都写 th、ow 在 now/snow 里读法不同、
  // oo 在 book/moon 里不同……这些光看拼写决定不了。
  // 注意 th 本身：θ -> サ行、ð -> ザ行 都有明确落点（页面里都写了），
  // 但**哪个词是 θ 哪个词是 ð** 拼写分不出来，所以仍然算「不放心」。
  // 不加 g 标志，免得 lastIndex 在多次调用之间残留。
  var EN_UNSURE_RE = [
    /th/, // θ 还是 ð（think 是 シンク、the 是 ザ，两条都合法）
    /wh/, // /w/ 还是 /hw/，日语里都写 ワ行
    /gh/, // 默字还是有声（light 的 gh 不发音，laugh 的 gh 是 f）
    /(oo|ou|ow|oa|oe)/, // book / moon、about / soul、now / snow 拼法一样读法不同
    /(ea|ew|ui)/, // ea 有 /iː/ /e/、ew 有 /juː/ /uː/、ui 的 u 常是默字
    /our/, // four / hour / tour 三个读音
    /^(wr|kn|ps|pn)/, // 词首默字拼法（write / know / psalm / pneumonia）
  ];

  // 双辅音字母的促音表（参照 sljfaq 的 "Addition of gemination"）。
  // 只收日语借词里真的会促音的组合，而且要求后面还有元音：
  //   message 的 ss 促音、pretty 的 tt 促音；kiss 词尾的 ss 不促音（キス）。
  // ff/ll/mm/rr/bb 不收：coffee/summer/mirror/rabbit 在日语里都不促音，
  // 收进来反而会把 coffee 读成 コッヒー。
  var EN_DOUBLE_GEMINATION = {
    cc: true,
    dd: true,
    gg: true,
    kk: true,
    pp: true,
    ss: true,
    tt: true,
    zz: true,
  };

  // 单音节词词尾的塞音补促音 ッ。参照 sljfaq：hot -> ホット、bed -> ベッド，
  // 首页例子 cat -> キャット、dog -> ドッグ。该页同时说明：多音节词里促音只
  // 落在**重读**音节上，而重音光看拼写定不下来 —— 所以只对单音节词动手
  // （单音节词唯一的元音就是重音），多音节词一律不猜。
  var EN_GEMINATE_FINAL = { t: true, d: true, g: true, k: true, p: true };

  // 词尾 ds -> ッズ。参照 sljfaq：dz -> ッズ（goods -> グッズ、kids -> キッズ）。
  var EN_FINAL_DS = "\u30C3\u30BA"; // ッズ

  // 「辅音 + 元音」两字母拼块（参照 sljfaq 的 Vowels and diphthongs 表）。
  // 查不到就退回单字母辅音的默认元音。
  var EN_PAIR = {
    ba: "\u30D0", // バ
    be: "\u30D9", // ベ
    bi: "\u30D3", // ビ
    bo: "\u30DC", // ボ
    bu: "\u30D6", // ブ
    ca: "\u30AB", // カ（开音节：cake / case / camera -> カメラ）
    ce: "\u30BB", // セ
    ci: "\u30B7", // シ
    co: "\u30B3", // コ
    cu: "\u30AF", // ク
    da: "\u30C0", // ダ
    de: "\u30C7", // デ
    di: "\u30C7\u30A3", // ディ（参照 sljfaq：ti/di -> ティ/ディ，Disney -> ディズニー）
    do: "\u30C9", // ド
    du: "\u30C9\u30A5", // ドゥ
    fa: "\u30D5\u30A1", // ファ（参照 sljfaq：f -> ファ/フィ/フ/フェ/フォ）
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
    ti: "\u30C6\u30A3", // ティ（参照 sljfaq：ti -> ティ（新式））
    to: "\u30C8", // ト
    tu: "\u30C8\u30A5", // トゥ（参照 sljfaq：tu -> トゥ（新式）或 ツ）
    va: "\u30D0", // バ（参照 sljfaq：v -> バ行 是首选写法）
    ve: "\u30D9", // ベ（同上）
    vi: "\u30D3", // ビ（同上：vitamin -> ビタミン）
    vo: "\u30DC", // ボ（同上）
    vu: "\u30D6", // ブ（同上）
    wa: "\u30EF", // ワ
    we: "\u30A6\u30A7", // ウェ
    wi: "\u30A6\u30A3", // ウィ（参照 sljfaq：w -> ウィ，win -> ウィン）
    wo: "\u30A6\u30A9", // ウォ
    ya: "\u30E4", // ヤ
    ye: "\u30A4\u30A7", // イェ
    yo: "\u30E8", // ヨ
    yu: "\u30E6", // ユ（参照 sljfaq：juː -> ュウ，cube -> キューブ 的 u 侧）
    za: "\u30B6", // ザ
    ze: "\u30BC", // ゼ
    zi: "\u30B8", // ジ
    zo: "\u30BE", // ゾ
    zu: "\u30BA", // ズ
  };

  // 单字母辅音单独出现时补的「读出来的元音」。
  // 日语没有单独辅音（ン 和 ッ 除外），所以必须补一个元音，这就是不准确的主要来源。
  //   - 唇音 b/m/p/f/v 补 u；齿龈音 d/t/s/z/l/r/n 补 u；软腭音 k/g 补 u；
  //     喉音 h 补 a；j 补 i、w 补 u、y 补 i
  //   - v 走 バ行（参照 sljfaq：v -> バ行 是首选写法，love -> ラブ、
  //     vitamin -> ビタミン、video -> ビデオ。ヴァ/ヴィ/ヴェ/ヴォ 是备选，
  //     只在日语实际那么写的词里用，那些词由例外表/小表兜住 —— visual 就是）
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
    v: "\u30D0",
    w: "\u30A6",
    x: "\u30AF\u30B9",
    y: "\u30A4",
    z: "\u30B6",
  };

  // m / n 在辅音前收 ン，不补元音。参照 sljfaq：
  //   hamburger -> ハンバーガー、London -> ロンドン、monkey -> モンキー、
  //   front -> フロント、stamp -> スタンプ。
  var EN_NASAL = "\u30F3"; // ン

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
    m: "\u30E0", // ム：ham -> ハム、time -> タイム
    n: "\u30F3", // ン：Washington -> ワシントン、phone -> フォン
    p: "\u30D7", // プ
    r: "\u30FC", // ー（over -> オーバー；正式的 r 化由 EN_R_VOWEL 处理）
    s: "\u30B9", // ス
    t: "\u30C8", // ト
    v: "\u30D6", // ブ（参照 sljfaq：v -> バ行）
    x: "\u30C3\u30AF\u30B9", // ックス
    z: "\u30BA", // ズ
  };

  /** 单个元音字母的读音。词尾的 e 在调用处先处理掉，不会走到这里。 */
  function enVowel(ch) {
    if (EN_VOWEL[ch] !== undefined) return EN_VOWEL[ch];
    if (ch === "y") return "\u30A4"; // イ
    return "";
  }

  /*
   * 「辅音 + 某个元音」怎么读：给 7a 的 r 化前瞻用。
   * **必须逐行显式列表**：片假名的码点顺序里 バ行和 パ行是交错的
   * （バ パ ヒ ビ ピ …），靠「ア段 + 序号」算码点会算出别行的音，
   * 所以这里老实把每个辅音的五段写出来。
   * 为什么不能直接用 EN_PAIR：那里带上下文特例（wo = ウォ、bi = ビ、
   * tu = トゥ、hu = フ…），借过来会把 bird 读成 ビ、turn 读成 トゥ。
   * 这张表要的是「辅音 + 元音」的**默认**读法。
   * 参照 sljfaq 的 Consonants 表：各行对应关系就是这张表。
   */
  var EN_CONSONANT_ROW = {
    b: { a: "\u30D0", i: "\u30D3", u: "\u30D6", e: "\u30D9", o: "\u30DC" }, // バ ビ ブ ベ ボ
    c: { a: "\u30AB", i: "\u30B7", u: "\u30AF", e: "\u30BB", o: "\u30B3" }, // カ シ ク セ コ（软音也算进来）
    d: { a: "\u30C0", i: "\u30C7\u30A3", u: "\u30C9\u30A5", e: "\u30C7", o: "\u30C9" }, // ダ ディ ドゥ デ ド
    g: { a: "\u30AC", i: "\u30AE", u: "\u30B0", e: "\u30B2", o: "\u30B4" }, // ガ ギ グ ゲ ゴ
    h: { a: "\u30CF", i: "\u30D2", u: "\u30D5", e: "\u30D8", o: "\u30DB" }, // ハ ヒ フ ヘ ホ
    k: { a: "\u30AB", i: "\u30AD", u: "\u30AF", e: "\u30B1", o: "\u30B3" }, // カ キ ク ケ コ
    l: { a: "\u30E9", i: "\u30EA", u: "\u30EB", e: "\u30EC", o: "\u30ED" }, // ラ リ ル レ ロ
    m: { a: "\u30DE", i: "\u30DF", u: "\u30E0", e: "\u30E1", o: "\u30E2" }, // マ ミ ム メ モ
    n: { a: "\u30CA", i: "\u30CB", u: "\u30CC", e: "\u30CD", o: "\u30CE" }, // ナ ニ ヌ ネ ノ
    p: { a: "\u30D1", i: "\u30D4", u: "\u30D7", e: "\u30DA", o: "\u30DD" }, // パ ピ プ ペ ポ
    q: { a: "\u30AB", i: "\u30AD", u: "\u30AF", e: "\u30B1", o: "\u30B3" }, // カ キ ク ケ コ
    r: { a: "\u30E9", i: "\u30EA", u: "\u30EB", e: "\u30EC", o: "\u30ED" }, // ラ リ ル レ ロ
    s: { a: "\u30B5", i: "\u30B7", u: "\u30B9", e: "\u30BB", o: "\u30BD" }, // サ シ ス セ ソ
    t: { a: "\u30BF", i: "\u30C6\u30A3", u: "\u30C8\u30A5", e: "\u30C6", o: "\u30C8" }, // タ ティ トゥ テ ト
    v: { a: "\u30D0", i: "\u30D3", u: "\u30D6", e: "\u30D9", o: "\u30DC" }, // バ ビ ブ ベ ボ（参照 sljfaq：v -> バ行）
    w: { a: "\u30EF", i: "\u30A6\u30A3", u: "\u30A6", e: "\u30A6\u30A7", o: "\u30A6\u30A9" }, // ワ ウィ ウ ウェ ウォ
    x: { a: "\u30AF\u30B5", i: "\u30AF\u30B7", u: "\u30AF\u30B9", e: "\u30AF\u30BB", o: "\u30AF\u30BD" }, // クサ クシ クス クセ クソ
    y: { a: "\u30E4", i: "\u30A4", u: "\u30E6", e: "\u30A4\u30A7", o: "\u30E8" }, // ヤ イ ユ イェ ヨ
    z: { a: "\u30B6", i: "\u30B8", u: "\u30BA", e: "\u30BC", o: "\u30BE" }, // ザ ジ ズ ゼ ゾ
  };

  // f 行（ファ フィ フ フェ フォ）全是小写 ァ 系，单列。
  var EN_F_ROW = {
    a: "\u30D5\u30A1", // ファ
    i: "\u30D5\u30A3", // フィ
    u: "\u30D5", // フ
    e: "\u30D5\u30A7", // フェ
    o: "\u30D5\u30A9", // フォ
  };

  // j 行（ジャ ジ ジュ ジェ ジョ）混小写 ャ 系，单列。
  var EN_J_ROW = {
    a: "\u30B8\u30E3", // ジャ
    i: "\u30B8", // ジ
    u: "\u30B8\u30E5", // ジュ
    e: "\u30B8\u30A7", // ジェ
    o: "\u30B8\u30E7", // ジョ
  };

  /**
   * 「辅音 + 元音」那一拍怎么读（给 7a 的 r 化前瞻用）。
   * 要的是**默认**读法，不是 EN_PAIR 里带上下文的特例。
   */
  function enConsonantVowel(ch, vowel) {
    if (vowel === undefined) return "";
    if (ch === "f") return EN_F_ROW[vowel] !== undefined ? EN_F_ROW[vowel] : "";
    if (ch === "j") return EN_J_ROW[vowel] !== undefined ? EN_J_ROW[vowel] : "";
    var row = EN_CONSONANT_ROW[ch];
    if (row === undefined || row[vowel] === undefined) return "";
    return row[vowel];
  }

  /** 这个字符是不是元音字母（英文规则里 y 当半元音，单独判断） */
  function charIsVowel(ch) {
    return ch !== "" && "aiueo".indexOf(ch) >= 0;
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
   * 词尾不发音的 e 前面那个辅音，能不能把前面那个元音「拉长」。
   * 参照 sljfaq：词尾 e 不发音，前面是单辅音时元音通常拉长
   * （time -> タイム、cube -> キューブ）。
   * 只收真正的塞音（ptkbd + c/b）：非塞音在日语里都是「辅音 + 元音」收尾
   * （nine 读 ナイン、some 读 サム、love 读 ラブ），拉长反而读错。
   */
  function enLengthensByE(ch) {
    return "ptkdbc".indexOf(ch) >= 0;
  }

  /** EN_UNSURE_RE 里有没有一条命中（用 test，不加 g 所以没有 lastIndex 状态） */
  function hasUnsureSpelling(word) {
    for (var i = 0; i < EN_UNSURE_RE.length; i++) {
      if (EN_UNSURE_RE[i].test(word)) return true;
    }
    return false;
  }

  /** 这个位置起是不是「辅音 + 词尾 le」（table 的 bl、people 的 pl） */
  function isFinalLe(word, i) {
    if (word.charAt(i) !== "l") return false;
    if (word.charAt(i + 1) !== "e") return false;
    if (i + 2 !== word.length) return false;
    if (i === 0) return false;
    // 前面必须是辅音：smile / style 是「元音 + le」，不是这一条
    return !charIsVowel(word.charAt(i - 1));
  }

  /**
   * 这个词是不是只有一个元音「组」（单音节）。
   * 促音只对单音节词的词尾塞音生效：参照 sljfaq，多音节词的促音落在
   * 重读音节上，而重音光看拼写定不下来 —— 不猜，交给 confident:false。
   */
  function isMonosyllable(word) {
    var groups = 0;
    var inRun = false;
    for (var i = 0; i < word.length; i++) {
      var c = word.charAt(i);
      if (charIsVowel(c) || (c === "y" && !charIsVowel(word.charAt(i - 1)))) {
        if (!inRun) {
          groups++;
          inRun = true;
          if (groups > 1) return false; // 两组以上就不是单音节了
        }
      } else {
        inRun = false;
      }
    }
    return groups === 1;
  }

  /**
   * 英文规则音译。返回 { kana, confident }，kana 一定非空。
   * 扫描顺序见本节开头那段注释（顺序本身就是规则）。
   * 每一步都至少吃掉一个字符，认不出就跳过并标 confident:false，
   * 保证不死循环、不吐空串。
   */
  function convertEnglish(word) {
    /*
     * ---- -ize / -yze 收尾（见 EN_IZE 的说明）。
     *
     * 词干照原样交给规则读，尾巴统一读「辅音 + アイズ」（含 -d/-s/-ing 变形）：
     *   memorize   メモ + ライズ   = メモライズ
     *   memorized  メモ + ライズド = メモライズド
     *   memorizing メモ + ライジング = メモライジング（-ing 的 s 要浊化）
     *   organize   オーガ + ナイズ = オーガナイズ
     *   apologize  アポロ + ジャイズ = アポロジャイズ（软音 g）
     *   criticize  クリティ + サイズ = クリティサイズ（软音 c）
     *   analyze    アナ + ライズ   = アナライズ
     * 词干是空的（size / prize 这类词根本身就是 "…ize"）就交给下面普通那条路，
     * 免得把 s 当尾巴的辅音读出个"サイズ"来。
     */
    var ude = EN_UDE.exec(word);
    if (ude) {
      var stemUde = ude[1] ? convertEnglish(ude[1]) : { kana: "", confident: true };
      var consUde = ude[2];
      var headUde =
        consUde === "d" ? "\u30C7\u30E5" // デュ（dude デュード）
          : consUde === "t" ? "\u30C6\u30E5" // テュ（attitude アティテュード）
            : enConsonantVowel(consUde, "u");
      if (headUde) {
        return {
          kana: stemUde.kana + headUde + "\u30FC\u30C9", // ー + ド
          confident: stemUde.confident && !hasUnsureSpelling(word),
        };
      }
    }

    var ize = EN_IZE.exec(word);
    if (ize) {
      var stemIze = ize[1] ? convertEnglish(ize[1]) : { kana: "", confident: true };
      var cons = ize[2];
      var head = cons === "g" ? "\u30B8\u30E3" : cons === "c" ? "\u30B5" : enConsonantVowel(cons, "a");
      if (head) {
        var ending = ize[4];
        /*
         * 注意这里拼的是「head + イズ」—— head 本身已经带 a 了
         * （メモ + **ラ** + イズ = メモライズ）。写成 head + アイズ 会多一个元音
         * （メモラアイズ ✗），这个坑我第一版就踩了。
         */
        var body =
          ending === "ed" ? "\u30A4\u30BA\u30C9" // イズド
            : ending === "es" ? "\u30A4\u30B8\u30BA" // イジズ（-es 的 s 浊化）
              : ending === "ing" ? "\u30A4\u30B8\u30F3\u30B0" // イジング
                : "\u30A4\u30BA"; // イズ
        return {
          kana: stemIze.kana + head + body,
          confident: stemIze.confident && !hasUnsureSpelling(word),
        };
      }
    }

    var kana = "";
    // 拼写本身就定不下读音的组合（th/gh/ow/... ）先标上不放心
    var confident = !hasUnsureSpelling(word);
    var i = 0;
    var len = word.length;

    while (i < len) {
      var ch = word.charAt(i);
      var rest = len - i;
      var nxt = word.charAt(i + 1);
      var nxt2 = word.charAt(i + 2);
      var pair;

      /*
       * ---- 0. 词首不发音的字母：kn- / wr- / gn- / ps- / pn-。
       *
       * 用户报的 `Knock knock!` 被规则读成「ナオック」—— `k` 是哑音。
       * 这几组在英语里**从不**发音（knock/knee/knight、wrap/write/wrong、
       * gnome、psalm/psychology、pneumonia），所以整组丢掉首字母就行。
       *
       * `wh-` 不在此列：who 哑 w、what 哑 h，得靠词表（词典里有 who/what/why）
       * 或者 `hasUnsureSpelling` 的标记，不能一刀切。
       * 词尾的 -mb 同理（comb/climb/lamb/bomb/thumb），但那是 b 哑，见下一条。
       */
      if (i === 0 && EN_SILENT_HEAD.test(word)) {
        i++;
        continue;
      }

      /*
       * ---- 0b. 词尾 -mb：b 不发音（comb コーム、climb クライム、lamb ラム、
       *          bomb ボム、thumb サム、tomb トゥーム、dumb ダム）。
       *          只处理**词尾**这一种：number / amber / timber 的 b 是发音的
       *          （ナンバー・アンバー・ティンバー），而 plumber 又哑 —— 词中
       *          的 mb 分不出来，那些交给词典。
       */
      if (ch === "b" && rest === 1 && i > 0 && word.charAt(i - 1) === "m") {
        i++;
        continue;
      }

      // ---- 1. 词尾不发音的 e。
      //      -ce / -ge / -Cle 这些固定收尾由后面 3b/3c 处理，这里只丢掉 e；
      //      vc-e 型的长音由 7b 在读出那一拍时补 ー。
      if (ch === "e" && rest === 1 && i > 0) {
        i++;
        continue;
      }

      // ---- 2. r 化元音：元音 + r +（词尾或辅音）-> 长音。
      //      参照 sljfaq：英式不卷舌，ɑː/ɜː -> アー、ɔː -> オー。
      //      r 后面是元音时 r 归下一个音节（story 的 or-y），不算；
      //      rr 也不算（sorry 的两个 r，第一个 r 归下一个音节）。
      //      **必须排在 7b 的「辅音 + 元音」两字母块前面**：park 的 ar
      //      要是先被 pa 吃掉，就会读成 パラク（老引擎的错法）。
      if (charIsVowel(ch) && nxt === "r" && nxt2 !== "r") {
        if (nxt2 === "" || !charIsVowel(nxt2)) {
          pair = ch + "r";
          if (EN_R_VOWEL[pair] !== undefined) {
            kana += EN_R_VOWEL[pair];
            i += 2;
            continue;
          }
        }
      }

      // ---- 3a. 词尾 y：辅音 + 词尾 y -> 那个辅音 + イー
      //          参照 sljfaq：happy -> ハッピー、city -> シティ、lucky -> ラッキー。
      if (ch === "y" && rest === 1 && i > 0 && !charIsVowel(word.charAt(i - 1))) {
        kana += EN_FINAL_CONSONANT_Y;
        i++;
        continue;
      }

      // ---- 3b. -Cle 收尾 -> クル/プル/ブル/トル…（参照 sljfaq：
      //          simple -> シンプル、table -> テーブル、people -> ピープル）
      if (isFinalLe(word, i)) {
        var leHead = word.charAt(i - 1);
        if (EN_FINAL_LE[leHead] !== undefined) {
          kana += EN_FINAL_LE[leHead];
        } else {
          kana += "\u30EB"; // ル
          confident = false;
        }
        i += 2;
        continue;
      }

      // ---- 3c. 词尾 -ce / -ge：默字 e 不补长音，c -> ス、g -> ジ
      //          （dance -> ダンス、orange -> オレンジ）
      if (rest === 2 && (ch === "c" || ch === "g") && nxt === "e" && i > 0) {
        var prevCE = word.charAt(i - 1);
        if (charIsVowel(prevCE) || prevCE === "n" || prevCE === "r" || prevCE === "l") {
          kana += ch === "c" ? EN_FINAL_CE : EN_FINAL_GE;
          i += 2;
          continue;
        }
      }

      // ---- 3d. 词尾 -ous -> アス（参照 sljfaq：-ous -> アス）
      if (rest === 3 && word.substr(i, 3) === "ous") {
        kana += EN_FINAL_OUS;
        i += 3;
        continue;
      }

      // ---- 3e. 词尾 ds -> ッズ（参照 sljfaq：dz -> ッズ，goods -> グッズ）
      if (rest === 2 && word.substr(i, 2) === "ds") {
        kana += EN_FINAL_DS;
        i += 2;
        continue;
      }

      // ---- 4a. -ture -> チャー（参照 sljfaq：nature -> ネイチャー）。
      //          必须排在 tu 前面，否则 ture 会被读成 トゥレ。
      if (rest >= 4 && word.substr(i, 4) === "ture") {
        kana += "\u30C1\u30E3\u30FC"; // チャー
        i += 4;
        continue;
      }

      // ---- 4b. -tion / -sion -> ション（nation / television 都吃这一段）
      if (rest >= 4 && (word.substr(i, 4) === "tion" || word.substr(i, 4) === "sion")) {
        kana += "\u30B7\u30E7\u30F3"; // ション
        i += 4;
        continue;
      }

      // ---- 4c. -ious / -eous -> アス（i/e 已经单独读过，这里只吃 ous）
      if (rest >= 4 && (word.substr(i, 4) === "ious" || word.substr(i, 4) === "eous")) {
        kana += EN_FINAL_OUS;
        i += 4;
        continue;
      }

      // ---- 5a. 四/三/两字母元音块（igh / ier / our / ee / ea / ...）。
      //          必须排在辅音连缀前面：croak 是 c + r + oa + k，
      //          oa 先被吃掉，不然 cr 会抢走那个 c。
      if (rest >= 4 && EN_VOWEL_FIX[word.substr(i, 4)] !== undefined) {
        kana += EN_VOWEL_FIX[word.substr(i, 4)];
        i += 4;
        continue;
      }
      if (rest >= 3 && EN_VOWEL_FIX[word.substr(i, 3)] !== undefined) {
        kana += EN_VOWEL_FIX[word.substr(i, 3)];
        i += 3;
        continue;
      }
      //      两字母这里要排除「元音 + r」和「元音 + y」：ar/or 是 r 化元音、
      //      ay/ey/oy 是双元音，优先级比普通元音对高（第 2/3a 步已处理）。
      if (rest >= 2) {
        pair = word.substr(i, 2);
        if (nxt !== "r" && nxt !== "y" && EN_VOWEL_FIX[pair] !== undefined) {
          kana += EN_VOWEL_FIX[pair];
          i += 2;
          continue;
        }
      }

      // ---- 6a. θ（th）：参照 sljfaq，θ -> サ行（think -> シンク），
      //          词尾或辅音前的 th -> ス（north -> ノース）。
      if (rest >= 2 && ch === "t" && nxt === "h") {
        var thVowel = word.charAt(i + 2);
        if (!charIsVowel(thVowel)) thVowel = "";
        kana += EN_TH[thVowel];
        i += 2;
        continue;
      }

      // ---- 6b. ŋ：拼作 ng 且后面有元音 -> ンガ行（singer -> シンガー）；
      //          拼作 ng 且后面没有元音 -> ン（Washington -> ワシントン）。
      //          注意必须用 charIsVowel 判断：charAt 越界返回空串，而
      //          "aiueoy".indexOf("") 恒为 0，直接写会把词尾的 ng 误判成
      //          「后面有元音」，拼出 EN_NG[""] = undefined。
      if (rest >= 2 && ch === "n" && nxt === "g") {
        var ngNext = word.charAt(i + 2);
        if (charIsVowel(ngNext) || ngNext === "y") {
          kana += EN_NG[ngNext];
          i += 3;
        } else {
          kana += EN_NASAL;
          i += 2;
        }
        continue;
      }

      // ---- 6c. nk / nc：参照 sljfaq，ŋ 拼作 nk/nc 时读 ン（sink -> シンク）
      if (rest >= 2 && ch === "n" && (nxt === "k" || nxt === "c")) {
        kana += EN_NASAL;
        i++;
        continue;
      }

      // ---- 6d. ts -> ツ（参照 sljfaq：tu -> トゥ/ツ；tsunami 这类 ts 拼法）
      if (rest >= 2 && ch === "t" && nxt === "s") {
        kana += "\u30C4"; // ツ
        i += 2;
        continue;
      }

      // ---- 6e. 辅音 + l/r 连缀（clover 的 cl、dream 的 dr）
      if (rest >= 2 && isClusterHead(ch) && CLUSTER_TAIL[nxt] === true) {
        kana += CLUSTER_HEAD[ch];
        i++;
        continue;
      }

      // ---- 6f. wh / qu / ph / ck / sh / ch / ss / wr / kn 这些二合字母
      if (rest >= 2 && EN_DIGRAPH[word.substr(i, 2)] !== undefined) {
        kana += EN_DIGRAPH[word.substr(i, 2)];
        i += 2;
        continue;
      }

      // ---- 6g. c 在 e/i/y 前读 ス（dance / since / city / cycle）
      if (ch === "c" && "eiy".indexOf(nxt) >= 0) {
        kana += "\u30B9"; // ス
        i++;
        continue;
      }

      // ---- 7a. 「辅音 + 元音 + r +（词尾或辅音）」：把「辅音 + 元音」读成一拍，
      //          再补长音符 ー —— 这就是 r 化元音在词中/词尾的写法。
      //          参照 sljfaq 的非重读 r：park -> パーク、bird -> バード、
      //          horse -> ホース、river -> リバー、finger -> フィンガー。
      //          为什么是「辅音 + 元音 + ー」而不是「辅音 + 元音 + アー」：
      //          该页写的是「元音 + r -> アー / オー」，其中 ア/オ 就是元音
      //          本身那一拍，辅音 + 元音已经把它读出来了，这里只差长度。
      //          必须排在 7b 的「辅音 + 元音」拼块前面，否则 pa 会先被
      //          EN_PAIR 吃成 パ，轮到 r 只剩 ラ，读成 パラク（老引擎的错法）。
      if (
        charIsVowel(nxt) &&
        nxt2 === "r" &&
        word.charAt(i + 3) !== "r" &&
        (word.charAt(i + 3) === "" || !charIsVowel(word.charAt(i + 3)))
      ) {
        pair = nxt + "r";
        if (EN_R_VOWEL[pair] !== undefined) {
          /*
           * 辅音那一拍用「行头 + 元音」算出来，然后补 ー。
           * 不用 EN_PAIR：那里带上下文特例（wo = ウォ、bi = ビ），借过来会把
           * bird 读成 ビ、turn 读成 トゥ。
           *
           * 关键：这个「元音段」由**读音**决定，不由拼写字母决定。
           * sljfaq 的 r 化元音是 ɑː / ɜː -> アー，只有 or -> オー：
           *   turn -> ターン、bird -> バード、nurse -> ナース（ur/ir/er 都配 ア段）
           *   horse -> ホース、fork -> フォーク（or 配 オ段）
           * 例外：英式里 wor- 读 /wɜː/ -> ワー（work / word / world / worth），
           * 所以 w + or 要配 ア段而不是 オ段。
           * 之前按拼写字母取段，于是 turn 读成 トゥーン、bird 读成 ビード、
           * river 读成 リベー —— 都是"段选错了"，不是长度错了。
           *
           * 判据用 enConsonantVowel() 的返回值而不是查 EN_CONSONANT_ROW：
           * f / j 两行是独立的表（EN_F_ROW / EN_J_ROW），只看 EN_CONSONANT_ROW
           * 会把 fork -> フォラク、form -> フォラム 这类漏掉。
           */
          var rv = pair === "or" && ch !== "w" ? "o" : "a";
          var head = enConsonantVowel(ch, rv);
          if (head) {
            kana += head + "\u30FC";
            i += 3; // 吃掉「辅音 + 元音 + r」
            continue;
          }
        }
      }

      // ---- 7b. 辅音 + 元音两字母块（参照 sljfaq 的 Vowels and diphthongs 表）
      if (rest >= 2) {
        pair = word.substr(i, 2);
        // ca 在**闭音节**里读 キャ（参照 sljfaq：æ after k -> キャ，cap -> キャップ）；
        // 开音节的 ca 保持 カ（cake / case / camera -> カメラ）。
        // 后面的 r 不算「闭音节的辅音」：car / card 的 ar 归 r 化元音管，
        // 抢过来会读成 キャー / キャラド。
        if (
          pair === "ca" &&
          word.charAt(i + 2) !== "" &&
          word.charAt(i + 2) !== "r" &&
          word.charAt(i + 2) !== "y" &&
          !charIsVowel(word.charAt(i + 2))
        ) {
          kana += "\u30AD\u30E3"; // キャ
          i += 2;
          continue;
        }
        if (EN_PAIR[pair] !== undefined && !(pair === "ca" && nxt2 === "r")) {
          kana += EN_PAIR[pair];
          i += 2;
          continue;
        }
      }

      // ---- 8a. 双辅音字母：参照 sljfaq 的促音（gemination）那条。
      //          只对日语借词里真的会促音的组合动手，而且后面还要有元音
      //          （message 的 ss 促音，kiss 词尾的 ss 不促音 -> キス）。
      if (
        rest >= 3 &&
        ch === nxt &&
        EN_DOUBLE_GEMINATION[ch] === true &&
        (charIsVowel(word.charAt(i + 2)) || word.charAt(i + 2) === "y")
      ) {
        kana += "\u30C3" + (EN_CONSONANT[ch] || "");
        i += 2;
        continue;
      }

      // ---- 8b. m / n 在辅音前收 ン：参照 sljfaq 的
      //          hamburger -> ハンバーガー、London -> ロンドン、front -> フロント。
      if (
        (ch === "m" || ch === "n") &&
        nxt !== "" &&
        !charIsVowel(nxt) &&
        nxt !== "y" &&
        nxt !== ch
      ) {
        kana += EN_NASAL;
        i++;
        continue;
      }

      // ---- 8c. 词尾元音 + r 的 r 化（EN_R_VOWEL 漏掉的兜底）
      if (rest === 2 && EN_FINAL_R[word.substr(i, 2)] !== undefined) {
        kana += EN_FINAL_R[word.substr(i, 2)];
        i += 2;
        continue;
      }

      // ---- 9a. 元音（含 y 当元音）
      if ("aiueoy".indexOf(ch) >= 0) {
        kana += enVowel(ch);
        i++;
        continue;
      }

      // ---- 9b. 词尾 r -> ー。前面必须已经有假名可拉长（而且不能已经是 ー），
      //          否则退回 ル，免得吐一个孤零零的 ー 或一串 ー。
      if (ch === "r" && rest === 1) {
        kana += canLengthen(kana) ? "\u30FC" : "\u30EB";
        i++;
        continue;
      }

      // ---- 9c. 词尾辅音：顺带处理单音节词的促音。
      //          参照 sljfaq：hot -> ホット、bed -> ベッド、cat -> キャット、
      //          dog -> ドッグ。多音节词一律不猜（见 EN_GEMINATE_FINAL 注释）。
      if (rest === 1 && EN_FINAL_CONSONANT[ch] !== undefined) {
        if (
          EN_GEMINATE_FINAL[ch] === true &&
          isMonosyllable(word) &&
          charIsVowel(word.charAt(i - 1))
        ) {
          kana += "\u30C3" + EN_FINAL_CONSONANT[ch];
        } else {
          kana += EN_FINAL_CONSONANT[ch];
        }
        i++;
        continue;
      }

      // ---- 9d. 单字母辅音（必须排在 8b 后面：m/n 在辅音前已经收 ン 了）
      if (EN_CONSONANT[ch] !== undefined) {
        kana += EN_CONSONANT[ch];
        // 同上：单字母辅音 + 词尾 e 也是 vc-e 型（bake 的 k 在这里）
        if (isLongVowelBeforeE(word, i)) kana += "\u30FC"; // ー
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
   * vc-e 型的长音：i 这个位置是「单个塞音 + 词尾 e」，而且前面是元音 ——
   * 那就在读这个辅音时顺便补 ー（bake 的 ー 就是这里补的）。
   */
  function isLongVowelBeforeE(word, i) {
    var nxt = word.charAt(i + 1);
    if (word.charAt(i + 2) !== "e") return false; // 再往后必须是词尾那个 e
    if (i + 2 !== word.length - 1) return false; // 而且那个 e 就是词尾
    if (!charIsVowel(word.charAt(i - 1))) return false; // 前面是元音
    if (enLengthensByE(nxt) !== true) return false; // 而且是塞音
    return true;
  }

  /**
   * 英文词 -> 片假名读音。永远返回 { kana, confident }，kana 一定非空。
   *
   * 硬契约（不只是「非空」）：kana 一定是**能直接标注的纯片假名**
   * ——只允许 ァ-ヶ 和长音符 ー。规则层哪一步拼出了别的东西
   * （占位符、undefined、拉丁字母……），这里最后统一清掉并把 confident
   * 置 false，交给联网校正层。
   *
   * 层序：例外表 -> 小表 -> 规则。
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
    var out = sanitizeKana(res.kana);
    var ok = out === res.kana;
    if (!out) return { kana: "\u30A2", confident: false }; // ア（兜底）
    return { kana: out, confident: confident && res.confident && ok };
  }

  /**
   * 把规则层的输出收敛成「纯片假名 + ー」。
   * 非法字符直接删掉（不是替换），这样至少剩下的读音还能用；
   * 调用方通过「出来和进去不一样」得知这一步发生过，从而把 confident 置 false。
   */
  function sanitizeKana(kana) {
    var out = "";
    for (var i = 0; i < kana.length; i++) {
      var c = kana.charAt(i);
      if (RE_KATAKANA.test(c)) out += c;
    }
    return out;
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

  // ------------------------------------------------------------ 记号逐字母

  /*
   * 字母名（日语里的通行读法）。用于 `D/N/A`、`N/A`、`A.B.C`、`R&B` 这类**记号**：
   * 它们不是单词，唱出来是一个字母一个字母念的。
   *
   * 全大小写都映射到同一张表（查之前会小写化）。
   * G 用 ジー（不是 ジェー）、H 用 エイチ（不是 エッチ —— 那个词在日语里有别的意思）、
   * Z 用 ゼット（JIS 的通行读法；ゼッド 是另一种）。
   */
  var LETTER_KANA = {
    a: "\u30A8\u30FC", // エー
    b: "\u30D3\u30FC", // ビー
    c: "\u30B7\u30FC", // シー
    d: "\u30C7\u30A3\u30FC", // ディー
    e: "\u30A4\u30FC", // イー
    f: "\u30A8\u30D5", // エフ
    g: "\u30B8\u30FC", // ジー
    h: "\u30A8\u30A4\u30C1", // エイチ
    i: "\u30A2\u30A4", // アイ
    j: "\u30B8\u30A7\u30FC", // ジェー
    k: "\u30B1\u30FC", // ケー
    l: "\u30A8\u30EB", // エル
    m: "\u30A8\u30E0", // エム
    n: "\u30A8\u30CC", // エヌ
    o: "\u30AA\u30FC", // オー
    p: "\u30D4\u30FC", // ピー
    q: "\u30AD\u30E5\u30FC", // キュー
    r: "\u30A2\u30FC\u30EB", // アール
    s: "\u30A8\u30B9", // エス
    t: "\u30C6\u30A3\u30FC", // ティー
    u: "\u30E6\u30FC", // ユー
    v: "\u30D6\u30A4", // ブイ
    w: "\u30C0\u30D6\u30EA\u30E5\u30FC", // ダブリュー
    x: "\u30A8\u30C3\u30AF\u30B9", // エックス
    y: "\u30EF\u30A4", // ワイ
    z: "\u30BC\u30C3\u30C8", // ゼット
  };

  /** `&` 在记号里是要念出来的（R&B -> アールアンドビー） */
  var LETTER_AMP = "\u30A2\u30F3\u30C9"; // アンド

  /*
   * ------------------------------------------------------------ 缩写
   *
   * 用户报的：`you're` / `I'll` / `it's` / `I'd` 这类注不准。
   *
   * 根因是折撇号那一步：`normalize()` 把 `'` 去掉，于是
   *   `I'll` -> `ill`（词典里真有 ill = イル）
   *   `I'd`  -> `id`（词典里真有 id = アイディー）
   *   `you're` -> `youre`（谁也不认识，落到规则去猜 -> ヨウレ）
   * 所以缩写必须在**折撇号之前**认出来：拆成"词干 + 缩写尾巴"，
   * 词干照常走词典/罗马音/规则，尾巴按下面这张表补上。
   *
   * 绝大多数缩写用"拼接 + 少量音变"就够了（见 mergeContraction），
   * 少数几个例外单独列表 —— 它们的读音不是词干加尾巴能拼出来的。
   */
  var EN_CONTRACTIONS = {
    // n't：词干的读音会被词典/规则带偏，逐个定死
    "don't": "\u30C9\u30F3\u30C8", // ドント（do 是 ドゥー，接上去变成 ドゥーント）
    "can't": "\u30AD\u30E3\u30F3\u30C8", // キャント（ca 在词典里是字母名 シーエー）
    "won't": "\u30A6\u30A9\u30F3\u30C8", // ウォント
    "ain't": "\u30A8\u30A4\u30F3\u30C8", // エイント
    "weren't": "\u30EF\u30FC\u30F3\u30C8", // ワーント（were 不是 ウィア）
    "couldn't": "\u30AF\u30C9\u30F3\u30C8", // クドント（could 是 クッド，会多一个促音）
    "wouldn't": "\u30A6\u30C9\u30F3\u30C8", // ウドント
    "shouldn't": "\u30B7\u30E5\u30C9\u30F3\u30C8", // シュドント
    "mustn't": "\u30DE\u30B9\u30F3\u30C8", // マスント
    "hadn't": "\u30CF\u30C9\u30F3\u30C8", // ハドント
    "needn't": "\u30CB\u30C9\u30F3\u30C8", // ニドント
    // 其它不规则
    "they're": "\u30BC\u30A2", // ゼア（ゼイ+ア 不对）
    "we'll": "\u30A6\u30A3\u30EB", // ウィル（ウィー+ル 会变成 ウィール）
    "y'all": "\u30E8\u30FC\u30EB", // ヨール（不是词干+尾巴能拼的）
  };

  /** "n't" 单独认：don't = do + n't、can't = ca + n't */
  var RE_CONTRACTION_NT = /^([A-Za-z]+)n['\u2019\u02BC\uFF07]t$/;
  /** 其余缩写：词干 + 撇号 + 尾巴 */
  var RE_CONTRACTION = /^([A-Za-z]+)['\u2019\u02BC\uFF07](s|re|ll|d|ve|m)$/i;

  /**
   * 拆一个缩写。不是缩写返回 null，否则返回 { base, suffix, fixed }：
   *   base   词干（拿去走正常读音路径）
   *   suffix 尾巴（s / re / ll / d / ve / m / nt）
   *   fixed  例外表里定死的整词读音（没有就是 null）
   */
  function splitContraction(raw) {
    if (typeof raw !== "string") return null;
    var s = raw.trim();
    if (s.indexOf("'") < 0 && s.indexOf("\u2019") < 0 && s.indexOf("\u02BC") < 0 && s.indexOf("\uFF07") < 0) {
      return null;
    }
    var lower = s.toLowerCase();
    // 先把"词干 + 尾巴"拆出来（拆得出来就带上整词表里的例外读音）
    var m = RE_CONTRACTION_NT.exec(s);
    if (m) return { base: m[1], suffix: "nt", fixed: EN_CONTRACTIONS[lower] || null };
    m = RE_CONTRACTION.exec(s);
    if (m) return { base: m[1], suffix: m[2].toLowerCase(), fixed: EN_CONTRACTIONS[lower] || null };
    // 拆不出来的（y'all 这类）只能靠整词表
    if (EN_CONTRACTIONS[lower]) return { base: null, suffix: null, fixed: EN_CONTRACTIONS[lower] };
    return null;
  }

  /** 把词干的读音和缩写尾巴拼起来（该并促音的并促音、该收长音的收长音） */
  function mergeContraction(kana, suffix) {
    if (!kana) return kana;
    if (suffix === "s") {
      /*
       * it's / that's / let's：词尾是 ト 时并成 ツ（イット -> イッツ，
       * 不是 イッズ）；是 ド 时并成 ズ（キッド -> キッズ）。
       * 注意去掉的是**词尾那个假名**再补促音那套 —— 词干本身可能已经带 ッ
       * （it 的词典读音是 イット），再补一个就成 イッッズ 了。
       */
      if (/[\u30C8]$/.test(kana)) return kana.slice(0, -1) + "\u30C4"; // イット -> イッツ
      if (/[\u30C9]$/.test(kana)) return kana.slice(0, -1) + "\u30BA"; // キッド -> キッズ
      if (/[\u30C3]$/.test(kana)) return kana + "\u30C4"; // 已经是促音结尾
      return kana + "\u30BA"; // ズ（he's -> ヒーズ）
    }
    if (suffix === "re") {
      // you're / we're：长音要收掉（ユー + ア = ユア）
      if (kana.charAt(kana.length - 1) === "\u30FC") kana = kana.slice(0, -1);
      return kana + "\u30A2"; // ア
    }
    if (suffix === "ll") return kana + "\u30EB"; // ル：I'll -> アイル
    if (suffix === "d") return kana + "\u30C9"; // ド：I'd -> アイド
    if (suffix === "ve") return kana + "\u30D6"; // ブ：I've -> アイブ
    if (suffix === "m") return kana + "\u30E0"; // ム：I'm -> アイム
    if (suffix === "nt") return kana + "\u30F3\u30C8"; // ント：don't -> ドント
    return kana;
  }

  /*
   * 整串就是一个记号：`D/N/A`、`N/A`、`A.B.C`、`R&B`、`X-Y` ——
   * 字母被分隔符一个一个串起来。和 matcher 的 RE_NOTATION_WHOLE 同一口径。
   *
   * 为什么判据必须是"**每个**分段都是单个字母"：`X-Y` 是记号（エックスワイ），
   * 而 `x-ray` 是普通词（エックスレイ）—— 只看"有没有连字符"会把后者也逐字母念。
   */
  var RE_NOTATION_RAW = /^[A-Za-z](?:[\/\\|_.&#*~+=\u30FB\uFF0F\uFF3C-][A-Za-z])+$/;

  /**
   * 一串「只有字母/`&`」的记号 -> 逐字母读音。不是记号就返回 null。
   *
   * 长度上限 12：太长的串不是记号，是数据（URL、ID）混进了歌词。
   */
  function lettersToKatakana(word) {
    if (typeof word !== "string") return null;
    var w = word.toLowerCase();
    if (!w || w.length < 2 || w.length > 12) return null;
    if (!/^[a-z&]+$/.test(w)) return null;
    // 不允许首尾是 &：`&A&` 这种是排版噪声
    if (w.charAt(0) === "&" || w.charAt(w.length - 1) === "&") return null;
    var letters = w.replace(/&/g, "");
    if (letters.length < 2) return null;

    var out = "";
    for (var i = 0; i < w.length; i++) {
      var ch = w.charAt(i);
      if (ch === "&") {
        out += LETTER_AMP;
        continue;
      }
      if (LETTER_KANA[ch] === undefined) return null;
      out += LETTER_KANA[ch];
    }
    return out || null;
  }

  /** 同一个元音重复成串时用的那一拍（AAAAA -> アアアアア） */
  var VOWEL_KANA = { a: "\u30A2", i: "\u30A4", u: "\u30A6", e: "\u30A8", o: "\u30AA" };

  /** 原始写法 -> 逐字母读音（不是记号返回 null）。分隔符不发音，`&` 读 アンド。 */
  function notationToKatakana(raw) {
    if (typeof raw !== "string") return null;
    var s = raw.trim();
    if (!RE_NOTATION_RAW.test(s)) return null;
    return lettersToKatakana(s.toLowerCase().replace(/[^a-z&]/g, ""));
  }

  /**
   * 全大写的缩写 -> 逐字母读音（不是缩写返回 null）。
   *
   * 用户报的 `LDK` 一类。判据刻意收得紧，免得误伤真词：
   *   - 原文**全大写**（缩写就是这么写的；`my` / `sky` / `why` 这些真词是小写）；
   *   - 长度 2~6；
   *   - 一个元音都没有，而且 **y 也算元音**（否则 my / sky / why / fly 会被逐字母念）。
   * 于是 LDK / NHK / CD / TV / BGM / RPG / DVD / CM / DJ 都逐字母读，
   * 而 hmm / tsk / shh 这类小写感叹词不受影响。
   *
   * 用户后面又报了**有元音的**缩写（截图里的 `SOS` 被读成 ソス、`QTE` 读成 クテ）——
   * 所以再放两条进来，但都要过两道闸门，缺一不可：
   *   - **不是词典里的词**：LOVE / DREAM / YES / OK / KISS 这些真词全大写也常见，
   *     逐字母念就毁了（エルオーブイイー ✗）；
   *   - **罗马音也切不出来**：`SORA` / `KIMI` / `YUKI` 这类全大写日语罗马字要留给
   *     罗马音层（它们切得出来），不能念成字母名；
   *   - **不在英文常用词表里**（`enWords`）：MY / WHY / SKY / FLY 这些真词全大写也常见。
   * 于是 SOS -> エスオーエス、QTE -> キューティーイー、YY -> ワイワイ 都对，
   * 而 SORA / LOVE / MY 不受影响。
   */
  function spellOutAcronym(raw, dict, enWords) {
    if (typeof raw !== "string") return null;
    var s = raw.trim();
    if (s.length < 2 || s.length > 6) return null;
    if (!/^[A-Z]+$/.test(s)) return null;
    if (!/[AEIOUY]/.test(s)) return lettersToKatakana(s.toLowerCase());
    /*
     * 有元音的这一支**只收 2~3 个字母**：`SOS` / `QTE` / `YY` 是缩写，
     * 而 4 个字母以上、又带元音的（`DIVA` / `QUIX` / `KISS`）基本都是**词或名字**，
     * 逐字母念就错了 —— 用户截图里 `憧れた DIVA なん だ` 的 DIVA 被念成
     * ディーアイブイエー，正确是 ディーヴァ。
     */
    if (s.length > 3) return null;
    var low = s.toLowerCase();
    if (dict && dict[low] !== undefined) return null;
    // 英文常用词表里有的（MY / WHY / SKY / FLY…）：真词，不能念字母
    if (enWords && enWords[low]) return null;
    if (romajiToKatakana(low)) return null;
    return lettersToKatakana(low);
  }

  // ------------------------------------------------------------ 变音符号折叠

  /*
   * 变音符号 -> ASCII。用户报的 `Ō` / `Tōkyō` / `Café` 都属于这一类。
   *
   * 分两组处理，性质完全不同：
   *   1. **长音符 ā ē ī ō ū**（日语罗马字的写法）-> "元音 + -"，
   *      因为在本仓库的罗马音口径里 `-` 就是长音（`saka-` -> サカー），
   *      于是 `Tōkyō` -> `to-kyo-` -> トーキョー、`kōhī` -> `ko-hi-` -> コーヒー。
   *      这一组是**确定**的（罗马字的长音就是这么标的）。
   *   2. 别的变音符号（é ü ñ ç …）-> 基础字母（José -> jose、Café -> cafe）。
   *      这一组只是"没有更好的办法"：读音得看是哪种语言，所以标成
   *      `confident: false`，交给大模型/联网那一层去修（ホセ 而不是 ジョセ）。
   */
  var FOLD_MAP = (function () {
    var m = {};
    function add(chars, to) {
      for (var i = 0; i < chars.length; i++) m[chars.charAt(i)] = to;
    }
    // 1. 长音符：折成「元音 + -」，'-' 在罗马音里读长音
    add("\u0101", "a-"); // ā
    add("\u0113", "e-"); // ē
    add("\u012B", "i-"); // ī
    add("\u014D", "o-"); // ō
    add("\u016B", "u-"); // ū
    // 2. 其它变音符号：折成基础字母
    add("\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u0103\u0105", "a");
    add("\u00E8\u00E9\u00EA\u00EB\u0115\u0117\u0119\u011B", "e");
    add("\u00EC\u00ED\u00EE\u00EF\u012D\u012F\u0131", "i");
    add("\u00F2\u00F3\u00F4\u00F5\u00F6\u00F8\u014F\u0151", "o");
    add("\u00F9\u00FA\u00FB\u00FC\u016D\u016F\u0171\u0173", "u");
    add("\u00FD\u00FF\u0177", "y");
    add("\u00E7\u0107\u0109\u010B\u010D", "c");
    add("\u00F1\u0144\u0146\u0148", "n");
    add("\u015B\u015D\u015F\u0161", "s");
    add("\u017A\u017C\u017E", "z");
    add("\u0142\u013A\u013E\u013C", "l");
    add("\u011D\u011F\u0121\u0123", "g");
    add("\u010F\u0111", "d");
    add("\u0165\u0163", "t");
    add("\u0155\u0159", "r");
    add("\u0175", "w");
    add("\u0125", "h");
    add("\u00E6", "ae");
    add("\u0153", "oe");
    add("\u00DF", "ss");
    add("\u00FE", "th");
    add("\u00F0", "d");
    return m;
  })();

  /**
   * 把带变音符号的写法折成 ASCII。没有变音符号返回 **null**（调用方据此走原路）。
   * 返回 { text, pureMacron }：pureMacron 表示"只有长音符"（= 日语罗马字，可信）。
   */
  function foldLatin(s) {
    if (typeof s !== "string" || !s) return null;
    var lower = s.toLowerCase();
    var out = "";
    var changed = false;
    var macron = false;
    var other = false;
    for (var i = 0; i < lower.length; i++) {
      var ch = lower.charAt(i);
      var rep = FOLD_MAP[ch];
      if (rep === undefined) {
        out += ch;
        continue;
      }
      changed = true;
      if (rep.length === 2 && rep.charAt(1) === "-") macron = true;
      else other = true;
      out += rep;
    }
    if (!changed) return null;
    return { text: out, pureMacron: macron && !other };
  }

  // ------------------------------------------------------------ 校验在线结果

  /*
   * 首音校验：一个"纯片假名"的答案不一定是**音译**。
   *
   * 用户报的：`tick` 被注成 カチカチ —— 那是拟声词/意译，不是 tick 的读音
   * （Google 的 en→ja 对 tick 会回「カチカチ」这种，纯片假名，光看字符集拦不住）。
   *
   * 判据只看**第一个假名**：词首字母是稳定的辅音时，音译的首音必然落在对应的行上
   * （t 只能出 タ行、k 只能出 カ行……）。tick 的 カチカチ 首音是 カ（カ行），
   * 与 t 不符 -> 判为"这不是音译"，丢掉，让本地规则兜底。
   *
   * 刻意保守：h / w / y 开头、元音开头、以及 kn / gn / ps 这类有默字的组合
   * 一律**不做校验**（write -> ライト、hour -> アワー、knife -> ナイフ 都是合法的）。
   * 宁可漏掉几个错的，也不要把对的判错。
   */
  var FIRST_ROWS = {
    b: "\u30D0\u30D3\u30D6\u30D9\u30DC",
    // c：/k/（cat キャット）、/s/（city シティ）、ch（chat チャット）
    c: "\u30AB\u30AD\u30AF\u30B1\u30B3\u30B5\u30B7\u30B9\u30BB\u30BD\u30C1\u30C1\u30E3\u30C1\u30E5\u30C1\u30A7\u30C1\u30E7",
    // d：/d/ 与 di 的 ディ、dj 的 ジ
    d: "\u30C0\u30C7\u30A3\u30C9\u30C9\u30A5\u30B8\u30B8\u30E3\u30B8\u30E5\u30B8\u30A7\u30B8\u30E7\u30C2",
    f: "\u30D5\u30A1\u30D5\u30A3\u30D5\u30A7\u30D5\u30A9\u30D2",
    // g：硬音 ガ行（game）、软音 ジ行（gem / giant / George）、gn 的 ナ行
    g: "\u30AC\u30AE\u30B0\u30B2\u30B4\u30CA\u30CB\u30CC\u30CD\u30CE\u30B8\u30B8\u30E3\u30B8\u30E5\u30B8\u30A7\u30B8\u30E7",
    j: "\u30B8\u30B8\u30E3\u30B8\u30E5\u30B8\u30A7\u30B8\u30E7\u30E4",
    k: "\u30AB\u30AD\u30AF\u30B1\u30B3\u30CA\u30CB\u30CC\u30CD\u30CE", // kn
    l: "\u30E9\u30EA\u30EB\u30EC\u30ED",
    // m：/m/ 与 mn 的 ナ行（mnemonic ニモニック —— m 不发音）
    m: "\u30DE\u30DF\u30E0\u30E1\u30E2\u30CA\u30CB\u30CC\u30CD\u30CE",
    // n：/n/ 与 Ng 开头的姓名（Nguyen グエン）；还有 ン 开头这种（Ngo）
    n: "\u30CA\u30CB\u30CC\u30CD\u30CE\u30AC\u30AE\u30B0\u30B2\u30B4\u30F3",
    // p：/p/ 与 ps 的 サ行、ph 的 ファ行（phone フォン）、pn 的 ナ行（pneumonia ニューモニア）
    p: "\u30D1\u30D4\u30D7\u30DA\u30DD\u30B5\u30B7\u30B9\u30BB\u30BD\u30D5\u30D5\u30A1\u30D5\u30A3\u30D5\u30A7\u30D5\u30A9\u30D2\u30CA\u30CB\u30CC\u30CD\u30CE",
    q: "\u30AB\u30AD\u30AF\u30B1\u30B3",
    r: "\u30E9\u30EA\u30EB\u30EC\u30ED",
    s: "\u30B5\u30B7\u30B9\u30BB\u30BD",
    /*
     * t：/t/ 与 th 的三种读法都要放行 ——
     *   θ 的 th（think シンク、three スリー）-> サ行
     *   ð 的 th（the ザ、this ジ、that ザッ、they ゼイ、there ゼア）-> ザ行
     * 另外 th 开头还有读成 d 系的写法（this ディス、there ディア），
     * 那一支在 looksLikeTransliteration 里**按词首是不是 th** 单独放行 ——
     * 不能直接写进这张表：写进来 `tick` -> ダニ（蜱虫）就拦不住了。
     */
    t: "\u30BF\u30C1\u30C4\u30C6\u30C8\u30B5\u30B7\u30B9\u30BB\u30BD\u30B6\u30B8\u30BA\u30BC\u30BE",
    v: "\u30D0\u30D3\u30D6\u30D9\u30DC\u30F4",
    z: "\u30B6\u30B8\u30BA\u30BC\u30BE",
  };

  /**
   * 这个片假名答案像不像 word 的**音译**？
   * 首字母没有把握（h/w/y/元音）时一律返回 true（不拦）。
   */
  function looksLikeTransliteration(word, kana) {
    if (typeof word !== "string" || typeof kana !== "string" || !kana) return true;
    var w = word.toLowerCase();
    var first = w.charAt(0);
    var row = FIRST_ROWS[first];
    if (!row) return true; // h / w / y / 元音 / 其它 -> 不校验
    /*
     * t + th 的 ð 有一支读成 d 系：this ディス、they ディ、there ディア。
     * 只对 **th 开头**的词放行ダ行 —— 不然 `tick` -> ダニ（蜱虫，意译）这种
     * 也会跟着溜进来（那正是这条校验要拦的东西）。词典里 this 就是 ディス，
     * 所以这一支必须放行。
     */
    if (first === "t" && /^th/.test(w)) row += "\u30C0\u30C2\u30C5\u30C7\u30C9";
    return row.indexOf(kana.charAt(0)) >= 0;
  }

  // ------------------------------------------------------------ 规范

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
   *   opts.order 可选的同步层顺序，例如 ["romaji", "dict", "rule"]（缺省 dict > romaji > rule）
   *   opts.log  可选，(msg) => void，只用来报调试信息，正常路径不调用
   * @returns {Object} { read, addOnline, stats, setOrder, getOrder }
   */
  function createReader(opts) {
    var options = opts || {};
    // 词表可能直接传进来，也可能什么都没传
    var dict = options.dict && typeof options.dict === "object" ? options.dict : {};
    /*
     * 英文常用词表（core/enwords.js）：罗马音层用它判断"这看着像英文词"，
     * 判出来的结果标成没把握、交给上层让在线层仲裁。不给就退化成老行为（罗马音全信）。
     */
    var enWords = options.enWords && typeof options.enWords === "object" ? options.enWords : null;
    // 联网校正结果只放内存，进程退出就没了（下次联网再学一遍）
    var online = {};
    var log = typeof options.log === "function" ? options.log : null;

    var stat = { dictHits: 0, letterHits: 0, romajiHits: 0, ruleHits: 0, onlineHits: 0, missed: 0 };

    /*
     * 可排序的同步层与它们的默认顺序。
     *
     * 用户可以在设置面板里把这几层上下调（"哪个来源更可信"是口味问题：词典是人工核过的，
     * 但词典也可能有错；规则是拼写猜测，但它不联网、不说谎）。大模型 / 免费接口那两层
     * 是**异步**的，顺序由上层（main.js）管，这里只管同步层。
     */
    var LAYER_IDS = ["dict", "romaji", "rule"];
    var layers = LAYER_IDS.slice();

    /**
     * 设置同步层的顺序。只认识 dict / romaji / rule，重复项丢掉，
     * 没提到的层按默认顺序补在后面 —— 旧配置、手改坏的配置都不会因此少一层。
     */
    function setOrder(next) {
      var out = [];
      var i;
      if (next && typeof next.length === "number") {
        for (i = 0; i < next.length; i++) {
          if (LAYER_IDS.indexOf(next[i]) >= 0 && out.indexOf(next[i]) < 0) out.push(next[i]);
        }
      }
      for (i = 0; i < LAYER_IDS.length; i++) {
        if (out.indexOf(LAYER_IDS[i]) < 0) out.push(LAYER_IDS[i]);
      }
      layers = out;
      trace("同步层序：" + layers.join(" > "));
    }

    function getOrder() {
      return layers.slice();
    }

    if (options.order) setOrder(options.order);

    /**
     * 三层各自的取法。每层自己判"给不给得出答案"，给不出返回 null 让下一层试。
     * 层与层之间没有依赖，所以顺序可以随便换。
     */
    var LAYER_FN = {
      dict: function (c) {
        var i;
        var key;
        // 词典：折叠写法优先（词典里存的是 ASCII）
        // 注意**不能**再走"去掉非字母"那一档键：`déjà` 会被削成 `dj`，
        // 正好命中词典里的 DJ -> ディージェイ（用户报过类似的怪音）。
        for (i = 0; i < c.keys.length; i++) {
          key = c.keys[i];
          if (dict[key] !== undefined && dict[key]) {
            trace("dict 命中：" + key);
            return { kana: dict[key], source: "dict", confident: true };
          }
        }
        // 联网学到的读音排在词典之后：词典是人工核过的，联网结果可能会漂
        for (i = 0; i < c.keys.length; i++) {
          key = c.keys[i];
          if (online[key] !== undefined) {
            trace("online 命中：" + key);
            return { kana: online[key], source: "online", confident: true };
          }
        }
        /*
         * 全大写的缩写（LDK / NHK / CD / TV / BGM / RPG / DVD …，以及 SOS / QTE / YY
         * 这种有元音但"既不是词、也切不成罗马音"的）：按字母名逐个念。
         * 挂在词典这一层里（而不是单独一层）：它和词典一样是"查表就有确定答案"，
         * 而且必须排在规则层前面 —— 规则会把它当词拼（LDK -> ラダク、TV -> タブ）。
         * 词典里已有的（CM -> シーエム、DJ -> ディージェイ）在上面就返回了，不受影响。
         */
        var spelledAcronym = spellOutAcronym(c.raw, dict, enWords);
        if (spelledAcronym) {
          trace("letters（缩写）命中：" + c.raw + " -> " + spelledAcronym);
          return { kana: spelledAcronym, source: "letters", confident: true };
        }
        return null;
      },
      romaji: function (c) {
        /*
         * 词尾 -ize / -yze 的**不是**日语罗马字（日语里没有以 ぜ 收尾的动词），
         * 一定是英文：memorize / organize / analyze / apologize。
         * 交给规则层的 EN_IZE 那条读成「辅音 + アイズ」—— 否则罗马音会抢答成
         * メモリゼ（用户截图里的 `memorize` 就是这么来的）。
         */
        if (RE_ENGLISH_IZE.test(c.shown)) return null;
        // 词尾 -ude 同理（jude 该是 ジュード，不是 ju-de ジュデ）
        if (RE_ENGLISH_UDE.test(c.shown)) return null;
        var res = null;
        // 用 shown（已小写、去了首尾标点）而不是 stripNonLetters，
        // 因为 "saka-" 词尾的连字符是长音符，不能被吃掉。
        // 折叠过的写法先试：`to-kyo-` 这种末尾的长音符在 normalize 里会被去掉，
        // 所以要用 fold.text 原样喂进去（Tōkyō -> トーキョー，而不是 トキョ）。
        if (c.fold) {
          var foldKana = romajiToKatakana(c.fold.text);
          if (foldKana) {
            trace("romaji（折叠）命中：" + c.fold.text + " -> " + foldKana);
            // 只有长音符（日语罗马字）才算确定；别的变音符号交给上层去修
            res = { kana: foldKana, source: "romaji", confident: c.fold.pureMacron };
          }
        }
        if (!res) {
          var kana = romajiToKatakana(c.shown);
          if (kana) {
            trace("romaji 命中：" + c.shown + " -> " + kana);
            res = { kana: kana, source: "romaji", confident: !c.fold };
          }
        }
        if (!res) return null;
        /*
         * 「看着像英文词」的罗马音答案标成**没把握**。
         *
         * 为什么必须有这一手：罗马音层的判据只是"整串都切得干净"，于是
         * `shake`(sha-ke) -> シャケ、`open`(o-pe-n) -> オペン、`again` -> アガイン
         * 这种英文词会被它当成日语罗马字。而层序里罗马音排在**大模型前面**，
         * 它一答，大模型就没机会纠正 —— 这些词就**永远读错**（用户报的
         * 「the pretender up, … shake, shake, shake it up, it up」里的 shake 就是）。
         *
         * 判据是英文常用词表（core/enwords.js，已剔除词典里已有的词）：
         * 在里面 = 大概率是英文词。标成 confident:false 之后，上层的层序逻辑
         * 会把这个答案当成"垫底的那种"，让在线层来仲裁（结果没回来之前先显示它，
         * 标记成暂定），而不是就此拍板。
         */
        if (res.confident && enWords && enWords[c.shown]) {
          trace("romaji 可疑（英文词表里有）：" + c.shown + " -> " + res.kana);
          res.confident = false;
        }
        return res;
      },
      rule: function (c) {
        // 英文规则永远有结果（最差也是个不 confident 的读音）
        var res = englishToKatakana(c.shown);
        trace("rule 命中：" + c.shown + " -> " + res.kana + "（confident=" + res.confident + "）");
        return { kana: res.kana, source: "rule", confident: res.confident && !c.fold };
      },
    };

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
     *   ① 形态层（不参与排序，永远最先）：
     *      - 记号逐字母读（D/N/A -> ディーエヌエー）
     *      - 缩写拆词干 + 尾巴（I'll -> アイル）
     *      - 只有长音符的罗马字（Tōkyō -> トーキョー）
     *   ② 可排序层：dict / romaji / rule，顺序由上层给（默认 dict > romaji > rule）
     *
     * 为什么形态层不能参与排序：它决定的不是"读音该信谁"，而是"这个词该怎么断"
     * （`D/N/A` 去掉斜杠正好是个词典词条；`I'll` 折掉撇号会撞上 ill）。
     * 查不到返回 null（输入为空、或规范化后没有拉丁字母，也走这条路）。
     */
    function lookup(raw) {
      if (typeof raw !== "string") return null;

      /*
       * 变音符号先折成 ASCII：`Tōkyō` -> `to-kyo-`、`Café` -> `cafe`。
       * 折过之后所有的查表/规则都用折叠形式，只有"记号"判据用原始写法
       * （分隔符的形态只在原文里才有）。
       */
      var fold = foldLatin(raw);
      var query = fold ? fold.text : raw;

      // 去掉首尾标点后再判断「有没有拉丁字母」。
      // 纯标点（"..."）和空串都在这里被挡掉。
      var shown = normalize(query);
      if (!shown || !RE_LATIN.test(shown)) return null;

      /*
       * ① 记号：原始写法就是「字母 分隔符 字母」的，逐字母读
       *    （D/N/A -> ディーエヌエー、R&B -> アールアンドビー）。
       *
       * 必须排在词典**前面**：记号的字母串去掉分隔符之后可能正好是个词条
       * （dna / abc 就在词典里），那会读成单词音而不是字母名。
       * 判据用**原始串**（raw）而不是折过的 shown —— 折的时候连字符会被去掉，
       * 那样 `X-Y` 和 `x-ray` 就分不出来了（前者是记号，后者是词）。
       */
      var spelled = notationToKatakana(raw);
      if (spelled) {
        trace("letters 命中：" + raw + " -> " + spelled);
        return { kana: spelled, source: "letters", confident: true };
      }

      /*
       * ①.5 缩写（'s / 're / 'll / 'd / 've / 'm / n't）：**必须在词典前面**。
       *      折掉撇号之后 `I'll` 会变成 `ill`、`I'd` 变成 `id`，
       *      正好撞上词典里的别的词 —— 用户报的就是这个。
       *      词干递归走正常路径（词典/罗马音/规则），尾巴按音变补上。
       */
      var contr = splitContraction(raw);
      if (contr) {
        if (contr.fixed) {
          trace("缩写命中（整词表）：" + raw + " -> " + contr.fixed);
          return { kana: contr.fixed, source: "dict", confident: true };
        }
        var baseRes = lookup(contr.base);
        if (baseRes) {
          var merged = mergeContraction(baseRes.kana, contr.suffix);
          trace("缩写命中：" + raw + " = " + contr.base + " + " + contr.suffix + " -> " + merged);
          return { kana: merged, source: baseRes.source, confident: baseRes.confident };
        }
      }

      /*
       * ①.2 同一个**元音**重复成串（`AAAAA` / `OOO` / `aaa`）：那是喊叫/拖长音，
       *      不是词，直接按那个元音叠出来。用户截图：
       *      `邪魔者は成敗いたAAAAAす！` 里的 AAAAA —— 词典里 `aaa` 是
       *      トリプルエー、规则层也会读成别的，都不对。
       *      只认元音串：辅音串（XX / YY）另有规矩（见 matcher.looksReadable）。
       */
      var vowelRun = /^([aeiou])\1+$/i.exec(shown);
      if (vowelRun && vowelRun[0].length <= 12) {
        var oneKana = VOWEL_KANA[vowelRun[1].toLowerCase()];
        if (oneKana) {
          var runKana = "";
          for (var vi = 0; vi < vowelRun[0].length; vi++) runKana += oneKana;
          trace("元音串命中：" + shown + " -> " + runKana);
          /*
           * source 用 letters：它和记号/字母名一样属于**形态层**的确定答案 ——
           * 名次算最优先（在线层不会再问一遍，省一次请求）。
           */
          return { kana: runKana, source: "letters", confident: true };
        }
      }

      /*
       * ①.6 只有长音符的词（`Tōkyō` / `kōhī` / `arigatō`）：这就是**日语罗马字**，
       *      麦克风就是长音符标记 —— 按罗马音读（トーキョー / コーヒー / アリガトー）。
       *      长音符只出现在罗马字里，不存在"这层和那层打架"的问题，所以钉在最前面，
       *      跟着 romaji 层一起被排序反而会让 `Tōkyō` 落到词典键上去。
       */
      if (fold && fold.pureMacron) {
        var macronKana = romajiToKatakana(fold.text);
        if (macronKana) {
          trace("romaji（长音符）命中：" + fold.text + " -> " + macronKana);
          return { kana: macronKana, source: "romaji", confident: true };
        }
      }

      // ② 可排序层：按上层给的顺序逐个试，谁先给得出答案就算谁的
      var ctx = { raw: raw, shown: shown, fold: fold, keys: fold ? keysFor(fold.text, shown) : keysFor(raw, normalize(raw)) };
      for (var li = 0; li < layers.length; li++) {
        var picked = LAYER_FN[layers[li]](ctx);
        if (picked) {
          trace(picked.source + " 命中：" + raw + " -> " + picked.kana);
          return picked;
        }
      }
      return null;
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
      else if (res.source === "letters") stat.letterHits++;
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
        letterHits: stat.letterHits,
        romajiHits: stat.romajiHits,
        ruleHits: stat.ruleHits,
        onlineHits: stat.onlineHits,
        missed: stat.missed,
      };
    }

    return { read: read, addOnline: addOnline, stats: stats, setOrder: setOrder, getOrder: getOrder };
  }

  return {
    romajiToKatakana: romajiToKatakana,
    englishToKatakana: englishToKatakana,
    lettersToKatakana: lettersToKatakana,
    notationToKatakana: notationToKatakana,
    spellOutAcronym: spellOutAcronym,
    splitContraction: splitContraction,
    mergeContraction: mergeContraction,
    looksLikeTransliteration: looksLikeTransliteration,
    EN_CONTRACTIONS: EN_CONTRACTIONS,
    foldLatin: foldLatin,
    createReader: createReader,
    normalize: normalize,
    // 下面这些是给上层/测试翻表用的，不在任务要求的四个 API 里，但不多余
    ENGLISH_EXCEPTIONS: ENGLISH_EXCEPTIONS,
    LETTER_KANA: LETTER_KANA,
    RE_KATAKANA: RE_KATAKANA,
  };
});
