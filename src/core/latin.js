/*
 * 拉丁字母识别：在一片文本里找出"值得标片假名读音"的拉丁词。
 *
 * 和 katakana-terminator 的 matcher.js 正好相反 —— 那个找片假名，这个找拉丁字母。
 * 但要处理的问题一样：不能把整段文字当成一个词，也不能把标点、缩写、单字母
 * 当成要标的东西。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LKMatcher = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*
   * 拉丁字母的字符集：ASCII + Latin-1 Supplement + Latin Extended-A/B +
   * Latin Extended Additional。**必须带变音符号那一堆** —— 用户报的
   * `Ō` 就是被 ASCII 正则漏掉的：`Tōkyō` 会被切成 `T` + `ky`，
   * 于是 `ky` 单独命中词典读成 ケーワイ，比不标还糟。
   */
  var LAT = "[A-Za-z\\u00C0-\\u024F\\u1E00-\\u1EFF]";
  /** 记号里的分隔符（`D/N/A` 的斜杠等） */
  var GLUE = "[\\/\\\\|_.&#*~+=\\u30FB\\uFF0F\\uFF3C-]";

  /*
   * 一个"词"：字母开头结尾，中间允许撇号和连字符（don't / e-mail / rock'n'roll）。
   * 撇号用 ASCII 的和全角的都收 —— 歌词里两种都见过。
   *
   * 另一种要先认出来的是**记号**：`D/N/A`、`N/A`、`A.B.C`、`R&B`、`X-Y` ——
   * 单个字母被分隔符串起来（用户报的 `だって D/N/Aじゃ 騙れない` 就是这种）。
   * 它整体算一个词，读音是**逐字母**的字母名（ディーエヌエー），见 reading.js。
   * 必须排在普通词前面：否则 `D/N/A` 会被切成三个单字母，或者 `X-Y` 被
   * 当成一个普通的连字符词读成"xy"。
   */
  var RE_NOTATION = new RegExp(LAT + "(?:" + GLUE + LAT + ")+", "g");

  /** 整串就是一个记号（`D/N/A`、`N/A`、`A.B.C`、`R&B`、`X-Y`） */
  var RE_NOTATION_WHOLE = new RegExp("^" + LAT + "(?:" + GLUE + LAT + ")+$");

  /** 普通词（含撇号/连字符） */
  var RE_PLAIN = new RegExp(LAT + "(?:" + LAT + "|['\\u2019-](?=" + LAT + "))*", "g");

  /** 这段文字里有没有拉丁字母（含带变音符号的） */
  function hasLatin(text) {
    // 注意必须先挡掉空值：/[A-Za-z]/.test(null) 会把参数转成字符串 "null"，
    // 于是返回 true —— 后面那句 scan 就会去扫一个不存在的文本。
    if (!text) return false;
    return new RegExp(LAT).test(String(text));
  }

  /*
   * 单字母是不是"某个记号被拆开的一截"（而不是一个英文单词）。
   *
   * 用户报的：`だって D/N/Aじゃ 騙れない` 里的那个 A 被注成了 ア。
   * 这类写法的 A 是标题/记号的零件（`D/N/A`、`N/A`、`A.B.C`、`X-Y`），
   * 按英文冠词去读是错的。判据只看**紧挨着的前后一个字符**：
   * 是分隔符就说明它和邻字粘在一起。
   *
   * 全角斜杠/中点也认（歌词里经常混排），句尾的 `.` 同样算 —— 代价是
   * "A." 这种句首缩写不再注音，比把 `A.B.C` 里的 A 注成 ア 好得多。
   * 装饰性符号（`&A&`、`*A*`、`#A`）同样算粘住：那种 A 是排版效果，不是冠词。
   */
  var GLUE_CHARS = "/\\|_.\u30FB\uFF0F\uFF3C-\u2010\u2011\u2013\u2014&#*~+=\u301C";
  function isGluedLetter(text, start, end) {
    var before = start > 0 ? text.charAt(start - 1) : "";
    var after = end < text.length ? text.charAt(end) : "";
    return (before !== "" && GLUE_CHARS.indexOf(before) >= 0) || (after !== "" && GLUE_CHARS.indexOf(after) >= 0);
  }

  /**
   * 切成一个个词，返回 [{ text, start, end, norm, glued, notation }]。
   *
   * norm 是拿去查读音的形式：小写、去掉撇号连字符。查表、音译都用它 ——
   * 保留原始 text 是为了原样把底字写回 DOM（底字必须是歌词原文，一个字符不改）。
   * glued 只对单字母有意义：它粘在分隔符上。notation 是"记号"整体（D/N/A）。
   *
   * 扫描顺序：先记号、再普通词 —— 两个正则都在同一个位置试，取先匹配上的。
   */
  function scan(text) {
    var out = [];
    if (!text) return out;
    var i = 0;
    var len = text.length;
    var RE_LATIN_ONE = new RegExp(LAT);
    while (i < len) {
      var ch = text.charAt(i);
      // 注意这里也要用 LAT：只判 [A-Za-z] 的话，`Ōkami` 会在 Ō 上直接跳过，
      // 剩下 `kami` 被当成一个词（用户报的 `Ō` 不注音就是这么来的）
      if (!RE_LATIN_ONE.test(ch)) {
        i++;
        continue;
      }
      /*
       * 先试记号：`D/N/A` 要整体认出来。
       * 但记号后面**不能再跟字母** —— 否则 `e-mail` 会被切成 `e-m` + `ail`
       * （两个单字母被连字符串起来，正好长得像记号）。那种情况退回普通词。
       */
      var raw = null;
      var nota = matchAt(RE_NOTATION, text, i);
      // 记号后面不能再跟字母（含带变音符号的），否则 e-mail 会被切成 e-m + ail
      if (nota && !RE_LATIN_ONE.test(text.charAt(i + nota.length))) raw = nota;
      if (!raw) raw = matchAt(RE_PLAIN, text, i);
      if (!raw) {
        i++;
        continue;
      }
      var start = i;
      var end = i + raw.length;
      out.push({
        text: raw,
        start: start,
        end: end,
        norm: normalize(raw),
        // 单字母且粘着分隔符 —— 只有在它**没有**组成记号时才会走到
        // （例如句尾那个孤零零的 `A.`），那种不标
        glued: raw.length === 1 ? isGluedLetter(text, start, end) : false,
        notation: raw.length > 1 && RE_NOTATION_WHOLE.test(raw),
        // 带变音符号（Ō / é / ü …）：读音层要先折成 ASCII 再查，见 reading.js
        diacritic: /[^\x00-\x7F]/.test(raw),
      });
      i = end;
    }
    return out;
  }

  /** 在 i 处锚定匹配一个正则（不带 g，靠 ^ 与切片避免 lastIndex 的坑） */
  function matchAt(re, text, i) {
    re.lastIndex = 0;
    var m = re.exec(text.slice(i));
    return m && m.index === 0 ? m[0] : null;
  }

  /** 查表/音译用的规范形式：小写、去掉撇号与连字符 */
  function normalize(text) {
    if (!text) return "";
    return String(text)
      .toLowerCase()
      .replace(/['\u2019-]/g, "");
  }

  /*
   * 单字母词：默认不标，但英文里真实存在的两个词例外。
   *
   * 「x」「b」这种一个字母的多半是首字母缩写或者排版噪声，标上去只是噪音，
   * 所以默认跳过。但 `a` 和 `I` 是**真正的英文单词**，而且在 J-pop 歌词里满地都是
   * （"Tell me a story"、"I love you"）—— 一行里其它词都标了、就它们空着，
   * 比标错还显眼。它们的读音由词典给（`a` -> ア、`i` -> アイ，见 tools/seed-words.js）。
   *
   * 已知取舍：罗马音歌词里孤零零一个 `i`（= い）会被读成 アイ。
   * 但 RNP 的罗马音层本来就被整层跳过，纯罗马音行里的单字母也极少，
   * 而英文歌部分里 "I" 远比裸的 "i" 常见，所以选这一侧。
   *
   * 记号（`D/N/A`、`N/A`、`A.B.C`、`R&B`）整体算一个词，读音是逐字母的字母名，
   * 所以这里照常放行（norm 长度 >= 2）。孤零零粘着分隔符的单字母（`A.`）
   * 不标 —— 那是记号的零件或排版噪声。
   *
   * 注意**不做**"常见词不标"的白名单：用户要的就是歌词里的拉丁词都标上读音，
   * the / and 这类也照标 —— 否则一行里漏一半，看着更奇怪。
   */
  var SINGLE_LETTER_WORDS = { a: true, i: true };

  function looksReadable(token) {
    if (!token || !token.norm) return false;
    // 记号：整体逐字母读（D/N/A -> ディーエヌエー）
    if (token.notation === true) return token.norm.replace(/[^a-z]/g, "").length >= 2;
    if (token.norm.length === 1) {
      // 粘在分隔符上的单字母还是不算词（`&A&`、`A.`）
      if (token.glued === true) return false;
      // 带变音符号的单字母（`Ō`）不是缩写噪声，是罗马音/外语里的一个音，要标
      return token.diacritic === true || SINGLE_LETTER_WORDS[token.norm] === true;
    }
    return true;
  }

  /** 这片文字里有没有"值得标"的词（用来快速判断整段要不要处理） */
  function hasReadable(text) {
    var toks = scan(text);
    for (var i = 0; i < toks.length; i++) if (looksReadable(toks[i])) return true;
    return false;
  }

  return {
    hasLatin: hasLatin,
    hasReadable: hasReadable,
    scan: scan,
    normalize: normalize,
    looksReadable: looksReadable,
    isNotation: function (s) {
      return RE_NOTATION_WHOLE.test(String(s || ""));
    },
  };
});
