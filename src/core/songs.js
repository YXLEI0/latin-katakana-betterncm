/*
 * **整首专属读音**：这首歌里的这些词就这么读（**自动生成 + 手工条目，勿手改**）。
 *
 * 由 tools/build-song-readings.js 生成（跑 npm run build:songs）：
 *   1. tools/vendor/sekai/musics.json 的歌名官方读音，按词切开（只在那一首里生效）——
 *      纯西文、西文 + 假名汉字、带符号的都收（假名汉字符号那部分当"通配段"对齐）；
 *   2. tools/song-readings-hand.js 的手工条目，同一条以手工为准。
 *      手工条目**不限于** Project Sekai：例如 BanG Dream! 的「夢現妄想世界」
 *      （夢限大みゅーたいぷ）就不在那份主数据里，是用户点名按整首钉的。
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
    { title: new RegExp("potatoになっていく", "i"), marker: null, words: { "potato": "ポテト" } },
    { title: new RegExp("Gimme×Gimme", "i"), marker: null, words: { "gimme": "ギミ" } },
    { title: new RegExp("Color of Drops", "i"), marker: null, words: { "color": "カラー", "drops": "ドロップス", "of": "オブ" } },
    { title: new RegExp("サンドリヨン 10th Anniversary", "i"), marker: null, words: { "anniversary": "アニバーサリー" } },
    { title: new RegExp("ODDS＆ENDS", "i"), marker: null, words: { "ends": "エンズ", "odds": "オッズ" } },
    { title: new RegExp("Happy Halloween", "i"), marker: null, words: { "halloween": "ハロウィン", "happy": "ハッピー" } },
    { title: new RegExp("ぼくらの16bit戦争", "i"), marker: null, words: { "bit": "ビット" } },
    { title: new RegExp("豚になってyeah yeah", "i"), marker: null, words: { "yeah": "イエイ" } },
    { title: new RegExp("Mr\\. Showtime", "i"), marker: null, words: { "mr": "ミスター", "showtime": "ショウタイム" } },
    { title: new RegExp("imaginary love story", "i"), marker: null, words: { "imaginary": "イマジナリー", "love": "ラブ", "story": "ストーリー" } },
    { title: new RegExp("JUMPIN’ OVER !", "i"), marker: null, words: { "jumpin’": "ジャンピン", "over": "オーバー" } },
    { title: new RegExp("On&On", "i"), marker: null, words: { "on": "オン" } },
    { title: new RegExp("成敗いたAAAAAす！", "i"), marker: null, words: { "aaaaa": "アアアアア" } },
    { title: new RegExp("ワールド・ランプシェード \\[reunion\\]", "i"), marker: null, words: { "reunion": "リユニオン" } },
    { title: new RegExp("Snow Fairy Story", "i"), marker: null, words: { "fairy": "フェアリー", "snow": "スノウ", "story": "ストーリー" } },
    { title: new RegExp("Fondant Step", "i"), marker: null, words: { "fondant": "フォンダン", "step": "ステップ" } },
    { title: new RegExp("フィッシュアンドTips", "i"), marker: null, words: { "tips": "チップス" } },
    { title: new RegExp("SAN値直葬", "i"), marker: null, words: { "san": "サン" } },
    { title: new RegExp("MASTER高難易度楽曲メドレー", "i"), marker: null, words: { "master": "マスター" } },
    { title: new RegExp("プロセカULTIMATE楽曲メドレー", "i"), marker: null, words: { "ultimate": "アルティメット" } },
    { title: new RegExp("CRASH THE PARTY", "i"), marker: null, words: { "crash": "クラッシュ", "party": "パーティ", "the": "ザ" } },
    { title: new RegExp("Internet Junk Junkie", "i"), marker: null, words: { "internet": "インターネット", "junk": "ジャンク", "junkie": "ジャンキー" } },
    { title: new RegExp("鎖の少女-Re Alive-", "i"), marker: null, words: { "alive": "アライブ" } },
    { title: new RegExp("Catch the Wave", "i"), marker: null, words: { "catch": "キャッチ", "the": "ザ", "wave": "ウェーブ" } },
    { title: new RegExp("ヒバナ -Reloaded-", "i"), marker: null, words: { "reloaded": "リローデッド" } },
    { title: new RegExp("モザイクロール \\(Reloaded\\)", "i"), marker: null, words: { "reloaded": "リローデッド" } },
    { title: new RegExp("Leia - Remind", "i"), marker: null, words: { "leia": "レイア", "remind": "リマインド" } },
    { title: new RegExp("the EmpErroR", "i"), marker: null, words: { "emperror": "エンペラー", "the": "ジ" } },
    { title: new RegExp("DAYBREAK FRONTLINE", "i"), marker: null, words: { "daybreak": "デイブレイク", "frontline": "フロントライン" } },
    { title: new RegExp("CIRCUS PANIC!!!", "i"), marker: null, words: { "circus": "サーカス", "panic": "パニック" } },
    { title: new RegExp("Twilight Melody", "i"), marker: null, words: { "melody": "メロディ", "twilight": "トワイライト" } },
    { title: new RegExp("Disco No\\.39", "i"), marker: null, words: { "disco": "ディスコ", "no": "ナンバー" } },
    { title: new RegExp("PaⅢ\\.SENSATION", "i"), marker: null, words: { "sensation": "センセーション" } },
    { title: new RegExp("ULTRA C", "i"), marker: null, words: { "c": "シー", "ultra": "ウルトラ" } },
    { title: new RegExp("Bad Apple!! feat\\.SEKAI", "i"), marker: null, words: { "apple": "アップル", "bad": "バッド", "feat": "フィーチャリング", "sekai": "セカイ" } },
    { title: new RegExp("erase or zero", "i"), marker: null, words: { "erase": "イレース", "or": "オア", "zero": "ゼロ" } },
    { title: new RegExp("99 Glooms", "i"), marker: null, words: { "glooms": "グルームズ" } },
    { title: new RegExp("from Y to Y", "i"), marker: null, words: { "from": "フロム", "to": "トゥ", "y": "ワイ" } },
    { title: new RegExp("p\\.h\\.", "i"), marker: null, words: { "h": "ハー", "p": "ペー" } },
    { title: new RegExp("I know 愛脳\\.", "i"), marker: null, words: { "i": "アイ", "know": "ノー" } },
    { title: new RegExp("Fire◎Flower \\(Rerec\\)", "i"), marker: null, words: { "fire": "ファイア", "flower": "フラワー" } },
    { title: new RegExp("Intergalactic Bound", "i"), marker: null, words: { "bound": "バウンド", "intergalactic": "インターギャラクティック" } },
    { title: new RegExp("Peaky Peaky", "i"), marker: null, words: { "peaky": "ピーキー" } },
    { title: new RegExp("Help me, ERINNNNNN!!", "i"), marker: null, words: { "erinnnnnn": "エーリン", "help": "ヘルプ", "me": "ミー" } },
    { title: new RegExp("Vampire's ∞ pathoS", "i"), marker: null, words: { "pathos": "パトス", "vampire's": "ヴァンパイアズ" } },
  ];

  return { list: list, count: list.length };
});
