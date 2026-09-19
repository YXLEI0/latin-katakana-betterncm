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
   * 一个"词"：字母开头结尾，中间允许撇号和连字符（don't / e-mail / rock'n'roll）。
   * 撇号用 ASCII 的和全角的都收 —— 歌词里两种都见过。
   */
  var RE_WORD = /[A-Za-z](?:[A-Za-z]|['\u2019-](?=[A-Za-z]))*/g;

  /** 这段文字里有没有拉丁字母 */
  function hasLatin(text) {
    // 注意必须先挡掉空值：/[A-Za-z]/.test(null) 会把参数转成字符串 "null"，
    // 于是返回 true —— 后面那句 scan 就会去扫一个不存在的文本。
    if (!text) return false;
    return /[A-Za-z]/.test(String(text));
  }

  /**
   * 切成一个个词，返回 [{ text, start, end, norm }]。
   *
   * norm 是拿去查读音的形式：小写、去掉撇号连字符。查表、音译都用它 ——
   * 保留原始 text 是为了原样把底字写回 DOM（底字必须是歌词原文，一个字符不改）。
   */
  function scan(text) {
    var out = [];
    if (!text) return out;
    RE_WORD.lastIndex = 0;
    var m;
    while ((m = RE_WORD.exec(text)) !== null) {
      var raw = m[0];
      out.push({
        text: raw,
        start: m.index,
        end: m.index + raw.length,
        norm: normalize(raw),
      });
      // 零宽匹配保护：正常不会发生，但正则改坏了不能让浏览器卡死
      if (m.index === RE_WORD.lastIndex) RE_WORD.lastIndex++;
    }
    return out;
  }

  /** 查表/音译用的规范形式：小写、去掉撇号与连字符 */
  function normalize(text) {
    if (!text) return "";
    return String(text)
      .toLowerCase()
      .replace(/['\u2019-]/g, "");
  }

  /*
   * 不值得标的：单字母。
   *
   * 「a」「I」这种一个字母的，标上去只是噪音（而且 I 是日语里的「い」还是英语的
   * 「アイ」本来就说不清）。真需要标的词不会只有一个字母。
   *
   * 注意**不做**"常见词不标"的白名单：用户要的就是歌词里的拉丁词都标上读音，
   * the / and 这类也照标 —— 否则一行里漏一半，看着更奇怪。
   */
  function looksReadable(token) {
    return !!token && token.norm.length >= 2;
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
    RE_WORD: RE_WORD,
  };
});
