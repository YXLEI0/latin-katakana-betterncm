/*
 * 运行期沉淀下来的词（生成物，勿手改）。
 *
 * 来源：面板「操作 → 导出词库素材」（或控制台 `LK.exportWordsJson()`）导出的 JSON，
 *      经 `npm run promote:learned` 筛掉"读音不一致 / 只见过一次 / 在黑名单 /
 *      人工词表已有 / 两可短音节"之后再写进这里。
 * 生成命令：
 *   npm run promote:learned          # 读 data/learned.json，筛完写本文件
 *   npm run build:dict               # 再合并进 src/core/dict.js
 *
 * 目前为空：还没有导出过素材。听几首歌（开着大模型）之后按上面两步跑一遍。
 */
module.exports = [];
