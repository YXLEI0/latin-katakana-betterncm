/*
 * 官方歌名读音：Project Sekai 主数据库里**单个西文词**的歌名（共 34 条）。
 *
 * **自动生成，勿手改** —— 由 tools/build-sekai.js 从 tools/vendor/sekai/musics.json 生成，
 * 跑 npm run build:sekai 重新生成（原始数据：sekai-world/sekai-master-db-diff 的 musics.json，
 * 见 https://pjsekai.moe/#/music/<id>）。
 *
 * 为什么收：这些是官方读音（游戏里就这么读），而我们自己的英文音译规则会读错
 * （Nostalogic -> ノサタロギス、CHAOS -> チアオス、needLe -> ネエドドル…）。
 * 只收单词歌名：多词歌名的读音没法逐词归因（the EmpErroR 官方读 ジエンペラー）。
 *
 * 优先级：人工词表（seed-words.js）> 本表 > 运行期沉淀（seed-words-learned.js）> 大模型批量（seed-words-llm.js）。
 */
"use strict";

module.exports = [
  { en: "afterglow", kana: "アフターグロウ" },
  { en: "anima", kana: "アニマ" },
  { en: "arqetype", kana: "アーキタイプ" },
  { en: "blender", kana: "ブレンダー" },
  { en: "blessing", kana: "ブレッシング" },
  { en: "chaos", kana: "カオス" },
  { en: "connecting", kana: "コネクティング" },
  { en: "copycat", kana: "コピーキャット" },
  { en: "dear", kana: "ディアー" },
  { en: "flos", kana: "フロース" },
  { en: "flyway", kana: "フライウェイ" },
  { en: "folern", kana: "フォレン" },
  { en: "glow", kana: "グロウ" },
  { en: "henceforth", kana: "ヘンスフォース" },
  { en: "imawanokiwa", kana: "イマワノキワ" },
  { en: "limbo", kana: "リンボ" },
  { en: "masquerade", kana: "マスカレード" },
  { en: "meteor", kana: "ミーティア" },
  { en: "miku", kana: "ミク" },
  { en: "needle", kana: "ニードル" },
  { en: "nostalogic", kana: "ノスタロジック" },
  { en: "oneself", kana: "ワンセルフ" },
  { en: "packaged", kana: "パッケージド" },
  { en: "sage", kana: "サゲ" },
  { en: "saika", kana: "サイカ" },
  { en: "sairai", kana: "サイライ" },
  { en: "snooze", kana: "スヌーズ" },
  { en: "supernova", kana: "スーパーノヴァ" },
  { en: "surges", kana: "サージズ" },
  { en: "sympathy", kana: "シンパシー" },
  { en: "underwater", kana: "アンダーウォーター" },
  { en: "unpoison", kana: "アンポイズン" },
  { en: "worlders", kana: "ワールダーズ" },
  { en: "yy", kana: "ワイワイ" },
];
