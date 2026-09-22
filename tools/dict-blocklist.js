/*
 * 生成词表（tools/seed-words-llm.js）里"读错义项"的黑名单。
 *
 * 大模型偶尔会把缩写展开成整词，在歌词里这是错的：
 *   avg  -> アベレージ（average 的缩写）
 *   blvd -> ブールバード（boulevard 的缩写）
 * （`ave` -> アベニュー 也是这一类，那一条在人工词表里定死成 アヴェ 了。）
 *
 * 单独放一个文件是为了只有一个事实来源：tools/build-dict.js 用它过滤，
 * tests/dict.test.js 用它来放行 —— 否则加一条黑名单就会把"生成词都进词典"
 * 这条不变量测试搞红。
 */
"use strict";

module.exports = {
  avg: "缩写展开（アベレージ）",
  blvd: "缩写展开（ブールバード）",
};
