/*
 * **整首专属读音**：这首歌里的这些词就这么读（**自动生成 + 手工条目，勿手改**）。
 *
 * 由 tools/build-song-readings.js 生成（跑 npm run build:songs）：
 *   1. tools/vendor/sekai/musics.json 里多词歌名的官方读音，按词切开（只在那一首里生效）；
 *   2. tools/song-readings-hand.js 的手工条目（歌名或歌词识别词 + 词表），同一条以手工为准。
 *
 * 结构：{ title, marker, words }
 *   title  歌名正则（播放栏那行，命中即这一首）
 *   marker 备用判据：整首歌词里出现这个词就认（歌名读不到 / 标题写法不同时用）
 *   words  小写词 -> 片假名读音
 *
 * 命中之后：这些读音排在**所有层前面**（来源 `song`，层序 -1，大模型也不会被咨询）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKSongs = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var list = [
    { title: new RegExp("Gimme×Gimme", "i"), marker: null, words: { "gimme": "ギミ" } },
    { title: new RegExp("Leia - Remind", "i"), marker: null, words: { "leia": "レイア", "remind": "リマインド" } },
    { title: new RegExp("Color of Drops", "i"), marker: null, words: { "color": "カラー", "drops": "ドロップス", "of": "オブ" } },
    { title: new RegExp("from Y to Y", "i"), marker: null, words: { "from": "フロム", "to": "トゥ", "y": "ワイ" } },
    { title: new RegExp("the EmpErroR", "i"), marker: null, words: { "emperror": "エンペラー", "the": "ジ" } },
    { title: new RegExp("Happy Halloween", "i"), marker: null, words: { "halloween": "ハロウィン", "happy": "ハッピー" } },
    { title: new RegExp("DAYBREAK FRONTLINE", "i"), marker: null, words: { "daybreak": "デイブレイク", "frontline": "フロントライン" } },
    { title: new RegExp("CIRCUS PANIC!!!", "i"), marker: null, words: { "circus": "サーカス", "panic": "パニック" } },
    { title: new RegExp("imaginary love story", "i"), marker: null, words: { "imaginary": "イマジナリー", "love": "ラブ", "story": "ストーリー" } },
    { title: new RegExp("Snow Fairy Story", "i"), marker: null, words: { "fairy": "フェアリー", "snow": "スノウ", "story": "ストーリー" } },
    { title: new RegExp("Fondant Step", "i"), marker: null, words: { "fondant": "フォンダン", "step": "ステップ" } },
    { title: new RegExp("CRASH THE PARTY", "i"), marker: null, words: { "crash": "クラッシュ", "party": "パーティ", "the": "ザ" } },
    { title: new RegExp("Internet Junk Junkie", "i"), marker: null, words: { "internet": "インターネット", "junk": "ジャンク", "junkie": "ジャンキー" } },
    { title: new RegExp("Catch the Wave", "i"), marker: null, words: { "catch": "キャッチ", "the": "ザ", "wave": "ウェーブ" } },
    { title: new RegExp("夢現妄想世界", "i"), marker: new RegExp("MO-SO|SO-ZO|KYO-SO"), words: { "kyo": "キョー", "mo": "モー", "so": "ソー", "yume": "ユメ", "zo": "ゾー" } },
    { title: new RegExp("Intergalactic Bound", "i"), marker: null, words: { "bound": "バウンド", "intergalactic": "インターギャラクティック" } },
    { title: new RegExp("Peaky Peaky", "i"), marker: null, words: { "peaky": "ピキ" } },
    { title: new RegExp("Help me, ERINNNNNN!!", "i"), marker: null, words: { "erinnnnnn": "エリン", "help": "ヘルプ", "me": "ミー" } },
    { title: new RegExp("Vampire's ∞ pathoS", "i"), marker: null, words: { "pathos": "パトス", "vampire's": "ヴァンパイアズ" } },
  ];

  return { list: list, count: list.length };
});
