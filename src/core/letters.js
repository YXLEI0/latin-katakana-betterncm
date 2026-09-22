/*
 * 西文字母识别：在一片文本里挑出值得标片假名读音的西文词（core/letters.js）。
 *
 * 和 katakana-terminator 的 matcher.js 正好相反：那个找片假名，这个找字母。
 * 要处理的问题一样，不能把整段文字当成一个词，也不能把标点、缩写、单字母
 * 当成要标的东西。
 *
 * 俄语（西里尔）和希腊语也要注音，所以这里认三种字母：latin / cyrillic / greek，
 * 词条上带 script 字段，读音层按它选拼读规则。
 * 挂在 globalThis.WKMatcher（改名前的名字是 LKMatcher）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKMatcher = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /*
   * 拉丁字母的字符集：ASCII + Latin-1 Supplement + Latin Extended-A/B +
   * Latin Extended Additional + 全角拉丁（`ＮＯ` / `ＤＲＥＡＭ`）。
   * 变音符号那一堆必须带上：用户报的 `Ō` 就是被 ASCII 正则漏掉的，
   * `Tōkyō` 会被切成 `T` + `ky`，`ky` 再单独命中词典读成 ケーワイ，比不标还糟。
   * 全角那一段是另一张截图教的，`こんなんじゃ（ＮＯ!）` 里的 `ＮＯ` 是排版用的全角写法，
   * 原来压根没被当成词（一个注音都没有）；读音层会先折成半角再查，见 main.js。
   */
  var LAT_CLS = "A-Za-z\\u00C0-\\u024F\\u1E00-\\u1EFF\\uFF21-\\uFF3A\\uFF41-\\uFF5A";
  /** 西里尔字母（基本块 + 补充块） */
  var CYR_CLS = "\\u0400-\\u04FF\\u0500-\\u052F";
  /** 希腊字母（基本块 + 多音调扩展） */
  var GRK_CLS = "\\u0370-\\u03FF\\u1F00-\\u1FFF";
  var LAT = "[" + LAT_CLS + "]";
  var CYR = "[" + CYR_CLS + "]";
  var GRK = "[" + GRK_CLS + "]";
  /** 三种字母合起来的"一个西文字母" */
  var WEST = "[" + LAT_CLS + CYR_CLS + GRK_CLS + "]";
  /** 记号里的分隔符（`D/N/A` 的斜杠等） */
  var GLUE = "[\\/\\\\|_.&#*~+=\\u30FB\\uFF0F\\uFF3C\\u2010\\u2011\\u2013\\u2014\\u00B7\\u2022-]";

  /*
   * 一个“词”：字母开头结尾，中间允许撇号和连字符（don't / e-mail / rock'n'roll），
   * 撇号 ASCII 的和全角的都收，歌词里两种都见过。
   *
   * 另一种要先认出来的是记号：`D/N/A`、`N/A`、`A.B.C`、`R&B`、`X-Y`，
   * 也就是单个字母被分隔符串起来（用户报的 `だって D/N/Aじゃ 騙れない` 就是这种）。
   * 记号整体算一个词，读音逐字母走字母名（ディーエヌエー），见 reading.js。
   * 它必须排在普通词前面：不然 `D/N/A` 会被切成三个单字母，`X-Y` 会被当成
   * 普通的连字符词读成“xy”。
   */
  var RE_NOTATION = new RegExp(LAT + "(?:" + GLUE + LAT + ")+", "g");

  /** 整串就是一个记号（`D/N/A`、`N/A`、`A.B.C`、`R&B`、`X-Y`） */
  var RE_NOTATION_WHOLE = new RegExp("^" + LAT + "(?:" + GLUE + LAT + ")+$");

  /*
   * 词内连接符：撇号、连字符，以及波浪号。
   *
   * 波浪号是用户截图教出来的。`この feel~ing go~od` 原来按波浪号切开
   * （feel + ing → フィール + イング、go + od → ゴー + オッド），读出来就是
   * “フィールイング”这种东西。它其实是拉长音的排版写法（feel~ing = feeling、
   * go~od = good），所以当词内连接符处理：整串算一个词，查表时把波浪号折掉
   * （norm 是 feeling / good）。
   *
   * 结尾那种（`go~` / `love~`）不受影响，连接符后面得还有字母才算词内。
   * 三种波浪号都收：ASCII `~`、全角 `～`(FF5E)、波ダッシュ `〜`(301C)。
   *
   * `○` / `●` 也当词内连接符 —— 那是**被涂掉一个字**（用户截图 `T○itter` =
   * Twitter），整串仍是一个词，读音层再拿它去词典里按通配找（见 main.js）。
   *
   * 连字符也是几种都收（ASCII `-`、`‐`(2010)、`‑`(2011)、`–`(2013)、`—`(2014)）：
   * 歌词里这几种混着用，只认 ASCII 那一版的话 `Looser–Krankheit` 会被切成两个词，
   * 而 `Looser-Krankheit` 却是一条，同一个排版两种切法，全看运气。
   * 串成一条之后还会再判要不要拆，见 splitDashes。
   */
  var WORD_JOIN = "['\\u2019~\uFF5E\u301C\\-\\u2010\\u2011\\u2013\\u2014\u25CB\u25CF\u25EF\u3007\u2B55]";

  /** 普通词（含撇号/连字符/波浪号/结尾的掩码符号）；西里尔/希腊字母同样算词 */
  var RE_PLAIN = new RegExp(
    WEST + "(?:" + WEST + "|" + WORD_JOIN + "(?=" + WEST + ")|[\u25CB\u25CF\u25EF\u3007\u2B55])*",
    "g"
  );

  /*
   * 连字符链要拆成独立的词：`Looser-Krankheit-Was`、`High-de-Siehst`、`well-known`。
   *
   * 原来整条链算一个词（`e-mail` / `x-ray` 那种确实要），于是读音层一次读一整串，
   * 注音也只有一个 ruby：用户截图里 `Looser-Krankheit-` 上面压着一整条
   * `ルーザークランクハイトヴァス`，比底字还宽、和每个词对不上（用户的话是
   * “有些单词超长了效果不好”）；大模型那层还会把 `looserkrankheitwas` 当成一个词
   * 去问（真机缓存里就有这条键），每个词各问各的、各自沉淀的机会全没了。
   *
   * 判据是每一段都 >= 2 个字母才拆。`e-mail` / `x-ray` / `T-ara` 里有单字母段，
   * 那是词内的连字符，拆开只会更差，保持整词；`A-Z` 那种记号在扫描时就被
   * 记号规则接走了，到不了这里。
   */
  var RE_DASH = /[\-\u2010\u2011\u2013\u2014]/;

  /** 把一条连字符链切成 [{ text, offset }]；不该拆就返回 null */
  function splitDashes(raw) {
    var parts = raw.split(RE_DASH);
    if (parts.length < 2) return null;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length < 2) return null;
    }
    var out = [];
    var at = 0;
    for (var j = 0; j < parts.length; j++) {
      out.push({ text: parts[j], offset: at });
      at += parts[j].length + 1; // +1 = 那个连字符
    }
    return out;
  }

  /** 这段文字里有没有拉丁字母（含带变音符号的） */
  function hasLatin(text) {
    // 空值必须先挡掉：/[A-Za-z]/.test(null) 会把参数转成字符串 "null" 返回 true，
    // 后面那句 scan 就会去扫一个不存在的文本。
    if (!text) return false;
    return new RegExp(LAT).test(String(text));
  }

  /** 这段文字里有没有西文字母（拉丁 + 西里尔 + 希腊） */
  function hasWestern(text) {
    if (!text) return false;
    return new RegExp(WEST).test(String(text));
  }

  var RE_CYR = new RegExp(CYR);
  var RE_GRK = new RegExp(GRK);

  /** 这个词属于哪种字母：latin / cyrillic / greek（读音层按它选拼读规则） */
  function scriptOf(text) {
    var s = String(text == null ? "" : text);
    if (RE_CYR.test(s)) return "cyrillic";
    if (RE_GRK.test(s)) return "greek";
    return "latin";
  }

  /*
   * 单字母是不是“某个记号被拆开的一截”，而不是一个英文单词。
   *
   * 用户报的 `だって D/N/Aじゃ 騙れない` 里那个 A 被注成了 ア。这类写法的 A 是
   * 标题和记号的零件（`D/N/A`、`N/A`、`A.B.C`、`X-Y`），按英文冠词读是错的。
   * 判据只看紧挨着的前后一个字符：是分隔符就说明它和邻字粘在一起。
   *
   * 全角斜杠、中点也认（歌词里经常混排），句尾的 `.` 同样算，代价是 "A." 这种
   * 句首缩写不再注音，但比把 `A.B.C` 里的 A 注成 ア 好得多。装饰性符号
   * （`&A&`、`*A*`、`#A`）也算粘住，那种 A 是排版效果，不是冠词。
   *
   * 颜文字符号同样算粘住：用户截图 `(#^ω^)` 里的 ω 被标成了 オメガ。`^` `` ` `` `´`
   * `＾` `｀` `ﾟ` `゛` `゜` 这些在日文里只出现在颜文字和装饰里（`(ﾟДﾟ)`、`(´▽｀)`、
   * `(#^ω^)`），夹在它们中间的那个字母是画脸用的，不是词。
   */
  var GLUE_CHARS = "/\\|_.\u30FB\uFF0F\uFF3C-\u2010\u2011\u2013\u2014\u00B7\u2022&#*~+=\u301C\uFF5E^`\u00B4\uFF3E\uFF40\uFF9F\u309B\u309C";
  function isGluedLetter(text, start, end) {
    var before = start > 0 ? text.charAt(start - 1) : "";
    var after = end < text.length ? text.charAt(end) : "";
    return (before !== "" && GLUE_CHARS.indexOf(before) >= 0) || (after !== "" && GLUE_CHARS.indexOf(after) >= 0);
  }

  /**
   * 这个单字母是不是**颜文字里的那个字母**（`:-b` / `;-b` / `:o`）—— 眼睛符号在它前面。
   *
   * 用户截图：`:-b ;-b boy, :-b ;-b` 里的 `b` 希望照样注音（ビー）。它和 `A.` 那种
   * "句尾粘着句号的单字母不标"拼写上都叫"粘着分隔符"，区别在粘的是什么：
   * 冒号/分号是表情符号的眼睛，这种字母是歌词里唱出来的；句号/引号那种是排版符号。
   * 这里只标出"是颜文字字母"，标不标、读什么还是交给 main.js 按整行判。
   */
  function isEmoticonLetter(text, start, end) {
    var before = start > 0 ? text.charAt(start - 1) : "";
    var before2 = start > 1 ? text.charAt(start - 2) : "";
    var after = end < text.length ? text.charAt(end) : "";
    var after2 = end + 1 < text.length ? text.charAt(end + 1) : "";
    var EYES = ":\uFF1A;\uFF1B";
    // `:-b`（眼睛 + 一道横线 + 字母）和 `:b` 都算；注意别用空字符串去 indexOf（那会返回 0）
    return (
      (!!before && EYES.indexOf(before) >= 0) ||
      (!!before2 && EYES.indexOf(before2) >= 0) ||
      (!!after && EYES.indexOf(after) >= 0) ||
      (!!after2 && EYES.indexOf(after2) >= 0)
    );
  }

  /**
   * 切成一个个词，返回 [{ text, start, end, norm, glued, notation }]。
   *
   * norm 是拿去查读音的形式：小写、去掉撇号连字符，查表和音译都用它。保留原始
   * text 是为了原样把底字写回 DOM（底字必须是歌词原文，一个字符不改）。
   * glued 只对单字母有意义：它粘在分隔符上。notation 是“记号”整体（D/N/A）。
   *
   * 扫描顺序是先记号、再普通词，两个正则都在同一个位置试，取先匹配上的。
   */
  function scan(text) {
    var out = [];
    if (!text) return out;
    var i = 0;
    var len = text.length;
    var RE_WEST_ONE = new RegExp(WEST);
    while (i < len) {
      var ch = text.charAt(i);
      // 这里也得用字母类：只判 [A-Za-z] 的话 `Ōkami` 会在 Ō 上直接跳过，
      // 剩下 `kami` 被当成一个词，用户报的 `Ō` 不注音就是这么来的；
      // 西里尔、希腊同理（俄语、希腊语歌词要整词走语言引擎）
      if (!RE_WEST_ONE.test(ch)) {
        i++;
        continue;
      }
      /*
       * 先试记号，`D/N/A` 要整体认出来；但记号后面不能再跟字母，否则 `e-mail`
       * 会被切成 `e-m` + `ail`（两个单字母被连字符串起来，正好长得像记号），
       * 那种情况退回普通词。
       */
      var raw = null;
      var nota = matchAt(RE_NOTATION, text, i);
      if (nota && !RE_WEST_ONE.test(text.charAt(i + nota.length))) raw = nota;
      if (!raw) raw = matchAt(RE_PLAIN, text, i);
      if (!raw) {
        i++;
        continue;
      }
      var start = i;
      var end = i + raw.length;
      /*
       * 记号（`D/N/A`、`M・I・D・I`、`R&B`、`A.B.C`）拆成一个字母一个词。
       *
       * 用户截图里 `M·I·D·I` 上面压着一整条 `エムアイディーアイ`，和每个字母对不上，
       * 用户问的是“能不能分别注在每个字母上”。拆开之后每个字母各标一个 ruby
       * （エム / アイ / ディー / アイ），分隔符留在原地当普通文本。
       *
       * `&` 是唯一有读音的分隔符（アンド），所以它自己发一个“符号词”，别的分隔符
       * （`/` `.` `・` `-` …）不发音，不当词。
       *
       * 尾巴上的缩写，比如 `I-I-I-I-I-I-I'm` 里最后的 `I'm`，`'m` / `'s` / `'re` /
       * `'ll` / `'ve` / `'d` 要跟最后一个字母合成一个词（读 アイム，见 reading.js
       * 的缩写表）。用户截图 `I-I-I-I-I-I-I'm mine` 原来只注到 `I`、`'m` 整个丢了，
       * 因为记号在 `'` 前面就切断了，剩下一个孤零零的 `m` 没人管。
       */
      if (RE_NOTATION_WHOLE.test(raw)) {
        /*
         * 有些点号记法其实是**罗马字单词**拆开写的：`K・A・I・S・A・N` 唱的是 カイサン
         * （官方罗马音那行写的正是 KAISAN，用户截图）。这种整串交给罗马音层，不逐字母念。
         * 判据：拼起来全是字母、≥5 个字母、罗马音层切得出 ≥3 拍 ——
         * 短的（`M・I・D・I` / `D/N/A` / `A.B.C`）照旧逐字母读字母名。
         */
        var flat = raw.replace(/[^A-Za-z]/g, "");
        /*
         * 有**固定读法**的记号：`p.h.`（`pH`，化学的酸碱度）日语读 ペーハー，
         * 不是逐字母的 ピーエイチ（用户截图 `p.h.って、胃酸を`，官方翻译写着"靠着 p.h."）。
         * 整串发一个词，读音交给 main.js 的 NOTATION_WORD_KANA。
         */
        if (flat.toLowerCase() === "ph") {
          out.push({
            text: raw,
            start: start,
            end: end,
            norm: normalize(raw),
            glued: false,
            emoticon: false,
            notation: false,
            notationWord: true,
            script: scriptOf(raw),
            diacritic: false,
          });
          i = end;
          continue;
        }
        if (flat.length >= 5 && typeof WKReading !== "undefined" && WKReading.romajiToKatakana) {
          var asRomaji = null;
          try {
            var rr = WKReading.romajiToKatakana(flat.toLowerCase());
            asRomaji = rr && (typeof rr === "string" ? rr : rr.kana);
          } catch (e) {
            asRomaji = null;
          }
          if (asRomaji && asRomaji.length >= 3) {
            out.push({
              text: raw,
              start: start,
              end: end,
              norm: normalize(raw),
              glued: false,
              emoticon: false,
              notation: false,
              afterDigit: start > 0 && /[0-9\uFF10-\uFF19]/.test(text.charAt(start - 1)),
              label: false,
              script: scriptOf(raw),
              diacritic: /[^\x00-\x7F]/.test(raw),
              romajiWord: true,
            });
            i = end;
            continue;
          }
        }
        var tail = "";
        var tm = /^['\u2019](?:m|s|re|ll|ve|d)(?![A-Za-z])/i.exec(text.slice(end));
        if (tm) tail = tm[0];
        var em = end + tail.length;
        for (var q = 0; q < raw.length; q++) {
          var chN = raw.charAt(q);
          var atN = start + q;
          var last = q === raw.length - 1 && tail;
          if (RE_WEST_ONE.test(chN)) {
            out.push({
              text: last ? chN + tail : chN,
              start: atN,
              end: last ? em : atN + 1,
              norm: last ? normalize(chN + tail) : chN.toLowerCase(),
              glued: true,
              notation: true,
              script: scriptOf(chN),
              diacritic: /[^\x00-\x7F]/.test(chN),
            });
          } else if (chN === "&") {
            out.push({
              text: "&",
              start: atN,
              end: atN + 1,
              norm: "&",
              glued: true,
              notation: true,
              symbol: true,
              script: "latin",
              diacritic: false,
            });
          }
        }
        i = em;
        continue;
      }
      /*
       * 连字符链：先看要不要拆成几个独立的词（见 splitDashes）。拆出来的每一段
       * 自己走一遍 norm / script / diacritic，读音层和注音层都当成普通的词处理，
       * 连字符留在原地当普通文本。
       */
      var parts = splitDashes(raw);
      if (parts) {
        for (var p = 0; p < parts.length; p++) {
          var seg = parts[p];
          var segStart = start + seg.offset;
          out.push({
            text: seg.text,
            start: segStart,
            end: segStart + seg.text.length,
            norm: normalize(seg.text),
            glued: false,
            emoticon: false,
            notation: false,
            // 连字符串里的一段（`Ex-Otogibanashi` 的 Ex）：读音层要靠它决定"逐字母还是罗马音"
            chain: true,
            script: scriptOf(seg.text),
            diacritic: /[^\x00-\x7F]/.test(seg.text),
          });
        }
        i = end;
        continue;
      }
      out.push({
        text: raw,
        start: start,
        end: end,
        norm: normalize(raw),
        // 单字母且粘着分隔符：只有没组成记号时才会走到（句尾那个孤零零的
        // `A.` 就是），那种不标
        glued: raw.length === 1 ? isGluedLetter(text, start, end) : false,
        // 颜文字里的字母（`:-b` 的 b）：粘的分隔符是表情的眼睛，别按"A. 那种"挡掉
        emoticon: raw.length === 1 ? isEmoticonLetter(text, start, end) : false,
        notation: false,
        // 紧跟在数字后面（`300mm` 的 mm），多半是单位词，见 looksReadable
        afterDigit: start > 0 && /[0-9\uFF10-\uFF19]/.test(text.charAt(start - 1)),
        /*
         * 段标（`M:` / `A：` / `(B:`）：单字母后面（可夹空白）紧跟冒号。
         * 这一判必须带上位置，只看“这一行里有没有 `M:`”的话，`M: 匿名Mです。`
         * 里 `匿名M` 的那个 M 也会跟着留白（用户截图）。
         */
        label: raw.length === 1 && /^\s*[:：]/.test(text.slice(end)),
        // 属于哪种字母（latin / cyrillic / greek）：读音层按它选拼读规则
        script: scriptOf(raw),
        // 带变音符号（Ō / é / ü …）：读音层要先折成 ASCII 再查，见 reading.js
        diacritic: /[^\x00-\x7F]/.test(raw),
      });
      i = end;
    }
    return out;
  }

  /** 在 i 处锚定匹配一个正则（靠切片 + ^ 锚定，避开 lastIndex 的坑） */
  function matchAt(re, text, i) {
    re.lastIndex = 0;
    var m = re.exec(text.slice(i));
    return m && m.index === 0 ? m[0] : null;
  }

  /**
   * 查表/音译用的规范形式：小写、去掉撇号与连字符，波浪号同理（见 WORD_JOIN），
   * 全角拉丁折成半角（`ＮＯ` → `no`）：词表的键都是半角。
   */
  function normalize(text) {
    if (!text) return "";
    return foldFullwidth(String(text))
      .toLowerCase()
      .replace(/['\u2019~\uFF5E\u301C\-\u2010\u2011\u2013\u2014]/g, "");
  }

  /** 全角拉丁字母 -> 半角（其余字符不动） */
  function foldFullwidth(s) {
    return String(s).replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
  }

  /*
   * 单字母词：默认不标，只有真实存在于语言里的那几个例外。
   *
   * 「x」「b」这种一个字母的多半是首字母缩写或排版噪声，标上去只是噪音，所以默认
   * 跳过。但 a / i / o 是真词，一行里其它词都标了、就它们空着，比标错还显眼：
   * a / i 是英文单词（"Tell me a story"、"I love you"），读音由词典给；o 是拉丁语
   * 和意大利语里的连词（= 或）与呼语，用户截图的拉丁语歌词里 `tragedia o splendidae`
   * 和 `fatalita o infaustae` 里那个小 o 就是它（同一首歌里呼语用大写 `O`，读 オー，
   * 见 main.js）。
   *
   * 已知取舍：罗马音歌词里孤零零一个 `i`（= い）会被读成 アイ。但 RNP 的罗马音层
   * 本来就被整层跳过，纯罗马音行里的单字母也极少，而英文歌部分里 "I" 远比裸的 "i"
   * 常见，所以选这一侧。
   *
   * 记号（`D/N/A`、`N/A`、`A.B.C`、`R&B`）整体算一个词，读音是逐字母的字母名，
   * 这里照常放行（norm 长度 >= 2）。孤零零粘着分隔符的单字母（`A.`）不标，
   * 那是记号的零件或排版噪声。
   *
   * 这里不做“常见词不标”的白名单：用户要的就是歌词里的拉丁词都标上读音，
   * the / and 这类也照标，否则一行里漏一半，看着更奇怪。
   */
  var SINGLE_LETTER_WORDS = { a: true, i: true, o: true };

  function looksReadable(token) {
    if (!token || !token.norm) return false;
    /*
     * 西里尔、希腊：单字母也是真词（俄语的 и / в / с / к / у 全是常用介词），
     * 也没有“打码占位符”那种顾虑，整词一律照标。
     */
    if (token.script && token.script !== "latin") return token.glued !== true;
    /*
     * 记号里的零件（`D/N/A` 的 D、`M・I・D・I` 的 I、`R&B` 的 `&`）一律照标。
     * 它们本来就是逐字母读的那串字母，读音由读音层按整行判成字母名（见 main.js
     * 的 lineLetterRun / localReading）；拿“粘着分隔符的单字母不标”那条去挡它们
     * 就全空了：用户当初报的正是 `D/N/A` 里的 A 被读成 ア，现在标的是字母名 エー。
     */
    if (token.notation === true) return true;
    /*
     * 同一个辅音字母重复的整词。
     *
     * 小写和长串不标，歌词里的 `xx` / `XXXX` 是打码或排版噪声；全大写 2~3 个要标，
     * 用户要的 `YY`（`合言葉は「YY」`）就是这种，按字母名读成 ワイワイ。代价是
     * 打码的 `XX` 也会读成 エックスエックス：两者拼写一模一样、意思相反，本地分不出
     * 来，就按用户的选择统一标。
     *
     * 元音串（`AAAAA` / `OOO`）在上面就不受这条影响，那是喊叫或拖长音。
     * 这一段必须放在记号判断之后：`A-A`、`X-X` 那种是记号（エーエー / エックスワイ）。
     */
    if (/^([bcdfghjklmnpqrstvwxyz])\1+$/i.test(token.norm)) {
      /*
       * 紧跟数字的重复辅音是单位词（`300mm` 的 `mm` = ミリ；`5kg` 倒不是重复字母）。
       * 用户截图 `半径300mmの体で`：那首歌罗马音行唱的就是 mi ri（ミリ），而 `mm`
       * 原来被当成打码的 `XX` 留白了。`mm~` 这种语气词前面没有数字，照旧留白。
       */
      if (token.afterDigit === true) return token.norm.length <= 3;
      return /^[BCDFGHJKLMNPQRSTVWXYZ]{2,3}$/.test(token.text);
    }
    if (token.norm.length === 1) {
      // 粘在分隔符上的单字母还是不算词（`&A&`、`A.`）；颜文字里的那个字母除外
      // （`:-b` 的 b —— 用户点名要它注音，见 isEmoticonLetter）
      if (token.glued === true && token.emoticon !== true) return false;
      // 颜文字里的那个字母（`:-b` 的 b）：交给读音层按整行判
      if (token.emoticon === true) return true;
      /*
       * 大写的单个字母（`(A, B)` / `B面` / `O型`）可能是字母名，也可能是英文冠词 A，
       * 光看这个词分不出来，所以这里放行，由读音层按整行判：同一行里成串的大写
       * 单字母才读字母名，见 main.js 的 lineLetterRun / localReading。
       */
      if (/^[A-Z]$/.test(token.text)) return true;
      // 带变音符号的单字母（`Ō`）不是缩写噪声，是罗马音/外语里的一个音，要标
      return token.diacritic === true || SINGLE_LETTER_WORDS[token.norm] === true;
    }
    return true;
  }

  /** 这片文字里有没有“值得标”的词（用来快速判断整段要不要处理） */
  function hasReadable(text) {
    var toks = scan(text);
    for (var i = 0; i < toks.length; i++) if (looksReadable(toks[i])) return true;
    return false;
  }

  return {
    hasLatin: hasLatin,
    hasWestern: hasWestern,
    hasReadable: hasReadable,
    scan: scan,
    scriptOf: scriptOf,
    normalize: normalize,
    looksReadable: looksReadable,
    isNotation: function (s) {
      return RE_NOTATION_WHOLE.test(String(s || ""));
    },
  };
});
