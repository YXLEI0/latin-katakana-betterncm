/*
 * 手工的整首专属读音条目（tools/build-song-readings.js 会并进 src/core/songs.js，
 * 同一条歌名以这里的为准）。
 *
 * 字段：
 *   title  歌名（普通字符串，生成时按"歌名里包含这段文字"匹配，忽略大小写）
 *   marker 备用判据（字符串正则）：歌名读不到时，看整首歌词里有没有这个词
 *   words  小写词 -> 片假名读音（这首歌里这些词就这么读）
 *
 * 加新条目的判断标准：这首歌把日语词写成了罗马字（或有官方给的读法），
 * 而我们自己的规则/罗马音层必然读错 —— 也就是"只有这一首里这么读"的那种。
 * 一般英文词（`dream` / `love`）该进的是离线词典，不是这张表。
 *
 * 手工条目的前提：读音要有官方来源（`tools/vendor/sekai/musics.json` 那份主数据，
 * 或别的能查到的官方读法），我们只是把"整串读音"按词切开。自己按词义猜的不进表 ——
 * 用户点名：`夢現妄想世界`（夢限大みゅーたいぷ，不在那份主数据里）不要放进这一档。
 */
"use strict";

module.exports = [
  /*
   * 下面这些是"官方读音切分过不了自动检查"的（我们的候选读音错得太多，
   * 自动切分没法自证可信），按 vendor/sekai 的官方读音手工切开。
   * 每条后面的注释是官方整串读音，改的时候照着对。
   */
  {
    /*
     * the EmpErroR -> じえんぺらー（标题里的 `the` 就是 ジ，不是 ザ）。
     * marker 用歌名里的 `EmpErroR` 这种独特写法：歌名读不到时靠歌词认出来。
     */
    title: "the EmpErroR",
    marker: "EmpErroR",
    words: { the: "ジ", emperror: "エンペラー" },
  },
  {
    // ヒバナ -Reloaded- -> ひばなりろーでっど
    title: "ヒバナ -Reloaded-",
    marker: null,
    words: { reloaded: "リローデッド" },
  },
  {
    // モザイクロール (Reloaded) -> もざいくろーるりろーでっど
    title: "モザイクロール (Reloaded)",
    marker: null,
    words: { reloaded: "リローデッド" },
  },
  {
    // Leia - Remind -> れいありまいんど
    title: "Leia - Remind",
    marker: null,
    words: { leia: "レイア", remind: "リマインド" },
  },
  {
    // the EmpErroR -> じえんぺらー（标题里的 `the` 就是 ジ，不是 ザ）
    title: "the EmpErroR",
    marker: null,
    words: { the: "ジ", emperror: "エンペラー" },
  },
  {
    // DAYBREAK FRONTLINE -> でいぶれいくふろんとらいん
    title: "DAYBREAK FRONTLINE",
    marker: null,
    words: { daybreak: "デイブレイク", frontline: "フロントライン" },
  },
  {
    // CIRCUS PANIC!!! -> さーかすぱにっく
    title: "CIRCUS PANIC!!!",
    marker: null,
    words: { circus: "サーカス", panic: "パニック" },
  },
  {
    // Twilight Melody -> とわいらいとめろでぃ（官方就是短音 メロディ）
    title: "Twilight Melody",
    marker: null,
    words: { twilight: "トワイライト", melody: "メロディ" },
  },
  {
    // Disco No.39 -> でぃすこなんばーさーてぃーないん（`No.` 在这首里是 ナンバー）
    title: "Disco No.39",
    marker: null,
    words: { disco: "ディスコ", no: "ナンバー" },
  },
  {
    // PaⅢ.SENSATION -> ぱっしょねーとすりーどっとせんせーしょん
    // （`PaⅢ` 那个梗拆不干净，只钉 SENSATION）
    title: "PaⅢ.SENSATION",
    marker: null,
    words: { sensation: "センセーション" },
  },
  {
    // ULTRA C -> うるとらしー
    title: "ULTRA C",
    marker: null,
    words: { ultra: "ウルトラ", c: "シー" },
  },
  {
    // Bad Apple!! feat.SEKAI -> ばっどあっぷるふぃーちゃりんぐせかい
    title: "Bad Apple!! feat.SEKAI",
    marker: null,
    words: { bad: "バッド", apple: "アップル", feat: "フィーチャリング", sekai: "セカイ" },
  },
  {
    // erase or zero -> いれーすおあぜろ
    title: "erase or zero",
    marker: null,
    words: { erase: "イレース", or: "オア", zero: "ゼロ" },
  },
  {
    // 99 Glooms -> ないんてぃないんぐるーむず
    title: "99 Glooms",
    marker: null,
    words: { glooms: "グルームズ" },
  },
  {
    // from Y to Y -> ふろむわいとぅわい（这首里两个 Y 都读 ワイ）
    title: "from Y to Y",
    marker: null,
    words: { from: "フロム", to: "トゥ", y: "ワイ" },
  },
  {
    // p.h. -> ぺーはー（记号在读法上是两个字母名，但这首里是"ペーハー"）
    title: "p.h.",
    marker: null,
    words: { p: "ペー", h: "ハー" },
  },
  {
    // I know 愛脳. -> あいのーあいのう（`know` 在这里是梗，读 ノー）
    title: "I know 愛脳.",
    marker: null,
    words: { i: "アイ", know: "ノー" },
  },
  {
    // Fire◎Flower (Rerec) -> ふぁいあふらわー
    title: "Fire◎Flower (Rerec)",
    marker: null,
    words: { fire: "ファイア", flower: "フラワー" },
  },
  {
    /*
     * 自动切分偶尔会切错一格（`Intergalactic Bound` 官方读 インターギャラクティックバウンド，
     * DP 把边界挪了一拍成了 …ティッ + クバウンド）。这种手工钉一下 ——
     * 同一条歌名以手工为准（生成器会把它从自动条目里去掉）。
     */
    title: "Intergalactic Bound",
    marker: null,
    words: { intergalactic: "インターギャラクティック", bound: "バウンド" },
  },
  {
    // Peaky Peaky -> ぴーきーぴーきー
    title: "Peaky Peaky",
    marker: null,
    words: { peaky: "ピーキー" },
  },
  {
    // Help me, ERINNNNNN!! -> へるぷみーえーりん（那些 N 只是拖长）
    title: "Help me, ERINNNNNN!!",
    marker: null,
    words: { help: "ヘルプ", me: "ミー", erinnnnnn: "エーリン" },
  },
  {
    // Vampire's ∞ pathoS -> ヴァンパイアズパトス（带 `∞`，自动切分不收这种花体歌名）
    title: "Vampire's ∞ pathoS",
    marker: null,
    words: { "vampire's": "ヴァンパイアズ", pathos: "パトス" },
  },
];
