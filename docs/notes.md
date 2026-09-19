> **这是本插件的详细说明**，从 README 移过来的：读音来源与规则依据、
> 离线词典怎么生成、和另外两个插件怎么共存、排障、实现要点、已知限制。
> README 只留最短的上手部分。

---

# 拉丁字母片假名注音 · Latin Katakana for BetterNCM

在日语歌的歌词里，给**拉丁字母**上方标注**片假名读音**。

这是 [片假名终结者](https://github.com/YXLEI0/katakana-terminator-betterncm) 的反方向：那个把片假名读成英文，
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

五层，按顺序命中（`src/core/reading.js` + `src/core/llm.js`）：

| 顺序 | 来源 | 例子 | 可信度 |
| --- | --- | --- | --- |
| 1 | **离线词典**（`src/core/dict.js`，**6046 条**） | `clover` → クローバー、`hello` → ハロー | 确定对 |
| 2 | **罗马音切分**（歌词里官方写的罗马音） | `sekai` → セカイ、`shinjiteru` → シンジテル | 确定对 |
| 3 | **英文音译规则**（兜底，永远给得出结果） | `blorf` → ブローフ | 猜的，标记为"没把握" |
| 4 | **大模型校正**（只对规则读出来的词；需要你自己填 API Key） | `kaleidoscope` → カレイドスコープ | 很准，异步换上去 |
| 5 | **Google 校正**（没配大模型时才轮到它，只对"没把握"的词） | Google en→ja，**只接受纯片假名** | 更准 |

词典是**查表**、规则是**猜**：所以第 1 层命中就直接用，第 2 层（罗马音）是确定的，
只有第 3 层那个"猜出来的"结果会被第 4/5 层替换。

### 大模型校正（推荐打开）

规则层再怎么写也只是拼写音译：`hello` → ヘッラオ、`question` → クワエサション ——
那不是人唱的音。所以词典之外交给大模型：

- **设置面板 → 大模型校正**：填 API Key（默认 `https://api.deepseek.com/chat/completions`
  + `deepseek-chat`，任何 OpenAI 兼容接口都行），点「测试连接」当场验证；
- **接口地址会自动补全**：DeepSeek / OpenAI 文档里给的是 `base_url`
  （`https://api.deepseek.com` 或 `https://api.deepseek.com/v1`），照抄粘进来 POST 过去是
  **404**（实测：只有完整地址 `/chat/completions` 那一档返回 200）。
  现在少一段就补一段，设置面板里也会把纠正后的值写回输入框。
  报错也不再是干巴巴的 "HTTP 404"，而是**地址 + 该改哪儿 + 服务端原话**
  （401/403/429/5xx 各有对应提示）；
- 命中缓存**立刻**用；没命中就入队，攒 30 个词或 400ms 发一次请求，
  结果回来时自动重扫换掉 —— **先显示规则的即时结果，不阻塞注音**；
- 一个词只问一次：**命中和"模型也给不出"都永久落 localStorage**，重启网易云不重新花钱；
- 请求失败不写缓存，按退避冷却重试（60s 起、翻倍、10 分钟封顶）；
- 限流 20 请求/分钟、单批 30 词、20 秒超时；**任何异常都只是"这一层不工作"**，
  自动退回第 5 层的免费接口；
- Key **只存在本机 localStorage**，除你填的那个接口地址之外不会发到别处，永远不会进仓库。
  留空则整层不工作（也**一个请求都不会发**）。

实测（真接口，16 个词典外的词一批问完，1.5 秒）：
`precious → プレシャス`、`blossom → ブロッサム`、`twilight → トワイライト`、
`nostalgia → ノスタルジア`、`silhouette → シルエット`、`kaleidoscope → カレイドスコープ`。

### 离线词典是怎么来的

`src/core/dict.js` 是**生成物**，由 `tools/build-dict.js` 合并两份词表：

| 来源 | 条数 | 怎么来的 |
| --- | --- | --- |
| `tools/seed-words.js` | 491 | 人工核过（大部分是反转 katakana-terminator 的离线词典得到的真实外来语写法 + 手工补的歌词高频词） |
| `tools/seed-words-llm.js` | 5555 | `tools/expand-dict-llm.js` 让大模型按英文词频（前 6000）批量生成的读音 |

人工优先：同一个词两边都有时保留人工那份；生成物只收**纯片假名**，
混进汉字/平假名的结果当场丢掉（实测拦下 1 条：`portuguese → ポルトガル語`）。

重新生成（需要 `DEEPSEEK_API_KEY` 环境变量，约 4.5 分钟 / 8 万 tokens / 几分钱）：

```bash
npm run build:dict:llm -- --top 6000 --resume   # 生成/续跑 tools/seed-words-llm.js
npm run build:dict                              # 合并进 src/core/dict.js
```

**质量怎么核的**：拿人工核过的 491 条抽 80 条再问一遍模型，**一致率 95%**；
4 条不一致里 2 条其实是人工那份更差（`cigarette` 人工 タバコ、`complaint` 人工 クレーム ——
那是"意译"不是"音译"，歌词里唱 cigarette 更该是 シガレット），
另 2 条是两可写法（ヴィクトリー/ビクトリー、イエスタデイ/イエスタデー）。

### 规则层依据（sljfaq）

**英文音译规则**（第 3 层的 `convertEnglish`）按 sci.lang.japan FAQ 的
[How do I write an English word in Japanese?](https://www.sljfaq.org/afaq/english-in-japanese.html)
写，代码里每条规则/每张表都注了 `参照 sljfaq：…`。已按该页实现的约定：

- **英式发音优先**（vitamin → ビタミン，不是 バイタミン）；
- **非重读 r**（英式不卷舌）：`ar/er/ir/ur + 辅音或词尾` → アー、
  `or` → オー（car → カー、bird → バード、horse → ホース）；
- **θ → サ行**（think → シンク）、**ð → ザ行**（the → ザ、-ther → ザー）；
- **v → バ行**是首选写法（love → ラブ、vitamin → ビタミン），
  ヴァ/ヴィ/ヴ/ヴェ/ヴォ 只在日语实际那么写的词里用（visual → ヴィジュアル，走小表）；
- `ti/di` → ティ/ディ（Disney → ディズニー）、`dz` → ッズ（goods → グッズ）；
- **æ after k → キャ**（cap → キャップ），开音节的 `ca` 保持 カ（camera → カメラ）；
- **词尾不发音的 e**：前面的元音是长音（time → タイム），`-ce/-ge` 收 ス/ジ
  （dance → ダンス、orange → オレンジ）；
- **辅音 + 词尾 y → イー**（happy → ハッピー、city → シティ、lucky → ラッキー）；
- **`-Cle` 词尾** → クル/プル/ブル/トル…（simple → シンプル、table → テーブル、people → ピープル）；
- **m/n 在辅音前收 ン**（hamburger → ハンバーガー、London → ロンドン、front → フロント）；
- **促音**：多音节词只在重读音节促音，而重音光看拼写定不下来 ——
  所以只对**单音节词**的词尾塞音补 ッ（hot → ホット、cat → キャット、dog → ドッグ），
  其余的靠 `confident:false` 交给上层，不猜；
- **`-ing` → イング**（surfing 的 サーフィン 是该页单列的例外形式）。

**硬契约**：`englishToKatakana()` 的输出一定是**纯片假名**（ァ-ヶ + ー）。
规则层任何一步拼出别的东西（占位符、`undefined`、拉丁字母），
`englishToKatakana` 最后会统一清掉并把 `confident` 置 false。
这条由 `tests/dict.test.js` 的不变量测试（遍历全部词典词）守着。

**已知缺口**（拼写层确实决定不了、页面自己也说「先查词典」的情形）：
θ/ð 拼写同形、`ow` 在 now/snow、`oo` 在 book/moon、`our` 在 four/hour/tour、
`-er` 的两个读音、促音落在重读音节上、专有名词（Disney / Washington）、
词典形（pajamas → パジャマ、slippers → スリパー、router → ルーター、tarot → タロット）。
`tests/sljfaq-words.test.js` 把页面上的例子分成「读得对」和「读不出来（附理由）」
两张表逐条登记，**不允许静默跳过**。

词典是**生成**的，别手改：

```bash
# 改 tools/seed-words.js 之后
npm run build:dict
```

种子词表来自两处：把片假名终结者的离线词典**反转**（那份本来就是"片假名外来语 → 英文原词"，
反转过来正好是真实写法而不是规则拼的），以及手工补的歌词高频词与变形词
（`shining` / `dancing` / `stories` 这类规则会读歪的）。

## 安装

1. 从 [Releases](../../../releases) 下载 `.plugin`；
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
| 用大模型校正规则读出来的词 | 需要填下面的 API Key；关掉则这一层完全不工作 |
| 接口地址 / 模型 / API Key | 默认 DeepSeek；任何 OpenAI 兼容接口都行。「测试连接」当场验证 |
| 规则没把握时联网校正读音 | 免费的那条路（Google 接口）。配了大模型时大模型优先 |
| 除歌词外也标注播放栏的歌曲名 / 歌手 | 关掉就只处理歌词区域 |
| 注音字号 / 不透明度 | 默认 55% / 80% |
| 标注范围 | 歌词 + 播放栏 / 只标歌词 / 只标播放栏 / 自定义选择器 |

## 排障

控制台里有一个 `LK` 对象：

```js
LK.stats()             // 读音 + 大模型 + 在线校正三份统计
LK.read('light')       // 单个词：{ kana, source, confident }，source 是 dict/romaji/rule/online
LK.scan('light と clover')  // 分词结果
LK.pass()              // 立刻重扫一次
LK.clearCache()        // 清掉在线校正缓存
LK.llm.stats()         // 大模型层：命中 / 缓存条数 / 待问 / 请求 / 失败 / 退避剩余
LK.llm.test()          // 用当前配置打一次真请求，返回 { ok, message }
LK.llm.flush()         // 立刻把队列里的词发出去（不等攒批窗口）
LK.llm.clearCache()    // 清掉大模型缓存（下次会重新问）
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

- **规则音译只是兜底**：`hello` → ヘッラオ 这种还不准。6046 条的词典覆盖了英语词频前 6000，
  配了大模型 key 之后词典外的词也交给模型，所以正常情况下看不到规则层的输出。
- **规则层在若干拼写上比老版本更差**（诚实记账，都没有为了好看去塞词表）：
  `my` → マイー、`cake` → キャケ、`third/shirt/church/short` 这类
  「二合字母 + r」（→ シアード/シアート/チアーチ/シオート）、
  `horse/nurse/purse` 的词尾 `-se`（→ ホーセ/ナーセ/パーセ）、
  `search/earth/early` 的 `ear`、`memory` → メモーイー、`book` → ボオック。
  这些词全都在词典里（或人工小表里），所以真机上不会走到规则层；
  走得到的只有词典外的专有名词，那些正好是大模型层的地盘。
- **规则层的读音依据是 sljfaq 那张表**（见「规则层依据」一节），
  但表里有些例子拼写决定不了读音，规则层读不准：
  `ow`（now / snow）、`oo`（book / moon）、`oo+r`（door / four）、
  `our`（hour / tour）、`θ/ð`（think / the）、`-er` 的两个读音、
  `igh` 被前面的 `f` 拼块抢先（fight）等。这些要么进词典/小表，
  要么标 `confident: false` 交给大模型/联网。完整清单见
  `tests/sljfaq-words.test.js` 的 `KNOWN_GAPS`（每条都写了理由）。
- **人工词表里有少量"意译"而非"音译"的条目**：那 491 条是从
  "片假名外来语 → 英文" 反转来的，所以 `cigarette` 是 タバコ、`complaint` 是 クレーム
  （日语里就这两个词，但歌词里唱出来更像 シガレット/コンプレイント）。
  交叉验证 80 条里这样的有 2 条。
- 罗马音路径按 `di → ヂ` 切分，所以 `diorama` 走罗马音会得到 ヂオラマ；
  正常走词典拿到 ジオラマ。
- 桌面歌词不生效（原生窗口，够不到）。
- 只处理拉丁字母，汉字振假名是 jp-furigana 的活。
- 大模型层要你自己填 key（**只存本机 localStorage**）；不填也能用，只是退回免费的
  Google 接口。Google 那条依赖**非公开**接口，可能失效或被限流；失效时自动退回本地读音。

## 开发

需要 **Node ≥ 22.22.2**（`jsdom 30` 的引擎要求）。

```bash
npm install
npm test              # 跑单元测试（node --test）
npm run test:serial   # 逐个文件跑；受限环境里 node --test 起不了子进程时用这个
npm run check         # 静态自检（语法 / manifest / 读音词典 / 密钥）
npm run build         # 打包
npm run install:plugin  # 复制到 C:\betterncm\plugins
npm run verify:install  # 核对装上去的那个包和当前 src/ 是否逐字节一致
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
  build.js / check.js / read-trace.js / verify-install.js
  build-dict.js       生成离线读音词典
  seed-words.js       种子词表（唯一数据源）
  make-preview.js     生成 src/preview.png（零依赖手写 PNG 编码器）
  patch-jp-furigana*.js  jp-furigana 共存补丁（和片假名终结者仓库里的同一份，必须保持一致）
```

## 许可

插件自身代码采用 **MIT**，见 [LICENSE](../LICENSE)。

读音词典里的外来语写法来自公开资料与人工整理，注意事项见 [NOTICE.md](../NOTICE.md)。

## 致谢

- [Arnie97/katakana-terminator](https://github.com/Arnie97/katakana-terminator) —— 原版扩展；
  本插件的 DOM 注入、还原、共存那套机制是从它的网易云移植版（片假名终结者）继承来的。
- [Leleawa/jp-furigana](https://github.com/Leleawa/jp-furigana) —— 共存补丁改的就是它。
- [BetterNCM](https://github.com/BetterNCM) —— 插件框架。
