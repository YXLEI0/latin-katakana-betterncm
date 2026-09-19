# 拉丁字母片假名注音 · Latin Katakana for BetterNCM

在日语歌的歌词里，给**拉丁字母**上方标注**片假名读音**。

这是 [片假名终结者](../katakana-terminator) 的反方向：那个把片假名读成英文，
这个把英文/罗马音读成片假名 —— 唱歌时用得上。

```
きらめく  light  と  clover、それから Sekai へ
        ライト      クローバー            セカイ
```

## 它标什么、不标什么

| | 处理 |
| --- | --- |
| 歌词原文行里的拉丁词（`light` / `clover` / `Sekai`） | ✅ 标片假名读音 |
| 含汉字的行 | ✅ 照标 —— 拉丁字母跟振假名不是同一批字，没有让位的理由 |
| 播放栏的歌名 / 歌手 | ✅ 默认也标 |
| RNP 歌词页的**罗马音层**（`rnp-lyrics-line-romaji`） | ❌ 跳过 —— 它本身就是读音，再标是噪音 |
| RNP 歌词页的**中文翻译层**（`rnp-lyrics-line-translated`） | ❌ 跳过 —— 跟日语读音无关 |
| 单个字母（`a` / `I`） | ❌ 不标 —— 只会让行变乱 |
| 制作信息行（作词/作曲/编曲） | ❌ 跳过 |
| 别的注音插件插进来的节点内部（片假名终结者的英文注释、jp-furigana 的振假名） | ❌ 整棵跳过 —— 给注解做注解没有意义（详见「三个插件一起用」） |

## 读音从哪来

四层，按顺序命中（`src/core/reading.js`）：

| 顺序 | 来源 | 例子 | 可信度 |
| --- | --- | --- | --- |
| 1 | **离线词典**（`src/core/dict.js`，491 条） | `clover` → クローバー、`light` → ライト | 确定对 |
| 2 | **罗马音切分**（歌词里官方写的罗马音） | `sekai` → セカイ、`shinjiteru` → シンジテル | 确定对 |
| 3 | **英文音译规则**（兜底，永远给得出结果） | `blorf` → ブローフ | 猜的，标记为"没把握" |
| 4 | **联网校正**（只对第 3 层"没把握"的词） | Google en→ja，**只接受纯片假名**的结果 | 更准 |

第 4 层的关键取舍：Google 的 en→ja 对**外来语**通常回片假名（`clover` → クローバー），
对**普通词**回汉字（`love` → 愛）。后者对唱歌没用 —— 我们要的是读音不是翻译 ——
所以非纯片假名的结果直接丢掉，保留本地规则的结果。

词典是**生成**的，别手改：

```bash
# 改 tools/seed-words.js 之后
npm run build:dict
```

种子词表来自两处：把片假名终结者的离线词典**反转**（那份本来就是"片假名外来语 → 英文原词"，
反转过来正好是真实写法而不是规则拼的），以及手工补的歌词高频词与变形词
（`shining` / `dancing` / `stories` 这类规则会读歪的）。

## 安装

1. 从 [Releases](../../releases) 下载 `.plugin`；
2. 放进 BetterNCM 插件目录（通常是 `C:\betterncm\plugins`）；
3. 重启网易云音乐。

自己打包：

```bash
npm install
npm run build            # 产出 builds/latin-katakana.plugin
npm run install:plugin   # 顺便复制到 C:\betterncm\plugins
```

## 三个插件一起用

页面上可能同时开着三个注音插件，各自标不同的字，互不抢：

| 插件 | 标什么 |
| --- | --- |
| [jp-furigana](https://github.com/Leleawa/jp-furigana) | 汉字 → 振假名 |
| [片假名终结者](https://github.com/YXLEI0/katakana-terminator-betterncm) | 片假名 → 英文 |
| **本插件** | 拉丁字母 → 片假名读音 |

三者都会往同一行插节点，所以 jp-furigana 需要打共存补丁（同一份补丁三个插件共用）。
另外片假名终结者要 **2.1.1 或更新**：那一版起它才认得本插件插的 `lt-ruby` / `lt-rt`。

```bash
npm run patch:furigana            # 自动找 C:\betterncm\plugins 里的 jp-furigana*.plugin
npm run patch:furigana -- --check # 已打补丁？打的还是当前这一版补丁吗？
npm run patch:furigana -- --force # 以备份为基准重打
```

补丁做五件事（细节见 `tools/patch-jp-furigana.js` 里的注释）：

1. `isClean()` 的子节点计数忽略**两家注音插件**的节点（`kt-*` 与 `lt-*`）；
2. `restore()` 拆 wrap 前把外来注音暂存，别一起丢掉；
3. observer 忽略注音插件引起的变更（**闪烁的真正来源**）—— `__ktOwned` 与
   `__ltOwned` 两种标记都认；
4. `hostsText()` 的"看得见的原文"排除外来注音的 `rt`；
5. `processLine()` 重建完一行后回调 `window.__ktRepairLine(line)`，让注音**同步**补回去。

> 第 5 条是"不闪"的关键：靠 MutationObserver 等下一帧补，中间那一帧就是可见的一闪。
> 两个插件都会挂这个钩子，所以**后加载的那个必须链上去而不是覆盖**
> （见 `src/main.js` 里的 `prevHook`）。

补丁打在**别人的包**上，jp-furigana 一升级就没了；补丁工具本身也会变（比如把识别范围
从一家扩到两家）。症状是歌词抽搐、或某个词反复闪 ——
`--check` 会直接告诉你包里的补丁**是不是当前这一版**，不一致就重跑
`npm run patch:furigana -- --force`。

反过来，本插件也认另外两家的注音节点：`isSkippable()` 会整棵跳过
`kt-ruby` / `fg-ruby` 里面。片假名终结者的注音里装的偏偏是**英文原词**
（`<rt class="kt-rt">dream</rt>`），正是本插件要标的对象 —— 不跳就会给英文注释
再注一层片假名。

## 设置

| 选项 | 说明 |
| --- | --- |
| 启用拉丁字母注音 | 总开关 |
| 规则没把握时联网校正读音 | 关掉则完全离线（词典 + 罗马音 + 规则） |
| 除歌词外也标注播放栏的歌曲名 / 歌手 | 关掉就只处理歌词区域 |
| 注音字号 / 不透明度 | 默认 55% / 80% |
| 标注范围 | 歌词 + 播放栏 / 只标歌词 / 只标播放栏 / 自定义选择器 |

## 排障

控制台里有一个 `LK` 对象：

```js
LK.stats()             // 读音命中统计 + 在线校正统计
LK.read('light')       // 单个词：{ kana, source, confid  }，source 是 dict/romaji/rule/online
LK.scan('light と clover')  // 分词结果
LK.pass()              // 立刻重扫一次
LK.clearCache()        // 清掉在线校正缓存
```

运行轨迹写在 `localStorage`（键 `latin-katakana.trace`），用仓库里的工具读：

```bash
node tools/read-trace.js
```

它落在网易云的 leveldb 里，值是 Snappy 压缩的、还跨 record 分片 —— 别手工捞。
轨迹里主要看三类行：`[pass]`（每轮扫描结果）、`churn 放弃这一行 … age=… peer{…}`
（认输退避与对端状态）、`未注音 …`（**某处没标上的原因**，每种跳过都会留痕）。

## 实现要点

- **只改文本节点，不改整行**：React 持有的原文本节点尽量保留（只切短），
  否则它的引用失效可能把页面搞崩；底字逐字节保持原文。
- **不改任何既有元素的 class**：标记一律用 `data-lt-*`。改别人的 class 会让对方插件
  判定"这行变了"并重建整行，我们的注音跟着被丢掉 —— 来回就是抽搐。
- **补注音赶在下一帧之前**：观测到 DOM 变更后用 `requestAnimationFrame` 立刻补，
  而不是防抖 250ms。
- **靠"活了多久"分辨打架与正常重绘**：注音被重建掉时的 `age` 小于 150ms 才算对方
  在无条件重建（此时才认输退避）；活得更久的属于正常重绘，照补不误。
- **只读别人的状态做诊断**：`peer{dirty=… hosts=… ktOwn=… 原文一致=…}` 直接读
  jp-furigana 的 expando，判断它为什么重建这一行，不改它任何东西。

## 已知限制

- **规则音译只是兜底**：`hello` → ヘッラオ、`question` → クワエサション 这种还不准
  （不在词表里的生僻词会读歪）。常用的词都进了词典，剩下的靠联网校正兜。
- 罗马音路径按 `di → ヂ` 切分，所以 `diorama` 走罗马音会得到 ヂオラマ；
  正常走词典拿到 ジオラマ。`the` / `think` 这类 `th` 词会标上 `confident: false`
  并交给联网校正。
- 桌面歌词不生效（原生窗口，够不到）。
- 只处理拉丁字母，汉字振假名是 jp-furigana 的活。
- 在线校正依赖 Google 的**非公开**接口，可能失效或被限流；失效时自动退回本地读音。

## 开发

需要 **Node ≥ 22.22.2**（`jsdom 30` 的引擎要求）。

```bash
npm install
npm test              # 跑单元测试（node --test）
npm run test:serial   # 逐个文件跑；受限环境里 node --test 起不了子进程时用这个
npm run check         # 静态自检（语法 / manifest / 读音词典 / 密钥）
npm run build         # 打包
```

## 目录结构

```
src/
  manifest.json       插件描述（injects 顺序即依赖顺序）
  main.js             入口：生命周期、观察循环、设置面板、修复钩子
  core/latin.js       拉丁词识别（词边界、撇号连字符、单字母过滤）
  core/dict.js        离线读音词典（自动生成，勿手改）
  core/reading.js     读音引擎：词典 -> 罗马音 -> 英文规则
  core/correct.js     联网校正：批量、四接口、只接受纯片假名
  core/annotate.js    DOM 注音注入与还原
tests/                jsdom 单元测试
tools/
  build.js / check.js / read-trace.js
  build-dict.js       生成离线读音词典
  seed-words.js       种子词表（唯一数据源）
  patch-jp-furigana*.js  jp-furigana 共存补丁（和片假名终结者仓库里的同一份，必须保持一致）
```

## 许可

插件自身代码采用 **MIT**，见 [LICENSE](LICENSE)。

读音词典里的外来语写法来自公开资料与人工整理，注意事项见 [NOTICE.md](NOTICE.md)。

## 致谢

- [Arnie97/katakana-terminator](https://github.com/Arnie97/katakana-terminator) —— 原版扩展；
  本插件的 DOM 注入、还原、共存那套机制是从它的网易云移植版（片假名终结者）继承来的。
- [Leleawa/jp-furigana](https://github.com/Leleawa/jp-furigana) —— 共存补丁改的就是它。
- [BetterNCM](https://github.com/BetterNCM) —— 插件框架。
