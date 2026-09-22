/*
 * western-katakana 的注音注入与还原。
 *
 * 职责：在指定区域里找西文词，给它们套上 <ruby>词<rt>片假名读音</rt></ruby>。
 *
 * 三条早期定下来的做法，都是踩坑换来的：
 *
 *  1. 不动「行」的 DOM，只动「文本节点」。
 *     jp-furigana 是整行重写（把自己的 span 塞进去替代整行内容），因为振假名要按
 *     分词重新切整行；我们不用：逐个文本节点替换就行，React 重建时要还原的东西
 *     也少得多（只有我们插的那几个节点）。
 *
 *  2. 还原靠 isConnected，不靠"文本内容相等"。
 *     React 重渲染时会换掉整个元素，我们插进去的节点随之脱离文档，所以判「原文
 *     回来没有」只看我们插的节点还连不连着。jp-furigana 注释里那个麻烦（React 会去改
 *     已脱离文档的旧文本节点，MutationObserver 不触发，只能靠内容比对兜底）也就
 *     跟着没了。
 *
 *  3. 内核不支持 ruby 排版时降级。
 *     NCM 用的是 CEF，某些版本里 <rt> 会退化成 block，把行高撑坏。这里沿用
 *     jp-furigana 的实测探针，不支持就用绝对定位的 span —— 不能用
 *     CSS.supports('display','ruby')，那玩意儿对新版内核恒返回 false。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKAnnotate = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 同 translate.js：factory 里没有 UMD 壳的 root，统一用 globalThis
  var G = typeof globalThis !== "undefined" ? globalThis : {};

  // 注入时是全局（manifest 的 injects 顺序保证它在前面）；Node 里 require 时按文件找
  var matcher = G.WKMatcher || (typeof require === "function" && (safeRequire("./letters.js") || safeRequire("./matcher.js")));
  function safeRequire(p) {
    try {
      return require(p);
    } catch (e) {
      return null;
    }
  }

  if (!matcher) {
    // 没有匹配器就什么都做不了；返回一个空壳，让上层能优雅降级
    return { createAnnotator: function () { throw new Error("WKMatcher 未加载"); } };
  }

  /*
   * 制作信息行（署名）不标：「作詞: アニメ太郎」「编曲 : Kenji」这类注了没意义还碍眼。
   *
   * 用户报过两处。一是「编曲也会被注上」：老版本只列了 `作[词詞曲編编]`（作词/作曲），
   * 漏了 `编曲`，于是「编曲 : Kenji」里的 Kenji 照标。二是英文那一支 ——
   * 「Arranged by Kenji」本来靠前缀匹配，但英文歌词行也可能以 `Music`/`Words` 开头
   * （"Music by the lake"），所以英文那支要求后面跟分隔符或 `by`，中文那支要求冒号
   * （中文歌词行不会以「编曲：」开头）。
   *
   * 结尾那个冒号 / `by` / 连字符是必须的：不然 `Music と light の 中` 这种正常歌词
   * 会被误杀（有测试守着）。空格会打断中间那段填充，这也是故意的：`Art of love`
   * 不是署名，`Art: CC` 才是。
   *
   * 中间那段填充是给组合写法用的：`混音&母带处理：宫奇`、`作曲/和声编写：CC`
   * （用户截图的署名行）—— 关键词后面跟 `&`、`/`、别的词、几个汉字都算同一行署名。
   * 中文那一串是用户一张张截出来的（演唱 / 美工 / 策划 / 导唱 / 封面 / 曲绘 /
   * 调校 / 后期…原本都没认出来，名字里的拉丁字母就被注上音了）。
   */
  var CREDIT_CN = [
    "作[词詞]", "作曲", "编曲", "編曲", "混音", "录音", "録音", "母带", "母帶", "制作", "制作人", "製作人",
    "出品", "监制", "監製", "吉他", "贝斯", "貝斯", "鼓手", "键盘", "鍵盤", "弦乐", "弦樂",
    "和声", "和聲", "合声", "合聲", "和音", "演唱", "配唱", "导唱", "導唱",
    "美工", "策划", "策劃", "企划", "企劃", "统筹", "統籌", "后期", "後期",
    "封面", "曲绘", "曲繪", "插画", "插畫", "调校", "調校", "调教", "調教",
    "视频", "視頻", "字幕", "翻译", "翻譯", "鸣谢", "鳴謝", "感谢", "感謝", "发行", "發行", "版权", "版權",
    "采样", "取樣", "音源", "素材", "原曲", "原唱", "翻唱", "伴奏", "后期", "混音",
    /*
     * 用户贴过一整块 HOYO-MiX 的署名表，下面这几行原本会漏（漏了名字就被注音）：
     * `管弦配器 Orchestrator：`、`编曲（电子） Arranger：`、`尺八 Shakuhachi：`、
     * `乐队 Orchestra：`、`音频编辑 Editing Engineer：`。这一批是乐器 / 声部 / 工种
     * 的长尾，关键词表本来只收了常见的那几个。
     */
    "配器", "管弦", "编配", "乐器", "樂器", "演奏", "独奏", "独唱", "指挥", "指揮", "合唱", "合音", "童声", "人声", "旁白", "念白", "朗诵", "吟唱",
    "乐队", "樂隊", "乐团", "樂團", "交响", "交響", "室内乐", "民乐", "打击乐", "架子鼓", "电子琴", "合成器", "钢琴", "鋼琴",
    "小提琴", "中提琴", "大提琴", "低音提琴", "竖琴", "手风琴", "口琴", "长笛", "短笛", "双簧管", "单簧管", "萨克斯", "小号", "长号", "圆号", "大号",
    "二胡", "琵琶", "古筝", "古琴", "笛", "箫", "笙", "唢呐", "马头琴", "尺八", "三味线", "太鼓", "打击", "手鼓", "非洲鼓",
    "音频", "音頻", "编辑", "編輯", "剪辑", "剪輯", "音效", "声效", "缩混", "混缩",
    "出品人", "音乐总监", "艺术总监", "艺术指导", "監唱", "制作助理", "宣发", "营销", "推广", "商务", "经纪",
    "美術", "设计", "設計", "视觉", "視覺", "摄影", "攝影", "造型", "服装", "化妆", "道具", "场景", "特效", "动画", "動畫", "调色", "剪輯師",
    "特别感谢", "特別感謝", "协助", "協助", "支持", "赞助", "提供", "场地", "器材", "厂牌", "出品方",
  ];
  var CREDIT_EN = [
    "Lyric", "Music", "Melody", "Arrang", "Compos", "Produc", "Written", "Words",
    "Guitar", "Bass", "Drum", "Piano", "Keyboard", "Vocal", "Mixing", "Mix", "Master", "Mastering",
    "Recorded", "Engineer", "Strings", "Synthesizer", "Programming", "Chorus", "Art", "Illust", "Design", "Tun",
    "Orchestr", "Conduct", "Edit", "Score", "Studio", "Label", "Distribut", "Publish", "Management",
    "Shakuhachi", "Flute", "Violin", "Cello", "Viola", "Harp", "Erhu", "Pipa", "Guzheng", "Koto", "Shamisen",
    "Percussion", "Choir", "Harmony", "Cover", "Director", "Coordinator", "Supervis", "Thanks", "Support",
    /*
     * 用户截图：`PV: 羽生まゐご`（上一行是 `曲絵: 瀬川あをじ`）—— 两行都是制作信息，
     * 但 `PV` 不在表里，那个 `PV` 就被注成了 ビーピー。下面这几个是纯拉丁的工种标签
     * （PV / MV 这类缩写，加几个常见工种）。
     */
    "PV", "MV", "Promotion", "Movie", "Animation", "Illustration", "Artwork", "Photo", "Camera",
    "Logo", "Narration", "Cast", "Staff", "Special",
  ];
  /*
   * 署名行的形状，三种写法都要认（用户的署名表里三种混着）：
   *   ① `作词：` / `混音&母带处理：` —— 中文标签（标签里允许括号：`编曲（电子）`）
   *   ② `作词 Lyricist：` / `尺八 Shakuhachi：` / `录音棚 Recording Studio：`
   *      —— 中文标签 + 空格 + 首字母大写的拉丁标签（乐器 / 工种的长尾都走这一支，
   *      不用一个个列进关键词表，但那一串只吃首字母大写的词）
   *   ③ `Lyricist：` / `Mastering Engineer：` —— 纯拉丁标签
   *
   * `Music と light の 中で`、`Art of love`、`Music is my life:` 都不匹配（有测试守着）。
   */
  var CREDIT_FILL = "[\\u4e00-\\u9fa5A-Za-z&\\/|,\u3001+\u00B7\u30FB\uFF08\uFF09()]{0,8}";
  var CREDIT_LATIN_LABEL = "(?:\\s+[A-Z][A-Za-z.&'\\-]*){0,3}";
  var CREDIT_TAIL = "\\s*(?::|：|by\\b|-)";
  var RE_CREDIT = new RegExp(
    "^\\s*(?:" +
      "(?:" + CREDIT_CN.join("|") + ")" + CREDIT_FILL + CREDIT_TAIL +
      "|(?:" + CREDIT_CN.join("|") + ")" + CREDIT_FILL + CREDIT_LATIN_LABEL + CREDIT_TAIL +
      "|(?:" + CREDIT_EN.join("|") + ")[a-z]*" + CREDIT_FILL + CREDIT_LATIN_LABEL + CREDIT_TAIL +
      ")",
    "i"
  );

  /*
   * 有些行光看开头就能判定是版权 / 署名，后面不一定要冒号：`Copyright MGMT :Fann`
   * （用户截图）就是这种，冒号在名字后面，上面那条判据够不着，于是 MGMT 被念成
   * エムジーエムティー、Fann 被念成 ファン。歌词不会以这些词开头，放宽是安全的。
   */
  var RE_CREDIT_HARD = /^\s*(?:copyright\b|copyrighted\b|©|\(c\)|℗|\(p\)|all rights reserved\b|presented by\b|published by\b|licensed by\b)/i;

  // ---------------------------------------------------------------- 注入

  var styleCache = null;

  /** 实测内核认不认 ruby 排版（探针只跑一次，结果留在 styleCache） */
  function hasRubyLayout(doc) {
    // 测试用开关：jsdom 没有布局引擎，量不出宽度，只能打桩
    if (typeof G.__WK_FORCE_RUBY__ === "boolean") return G.__WK_FORCE_RUBY__;
    if (styleCache !== null) return styleCache;
    try {
      if (!doc.body) return true; // body 还没出来，量不了，先当支持
      var probe = doc.createElement("div");
      probe.style.cssText =
        "position:absolute;left:-9999px;top:-9999px;width:300px;" +
        "font-size:20px;line-height:1.2;visibility:hidden;";
      probe.innerHTML = '<ruby>\u6f22<rt style="font-size:60%">kanji</rt></ruby>';
      doc.body.appendChild(probe);
      var rt = probe.querySelector("rt");
      var rtWidth = rt ? rt.getBoundingClientRect().width : 0;
      var height = probe.getBoundingClientRect().height;
      probe.remove();
      styleCache = rtWidth > 0 && rtWidth < 150 && height < 20 * 1.2 * 1.9;
      return styleCache;
    } catch (e) {
      return (styleCache = true);
    }
  }

  function createAnnotator(options) {
    options = options || {};
    var doc = options.document || (typeof document !== "undefined" ? document : null);
    var lookup = options.lookup;
    if (typeof lookup !== "function") throw new Error("createAnnotator 需要 lookup(word) 函数");
    /*
     * 可选：pending(word, line, token) 返回这个词的读音是不是"暂定"的（在线那层还在
     * 问，先用规则结果顶上）。暂定的注音加 `wk-pending` 类，样式上淡一点，真结果回来
     * 由 relabel() 改写并去掉类。第三个参数是分词给的 token —— 段标那类判断要看位置，
     * 见 main.js 的 labelLetter。
     */
    var pending = typeof options.pending === "function" ? options.pending : null;
    /*
     * 可选：这段文字里有没有被判成打码的重复字母串（排障用）。判据在 main.js，
     * 要靠整行和后一个字符，这里只是问一句 —— 不然排障报告只能写成"上面几条
     * 都不成立"，看着像漏标了。
     */
    var censoredRun = typeof options.censoredRun === "function" ? options.censoredRun : null;

    var annotateAll = options.annotateAll !== false; // false = 只标歌词

    /*
     * 本插件不做"按行分工、让给振假名插件"那件事。
     *
     * katakana-terminator 需要它，是因为那两个插件抢同一批字（片假名 vs 汉字）：
     * 谁都不让，jp-furigana 每轮重建整行、我们的注音每轮被抹掉，就是抽搐。本插件标的
     * 是西文字母，跟振假名不是同一批字，一行里既有汉字又有英文时两种注音本来就该同时
     * 出现，让开反而是漏标。所以这里没有 skipKanjiLines / coexistWithFurigana 这类
     * 开关：与 jp-furigana 的冲突只剩"它整行重建会把我们的 ruby 一起换掉"，那个交给
     * 共存补丁（第三条 observer + 第五条同步回调）解决，补丁没打时由 churn 认输兜底。
     */
    // 我们改过的文本节点 -> 记录，字段见 annotateNode 里的 records.set
    var records = new Map();

    /*
     * 宿主里"文字没变"不等于没被动过。
     *
     * React（还有 RefinedNowPlaying 这类插件）会把整行元素的子节点全换新，文字却
     * 一模一样。我们的记录挂在旧文本节点上，新节点没有记录，只看 records 就会把它
     * 当成新的一行重新注音 —— React 一重建我们就注一次，来回触发，永远不收敛。
     * 真机轨迹里那句「18 行每 250ms 重注一次」就是这么来的。
     *
     * 所以下面按宿主记状态，判"这行变没变"也一律拿宿主说话。
     */
    /*
     * host -> { text, changes }：这段可见文本最近变了多少次。
     *
     * 真机里歌词行的内容每 250ms 就会被重建或改写（逐字动画、逐行滚动、别的插件
     * 重排），这种一直在动的元素，注进去的注音下一秒就被丢掉，追着重注就是抽搐。
     * 所以对反复变化的 host 直接放弃，稳定性优先于覆盖率。
     */
    var motionByHost = new WeakMap();
    /*
     * 但这必须是滑动窗口，不能是一辈子的黑名单。老版本 `changes` 只加不减，同一个
     * 元素被复用超过 3 次就永久不再碰它 —— 用户报的「换歌后 KiLLKiSS judy.., …
     * 这句没注音了」就是这个：网易云换歌时复用同一批 `<li>/<p>`，只把文本换掉，
     * 于是第 4 首之后那一行再也不标；更糟的是整行被跳过，连上一首残留的旧注音都
     * 没人清（探针里能看到新旧注音混在一行）。
     *
     * 现在按窗口计数：窗口内变到 MOTION_LIMIT 次才在本轮放弃，窗口一过自动重试。
     * 真正的死循环还有 churn 认输兜着，见 noteChurn。
     */
    var MOTION_LIMIT = 3;
    var MOTION_WINDOW_MS =
      typeof options.motionWindowMs === "number" ? options.motionWindowMs : 3000;

    /*
     * 自动避让：认输，别再跟一个"无条件重建这一行"的插件对打。
     *
     * 真机轨迹：jp-furigana 的共存补丁一旦失效（它自己升级、.plugin 被换掉，补丁没
     * 了），它会把我们引起的每一次 DOM 变更都当成"行被外人改过"，于是它重建、我们
     * 重注、它再重建，轨迹里 `[pass] changed=18 restored=18` 每秒重复，肉眼就是一直
     * 抽搐。这种循环我们永远追不上，唯一有用的动作是松手。判据是「可见文本一个字都
     * 没变，我们却反复判定注音失效」—— 正常换行是文本变了，不算；正常的一秒一行也
     * 不会触发；只有对方在无条件重建才有这个特征。
     *
     * 键用文本而不是元素：对方每次重建都新建一个元素（wrap 是新建的 span），按元素记
     * 永远归不了零，按文本才能跨重建累计。
     */
    var churnByText = new Map(); // 文本 -> { count, since, strikes }
    var churnUntil = new Map(); // 文本 -> 退避截止时间戳
    /*
     * 窗口 1.5s、阈值 3 次，这两个数是拿真机轨迹对出来的，别随手改小。
     *
     * 2.0.2 的「4s 内 2 次」误伤过正常重绘：
     *   16:36:09 已注音 文本="diorama"          ← 这行刚变成当前行，注上
     *   16:36:10 已注音 文本="diorama"          ← 被重绘掉，补一次
     *   16:36:10 churn 放弃这一行 60s             ← 才两轮就认输，行首 60s 没注音
     * 这只是歌词行切换时被重绘两次，重绘完就稳定了，不该放弃。
     *
     * 真正的死循环长这样（1.2.3 之前的实测轨迹）：3 秒里重建 5 轮，也就是 1.5s
     * 窗口里稳定有 3 轮以上。所以窗口收到 1.5s、阈值提到 3，既跳得过正常重绘，
     * 又抓得住死循环。
     */
    var CHURN_WINDOW_MS = 1500; // 计数窗口
    var CHURN_LIMIT = 3; // 窗口内超过这个次数才认输
    /*
     * 退避：1s 起，每次翻倍（1s → 2s → 4s → … → 1min 封顶）。
     *
     * 别把"短退避"改回"一次就退 10 分钟"，这个教训是拿真机轨迹换的：
     *   17:04:09 churn 2s   ... peer{dirty=false hosts=1 无wrap=0 ktOwn=1 原文一致=true}
     *   17:04:12 churn 600s ... peer{dirty=false hosts=1 无wrap=0 ktOwn=1 原文一致=true}
     * 对端状态完全健康（isClean 必然为真），两次之间隔了 3 秒，那是正常的重绘
     * （行切换 / 逐字动画），不是死循环，却被退了 600s，那一句整整十分钟没有英文
     * （用户原话："ジオラマ的英文消失了"）。
     *
     * 死循环的特征是短时间内连续十几二十轮（1.2.3 之前的实测：每秒 4 轮、一分钟
     * 十几条 churn）。所以策略是短退避、尽快重试：正常重绘重试一次就稳住，真死循环
     * 靠翻倍在一分钟内退到上限。
     */
    var CHURN_BASE_MS = typeof options.churnBaseMs === "number" ? options.churnBaseMs : 1000;
    /*
     * 退避上限。原来是 10 分钟 → 3 分钟 → 2 分钟 → 现在 1 分钟。用户反复报"某一行
     * 不注音"，踩的就是这个：那一行被播放器或别的插件反复重建（RNP 逐字歌词会为
     * 每个字重建当前行），我们认输之后退避一路翻倍，那行就"永远"没注音了。
     * 退避只是礼貌，不该让人以为插件坏了。
     */
    var CHURN_MAX_MS = 60000;
    /*
     * 只有"刚插上就被毁"才算打架。
     *
     * 真机数据把两类现象分得很清楚：
     *   age=223ms / 435ms / 543ms  —— RNP 分几次补齐歌词行，属于正常重绘
     *   age≈0~几十 ms              —— 对方在无条件重建，注什么秒毁什么（真死循环）
     * 配合 2.0.11 的"下一帧前补回来"，正常重绘根本看不见，补一次几乎免费，不该为它
     * 认输 —— 认输会让那一句十几秒没有英文，用户看到的就是"RNP 页的ジオラマ一直
     * 没注音"。
     *
     * 这道门槛原本是 150ms。用户报的「MWAH 一直没注音」说明 150ms 还是太高：RNP
     * 的逐字行大约每 100ms 重写一次内容，cycle 落在 150ms 以内，每次都判成打架，
     * 三轮就进认输期，那一行在退避窗口里完全没有注音。而我们的补注是在
     * MutationObserver 回调里做的（在下一帧之前），100ms 的空窗根本到不了屏幕，
     * 也就是说这里压根没有"闪"要治，认输纯属误伤。所以门槛降到 50ms（一帧 16ms
     * 的 3 倍），只留下"同一拍就被抹掉"的真死循环。
     */
    var CHURN_FAST_MS = 50;
    /*
     * 原谅期：这么久没有再打架，就把 strikes 清零。
     * 否则一段文字一旦被打过一次，之后每次重试都只给 1 轮机会、退避起点也更高，
     * 于是一首歌里只会越来越容易被判成"打架"。
     */
    var CHURN_FORGIVE_MS = 10000;
    var CHURN_MAX_ENTRIES = 200; // 兜底：别让 Map 无限长

    function churnPrune() {
      if (churnByText.size <= CHURN_MAX_ENTRIES && churnUntil.size <= CHURN_MAX_ENTRIES) return;
      var now = Date.now();
      churnUntil.forEach(function (until, k) {
        if (now >= until) churnUntil.delete(k);
      });
      var over = churnByText.size - CHURN_MAX_ENTRIES;
      if (over > 0) {
        var it = churnByText.keys();
        for (var i = 0; i < over; i++) {
          var k2 = it.next();
          if (k2.done) break;
          churnByText.delete(k2.value);
        }
      }
    }

    /** 这段文本是不是正在"认输期"，这一轮别碰它 */
    function churnSuppressed(text) {
      if (!text) return false;
      var until = churnUntil.get(text);
      if (until == null) return false;
      var now = Date.now();
      if (now < until) return true;
      churnUntil.delete(text); // 退避结束，再试一次
      // 安静够久就把 strikes 也忘掉：下次是新的"事故"，该从头给足机会
      var c = churnByText.get(text);
      if (c && now - (c.last || 0) > CHURN_FORGIVE_MS) churnByText.delete(text);
      return false;
    }

    /** 注音插上去多久了（毫秒）；没记过就返回 undefined */
    function ageOf(host) {
      // __wkAt 是现在的标记；__ltAt 是改名前的（同一台机器上可能还留着上一版插的节点）
      if (!host) return undefined;
      var at = typeof host.__wkAt === "number" ? host.__wkAt : host.__ltAt;
      if (typeof at !== "number") return undefined;
      return Date.now() - at;
    }

    /**
     * 记一次"文本没变但注音失效"；到达阈值就进入退避。
     *
     * @param text    被毁掉的那段文字（认输/退避都以它为键）
     * @param where   宿主的简短身份，写进轨迹用
     * @param ageMs   注音活了多久才被毁（undefined 表示不清楚，按"打架"算）
     * @param peerLine 注音时抓下来的行元素（宿主脱链后仍能读对端状态）
     * @param peerEl  兜底元素，peerLine 没有时顺着它往上找行
     */
    function noteChurn(text, where, ageMs, peerLine, peerEl) {
      if (!text) return;
      /*
       * 活够久才被重建 = 正常重绘，不是打架：不计数。
       * （补回来只要一帧，看不见；而认输会让那一句长时间没有英文。）
       */
      if (typeof ageMs === "number" && ageMs >= CHURN_FAST_MS) return;
      var now = Date.now();
      var c = churnByText.get(text);
      if (!c || now - c.since > CHURN_WINDOW_MS) c = { count: 0, since: now, strikes: (c && c.strikes) || 0 };
      c.count++;
      /*
       * 每次都要凑够 CHURN_LIMIT 次窗口内的重建才认输。
       *
       * 以前是"判过它爱打架之后，每次重试只给 1 轮机会"（limit=1），太狠：那一行
       * 只要再被重绘一次（换歌、拖进度、逐字动画收尾各算一次），退避就再翻一倍，
       * 很快顶到上限，于是"某一行永远没注音"。真死循环在 1.5s 窗口里轻松凑够 3 次，
       * 正常重绘凑不够，这个判据本来就够用。
       */
      var limit = CHURN_LIMIT;
      if (c.count < limit) {
        c.last = now;
        churnByText.set(text, c);
        return;
      }
      c.strikes++;
      /*
       * 退避按 2 倍递增（1s → 2s → … → 1min 封顶）。别改成"第二次起直接顶到上限"，
       * 真机数据否过它：对端状态健康、两次 churn 隔了 3 秒，那只是正常重绘，却让
       * 那一句十分钟没有英文。翻倍递增下正常重绘重试一两次就稳，真死循环才会很快
       * 退到上限。
       */
      var wait = Math.min(CHURN_BASE_MS * Math.pow(2, c.strikes - 1), CHURN_MAX_MS);
      churnUntil.set(text, now + wait);
      /*
       * 不能把记录删掉：strikes 必须跨退避留着，否则下次重新计数时它又从 0 开始，
       * "已经判过它爱打架"永远不成立、退避也永远停在第 1 档
       * （2.0.5 的实际 bug：每 2s 就再闪一下）。只把窗口计数清零。
       */
      churnByText.set(text, { count: 0, since: now, strikes: c.strikes, last: now });
      if (options.log) {
        options.log(
          "churn 放弃这一行 " +
            Math.round(wait) +
            "ms（约 " +
            Math.round(wait / 1000) +
            "s，注音反复被重建掉" +
            (where ? "，宿主 " + where : "") +
            "）文本=" +
            JSON.stringify(String(text).slice(0, 40)) +
            " age=" +
            (typeof ageMs === "number" ? Math.round(ageMs) + "ms" : "?") +
            " " +
            describePeer(peerLine, peerEl)
        );
      }
      churnPrune();
    }

    /*
     * 排障用的一小段：把 jp-furigana 自己的状态读出来，看它为什么会重建这一行。
     *
     * 只读别人的 expando，不改任何东西。要回答的是它 isClean() 里那几条判据到底
     * 哪条不成立，光看我们自己的轨迹猜不出来：
     *   dirty     它自己标脏了（有 DOM 变更被它当成"行被外人改过"）
     *   无wrap    有宿主没挂着它的 wrap（那它会重建）
     *   ktOwn     按它的口径数"属于自己的子节点"，正常应该恰好是 1
     *   原文一致  hostsText(line) === line.__fgText —— 这条最容易被我们的 <ruby>
     *             污染：它求和用的是 host.__fgOrig 的 textContent，我们的 rt
     *             文字会被算进去，于是这一行永远"不干净"、永远重建
     */
    /**
     * 顺着祖先找一个 jp-furigana 标过的行（它会给行挂 __fgText）。
     * 必须在元素还挂在文档里的时候调用 —— 脱链之后就找不到了。
     */
    function enclosingPeerLine(el) {
      for (var p = el; p && p !== doc.body; p = p.parentElement) {
        if (p.__fgText != null) return p;
      }
      return null;
    }

    function describePeer(lineEl, fallbackEl) {
      try {
        // 优先用注音时存下来的行元素；兜底元素往往已经脱链，找不到行
        var line =
          lineEl && lineEl.__fgText != null ? lineEl : enclosingPeerLine(fallbackEl);
        if (!line || line.__fgText == null) return "peer=无标记";
        var hosts = line.__fgHosts || [];
        var noWrap = 0;
        var orig = "";
        for (var i = 0; i < hosts.length; i++) {
          var h = hosts[i];
          if (!h.isConnected || !h.__fgWrap || h.__fgWrap.parentNode !== h) noWrap++;
          var o = h.__fgOrig || [];
          for (var j = 0; j < o.length; j++) orig += o[j].textContent || "";
        }
        var fg = String(line.__fgText == null ? "" : line.__fgText);
        var same = orig === fg;
        return (
          "peer{dirty=" +
          !!line.__fgDirty +
          " hosts=" +
          hosts.length +
          " 无wrap=" +
          noWrap +
          " mirrors=" +
          ((line.__fgMirrors || []).length) +
          " ktOwn=" +
          (hosts.length ? ownChildCountLikePeer(hosts[0]) : "-") +
          " 原文一致=" +
          same +
          (same ? "" : " orig=" + JSON.stringify(orig.slice(0, 24)) + " fgText=" + JSON.stringify(fg.slice(0, 24))) +
          "}"
        );
      } catch (e) {
        return "peer=err:" + ((e && e.message) || e);
      }
    }

    /** 按 jp-furigana 打补丁后的口径数"属于它的"子节点（正常恰好 1 个 wrap） */
    function ownChildCountLikePeer(h) {
      var n = 0;
      for (var i = 0; i < h.childNodes.length; i++) {
        var c = h.childNodes[i];
        if (c.nodeType === 1) {
          // 口径必须和 jp-furigana 被打上的 __ktOwnChildCount() 完全一致：
          // 排除"别家插的注音"，但不排除它自己的 wrap（正常情况下恰好数到 1）。
          var cls = typeof c.className === "string" ? c.className : "";
          if (/(^|\s)(wk-ruby|kt-ruby|wk-rt|kt-rt|wk-ov-label|kt-ov-label)(\s|$)/.test(cls)) continue;
          if (c.tagName === "RT" && c.parentNode) {
            var pc = typeof c.parentNode.className === "string" ? c.parentNode.className : "";
            if (/(^|\s)(wk-ruby|kt-ruby)(\s|$)/.test(pc)) continue;
          }
        }
        n++;
      }
      return n;
    }

    // host -> { at }：这个宿主上次注音的时刻，用来算 age（churn 那套判据要用）
    var decidedByHost = new WeakMap();

    // 不进去的标签
    var SKIP_TAGS = {
      SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1,
      OPTION: 1, TITLE: 1, HEAD: 1, RUBY: 1, RT: 1, RP: 1, CODE: 1, PRE: 1,
      SVG: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1,
    };

    // 歌词区域选择器（NCM 3.x 实测 + 2.x + 常见第三方歌词插件）
    /*
     * 顺序有意义：越细的行选择器排越前。
     *
     * 网易云默认歌词页（3.1.36 实测，来自 jp-furigana 源码注释加我们自己的真机轨迹）
     * 是 `ul#mod_pc_lyric_record.lyric > li.line > p × 2`，一个 `<li>` 里两个 `<p>`。
     * 老版本先命中 `ul.lyric > li`，把整个 `<li>` 当区域，翻译层就跟着原文一起被注音
     * （用户报的「翻译也会被注上」）。现在先按 `<p>` 取区域，再由 collectBySelectors
     * 把同一个 `<li>` 里的第二个块踢掉。
     */
    var LYRIC_SELECTORS = [
      "ul.lyric > li > p",
      "ul.lyric li p",
      "ul.lyric > li",
      "div.lyric ul li p",
      ".lyric-line",
      ".lyric-next-p",
      'div[class^="rnp-lyrics-line"]',
      'div[class^="lyric-bar-inner"] div[class^="rnp-lyrics-line"]',
      'div[class^="rnp-lyrics-overview-line"]',
      'div[class^="lyricMainLine"]',
      'div[class*="lyric-line"]',
    ];

    /*
     * 不标的区域：RNP（RefinedNowPlaying）把一行渲染成好几层。
     *   -original   官方原文（只有这层要标）
     *   -romaji     它自己算的罗马音（`i za na` 这种），本身已经是读音，再标就是噪音
     *   -translated 中文翻译层，跟日语读音无关
     * 后两层直接跳过。用 className 而不是选择器，是因为这几层在不同版本里前缀后缀
     * 不完全一样。
     *
     * 第一支来自 RNP 3.0.2 的 bundle（把 main.js 里的标识符全捞出来核对过）：除了
     * -romaji / -translated，还有 -overview-line-romaji / -overview-line-translation
     * / -placeholder 这些变体 —— 老正则只认 `rnp-lyrics-line-`，总览页的翻译层就漏了。
     * 后两支给别家歌词插件兜底：翻译 / 罗马音层的 class 里基本都会出现 trans /
     * translated / romaji 这种整词（AMLL 那类叫 lyricSubLine）。
     */
    var SKIP_REGION_CLASS = new RegExp(
      "rnp-lyrics-(?:overview-)?line-(?:romaji|translated|translation|placeholder)" +
        /*
         * RNP 的复制模式 / 总览视图整块跳过。
         *
         * 用户要求「不要在 RNP 的复制模式上注音」。查了 RNP 3.0.2 的 bundle：那颗
         * 按钮的 title 就是「复制模式」（class 里带 overview-mode，state 是
         * overviewMode），打开后它把正常歌词整块隐藏（`.rnp-lyrics` 上加
         * `overview-mode-hide`），另渲染一个 `.rnp-lyrics-overview-container`
         * （CSS 里写着 `user-select: text`，专门用来选中复制）。我们以前两边都注音，
         * 复制出来就带上 `<ruby>`/`<rt>` 的注音文字。现在两块都不碰；退出复制模式后
         * class 消失，MutationObserver 会叫我们重扫，注音自己回来。
         */
        "|rnp-lyrics-overview-container|overview-mode-hide" +
        "|(^|[\\s_-])(?:romaji|romanized|translated|translation|trans|transLine|transText)([\\s_-]|$)" +
        "|lyricSubLine|lyricSubText|lyricTrans",
      "i"
    );

    function isSkippedRegion(el) {
      var cn = el && typeof el.className === "string" ? el.className : "";
      return SKIP_REGION_CLASS.test(cn);
    }

    /** 有假名 = 更像日文原文；中文翻译层一个假名都没有（拣行判据见 collectBySelectors） */
    var RE_KANA = /[\u3041-\u309F\u30A0-\u30FF\uFF66-\uFF9F]/;

    /*
     * 标题 / 歌手等"顺带标注"的容器白名单。
     *
     * 这里刻意不用 body：早期版本拿 body 当区域，把侧边栏、搜索框、歌单名、评论正文
     * 全改了，直接把网易云干到错误页（有运行轨迹为证，一轮 pass 里 changed=8，命中的
     * 全是 BODY 下的各种文字）。只碰这些语义明确、内容稳定的容器，宁可漏标不越界。
     */
    var TARGET_SELECTORS = [
      ".m-playbar .words .name",
      ".m-playbar .words .by",
      '[class*="playbar"] [class*="songName"]',
      '[class*="playbar"] [class*="artist"]',
      '[class*="nowPlaying"] [class*="title"]',
      '[class*="nowPlaying"] [class*="artist"]',
      '[class*="songTitle"]',
      '[class*="songName"]',
      '[class*="artistName"]',
    ];

    function isSkippable(el) {
      if (!el || el.nodeType !== 1) return true;
      if (SKIP_TAGS[el.tagName]) return true;
      if (el.isContentEditable) return true;
      /*
       * 别进任何一家的注音节点内部。
       *
       * 自家的 wk-ruby 要跳过是显然的；kt-rt / fg-rt 也必须跳过，那里装的是别家的
       * 注音文字：katakana-terminator 的 `<rt class="kt-rt">` 里是英文原词（hello、
       * dreamer…），全是拉丁字母，正是我们要标的对象，不跳就会给英文注释再注一层
       * 片假名；jp-furigana 的 `<rt class="fg-rt">` 里是振假名，一样不该碰。
       * <rt>/<rp> 已由 SKIP_TAGS 兜住，下面判 class 是给"内核不支持 ruby、降级成
       * span"的情况兜底，三家的降级节点都用各自的前缀。
       */
      var cls = typeof el.className === "string" ? el.className : "";
      if (/(^|\s)(wk-ruby|kt-ruby|fg-ruby)(\s|$)/.test(cls)) return true;
      if (el.tagName === "RT" || /(^|\s)(wk-rt|kt-rt|fg-rt|wk-ov-label|kt-ov-label)(\s|$)/.test(cls)) {
        return true;
      }
      return false;
    }

    /** 收集要处理区域里的所有文本节点（一次 TreeWalker，按文档顺序） */
    function collectTextNodes(regions) {
      var out = [];
      for (var i = 0; i < regions.length; i++) {
        var region = regions[i];
        if (!region || region.nodeType !== 1) continue;
        if (isSkippable(region)) continue;
        /*
         * 区域自己或它的祖先是"整层跳过"的（RNP 的复制模式：区域往往是
         * `.rnp-lyrics-line`，而 `overview-mode-hide` 挂在它的父元素上）——
         * 下面那个循环只走到 region.parentNode 为止，正好漏掉这一层，所以这里单独判。
         */
        var skipAncestor = false;
        for (var a = region; a && a.nodeType === 1; a = a.parentNode) {
          if (isSkippedRegion(a)) {
            skipAncestor = true;
            break;
          }
        }
        if (skipAncestor) continue;
        var walker = doc.createTreeWalker(region, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            for (var p = node.parentNode; p && p !== region.parentNode; p = p.parentNode) {
              if (isSkippable(p)) return NodeFilter.FILTER_REJECT;
              /*
               * RNP 的罗马音层 / 翻译层要整层跳过。
               *
               * 只在"区域"这一层过滤是不够的：`div.rnp-lyrics-line` 本身是个区域，
               * 而 -romaji / -translated 是它的子元素。父区域被收下之后，
               * 收集文本节点会把子层里的文字一起收走 —— 实测就是这样给罗马音层
               * 标了 6 个读音（`ki ra me ku` 上面又出现一遍片假名）。
               */
              if (isSkippedRegion(p)) return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        while (walker.nextNode()) out.push(walker.currentNode);
      }
      return out;
    }

    /**
     * 一个文本节点 -> 注入后续节点。返回是否改动。
     * 只处理这个节点自己的 nodeValue，不碰别的节点。
     */
    /*
     * 跳过原因记录（诊断用）。
     *
     * 为什么需要：以前只有「成功注音」会留痕，于是用户说"某一行没注上"时，
     * 我完全看不到它是"没译文"、"被按行分工让开"还是"在认输期"—— 只能猜，
     * 而这几轮反复猜错。每轮最多记 6 条，随 pass 一起写进轨迹。
     */
    var skipNotes = [];
    var SKIP_NOTE_MAX = 6;

    function noteSkip(why, text, region, words) {
      if (skipNotes.length >= SKIP_NOTE_MAX) return;
      var where = region ? idOf(region) : "?";
      skipNotes.push(
        why +
          " @" +
          where +
          " " +
          JSON.stringify(String(text == null ? "" : text).slice(0, 24)) +
          (words && words.length ? " 词=" + words.slice(0, 3).join("/") : "")
      );
    }

    /**
     * 宿主所在的一整行歌词的文字（用来判"是不是制作信息行"）。
     *
     * 为什么要往上找：RNP 会把一行拆成好几个 div（逐字/分段），于是
     * `混音&母带处理：宫奇` 和 `Gon` 是两个节点 —— 只看节点自己的文字，
     * `Gon` 就不像制作信息，会被注上音（用户截图里正是这样，而同一张图里
     * 另一行的 `Zoe` 因为和 `制作人：` 在同一个节点里，反而被正确跳过了）。
     * 往上找到最近的 `li` / `.rnp-lyrics-line` 就是那一行。
     */
    function enclosingLineText(el) {
      var best = lineElementOf(el);
      if (!best) return null;
      try {
        return visibleText(best);
      } catch (e) {
        return null;
      }
    }

    /**
     * 往上找到"这一行"的元素（`li` 或 `.rnp-lyrics-line`）。
     *
     * RNP 的行 class 是带尾巴的（`rnp-lyrics-line-original` / `-romaji` /
     * `-translated`，逐字歌词那块是 `rnp-lyrics-line-karaoke`），以前只认
     * 光秃秃的 `rnp-lyrics-line`，于是**逐字歌词**里宿主找不到"这一行"，
     * 语境退化成宿主自己那一两个字（逐字行一个字就是一个 `<span>`），
     * `ズ干Cャ` 的 C 既看不出前面是假名、也看不出后面跟着 ャ，整行一个注音都没有
     * （用户截图）。所以这里按前缀认，尾巴随便是什么。
     */
    function lineElementOf(el) {
      var best = null;
      for (var p = el, d = 0; p && p.nodeType === 1 && d < 6; p = p.parentNode, d++) {
        var cls = typeof p.className === "string" ? p.className : "";
        if (p.tagName === "LI" || /(^|\s)rnp-lyrics-line[-\w]*(\s|$)/.test(cls)) best = p;
      }
      return best;
    }

    /**
     * 判断语境用哪段文字：宿主自己的可见原文，宿主太短就用**整行**的。
     *
     * 为什么要退到整行：网易云把一行歌词按词/字拆成好几个 `<span>`（逐字歌词、
     * 或者别的注音插件给某个字包了 `<ruby>`），这时单个词的宿主可能就是 `T` 自己 ——
     * 语境里没有假名，"T氏" 这类**贴日文才读字母名**的判据就全失效了
     * （用户截图：`T氏にすべてを捧げましょう` 的 T 一直没注音）。
     * 注音与 relabel 两边都走这个函数，语境才会一致（大模型那层按「词 + 语境」缓存）。
     */
    function contextOf(host, fallbackText) {
      var own = host && host.isConnected ? visibleText(host) : "";
      var line = host ? enclosingLineText(host) : null;
      if (line && line.length > own.length) return line;
      return own || fallbackText || "";
    }

    /*
     * 这一行是不是夹在署名块中间的一行（前后紧挨着的都是署名行）。
     *
     * 为什么还要这一手：关键词表永远有长尾（乐器 / 声部 / 工种），但真实署名块里
     * 漏掉的那一行前后一定也是署名行（用户那块里的 `尺八 Shakuhachi：`、
     * `乐队 Orchestra：`、`音频编辑 Editing Engineer：`）。判据故意取这个局部
     * 特征，而不是"整张列表都是署名" —— 网易云的署名常常就挂在歌词列表末尾，
     * 按整张列表判会把同一列表里的真歌词一起杀掉（实测：`きらめく light と clover`
     * 跟着署名块一起没了）。
     */
    function insideCreditBlock(lineEl, cache) {
      if (!lineEl || !lineEl.parentNode) return false;
      var hit = cache.get(lineEl);
      if (hit !== undefined) return hit;
      hit = neighborIsCredit(lineEl, -1) && neighborIsCredit(lineEl, 1);
      cache.set(lineEl, hit);
      return hit;
    }

    /** 紧挨着的上一/下一元素兄弟是不是署名行（跳过文本节点） */
    function neighborIsCredit(lineEl, delta) {
      var sib = delta < 0 ? lineEl.previousSibling : lineEl.nextSibling;
      while (sib && sib.nodeType !== 1) sib = delta < 0 ? sib.previousSibling : sib.nextSibling;
      if (!sib) return false;
      try {
        var t = visibleText(sib);
        return !!(t && (RE_CREDIT.test(t) || RE_CREDIT_HARD.test(t)));
      } catch (e) {
        return false;
      }
    }

    /**
     * 从 node 的 offset 处往后找第一个非空白字符，**可以跨文本节点**
     * （段标的冒号常被拆到下一个节点里）。找不到就返回空串。
     */
    function charAfterToken(node, offset) {
      var n = node;
      var at = offset;
      for (var guard = 0; n && guard < 16; guard++) {
        if (n.nodeType === 3) {
          var s = String(n.nodeValue || "").slice(at);
          var m = /\S/.exec(s);
          if (m) return s.charAt(m.index);
        } else if (n.nodeType === 1 && !isSkippable(n)) {
          // 元素节点：直接看它里面第一段可见文字（`<span>: Vanitatum …</span>`）
          var t = visibleText(n);
          var m2 = /\S/.exec(t);
          if (m2) return t.charAt(m2.index);
        }
        if (n.nextSibling) {
          n = n.nextSibling;
          at = 0;
          continue;
        }
        // 这一层到头了：爬到上一层，从它的下一个兄弟继续
        var up = n.parentNode;
        if (!up || up.nodeType !== 1 || up.tagName === "LI" || up.tagName === "P") return "";
        n = up.nextSibling;
        at = 0;
      }
      return "";
    }

    /**
     * 从 node 的 offset 处往后拼出**原始**文字（不跳空白，最多取 8 个字，可跨节点）。
     *
     * 和 charAfterToken 的区别：那个只回答"下一个非空白字是什么"，这里要连
     * "中间有没有空格"一起回答 —— 读音层要分"贴着的 `Cゃ`"和"隔空格的 `R ァ`"。
     * 逐字歌词里 `ズ干Cャ` 的 ャ 跟 C 不在同一个文本节点，只有跨节点拼才看得到。
     */
    function rawAfterText(node, offset) {
      var out = "";
      var n = node;
      var at = offset;
      for (var guard = 0; n && out.length < 8 && guard < 16; guard++) {
        if (n.nodeType === 3) {
          out += String(n.nodeValue || "").slice(at);
        } else if (n.nodeType === 1 && !isSkippable(n)) {
          out += visibleText(n);
        }
        if (out.length >= 8) break;
        if (n.nextSibling) {
          n = n.nextSibling;
          at = 0;
          continue;
        }
        var up = n.parentNode;
        if (!up || up.nodeType !== 1 || up.tagName === "LI" || up.tagName === "P") break;
        n = up.nextSibling;
        at = 0;
      }
      return out;
    }

    /** rawAfterText 的反方向：往前拼**原始**文字（同样不跳空白、可跨节点） */
    function rawBeforeText(node, offset) {
      var out = "";
      var n = node;
      var at = offset;
      for (var guard = 0; n && out.length < 8 && guard < 16; guard++) {
        if (n.nodeType === 3) {
          out = String(n.nodeValue || "").slice(0, at) + out;
        } else if (n.nodeType === 1 && !isSkippable(n)) {
          out = visibleText(n) + out;
        }
        if (out.length >= 8) break;
        if (n.previousSibling) {
          n = n.previousSibling;
          at = n.nodeType === 3 ? String(n.nodeValue || "").length : 0;
          continue;
        }
        var up = n.parentNode;
        if (!up || up.nodeType !== 1 || up.tagName === "LI" || up.tagName === "P") break;
        n = up.previousSibling;
        at = n && n.nodeType === 3 ? String(n.nodeValue || "").length : 0;
      }
      return out;
    }

    /** 取一段原始文字里第一个非空白字；没有就返回空串 */
    function firstVisible(s) {
      var m = /\S/.exec(String(s == null ? "" : s));
      return m ? m[0] : "";
    }

    /** 取一段原始文字里最后一个非空白字；没有就返回空串 */
    function lastVisible(s) {
      var str = String(s == null ? "" : s).replace(/\s+$/, "");
      return str ? str.charAt(str.length - 1) : "";
    }

    function annotateNode(node, region) {
      var text = node.nodeValue;
      // 长度 1 的文本节点也要看：逐字歌词/别的插件拆行时，单个字母就是它自己的节点
      // （`T氏` 的 T），按"太短就跳过"会把它整段漏掉。
      if (!text) return false;
      if (!matcher.hasReadable(text)) return false;

      var tokens = matcher.scan(text);
      if (!tokens.length) {
        noteSkip("切不出词", text, region);
        return false;
      }

      var hostMaybe = node.parentNode;
      var glosses = [];
      // 每个词的来源（dict / romaji / rule / llm / google / letters），给"按来源着色"用
      var sources = [];
      var any = false;
      var missing = [];
      /*
       * 语境：用宿主里看得见的原文（不含任何注音），不是这个文本节点自己的值。
       *
       * 为什么不能用节点自己的值：注音之后节点的值会被我们切短（只剩前半截），
       * 同一个词在"注音前/注音后"就会算出两个不同的语境 —— 大模型那层按
       * 「词 + 语境」缓存，于是同一个词会被反复问（真机轨迹里看得到重复请求）。
       * 宿主的可见原文在注音前后不变（我们的注音不算底字），拿它当语境最稳，
       * 而且对模型来说信息更全（整行而不是半截）。
       */
      var context = contextOf(hostMaybe, text);
      for (var i = 0; i < tokens.length; i++) {
        var g = null;
        var src = null;
        /*
         * 段标（`(A:` / `B：`）在真机上可能被拆成不同节点：`A` 在它自己的节点里，
         * 冒号落在**下一个**文本节点 —— token 自己看不到冒号，段标判定就失效了
         * （用户截图 `Vindicia (A: Vanitatum sentio)` 的 A、B 被注上了 ア / ビー）。
         * 这里跨节点往后瞟一眼（跳过空白），是冒号就补上 label 标记。
         */
        if (tokens[i].text.length === 1 && tokens[i].label !== true) {
          if (charAfterToken(node, tokens[i].end) === ":" || charAfterToken(node, tokens[i].end) === "\uFF1A") {
            tokens[i].label = true;
          }
        }
        /*
         * 单字母左右两边的字，连同"中间有没有空格"一起带给读音层（token.after /
         * token.afterSpaced / token.before / token.beforeSpaced）。
         *
         * 为什么要在注音层算：`ズ干Cャ` = ズ干チャ、`ラR ア` = ララ 这类
         * "拿字母当假名用"的写法，判据就是字母紧挨着什么字。而逐字歌词把每个字
         * 拆进各自的 `<span>`，读音层拿到的 `line`（整行文本）+ 偏移量根本对不上，
         * 只能由这里跨节点现取（用户截图：逐字歌词那几行一个注音都没有）。
         */
        if (tokens[i].text.length === 1) {
          var afterRaw = rawAfterText(node, tokens[i].end);
          var beforeRaw = rawBeforeText(node, tokens[i].start);
          tokens[i].after = firstVisible(afterRaw);
          tokens[i].afterSpaced = /^\s/.test(afterRaw);
          tokens[i].before = lastVisible(beforeRaw);
          tokens[i].beforeSpaced = /\s$/.test(beforeRaw);
        }
        if (matcher.looksReadable(tokens[i])) {
          /*
           * 传原始写法（tk.text）而不是 tk.norm：
           * 折过的形式会把连字符吃掉，于是 `D/N/A`（记号，逐字母读）和
           * `x-ray`（普通词）在读音层就分不出来了 —— 见 reading.js 的
           * notationToKatakana()。查表那几层自己会折，传原文不损失什么。
           *
           * 第二个参数是整句原文：大模型那一层靠它消歧
           * （read リード/レッド、人名地名、记号）。同一个词在不同句子里
           * 读音不同，所以语境要跟着词一起传下去。
           *
           * 返回两种形状都认：字符串（老约定）或 { kana, source }（带来源，给着色用）。
           *
           * 第三个参数是这个词的 token：段标（`M:`）那类判断要按位置判，
           * 只看整行会把 `M: 匿名Mです。` 里的两个 M 一起留白（用户截图）。
           */
          var got = lookup(tokens[i].text, context, tokens[i]);
          if (typeof got === "string") {
            g = got;
          } else if (got && got.kana) {
            g = got.kana;
            src = got.source || null;
          }
          if (!g) missing.push(tokens[i].norm);
        }
        glosses.push(g);
        sources.push(src);
        if (g) any = true;
      }
      if (!any) {
        // 这一段里有片假名，但一个词都没查到译文 —— 是"词典没有 + 联网还没回来/失败"，
        // 不是我们跳过了。真机排障时最容易漏的就是这一种：它不留任何痕迹。
        noteSkip("无译文", text, region, missing);
        return false;
      }

      // 有词要标，才动手
      var host = node.parentNode;
      if (!host) return false;

      // 原节点在 host 里的下标。必须在动 DOM 之前算好：leadIsRuby 时原节点
      // 会被摘掉，摘完再遍历就找不到它，index 会留在 0，还原时整段原文
      // 会被插到宿主行首（和上面 refNode 是同一类坑）。
      var origIndex = 0;
      for (var ci = 0; ci < host.childNodes.length; ci++) {
        if (host.childNodes[ci] === node) {
          origIndex = ci;
          break;
        }
      }

      // 关键：不替换原文本节点，只把它「切短」，注音作为兄弟节点插在中间。
      //
      // 为什么这样做：React 更新纯文本时执行的是 setTextContent(node)，
      // node 是它内部持有的那个文本节点引用。如果这个节点被我们删掉/换成
      // 别的节点，React 的引用就失效了，commit 阶段可能直接抛错，
      // 整个页面会掉进 NMC 的错误页（"应用出错了…重启下试试吧"）。
      // 保留原节点既能满足 React，也不影响我们的注音排版。
      var pieces = [];
      var pos = 0;
      var inserted = [];
      for (var j = 0; j < tokens.length; j++) {
        var tk = tokens[j];
        if (tk.start > pos) pieces.push({ text: text.slice(pos, tk.start) });
        if (!glosses[j]) {
          pieces.push({ text: tk.text });
        } else {
          var isPending = false;
          if (pending) {
            try {
              isPending = !!pending(tk.text, context, tk);
            } catch (e) {
              isPending = false;
            }
          }
          var ruby = buildRuby(tk.text, glosses[j], isPending, sources[j]);
          pieces.push({ text: tk.text, ruby: ruby });
          inserted.push(ruby);
        }
        pos = tk.end;
      }
      if (pos < text.length) pieces.push({ text: text.slice(pos) });

      if (!inserted.length) return false;

      // 注入方式：尽量保留 React 持有的那个原文本节点，只把它「切短」，
      // 注音和其他段落作为兄弟节点插到它后面。
      //
      // 为什么优先保留原节点：React 更新纯文本时执行 setTextContent(node)，
      // node 是它内部持有的引用。如果这个节点被删掉换成别的节点，React 的引用
      // 就失效了，commit 阶段可能直接抛错，整页掉进 NMC 的错误页
      // （"应用出错了…重启下试试吧"）。保留它既能满足 React，也不影响排版。
      //
      // 例外：文本正好以片假名词开头时，第 0 段本身带注音，不能既留原文又插注音
      // （那样底字会渲染两遍）。这种情况直接移除原节点，注音从第 0 段开始排。
      var leadIsRuby = !!pieces[0].ruby;
      /*
       * 记下动 DOM 之前宿主的可见原文。
       *
       * 为什么不能只用 rec.plain 来判断"这行变没变"：plain 是这个文本节点的原文，
       * 而宿主里可能还有别人的内容（例如 katakana-terminator 的
       * `<ruby class="kt-ruby">コーヒー<rt class="kt-rt">coffee</rt></ruby>`）。
       * 拿"整个宿主的可见文本"去和"单个节点的原文"比，永远不会相等 ——
       * 结果是每轮都判定失效、还原、重注（一直闪）。之前这条路径被
       * 「注音还在就跳过」那道粗闸挡住了，闸一松就露出来。
       * 所以这里存一份"注入当时宿主长什么样"，之后按它比。
       */
      var hostPlainBefore = visibleText(host);
      /*
       * 插入位置必须在动 DOM 之前取好。
       *
       * leadIsRuby 时下面会把原节点从 host 里摘掉，摘掉之后 `node.nextSibling`
       * 恒为 null，于是 `host.insertBefore(tail, null)` 等价于「挂到 host 末尾」——
       * 以片假名词开头的文本会被整段挪到宿主的结尾。真机上就是：中文/汉字部分
       * 在行首、片假名注音跑到行尾；下一轮还原又把原节点按原下标放回行首，
       * 再注音又挪到行尾，肉眼正是「注音在行首和行尾来回横跳」。
       */
      var refNode = node.nextSibling;
      var tail = doc.createDocumentFragment();
      var startIndex = 0;
      if (!leadIsRuby) {
        node.nodeValue = pieces[0].text;
        startIndex = 1;
      } else if (node.parentNode === host) {
        /*
         * 行首就是词（`KiLLKiSS judy..,` 这种）：原文本节点留在原地、值清空，
         * 注音插在它后面。
         *
         * 老版本是把它从 host 里摘掉（注音取而代之）。摘掉看着更"干净"，但有个
         * 要命的副作用：框架（React）还攥着这个文本节点的引用，换歌时它执行的是
         * `node.nodeValue = 新歌词` —— 节点一旦脱链，那句话说给空气听，页面上什么都
         * 不变。于是我们永远看不到"这行换了"，旧注音留在新歌的行里，而且框架认为
         * 这行没变、不会自己修回来。用户报的「换歌后这句没注音 / 混着上一首的注音」
         * 就有这一份。
         *
         * 留在 DOM 里（哪怕暂时是空串）就没这个问题：框架写进来的新歌词立刻可见，
         * 我们下一轮就能判定"这行失效"、还原、重注。
         * 空文本节点不占位置、不影响排版，还原时按 kept=true 那条路把原文写回去。
         */
        node.nodeValue = "";
      }
      // inserted 要记「我们插进去的每一个节点」—— 包括那些纯文本分段。
      // 只记注音的话，还原时这些分段会留在 DOM 里，原文就会重复一遍。
      for (var k = startIndex; k < pieces.length; k++) {
        var piece = pieces[k];
        var childNode = piece.ruby || doc.createTextNode(piece.text);
        // 给"我们自己造出来的"节点打标记：别的插件（jp-furigana）的
        // MutationObserver 靠它区分"这是注音插件插的"从而不把行标脏。
        // 见 tools/patch-jp-furigana.js 的 __ktRecordIsOurs（它认 __wkOwned，
        // 也认改名前的 __ltOwned）。
        if (childNode.nodeType === 3) childNode.__wkOwned = true;
        tail.appendChild(childNode);
        inserted.push(childNode);
      }
      host.insertBefore(tail, refNode);
      // 原文本节点（保留下来那条）的值也被我们改写过，同样算我们的
      if (!leadIsRuby) node.__wkOwned = true;
      // 记下注音时刻：出问题时 age 能直接区分"我们的注音活了多久"，
      // 从而分辨"死循环"（几十毫秒就没）和"正常重绘"（活了一两秒）
      host.__wkAt = Date.now();

      // 记录：原节点是否还留在 host 里、注音节点清单，以及它原来插在哪个位置
      // （host 的子节点下标）。
      // 记下标是为了还原 —— 还原时我们插的节点会被逐个摘掉，届时再想找"插回哪儿"
      // 就已经晚了。数值同样要在动 DOM 之前算好。
      // kept 现在总是 true（两种形态都保留原节点，见上面 leadIsRuby 那段），
      // 保留这个字段是因为还原逻辑按它分支（万一哪天又需要摘掉节点）。
      records.set(node, {
        host: host,
        nodes: inserted,
        plain: text,
        // 注入当时宿主的可见原文（不含任何注音）。判"这行变了没有"要用它，
        // 不能用 plain —— 宿主里可能还有别人的注音底字（见上面 hostPlainBefore）。
        hostPlain: hostPlainBefore,
        // kept=true 时我们写在原节点上的那截文字（前缀）。框架换歌会把它的值
        // 换成新歌词，那时就绝对不能照着 plain 写回去 —— 写回去就是把上一首
        // 的歌词搬进新歌的行里。还原前拿它确认"这截还是我们写的"。
        // 行首就是词的那种，我们写进去的是空串，所以这里也存空串（不是 null）——
        // 判据是 `rec.head == null || node.nodeValue === rec.head`，
        // 存 null 会变成"不检查"，框架写进去的新歌词就会被我们覆盖掉。
        head: leadIsRuby ? "" : pieces[0].text,
        region: region,
        kept: node.parentNode === host,
        index: origIndex,
        // 记下当时所在的行元素（jp-furigana 会给它挂 __fgText）。
        // 只能在注音时抓：等到出问题（宿主被摘掉）再顺着 host 往上找就已经晚了，
        // 那时 host 已经脱链，parentElement 全是 null，诊断只能输出"无标记"。
        peerLine: enclosingPeerLine(host),
      });
      // 记下"这个 host 我们已经注过音了"，给下面 prior 那段判断用。
      /*
       * 只记一个注音时刻。
       *
       * 以前这里还存 plain / annotated / reAnnotated，是给"文字没变就只补一次"
       * 那道防抖用的。现在防抖已经统一交给 churn 计数器（按 age 区分真死循环
       * 与正常重绘），那三个字段没有任何地方读了 —— 留着只会让人以为还有第二道闸。
       */
      decidedByHost.set(host, { at: Date.now() });

      if (options.log && records.size <= 40) {
        // 记下区域和宿主的身份。真机排障时最关键的就是这个 host：
        // 它是 jp-furigana 的 wrap（fg-line）、RNP 的逐字 span（rnp-*），
        // 还是整行 div —— 决定了我们的注音会不会被对方重建掉。
        options.log(
          "已注音 region=" + idOf(region) + " host=" + idOf(host) + " 文本=" + JSON.stringify(text.slice(0, 30))
        );
      }

      /*
       * 消费 jp-furigana 的「暂存」交接（见 tools/patch-jp-furigana.js）。
       *
       * 它 restore() 时会把我们上一轮插进它 wrap 里的注音节点挂到 host.__wkForeign
       * （改名前的名字是 __ltForeign，两个都认）。
       * 这些节点只取走、不再挂回去，两个原因：
       *
       *   1. 位置信息已经没了。它们属于一个刚被拆掉的 wrap，原来的邻居节点
       *      大多已经不在了。以前这里是 `host.insertBefore(fnode, node.nextSibling)`，
       *      而 node 是"这一轮碰巧处理到的文本节点"—— 行首片假名的注音会被挂到
       *      行尾去，肉眼就是注音在行首/行尾来回横跳。
       *   2. 不需要它们。那一段的原文一定还在 host.__fgOrig 里（wrap 之前的内容），
       *      restore() 已经把它放回 DOM 了；而且下面紧接着就是正常注音流程，
       *      会按当前 DOM 重新标一遍，位置自然是对的。挂回去只会多出一个重复注音。
       *
       * 清空是为了别把已经脱离文档的节点一直挂在 expando 上。
       */
      if (host.__wkForeign || host.__ltForeign) {
        host.__wkForeign = null;
        host.__ltForeign = null;
      }

      if (!hasRubyLayout(doc) && host.setAttribute && !host.hasAttribute("data-wk-fallback")) {
        host.setAttribute("data-wk-fallback", "1");
      }

      return true;
    }

    /**
     * 建 <ruby>カナ<rt>Kana</rt></ruby>；内核不支持时用 span 绝对定位。
     *
     * provisional=true 时加一个 `wk-pending` 类：这个读音还是"暂定"的
     * （在线那层还在问，先拿规则结果顶上），样式上会淡一点，
     * 等真结果回来由 relabel() 改写并把类去掉。
     *
     * source 是"这个读音是谁给的"（dict / romaji / rule / letters / llm / google），
     * 只用来打一个 `wk-src-*` 类 —— 排障时打开「按来源着色」就能一眼看出
     * 哪个词是词典给的、哪个是规则猜的、哪个是模型换过的。类名一直在，
     * 不给它上色而已（这样开关一开立刻生效，不用重扫）。
     */
    function buildRuby(base, gloss, provisional, source) {
      var ruby = doc.createElement("ruby");
      ruby.className = "wk-ruby" + (provisional ? " wk-pending" : "") + (source ? " wk-src-" + source : "");
      ruby.appendChild(doc.createTextNode(base));
      if (hasRubyLayout(doc)) {
        var rt = doc.createElement("rt");
        rt.className = "wk-rt";
        rt.textContent = gloss;
        ruby.appendChild(rt);
      } else {
        var span = doc.createElement("span");
        span.className = "wk-rt";
        span.textContent = gloss;
        ruby.appendChild(span);
      }
      return ruby;
    }

    /**
     * 换掉 ruby 上的 `wk-src-*` 类（读音换来源时用：规则 -> 大模型就是这么变的）。
     * 只动我们自己的节点，而且只动这一类，不碰别人给这行加的任何 class。
     */
    function setSourceClass(el, source) {
      if (!el || !el.classList) return;
      var drop = [];
      for (var i = 0; i < el.classList.length; i++) {
        var cn = el.classList[i];
        if (cn.indexOf("wk-src-") === 0 && cn !== "wk-src-" + source) drop.push(cn);
      }
      for (var j = 0; j < drop.length; j++) el.classList.remove(drop[j]);
      if (source && !el.classList.contains("wk-src-" + source)) el.classList.add("wk-src-" + source);
    }

    /**
     * 还原某条记录。
     *
     * 注入时有两种形态，还原也要分两种情况：
     *   kept=true  —— 原文本节点还在（被切短了），注音插在它后面：
     *                 摘掉注音，把后面残留的纯文本兄弟并回原节点。
     *   kept=false —— 文本以片假名词开头，原节点已被移除、注音取而代之：
     *                 摘掉注音，把原节点（值是完整原文）插回原位置。
     */
    function restoreRecord(node, rec) {
      var host = rec.host;
      var i;

      /*
       * 换歌时最要紧的一条：不许把 rec.plain 写回一个内容已经变了的节点。
       *
       * 网易云的歌词列表会复用同一批 <li>/<p>/文本节点，换歌时只把 nodeValue
       * 换成新歌词。我们手里那份 rec.plain 还是上一首的原文，照着写回去就等于
       * 把上一首的歌词写进新歌的行里 —— 用户看到的就是"下一首歌出现上一首歌的歌词"，
       * 而且框架认为这行没变，不会自己修回来。
       *
       * 判据是"这行还是不是我们注的那句话"：
       *   kept=true  —— 原节点还在宿主里、值仍然是我们当时写下的那截前缀
       *                （框架换歌时会把它的值换成新歌词，那就一个字都不许动）；
       *   kept=false —— 原节点当初被摘掉了，宿主里只剩我们的注音节点，
       *                所以看"注音还在不在"，并且宿主的可见原文没被换过。
       * 不满足时只摘掉我们插的节点，DOM 里的文字一个字都不改。
       */
      var ours = false;
      if (host && host.isConnected) {
        if (rec.kept) {
          ours = node.parentNode === host && (rec.head == null || node.nodeValue === rec.head);
        } else {
          ours =
            annotationsIntact(rec) &&
            (rec.hostPlain == null || visibleText(host) === rec.hostPlain);
        }
      }

      if (ours) {
        if (node.parentNode === host) {
          // 原节点还在 host 里（kept=true 的形态），把原文写回去
          node.nodeValue = rec.plain;
        } else if (rec.kept) {
          // kept=true 却找不到原节点：说明 React 把整棵子树重建过了，
          // 原文已经在 DOM 里。这时绝对不能再把我们的旧节点插回去 ——
          // 那会和 React 的新节点并存，同一句话渲染两遍。
          // 只清掉我们插的节点，DOM 让 React 说了算。
          removeInjected(rec);
          records.delete(node);
          untagIfClean(host, rec.region);
          return;
        } else {
          // kept=false（文本以片假名开头，注入时移除了原节点）：
          // 按注入前记下的下标把原节点插回去。
          var ref = host.childNodes[rec.index] || null;
          host.insertBefore(node, ref);
          node.nodeValue = rec.plain;
        }
      }

      removeInjected(rec);
      records.delete(node);
      untagIfClean(host, rec.region);
    }

    /** 我们插进去的注音节点是否还都挂在 DOM 上 */
    function annotationsIntact(rec) {
      for (var i = 0; i < rec.nodes.length; i++) {
        if (!rec.nodes[i].isConnected) return false;
      }
      return rec.nodes.length > 0;
    }

    /**
     * 这个宿主里还有没有我们的注音。
     *
     * 和 annotationsIntact(rec) 的区别：那个查的是"某条记录里的节点还在不在"，
     * 这里查的是"DOM 里到底还有没有 wk-ruby"。后者才回答得了
     * 「底字没变，但注音是不是被对方抹掉了」—— 见 pass() 里 prior 那一段。
     *
     * 刻意不做缓存：对方随时可能把我们的节点抹掉，缓存成 true 就会让上面
     * 那个判断重新退化成 bug。调用点只有一处，且只在"底字恰好没变"时才会走到，
     * 开销可以接受。
     */
    function hostHasOurRuby(host) {
      if (!host || host.nodeType !== 1 || !host.querySelector) return false;
      return !!host.querySelector("ruby.wk-ruby");
    }

    /**
     * 这个区域是不是「歌词行」。
     * 只有歌词行才需要按"含不含汉字"和振假名插件分工 ——
     * 播放栏的歌曲名/歌手它根本不管，含汉字也照标。
     *
     * 判据：祖先里出现歌词相关的 class（lyric / line / rnp-）；
     * 但玩家栏（playbar）本身带 "line"？不会——所以额外排除播放栏那几类，
     * 免得把歌曲名误判成歌词行。
     */
    function isLyricRegion(el) {
      for (var p = el; p && p !== doc.body; p = p.parentElement) {
        var cn = typeof p.className === "string" ? p.className : "";
        if (/playbar|nowplaying|now-playing|player-bar/i.test(cn)) return false;
        if (/\bline\b|lyric|rnp-/.test(cn)) return true;
      }
      return false;
    }

    /** 摘掉我们插进去的所有节点（注音 + 文本分段） */
    function removeInjected(rec) {
      for (var i = 0; i < rec.nodes.length; i++) {
        var n = rec.nodes[i];
        if (n.parentNode) n.parentNode.removeChild(n);
      }
    }

    /** 宿主/区域里已经没有我们的注音了，就把标记摘干净 */
    function untagIfClean(host, region) {
      if (region && region.isConnected && !region.querySelector("ruby.wk-ruby")) {
        untagData(region, "data-wk-region");
      }
      if (host && host.isConnected && !host.querySelector("ruby.wk-ruby")) {
        untagData(host, "data-wk-fallback");
      }
    }

    /**
     * 摘掉我们挂的 data 标记（不回写 className）。
     * 为什么不挂 class：歌词行元素是和别的插件（jp-furigana 等）共用的，
     * 改它的 className 会让对方的渲染检查失效、重建整行，进而把我们的注音
     * 也一起丢掉 —— 两边互相触发就是一直抽搐。data-* 属性不影响 className，
     * 也不会被对方的检查逻辑看在眼里。
     */
    function untagData(el, name) {
      if (el && el.removeAttribute && el.hasAttribute(name)) el.removeAttribute(name);
    }

    /**
     * 区域标记 + 降级标记的收尾。
     * 标记只加在真正含注音的元素上，还原后立刻摘掉 —— 往不属于我们的
     * 元素上留痕迹，既脏又可能被别人读取。
     *
     * 用 data-* 而不是 class：这些元素常常和别的歌词插件共用，改 className
     * 会让对方的渲染检查失效、重建整行，两边互相触发就会一直抽搐。
     */
    function cleanup() {
      var regions = doc.querySelectorAll("[data-wk-region]");
      for (var i = 0; i < regions.length; i++) {
        if (!regions[i].querySelector("ruby.wk-ruby")) untagData(regions[i], "data-wk-region");
      }
      var fallbacks = doc.querySelectorAll("[data-wk-fallback]");
      for (var j = 0; j < fallbacks.length; j++) {
        var el = fallbacks[j];
        if (!el.querySelector("ruby.wk-ruby")) untagData(el, "data-wk-fallback");
      }
    }

    /**
     * 就地改写已有注音的读音（不拆 DOM、不重注）。
     *
     * 为什么需要它：在线结果回来时会触发"补一次"，以前的做法是 restoreAll() ——
     * 把所有注音先撤掉再重注。问题是重注时还要再问一遍读音，而那些
     * "还没拿到结果"的词这时给不出读音（层序是在线优先、规则垫底，等待期间先不标），
     * 于是已经被注好的整行会变空，过一会儿才陆续补回来 ——
     * 用户看到的就是"全英文的行标注后有概率消失"（英语行词典外的词最多）。
     *
     * 现在只做一件事：把每条记录里 ruby 的读音按当前结果改写一遍，
     * DOM 结构、节点对象统统不动。还没结果的词保持原样，等结果回来再改。
     *
     * @returns {number} 真正改写的注音数量
     */
    /**
     * 从一个已经写好的 ruby 元素上还原一个"够用"的 token。
     *
     * 注音时 token 是分词给的（带 `label` = 段标 `M:`），改写（relabel）时手头只有
     * DOM，于是照同一个判据就地拼一个：底字后面紧跟的是不是冒号。
     * `M: 匿名Mです。` 里行首那个 `M` 的 ruby 后面是 `:`（留白那个压根没有 ruby），
     * 而 `匿名M` 的 M 后面是 `で` —— 位置信息就是这么保住的。
     */
    function tokenAt(el, word) {
      var after = "";
      var n = el ? el.nextSibling : null;
      if (n && n.nodeType === 3) after = n.nodeValue || "";
      var w = String(word == null ? "" : word);
      return { text: w, label: w.length === 1 && /^\s*[:：]/.test(after) };
    }

    function relabel() {
      var updated = 0;
      records.forEach(function (rec, node) {
        var host = rec.host;
        if (!host || !host.isConnected) return;
        for (var i = 0; i < rec.nodes.length; i++) {
          var el = rec.nodes[i];
          if (!el || el.nodeType !== 1 || !el.classList || !el.classList.contains("wk-ruby")) continue;
          // ruby 的第一个子节点就是底字（原文），拿它当查读音的词
          var baseNode = el.firstChild;
          if (!baseNode || baseNode.nodeType !== 3) continue;
          var word = baseNode.nodeValue;
          if (!word) continue;
          var gloss = null;
          var src = null;
          try {
            /*
             * 语境要和注音时用的一致（那次用的是宿主的可见原文）——
             * 换别的东西当语境会让缓存键对不上、白白重问一次。
             */
            var got = lookup(word, contextOf(host, word), tokenAt(el, word));
            if (typeof got === "string") {
              gloss = got;
            } else if (got && got.kana) {
              gloss = got.kana;
              src = got.source || null;
            }
          } catch (e) {
            gloss = null;
          }
          if (!gloss) continue; // 还没结果：保持原样（这一条就是"不消失"的关键）
          var rt = el.querySelector(".wk-rt");
          if (rt && rt.textContent !== gloss) {
            rt.textContent = gloss;
            updated++;
          }
          // 来源变了（规则 -> 大模型）连类名一起换，不然"按来源着色"会一直显示旧颜色
          if (src) setSourceClass(el, src);
          /*
           * 真结果回来了就把"暂定"标记去掉（样式上不再淡）。
           * 判断依据交给上层：pending() 为假 = 这个词已经有确定结论。
           */
          if (el.classList.contains("wk-pending")) {
            var stillPending = false;
            if (pending) {
              try {
                stillPending = !!pending(word, visibleText(host), tokenAt(el, word));
              } catch (e) {
                stillPending = false;
              }
            }
            if (!stillPending) el.classList.remove("wk-pending");
          }
        }
      });
      return updated;
    }

    /** 全量还原（禁用插件 / 设置变更时调用） */
    function restoreAll() {
      records.forEach(function (rec, node) {
        restoreRecord(node, rec);
      });
      records.clear();
      // 同时清掉"这段内容处理过"的记忆。
      // 否则用户手动禁用再启用（或改设置触发 rescan）后，插件会认为
      // 「已经处理过、不用再动」，结果就是怎么都不再注音。
      decidedByHost = new WeakMap();
      cleanup();
    }

    /**
     * 记录是否已经作废。
     *
     * 判据只有一条：宿主不在文档里了。
     *
     * 不能拿「我们插的节点都不见了」当依据 —— 宿主还在、只是 React 把我们的
     * 注音节点摘掉了，这是最常见的情况，而它恰恰需要重新注音，不是丢弃记录。
     * 早期版本在这里判错，导致被摘掉注音的歌词行再也标不回来
     * （restore 完就把记录删了，同一轮里不会再注一次）。
     */
    function orphaned(rec) {
      return !(rec.host && rec.host.isConnected);
    }

    /** 撤掉孤儿记录（连带把丢弃子树里的注入节点摘掉，免得 React 复用时看到过期注音） */
    function dropDetached() {
      var dead = [];
      records.forEach(function (rec, node) {
        if (orphaned(rec)) dead.push(node);
      });
      for (var i = 0; i < dead.length; i++) {
        var rec = records.get(dead[i]);
        for (var j = 0; j < rec.nodes.length; j++) {
          var n = rec.nodes[j];
          if (n.parentNode) n.parentNode.removeChild(n);
        }
        // 宿主整个被摘掉 = 我们刚注的那段文字连同容器一起被对方丢弃了。
        // 真机轨迹里 restored 全部来自这里（一条"失效[...]"都没有），
        // 说明闪烁的形态就是"宿主被反复删掉重建"，而不是判定逻辑出错。
        noteChurn(rec.plain, idOf(rec.host), ageOf(rec.host), rec.peerLine, rec.host);
        records.delete(dead[i]);
      }
      return dead.length;
    }

    /*
     * 注音节点的判据集合。
     *
     * 这里必须认识另外两个插件的注音，不能只认自己的 `<rt class="wk-rt">`：
     *   - wk-rt  本插件（拉丁词 -> 片假名读音）
     *   - kt-rt  katakana-terminator（片假名 -> 英文）
     *   - fg-rt  jp-furigana（汉字 -> 振假名）
     * 少认一个的后果是实打实的：visibleText() 会把别人的注音算成"底字"，
     * 于是底字一直在变、我们每轮都判定"馊了"并重注 —— 就是那种一直闪。
     */
    var ANNOTATION_CLASS = /(^|\s)(wk-rt|kt-rt|fg-rt|wk-ov-label|kt-ov-label)(\s|$)/;

    function isAnnotationNode(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === "RT" || el.tagName === "RP") return true;
      return !!(el.classList && ANNOTATION_CLASS.test(String(el.className || "")));
    }

    /**
     * 某条记录对应的「可见原文」——把所有注音（<rt> / 各家的 .xx-rt）都排除掉，
     * 只看底字。用来判断注音是否仍然有效。
     */
    function visibleText(el) {
      var out = "";
      var walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          for (var p = node.parentNode; p && p !== el; p = p.parentNode) {
            if (isAnnotationNode(p)) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      while (walker.nextNode()) out += walker.currentNode.nodeValue || "";
      return out;
    }

    /**
     * 判断某条记录是不是「馊了」。
     *
     * 只用 isConnected 判断会误伤：网易云（以及 RefinedNowPlaying 这类歌词插件）
     * 几乎每 250ms 就会重建一次歌词行的 DOM，我们插的节点时连时断，于是每轮扫描
     * 都「还原 -> 重新注音」一遍。实测轨迹里就是这个样子：
     *
     *   [pass] regions=50 changed=20 restored=20   ← 每秒重复四次
     *
     * 肉眼看到的就是歌词一直在闪（抽搐）。
     *
     * 所以判断标准换成「可见原文有没有变」：只要底字还是我们注音时那句话，
     * 注音就依然有效，哪怕插进去的节点被 React 换过也无所谓 —— 让它留着，
     * 不要动 DOM，这样才不会闪。
     */
    function isStale(rec, node) {
      var host = rec.host;
      if (!host || !host.isConnected) {
        logStale(rec, "宿主脱链");
        return true;
      }
      // 只有「保留了原节点」的记录才检查它还在不在；
      // 文本以片假名开头时原节点本来就被移除了，不能拿这个当失效依据
      // （否则每轮都会判定为馊了，变成一直闪）。
      if (rec.kept && node.parentNode !== host) {
        logStale(rec, "原文本节点被摘走");
        return true;
      }
      var now = visibleText(host);
      // 比的是"注入当时宿主长什么样"，不是"这个节点的原文"：
      // 宿主里可能还有别人的注音底字（kt-ruby 之类），拿单个节点的原文去比
      // 永远不会相等，于是每轮都判失效。老记录没有 hostPlain 时退回 plain。
      var want = rec.hostPlain != null ? rec.hostPlain : rec.plain;
      if (now !== want) {
        // 记下失败现场：到底算出什么、原文是什么、DOM 长什么样。
        logStale(rec, "可见文本变了", now);
        return true;
      }
      return false;
    }

    /** 诊断用：把「为什么判定失效」写进轨迹（只在给了 log 时） */
    function logStale(rec, why, now) {
      if (!options.log) return;
      options.log(
        "失效[" +
          why +
          "] plain=" +
          JSON.stringify(String(rec.plain == null ? "" : rec.plain).slice(0, 40)) +
          " now=" +
          JSON.stringify(String(now == null ? "" : now).slice(0, 40)) +
          " kept=" +
          !!rec.kept
      );
    }

    /**
     * 元素的简短身份（tag + 前两个 class），写进轨迹用。
     *
     * 排障时最要紧的就是宿主到底是谁：jp-furigana 的 wrap（fg-line）、
     * RNP 的逐字 span（rnp-karaoke-word）、还是整行 div —— 我们的注音
     * 稳不稳，全看这个宿主会不会被对方重建。
     */
    function idOf(el) {
      if (!el || el.nodeType !== 1) return "?";
      var c = String(el.className || "")
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .join(".");
      return (el.tagName || "?") + (c ? "." + c : "");
    }

    /**
     * 元素当前是否可见。
     *
     * 为什么必须判：换歌时上一首的歌词容器（以及 RefinedNowPlaying 的淡出副本）
     * 还会在 DOM 里挂一会儿。如果照样给它注音，换歌过程中就会看到
     * 「上一首的歌词」和正在播放的歌词同时出现，而且两个容器来回被 React
     * 重建、我们也来回重注，表现就是一直抽搐。只处理可见的容器即可。
     *
     * 判定从严：只有「明确隐藏」才排除。
     * - 行内 style 的 display:none / visibility:hidden、hidden 属性：一定可信；
     * - getComputedStyle 拿不到有效值时（jsdom 之类）一律当可见，
     *   不能因为环境测不出来就把正常内容漏掉。
     */
    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      for (var p = el; p && p !== doc.body; p = p.parentElement) {
        if (p.hidden === true) return false;
        var inline = p.style;
        if (inline) {
          if (inline.display === "none") return false;
          if (inline.visibility === "hidden" || inline.visibility === "collapse") return false;
        }
        var s;
        try {
          s = getComputedStyle(p);
        } catch (e) {
          continue; // 拿不到样式就当可见
        }
        if (!s || !s.display) continue;
        if (s.display === "none") return false;
        if (s.visibility === "hidden" || s.visibility === "collapse") return false;
      }
      return true;
    }

    /**
     * 按一组选择器收集元素，去掉互相包含的重复项。
     * 选择器写错不会抛异常（用户自定义选择器可能非法）。
     *
     * lyricCount：前 N 个选择器是「歌词行」，只有它们套用下面两条歌词专属规则
     * （同一 <li> 只取第一块、别再收已经被更细的行覆盖的祖先）。标题白名单那组
     * 不套用 —— 那边是「名字 + 歌手」的结构，套用会把歌手那一块丢掉。
     */
    function collectBySelectors(selectors, lyricCount) {
      var regions = [];
      var seen = [];
      if (typeof lyricCount !== "number") lyricCount = 0;
      for (var i = 0; i < selectors.length; i++) {
        var isLyric = i < lyricCount;
        var found;
        try {
          found = doc.querySelectorAll(selectors[i]);
        } catch (e) {
          continue;
        }
        for (var j = 0; j < found.length; j++) {
          var el = found[j];
          if (!el.isConnected) continue;
          if (!isVisible(el)) continue; // 隐藏的副本（换歌残留）不碰
          if (isSkippedRegion(el)) continue; // RNP 的罗马音层 / 翻译层
          var covered = false;
          for (var s = 0; s < seen.length; s++) {
            if (seen[s].contains(el)) {
              covered = true;
              break;
            }
          }
          if (covered) continue;
          if (isLyric && el.parentElement && el.parentElement.tagName === "LI") {
            /*
             * 同一个 <li> 里只留一块 —— 网易云默认页是 `li.line > p × 2`：
             * 第一个 <p> 原文，第二个 <p> 是中文翻译（3.1.36 实测）。
             *
             * 判据用假名而不是 class：那两层通常没有可用的 class，而
             * 日文原文必有假名、中文翻译一定没有。所以同一个 <li> 里
             * 「已经有带假名的一块」就扔掉后来者；如果前一块没假名而这一块有，
             * 说明前一块是翻译层，把它换掉。两块都没假名（纯英文原文 + 中文翻译）
             * 时留第一个 —— 网易云原文在前。
             */
            var sib = -1;
            for (var q = 0; q < regions.length; q++) {
              if (regions[q].parentElement === el.parentElement) {
                sib = q;
                break;
              }
            }
            if (sib >= 0) {
              var prevKana = RE_KANA.test(visibleText(regions[sib]));
              var curKana = RE_KANA.test(visibleText(el));
              if (prevKana || !curKana) continue; // 这一块是翻译/罗马音层
              regions.splice(sib, 1); // 前一块才是翻译层，换掉它
              seen.splice(sib, 1);
            }
          }
          if (isLyric) {
            /*
             * 更细的行已经收下了，就别再收它的祖先。
             * 否则 `ul.lyric > li` 会把这个 <li> 整个再收一遍，
             * 上面刚踢掉的翻译层又跟着父区域回来了。
             */
            var wraps = false;
            for (var w = 0; w < seen.length; w++) {
              if (el !== seen[w] && el.contains(seen[w])) {
                wraps = true;
                break;
              }
            }
            if (wraps) continue;
          }
          seen.push(el);
          regions.push(el);
        }
      }
      return regions;
    }

    /**
     * 找出要处理的区域。
     *
     *   "lyrics" —— 只找歌词容器
     *   "titles" —— 只找播放栏的歌曲名/歌手（DOM 稳定，默认用它）
     *   "safe"   —— 歌词 + 标题白名单
     *
     * 为什么没有"整页 body"：实测它会把侧边栏/搜索框/歌单名全改了，
     * 直接把应用干崩（见 TARGET_SELECTORS 上面的注释）。宁可少标，不可越界。
     */
    function findRegions(mode) {
      if (!doc || !doc.body) return [];
      if (mode === "titles") return collectBySelectors(TARGET_SELECTORS, 0);
      if (mode === "safe") {
        return collectBySelectors(LYRIC_SELECTORS.concat(TARGET_SELECTORS), LYRIC_SELECTORS.length);
      }
      return collectBySelectors(LYRIC_SELECTORS, LYRIC_SELECTORS.length);
    }

    // 用户传来的 CSS 选择器可能非法，非法时返回空数组而不是抛异常
    function customRegions(selector) {
      try {
        var found = doc.querySelectorAll(selector);
        var out = [];
        for (var i = 0; i < found.length; i++) if (found[i].isConnected) out.push(found[i]);
        return out;
      } catch (e) {
        if (options.log) options.log("选择器无效：" + selector);
        return [];
      }
    }

    /**
     * 跑一遍。
     *   regions 传了 -> 只扫这些区域
     *   没传         -> 按 scope 自己找（annotateAll / scope=lyrics / scope=custom）
     * 返回 { scanned, changed, restored }
     */
    function pass(regions) {
      if (!doc || !doc.body) return { scanned: 0, changed: 0, restored: 0 };

      // 只清掉宿主已经脱离文档的记录（那块 DOM 已经没了）
      var restored = dropDetached();
      skipNotes = [];

      // 注意判断顺序：传了数组就用传进来的，哪怕是空数组。
      // 旧写法 `regions && regions.length ? regions : findRegions(...)`
      // 会把空数组当成"没传"，于是"不标任何区域"反而变成了"扫默认区域"——
      // 设置里关掉播放栏标注后它还在注音，就是这个 bug。
      var list = regions ? regions : findRegions("safe");
      if (!list.length) {
        // 一个区域都没有（例如用户把范围改成"不标"）：
        // 要把已有的注音撤掉，而不是什么都不做 —— 否则关掉开关后
        // 页面上还留着之前注的音，看起来像"关不掉"。
        if (records.size) {
          var removed = records.size;
          restoreAll();
          return { scanned: 0, changed: 0, restored: removed, skipped: 0, unstable: 0 };
        }
        return { scanned: 0, changed: 0, restored: restored };
      }

      // 先收集一遍待检查的文本节点。还原（restoreRecord）会改变 host 的子节点结构，
      // 但那些文本节点本身还是原来那些对象（原节点、我们插入的文本分段都还是同一批），
      // 所以先收集、循环里再读 node.nodeValue 是安全的；反过来在循环内收集会漏掉
      // 「刚被还原成原文」的节点（快照拍在还原之前，拿到的是"今日は"这种被切短的半截文本，
      // 于是那一行永远标不回来）。
      var candidates = collectTextNodes(list);

      var changed = 0;
      var skipped = 0;
      var unstable = 0;
      /** 「这一整块是不是署名表」按行列表缓存，一轮只算一次（见 lineLooksLikeCreditBlock） */
      var creditBlockCache = new Map();
      /*
       * 这一轮里"要等一会儿再试"的最短时间。有节点因为
       * 「文本在动」（MOTION_WINDOW_MS 滑动窗口）或「认输期」（churn 退避）
       * 被跳过时记下来，最后交给上层安排下一次扫描 —— 页面自己不动的时候，
       * 没有这一手那行就永远不注音了（见 pass() 返回值的说明）。
       */
      var retryInMs = 0;
      var errorNotes = [];
      function noteRetry(ms) {
        if (!(ms > 0)) return;
        if (retryInMs === 0 || ms < retryInMs) retryInMs = ms;
      }
      for (var i = 0; i < candidates.length; i++) {
        var node = candidates[i];

        // 所属区域：可能是被包含的子区域，取文档顺序里第一个包含它的
        var region = list[0];
        for (var ri = 0; ri < list.length; ri++) {
          if (list[ri].contains(node)) {
            region = list[ri];
            break;
          }
        }
        if (!region.isConnected || !isVisible(region)) continue;

        /*
         * 这里没有「按行分工、让给 jp-furigana」那套规则 —— 那是
         * katakana-terminator 需要的（两边都要给同一行的片假名/汉字注音，
         * 谁都不肯让就会一直重建）。本插件标的是西文字母，跟振假名
         * 完全不是同一批字，没有分工的必要：一行里既有汉字又有英文时，
         * 两种注音本来就该同时存在。
         *
         * 与 jp-furigana 的冲突只剩"它整行重建会把我们的 ruby 一起换掉"，
         * 那个由共存补丁（第三条 observer + 第五条同步回调）解决；
         * 补丁没打时靠 churn 认输兜底，不会一直闪。
         */
        var hostEl = node.parentNode;
        var visibleNow = hostEl ? visibleText(hostEl) : "";

        // 这一行已经被判定为"跟我们打架"：认输期内不再碰它。
        // 认输的判据是「同一段文字被我们注了又失效、反复好几次」——
        // 键必须用文字：对方每次重建都新建一个 <span> 当宿主
        // （我们的 rec.host 就是它那个 wrap），按元素记永远归不了零。
        if (churnSuppressed(node.nodeValue || "")) {
          unstable++;
          noteSkip("认输期", node.nodeValue, region);
          var untilChurn = churnUntil.get(node.nodeValue || "");
          if (untilChurn) noteRetry(untilChurn - Date.now() + 20);
          continue;
        }

        // 这个 host 的可见文本是不是一直在变？一直在变就这一轮放弃它，
        // 别再追着重注 —— 追就是抽搐。窗口过了会自动重试（见 MOTION_WINDOW_MS）。
        if (hostEl) {
          var motion = motionByHost.get(hostEl);
          var nowMs = Date.now();
          if (!motion) {
            // 第一次见：只登记，不算变化（否则我们自己注音造成的可见文本变化
            // 会被记成"在动"，把正常的行也放弃掉）
            motion = { text: visibleNow, changes: 0, since: nowMs };
            motionByHost.set(hostEl, motion);
          } else {
            /*
             * 窗口过期就重新起算 —— 而且每次扫描都要判，不能只在"文本又变了"时判。
             *
             * 只判变化有个致命的洞：文本变快了几次被跳过之后，文本就安定下来了，
             * 于是再也不会有人来重置计数，那一行就永久不再注音 ——
             * 用户报的「换歌后这句没注音了」正是这个形态（换歌时抖了几下，
             * 之后歌词不动，行也永远不标了）。
             */
            if (motion.changes > 0 && nowMs - motion.since > MOTION_WINDOW_MS) {
              motion.changes = 0;
              motion.since = nowMs;
            }
            if (motion.text !== visibleNow) {
              if (motion.changes === 0) motion.since = nowMs;
              motion.text = visibleNow;
              motion.changes++;
            }
          }
          if (motion.changes >= MOTION_LIMIT) {
            unstable++;
            // 这一条以前不留痕，"某一行不注音"时轨迹里什么都看不到 —— 必须记
            noteSkip("文本在动 " + motion.changes + " 次/" + Math.round(MOTION_WINDOW_MS / 1000) + "s", visibleNow, region);
            // 窗口一过就该重试：算准剩余时间，让上层安排下一次扫描
            noteRetry(MOTION_WINDOW_MS - (nowMs - motion.since) + 50);
            continue;
          }
        }

        var prior = hostEl ? decidedByHost.get(hostEl) : null;
        if (prior) {
          /*
           * 「底字没变」不等于「注音还在」—— visibleText() 是不含注音的，
           * 所以注音被抹掉之后这个比较照样相等。
           *
           * 真机事故：RNP 会在同一个元素里重写内容，把我们的 <ruby> 抹掉，
           * 底字一模一样。以前只看文字就 continue，注音永远回不来
           * （默认页的クローバー、RNP 页的ジオラマ都是这个形态）。
           *
           * 但反过来"注音还在"也不等于"这行还是我们的"：换歌时框架复用同一行，
           * 只把文本节点的值换成新歌词，我们的 ruby 还挂在原地 —— 只判"注音还在"
           * 就会一直跳过，于是上一首的注音留在新歌的行里，正是用户报的
           * 「下一首歌会出现上一首歌的歌词」。
           *
           * 所以判据要两条一起看，而且交给记录来说话：
           *   注音还在（annotationsIntact）且底字没变（!isStale）
           * 只满足一条就往下走，让还原/重注那条路接手。
           * 要不要继续跟下去，统一交给 churn 计数器
           * （它按 age 区分"真死循环"和"正常重绘"，见 CHURN_FAST_MS）。
           */
          var recHere = records.get(node);
          if (recHere && !isStale(recHere, node) && annotationsIntact(recHere)) {
            skipped++;
            continue; // 注音在位、底字也是我们注的那句 —— 一个字节都不动
          }
          noteChurn(
            visibleNow,
            idOf(hostEl),
            typeof prior.at === "number" ? Date.now() - prior.at : ageOf(hostEl),
            enclosingPeerLine(hostEl),
            hostEl
          );
        }

        // 已经注过音的行：只有确认「需要动它」才动。
        var rec = records.get(node);
        if (rec) {
          var stale = isStale(rec, node);
          var intact = annotationsIntact(rec);
          /*
           * 关键：isStale() 只看"底字有没有变"，而底字是不含注音的 ——
           * 所以"注音被摘掉了、底字没变"这种情况它判定为"依然有效"。
           * 只看它的话就会永远跳过、注音再也回不来（真机：默认页的クローバー、
           * RNP 页的ジオラマ，都属于"元素没换、只把 <ruby> 摘掉"）。
           * 所以"注音还在不在"必须一起看。
           */
          if (!stale && intact) continue; // 注音在位、底字没变 —— 一个字节都不动
          // 要动它了。先记一次 churn（age 够大就不算打架，见 noteChurn）。
          if (rec.plain != null) {
            noteChurn(rec.plain, idOf(rec.host), ageOf(rec.host), rec.peerLine, rec.host);
          }
          if (stale && intact) {
            // 底字真的变了：还原（摘掉注音、写回原文）再重注
            restoreRecord(node, rec);
            restored++;
          } else {
            // 我们的节点已经不在 DOM 里了，不需要还原 —— 「还原」本身是一连串
            // DOM 变更，在真机上就是可见的一闪。丢掉记录、往下重新注音即可。
            records.delete(node);
          }
        }

        // 每次重新读值：上面可能刚把原文写回来
        var text = node.nodeValue || "";
        // 单个字母的节点也要看（逐字歌词、别的插件拆行时 `T氏` 的 T 就是这种），
        // 只把"连一个可读词都没有"的短节点挡掉
        if (!text) continue;
        if (text.length < 2 && !matcher.hasReadable(text)) continue;
        if (RE_CREDIT.test(text) || RE_CREDIT_HARD.test(text)) continue; // 制作信息行跳过
        /*
         * 制作信息行被拆成好几个节点时（RNP 常见），碎片本身不像制作信息 ——
         * 往上拿整行的文字再判一次，否则 `混音&母带处理：宫奇` 旁边的 `Gon`
         * 会被注上音（用户截图）。判到了就记一笔跳过原因，方便排障。
         */
        var lineForCredit = enclosingLineText(hostEl);
        if (lineForCredit && lineForCredit !== text && (RE_CREDIT.test(lineForCredit) || RE_CREDIT_HARD.test(lineForCredit))) {
          noteSkip("制作信息行（同行的另一个片段）", text, region);
          continue;
        }
        // 夹在署名块中间的行（前后都是署名行）：整块署名里关键词表漏掉的那一行靠它
        if (insideCreditBlock(lineElementOf(hostEl), creditBlockCache)) {
          noteSkip("制作信息块（前后都是署名行）", text, region);
          continue;
        }
        try {
          if (annotateNode(node, region)) {
            changed++;
            // 只在真的注了音之后才打区域标记。
            // 用 data-* 属性而不是 class：区域元素常和别的歌词插件共用，
            // 改它的 className 会让对方判定"这行变了"并重建整行，
            // 我们的注音跟着被丢掉、下一轮再标 —— 来回就是抽搐。
            if (region.setAttribute && !region.hasAttribute("data-wk-region")) {
              region.setAttribute("data-wk-region", "1");
              // 记录改了哪个元素：同一行反复出现在这里就说明没收敛
              if (options.log) {
                options.log(
                  "标记区域 " +
                    (region.tagName || "?") +
                    "." +
                    String(region.className || "").split(" ").slice(0, 2).join(".") +
                    " 文本=" +
                    JSON.stringify(String(region.textContent || "").slice(0, 24))
                );
              }
            }
          }
        } catch (e) {
          // 单个节点失败不影响其它节点；把现场记下来便于定位
          var errMsg =
            "注音失败 tag=" +
            (region.tagName || "?") +
            " cls=" +
            String(region.className || "").slice(0, 60) +
            " err=" +
            ((e && e.message) || e);
          if (errorNotes.length < SKIP_NOTE_MAX) errorNotes.push(errMsg);
          if (options.log) options.log(errMsg);
        }
      }
      // 把这一轮的"跳过原因"写进轨迹 —— 用户说"某处没注上"时，答案就在这里
      if (options.log && skipNotes.length) {
        options.log("未注音 " + skipNotes.join(" | "));
      }
      var notes = skipNotes;
      skipNotes = [];
      return {
        scanned: list.length,
        changed: changed,
        restored: restored,
        skipped: skipped,
        unstable: unstable,
        // 跳过原因（上层会写进 WK.stats()，排障时一眼看到"为什么这行没注音"）
        skips: notes,
        errors: errorNotes, // 单个节点注音时抛的异常（以前只在轨迹里，现在也会回到上层）
        /*
         * 这一轮有节点是因为"文本在动 / 认输期"被跳过的，那就要自己安排下一轮。
         *
         * 为什么必须这样（用户报的「换歌的时候…还是没注音」）：如果换歌之后页面
         * 不再发生变动（典型情况是歌是暂停的：歌词列表渲染一次就不动了），
         * 就再也没有事件来触发下一轮扫描 —— 被跳过的那一行会永远空着，
         * 直到用户点一下播放/滚动才补上（看着就像"插件坏了"）。
         * 返回 0 表示这一轮没有需要重试的节点。
         */
        retryInMs: retryInMs,
      };
    }

    function injectedCount() {
      return records.size;
    }
    /** 当前处于"认输期"的行数 —— 这些行是故意不注音的，不是漏了 */
    function churnedCount() {
      return churnUntil.size;
    }

    /*
     * 同步补注音：给"刚刚把这一行整个换新"的对方插件用的钩子。
     *
     * 为什么必须是同步的：真机轨迹里 `changed=1 restored=1` 每秒重复五次、
     * 永不停止 —— 对方每 ~200ms 重建一次这一行，我们靠 MutationObserver 被叫醒，
     * 补的动作要等到下一帧才落地，中间那一帧就是"没有注音"的样子，
     * 肉眼就是一直在闪。被对方直接调用就没有这个空窗。
     *
     * 重入保护：我们自己的 pass 也会改 DOM，虽然对方的 observer 已经忽略我们的
     * 变更（补丁第三条），但这是同步调用链上的一环，递归没有任何好处，挡掉。
     */
    var repairing = false;
    function repairLine(lineEl) {
      if (repairing) return false;
      if (!lineEl || lineEl.nodeType !== 1 || !lineEl.isConnected) return false;
      repairing = true;
      try {
        pass([lineEl]);
        return true;
      } catch (e) {
        return false;
      } finally {
        repairing = false;
      }
    }

    return {
      pass: pass,
      restoreAll: restoreAll,
      relabel: relabel,
      findRegions: findRegions,
      customRegions: customRegions,
      injectedCount: injectedCount,
      churnedCount: churnedCount,
      repairLine: repairLine,
      cleanup: cleanup,
    };
  }

  // ---------------------------------------------------------------- 样式

  function styles(opts) {
    opts = opts || {};
    var size = opts.rtSize == null ? 60 : opts.rtSize;
    var opacity = (opts.rtOpacity == null ? 80 : opts.rtOpacity) / 100;
    var colorBySource = !!opts.colorBySource;
    return [
      "ruby.wk-ruby {",
      "  ruby-position: over;",
      "  -webkit-ruby-position: before;",
      "  ruby-align: center;",
      "}",
      "rt.wk-rt, .wk-rt {",
      "  font-size: " + size + "%;",
      "  opacity: " + opacity + ";",
      "  font-weight: normal;",
      "  font-style: normal;",
      "  letter-spacing: 0;",
      "  line-height: 1.1;",
      "  text-align: center;",
      "  white-space: nowrap;",
      "  text-transform: none;",
      "  user-select: none;",
      "  -webkit-user-select: none;",
      "}",
      // 内核不支持 ruby 排版：注音脱离文档流，免得 <rt> 退化成 block 撑坏行高
      '[data-wk-fallback] { position: relative; }',
      '[data-wk-fallback] > ruby.wk-ruby { position: relative; display: inline-block; }',
      '[data-wk-fallback] > ruby.wk-ruby > .wk-rt {',
      "  position: absolute;",
      "  left: 50%;",
      "  bottom: 100%;",
      "  transform: translateX(-50%);",
      "  -webkit-transform: translateX(-50%);",
      "  display: block;",
      "  pointer-events: none;",
      "}",
      // 这几条是为了对抗 RefinedNowPlaying 之类的逐字歌词插件：它会给自己插的
      // 节点打 opacity，嵌套相乘会把注音压得几乎看不见，所以对注音强制不透明。
      //
      // 但底字和注音要分开对待（用户报的「这句不透明度怎么这么低」就是这么来的）：
      //   - ruby.wk-ruby 是底字在外面那层，锁死 1，永远不许别人把它压淡；
      //   - rt.wk-rt 是注音，它要用用户设的那个不透明度 ——
      //     老版本这里写死 `rt.wk-rt { opacity: 1 !important }`，把设置面板里的
      //     「注音不透明度」整个压掉了（拖了没反应，页面上只有"暂定"那 45% 看得见，
      //     于是所有待判定的行都显得特别淡）。
      "ruby.wk-ruby { opacity: 1 !important; }",
      "rt.wk-rt, .wk-rt { opacity: " + opacity + " !important; }",
      /*
       * 「暂定读音」：在线那层还在问，先用规则结果顶上。
       * 比上面的值再淡一档（跟着用户的设置走，不然把不透明度调到 30% 时
       * "暂定"反而比正常还清楚），真结果回来后 relabel() 会去掉这个类。
       */
      "ruby.wk-ruby.wk-pending .wk-rt { opacity: " + Math.max(0.2, opacity * 0.6).toFixed(2) + " !important; }",
      /*
       * 排障用：把每一层的读音染成不同颜色，一眼看出"这个音到底是谁给的"。
       * 颜色只用在这两类节点上（都是我们自己的），不改任何既有元素的样式；
       * 关掉这个开关就一条都不注入（类名照旧挂着，随时能开）。
       */
      colorBySource
        ? [
            "ruby.wk-src-dict > .wk-rt { color: #46d17e !important; }", // 离线词典：最可信，绿
            "ruby.wk-src-song > .wk-rt { color: #2fd6a8 !important; }", // 整首/整句专属读音（人工核过）：青绿
            "ruby.wk-src-learned > .wk-rt { color: #2fae7a !important; }", // 模型答案沉淀成的词条：深绿（同属"离线词条"）
            "ruby.wk-src-letters > .wk-rt { color: #3fb6d8 !important; }", // 记号 / 字母名：青
            "ruby.wk-src-romaji > .wk-rt { color: #6f8ff0 !important; }", // 罗马音：蓝
            "ruby.wk-src-rule > .wk-rt { color: #e8a33d !important; }", // 英文音译规则：橙
            "ruby.wk-src-llm > .wk-rt { color: #c07ce8 !important; }", // 大模型：紫
            "ruby.wk-src-google > .wk-rt { color: #e0629a !important; }", // 免费接口：品红
            "ruby.wk-src-online > .wk-rt { color: #e0629a !important; }", // 老名字，同上
          ].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function styleEl(doc, id) {
    var el = doc.getElementById(id);
    if (!el) {
      el = doc.createElement("style");
      el.id = id;
      doc.head.appendChild(el);
    }
    return el;
  }

  function applyStyles(doc, opts) {
    if (!doc || !doc.head) return;
    styleEl(doc, "western-katakana-style").textContent = styles(opts);
  }

  function removeStyles(doc) {
    var el = doc && doc.getElementById("western-katakana-style");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  return {
    createAnnotator: createAnnotator,
    applyStyles: applyStyles,
    removeStyles: removeStyles,
    hasRubyLayout: hasRubyLayout,
  };
});
