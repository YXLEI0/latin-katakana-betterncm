# 西文字母片假名注音 · western-katakana

在日语歌歌词的拉丁字母 / 西里尔字母 / 希腊字母上方标注片假名读音

![截图](src/preview.png)

## 环境

- 网易云音乐 **3.x** (在 3.1.39 上实测)
- [BetterNCM](https://github.com/std-microblock/BetterNCM) **1.3.0+**

## 安装

从 [Releases](../../releases) 下载 `western-katakana.plugin`, 放进 BetterNCM 的插件目录后重启网易云

自己打包:

```bash
npm install
npm run build            # 产出 builds/western-katakana.plugin
npm run install:plugin   # 顺便复制到 C:\betterncm\plugins
```

## 说明

- 读音按五层顺序取: **离线词典** (6470 条) > **日式罗马音** > **大模型校正** > **免费接口** > **英文音译规则**, 顺序可以在设置面板里上下调
- 推荐填一个大模型 API Key (默认 DeepSeek, 任何 OpenAI 兼容接口都行): **只存本机 localStorage**, 留空则这一层不工作、自动退回免费接口。按「词 + 它所在的那句歌词」缓存, 所以同一个词在不同句子里会分别判断
- 模型答过两次、读音一致的词会**自动沉淀成离线词条**, 以后不再问模型; 面板「操作 → 导出词库素材」可以把攒下来的词筛进离线词典 (`npm run promote:learned`)
- 记号 (`D/N/A` / `R&B` / `X-Y`) 按**字母名**逐字母读; 缩写 (`you're` / `I'll` / `don't`) 拆成"词干 + 尾巴"; 不发音字母也认 (`knock` ノック, `climb` クライム, `subtle` サトル)
- **西文各语种另有各自的拼读**: 德语 / 拉丁语 / 葡萄牙语 / 荷兰语 / 斯瓦希里语 / 汉语拼音 / 法语 / 俄语(西里尔) / 希腊语。按**整行**判定语种, 所以同一首歌里的英文行照旧按英语读 —— `die Ruinenstadt` ディー・ルイーネンスタト, `Novum mundum` ノヴム・ムンドゥム, `Shambulia` シャンブリア, `Виват Анастасия` ヴィヴァト・アナスタシヤ
- 另有 [sljfaq](https://www.sljfaq.org/afaq/gairaigo.html) 的**法语 / 德语 / 荷兰语 / 葡萄牙语 / 俄语**借词表 (`tools/vendor/loan/`, `npm run build:loan`, 共 309 条), 记的是**日语通行写法** (`Lied` リート, `bier` ビール, `pao` パン, `норма` ノルマ), 只在该语言的行上生效 —— `rose` 在法语行是 ロゼ、英文行仍是 ローズ
- 只标歌词原文行和播放栏标题, 含汉字的行也照标; 中文翻译层、罗马音层、制作信息行 (作词/作曲/编曲/演唱/曲绘…) 和版权行 (`Copyright` / `©` / `℗`) 跳过
- **RNP 的「复制模式」(总览视图) 整块不注音**, 复制歌词时不会带上注音文字
- **非日语歌** (整首歌词一个假名都没有的纯英文 / 西文各语种 / 中文歌) 可选是否标注, 见设置面板「范围」
- 可以和 [片假名终结者](https://github.com/YXLEI0/katakana-terminator-betterncm)、[jp-furigana](https://github.com/Leleawa/jp-furigana) 同时开着; jp-furigana 要先打共存补丁: `npm run patch:furigana`
- 桌面歌词无效, 那是原生窗口而不是网页
- 读音来源、规则依据、词典怎么生成、排障、实现要点、已知限制见 [docs/notes.md](docs/notes.md)

## 许可

插件自身的代码采用 **MIT** 协议, 见 [LICENSE](LICENSE)

读音词典的数据来源与分发注意事项见 [NOTICE.md](NOTICE.md)
