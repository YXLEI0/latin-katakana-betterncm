/*
 * 西文语言的拼读规则 + 整行语言判定 —— **语言这件事只在这里**。
 *
 * 分工（一个关注点只放一个地方）：
 *   core/letters.js  切词：哪些字符算"西文的一个词"（拉丁 / 西里尔 / 希腊三种字母）
 *   core/dict.js     离线词典（人工 + 沉淀 + 大模型），优先级最高
 *   core/reading.js  只有两套：日语罗马音、英语规则
 *   core/langs.js    **本文件**：九种西文的拼读引擎 + 整行语言判定 + 同形异音 + 语言名
 *   core/loan.js     借词表（tools/vendor/loan/*.txt 生成），九种语言共用一张机制
 *
 * 九种语言：法语 fr / 德语 de / 拉丁语 la / 葡萄牙语 pt / 荷兰语 nl /
 * 斯瓦希里语 sw / 汉语拼音 pinyin / 俄语 ru / 希腊语 el。
 * 法语原来单独写在 core/reading.js 里（拼读 + 判据 + 借词表），现在整块搬过来了：
 * 拼读进 ENGINE，判据进 SIGNALS，借词表进 tools/vendor/loan/fr.txt。
 *
 * 对外就四件事：
 *   detect(text)          这一行是什么语言（判不出来返回 null）
 *   fits(id, text)        整首投票兜底：短行自己分不够时"像不像"那种语言
 *   toKatakana(id, word)  按那种语言拼读，把一个词读成片假名
 *   word(id, raw)         这个词有没有"日语里就是这么写"的借词读音
 *
 * 借词表（core/loan.js，sljfaq 那份「日语里就是这么写的」）是**日语通行写法**，
 * 等于人工词条，所以在外语行上比英语词典还优先。
 *
 * 两种字母：
 *   拉丁字母：词由 core/letters.js 切出来，读音走这里的引擎；
 *   西里尔 / 希腊字母：core/letters.js 一样会切（它认这三种字母），但词典层和
 *   罗马音层都读不了 —— 俄语和希腊语的支持就落在"这里必须给出答案"上。
 *
 * 所有规则层的结果都是 confident:false（拼写近似，配了 key 交给大模型按整句定，
 * 判完还会被沉淀成离线词条），借词表命中的是 confident:true。
 *
 * 目标宿主是网易云内置的老 CEF，所以这里只用 ES5。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(typeof globalThis !== "undefined" ? globalThis : null);
  else root.WKLangs = factory(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /**
   * 运行时取依赖：注入顺序里 core/loan.js 在本文件前面，但 Node 里单独 require
   * 时它可能不在，所以取不到就退化成「没有这张表」。
   * **只依赖 core/loan.js** —— 拼读判据全在本文件里，不再伸手去拿 core/reading.js。
   */
  function dep(name) {
    return root && root[name] ? root[name] : null;
  }

  // ------------------------------------------------------------ 小工具

  /** 小写（变音符号留着 —— 拼读要看它） */
  function lower(s) {
    return String(s == null ? "" : s).toLowerCase();
  }

  /**
   * 查表/拼读用：小写 + 去掉撇号/连字符/空白。
   * 注意 **ASCII 连字符也要去掉**（rendez-vous→rendezvous、Auf-Wiedersehen→
   * aufwiedersehen）：借词表的键都是折掉的写法，法语那张表里
   * rendez-vous / l'eau 这类词全靠这一条才查得到。
   */
  function bare(s) {
    return lower(s)
      .replace(/['\u2019\u2011\u2013\u2014\u30FB.\uFF0E-]/g, "")
      .replace(/\s+/g, "");
  }

  /** 折成 ASCII（借词表的键都是 ASCII：ä→a、ç→c、ß→ss） */
  var FOLD = {
    "\u00E0": "a", "\u00E1": "a", "\u00E2": "a", "\u00E3": "a", "\u00E4": "a", "\u00E5": "a", "\u0101": "a", "\u0105": "a",
    "\u00E7": "c", "\u0107": "c", "\u010D": "c",
    "\u00E8": "e", "\u00E9": "e", "\u00EA": "e", "\u00EB": "e", "\u0113": "e", "\u0119": "e", "\u011B": "e",
    "\u00EC": "i", "\u00ED": "i", "\u00EE": "i", "\u00EF": "i", "\u012B": "i",
    "\u00F1": "n", "\u0144": "n",
    "\u00F2": "o", "\u00F3": "o", "\u00F4": "o", "\u00F5": "o", "\u00F6": "o", "\u00F8": "o", "\u014D": "o", "\u0151": "o",
    "\u00F9": "u", "\u00FA": "u", "\u00FB": "u", "\u00FC": "u", "\u016B": "u", "\u016F": "u", "\u0171": "u",
    "\u00FD": "y", "\u00FF": "y",
    "\u00DF": "ss", "\u00E6": "ae", "\u0153": "oe",
    // 希腊语的调号（ά έ ή ί ό ύ ώ …）折成基字母
    "\u03AC": "\u03B1", "\u03AD": "\u03B5", "\u03AE": "\u03B7", "\u03AF": "\u03B9", "\u03CC": "\u03BF", "\u03CD": "\u03C5", "\u03CE": "\u03C9",
    "\u03CA": "\u03B9", "\u03CB": "\u03C5", "\u0390": "\u03B9", "\u03B0": "\u03C5",
  };

  function foldAscii(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      out += FOLD[ch] !== undefined ? FOLD[ch] : ch;
    }
    return out;
  }

  /** 五行表：五个元音列（a i u e o）各给一个假名 */
  function row5(a, i, u, e, o) {
    return { a: a, i: i, u: u, e: e, o: o };
  }

  function pick(row, v) {
    return row[v] || row.a;
  }

  function vowelIdx(v) {
    return "aiueo".indexOf(v);
  }

  /** 词尾加长音符；已经有 ー 就不重复加 */
  function lengthen(kana) {
    return kana && kana.charAt(kana.length - 1) === "\u30FC" ? kana : kana + "\u30FC";
  }

  // ============================================================ 德语
  //
  // 目标读法（德→日，按用户给的测试用例逐个调过）：
  //   die ディー / ist イスト / ich イッヒ / schön シェーン / Zeit ツァイト /
  //   Tränen トレーネン / Wind ヴィント / und ウント / Lied リート / Tag ターク
  //
  // 德语拼写的规矩（和英语完全不同，所以必须单独一套）：
  //   w -> ヴ  z -> ツ  v -> フ  s+元音 -> ザ行  sch -> シュ  ch -> ッハ/ッヒ
  //   ei/ai -> アイ  eu/äu -> オイ  au -> アウ  ie -> イー
  //   长短音：元音 + 单个辅音 + 元音 就是长音（Name ナー、Regentropfen レーゲン…）
  //   双辅音只表示"前面的元音短"，不读促音（kommen コメン、immer イマー）

  var DE_ROW = {
    b: row5("\u30D0", "\u30D3", "\u30D6", "\u30D9", "\u30DC"),
    c: row5("\u30AB", "\u30C4\u30A3", "\u30AF", "\u30C4\u30A7", "\u30B3"),
    d: row5("\u30C0", "\u30C7\u30A3", "\u30C9\u30A5", "\u30C7", "\u30C9"),
    f: row5("\u30D5\u30A1", "\u30D5\u30A3", "\u30D5", "\u30D5\u30A7", "\u30D5\u30A9"),
    g: row5("\u30AC", "\u30AE", "\u30B0", "\u30B2", "\u30B4"),
    h: row5("\u30CF", "\u30D2", "\u30D5", "\u30D8", "\u30DB"),
    j: row5("\u30E4", "\u30A4", "\u30E6", "\u30A4\u30A7", "\u30E8"),
    k: row5("\u30AB", "\u30AD", "\u30AF", "\u30B1", "\u30B3"),
    l: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    m: row5("\u30DE", "\u30DF", "\u30E0", "\u30E1", "\u30E2"),
    n: row5("\u30CA", "\u30CB", "\u30CC", "\u30CD", "\u30CE"),
    p: row5("\u30D1", "\u30D4", "\u30D7", "\u30DA", "\u30DD"),
    r: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    s: row5("\u30B6", "\u30BA\u30A3", "\u30BA", "\u30BC", "\u30BE"),
    t: row5("\u30BF", "\u30C6\u30A3", "\u30C8\u30A5", "\u30C6", "\u30C8"),
    v: row5("\u30D5\u30A1", "\u30D5\u30A3", "\u30D5", "\u30D5\u30A7", "\u30D5\u30A9"),
    w: row5("\u30F4\u30A1", "\u30F4\u30A3", "\u30F4", "\u30F4\u30A7", "\u30F4\u30A9"),
    x: row5("\u30AF\u30B5", "\u30AF\u30B7", "\u30AF\u30B9", "\u30AF\u30BB", "\u30AF\u30BD"),
    z: row5("\u30C4\u30A1", "\u30C4\u30A3", "\u30C4", "\u30C4\u30A7", "\u30C4\u30A9"),
  };

  /** 德语 ü 那一列（ヒュ / キュ / リュ …） */
  var DE_U = {
    b: "\u30D3\u30E5", c: "\u30AD\u30E5", d: "\u30C7\u30E5", f: "\u30D5\u30E5", g: "\u30AE\u30E5",
    h: "\u30D2\u30E5", j: "\u30E6", k: "\u30AD\u30E5", l: "\u30EA\u30E5", m: "\u30DF\u30E5",
    n: "\u30CB\u30E5", p: "\u30D4\u30E5", r: "\u30EA\u30E5", s: "\u30B7\u30E5", t: "\u30C6\u30E5",
    v: "\u30D5\u30E5", w: "\u30F4\u30E5", x: "\u30AF\u30B7\u30E5", z: "\u30C4\u30E5",
  };

  /** 词尾单辅音 */
  var DE_FINAL = {
    b: "\u30D7", c: "\u30AF", d: "\u30C8", f: "\u30D5", g: "\u30AF", h: "", k: "\u30AF", l: "\u30EB",
    m: "\u30E0", n: "\u30F3", p: "\u30D7", r: "\u30A2", s: "\u30B9", t: "\u30C8", v: "\u30D5",
    w: "\u30D5", x: "\u30AF\u30B9", z: "\u30C4",
  };

  /** 词中/词尾辅音连缀里的单辅音 */
  var DE_CLUSTER = {
    b: "\u30D6", c: "\u30AF", d: "\u30C9", f: "\u30D5", g: "\u30B0", h: "\u30D5", k: "\u30AF",
    l: "\u30EB", m: "\u30E0", n: "\u30F3", p: "\u30D7", r: "\u30EB", s: "\u30B9", t: "\u30C8",
    v: "\u30D5", w: "\u30F4", x: "\u30AF\u30B9", z: "\u30C4",
  };

  var DE_VOWEL = {
    a: "\u30A2", e: "\u30A8", i: "\u30A4", o: "\u30AA", u: "\u30A6",
    "\u00E4": "\u30A8", "\u00F6": "\u30A8", "\u00FC": "\u30E6", y: "\u30A4",
  };

  function deIsVowel(ch) {
    return ch !== "" && "aeiou\u00E4\u00F6\u00FCy".indexOf(ch) >= 0;
  }

  /**
   * 从 pos 起的元音单元（含双元音/长音标记）。
   * 返回 { col, kana, len, long, glide }；col 是"拼到辅音哪一列"，glide 是滑音假名。
   */
  function deUnit(w, pos) {
    var two = w.substr(pos, 2);
    var c = w.charAt(pos);
    if (two === "ei" || two === "ai" || two === "ey" || two === "ay") return { col: "a", kana: "\u30A2\u30A4", len: 2, glide: "\u30A4" };
    if (two === "eu" || two === "\u00E4u") return { col: "o", kana: "\u30AA\u30A4", len: 2, glide: "\u30A4" };
    if (two === "au") return { col: "a", kana: "\u30A2\u30A6", len: 2, glide: "\u30A6" };
    if (two === "ie") return { col: "i", kana: "\u30A4\u30FC", len: 2, long: true };
    if (two === "aa") return { col: "a", kana: "\u30A2\u30FC", len: 2, long: true };
    if (two === "ee") return { col: "e", kana: "\u30A8\u30FC", len: 2, long: true };
    if (two === "oo") return { col: "o", kana: "\u30AA\u30FC", len: 2, long: true };
    if (!deIsVowel(c)) return null;
    var col = c === "\u00FC" || c === "y" ? "u" : c === "\u00E4" || c === "\u00F6" ? "e" : c;
    var unit = { col: col, kana: DE_VOWEL[c], len: 1, long: false, umlaut: c === "\u00FC" || c === "y" };
    var n1 = w.charAt(pos + 1);
    var n2 = w.charAt(pos + 2);
    if (n1 === "h" && n2 !== "" && !deIsVowel(n2)) {
      unit.long = true;
      unit.len = 2;
    } else if ("\u00E4\u00F6\u00FC".indexOf(c) >= 0 && n1 !== "r" && n2 === "") {
      unit.long = true; // schön シェーン（ü/ö/ä + 单辅音收尾）
    } else if (n2 !== "" && n1 !== "r" && !deIsVowel(n1) && deIsVowel(n2)) {
      unit.long = true; // Name ナー、Regentropfen レーゲン
    }
    return unit;
  }

  /** 辅音 + 元音单元，拼成一拍 */
  function deCV(c, unit) {
    var body;
    if (unit.umlaut && DE_U[c]) body = DE_U[c];
    else if (!DE_ROW[c]) return null;
    else body = pick(DE_ROW[c], unit.col);
    if (!body) return null;
    if (unit.glide) return body + unit.glide + (unit.long ? "\u30FC" : "");
    return unit.long ? lengthen(body) : body;
  }

  /** 德语词 -> 片假名（近似）。读不出来返回 null。 */
  function germanToKatakana(raw) {
    var w = bare(raw);
    if (!w || !/^[a-z\u00E4\u00F6\u00FC\u00DF]+$/.test(w)) return null;
    var len = w.length;
    var out = "";
    var i = 0;
    while (i < len) {
      var rest = len - i;
      var c = w.charAt(i);
      var two = w.substr(i, 2);
      var three = w.substr(i, 3);
      var four = w.substr(i, 4);

      // ---- 词首前缀 / 词首 sp- st-
      if (i === 0) {
        if (three === "ver") { out += "\u30D5\u30A7\u30A2"; i += 3; continue; }
        if (three === "zer") { out += "\u30C4\u30A7\u30A2"; i += 3; continue; }
        if (two === "er" && len > 3) { out += "\u30A8\u30A2"; i += 2; continue; }
        if (two === "sp") { out += "\u30B7\u30E5\u30D7"; i += 2; continue; }
        if (two === "st") { out += "\u30B7\u30E5\u30C8"; i += 2; continue; }
        // ge- 前缀读短的 ゲ（gegeben ゲゲーベン）
        if (two === "ge" && len > 3) { out += "\u30B2"; i += 2; continue; }
      }

      // ---- 词尾「辅音 + er」：immer イマー、Körper ケルパー（那个 e 是含糊音）
      // 必须 i > 0：否则 `der` / `mir` 这种"整个词就是 C+er"的会被吃掉词首辅音
      if (i > 0 && rest === 3 && w.charAt(i + 1) === "e" && w.charAt(i + 2) === "r" && !deIsVowel(c) && c !== "r" && DE_ROW[c]) {
        out += pick(DE_ROW[c], "a") + "\u30FC";
        i += 3;
        continue;
      }

      // ---- 辅音组合
      if (four === "tsch") { out += "\u30C1\u30E5"; i += 4; continue; }
      if (three === "sch") {
        var sv = w.charAt(i + 3);
        if (deIsVowel(sv)) {
          var su = deUnit(w, i + 3);
          out += su.col === "e" ? "\u30B7\u30A7" : su.col === "i" ? "\u30B7" : su.col === "o" ? "\u30B7\u30E7" : su.col === "a" ? "\u30B7\u30E3" : "\u30B7\u30E5";
          if (su.long) out += "\u30FC";
          i += 3 + su.len;
          continue;
        }
        out += "\u30B7\u30E5";
        i += 3;
        continue;
      }
      if (three === "chs") { out += "\u30AF\u30B9"; i += 3; continue; }
      if (two === "ch") {
        var prev = i > 0 ? w.charAt(i - 1) : "";
        out += "a\u00E4".indexOf(prev) >= 0 ? "\u30C3\u30CF" : "o\u00F6".indexOf(prev) >= 0 ? "\u30C3\u30DB" : "u\u00FC".indexOf(prev) >= 0 ? "\u30C3\u30D5" : "\u30C3\u30D2";
        i += 2;
        continue;
      }
      if (two === "ck") { out += "\u30C3\u30AF"; i += 2; continue; }
      if (two === "ph") { out += "\u30D5"; i += 2; continue; }
      if (two === "th") { out += "\u30C8"; i += 2; continue; }
      if (two === "pf") {
        // pf 是一个音：后面跟元音时读 プ + ファ行（Pferd プフェルト、tropfen トロプフェン）
        var pu = deUnit(w, i + 2);
        if (pu) {
          out += "\u30D7" + pick(DE_ROW.f, pu.col) + (pu.long ? "\u30FC" : "");
          i += 2 + pu.len;
          continue;
        }
        out += "\u30D7\u30D5";
        i += 2;
        continue;
      }
      if (two === "qu") { out += "\u30AF\u30F4"; i += 2; continue; }
      if (two === "tz" || two === "ts") { out += "\u30C4"; i += 2; continue; }
      if (two === "dt") { out += "\u30C8"; i += 2; continue; }
      // ng / nk 只在**不是**元音前才是 ング / ンク（lange ランゲ、singen ズィンゲン）
      if (two === "ng" && !deIsVowel(w.charAt(i + 2))) { out += "\u30F3\u30B0"; i += 2; continue; }
      if (two === "nk" && !deIsVowel(w.charAt(i + 2))) { out += "\u30F3\u30AF"; i += 2; continue; }
      if (c === "\u00DF") { out += "\u30B9"; i += 1; continue; }
      // 双辅音只是"前面元音短"，只读一次
      if (c === w.charAt(i + 1) && "bdflmnprstz".indexOf(c) >= 0) { i += 1; continue; }

      // ---- 元音开头
      var unit = deUnit(w, i);
      if (unit) {
        out += unit.long ? lengthen(unit.kana) : unit.kana;
        i += unit.len;
        continue;
      }

      // ---- 词尾两字母
      if (rest === 2 && (two === "en" || two === "el" || two === "er")) {
        out += two === "en" ? "\u30F3" : two === "el" ? "\u30EB" : "\u30A2";
        i += 2;
        continue;
      }

      // ---- 辅音 + 元音
      if (DE_ROW[c]) {
        var u2 = deUnit(w, i + 1);
        if (u2) {
          out += deCV(c, u2);
          i += 1 + u2.len;
          continue;
        }
      }

      // ---- 单个辅音（词尾 / 连缀）
      if (rest === 1 && DE_FINAL[c] !== undefined) { out += DE_FINAL[c]; i += 1; continue; }
      if (DE_CLUSTER[c] !== undefined) { out += DE_CLUSTER[c]; i += 1; continue; }
      i += 1;
    }
    return out ? { kana: out, confident: false } : null;
  }

  // ============================================================ 拉丁语
  //
  // 用的是**古典式**读法（日语里的拉丁语惯例：Caesar カエサル、Cicero キケロ），
  // 而不是教会式 —— 用户截图里的参考答案就是古典式：
  //   Vindicia ヴィンディキア / Vanitatum ヴァニタトゥム / sentio センティオ /
  //   dolor ドロル / dolores ドロレス
  // 所以：c 一律 カ行、g 一律 ガ行、ti 读 ティ、v 读 ヴ、ae/oe 读 アエ/オエ。

  var LA_ROW = {
    b: row5("\u30D0", "\u30D3", "\u30D6", "\u30D9", "\u30DC"),
    c: row5("\u30AB", "\u30AD", "\u30AF", "\u30B1", "\u30B3"),
    d: row5("\u30C0", "\u30C7\u30A3", "\u30C9\u30A5", "\u30C7", "\u30C9"),
    f: row5("\u30D5\u30A1", "\u30D5\u30A3", "\u30D5", "\u30D5\u30A7", "\u30D5\u30A9"),
    g: row5("\u30AC", "\u30AE", "\u30B0", "\u30B2", "\u30B4"),
    h: row5("\u30CF", "\u30D2", "\u30D5", "\u30D8", "\u30DB"),
    j: row5("\u30E4", "\u30A4", "\u30E6", "\u30A4\u30A7", "\u30E8"),
    k: row5("\u30AB", "\u30AD", "\u30AF", "\u30B1", "\u30B3"),
    l: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    m: row5("\u30DE", "\u30DF", "\u30E0", "\u30E1", "\u30E2"),
    n: row5("\u30CA", "\u30CB", "\u30CC", "\u30CD", "\u30CE"),
    p: row5("\u30D1", "\u30D4", "\u30D7", "\u30DA", "\u30DD"),
    q: row5("\u30AF\u30A2", "\u30AF\u30A4", "\u30AF", "\u30AF\u30A7", "\u30AF\u30AA"),
    r: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    s: row5("\u30B5", "\u30B7", "\u30B9", "\u30BB", "\u30BD"),
    t: row5("\u30BF", "\u30C6\u30A3", "\u30C8\u30A5", "\u30C6", "\u30C8"),
    v: row5("\u30F4\u30A1", "\u30F4\u30A3", "\u30F4", "\u30F4\u30A7", "\u30F4\u30A9"),
    x: row5("\u30AF\u30B5", "\u30AF\u30B7", "\u30AF\u30B9", "\u30AF\u30BB", "\u30AF\u30BD"),
    y: row5("\u30E4", "\u30A4", "\u30E6", "\u30A4\u30A7", "\u30E8"),
    z: row5("\u30B6", "\u30BA\u30A3", "\u30BA", "\u30BC", "\u30BE"),
  };

  var LA_VOWEL = { a: "\u30A2", e: "\u30A8", i: "\u30A4", o: "\u30AA", u: "\u30A6", y: "\u30A4" };

  var LA_FINAL = {
    b: "\u30D6", c: "\u30AF", d: "\u30C8", f: "\u30D5", g: "\u30AF", h: "", k: "\u30AF", l: "\u30EB",
    m: "\u30E0", n: "\u30F3", p: "\u30D7", r: "\u30EB", s: "\u30B9", t: "\u30C8", x: "\u30AF\u30B9", z: "\u30C4",
  };
  /** 辅音连缀里的单辅音（词尾用 LA_FINAL，中间用这张表） */
  var LA_CLUSTER = {
    b: "\u30D6", c: "\u30AF", d: "\u30C9", f: "\u30D5", g: "\u30B0", h: "\u30D5", k: "\u30AF", l: "\u30EB",
    m: "\u30E0", n: "\u30F3", p: "\u30D7", r: "\u30EB", s: "\u30B9", t: "\u30C8", x: "\u30AF\u30B9", z: "\u30C4",
  };

  function laIsVowel(ch) {
    return ch !== "" && "aeiouy\u0101\u0113\u012B\u014D\u016B".indexOf(ch) >= 0;
  }

  /** 拉丁语词 -> 片假名（古典式近似） */
  function latinToKatakana(raw) {
    var w = bare(raw);
    if (!w || !/^[a-z\u00E0-\u00FF\u0101\u0113\u012B\u014D\u016B\u0153\u00E6]+$/.test(w)) return null;
    var len = w.length;
    var out = "";
    var i = 0;
    while (i < len) {
      var rest = len - i;
      var c = w.charAt(i);
      var two = w.substr(i, 2);
      var three = w.substr(i, 3);

      // 双辅音：mm/nn 读 ン，其余读促音（bellum ベッルム、flamma フランマ）
      if (c === w.charAt(i + 1) && "bcdfglmnprst".indexOf(c) >= 0) {
        out += c === "m" || c === "n" ? "\u30F3" : "\u30C3";
        i += 1;
        continue;
      }
      // 长音符（ā ē ī ō ū）直接读长音；ae / oe / au / eu 是双元音
      if ("\u0101\u0113\u012B\u014D\u016B".indexOf(c) >= 0) {
        out += LA_VOWEL[c.charAt(0)] + "\u30FC";
        i += 1;
        continue;
      }
      if (two === "ae" || two === "\u00E6") { out += "\u30A2\u30A8"; i += 2; continue; }
      if (two === "oe" || two === "\u0153") { out += "\u30AA\u30A8"; i += 2; continue; }
      if (two === "au") { out += "\u30A2\u30A6"; i += 2; continue; }
      if (two === "eu") { out += "\u30A8\u30A6"; i += 2; continue; }
      if (two === "ei") { out += "\u30A8\u30A4"; i += 2; continue; }
      if (two === "qu") { out += "\u30AF"; i += 2; continue; }
      if (two === "gu" && laIsVowel(w.charAt(i + 2))) { out += "\u30B0"; i += 2; continue; }
      if (three === "sch") { out += "\u30B9\u30AF"; i += 3; continue; }
      if (two === "ch") { out += "\u30AF"; i += 2; continue; }
      if (two === "ph") { out += "\u30D5"; i += 2; continue; }
      if (two === "th") { out += "\u30C8"; i += 2; continue; }
      if (two === "rh") { out += "\u30EB"; i += 2; continue; }
      // gn 读 グ + ニ（gnari グナリ、igni イグニ）—— n 不吞掉，让它自己去拼下一拍
      if (two === "gn") { out += "\u30B0"; i += 1; continue; }
      if (two === "ah") { out += "\u30A2\u30FC"; i += 2; continue; }
      if (two === "oh") { out += "\u30AA\u30FC"; i += 2; continue; }
      if (laIsVowel(c)) {
        out += LA_VOWEL[c];
        i += 1;
        continue;
      }
      var u = w.charAt(i + 1);
      if (LA_ROW[c] && laIsVowel(u)) {
        out += pick(LA_ROW[c], u === "y" ? "i" : u);
        i += 2;
        continue;
      }
      if (LA_ROW[c] && (u === "h" || u === "")) {
        // 词尾 / h 前
        if (u === "" && LA_FINAL[c] !== undefined) { out += LA_FINAL[c]; i += 1; continue; }
        if (u === "h") { out += LA_ROW[c].u; i += 1; continue; }
      }
      if (rest === 1 && LA_FINAL[c] !== undefined) { out += LA_FINAL[c]; i += 1; continue; }
      if (LA_CLUSTER[c] !== undefined) { out += LA_CLUSTER[c]; i += 1; continue; }
      if (LA_ROW[c]) { out += LA_ROW[c].u; i += 1; continue; }
      i += 1;
    }
    return out ? { kana: out, confident: false } : null;
  }

  // ============================================================ 葡萄牙语
  //
  // 鼻元音是葡语的门面：ão アン、õe オン、nh ニュ、lh リ、ch シュ、
  // 词首 r ハ行（巴西式），c+e/i ス、g+e/i ジ、x シ。

  var PT_ROW = {
    b: row5("\u30D0", "\u30D3", "\u30D6", "\u30D9", "\u30DC"),
    c: row5("\u30AB", "\u30B7", "\u30AF", "\u30BB", "\u30B3"),
    "\u00E7": row5("\u30B5", "\u30B7", "\u30B9", "\u30BB", "\u30BD"),
    d: row5("\u30C0", "\u30B8", "\u30C9\u30A5", "\u30C7", "\u30C9"),
    f: row5("\u30D5\u30A1", "\u30D5\u30A3", "\u30D5", "\u30D5\u30A7", "\u30D5\u30A9"),
    g: row5("\u30AC", "\u30B8", "\u30B0", "\u30B8\u30A7", "\u30B4"),
    j: row5("\u30B8\u30E3", "\u30B8", "\u30B8\u30E5", "\u30B8\u30A7", "\u30B8\u30E7"),
    k: row5("\u30AB", "\u30AD", "\u30AF", "\u30B1", "\u30B3"),
    l: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    m: row5("\u30DE", "\u30DF", "\u30E0", "\u30E1", "\u30E2"),
    n: row5("\u30CA", "\u30CB", "\u30CC", "\u30CD", "\u30CE"),
    p: row5("\u30D1", "\u30D4", "\u30D7", "\u30DA", "\u30DD"),
    r: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    s: row5("\u30B5", "\u30B7", "\u30B9", "\u30BB", "\u30BD"),
    t: row5("\u30BF", "\u30C1", "\u30C8\u30A5", "\u30C6", "\u30C8"),
    v: row5("\u30F4\u30A1", "\u30F4\u30A3", "\u30F4", "\u30F4\u30A7", "\u30F4\u30A9"),
    x: row5("\u30B7\u30E3", "\u30B7", "\u30B7\u30E5", "\u30B7\u30A7", "\u30B7\u30E7"),
    z: row5("\u30B6", "\u30B8", "\u30BA", "\u30BC", "\u30BE"),
  };

  var PT_VOWEL = { a: "\u30A2", e: "\u30A8", i: "\u30A4", o: "\u30AA", u: "\u30A6" };
  /** 带调/带鼻音符的元音：á é ê í ó ô ú ã õ à */
  var PT_ACCENT = {
    "\u00E1": "a", "\u00E0": "a", "\u00E2": "a", "\u00E3": "a",
    "\u00E9": "e", "\u00EA": "e", "\u00ED": "i", "\u00F3": "o", "\u00F4": "o", "\u00F5": "o", "\u00FA": "u",
  };

  function ptBase(ch) {
    return PT_ACCENT[ch] || ch;
  }

  function ptIsVowel(ch) {
    return ch !== "" && "aeiou".indexOf(ptBase(ch)) >= 0;
  }

  function portugueseToKatakana(raw) {
    var w = bare(raw);
    if (!w || !/^[a-z\u00E0-\u00FF]+$/.test(w)) return null;
    var len = w.length;
    var out = "";
    var i = 0;
    while (i < len) {
      var rest = len - i;
      var c = w.charAt(i);
      var two = w.substr(i, 2);
      var three = w.substr(i, 3);

      // 鼻元音（包括 ão / õe 这两个典型词尾）：辅音 + ão 合成 サン / タン（coração コラサン）
      if (three === "\u00E3es") { out += "\u30A2\u30F3\u30B9"; i += 4; continue; }
      if (two === "\u00E3o" || two === "\u00E3e") {
        if (PT_ROW[c]) { out += pick(PT_ROW[c], "a") + "\u30F3"; i += 3; continue; }
        out += "\u30A2\u30F3";
        i += 2;
        continue;
      }
      if (two === "\u00F5e") {
        if (PT_ROW[c]) { out += pick(PT_ROW[c], "o") + "\u30F3"; i += 3; continue; }
        out += "\u30AA\u30F3";
        i += 2;
        continue;
      }
      if (ptBase(c) !== c && ptBase(c) !== "a" && ptBase(c) !== "o") {
        // 重音符号本身不改变读音（葡语的调号只标重音）
        out += PT_VOWEL[ptBase(c)];
        i += 1;
        continue;
      }
      if (c === "\u00E3" || c === "\u00F5") {
        var nasal = c === "\u00E3" ? "\u30A2\u30F3" : "\u30AA\u30F3";
        // 后面还有元音时那个鼻化元音要分开读（maçã マサン 但 ãe 已经在上面处理）
        out += nasal;
        i += 1;
        continue;
      }
      // 二合字母（nh / lh 后面跟元音时读 ニャ行 / リャ行：minha ミニャ、filho フィーリョ）
      if (two === "nh" || two === "lh") {
        var nlv = ptBase(w.charAt(i + 2));
        var nrow = two === "nh" ? PT_ROW.n : PT_ROW.l;
        if ("aeiou".indexOf(nlv) >= 0) {
          // 颚化那一拍用**イ段**假名做底 + 小元音（nh+a ニャ、lh+o リョ）
          var pal = pick(nrow, "i");
          out += nlv === "a" ? pal + "\u30E3" : nlv === "o" ? pal + "\u30E7" : nlv === "u" ? pal + "\u30E5" : pick(nrow, nlv);
          i += 3;
          continue;
        }
        out += two === "nh" ? "\u30CB\u30E5" : "\u30EA";
        i += 2;
        continue;
      }
      if (two === "ch") { out += "\u30B7\u30E5"; i += 2; continue; }
      if (two === "ss") { out += "\u30B9"; i += 2; continue; }
      if (two === "qu") { out += "\u30AF"; i += 2; continue; }
      if (two === "gu" && "ei".indexOf(w.charAt(i + 2)) >= 0) { out += "\u30B0"; i += 2; continue; }
      if (two === "\u00E7") { i += 1; continue; }
      // 元音组合
      if (two === "ou" || two === "oi") { out += "\u30AA\u30A6"; i += 2; continue; }
      if (two === "ai") { out += "\u30A2\u30A4"; i += 2; continue; }
      if (two === "ei") { out += "\u30A8\u30A4"; i += 2; continue; }
      if (two === "ao") { out += "\u30A2\u30AA"; i += 2; continue; }
      if (two === "eu") { out += "\u30A8\u30A6"; i += 2; continue; }
      if (two === "iu") { out += "\u30A4\u30A6"; i += 2; continue; }
      // h 不发音
      if (c === "h") { i += 1; continue; }
      // 词尾
      if (rest === 1) {
        if (c === "o" || c === "e") { out += "\u30A6"; i += 1; continue; }
        if ("sz".indexOf(c) >= 0) { out += "\u30B9"; i += 1; continue; }
        if ("mn".indexOf(c) >= 0) { out += "\u30F3"; i += 1; continue; }
        if ("lr".indexOf(c) >= 0) { out += "\u30EB"; i += 1; continue; }
        if (c === "m") { out += "\u30F3"; i += 1; continue; }
      }
      // 辅音 + ão / õe：合成一拍（coração コラサン、põe ポン）
      if (PT_ROW[c] && w.charAt(i + 1) === "\u00E3" && w.charAt(i + 2) === "o") {
        out += pick(PT_ROW[c], "a") + "\u30F3";
        i += 3;
        continue;
      }
      if (PT_ROW[c] && w.charAt(i + 1) === "\u00F5" && w.charAt(i + 2) === "e") {
        out += pick(PT_ROW[c], "o") + "\u30F3";
        i += 3;
        continue;
      }
      // 辅音 + 元音
      var u = ptBase(w.charAt(i + 1));
      if (PT_ROW[c] && ptIsVowel(w.charAt(i + 1))) {
        out += pick(PT_ROW[c], u);
        i += 2;
        continue;
      }
      if (ptIsVowel(c)) {
        out += PT_VOWEL[ptBase(c)];
        i += 1;
        continue;
      }
      if (PT_ROW[c]) { out += pick(PT_ROW[c], "u"); i += 1; continue; }
      if (c === "s") { out += "\u30B9"; i += 1; continue; }
      i += 1;
    }
    return out ? { kana: out, confident: false } : null;
  }

  // ============================================================ 荷兰语
  //
  // ij/ei アイ、oe ウ、ui アウ、eu ウ、g/ch ハ行（荷兰语的 g 是喉音）、
  // 长元音写在拼写里（aa/ee/oo/uu -> ー）。

  var NL_ROW = {
    b: row5("\u30D0", "\u30D3", "\u30D6", "\u30D9", "\u30DC"),
    c: row5("\u30AB", "\u30B7", "\u30AF", "\u30BB", "\u30B3"),
    d: row5("\u30C0", "\u30C7\u30A3", "\u30C9\u30A5", "\u30C7", "\u30C9"),
    f: row5("\u30D5\u30A1", "\u30D5\u30A3", "\u30D5", "\u30D5\u30A7", "\u30D5\u30A9"),
    g: row5("\u30CF", "\u30D2", "\u30D5", "\u30D8", "\u30DB"),
    h: row5("\u30CF", "\u30D2", "\u30D5", "\u30D8", "\u30DB"),
    j: row5("\u30E4", "\u30A4", "\u30E6", "\u30A4\u30A7", "\u30E8"),
    k: row5("\u30AB", "\u30AD", "\u30AF", "\u30B1", "\u30B3"),
    l: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    m: row5("\u30DE", "\u30DF", "\u30E0", "\u30E1", "\u30E2"),
    n: row5("\u30CA", "\u30CB", "\u30CC", "\u30CD", "\u30CE"),
    p: row5("\u30D1", "\u30D4", "\u30D7", "\u30DA", "\u30DD"),
    r: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    s: row5("\u30B5", "\u30B7", "\u30B9", "\u30BB", "\u30BD"),
    t: row5("\u30BF", "\u30C6\u30A3", "\u30C8\u30A5", "\u30C6", "\u30C8"),
    v: row5("\u30F4\u30A1", "\u30F4\u30A3", "\u30F4", "\u30F4\u30A7", "\u30F4\u30A9"),
    w: row5("\u30EF", "\u30A6\u30A3", "\u30A6", "\u30A6\u30A7", "\u30A6\u30A9"),
    z: row5("\u30B6", "\u30B8", "\u30BA", "\u30BC", "\u30BE"),
  };

  var NL_VOWEL = { a: "\u30A2", e: "\u30A8", i: "\u30A4", o: "\u30AA", u: "\u30A6", y: "\u30A4" };

  function nlIsVowel(ch) {
    return ch !== "" && "aeiouy\u00E9\u00E8\u00EA\u00EB\u00EF\u00F6\u00FC".indexOf(ch) >= 0;
  }

  /**
   * 荷兰语的元音单元（含拼写里的长元音与双元音）。
   * 和德语一样要能"拼进辅音那一拍"：ij アイ（tijd タイト）、oe ウー（goed フート）、
   * ui アウ（huis ハウス）、ie イー（lied リート）。
   */
  function nlUnit(w, pos) {
    var three = w.substr(pos, 3);
    var two = w.substr(pos, 2);
    var c = w.charAt(pos);
    if (three === "eeuw") return { col: "e", kana: "\u30A8\u30FC\u30A6", len: 4 };
    if (three === "aai") return { col: "a", kana: "\u30A2\u30FC\u30A4", len: 3, glide: "\u30FC\u30A4" };
    if (three === "ooi") return { col: "o", kana: "\u30AA\u30FC\u30A4", len: 3, glide: "\u30FC\u30A4" };
    if (three === "oei") return { col: "u", kana: "\u30A6\u30A4", len: 3, glide: "\u30A4" };
    if (two === "ij" || two === "ei") return { col: "a", kana: "\u30A2\u30A4", len: 2, glide: "\u30A4" };
    if (two === "oe") return { col: "u", kana: "\u30A6", len: 2, long: true };
    if (two === "ui") return { col: "a", kana: "\u30A2\u30A6", len: 2, glide: "\u30A6" };
    if (two === "ou" || two === "au") return { col: "a", kana: "\u30A2\u30A6", len: 2, glide: "\u30A6" };
    if (two === "eu") return { col: "u", kana: "\u30A6", len: 2, long: true };
    if (two === "ie") return { col: "i", kana: "\u30A4\u30FC", len: 2, long: true };
    if (two === "aa") return { col: "a", kana: "\u30A2\u30FC", len: 2, long: true };
    if (two === "ee") return { col: "e", kana: "\u30A8\u30FC", len: 2, long: true };
    if (two === "oo") return { col: "o", kana: "\u30AA\u30FC", len: 2, long: true };
    if (two === "uu") return { col: "u", kana: "\u30A6\u30FC", len: 2, long: true };
    if (!nlIsVowel(c)) return null;
    var col = c === "y" ? "i" : c === "\u00E9" || c === "\u00E8" || c === "\u00EA" || c === "\u00EB" ? "e" : "\u00EF" === c ? "i" : "\u00F6" === c ? "e" : "\u00FC" === c ? "u" : c;
    return { col: col, kana: NL_VOWEL[col] || "\u30A4", len: 1 };
  }

  function dutchToKatakana(raw) {
    var w = bare(raw);
    if (!w || !/^[a-z\u00E0-\u00FF]+$/.test(w)) return null;
    var len = w.length;
    var out = "";
    var i = 0;
    while (i < len) {
      var rest = len - i;
      var c = w.charAt(i);
      var two = w.substr(i, 2);
      var three = w.substr(i, 3);

      // 辅音组合
      if (three === "sch") { out += "\u30B9\u30CF"; i += 3; continue; }
      if (two === "ch" || two === "gg") { out += "\u30CF"; i += 2; continue; }
      if (two === "sj") { out += "\u30B7"; i += 2; continue; }
      if (two === "tj") { out += "\u30C1"; i += 2; continue; }
      if (two === "th") { out += "\u30C8"; i += 2; continue; }
      if (two === "ph") { out += "\u30D5"; i += 2; continue; }
      if (two === "qu") { out += "\u30AF"; i += 2; continue; }
      // 词尾 -en 读 ン（lopen ローペン）
      if (rest === 2 && two === "en") { out += "\u30F3"; i += 2; continue; }
      // 元音开头：整个单元自己成拍
      var unit = nlUnit(w, i);
      if (unit) {
        out += unit.kana;
        i += unit.len;
        continue;
      }
      // 辅音 + 元音单元
      var u = nlUnit(w, i + 1);
      if (u && NL_ROW[c]) {
        out += pick(NL_ROW[c], u.col) + (u.glide || "") + (u.long ? "\u30FC" : "");
        i += 1 + u.len;
        continue;
      }
      // 词尾单字母
      if (rest === 1) {
        if (c === "e") { out += "\u30A8"; i += 1; continue; }
        if ("tdb".indexOf(c) >= 0) { out += "\u30C8"; i += 1; continue; }
        if (c === "n" || c === "m") { out += "\u30F3"; i += 1; continue; }
        if (c === "s" || c === "z") { out += "\u30B9"; i += 1; continue; }
        if (c === "l" || c === "r") { out += "\u30EB"; i += 1; continue; }
        if (c === "g" || c === "h") { out += "\u30CF"; i += 1; continue; }
        if (c === "f" || c === "v") { out += "\u30D5"; i += 1; continue; }
        if (c === "k") { out += "\u30AF"; i += 1; continue; }
        if (c === "p") { out += "\u30D7"; i += 1; continue; }
      }
      if (NL_ROW[c]) { out += pick(NL_ROW[c], "u"); i += 1; continue; }
      i += 1;
    }
    return out ? { kana: out, confident: false } : null;
  }

  // ============================================================ 斯瓦希里语
  //
  // 斯瓦希里语是**开音节**语言（音节几乎全是 辅音+元音），这一点和日语一样，
  // 所以按音节直接拼就八九不离十：Shambulia シャンブリア、Beba ベバ、
  // mbingu ンビング、kwa クワ（鼻音在辅音前读 ン）。
  // 用户用例 3/4 的两大段就是靠这条。

  var SW_ROW = {
    b: row5("\u30D0", "\u30D3", "\u30D6", "\u30D9", "\u30DC"),
    ch: row5("\u30C1\u30E3", "\u30C1", "\u30C1\u30E5", "\u30C1\u30A7", "\u30C1\u30E7"),
    d: row5("\u30C0", "\u30C7\u30A3", "\u30C9\u30A5", "\u30C7", "\u30C9"),
    dh: row5("\u30C0", "\u30C7\u30A3", "\u30C9\u30A5", "\u30C7", "\u30C9"),
    f: row5("\u30D5\u30A1", "\u30D5\u30A3", "\u30D5", "\u30D5\u30A7", "\u30D5\u30A9"),
    g: row5("\u30AC", "\u30AE", "\u30B0", "\u30B2", "\u30B4"),
    gh: row5("\u30AC", "\u30AE", "\u30B0", "\u30B2", "\u30B4"),
    h: row5("\u30CF", "\u30D2", "\u30D5", "\u30D8", "\u30DB"),
    j: row5("\u30B8\u30E3", "\u30B8", "\u30B8\u30E5", "\u30B8\u30A7", "\u30B8\u30E7"),
    k: row5("\u30AB", "\u30AD", "\u30AF", "\u30B1", "\u30B3"),
    l: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    m: row5("\u30DE", "\u30DF", "\u30E0", "\u30E1", "\u30E2"),
    n: row5("\u30CA", "\u30CB", "\u30CC", "\u30CD", "\u30CE"),
    ng: row5("\u30F3\u30AC", "\u30F3\u30AE", "\u30F3\u30B0", "\u30F3\u30B2", "\u30F3\u30B4"),
    "ng'": row5("\u30F3\u30AC", "\u30F3\u30AE", "\u30F3\u30B0", "\u30F3\u30B2", "\u30F3\u30B4"),
    ny: row5("\u30CB\u30E3", "\u30CB", "\u30CB\u30E5", "\u30CB\u30A7", "\u30CB\u30E7"),
    p: row5("\u30D1", "\u30D4", "\u30D7", "\u30DA", "\u30DD"),
    r: row5("\u30E9", "\u30EA", "\u30EB", "\u30EC", "\u30ED"),
    s: row5("\u30B5", "\u30B7", "\u30B9", "\u30BB", "\u30BD"),
    sh: row5("\u30B7\u30E3", "\u30B7", "\u30B7\u30E5", "\u30B7\u30A7", "\u30B7\u30E7"),
    t: row5("\u30BF", "\u30C6\u30A3", "\u30C8\u30A5", "\u30C6", "\u30C8"),
    th: row5("\u30B5", "\u30B7", "\u30B9", "\u30BB", "\u30BD"),
    v: row5("\u30F4\u30A1", "\u30F4\u30A3", "\u30F4", "\u30F4\u30A7", "\u30F4\u30A9"),
    w: row5("\u30EF", "\u30A6\u30A3", "\u30A6", "\u30A6\u30A7", "\u30A6\u30A9"),
    y: row5("\u30E4", "\u30A4", "\u30E6", "\u30A4\u30A7", "\u30E8"),
    z: row5("\u30B6", "\u30B8", "\u30BA", "\u30BC", "\u30BE"),
  };

  var SW_VOWEL = { a: "\u30A2", e: "\u30A8", i: "\u30A4", o: "\u30AA", u: "\u30A6" };

  function swahiliToKatakana(raw) {
    var w = bare(raw);
    if (!w || !/^[a-z']+$/.test(w)) return null;
    var len = w.length;
    var out = "";
    var i = 0;
    while (i < len) {
      var rest = len - i;
      var three = w.substr(i, 3);
      var two = w.substr(i, 2);
      var c = w.charAt(i);
      // 撇号（ng'ombe 这种）不发音
      if (c === "'" || c === "\u2019") { i += 1; continue; }
      // 鼻音 + 辅音 -> ン（mbingu ンビング、nchi ンチ）；ng / ny 是二合字母，先让下面接走。
      // w / y / h 前面不算"辅音前的鼻音"：mwa 读 ムワ、mya 读 ミャ
      var nx = w.charAt(i + 1);
      if ((c === "m" || c === "n") && "bcdfgjklpqrstvz".indexOf(nx) >= 0 && !(two === "ng" || two === "ny")) {
        out += "\u30F3";
        i += 1;
        continue;
      }
      if (SW_ROW[three] && SW_VOWEL[w.charAt(i + 3)]) {
        out += pick(SW_ROW[three], w.charAt(i + 3));
        i += 4;
        continue;
      }
      if (SW_ROW[two] && SW_VOWEL[w.charAt(i + 2)]) {
        out += pick(SW_ROW[two], w.charAt(i + 2));
        i += 3;
        continue;
      }
      if (SW_ROW[c] && SW_VOWEL[w.charAt(i + 1)]) {
        out += pick(SW_ROW[c], w.charAt(i + 1));
        i += 2;
        continue;
      }
      if (SW_VOWEL[c]) { out += SW_VOWEL[c]; i += 1; continue; }
      // 辅音收尾（借词、专名）：Natlan ナトラン
      if (rest === 1) {
        if ("mn".indexOf(c) >= 0) { out += "\u30F3"; i += 1; continue; }
        if (c === "l" || c === "r") { out += "\u30EB"; i += 1; continue; }
        if (c === "s") { out += "\u30B9"; i += 1; continue; }
        if (c === "t" || c === "d") { out += "\u30C8"; i += 1; continue; }
        if (c === "k" || c === "g") { out += "\u30AF"; i += 1; continue; }
        if (c === "p" || c === "b") { out += "\u30D7"; i += 1; continue; }
        if (c === "f" || c === "v") { out += "\u30D5"; i += 1; continue; }
      }
      if (SW_ROW[c]) { out += pick(SW_ROW[c], "u"); i += 1; continue; }
      i += 1;
    }
    return out ? { kana: out, confident: false } : null;
  }

  // ============================================================ 汉语拼音
  //
  // 声母/韵母拆开拼。汉语的音节比日语多得多（ng 尾、iu/ui/ian 这类复韵母），
  // 所以只能近似 —— 但方向是对的：zh ジ、ch チ、sh シ、x シ、q チ、c ツ、
  // r ル、ong オン、ian イエン。
  // 判定很保守：**必须有声调符号或者 ü**，而且每个词都得能切成拼音音节
  // （否则和日语罗马字行、法语行分不开）。

  /**
   * 韵母表：{ solo, col, kana }
   *   solo 单独成音节时的读音（`ang` アン）
   *   col  拼在声母后面时，声母换到哪一列（shang -> シャ + ン，col = "a"）
   *   kana 声母那一拍之后还要补的假名（`ang` 补 ン；`ai` 不补，因为 シャ+イ 里
   *        的 イ 由 glide 处理……所以 glide 用 "イ"/"ウ" 这种形式写清楚）
   * 复韵母里的 i/u/ü 是介音，日语音译里并进声母那一拍（xie シェ、liu リュウ）。
   */
  var PY_FINAL = {
    a: { solo: "\u30A2", col: "a", kana: "" },
    o: { solo: "\u30AA", col: "o", kana: "" },
    e: { solo: "\u30A6", col: "u", kana: "" },
    i: { solo: "\u30A4", col: "i", kana: "" },
    u: { solo: "\u30A6", col: "u", kana: "" },
    "\u00FC": { solo: "\u30E6", col: "u", kana: "", umlaut: true },
    ai: { solo: "\u30A2\u30A4", col: "a", kana: "\u30A4" },
    ei: { solo: "\u30A8\u30A4", col: "e", kana: "\u30A4" },
    ao: { solo: "\u30A2\u30AA", col: "a", kana: "\u30AA" },
    ou: { solo: "\u30AA\u30A6", col: "o", kana: "\u30A6" },
    an: { solo: "\u30A2\u30F3", col: "a", kana: "\u30F3" },
    en: { solo: "\u30A8\u30F3", col: "e", kana: "\u30F3" },
    ang: { solo: "\u30A2\u30F3", col: "a", kana: "\u30F3" },
    eng: { solo: "\u30AA\u30F3", col: "o", kana: "\u30F3" },
    ong: { solo: "\u30AA\u30F3", col: "o", kana: "\u30F3" },
    er: { solo: "\u30A2\u30EB", col: "a", kana: "\u30EB" },
    ia: { solo: "\u30A4\u30A2", col: "i", kana: "\u30E3" },
    ie: { solo: "\u30A4\u30A8", col: "i", kana: "\u30A7" },
    iao: { solo: "\u30A4\u30A2\u30AA", col: "i", kana: "\u30E3\u30AA" },
    iu: { solo: "\u30A4\u30A6", col: "i", kana: "\u30E5\u30A6" },
    ian: { solo: "\u30A4\u30A8\u30F3", col: "i", kana: "\u30A7\u30F3" },
    in: { solo: "\u30A4\u30F3", col: "i", kana: "\u30F3" },
    iang: { solo: "\u30A4\u30A2\u30F3", col: "i", kana: "\u30E3\u30F3" },
    ing: { solo: "\u30A4\u30F3", col: "i", kana: "\u30F3" },
    iong: { solo: "\u30A4\u30AA\u30F3", col: "i", kana: "\u30E7\u30F3" },
    ua: { solo: "\u30A6\u30A2", col: "u", kana: "\u30A1" },
    uo: { solo: "\u30A6\u30AA", col: "u", kana: "\u30A9" },
    uai: { solo: "\u30A6\u30A2\u30A4", col: "u", kana: "\u30A1\u30A4" },
    ui: { solo: "\u30A6\u30A4", col: "u", kana: "\u30A4" },
    uan: { solo: "\u30A6\u30A2\u30F3", col: "u", kana: "\u30A1\u30F3" },
    un: { solo: "\u30A6\u30F3", col: "u", kana: "\u30F3" },
    uang: { solo: "\u30A6\u30A2\u30F3", col: "u", kana: "\u30A1\u30F3" },
    ueng: { solo: "\u30A6\u30AA\u30F3", col: "u", kana: "\u30A9\u30F3" },
    "\u00FCe": { solo: "\u30E6\u30A8", col: "u", kana: "\u30A8", umlaut: true },
    "\u00FCan": { solo: "\u30E6\u30A8\u30F3", col: "u", kana: "\u30A8\u30F3", umlaut: true },
    "\u00FCn": { solo: "\u30E6\u30F3", col: "u", kana: "\u30F3", umlaut: true },
  };

  /** 声母 -> 各列假名（拼韵母用） */
  var PY_ROW = {
    zh: { a: "\u30B8\u30E3", i: "\u30B8", u: "\u30B8\u30E5", e: "\u30B8\u30A7", o: "\u30B8\u30E7" },
    ch: { a: "\u30C1\u30E3", i: "\u30C1", u: "\u30C1\u30E5", e: "\u30C1\u30A7", o: "\u30C1\u30E7" },
    sh: { a: "\u30B7\u30E3", i: "\u30B7", u: "\u30B7\u30E5", e: "\u30B7\u30A7", o: "\u30B7\u30E7" },
    b: { a: "\u30D0", i: "\u30D3", u: "\u30D6", e: "\u30D9", o: "\u30DC" },
    p: { a: "\u30D1", i: "\u30D4", u: "\u30D7", e: "\u30DA", o: "\u30DD" },
    m: { a: "\u30DE", i: "\u30DF", u: "\u30E0", e: "\u30E1", o: "\u30E2" },
    f: { a: "\u30D5\u30A1", i: "\u30D5\u30A3", u: "\u30D5", e: "\u30D5\u30A7", o: "\u30D5\u30A9" },
    d: { a: "\u30C0", i: "\u30C7\u30A3", u: "\u30C9\u30A5", e: "\u30C7", o: "\u30C9" },
    t: { a: "\u30BF", i: "\u30C6\u30A3", u: "\u30C8\u30A5", e: "\u30C6", o: "\u30C8" },
    n: { a: "\u30CA", i: "\u30CB", u: "\u30CC", e: "\u30CD", o: "\u30CE" },
    l: { a: "\u30E9", i: "\u30EA", u: "\u30EB", e: "\u30EC", o: "\u30ED" },
    g: { a: "\u30AC", i: "\u30AE", u: "\u30B0", e: "\u30B2", o: "\u30B4" },
    k: { a: "\u30AB", i: "\u30AD", u: "\u30AF", e: "\u30B1", o: "\u30B3" },
    h: { a: "\u30CF", i: "\u30D2", u: "\u30D5", e: "\u30D8", o: "\u30DB" },
    j: { a: "\u30B8\u30E3", i: "\u30B8", u: "\u30B8\u30E5", e: "\u30B8\u30A7", o: "\u30B8\u30E7" },
    q: { a: "\u30C1\u30E3", i: "\u30C1", u: "\u30C1\u30E5", e: "\u30C1\u30A7", o: "\u30C1\u30E7" },
    x: { a: "\u30B7\u30E3", i: "\u30B7", u: "\u30B7\u30E5", e: "\u30B7\u30A7", o: "\u30B7\u30E7" },
    r: { a: "\u30E9", i: "\u30EB", u: "\u30EB", e: "\u30EC", o: "\u30ED" },
    z: { a: "\u30B6", i: "\u30BA", u: "\u30BA", e: "\u30BC", o: "\u30BE" },
    c: { a: "\u30C4\u30A1", i: "\u30C4", u: "\u30C4", e: "\u30C4\u30A7", o: "\u30C4\u30A9" },
    s: { a: "\u30B5", i: "\u30B9", u: "\u30B9", e: "\u30BB", o: "\u30BD" },
    y: { a: "\u30E4", i: "\u30A4", u: "\u30E6", e: "\u30A4\u30A7", o: "\u30E8" },
    w: { a: "\u30EF", i: "\u30A6\u30A3", u: "\u30A6", e: "\u30A6\u30A7", o: "\u30A6\u30A9" },
  };

  /** 声调符号 -> [基元音, 声调] */
  var PY_TONE = {
    "\u0101": "a1", "\u00E1": "a2", "\u01CE": "a3", "\u00E0": "a4",
    "\u0113": "e1", "\u00E9": "e2", "\u011B": "e3", "\u00E8": "e4",
    "\u012B": "i1", "\u00ED": "i2", "\u01D0": "i3", "\u00EC": "i4",
    "\u014D": "o1", "\u00F3": "o2", "\u01D2": "o3", "\u00F2": "o4",
    "\u016B": "u1", "\u00FA": "u2", "\u01D4": "u3", "\u00F9": "u4",
    "\u01D6": "\u00FC1", "\u01D8": "\u00FC2", "\u01DA": "\u00FC3", "\u01DC": "\u00FC4",
  };

  /** 把带声调的拼音折成不带调的形式（ü 保留，它是音位） */
  function pyStripTone(word) {
    var out = "";
    for (var i = 0; i < word.length; i++) {
      var ch = word.charAt(i);
      var t = PY_TONE[ch];
      out += t ? t.slice(0, t.length - 1) : ch;
    }
    return out;
  }

  var PY_INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];
  var PY_FINALS_ORDER = ["iong", "iang", "uang", "ueng", "\u00FCan", "ian", "iao", "ing", "uai", "uan", "ang", "eng", "ong", "ai", "ei", "ao", "ou", "an", "en", "ia", "ie", "iu", "in", "ua", "uo", "ui", "un", "er", "\u00FCe", "\u00FCn", "a", "o", "e", "i", "u", "\u00FC"];

  /** 切声母+韵母；不成音节返回 null（判语言时也用它） */
  function pySplit(word) {
    var w = pyStripTone(String(word == null ? "" : word).toLowerCase());
    if (!w) return null;
    var initial = "";
    var i;
    for (i = 0; i < PY_INITIALS.length; i++) {
      if (w.indexOf(PY_INITIALS[i]) === 0) {
        initial = PY_INITIALS[i];
        break;
      }
    }
    var tail = w.slice(initial.length);
    // j/q/x/y 后面写 u 的其实是 ü（ju ジュ、xu シュ、yu ユ）
    if ("jqxy".indexOf(initial) >= 0 && tail.charAt(0) === "u") tail = "\u00FC" + tail.slice(1);
    if (!tail) return null;
    for (i = 0; i < PY_FINALS_ORDER.length; i++) {
      if (tail === PY_FINALS_ORDER[i]) return { initial: initial, final: tail };
    }
    return null;
  }

  function pinyinToKatakana(raw) {
    var w = lower(raw).replace(/['\u2019\u2011\s]/g, "");
    if (!w || !/^[a-z\u00E0-\u00FF\u0100-\u01FF\u00FC]+$/.test(w)) return null;
    var parts = pySplit(w);
    if (!parts) return null;
    var fin = PY_FINAL[parts.final];
    if (!fin) return null;
    if (!parts.initial) return { kana: fin.solo, confident: false };
    var row = PY_ROW[parts.initial];
    if (!row) return { kana: fin.solo, confident: false };
    var col = fin.col;
    // ü 系列的韵母后面接 j/q/x/y 时用 u 列（ju ジュ）
    var body = row[col] || row.a;
    var kana = body + (fin.kana || "");
    // zhi / chi / shi / ri / zi / ci / si：那个 i 不读 イ（知 ジ、吃 チ、思 ス）——
    // PY_ROW 里 zh/ch/sh/r/z/c/s 的 i 列已经写成 ジ/チ/シ/ル/ズ/ツ/ス 了 ✓
    return { kana: kana, confident: false };
  }

  // ============================================================ 俄语（西里尔）
  //
  // 逐字母转写 + 软化（软元音 е ё и ю я 让前面的辅音带 ィ）：
  //   Мы ムイ / Отчизну オトチズヌ / Виват ヴィヴァト / Анастасия アナスタシヤ
  // 俄语的重音和元音弱化（о 在非重音读 а）这里不做 —— 近似就够，配了 key 交给大模型。

  var RU_CHAR = {
    "\u0430": "\u30A2", "\u0431": "\u30D6", "\u0432": "\u30F4", "\u0433": "\u30B0", "\u0434": "\u30C9",
    "\u0435": "\u30A8", "\u0451": "\u30E8", "\u0436": "\u30B8\u30E5", "\u0437": "\u30BA", "\u0438": "\u30A4",
    "\u0439": "\u30A4", "\u043A": "\u30AF", "\u043B": "\u30EB", "\u043C": "\u30E0", "\u043D": "\u30F3",
    "\u043E": "\u30AA", "\u043F": "\u30D7", "\u0440": "\u30EB", "\u0441": "\u30B9", "\u0442": "\u30C8",
    "\u0443": "\u30A6", "\u0444": "\u30D5", "\u0445": "\u30D5", "\u0446": "\u30C4", "\u0447": "\u30C1",
    "\u0448": "\u30B7", "\u0449": "\u30B7\u30C1", "\u044A": "", "\u044B": "\u30A4", "\u044C": "",
    "\u044D": "\u30A8", "\u044E": "\u30E6", "\u044F": "\u30E4",
  };

  /*
   * 辅音 + 硬元音（а э о у）各拼一拍 —— 日语假名本身自带元音，所以
   * 「辅音 + 元音」必须**合成一个假名**（то ト、не ネ），不能一个字母一个假名，
   * 否则 отстоим 会读成 オトストオイム（多出一堆元音）。
   * 「辅音 + 辅音 / 词尾」用 u 那一列（ст ス・ト、м ム、х フ），
   * 这也是日语转写俄语的做法（ストル、フレブ）。
   */
  var RU_ROW = {
    "\u0431": { a: "\u30D0", e: "\u30D9", o: "\u30DC", u: "\u30D6" },
    "\u0432": { a: "\u30F4\u30A1", e: "\u30F4\u30A7", o: "\u30F4\u30A9", u: "\u30F4" },
    "\u0433": { a: "\u30AC", e: "\u30B2", o: "\u30B4", u: "\u30B0" },
    "\u0434": { a: "\u30C0", e: "\u30C7", o: "\u30C9", u: "\u30C9\u30A5" },
    "\u0436": { a: "\u30B8\u30E3", e: "\u30B8\u30A7", o: "\u30B8\u30E7", u: "\u30B8\u30E5" },
    "\u0437": { a: "\u30B6", e: "\u30BC", o: "\u30BE", u: "\u30BA" },
    "\u043A": { a: "\u30AB", e: "\u30B1", o: "\u30B3", u: "\u30AF" },
    "\u043B": { a: "\u30E9", e: "\u30EC", o: "\u30ED", u: "\u30EB" },
    "\u043C": { a: "\u30DE", e: "\u30E1", o: "\u30E2", u: "\u30E0" },
    "\u043D": { a: "\u30CA", e: "\u30CD", o: "\u30CE", u: "\u30CC" },
    "\u043F": { a: "\u30D1", e: "\u30DA", o: "\u30DD", u: "\u30D7" },
    "\u0440": { a: "\u30E9", e: "\u30EC", o: "\u30ED", u: "\u30EB" },
    "\u0441": { a: "\u30B5", e: "\u30BB", o: "\u30BD", u: "\u30B9" },
    "\u0442": { a: "\u30BF", e: "\u30C6", o: "\u30C8", u: "\u30C8" },
    "\u0444": { a: "\u30D5\u30A1", e: "\u30D5\u30A7", o: "\u30D5\u30A9", u: "\u30D5" },
    "\u0445": { a: "\u30CF", e: "\u30D8", o: "\u30DB", u: "\u30D5" },
    "\u0446": { a: "\u30C4\u30A1", e: "\u30C4\u30A7", o: "\u30C4\u30A9", u: "\u30C4" },
    "\u0447": { a: "\u30C1\u30E3", e: "\u30C1\u30A7", o: "\u30C1\u30E7", u: "\u30C1" },
    "\u0448": { a: "\u30B7\u30E3", e: "\u30B7\u30A7", o: "\u30B7\u30E7", u: "\u30B7" },
    "\u0449": { a: "\u30B7\u30C1\u30E3", e: "\u30B7\u30C1\u30A7", o: "\u30B7\u30C1\u30E7", u: "\u30B7\u30C1" },
  };

  /** 软化（辅音 + и）：イ段假名 */
  var RU_I = {
    "\u0442": "\u30C1", "\u0434": "\u30B8", "\u043D": "\u30CB", "\u043B": "\u30EA", "\u0441": "\u30B7",
    "\u0437": "\u30B8", "\u0440": "\u30EA", "\u0431": "\u30D3", "\u043F": "\u30D4", "\u043C": "\u30DF",
    "\u0432": "\u30F4\u30A3", "\u0444": "\u30D5\u30A3", "\u043A": "\u30AD", "\u0433": "\u30AE",
    "\u0445": "\u30D2", "\u0436": "\u30B8", "\u0448": "\u30B7", "\u0446": "\u30C4\u30A3", "\u0447": "\u30C1",
    "\u0449": "\u30B7\u30C1",
  };

  var RU_VOWEL = {
    "\u0430": "\u30A2", "\u044D": "\u30A8", "\u043E": "\u30AA", "\u0443": "\u30A6",
    "\u044B": "\u30A4", "\u0435": "\u30A8", "\u0451": "\u30E8", "\u044E": "\u30E6", "\u044F": "\u30E4", "\u0438": "\u30A4",
  };

  /** 硬元音（拼进辅音那一拍）；е 在不软化的辅音后面也算硬（себя セビャ、Денис デニス） */
  var RU_HARD = { "\u0430": "a", "\u044D": "e", "\u043E": "o", "\u0443": "u", "\u0435": "e" };
  /** 词尾/连缀里读拨音的辅音 */
  var RU_CLUSTER = { "\u043D": "\u30F3" };
  /** 软元音 */
  var RU_SOFT_V = { "\u0438": "\u30A4", "\u0435": "\u30A7", "\u044E": "\u30E5", "\u044F": "\u30E3", "\u0451": "\u30E7" };

  function ruIsVowel(ch) {
    return "\u0430\u0435\u0451\u0438\u043E\u0443\u044B\u044D\u044E\u044F".indexOf(ch) >= 0;
  }

  function russianToKatakana(raw) {
    var w = lower(raw).replace(/[\u0300\u0301]/g, "");
    if (!w || !/^[\u0430-\u044F\u0451]+$/.test(w)) return null;
    var len = w.length;
    var out = "";
    var i = 0;
    while (i < len) {
      var c = w.charAt(i);
      var next = w.charAt(i + 1);
      var prev = i > 0 ? w.charAt(i - 1) : "";

      // 词尾的 -ий / -ый 读 イー（ロシースキー）
      if (i + 2 === len && (c === "\u0438" || c === "\u044B") && next === "\u0439") { out += "\u30A4\u30FC"; i += 2; continue; }
      // ь / ъ 不发音
      if (c === "\u044C" || c === "\u044A") { i += 1; continue; }
      // 词首（或元音后）的 е 读 イェ（Ельцин イェリツィン）；его 里的 г 读 в 那种例外不管
      if (c === "\u0435" && (i === 0 || ruIsVowel(prev))) { out += "\u30A4\u30A7"; i += 1; continue; }
      // 元音单字
      if (ruIsVowel(c)) { out += RU_VOWEL[c]; i += 1; continue; }
      // й（以及词尾的 ы）
      if (c === "\u0439") { out += "\u30A4"; i += 1; continue; }

      // ---- 辅音
      if (next !== "" && RU_SOFT_V[next] !== undefined && RU_I[c]) {
        // е 只在 н / л / т 后面软化（нет ニェト、теле チェレ）；
        // д / с / з / б / п / м / в / ф 后面保持硬音（Денис デニス、себя セビャ）
        var softEnable = next !== "\u0435" || c === "\u043D" || c === "\u043B" || c === "\u0442";
        if (softEnable) {
          out += RU_I[c];
          if (next !== "\u0438") out += RU_SOFT_V[next];
          i += 2;
          continue;
        }
      }
      // тч / дч 合成 チ，后面的 и 也一起收进来（Отчизна オチズナ）
      if ((c === "\u0442" || c === "\u0434") && next === "\u0447") {
        out += "\u30C1";
        i += "\u0438\u0435".indexOf(w.charAt(i + 2)) >= 0 ? 3 : 2;
        continue;
      }
      // 辅音 + 硬元音：合成一拍
      if (next !== "" && RU_HARD[next] !== undefined && RU_ROW[c]) {
        out += RU_ROW[c][RU_HARD[next]];
        i += 2;
        continue;
      }
      // 辅音 + ы：ы 单独一个イ（Мы ムイ）
      if (next === "\u044B" && RU_ROW[c]) { out += RU_ROW[c].u + "\u30A4"; i += 2; continue; }
      // 双辅音只读一次
      if (c === next && RU_ROW[c]) { i += 1; continue; }
      // 辅音 + 辅音 / 词尾：用 u 那一列（н 收拨音）
      if (RU_ROW[c]) { out += RU_CLUSTER[c] || RU_ROW[c].u; i += 1; continue; }
      i += 1;
    }
    return out ? { kana: out, confident: false } : null;
  }

  // ============================================================ 希腊语
  //
  // 逐字母 + 二合字母：ου ウ、αι エ、ει イ、μπ ンブ、ντ ンド、γκ ング、
  // γγ ング、τζ ツ、θ ト、χ フ、β ヴ、δ ド、η イ、υ イ、ω オ、ς ス。
  //   Θάλασσα サラッサ / Ουρανός ウラノス / Άνθρωπος アンスロポス

  var EL_CHAR = {
    "\u03B1": "\u30A2", "\u03B2": "\u30D6", "\u03B3": "\u30B0", "\u03B4": "\u30C9", "\u03B5": "\u30A8",
    "\u03B6": "\u30BA", "\u03B7": "\u30A4", "\u03B8": "\u30B5", "\u03B9": "\u30A4", "\u03BA": "\u30AF",
    "\u03BB": "\u30EB", "\u03BC": "\u30E0", "\u03BD": "\u30F3", "\u03BE": "\u30AF\u30B9", "\u03BF": "\u30AA",
    "\u03C0": "\u30D7", "\u03C1": "\u30EB", "\u03C3": "\u30B9", "\u03C2": "\u30B9", "\u03C4": "\u30C8",
    "\u03C5": "\u30A4", "\u03C6": "\u30D5", "\u03C7": "\u30D5", "\u03C8": "\u30D7\u30B9", "\u03C9": "\u30AA",
  };

  /** 元音（含带调号的那些：先折成基字母再看） */
  function greekBase(ch) {
    return FOLD[ch] !== undefined && FOLD[ch].length === 1 && ch.charCodeAt(0) >= 0x380 && ch.charCodeAt(0) <= 0x3FF ? FOLD[ch] : ch;
  }

  /** θ / φ / χ 按后一个元音成拍 */
  var EL_ROW = {
    s: row5("\u30B5", "\u30B7", "\u30B9", "\u30BB", "\u30BD"),
    f: row5("\u30D5\u30A1", "\u30D5\u30A3", "\u30D5", "\u30D5\u30A7", "\u30D5\u30A9"),
    h: row5("\u30CF", "\u30D2", "\u30D5", "\u30D8", "\u30DB"),
  };

  /**
   * 希腊语的辅音行：辅音 + 元音要**合成一拍**（λα ラ、νο ノ、ρω ロ）。
   * 列按元音分 a/e/i/o/u，其中 η 和 υ 都并到 i 列（η 读 イ、υ 读 イ），ω 并到 o 列。
   */
  var EL_CONS = {
    /*
     * β 读 **バ行**（不是 ヴァ行）：日语里希腊语借词的通行写法就是 b
     * —— ベータ（beta）、ビザンツ、ビオス…。用户截图 `《βίος》` 被读成 ヴィオス，
     * 那个词（Guilty Crown 的 βίος）在日语里是 **ビオス**。
     * 古希腊语的 β 本来就是 /b/，现代希腊语虽然读 /v/，但日语仍然写 バ行。
     */
    "\u03B2": { a: "\u30D0", e: "\u30D9", i: "\u30D3", o: "\u30DC", u: "\u30D6" },
    "\u03B3": { a: "\u30AC", e: "\u30B2", i: "\u30AE", o: "\u30B4", u: "\u30B0" },
    "\u03B4": { a: "\u30C0", e: "\u30C7", i: "\u30C7\u30A3", o: "\u30C9", u: "\u30C9\u30A5" },
    "\u03B6": { a: "\u30B6", e: "\u30BC", i: "\u30B8", o: "\u30BE", u: "\u30BA" },
    "\u03B8": { a: "\u30B5", e: "\u30BB", i: "\u30B7", o: "\u30BD", u: "\u30B9" },
    "\u03BA": { a: "\u30AB", e: "\u30B1", i: "\u30AD", o: "\u30B3", u: "\u30AF" },
    "\u03BB": { a: "\u30E9", e: "\u30EC", i: "\u30EA", o: "\u30ED", u: "\u30EB" },
    "\u03BC": { a: "\u30DE", e: "\u30E1", i: "\u30DF", o: "\u30E2", u: "\u30E0" },
    "\u03BD": { a: "\u30CA", e: "\u30CD", i: "\u30CB", o: "\u30CE", u: "\u30CC" },
    "\u03BE": { a: "\u30AF\u30B5", e: "\u30AF\u30BB", i: "\u30AF\u30B7", o: "\u30AF\u30BD", u: "\u30AF\u30B9" },
    "\u03C0": { a: "\u30D1", e: "\u30DA", i: "\u30D4", o: "\u30DD", u: "\u30D7" },
    "\u03C1": { a: "\u30E9", e: "\u30EC", i: "\u30EA", o: "\u30ED", u: "\u30EB" },
    "\u03C3": { a: "\u30B5", e: "\u30BB", i: "\u30B7", o: "\u30BD", u: "\u30B9" },
    "\u03C2": { a: "\u30B5", e: "\u30BB", i: "\u30B7", o: "\u30BD", u: "\u30B9" },
    "\u03C4": { a: "\u30BF", e: "\u30C6", i: "\u30C6\u30A3", o: "\u30C8", u: "\u30C8\u30A5" },
    "\u03C6": { a: "\u30D5\u30A1", e: "\u30D5\u30A7", i: "\u30D5\u30A3", o: "\u30D5\u30A9", u: "\u30D5" },
    "\u03C7": { a: "\u30CF", e: "\u30D8", i: "\u30D2", o: "\u30DB", u: "\u30D5" },
    "\u03C8": { a: "\u30D7\u30B5", e: "\u30D7\u30BB", i: "\u30D7\u30B7", o: "\u30D7\u30BD", u: "\u30D7\u30B9" },
  };

  /** 希腊语元音字母 -> EL_CONS 的列名 */
  var EL_VCOL = {
    "\u03B1": "a", "\u03B5": "e", "\u03B7": "i", "\u03B9": "i", "\u03BF": "o", "\u03C5": "i", "\u03C9": "o",
  };

  var EL_VOWEL = "\u03B1\u03B5\u03B7\u03B9\u03BF\u03C5\u03C9";

  function greekToKatakana(raw) {
    var src = lower(raw);
    var w = "";
    for (var k = 0; k < src.length; k++) w += greekBase(src.charAt(k));
    if (!w || !/^[\u03B1-\u03C9]+$/.test(w)) return null;
    var len = w.length;
    var out = "";
    var i = 0;
    while (i < len) {
      var rest = len - i;
      var two = w.substr(i, 2);
      var three = w.substr(i, 3);
      if (three === "\u03B3\u03BA\u03C3") { out += "\u30F3\u30AF\u30B9"; i += 3; continue; }
      if (two === "\u03BF\u03C5") { out += "\u30A6"; i += 2; continue; }
      if (two === "\u03B1\u03B9" || two === "\u03B5\u03B9" || two === "\u03BF\u03B9" || two === "\u03C5\u03B9") { out += "\u30A4"; i += 2; continue; }
      if (two === "\u03B1\u03C5" || two === "\u03B5\u03C5" || two === "\u03B7\u03C5") { out += "\u30D5"; i += 2; continue; }
      if (two === "\u03BC\u03C0") { out += i === 0 ? "\u30D6" : "\u30F3\u30D6"; i += 2; continue; }
      if (two === "\u03BD\u03C4") { out += i === 0 ? "\u30C9" : "\u30F3\u30C9"; i += 2; continue; }
      if (two === "\u03B3\u03BA") { out += i === 0 ? "\u30B0" : "\u30F3\u30B0"; i += 2; continue; }
      if (two === "\u03B3\u03B3") { out += "\u30F3\u30B0"; i += 2; continue; }
      if (two === "\u03B3\u03C7") { out += "\u30F3\u30D5"; i += 2; continue; }
      if (two === "\u03C4\u03B6" || two === "\u03C4\u03C3") { out += "\u30C4"; i += 2; continue; }
      // 双辅音在希腊语里读促音（θάλασσα サラッサ）
      if (w.charAt(i) === w.charAt(i + 1) && EL_CHAR[w.charAt(i)]) { out += "\u30C3"; i += 1; continue; }
      var c = w.charAt(i);
      // 注：γ / κ / χ 不另做颚化 —— 希腊语里它们就是 ガ行 / カ行 / ハ行
      // （κι キ、γη ギ、χι ヒ），而 ι / η 拼在辅音后面本来就是 イ 段，
      // 交给下面的 EL_CONS 表就对了（μουσική ムシキ）
      // 辅音 + ου（读 /u/）合成一拍：μου ム、νου ヌ
      if (EL_CONS[c] && w.substr(i + 1, 2) === "\u03BF\u03C5") {
        out += EL_CONS[c].u;
        i += 3;
        continue;
      }
      // 辅音 + 元音合成一拍（λα ラ、νο ノ、ρω ロ）
      var vcol = EL_VCOL[w.charAt(i + 1)];
      if (vcol && EL_CONS[c]) {
        out += EL_CONS[c][vcol];
        i += 2;
        continue;
      }
      // θ / φ / χ 在辅音前只读辅音本体（άνθρωπος アンスロポス）
      if (c === "\u03B8" || c === "\u03C6" || c === "\u03C7") {
        out += c === "\u03B8" ? "\u30B9" : "\u30D5";
        i += 1;
        continue;
      }
      var kana = EL_CHAR[c];
      if (kana !== undefined) {
        out += kana;
        i += 1;
        continue;
      }
      i += rest === 1 ? 1 : 1;
    }
    return out ? { kana: out, confident: false } : null;
  }

  // ------------------------------------------------------------ 法语拼读

  /*
   * 法语拼写 -> 片假名读音（近似），用于法语歌词。
   *
   * 用户给了一整首法语歌词（《L'Assasymphonie》那类），要求"添加对法语的支持"：
   *   Ah, si je pouvais vivre dans l'eau, / le monde serait-il plus beau ?
   *   Nous pardonneras-tu, ô chère mère ? / L'eau dans son courant fait danser nos vies.
   * 目标是日语通行写法：je ジュ、le ル、monde モンド、l'eau ロー、amour アムール、
   * toujours トゥジュール、jamais ジャメ …
   *
   * **这是近似**：法语的联诵、哑音 e、开闭音节、重音位置都靠拼写判不准，
   * 所以法语行上的结果一律 `confident: false` —— 配了 key 就交给大模型按整句定，
   * 判完还会被自动沉淀成离线词条（core/learn.js）；没配 key 时用这里的近似值。
   *
   * 规则按优先级从上到下试（先长后短）：
   *   1. 元音 + r +（词尾 / 哑音 e）：拉长 + ル（amour アムール、mère メール）
   *   2. 鼻化元音（后接辅音或词尾）：an/am/en/em/in/im/on/om/un/um/ain/ein/oin/ien
   *   3. 元音组合：eau/au オー、ou ウ、oi ワ、ai/ei エ、eu/œu ウ
   *   4. 辅音组合：ch シュ、gn ニュ、qu ク、ph フ、th ト、ill イユ
   *   5. 单字母（辅音 + 元音直接拼；词尾辅音大多不发音）
   * 撇号与连字符直接忽略：l'eau 当 leau（ロー）、serait-il 当 seraitil（スレティル）。
   */

  var FR_VOWEL = {
    a: "\u30A2", "\u00E0": "\u30A2", "\u00E2": "\u30A2", "\u00E6": "\u30A8",
    e: "\u30A6", "\u00E9": "\u30A8", "\u00E8": "\u30A8", "\u00EA": "\u30A8", "\u00EB": "\u30A8",
    i: "\u30A4", "\u00EE": "\u30A4", "\u00EF": "\u30A4", y: "\u30A4",
    o: "\u30AA", "\u00F4": "\u30AA", "\u00F6": "\u30AA",
    u: "\u30E5", "\u00F9": "\u30E5", "\u00FB": "\u30E5", "\u00FC": "\u30E5",
    "\u0153": "\u30A6",
  };

  var FR_UNITS = {
    eau: { k: "\u30AA\u30FC", col: "o", len: 3 },
    "\u0153u": { k: "\u30A6", col: "x", len: 2 },
    eu: { k: "\u30A6", col: "x", len: 2 },
    ou: { k: "\u30A6", col: "x", len: 2 },
    oi: { k: "\u30EF", col: "a", len: 2, glide: true },
    ai: { k: "\u30A8", col: "e", len: 2 },
    ei: { k: "\u30A8", col: "e", len: 2 },
    au: { k: "\u30AA\u30FC", col: "o", len: 2 },
  };

  var FR_NASAL = {
    oin: "\u30EF\u30F3", ien: "\u30A4\u30A2\u30F3",
    ain: "\u30A2\u30F3", ein: "\u30A2\u30F3",
    an: "\u30A2\u30F3", am: "\u30A2\u30F3", en: "\u30A2\u30F3", em: "\u30A2\u30F3",
    "in": "\u30A2\u30F3", im: "\u30A2\u30F3", yn: "\u30A2\u30F3", ym: "\u30A2\u30F3",
    on: "\u30AA\u30F3", om: "\u30AA\u30F3", un: "\u30A2\u30F3", um: "\u30A2\u30F3",
  };

  var FR_ROW = {
    b: { a: "\u30D0", e: "\u30D9", i: "\u30D3", o: "\u30DC", u: "\u30D3\u30E5", x: "\u30D6" },
    c: { a: "\u30AB", e: "\u30B9", i: "\u30B7", o: "\u30B3", u: "\u30AD\u30E5", x: "\u30AF" },
    "\u00E7": { a: "\u30B5", e: "\u30BB", i: "\u30B7", o: "\u30BD", u: "\u30B9\u30E5", x: "\u30B9" },
    d: { a: "\u30C0", e: "\u30C9", i: "\u30C7\u30A3", o: "\u30C9", u: "\u30C9\u30A5", x: "\u30C9\u30A5" },
    f: { a: "\u30D5\u30A1", e: "\u30D5\u30A7", i: "\u30D5\u30A3", o: "\u30D5\u30A9", u: "\u30D5\u30E5", x: "\u30D5" },
    g: { a: "\u30AC", e: "\u30B8\u30A7", i: "\u30B8", o: "\u30B4", u: "\u30B0\u30E5", x: "\u30B0" },
    j: { a: "\u30B8\u30E3", e: "\u30B8\u30A7", i: "\u30B8", o: "\u30B8\u30E7", u: "\u30B8\u30E5", x: "\u30B8\u30E5" },
    k: { a: "\u30AB", e: "\u30B1", i: "\u30AD", o: "\u30B3", u: "\u30AD\u30E5", x: "\u30AF" },
    l: { a: "\u30E9", e: "\u30EB", i: "\u30EA", o: "\u30ED", u: "\u30EA\u30E5", x: "\u30EB" },
    m: { a: "\u30DE", e: "\u30E1", i: "\u30DF", o: "\u30E2", u: "\u30DF\u30E5", x: "\u30E0" },
    n: { a: "\u30CA", e: "\u30CC", i: "\u30CB", o: "\u30CE", u: "\u30CB\u30E5", x: "\u30CC" },
    p: { a: "\u30D1", e: "\u30DA", i: "\u30D4", o: "\u30DD", u: "\u30D4\u30E5", x: "\u30D7" },
    r: { a: "\u30E9", e: "\u30EB", i: "\u30EA", o: "\u30ED", u: "\u30EA\u30E5", x: "\u30EB" },
    s: { a: "\u30B5", e: "\u30BB", i: "\u30B7", o: "\u30BD", u: "\u30B9\u30E5", x: "\u30B9" },
    t: { a: "\u30BF", e: "\u30C6", i: "\u30C6\u30A3", o: "\u30C8", u: "\u30C1\u30E5", x: "\u30C8\u30A5" },
    v: { a: "\u30F4\u30A1", e: "\u30F4\u30A7", i: "\u30F4\u30A3", o: "\u30F4\u30A9", u: "\u30F4\u30E5", x: "\u30F4" },
    w: { a: "\u30EF", e: "\u30F4\u30A7", i: "\u30A6\u30A3", o: "\u30F4\u30A9", u: "\u30F4\u30E5", x: "\u30A6" },
    z: { a: "\u30B6", e: "\u30BC", i: "\u30B8", o: "\u30BE", u: "\u30BA", x: "\u30BA" },
  };

  var FR_SILENT_TAIL = { s: true, t: true, d: true, x: true, z: true, p: true, g: true, m: true, n: true, c: true, f: true, b: true, k: true };

  /** 法语元音字母（含带符号的） */
  function charIsVowelFr(ch) {
    return ch !== "" && "aeiouy\u00E0\u00E2\u00E4\u00E9\u00E8\u00EA\u00EB\u00EE\u00EF\u00F4\u00F6\u00F9\u00FB\u00FC\u0153\u00E6".indexOf(ch) >= 0;
  }

  /** 从 pos 起是什么元音列（给辅音拼拍用）：返回 { col, len, nasal?, long?, glide? } */
  function frColumn(w, pos) {
    var three = w.substr(pos, 3);
    var two = w.substr(pos, 2);
    var one = w.charAt(pos);
    /** 这一拍后面是不是"r +（词尾或哑音 e）"——法语里那种元音要拉长（mère メール） */
    function longBeforeR(len) {
      var after = w.charAt(pos + len);
      if (after !== "r") return false;
      var nxt = w.charAt(pos + len + 1);
      return nxt === "" || (nxt === "e" && pos + len + 2 >= w.length);
    }
    if (FR_UNITS[three]) {
      return { col: FR_UNITS[three].col, len: 3, long: FR_UNITS[three].k.indexOf("\u30FC") >= 0 || longBeforeR(3), glide: !!FR_UNITS[three].glide };
    }
    if (FR_NASAL[three] && !charIsVowelFr(w.charAt(pos + 3))) {
      return { col: FR_NASAL[three].charAt(0) === "\u30AA" ? "o" : "a", len: 3, nasal: true };
    }
    if (FR_UNITS[two]) {
      return { col: FR_UNITS[two].col, len: 2, long: FR_UNITS[two].k.indexOf("\u30FC") >= 0 || longBeforeR(2), glide: !!FR_UNITS[two].glide };
    }
    if (FR_NASAL[two] && !charIsVowelFr(w.charAt(pos + 2))) {
      return { col: FR_NASAL[two].charAt(0) === "\u30AA" ? "o" : "a", len: 2, nasal: true };
    }
    if (one === "" || one === undefined) return null;
    if (one === "l" && w.charAt(pos + 1) === "l") return null;
    if ("e\u00E9\u00E8\u00EA".indexOf(one) >= 0) return { col: "e", len: 1, long: longBeforeR(1) };
    if ("iy\u00EE\u00EF".indexOf(one) >= 0) return { col: "i", len: 1, long: longBeforeR(1) };
    if ("o\u00F4".indexOf(one) >= 0) return { col: "o", len: 1, long: longBeforeR(1) };
    if ("u\u00F9\u00FB\u00FC".indexOf(one) >= 0) return { col: "u", len: 1, long: longBeforeR(1) };
    if ("a\u00E0\u00E2".indexOf(one) >= 0) return { col: "a", len: 1, long: longBeforeR(1) };
    return null;
  }

  /** 法语词 -> 片假名（近似）。判不出来返回 null。 */
  function frenchToKatakana(raw) {
    if (typeof raw !== "string") return null;
    var w = raw
      .toLowerCase()
      .replace(/['\u2019\u2011-]/g, "")
      .replace(/\s+/g, "");
    if (!w || !/^[a-z\u00E0-\u00FF\u0153]+$/.test(w)) return null;
    /*
     * 复数词尾 "-es" 不发音（vies ヴィ、amours アムール）—— 但三个字母以内不算：
     * les レ、des デ、ces セ、mes メ 这些 e 是要读的。这是近似，判错了交给大模型。
     */
    /*
     * 词尾的 s 大多不发音（vies ヴィ、pardonneras パルドンヌラ、plus プリュ）。
     * 四个字母以上、且 s 前面是元音（不是鼻化元音）时直接去掉；
     * les / des / ces / mes 这些三个字母以内的照旧读 レ / デ / セ / メ。
     */
    if (w.length >= 4 && /[aeiou\u00E9\u00E8\u00EA\u00E0\u00E2\u00EE\u00EF\u00F4\u00FB\u00F9]s$/.test(w)) {
      w = w.slice(0, -1);
    }
    if (w.length >= 4 && /[^aeiou]es$/.test(w)) w = w.slice(0, -2);

    var out = "";
    var i = 0;
    var len = w.length;
    while (i < len) {
      var rest = len - i;
      var three = w.substr(i, 3);
      var two = w.substr(i, 2);
      var ch = w.charAt(i);

      // ---- 1. 元音 + r +（词尾 / 哑音 e）：拉长 + ル
      var vr = /^([aeiouy\u00E0\u00E2\u00E9\u00E8\u00EA\u00EB\u00EE\u00EF\u00F4\u00F6\u00F9\u00FB\u00FC\u0153\u00E6]+)r(e?)$/.exec(w.slice(i));
      if (vr && vr[1].length <= 3) {
        var vk = null;
        if (FR_UNITS[vr[1]]) vk = FR_UNITS[vr[1]].k;
        else {
          var lv = vr[1].charAt(vr[1].length - 1);
          if (FR_VOWEL[lv] !== undefined) vk = FR_VOWEL[lv];
          else if (FR_UNITS[vr[1].slice(-2)]) vk = FR_UNITS[vr[1].slice(-2)].k;
        }
        if (vk) {
          out += vk.replace(/\u30FC$/, "") + "\u30FC\u30EB";
          i = len;
          continue;
        }
      }

      // ---- 2. 鼻化元音（后面是辅音或词尾）
      if (FR_NASAL[three] && (i + 3 === len || !charIsVowelFr(w.charAt(i + 3)))) {
        out += FR_NASAL[three];
        i += 3;
        continue;
      }
      if (FR_NASAL[two] && (i + 2 === len || !charIsVowelFr(w.charAt(i + 2)))) {
        out += FR_NASAL[two];
        i += 2;
        continue;
      }

      // ---- 3. 元音组合
      if (FR_UNITS[three]) {
        out += FR_UNITS[three].k;
        i += 3;
        continue;
      }
      if (FR_UNITS[two]) {
        out += FR_UNITS[two].k;
        i += 2;
        continue;
      }

      // ---- 4. 辅音组合
      if (three === "ill") {
        out += "\u30A4\u30E6";
        i += 3;
        continue;
      }
      if (two === "ch") {
        // ch 也要按后一个元音拼：chère シェール、chose ショーズ、chut シュ
        var chCol = frColumn(w, i + 2);
        if (chCol) {
          out += (chCol.col === "e" ? "\u30B7\u30A7" : chCol.col === "i" ? "\u30B7" : chCol.col === "o" ? "\u30B7\u30E7" : chCol.col === "a" ? "\u30B7\u30E3" : "\u30B7\u30E5");
          if (chCol.nasal) out += "\u30F3";
          if (chCol.long) out += "\u30FC";
          i += 2 + chCol.len;
          continue;
        }
        out += "\u30B7\u30E5"; // シュ
        i += 2;
        continue;
      }
      if (two === "gn") {
        out += "\u30CB\u30E5";
        i += 2;
        continue;
      }
      if (two === "qu") {
        out += "\u30AF";
        i += 2;
        continue;
      }
      if (two === "ph") {
        out += "\u30D5";
        i += 2;
        continue;
      }
      if (two === "th") {
        out += "\u30C8";
        i += 2;
        continue;
      }
      if (ch === "h") {
        i++;
        continue;
      }

      // ---- 5. 辅音 + 元音
      if (FR_ROW[ch]) {
        var col = frColumn(w, i + 1);
        if (col) {
          /*
           * 一拍怎么拼：
           *   - "oi"（glide ✓）：辅音本体 + ワ（toi トワ）
           *   - "ou"/"eu"（col = x）：只用本体（pou プ、deux ドゥ）
           *   - 其余（a/e/i/o/u 列）：本体换元音（dans ダン、plus プリュ…）
           */
          out += col.glide ? FR_ROW[ch].o + "\u30EF" : FR_ROW[ch][col.col] || FR_ROW[ch].a;
          if (col.nasal) out += "\u30F3";
          if (col.long) out += "\u30FC";
          i += 1 + col.len;
          continue;
        }
        if (rest === 1) {
          if (ch === "l" || ch === "r") out += "\u30EB";
          i++;
          continue;
        }
        // 辅音连缀里的第一个：只读辅音本体（plus プリュ、grand グラン）
        out += FR_ROW[ch].x;
        i++;
        continue;
      }

      // ---- 6. 元音单字母
      if (FR_VOWEL[ch] !== undefined) {
        out += FR_VOWEL[ch];
        i++;
        continue;
      }

      if (rest === 1 && FR_SILENT_TAIL[ch]) {
        i++;
        continue;
      }
      i++;
    }

    var kana = out.replace(/\u30FC{2,}/g, "\u30FC");
    return kana ? { kana: kana, confident: false } : null;
  }

  // ------------------------------------------------------------ 法语判据

  /*
   * 法语功能词表：既是"这行有多少法语词"的分表（SIGNALS.fr.words，权重 2），
   * 也是 looksFrench 判"没有硬信号时凑够两个法语词"的依据。
   * 键都是 ASCII（变音符号折掉后的写法），因为 wordsOf() 折过之后才查表。
   */
  var FR_WORDS = {};
  (function () {
    var list =
      "le la les un une des du de au aux ce cet cette ces mon ma mes ton ta tes son sa ses " +
      "notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te se moi toi lui eux " +
      "et ou mais donc car ni que qui quoi dont si comme ne pas rien jamais toujours deja " +
      "dans sur sous avec pour par vers chez entre sans est sont etait etaient sera serai suis es " +
      "etre avoir ont avait fait faire dit dire voit voir sais savoir peut pouvoir veut vouloir " +
      "doit devoir va aller vient venir vit vivre meurt mourir aime aimer chante chanter danse danser " +
      "coeur amour vie monde ciel nuit jour temps yeux main beau belle doux douce grand petit tout tous toute " +
      "bien mal encore aussi alors quand comment pourquoi oui non merci adieu histoire fleur mere pere soeur frere";
    var toks = list.split(/\s+/);
    for (var i = 0; i < toks.length; i++) if (toks[i]) FR_WORDS[toks[i]] = 2;
  })();

  /**
   * 这一行**像不像**法语（法语判定的门槛，见 passes()）。
   *
   * 为什么单独一条判据、不直接用分数：法语和拉丁语/英语的词形太像了，
   * 只按分数会把英文行和拉丁行读成法语。这里要的是"有法语独有的记号"：
   *   硬信号（变音符号 / 省音撇号 / 法语排版的" ?"）+ 至少一个法语词，
   *   没有硬信号时则要**两个以上**法语词 —— 而且**全大写缩写多的行不算**
   *   （`Yes, PA PI PU PE PO… MA MI MU ME MO… JUMP!` 那种罗马音节行
   *   也能凑出 ma / me 两个词）。
   */
  function looksFrench(text) {
    var s = String(text == null ? "" : text);
    if (!s) return false;
    var hard =
      /[\u00E9\u00E8\u00EA\u00E0\u00E7\u00F9\u00F4\u00EE\u00FB\u00EB\u00EF\u0153]/i.test(s) ||
      /(^|[\s(\["'])(?:l|d|j|n|s|c|m|t|qu)['\u2019]/i.test(s) ||
      /\s[?!;:]/.test(s);
    var words = 0;
    var re = /[a-zA-Z\u00C0-\u00FF\u0153'\u2019]+/g;
    var m;
    while ((m = re.exec(s))) {
      var w = m[0].toLowerCase().replace(/['\u2019].*$/, "");
      if (FR_WORDS[w]) words++;
    }
    if (hard && words >= 1) return true;
    /*
     * 没有硬信号时，只凭功能词判断的这条要小心：
     * `Yes, PA PI PU PE PO POP UP! … MA MI MU ME MO MORE JUMP!` 这种罗马音节行里
     * 也能凑出两个（ma / me），所以**全大写缩写多的行不算法语**。
     */
    if (/\b[A-Z]{2,}\b/.test(s)) return false;
    return words >= 2;
  }

  // ============================================================ 语言判定

  /**
   * 英语最常用的一小撮功能词。判语言时它们**反着加分**（减 2）：
   * 一行里出现 the / you / is 基本就不是德语/拉丁语歌词，这一条把
   * 「英文行被外语规则带歪」按住。
   */
  var EN_COMMON = {};
  (function () {
    var list =
      "the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had do does did doing done am being";
    var toks = list.split(" ");
    for (var i = 0; i < toks.length; i++) if (toks[i]) EN_COMMON[toks[i]] = true;
  })();

  /**
   * 每种语言的判据：
   *   hard   正则，命中就加分（带变音符号、ß 这种"只可能属于它"的记号）
   *   words  只属于这种语言的常用词/虚词（权重 2）；**在表里的词不再吃英语惩罚**
   *   shapes 词形（后缀、字母组合）
   * 分数 = hard + words + shapes（英语常用词 -2）；达到该语言的阈值才算认出来。
   */
  var SIGNALS = {
    /*
     * 法语：词表和别的语种同一套机制（FR_WORDS 直接当这张表用），分数也走 scoreOf。
     * 唯一特别的是**门槛**：法语和拉丁语的词形太像（Non, le grand amour ne suffit
     * pas. 里 grand / pas / non 全是"辅音收尾"），只按分数会把英文行/拉丁行读成
     * 法语，所以 passes() 里额外要求 looksFrench() 点头
     * （变音符号 / 省音撇号 / 两个以上法语功能词）。
     */
    fr: {
      min: 3,
      hard: [[/[\u00E9\u00E8\u00EA\u00E0\u00E7\u00F9\u00F4\u00EE\u00FB\u00EB\u00EF\u0153]/, 3]],
      words: FR_WORDS, // 定义在下面「法语判据」那一段（本文件在 SIGNALS 之前求值）
      shapes: [[/(?:eau|oi|ain|ein|oin|gn|ill|qu)/, 1], [/(?:ez|er|ir)$/, 1]],
    },
    de: {
      min: 4,
      hard: [[/\u00DF/, 3], [/[\u00E4\u00F6\u00FC]/, 3]],
      words: {
        und: 2, ist: 2, nicht: 2, ich: 2, dich: 2, mich: 2, sich: 2, der: 2, die: 2, das: 2, den: 2, dem: 2, des: 2,
        ein: 2, eine: 2, einen: 2, einem: 2, einer: 2, eines: 2, du: 2, wir: 2, ihr: 2, sind: 2, habt: 2, hast: 2, hat: 2,
        habe: 2, war: 2, waren: 2, wird: 2, werden: 2, wurde: 2, wenn: 2, denn: 2, aber: 2, oder: 2, auch: 2, noch: 2,
        nur: 2, schon: 2, sehr: 2, mehr: 2, mein: 2, meine: 2, meiner: 2, dein: 2, deine: 2, sein: 2, seine: 2, unser: 2,
        euer: 2, mit: 2, auf: 2, f\u00FCr: 2, von: 2, im: 2, beim: 2, vom: 2, zum: 2, zur: 2, aus: 2, bei: 2, nach: 2,
        \u00FCber: 2, unter: 2, durch: 2, gegen: 2, ohne: 2, zwischen: 2, dass: 2, weil: 2, wie: 2, was: 2, wer: 2,
        wo: 2, warum: 2, jetzt: 2, hier: 2, dort: 2, immer: 2, wieder: 2, alle: 2, alles: 2, etwas: 2, nichts: 2,
        jeder: 2, jede: 2, jedes: 2, diese: 2, dieser: 2, dieses: 2, keine: 2, kein: 2, k\u00F6nnen: 2, m\u00FCssen: 2,
        wollen: 2, sollen: 2, d\u00FCrfen: 2, m\u00F6gen: 2, wei\u00DF: 2, gro\u00DF: 2, gut: 2, tag: 2, nacht: 2,
        herz: 2, seele: 2, liebe: 2, leben: 2, tod: 2, zeit: 2, welt: 2, traum: 2, licht: 2, wind: 1, hand: 1,
        land: 1, wort: 2, lied: 2, singe: 2, singen: 2, kommt: 2, kommen: 2, geh: 2, gehen: 2, wach: 2, werde: 2,
        /*
         * 用户截图 `Sieh mit deinen Augen` 原来判不出德语（表里只有 mit 一个词、分数不够），
         * 于是走英文词典 —— `mit` 命中词典里的 **MIT**（学院缩写）被念成 エムアイティー。
         * 这一批是德语独有、歌词里常见的词（避开了 still / fast / hell / warm 这类
         * 英德同形词，免得把英文行带歪）。
         */
        sieh: 2, siehst: 2, sieht: 2, sehen: 2, sah: 2, sahen: 2, deinen: 2, deinem: 2, deiner: 2, deines: 2,
        meinen: 2, meinem: 2, meiner: 2, meines: 2, ihren: 2, ihrem: 2, ihren: 2, euren: 2, eurem: 2, augen: 2,
        himmel: 2, erde: 2, feuer: 2, wasser: 2, stern: 2, sterne: 2, schatten: 2, blut: 2, schmerz: 2,
        angst: 2, hoffnung: 2, sehnsucht: 2, ewig: 2, einsam: 2, kalt: 2, dunkel: 2, leise: 2, weit: 2,
        tief: 2, hoch: 2, klein: 2, niemals: 2, nimmer: 2, \u00FCberall: 2, zur\u00FCck: 2, vorbei: 2,
        zusammen: 2, allein: 2, vielleicht: 2, endlich: 2, pl\u00F6tzlich: 2, zwischen: 2, deiner: 2,
      },
      shapes: [
        [/sch/, 2], [/(?:ung|lich|keit|heit|schaft|chen|lein)$/, 2], [/(?:ei|eu|\u00E4u)/, 1], [/ch/, 1],
      ],
    },
    la: {
      min: 3,
      strong: true,
      hard: [[/(?:ae|oe)/, 2], [/qu/, 2], [/[aeiou]x$/, 2], [/ti[aeiou]/, 1]],
      /*
       * 虚词给 1~2 分（in / me / te / si 这些英语里也有的只给 1），
       * 实词一律 2 分。用户用例 2 / 5 / 7 里的词全在里面 —— 那些短行
       * （`Igni, cinis`、`Visio`）本来就靠词表认，不然后面整首投票也没依据。
       */
      words: (function () {
        var out = {
          et: 2, in: 1, cum: 2, per: 2, ad: 2, de: 1, ex: 2, non: 2, sed: 2, aut: 2, nec: 2, neque: 2,
          ut: 2, si: 1, me: 1, te: 1, se: 1, nos: 1, vos: 2, hic: 2, haec: 2, hoc: 2, at: 1, ac: 1,
          post: 2, ante: 2, super: 2, sub: 2, inter: 2, contra: 2, sine: 2, pro: 2, ab: 2, iam: 2, vae: 2,
          quis: 2, quid: 2, qui: 2, quae: 2, quod: 2, qua: 2, cui: 2, eis: 2, est: 2, sunt: 2, esse: 2,
          sumus: 2, estis: 2, esto: 2,
        };
        var list =
          "dominus deus lux vox rex terra terram caelum caelestis amor vita mors mortis bellum pax sanctus sancta " +
          "gloria fortuna fortunarum ignis igni cinis cinisque vanitas vanitatum dolor dolore dolores mundus mundo mundum " +
          "ordo novus novum nova omnia omnis omnibus nihil nihilum visio flamma flammae salto saltus calor caloris " +
          "oblivione oblivio tristitia tristitiae illusio sentio senta veni vidi vici requiem ave maria anima animus " +
          "corpus sanguis aqua dies diei nox noctis lumen verbum filius pater mater frater soror victis victor victoria " +
          "hostis miles plaga plagaque dominatus simulacrum simulacra solium solio inanis fixere sapientes sapiens " +
          "pelliciuntur currunt curro nefas vetitum vetat vetus ferox feroces necessitas necessitudinis semota " +
          "corripiet gradum gradus tarda tardus letum leti letifer vosmet coelica coelum premet premo vastus vastum " +
          "suimet oculis oculus estis vestris noster vestrum vestri proditi prodo condemus condemno aequum aequus album " +
          "albus sidus suscipite suscipio motam motus quatite quatio incohemus incoho mecum tenebras tenebra initis ineo " +
          "ruinis ruina aurora orietur orior servati servo Anastasia susurro resonat clades clado indiges indigeo vacuum " +
          "vacuus fatuus fatuum tinea fio vade retro retroque tragico tragicus comoeda suspiro requies requiescat " +
          "resurgito alluceto expergiscor " +
          "agnus dei benedictus excelsis spiritus sanctus peccata mundi gloria excelsis deo";
        var toks = list.split(/\s+/);
        for (var i = 0; i < toks.length; i++) if (toks[i]) out[toks[i]] = 2;
        return out;
      })(),
      shapes: [
        [/(?:us|um|ibus|orum|arum|tur|ntur)$/, 2], [/(?:ae|oe)$/, 2], [/x$/, 2], [/(?:gn|ph|th)/, 1],
        // 拉丁语的词大多以辅音收尾（Vosmet vetat res coelica）—— 英语常用词不算
        [/[bcdfghjklmnpqrstvwxz]$/, 1],
      ],
    },
    pt: {
      min: 4,
      hard: [[/[\u00E3\u00F5]/, 3], [/[nh]h/, 2], [/[\u00E1\u00E2\u00E9\u00EA\u00ED\u00F3\u00F4\u00FA\u00E0\u00E7]/, 3]],
      words: {
        o: 1, a: 1, os: 1, as: 1, um: 1, uma: 2, de: 1, do: 1, da: 1, dos: 2, das: 2, em: 1, no: 1, na: 1,
        que: 2, n\u00E3o: 2, sim: 1, com: 2, para: 2, por: 1, se: 1, eu: 2, tu: 1, ele: 2, ela: 2, n\u00F3s: 2,
        voc\u00EA: 2, meu: 2, minha: 2, seu: 1, sua: 2, este: 2, esta: 2, isso: 2, aquilo: 2, mais: 2, como: 2,
        mas: 2, muito: 2, j\u00E1: 2, sempre: 2, nunca: 2, cora\u00E7\u00E3o: 2, amor: 1, vida: 2, mundo: 1,
        tempo: 2, noite: 2, dia: 1, luz: 1, mar: 1, flor: 1, saudade: 2, destino: 2, esperan\u00E7a: 2, alma: 2,
      },
      shapes: [
        [/(?:\u00E3o|\u00F5e|nh|lh)$/, 2], [/(?:eiro|eira|\u00E7\u00E3o|mente)$/, 2], [/(?:ss|\u00E7)/, 1],
      ],
    },
    nl: {
      min: 4,
      hard: [[/ij/, 3], [/[\u00E9\u00E8\u00EA\u00EB\u00EF\u00F6\u00FC]/, 2]],
      words: {
        de: 1, het: 2, een: 2, en: 1, van: 2, ik: 2, is: 1, in: 1, op: 1, dat: 2, wat: 2, niet: 2, met: 2,
        voor: 2, aan: 2, bij: 2, om: 1, te: 1, maar: 2, ook: 2, als: 2, dan: 1, man: 1, kind: 2, wind: 1,
        hand: 1, land: 1, water: 2, huis: 2, boom: 2, bloem: 2, tijd: 2, nacht: 2, licht: 2, hart: 2,
        leven: 2, dood: 2, zijn: 2, haar: 2, mijn: 2, jouw: 2, wij: 2, jij: 2, hij: 2, zij: 2, ze: 1,
        hebben: 2, worden: 2, zal: 2, kan: 2, moet: 2, waarom: 2, omdat: 2, hoe: 2, waar: 2, nooit: 2,
        altijd: 2, samen: 2, ziel: 2, liefde: 2, dromen: 2, droom: 2, hemel: 2, aarde: 2, vuur: 2,
      },
      shapes: [[/(?:sch|oe|ui|eu|ou|aa|ee|oo|uu)/, 1], [/(?:lijk|heid|je)$/, 2]],
    },
    sw: {
      min: 3,
      /*
       * 必须**真的命中一个斯瓦希里语词**才认。
       * 只靠词形分（"元音收尾"）不够：法语行、罗马音行（`PA PI PU PE PO…`）
       * 几乎每个词都是元音收尾，会被误判成斯瓦希里语 —— 用户报的罗马音节行
       * 就是这么被带歪的。
       */
      needWords: true,
      hard: [[/ng['\u2019]/, 3]],
      words: {
        kwa: 2, ya: 1, wa: 1, na: 1, ni: 1, la: 1, za: 1, katika: 3, hii: 2, huyo: 2, yake: 2, yetu: 2,
        wako: 2, wetu: 2, kama: 2, tena: 2, mpaka: 2, ndoto: 2, majina: 2, mashujaa: 2, shujaa: 2, dunia: 2,
        moto: 2, mbingu: 2, ardhi: 2, nchi: 2, taifa: 2, watu: 2, vizazi: 2, ushujaa: 2, ukuu: 2, milele: 2,
        rudi: 2, rudini: 2, nyumbani: 2, nyimbo: 2, sana: 2, sasa: 2, marefu: 2, maisha: 2, wimbo: 2,
        usiku: 2, giza: 2, mwanga: 2, hadithi: 2, heshima: 2, warithi: 2, waka: 2, daima: 2, waangaza: 2,
        ashinda: 2, ndugu: 2, ati: 2, kweli: 2, kifo: 2, hapana: 2, kumbukeni: 2, andameni: 2, uwanjani: 2,
        jamaa: 2, matumaini: 2, mbeleni: 2, malengo: 2, zuri: 2, safi: 2, sawa: 2, vuma: 2, raha: 2,
        nguvu: 2, kelele: 2, sikiliza: 2, zitakuongoza: 2, damu: 2, yoyote: 2, geuka: 2, alfajiri: 2,
        utukufu: 2, beba: 2, silaha: 2, pigana: 2, mwishowe: 2, shambulia: 2, unasafirini: 2, mnachagueni: 2,
        matakwa: 2, unachagua: 2, ajili: 2, majivuni: 2, mnaunguweni: 2, unaunguwa: 2, tutaunguza: 2,
        wimbo: 2, na: 2, malaika: 2, moyo: 2, nafsi: 2, roho: 2, jua: 2, mwezi: 2, nyota: 2, bahari: 2,
        mlima: 2, safari: 2, rafiki: 2, mama: 2, baba: 2, mtoto: 2, mji: 2, kijiji: 2, shule: 2,
      },
      shapes: [[/(?:mb|nd|ng|nj|nz|ny|kw|mw|sw|ch|sh|dh|gh|th)/, 1], [/[aeiou]$/, 1]],
    },
    pinyin: {
      min: 4,
      // 没有声调符号就得靠韵母形状（zh/ch/sh/x/q + 复韵母）
      hard: [[/[\u0101\u00E1\u01CE\u00E0\u0113\u00E9\u011B\u00E8\u012B\u00ED\u01D0\u00EC\u014D\u00F3\u01D2\u00F2\u016B\u00FA\u01D4\u00F9\u01D6\u01D8\u01DA\u01DC]/, 4], [/\u00FC/, 3]],
      words: {
        wo: 2, ni: 2, ta: 2, men: 2, de: 1, le: 1, ma: 2, ne: 1, ba: 1, zai: 2, you: 1, mei: 2, bu: 2,
        shi: 2, hen: 2, hao: 2, xie: 2, ai: 1, yong: 2, hui: 2, gei: 2, zhe: 2, na: 1, shui: 2, shei: 2,
        shen: 2, yao: 2, xiang: 2, zhidao: 2, yongyuan: 2, shijie: 2, xin: 2, meng: 2, tian: 2, di: 1,
        feng: 2, yue: 2, guang: 2, hua: 2, xing: 2, qing: 2, chun: 2, xia: 2, dong: 2, qiu: 2,
      },
      shapes: [[/(?:zh|ch|sh)/, 2], [/^[xq]/, 2], [/(?:iang|iong|uang|ueng|\u00FCe|\u00FCn)/, 2], [/(?:ong|ing|ian|uan)$/, 1]],
    },
    ru: {
      min: 1,
      hard: [[/[\u0400-\u04FF]/, 9]],
      words: {},
      shapes: [],
    },
    el: {
      min: 1,
      hard: [[/[\u0370-\u03FF\u1F00-\u1FFF]/, 9]],
      words: {},
      shapes: [],
    },
  };

  function wordsOf(text) {
    var s = lower(text).replace(/[\u2019']/g, "");
    var parts = s.split(/[^a-z\u00E0-\u024F\u0400-\u04FF\u0370-\u03FF\u1F00-\u1FFF]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
    return out;
  }

  /**
   * 一个词的分数（供打分和 fits 共用）。
   * 顺序很关键：**这种语言自己的词表优先**（拉丁语的 in / 德语的 du 在英语里也有，
   * 但它们正是判据），表里没有而且是英语常用词的才倒扣 —— 而且**不给形状分**
   * （`you` 也满足"元音收尾"，给了形状分就把英语惩罚抵消掉了，英文行会算成斯瓦希里语）。
   */
  function wordScore(id, w) {
    var sig = SIGNALS[id];
    var own = sig.words[w] ? sig.words[w] : 0;
    /*
     * 英语常用词：只认"这种语言自己的词表"里写没写（拉丁语的 in、德语的 du 都在表里），
     * 而且**不给形状分**（`you` 也满足"元音收尾"，给了形状分就把英语惩罚抵消了）。
     * 单个字母（只有 `a` / `i` 在英语表里）不算：那是冠词/代词，也是记号的零件
     * （`A-Z` 里的 A、`(A, B)` 里的 A），fits() 早就按同一个口径忽略了 —— 两处要一致。
     */
    if (w.length > 1 && EN_COMMON[w]) return own;
    var score = own;
    for (var j = 0; j < sig.shapes.length; j++) {
      if (sig.shapes[j][0].test(w)) {
        score += sig.shapes[j][1];
        break;
      }
    }
    return score;
  }

  /** 整行打分 */
  function scoreOf(id, text) {
    var sig = SIGNALS[id];
    if (!sig) return 0;
    var s = lower(text);
    var score = 0;
    var i;
    for (i = 0; i < sig.hard.length; i++) if (sig.hard[i][0].test(s)) score += sig.hard[i][1];
    var words = wordsOf(s);
    for (i = 0; i < words.length; i++) {
      var w = words[i];
      var own = wordScore(id, w);
      if (own) score += own;
      // 单个字母不吃英语惩罚（口径同 wordScore / fits，见那里）
      else if (w.length > 1 && EN_COMMON[w]) score -= 2;
    }
    return score;
  }

  /** 这一行里有没有"只属于这种语言"的词（权重 >= 2 的那种） */
  function hasOwnWord(id, text) {
    var sig = SIGNALS[id];
    var words = wordsOf(text);
    for (var i = 0; i < words.length; i++) if (sig.words[words[i]] >= 2) return true;
    return false;
  }

  /**
   * 这一行的语言（判不出来返回 null）。
   *
   * 做法是"所有候选一起打分、按分数从高到低试"，而不是"谁分高就是谁"：
   * 每个语种后面还有自己的**门槛**（拉丁语要强信号、斯瓦希里语要真的命中一个
   * 斯瓦希里语词、拼音要能切成拼音），门槛没过就顺位给下一个候选 ——
   * 否则会出现"最高分那个被自己的门槛否掉、整行就没人认"（法语行
   * `L'eau dans son courant…` 就这么丢过）。
   */
  function detect(text) {
    var s = String(text == null ? "" : text);
    if (!s) return null;
    if (/[\u0400-\u04FF]/.test(s)) return "ru";
    if (/[\u0370-\u03FF\u1F00-\u1FFF]/.test(s)) return "el";
    /*
     * 有**假名**的行就是日语行，不做外语判定。
     *
     * 用户截图：`Ave Musica...仮面の民は誘う(Fortuna)` 被判成了拉丁语，于是整行
     * 走规则层 —— 手工核过的 `ave アベ`（用户点名"Ave Mujica 官方读 アベ"）被引擎的
     * アヴェ 盖掉；而同一首歌里 `Ave Musica...安らかな世界へ(Lacrima)` 没被判成拉丁语、
     * 读的是词典的 アベ —— 同一个词两行两个读音。
     * 日语歌里的拉丁词该走"词典优先"那条路（和大写单字母、段标同一个道理）：
     * 那一行是日语，不是拉丁语。
     */
    if (/[\u3041-\u3096\u30A1-\u30FA]/.test(s)) return null;

    /*
     * 所有语种一起打分，法语也在里面（门槛交给 passes）。
     * 顺序 = 同分时的优先级（数组顺序就是候选顺序）。
     */
    var ids = ["fr", "de", "la", "pt", "nl", "sw", "pinyin"];
    var cands = [];
    for (var i = 0; i < ids.length; i++) cands.push({ id: ids[i], score: scoreOf(ids[i], s) });
    cands.sort(function (a, b) {
      return b.score - a.score;
    });
    for (var c = 0; c < cands.length; c++) {
      if (passes(cands[c].id, s, cands[c].score)) return cands[c].id;
    }
    return null;
  }

  /** 这个候选过不过得了它自己的门槛 */
  function passes(id, text, score) {
    var sig = SIGNALS[id];
    if (!sig || score < sig.min) return false;
    /*
     * 法语的门槛是 looksFrench：变音符号/省音撇号 + 至少一个法语词，
     * 或者两个以上法语功能词。这一关挡住"英语行/拉丁行被法语词表蹭分"。
     */
    if (id === "fr" && !looksFrench(text)) return false;
    // 有的语言要求"必须命中自己的词"，光靠词形（元音收尾之类）不算
    if (sig.needWords && !hasOwnWord(id, text)) return false;
    var s = lower(text);
    /*
     * 拉丁语要**强信号**：弱信号（-is/-at 结尾、et/in 这类虚词、qu 组合）
     * 在英语里也满地都是（`Question!` 就凑得出分数），只看总分会把英文行读成拉丁语。
     * 强信号只认这几样：ae/oe 双元音、元音 + x 收尾、表里的拉丁实词、-us/-um/-ibus 词尾。
     */
    if (id === "la") {
      var strong = 0;
      if (/(?:ae|oe)/.test(s)) strong += 2;
      if (/[aeiou]x$/.test(s)) strong += 2;
      var lwords = wordsOf(s);
      for (var i = 0; i < lwords.length; i++) {
        var w = lwords[i];
        if (SIGNALS.la.words[w] >= 2) strong += 2;
        if (/(?:us|um|ibus|orum|arum|tur|ntur)$/.test(w)) strong += 2;
      }
      if (strong < 2) return false;
    }
    /*
     * 拼音：声调符号要和"能切成拼音音节"一起看。法语的 è / ô / ç 也是重音字母
     * （`ô chère mère` 全是），只看重音符号会把法语行读成拼音。
     */
    if (id === "pinyin") {
      var toks = wordsOf(s);
      var valid = 0;
      for (var j = 0; j < toks.length; j++) if (pySplit(toks[j])) valid++;
      if (!valid || valid / toks.length < 0.5) return false;
    }
    return true;
  }

  /**
   * 这一行"像不像"某种语言（给**整首投票**兜底用：短句 `Ukuu ukuu` / `Dominatus`
   * 自己分数不够，但整首都是那种语言时应该按那种语言读）。
   * 判据：词形命中率够高，而且**没有英语常用词**（有就一票否决）。
   */
  function fits(id, text) {
    if (!SIGNALS[id]) return false;
    var all = wordsOf(text);
    var words = [];
    for (var k = 0; k < all.length; k++) {
      // 单个字母的英语常用词（`A shujaa` 里的 A）不算"英语证据"：外语里也有冠词/呼语
      if (all[k].length === 1) continue;
      if (EN_COMMON[all[k]]) return false;
      words.push(all[k]);
    }
    if (!words.length) return false;
    var hit = 0;
    for (var i = 0; i < words.length; i++) {
      if (wordScore(id, words[i])) hit++;
    }
    if (words.length === 1) return hit === 1 && words[0].length >= 5;
    return hit / words.length >= 0.6;
  }

  /** 这一行是不是西里尔/希腊字母（脚本型语言不看词表） */
  function scriptOf(text) {
    var s = String(text == null ? "" : text);
    if (/[\u0400-\u04FF]/.test(s)) return "ru";
    if (/[\u0370-\u03FF\u1F00-\u1FFF]/.test(s)) return "el";
    return null;
  }

  // ============================================================ 借词表
  //
  // core/loan.js 是 tools/build-loan.js 从 tools/vendor/loan/*.txt 生成的
  // （sljfaq 那几张"日语里来自 X 语的借词"表）。键已经折成小写 ASCII
  // （俄语那张保持西里尔小写），查表时用同一套折法，两边都试。

  function loanTable(id) {
    var loan = dep("WKLoan");
    if (!loan || typeof loan.get !== "function") return null;
    return loan.get(id);
  }

  /** 借词表查询：命中返回日语通行写法，没有返回 null */
  function loanWord(id, raw) {
    var table = loanTable(id);
    if (!table) return null;
    var keys = [];
    var b = bare(raw);
    if (b) keys.push(b);
    var f = foldAscii(b);
    if (f && f !== b) keys.push(f);
    for (var i = 0; i < keys.length; i++) {
      if (table[keys[i]]) return table[keys[i]];
    }
    return null;
  }

  // ============================================================ 同形异音
  //
  // 这些词在**英语词典**里是英语读音，但外语行上必须按那门语言读，
  // 所以它们要绕过"词典优先"的规矩走规则层。
  // 法语那批原来写在 main.js 里，一起挪过来了。

  var HOMOGRAPH = {
    fr: {
      son: 1, plus: 1, grand: 1, cent: 1, pain: 1, main: 1, coin: 1, fin: 1, long: 1, or: 1, fort: 1,
      tour: 1, tout: 1, tous: 1, temps: 1, sur: 1, dans: 1, est: 1, sont: 1, fait: 1, cours: 1, mode: 1,
      note: 1, sage: 1, chair: 1, laid: 1, ver: 1, vers: 1, sol: 1,
    },
    de: {
      die: 1, der: 1, das: 1, den: 1, dem: 1, des: 1, war: 1, was: 1, hat: 1, hast: 1, man: 1, in: 1,
      an: 1, am: 1, im: 1, um: 1, so: 1, also: 1, bist: 1, gut: 1, tag: 1, land: 1, hand: 1, wind: 1,
      kind: 1, wort: 1, herz: 1, ist: 1, sind: 1, und: 1, du: 1, dick: 1, bin: 1, kann: 1, muss: 1,
      will: 1, soll: 1, darf: 1, mag: 1, hier: 1, dort: 1, nun: 1, grad: 1, bald: 1, fast: 1, halt: 1,
    },
    pt: {
      a: 1, o: 1, e: 1, de: 1, do: 1, da: 1, os: 1, as: 1, no: 1, na: 1, em: 1, um: 1, se: 1, por: 1,
      mais: 1, como: 1, sim: 1, mar: 1, sol: 1, flor: 1, dor: 1, cor: 1, amor: 1, vida: 1, mundo: 1,
      dia: 1, luz: 1, paz: 1, feliz: 1, cantar: 1, olhar: 1, noite: 1, tempo: 1, sabor: 1, menor: 1,
    },
    nl: {
      de: 1, het: 1, een: 1, en: 1, van: 1, ik: 1, is: 1, in: 1, op: 1, dat: 1, wat: 1, niet: 1,
      met: 1, voor: 1, aan: 1, bij: 1, om: 1, te: 1, maar: 1, ook: 1, als: 1, dan: 1, man: 1,
      kind: 1, wind: 1, hand: 1, land: 1, water: 1, huis: 1, boom: 1, tijd: 1, nacht: 1, licht: 1,
      hart: 1, leven: 1, dood: 1, ze: 1, kan: 1, zal: 1, moet: 1, was: 1, ben: 1, zijn: 1,
    },
    sw: {
      ni: 1, na: 1, wa: 1, ya: 1, la: 1, za: 1, moto: 1, mama: 1, baba: 1, jua: 1, nafsi: 1,
    },
    la: {}, // 拉丁语行上整行都走规则层（见 main.js 的 needEngine），不需要逐个列
    pinyin: { wo: 1, ni: 1, ta: 1, men: 1, shi: 1, le: 1, de: 1, you: 1, ai: 1 },
    ru: {},
    el: {},
  };

  function homograph(id, key) {
    var t = HOMOGRAPH[id];
    if (!t) return false;
    if (id === "la") return true; // 拉丁语：拼读规则和英语差得太远，整行走规则
    return t[key] === 1;
  }

  // ============================================================ 对外

  var LABEL = {
    fr: "法语", de: "德语", la: "拉丁语", pt: "葡萄牙语", nl: "荷兰语",
    sw: "斯瓦希里语", pinyin: "汉语拼音", ru: "俄语", el: "希腊语",
  };

  var ENGINE = {
    fr: frenchToKatakana,
    de: germanToKatakana,
    la: latinToKatakana,
    pt: portugueseToKatakana,
    nl: dutchToKatakana,
    sw: swahiliToKatakana,
    pinyin: pinyinToKatakana,
    ru: russianToKatakana,
    el: greekToKatakana,
  };

  /**
   * 按语言拼读一个词。九种语言走同一张表，没有特例。
   * 判不出来/抛异常都返回 null —— 调用方（main.js）会退回词典和罗马音层。
   */
  function toKatakana(id, raw) {
    var fn = ENGINE[id];
    if (!fn) return null;
    try {
      return fn(raw);
    } catch (e) {
      return null;
    }
  }

  /**
   * 这个词有没有"日语里就是这么写"的借词读音（core/loan.js，sljfaq 那几张表）。
   * 九种语言都一样：查同一张表，法语也在这里（原来那张表写在 reading.js 里）。
   */
  function word(id, raw) {
    return loanWord(id, raw);
  }

  return {
    ids: ["fr", "de", "la", "pt", "nl", "sw", "pinyin", "ru", "el"],
    labels: LABEL,
    label: function (id) {
      return LABEL[id] || id;
    },
    detect: detect,
    fits: fits,
    scriptOf: scriptOf,
    toKatakana: toKatakana,
    word: word,
    homograph: homograph,
    loanCount: function () {
      var loan = dep("WKLoan");
      return loan && loan.count ? loan.count : 0;
    },
    // 给测试翻表用
    SIGNALS: SIGNALS,
    EN_COMMON: EN_COMMON,
    foldAscii: foldAscii,
    bare: bare,
  };
});
