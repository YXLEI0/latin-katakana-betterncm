# 第三方组件与数据来源

本插件由 **YXLEI0** 维护：https://github.com/YXLEI0/western-katakana-betterncm

本插件**没有**打包任何第三方运行时库（不需要 kuromoji、不需要分词词典）。
分发的文件只有本仓库 `src/` 下的代码、一份生成的读音词典和一张预览图。

## 1. 与 Katakana Terminator 的关系

- 项目：https://github.com/Arnie97/katakana-terminator
- 作者：Arnie97 及贡献者
- 许可：MIT

本插件**不是**那个插件的移植，方向正好相反：

| | 输入 | 注出来的东西 |
| --- | --- | --- |
| Katakana Terminator | 片假名外来语 | 英文原词 |
| 本插件 | 西文字母词 | 片假名读音 |

沿用过来的是 **DOM 注音这一层的实现**（`src/core/annotate.js`）：文本节点切分、
`<ruby>` 与降级 `<span>` 两套排版、改动记录与失效判定、`age` 闸门、
和 `window.__ktRepairLine` 同步修复钩子。这些都是同一位作者在
[katakana-terminator-betterncm](https://github.com/YXLEI0/katakana-terminator-betterncm)
上真机踩出来的（那一版才是在移植原版油猴脚本），本插件直接继承。
种子词表里的一部分读音也来自那份移植版的离线词典（见第 2 节）。

## 2. 离线读音词典 `src/core/dict.js`

- 生成脚本：`tools/build-dict.js`（**不联网**）
- 唯一数据源：`tools/seed-words.js`（英文 → 片假名读音）
- 数据来源：
  1. **反转** katakana-terminator 移植版的离线词典（那份本来就是「片假名外来语 → 英文原词」，
     反转过来正好是「英文 → 片假名读音」，而且是日语里的真实写法，不是规则拼出来的）；
  2. 手工补充的 J-pop 歌词高频词与变形词（`shining` / `dancing` / `stories` 这类
     规则音译一定会拼错的）。

生成脚本会拦住三类脏数据：英文侧不是纯小写字母、读音不是纯片假名（可带长音符）、
同一个词有两种写法。`npm run build:dict` 是开发步骤，**不属于**插件的运行流程。

运行时还会用到另外两层读音来源，都不依赖本词典：

- **罗马音切分**：把 `sekai` / `shinjiteru` 这类罗马音歌词按音节转成片假名；
- **英文音译规则**：兜底，永远给得出结果，但会标记为「没把握」；
- **在线校正**：Google 翻译（`translate.google.cn` 一类接口，en→ja），
  **只接受纯片假名的返回值**。这是一个未公开文档的接口，可能随时失效、限流或改变行为；
  失效时插件自动退回上面三层本地结果，功能不受影响。
  使用者需要自行判断在所在地与自身用途下这样做是否合适。

## 3. 开发期依赖

`jsdom`（MIT）仅用于单元测试（`devDependencies`），**不会**被打进 `.plugin` 包。

## 4. 参考实现

- [Leleawa/jp-furigana](https://github.com/Leleawa/jp-furigana)：同生态的「日语歌词振假名」插件。
  本插件参考了它的 BetterNCM 生命周期写法、设置面板的 `data-k` 绑定结构、
  `MutationObserver` 记录清理方式，以及判断内核是否支持 ruby 排版的实测探针。
  未复制其代码，但思路来自该项目的公开实现。
  三个插件同时开着时互不打架，靠的是 `tools/patch-jp-furigana.js`
  给它打的共存补丁（见 README「和另外两个插件共存」）。
- [BetterNCM](https://github.com/BetterNCM)：插件框架与 manifest 规范。
