/*
 * 手工的**整首专属读音**条目（tools/build-song-readings.js 会并进 src/core/songs.js，
 * 同一条歌名以这里的为准）。
 *
 * 字段：
 *   title  歌名（**普通字符串**，生成时按"歌名里包含这段文字"匹配，忽略大小写）
 *   marker 备用判据（字符串正则）：歌名读不到时，看整首歌词里有没有这个词
 *   words  小写词 -> 片假名读音（这首歌里这些词就这么读）
 *
 * 加新条目的判断标准：这首歌**把日语词写成了罗马字**（或有官方给的读法），
 * 而我们自己的规则/罗马音层必然读错 —— 也就是"只有这一首里这么读"的那种。
 * 一般英文词（`dream` / `love`）该进的是离线词典，不是这张表。
 */
"use strict";

module.exports = [
  {
    /*
     * 夢現妄想世界（夢限大みゅーたいぷ）—— 用户截图：歌词把日语词写成罗马字，
     * 短横线是长音：MO-SO モーソー（妄想）、SO-ZO ソーゾー（創造）、
     * KYO-SO キョーソー（競争）、YUME ユメ（夢）。
     *
     * 没有这一条时：`MO`/`SO` 恰好被英语读音层读成 モー/ソー（蒙对），
     * 而 `ZO` 走罗马音层读成 **ゾ**、`KYO` 读成 **キョ**（都短了一拍）；
     * 更麻烦的是 `SO-ZO` 在歌词里被**换行拆开**（上一行结尾 `SO-`、下一行 `ZOは海をこえ`），
     * 单看那一行根本不知道是哪个词 —— 所以必须按**整首**判。
     */
    title: "夢現妄想世界",
    marker: "MO-SO|SO-ZO|KYO-SO",
    words: {
      mo: "モー",
      so: "ソー",
      zo: "ゾー",
      kyo: "キョー",
      yume: "ユメ",
    },
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
    // Peaky Peaky（官方 ピキピキ）：我们的规则层读成 ペアクイー，官方是 ピキ
    title: "Peaky Peaky",
    marker: null,
    words: { peaky: "ピキ" },
  },
  {
    // Help me, ERINNNNNN!!（官方 ヘルプミエリン）：`ERINNNNNN` 那些 N 只是拖长，读 エリン
    title: "Help me, ERINNNNNN!!",
    marker: null,
    words: { help: "ヘルプ", me: "ミー", erinnnnnn: "エリン" },
  },
  {
    // Vampire's ∞ pathoS（官方 ヴァンパイアズパトス）—— 带 `∞`，自动切分不收这种花体歌名
    title: "Vampire's ∞ pathoS",
    marker: null,
    words: { "vampire's": "ヴァンパイアズ", pathos: "パトス" },
  },
];
