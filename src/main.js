/*
 * 西文字母片假名注音 · BetterNCM 插件入口
 *
 * 给日语歌歌词里的西文字母（clover / light / diorama / Sekai / Отчизну /
 * Θάλασσα …）标片假名读音。方向跟 katakana-terminator（片假名 -> 英文）正好相反，
 * 两个可以同时开：一行里既有片假名又有英文时，两种注音一起出现。
 *
 * 读音来源（层序在 core/reading.js 里定，面板里可调）：
 *   1. 离线词典（core/dict.js，6892 条）：人工词条、官方歌名读音、运行期沉淀、大模型批量
 *   2. 日式罗马音切分（sekai -> セカイ，歌词里官方写的罗马音）
 *   3. 西文各语种的拼读（core/langs.js：法 / 德 / 拉 / 葡 / 荷 / 斯瓦希里 / 拼音 / 俄 / 希）
 *      以及各语言的借词表（core/loan.js）
 *   4. 大模型校正 / 免费接口（配了 key 或开着在线时，只查"猜的、没把握"的词）
 *   5. 英文音译规则（light -> ライト，兜底，永远给得出结果）
 *
 * 另外两档"整首 / 整句专属读音"排在所有层前面（core/songs.js 与本文件里的
 * LINE_READINGS）；"连字符标记长音"是在常规读音之后再补一拍。
 */
(function () {
  "use strict";

  var LOG = "[western-katakana]";
  var REPO_URL = "https://github.com/YXLEI0/western-katakana-betterncm";

  /*
   * 插件从「latin-katakana」改名叫「western-katakana」，localStorage 的键前缀也跟着换了。
   * 老用户的配置、学会的词、缓存、用量账本不该因为一次改名全丢，所以做一次性搬家：
   * 新键不存在、老键存在才复制，老键留着不删（万一要回退）。得在读 config / 建各层之前跑。
   */
  (function migrateStorage() {
    var SUFFIX = [".config", ".trace", ".learned.v1", ".usage", ".llm.v1", ".cache.v1", ".off", ".dev"];
    try {
      for (var i = 0; i < SUFFIX.length; i++) {
        var oldKey = "latin-katakana" + SUFFIX[i];
        var newKey = "western-katakana" + SUFFIX[i];
        var val = localStorage.getItem(oldKey);
        if (val !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, val);
      }
    } catch (e) {
      /* localStorage 不可用就跳过（隐私模式 / 配额满） */
    }
  })();

  // ------------------------------------------------------------ 基础工具

  function log() {
    var msg = "";
    try {
      msg = Array.prototype.join.call(arguments, " ");
    } catch (e) {
      msg = "(unserializable)";
    }
    try {
      console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
    return msg;
  }

  function warn() {
    var msg = "";
    try {
      msg = Array.prototype.join.call(arguments, " ");
    } catch (e) {
      msg = "(unserializable)";
    }
    trace("WARN", msg);
    try {
      console.warn.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  /*
   * 运行轨迹信标：把每轮扫描的关键信息和异常写进 localStorage，
   * 出问题时可以离线读出来（tools/read-trace.js 能直接从网易云的 leveldb 里读，
   * 那里面的值是 Snappy 压缩的、还跨 record 分片，别手工捞）。
   * 上限 250 行，超出丢最旧的，避免把配额写爆。
   */
  var TRACE_KEY = "western-katakana.trace";
  var TRACE_MAX = 250;

  function trace(kind, msg) {
    try {
      if (typeof localStorage === "undefined") return;
      var arr = [];
      try {
        arr = JSON.parse(localStorage.getItem(TRACE_KEY)) || [];
      } catch (e) {
        arr = [];
      }
      var t = new Date();
      var pad = function (n) {
        return (n < 10 ? "0" : "") + n;
      };
      var stamp = pad(t.getHours()) + ":" + pad(t.getMinutes()) + ":" + pad(t.getSeconds());
      arr.push(stamp + " [" + kind + "] " + String(msg).slice(0, 300));
      if (arr.length > TRACE_MAX) arr = arr.slice(arr.length - TRACE_MAX);
      localStorage.setItem(TRACE_KEY, JSON.stringify(arr));
    } catch (e) {
      /* 写不进去就算了，绝不能因为记日志把插件搞崩 */
    }
  }

  // 改了默认值就 +1：用来把旧版本存下来的设置迁移掉
  var CONFIG_VERSION = 2;
  var CONFIG_KEY = "western-katakana.config";

  var DEFAULTS = {
    enabled: true,
    online: true, // 词典/规则都没把握时是否联网校正（Google 接口，不用填 key）
    // ---- 大模型校正（质量比规则高一个数量级，需要自己填 key）
    llmEnabled: true,
    llmEndpoint: "https://api.deepseek.com/chat/completions",
    llmModel: "deepseek-chat",
    llmKey: "",
    /*
     * 读音来源的调用顺序（越靠前越优先），设置面板里可以上下调。
     * 记号 / 缩写 / 字母名 / 长音符罗马字不在这张表里 —— 那是"这个词该怎么断"，
     * 不是"读音该信谁"，永远最先判（见 core/reading.js 的 lookup）。
     */
    layerOrder: ["dict", "romaji", "llm", "google", "rule"],
    // ---- API 用量统计：单价只用来"估算花费"，0 = 不算（单位：元 / 百万 token）
    usagePriceIn: 0,
    usagePriceOut: 0,
    annotateAll: true, // 除歌词外，也标播放栏的歌名/歌手
    /*
     * 非日语歌（歌词里一个假名都没有，比如纯英语/法语/中文歌）是否也注音。
     * 默认 true = 照旧全标；打开「只标日语歌」就整首跳过（含播放栏标题）。
     * 判据看整首歌词（有一行含假名就算日语歌），所以日语歌里的纯英文行
     * 不会被误伤。
     */
    annotateNonJapanese: true,
    scope: "all", // titles | lyrics | all | custom
    customSelector: "",
    rtSize: 55, // 注音字号（相对底字百分比）
    rtOpacity: 80, // 注音不透明度
    colorBySource: false, // 按读音来源给注音上色（排障用，见设置面板的图例）
    verbose: false,
  };

  // ------------------------------------------------------------ 读音来源与顺序

  /*
   * 这几层用户能在设置面板里上下调，越靠前越优先。语义是"排在当前答案前面的在线层"
   * 才有资格覆盖它：把英文音译规则提到大模型 / 免费接口前面，就等于一个请求都不发
   * （不想联网的用法）；把大模型提到词典前面，则连词典命中的词也要让它判一遍。
   *
   * 记号 / 缩写 / 字母名 / 长音符罗马字（`D/N/A`、`I'll`、`LDK`、`Tōkyō`）不在这张表里，
   * 它们决定的不是"读音该信谁"，而是"这个词该怎么断"，永远最先判。
   */
  var LAYER_IDS = ["dict", "romaji", "llm", "google", "rule"];
  var LAYER_NAMES = {
    dict: "离线词典",
    romaji: "日式罗马音",
    llm: "大模型校正",
    google: "免费接口",
    rule: "英文音译规则",
  };
  // 异步层（要发请求、结果晚一点回来）；另外三层是同步的，读的时候当场就有答案
  var ASYNC_LAYERS = { llm: true, google: true };

  /** 去重 + 补齐：脏配置、旧版本配置都不至于少一层（缺的按默认顺序补在后面） */
  function normalizeLayerOrder(list) {
    var out = [];
    var src = list && typeof list.length === "number" ? list : [];
    var i;
    for (i = 0; i < src.length; i++) {
      if (LAYER_IDS.indexOf(src[i]) >= 0 && out.indexOf(src[i]) < 0) out.push(src[i]);
    }
    for (i = 0; i < LAYER_IDS.length; i++) {
      if (out.indexOf(LAYER_IDS[i]) < 0) out.push(LAYER_IDS[i]);
    }
    return out;
  }

  /** 这一层在用户排的顺序里排第几（越小越优先）；不在表里的（如 letters）算最优先 */
  function layerRank(id) {
    var i = config.layerOrder.indexOf(id);
    return i < 0 ? -1 : i;
  }

  /**
   * 当前层序里「英文音译规则」有没有挡住离线词典 / 日式罗马音。
   *
   * 规则层对每个词都给得出答案（它就是拼写猜测），排在它下面的层永远轮不到。用户把
   * 词典往下拖了几格就是这么踩的：`the` 变成规则猜的 セ、`this` 变黄（也是规则层）、
   * `I'll` 被拆成「イ + ル」= イル，大模型也不再被咨询（规则先答了）。面板里的 ↑↓
   * 已经不让这么换，这个函数兜住手改配置 / 老配置，并在设置面板里说出来。
   *
   * @returns {Array<string>} 被挡住的层名（空数组 = 没问题）
   */
  function ruleBlocksSync() {
    var ruleIdx = config.layerOrder.indexOf("rule");
    var out = [];
    if (ruleIdx < 0) return out;
    for (var i = ruleIdx + 1; i < config.layerOrder.length; i++) {
      var id = config.layerOrder[i];
      if (id === "dict" || id === "romaji") out.push(LAYER_NAMES[id] || id);
    }
    return out;
  }

  /*
   * 这一行是不是日语罗马字 —— 决定短音节按罗马音还是按英文词读。
   *
   * 用户报的 `Yes, PA PI PU PE PO POP UP!(Hey!!)Yes, MA MI MU ME MO MORE JUMP!(Yeah!!)`
   * 这种"罗马音节练习"式写法，用词典效果很差。打架的正是那几个短音节：
   *   PI 词典=パイ（英文 pi）  罗马音=ピ
   *   PE 词典=ピーイー（把 "P E" 当字母念）罗马音=ペ
   *   PO 词典=ピーオー        罗马音=ポ
   *   MI/ME/MO 词典=ミー/ミー/モー  罗马音=ミ/メ/モ
   * `pi/pe/po/mi/me/mo` 又全都在英文常用词表里，所以"它是不是英文词"这条判据分不开
   * （`me`/`no`/`so` 真是英文词，`pi`/`po` 只是被词表收进去了）。能分开的是整行的构成：
   * 一行里同时出现好几个"词典读音和罗马音读音打架"的短音节，那就是罗马字行，英文歌词
   * 不会这么写。
   *
   * 判据：一行里有 5 个以上不同的「≤3 字母 + 能切成罗马音 + 词典里有条目但读音不同」的词。
   *   `PA PI PU PE PO`（5 个）、`MA MI MU ME MO`（5 个）、用户那行（6 个）都算
   *   `No, no, no, I need you so`（no/i/so/you = 4 个）不算，英文行，保持词典读音
   *   `we can go to the sea`（we/go/to = 3 个）不算
   * 3 个 / 4 个都不行，常见英文短词凑到四个太容易：实测那两行就是这么被判进去的，
   * go/to/no/you 被读成 ゴ/ト/ノ/ヨウ。5 个才真正是"罗马音节练习"。命中之后这些词会
   * 标成没把握，在线层（大模型）拿到整句语境还能改回去。
   *
   * 另外整行还得几乎都是短词（≤3 字母占 60% 以上）：只数"打架几个"的话，`Shoo, Gimme more`
   * 这种长词句也可能被算进去。真正的罗马字行短词占比很高（实测用户那行 83%，
   * `Shoo, Gimme more` 是 0%）。
   */
  var ROMAJI_LINE_MIN = 5;
  var ROMAJI_LINE_SHORT_RATIO = 0.6;
  var romajiLineCache = new Map();
  var ROMAJI_LINE_CACHE_MAX = 200;
  /** 每一行的语种判定也缓存（同一行会被问很多次） */
  var langLineCache = new Map();
  var LANG_CACHE_MAX = 200;

  /*
   * 只在英语拼写里出现的字母组合：日语罗马字里没有 th / wh / ck / gh / ph，也没有 q 和 x
   * （θ・w・ク・q・x 都不是日语音节）。
   *
   * 用户报的 `Knock knock! Let me go in and get the ace` 里 `me` 被读成 メ。`me` 的词典
   * 读音是 ミー（对的），但这一行被判成了罗马字行，于是整行短词都改按罗马音读，`me`→メ、
   * `go`→ゴ…。这类英文行只要再多一个打架的短词（`so`/`no`/`you`…）就够 5 个门槛，
   * 靠"数短词"分不开英文行和罗马字行。
   *
   * 拼写能分开：罗马字写不出 `ck`（knock）、`th`（the/with）、`wh`（what）、`q`（question）。
   * 所以这一行里出现这类组合就不是罗马字行，词典读音照用 —— 比"再调几个数字"稳得多。
   * 对照：`PA PI PU PE PO POP UP!` / `MA MI MU ME MO MORE JUMP!` 里一个都没有，
   * 仍然是罗马字行（那里要的正是 パピプペポ）。
   */
  var RE_ENGLISH_ONLY = /(th|wh|ck|gh|ph|q|x)/;

  /** ≤3 个纯字母、且能干净地切成日语罗马音 -> 返回那个读音，否则 null */
  function shortRomajiOf(word) {
    var w = String(word || "").toLowerCase();
    if (!/^[a-z]{1,3}$/.test(w)) return null;
    if (typeof WKReading === "undefined" || !WKReading.romajiToKatakana) return null;
    try {
      return WKReading.romajiToKatakana(w) || null;
    } catch (e) {
      return null;
    }
  }

  function lineLooksRomaji(line) {
    if (!line) return false;
    var key = String(line);
    if (romajiLineCache.has(key)) return romajiLineCache.get(key);
    var looks = false;
    try {
      var tokens = WKMatcher.scan(key);
      var dict = typeof WKDict !== "undefined" ? WKDict.words : {};
      var seen = {};
      var distinct = 0;
      var latin = 0;
      var short = 0;
      var englishOnly = false;
      for (var i = 0; i < tokens.length; i++) {
        var w0 = String(tokens[i].text || "").toLowerCase();
        if (!/^[a-z]+$/.test(w0)) continue;
        latin++;
        if (/^[a-z]{1,3}$/.test(w0)) short++;
        if (RE_ENGLISH_ONLY.test(w0)) englishOnly = true;
        if (seen[w0]) continue;
        seen[w0] = true;
        var rom = shortRomajiOf(w0);
        if (!rom) continue;
        var dictKana = dict[w0];
        // 词典里有、而且和罗马音读音不一样 —— 这才是"会读歪"的那种词
        if (dictKana && dictKana !== rom) distinct++;
      }
      // 光数"打架几个"不够：英文行也能凑够（`No, no, no, I need you so` 到 4 个）。
      // 真正的罗马字行短词占比很高（`PA PI PU PE PO POP UP` 83%），所以再加一条 60% 的门槛
      var shortRatio = latin ? short / latin : 0;
      // 三条一起看：打架的短音节够多、整行几乎都是短词、拼写上不像英语（见 RE_ENGLISH_ONLY）
      looks = !englishOnly && distinct >= ROMAJI_LINE_MIN && shortRatio >= ROMAJI_LINE_SHORT_RATIO;
    } catch (e) {
      looks = false; // 判断失败就当它不是罗马字行，绝不因此影响注音
    }
    if (romajiLineCache.size > ROMAJI_LINE_CACHE_MAX) romajiLineCache.clear();
    romajiLineCache.set(key, looks);
    return looks;
  }

  /**
   * 一个本地答案在"谁说了算"上的实际名次：一般就是它所在层的名次，但没把握的答案
   * （confident:false）一律按最低那层（英文音译规则）算，排在它后面的在线层就有资格覆盖它。
   *
   * 罗马音层只是"整串能切成日语音节"，`shake`(sha-ke) / `open`(o-pe-n) 这种英文词会被它
   * 读成 シャケ / オペン。按名次拍板的话（罗马音排在在线层前面）这些词就永远读错、大模型
   * 也没机会纠；标成没把握再按这个名次算，在线层就能接手。用户把「英文音译规则」拖到在线层
   * 前面（纯离线用法）时，这个名次也跟着变成最优先，在线层照样不会被打扰。
   */
  function effectiveRank(r) {
    if (!r) return -1;
    // 「学会的词」是离线词条，名次按离线词典算（在线层不再覆盖它 —— 省的就是这一笔）
    if (r.source === "learned") return layerRank("dict");
    if (r.source !== "letters" && r.confident === false) return layerRank("rule");
    return layerRank(r.source);
  }

  /** 大模型那层现在能不能用（开关 + 填了 key） */
  function llmAvailable() {
    if (!state.llm || !state.llm.config) return false;
    var c = state.llm.config();
    return !!(c.enabled && c.hasKey);
  }

  function googleAvailable() {
    return !!(config.online && state.corrector);
  }

  function layerAvailable(id) {
    if (id === "llm") return llmAvailable();
    if (id === "google") return googleAvailable();
    return true;
  }

  /** 同步层（词典/罗马音/规则）在用户顺序里的相对次序 */
  function syncLayerOrder() {
    var out = [];
    for (var i = 0; i < config.layerOrder.length; i++) {
      if (!ASYNC_LAYERS[config.layerOrder[i]]) out.push(config.layerOrder[i]);
    }
    return out;
  }

  /** 把顺序推给读音引擎；配置坏了先纠正，免得引擎拿到半张表 */
  function applyLayerOrder() {
    config.layerOrder = normalizeLayerOrder(config.layerOrder);
    if (state.reader && state.reader.setOrder) state.reader.setOrder(syncLayerOrder());
  }

  function loadConfig() {
    var saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    } catch (e) {
      /* 坏了就用默认值 */
    }
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    for (var k2 in saved) if (k2 in DEFAULTS) cfg[k2] = saved[k2];
    // 层序是数组，且可能被手改坏：当场去重补齐（也顺便复制一份，别改到 DEFAULTS）
    cfg.layerOrder = normalizeLayerOrder(cfg.layerOrder);
    cfg.configVersion = CONFIG_VERSION;
    return cfg;
  }

  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (e) {
      warn("设置保存失败", e && e.message);
    }
  }

  var config = loadConfig();

  /*
   * 紧急开关：插件一旦把页面搞崩，设置面板也进不去，所以留一个不依赖 UI 的关闭方式。
   * 在网易云的开发者工具控制台执行：
   *     localStorage['western-katakana.off'] = '1'   // 并重启
   */
  function emergencyOff() {
    try {
      return localStorage.getItem("western-katakana.off") === "1";
    } catch (e) {
      return false;
    }
  }

  function devMode() {
    try {
      if (typeof plugin !== "undefined" && plugin.devMode) return true;
      return localStorage.getItem("western-katakana.dev") === "1";
    } catch (e) {
      return false;
    }
  }
  var DEV = devMode();

  // ------------------------------------------------------------ 状态

  var state = {
    reader: null,
    corrector: null,
    llm: null,
    usage: null,
    learned: null,
    annotator: null,
    observer: null,
    timer: null,
    timerIsRaf: false,
    tickTimer: null,
    applied: false,
    lastPassMs: 0,
    lastPassAt: 0,
    lastResult: null,
    error: null,
    betterncmVersion: "",
    // 整首专属读音表（见 SONG_READINGS，每轮扫描开始时按歌名/歌词重算）
    songWords: null,
    // 「连字符串」（连字符标记长音，见 collectLongVowelWords）：同一趟扫描算出来
    longWords: null,
  };

  // ------------------------------------------------------------ 读音

  /*
   * 取一个词的显示读音，连同"这个读音最终是谁给的"一起返回：
   *   { kana, source }，source ∈ dict / romaji / rule / letters / llm / google
   *
   * 层序由用户在设置面板里定，默认 离线词典 > 罗马音 > 大模型校正 > 免费接口 > 英文音译规则。
   * 同步层（词典 / 罗马音 / 规则）当场给答案，异步层（大模型 / 免费接口）要发请求。规则是
   * 拼写音译（hello -> ヘッラオ、question -> クワエサション），所以默认排在在线层后面，
   * 但它也是一切的兜底：在线层挂了 / 没配 / 在退避时立刻放行，否则断网就等于一个字都不标。
   * 排序顺带给了两个用法 —— 把「英文音译规则」提到在线层前面就是一个请求都不发（纯离线），
   * 把「大模型」提到词典前面则连词典命中的词也让它判一遍（词典偶有错条目，这是逃生门）。
   *
   * 底线是绝不返回 null 让这行空着：高优先的在线层还在问的时候，用现成的答案顶上并标成
   * "暂定"（`wk-pending`，样式淡一点），结果回来由 annotate.relabel() 就地改写 ——
   * 用户报过的"全英文行标注后有概率消失"就是这么修的。source 是给排障用的（「按来源着色」
   * 把每一层染成不同颜色），只要读音字符串的调用方走 readForDisplay()，控制台 WK.display() 用它。
   */
  /**
   * 本地几层给的答案（含"罗马字行里的短音节改读罗马音"这条修正）。
   * resolveReading 和 isProvisional 必须用同一个答案，否则会出现"页面上显示得很确定、
   * 其实正在问模型"这种不同步。
   */
  /**
   * 全大写的 2~3 字母紧贴着假名出现（`ATフィールド`、`のSOS`、`BGMオン`）。
   *
   * 用户截图 `対バンにはATフィールド` 把 `AT` 读成了词典里的英文词 at（アット），正确是
   * エーティー。这一条我们自己分不清（`AT`/`NO`/`GO`/`UP` 拼写一样、场合不同），所以只调
   * "把握"、不改读音：标成没把握，让大模型按整句判（判完还会自动沉淀成离线词条）。
   * 模型没开时显示的还是原来的词音，不会更差。
   */
  /**
   * 这一行是什么语言（带缓存），判不出来返回 null —— 那就按老规矩走：离线词典 ->
   * 日语罗马音 -> 英文规则。
   *
   * 支持的语言在 core/langs.js 里：法语 / 德语 / 拉丁语 / 葡萄牙语 / 荷兰语 / 斯瓦希里语 /
   * 汉语拼音 / 俄语（西里尔）/ 希腊语。判定分两层：① 这一行自己的特征（WKLangs.detect）；
   * ② 整首歌词的多数语种兜底（songLanguage）—— `Dominatus`、`Ukuu ukuu` 这种两三个词的
   * 短行自己分数不够，但整首都是拉丁语 / 斯瓦希里语时应该照那种语言读，不然一行一个读法。
   */
  function lineLang(line) {
    if (!line) return null;
    var key = String(line);
    if (langLineCache.has(key)) return langLineCache.get(key);
    var id = null;
    try {
      if (typeof WKLangs !== "undefined" && WKLangs.detect) {
        id = WKLangs.detect(key);
        if (!id) {
          var song = songLanguage();
          if (song && WKLangs.fits(song, key)) id = song;
        }
      }
    } catch (e) {
      id = null; // 判语言失败绝不影响注音
    }
    if (langLineCache.size > LANG_CACHE_MAX) langLineCache.clear();
    langLineCache.set(key, id);
    return id;
  }

  /**
   * 整首歌词的语种：数每一行自己判出来的语种，取出现次数最多的那个（至少 2 行）。
   * 只用来兜住短行，不参与长行的判定；按歌词文本缓存（换歌才重算）。
   */
  var songLangCache = { key: "", value: null };
  function songLanguage() {
    if (typeof WKLangs === "undefined" || !WKLangs.detect) return null;
    if (!state.annotator || !state.annotator.findRegions) return null;
    var regions;
    try {
      regions = state.annotator.findRegions("lyrics");
    } catch (e) {
      return null;
    }
    if (!regions || !regions.length) return null;
    var texts = [];
    for (var i = 0; i < regions.length; i++) {
      try {
        texts.push(regions[i].textContent || "");
      } catch (e2) {
        texts.push("");
      }
    }
    var key = texts.join("\n").slice(0, 4000);
    if (songLangCache.key === key) return songLangCache.value;
    var counts = {};
    var best = null;
    var bestN = 0;
    for (var j = 0; j < texts.length; j++) {
      var id = null;
      try {
        id = WKLangs.detect(texts[j]);
      } catch (e3) {
        id = null;
      }
      if (!id) continue;
      counts[id] = (counts[id] || 0) + 1;
      if (counts[id] > bestN) {
        bestN = counts[id];
        best = id;
      }
    }
    songLangCache = { key: key, value: bestN >= 2 ? best : null };
    return songLangCache.value;
  }

  /*
   * 单字母单位符号：整串字母全是单位时才按单位名读。
   *
   * 用户截图 `誰にも邪魔されないような（V, W, A）`，这三个是物理单位（ボルト / ワット /
   * アンペア），要读单位名而不是字母名。而 `(A, B) 退屈に打つ QTE` 里的 A / B 要读字母名
   * （エー / ビー）—— 两者都是括号里的字母串，区别是这一串里有没有非单位的字母：`B` 不是单位，
   * 那一串就按字母名；`V / W / A` 全是单位，按单位名。判据见 lineAllUnitSymbols。
   * `Ω` 是希腊字母，另有单位读法（オーム，见 localReading）。
   * 想加单位（`J` ジュール、`N` ニュートン…）就往这张表里补一行，但每加一个都会让"全是单位"
   * 更容易成立（`N/A` 就是这么会中的），所以只收常用、低歧义的。
   */
  var UNIT_SYMBOL = {
    V: "\u30DC\u30EB\u30C8", // ボルト
    W: "\u30EF\u30C3\u30C8", // ワット
    A: "\u30A2\u30F3\u30DA\u30A2", // アンペア
  };

  /*
   * 单位词（两个以上字母的）：同样只在紧跟在数字后面时按单位读。
   *
   * 用户截图 `半径300mmの体で必死に鳴いてる` 的 `mm` 没注音 —— 那首歌的罗马音行唱的就是
   * `sa n bya ku mi ri`（ミリ），所以这里给 ミリ。判据只看"紧跟数字"，`mm~`（语气词）、
   * `PV:` 这种不会被误伤。表是人工维护的（读法唯一、日语里就这么写），想加就往里补一行。
   */
  var UNIT_WORD = {
    MM: "\u30DF\u30EA", // ミリ
    CM: "\u30BB\u30F3\u30C1", // センチ
    KM: "\u30AD\u30ED", // キロ
    KG: "\u30AD\u30ED", // キロ
    ML: "\u30DF\u30EA\u30EA\u30C3\u30C8\u30EB", // ミリリットル
    HZ: "\u30D8\u30EB\u30C4", // ヘルツ
    KHZ: "\u30AD\u30ED\u30D8\u30EB\u30C4", // キロヘルツ
    MHZ: "\u30E1\u30AC\u30D8\u30EB\u30C4", // メガヘルツ
    DB: "\u30C7\u30B7\u30D9\u30EB", // デシベル
    KW: "\u30AD\u30ED\u30EF\u30C3\u30C8", // キロワット
    KV: "\u30AD\u30ED\u30DC\u30EB\u30C8", // キロボルト
  };

  /**
   * 这一行里的单字母全是单位符号（`（V, W, A）` ✓、`(A, B)` ✗ —— B 不是单位）。
   *
   * 还要有**两种以上不同的**单位符号：`A A A A A` 那种同一个字母重复的读字母名
   * （用户截图：`A A A A A じゃないか` 里的 A 被读成了 アンペア）。
   */
  var unitLineCache = new Map();
  function lineAllUnitSymbols(line) {
    var s = String(line == null ? "" : line);
    if (!s || typeof WKMatcher === "undefined") return false;
    if (unitLineCache.has(s)) return unitLineCache.get(s);
    var ok = false;
    var n = 0;
    var kinds = {};
    var distinct = 0;
    try {
      var toks = WKMatcher.scan(s);
      ok = true;
      for (var i = 0; i < toks.length; i++) {
        var t = String(toks[i].text);
        if (t.length !== 1) continue;
        if (!UNIT_SYMBOL[t]) {
          ok = false;
          break;
        }
        if (!kinds[t]) {
          kinds[t] = true;
          distinct++;
        }
        n++;
      }
    } catch (e) {
      ok = false;
    }
    var out = ok && n >= 2 && distinct >= 2; // 孤零零一个字母、或同一个字母重复，都不算单位表
    if (unitLineCache.size > 500) unitLineCache.clear();
    unitLineCache.set(s, out);
    return out;
  }

  /** 这个词在行里是不是紧跟在数字后面（`30W` の W、`100V` の V、`5A` の A） */
  function digitBefore(word, line) {
    var s = String(line == null ? "" : line);
    var w = String(word == null ? "" : word);
    if (!s || !w) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("[0-9\uFF10-\uFF19]\\s*" + esc + "(?![0-9\uFF10-\uFF19])").test(s);
  }

  /** 字母紧挨着数字（`B4` / `A4` / `2B`）：型号 / 规格里的字母，读字母名 */
  function digitAdjacent(word, line) {
    var s = String(line == null ? "" : line);
    var w = String(word == null ? "" : word);
    if (!s || !w) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var D = "[0-9\uFF10-\uFF19]";
    return new RegExp("(?:" + D + "\\s*" + esc + "|" + esc + "\\s*" + D + ")").test(s);
  }

  /** 字母紧贴着日文（`T氏` / `B面` / `X線`：字母前后直接是汉字 / 假名，中间没空格） */
  function gluedToJapanese(word, line) {
    var s = String(line == null ? "" : line);
    var w = String(word == null ? "" : word);
    if (!s || !w) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var CJK = "[\\u3041-\\u3096\\u30A1-\\u30FA\\u4E00-\\u9FFF]";
    return new RegExp("(?:" + CJK + esc + "|" + esc + CJK + ")").test(s);
  }

  /** 同一行里还有没有别的西文词（长度 ≥2）—— `T Is My Everything` 里的 T 是句子里的字母 */
  function lineHasOtherWord(word, line) {
    var s = String(line == null ? "" : line);
    if (!s || typeof WKMatcher === "undefined") return false;
    var w = String(word == null ? "" : word);
    var toks;
    try {
      toks = WKMatcher.scan(s);
    } catch (e) {
      return false;
    }
    for (var i = 0; i < toks.length; i++) {
      var t = String(toks[i].text);
      if (t === w) continue;
      if (t.length >= 2 && /[A-Za-z]/.test(t)) return true;
    }
    return false;
  }

  /**
   * 这一行是不是 ASCII art / 颜文字（`~i.!.|| i !!i !!~`、`( ﾟ∀ﾟ)o彡ﾟ …`）。
   *
   * 用户两张截图：图案里的 `i` 被标成 アイ、颜文字 `)o彡ﾟ` 里的 `o` 被标成 オ —— 那些字母
   * 是画用的，不是词。判据故意收得很紧，宁可漏判也不能把正常歌词整行跳过：① 这一行的西文词
   * 全是单个字母（正常歌词里几乎不会这样）；② 符号字符（非字母、非假名、非汉字、非空白）
   * 有 6 个以上。`(A, B)`（符号 3 个）和 `（V, W, A）`（符号 4 个）都不够，那两种照旧注音。
   */
  function looksLikeAsciiArt(line) {
    var s = String(line == null ? "" : line);
    if (!s || typeof WKMatcher === "undefined") return false;
    var toks;
    try {
      toks = WKMatcher.scan(s);
    } catch (e) {
      return false;
    }
    if (!toks.length) return false;
    for (var i = 0; i < toks.length; i++) {
      // 记号零件（`D/N/A` 的 D）不算"单个字母的词"：那是正经的字母串
      if (toks[i].notation === true) return false;
      if (String(toks[i].text).length !== 1) return false;
    }
    var sym = 0;
    for (var j = 0; j < s.length; j++) {
      var ch = s.charAt(j);
      if (ch === " " || ch === "\t") continue;
      if (/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF\uFF21-\uFF3A\uFF41-\uFF5A]/.test(ch)) continue;
      // 数字也算"正文"（`100V と 5A と 30W の電源` 不能被当成图案）
      if (/[0-9\uFF10-\uFF19]/.test(ch)) continue;
      if (/[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF\u3005\u3006\u30FC]/.test(ch)) continue;
      sym++;
    }
    return sym >= 6;
  }

  function gluedUpperCase(word, line) {
    var w = String(word == null ? "" : word);
    if (!/^[A-Z]{2,3}$/.test(w)) return false;
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var KANA = "[\\u3041-\\u3096\\u30A1-\\u30FA]";
    return new RegExp("(?:" + KANA + esc + "|" + esc + KANA + ")").test(s);
  }

  /*
   * 日语里通行的那批首字母缩写：紧贴假名时按字母名读。
   *
   * 用户截图 `対バンにはATフィールド` 的 `AT` 被读成 アット（词典里 at = アット 先命中了），
   * 该读 エーティー（A.T.フィールド）。同类还有 OP 映像 / ED テーマ / CM ソング / BGM…
   *
   * 不写"全大写 2~3 个字母紧贴假名就逐字母读"那种通则，是因为歌词里 `YOU` / `SKY` / `DAY` /
   * `NO` / `GO` / `UP` 也常写成全大写，那几个要按词读，光看拼写分不出来（`AT` 既是英文介词 at、
   * 也是 A.T.）。只有这张人工核过的表才钉成字母名，表外的照旧标成没把握、交给大模型按整句判。
   */
  var GLUED_ACRONYM = {
    at: "\u30A8\u30FC\u30C6\u30A3\u30FC", // エーティー（ATフィールド）
    op: "\u30AA\u30FC\u30D4\u30FC", // オーピー（OP映像）
    ed: "\u30A4\u30FC\u30C7\u30A3\u30FC", // イーディー（EDテーマ）
    cm: "\u30B7\u30FC\u30A8\u30E0", // シーエム
    pv: "\u30D4\u30FC\u30D6\u30A4", // ピーブイ
    mv: "\u30A8\u30E0\u30D6\u30A4", // エムブイ
    se: "\u30A8\u30B9\u30A4\u30FC", // エスイー（効果音）
    bgm: "\u30D3\u30FC\u30B8\u30FC\u30A8\u30E0", // ビージーエム
    iq: "\u30A2\u30A4\u30AD\u30E5\u30FC", // アイキュー
    dj: "\u30C7\u30A3\u30FC\u30B8\u30A7\u30FC", // ディージェー
    mc: "\u30A8\u30E0\u30B7\u30FC", // エムシー
    cg: "\u30B7\u30FC\u30B8\u30FC", // シージー
    ng: "\u30A8\u30CC\u30B8\u30FC", // エヌジー
    ol: "\u30AA\u30FC\u30A8\u30EB", // オーエル
    hp: "\u30A8\u30A4\u30C1\u30D4\u30FC", // エイチピー
    pc: "\u30D4\u30FC\u30B7\u30FC", // ピーシー
    sf: "\u30A8\u30B9\u30A8\u30D5", // エスエフ
  };

  /*
   * 全大写缩写里，日语习惯读法**不是字母名**的那几个。
   *
   * 用户截图：`LVあげすぎて` 的 `LV` 被逐字母读成 エルブイ —— 日语里 LV 就是 "level"，
   * 读 レベル。这类词按字母名念反而听不懂，所以单独钉一张小表（排在缩写规则前面）。
   */
  var ACRONYM_WORD = {
    lv: "\u30EC\u30D9\u30EB", // レベル
    // 用户点名：`OMG 情けない` 的 OMG 要展开成 oh my god（不是逐字母 オーエムジー）
    omg: "\u30AA\u30FC\u30DE\u30A4\u30B4\u30C3\u30C9", // オーマイゴッド
  };

  /*
   * 掩码词（`T○itter`）：`○` 是**一个字被涂掉**，整串仍是一个词。
   * 按"一个字母的通配"去词典里找，只有一个候选就按它读（t○itter → twitter →
   * ツイッター）；找不出或不止一个就退回普通读法。
   */
  var maskCache = {};
  function maskedReading(word) {
    var raw = String(word == null ? "" : word);
    if (!/[\u25CB\u25CF]/.test(raw)) return null;
    if (maskCache[raw] !== undefined) return maskCache[raw];
    var out = null;
    try {
      var dict = typeof WKDict !== "undefined" ? WKDict.words : null;
      if (dict) {
        var low = raw.toLowerCase();
        var src = "";
        for (var ci = 0; ci < low.length; ci++) {
          var ch = low.charAt(ci);
          if (/[\u25CB\u25CF]/.test(ch)) src += "[a-z]";
          else if (ch >= "a" && ch <= "z") src += ch;
        }
        var re = new RegExp("^" + src + "$");
        var hit = null;
        var keys = Object.keys(dict);
        for (var i = 0; i < keys.length; i++) {
          if (!re.test(keys[i])) continue;
          if (hit !== null && hit !== dict[keys[i]]) {
            hit = null; // 不止一个候选：不猜
            break;
          }
          hit = dict[keys[i]];
        }
        out = hit;
      }
    } catch (e) {
      out = null;
    }
    maskCache[raw] = out;
    return out;
  }

  /*
   * 颜文字里的字母读的是**表情的音**，不是字母名 —— `:-b`（吐舌头）读 ボ（用户点名，
   * 不要长音）。表里没有的字母退回字母名。
   */
  var EMOTICON_LETTER_KANA = {
    b: "\u30DC", // ボ
  };

  /*
   * 连字符**切断**的片段读法（`wa-wa-wait` 的 `wa-`、`ar-ar-ar-ar` 的 `ar-`、
   * `Ni-ni-ni-ni-ni-` 的 `ni-`）：用户逐条点名 —— 这些片段不是在念字母或单词，
   * 是在重复那个音的开头，所以 `wa-` ウェ、`ar-` ア、`ni-` ネ
   * （单独一个 `wa` 还是 ワ、`ar` 还是 アール，只有被连字符切断时才按这张表读）。
   */
  var DASH_FRAGMENT_KANA = {
    wa: "\u30A6\u30A7", // ウェ
    ar: "\u30A2", // ア
    ni: "\u30CD", // ネ
  };

  /*
   * 孤零零一个希腊字母（不在希腊语行上时）：读日语里通行的字母名 / 单位读法。
   *
   * 用户截图 `無限増幅回路（Ω）` 里的 Ω 是电阻单位，日语读 オーム（不是 オメガ）。大写 Ω 按单位，
   * 小写 ω 保留字母名 オメガ（颜文字里的 ω 由 letters.js 的"装饰符号粘连"挡住，根本不标）。
   * 希腊语行上的单字母是词（`η` 是冠词、`ω` 是感叹词），照旧走希腊语引擎。
   */
  var GREEK_LETTER_KANA = {
    "\u03B1": "\u30A2\u30EB\u30D5\u30A1", "\u03B2": "\u30D9\u30FC\u30BF", "\u03B3": "\u30AC\u30F3\u30DE",
    "\u03B4": "\u30C7\u30EB\u30BF", "\u03B5": "\u30A4\u30D7\u30B7\u30ED\u30F3", "\u03B6": "\u30BC\u30FC\u30BF",
    "\u03B7": "\u30A4\u30FC\u30BF", "\u03B8": "\u30B7\u30FC\u30BF", "\u03B9": "\u30A4\u30AA\u30BF",
    "\u03BA": "\u30AB\u30C3\u30D1", "\u03BB": "\u30E9\u30E0\u30C0", "\u03BC": "\u30DF\u30E5\u30FC",
    "\u03BD": "\u30CB\u30E5\u30FC", "\u03BE": "\u30AF\u30B7\u30FC", "\u03BF": "\u30AA\u30DF\u30AF\u30ED\u30F3",
    "\u03C0": "\u30D1\u30A4", "\u03C1": "\u30ED\u30FC", "\u03C3": "\u30B7\u30B0\u30DE", "\u03C2": "\u30B7\u30B0\u30DE",
    "\u03C4": "\u30BF\u30A6", "\u03C5": "\u30A6\u30D7\u30B7\u30ED\u30F3", "\u03C6": "\u30D5\u30A1\u30A4",
    "\u03C7": "\u30AB\u30A4", "\u03C8": "\u30D7\u30B5\u30A4", "\u03C9": "\u30AA\u30E1\u30AC",
  };

  /**
   * 俄语（西里尔）字母名：全大写缩写的逐字母读法（`СССР` -> エスエスエスエル）。
   *
   * 用户截图：苏联国歌那几行里的 `СССР` 被读成 スル —— 引擎把它当词，又按俄语正字法把重复的 С
   * 并成一个，于是就剩 С+Р。缩写不是词：西里尔全大写、又没有元音的（СССР / РФ / КГБ / МВД /
   * ЛГБТ…）一律逐字母读，和拉丁那边的 `spellOutAcronym`（SOS -> エスオーエス）同一个口径。
   * 带元音的（`ГИМН` ギムン、`ЛЮБОВЬ`）不是缩写，照旧走俄语引擎。
   */
  var CYRILLIC_LETTER_KANA = {
    "\u0430": "\u30A2\u30FC", // а アー
    "\u0431": "\u30D9\u30FC", // б ベー
    "\u0432": "\u30F4\u30A7\u30FC", // в ヴェー
    "\u0433": "\u30B2\u30FC", // г ゲー
    "\u0434": "\u30C7\u30FC", // д デー
    "\u0435": "\u30A4\u30A7\u30FC", // е イェー
    "\u0451": "\u30E8\u30FC", // ё ヨー
    "\u0436": "\u30B8\u30A7\u30FC", // ж ジェー
    "\u0437": "\u30BC\u30FC", // з ゼー
    "\u0438": "\u30A4\u30FC", // и イー
    "\u0439": "\u30A4\u30FC", // й イー
    "\u043A": "\u30AB\u30FC", // к カー
    "\u043B": "\u30A8\u30EA", // л エリ
    "\u043C": "\u30A8\u30E0", // м エム
    "\u043D": "\u30A8\u30CC", // н エヌ
    "\u043E": "\u30AA\u30FC", // о オー
    "\u043F": "\u30DA\u30FC", // п ペー
    "\u0440": "\u30A8\u30EB", // р エル
    "\u0441": "\u30A8\u30B9", // с エス
    "\u0442": "\u30C6\u30FC", // т テー
    "\u0443": "\u30A6\u30FC", // у ウー
    "\u0444": "\u30A8\u30D5", // ф エフ
    "\u0445": "\u30CF\u30FC", // х ハー
    "\u0446": "\u30C4\u30A7\u30FC", // ц ツェー
    "\u0447": "\u30C1\u30A7\u30FC", // ч チェー
    "\u0448": "\u30B7\u30E3\u30FC", // ш シャー
    "\u0449": "\u30B7\u30C1\u30E3\u30FC", // щ シチャー
    "\u044B": "\u30A6\u30A3", // ы ウィ
    "\u044D": "\u30A8\u30FC", // э エー
    "\u044E": "\u30E6\u30FC", // ю ユー
    "\u044F": "\u30E4\u30FC", // я ヤー
  };

  /** 西里尔全大写、且一个元音都没有的缩写（СССР / РФ / КГБ…） */
  function cyrillicAcronym(word) {
    var w = String(word == null ? "" : word);
    if (!/^[\u0410-\u042F\u0401]{2,6}$/.test(w)) return false;
    return !/[\u0410\u0415\u0401\u0418\u041E\u0423\u042B\u042D\u042E\u042F]/.test(w);
  }

  /**
   * 整首 / 整句专属读音：这首歌（或这一句歌词）里的这个词就这么读。两个作用域，都是
   * 人工核过、不许别的层改的读音。
   *
   * 1. 整首（`SONG_READINGS`，用户要求"按这一首歌名做"）：按歌名（播放栏那行）或者整首
   *    歌词里的识别词命中，命中后这首歌里的这些词一律按表读。例：`夢現妄想世界`
   *    （夢限大みゅーたいぷ）把日语词写成罗马字，短横线是长音 —— `MO-SO` モーソー（妄想）、
   *    `SO-ZO` ソーゾー（創造）、`KYO-SO` キョーソー（競争）、`YUME` ユメ（夢）。
   *    没有这张表时 `ZO` 走罗马音层读成 ゾ、`KYO` 读成 キョ（那个 ZO 还被换行拆到了下一行，
   *    模型也只看得到 `ZOは海をこえ`）。
   *
   * 2. 整句（`LINE_READINGS`）：只有这一句歌词里的这个词这么读。用户点名
   *    `Xだけの"人マニア"` 的 X 指的是 Twitter（那首歌官方翻译那行写着 `X(Twitter)`），
   *    要读 ツイッター；但"日语行里孤零零一个 X 一律读 Twitter"太宽了，只在这一句歌词命中，
   *    别处的 X 该是字母名（`X線` エックス線）或者留白。
   *
   * 两处都按"词 + 形状"配对，命中才换读音；返回的读音带自己的来源名 `song`，层序里它排在
   * 所有层前面（`layerRank("song")` 是 -1，在线层不会被咨询）。
   */
  var SONG_READINGS = (typeof WKSongs !== "undefined" && WKSongs.list) || [];

  var LINE_READINGS = [{ word: "X", line: /X\s*だけの/, kana: "\u30C4\u30A4\u30C3\u30BF\u30FC" }];

  /** 这一句里有没有为这个词指定的专属读音（见 LINE_READINGS） */
  function lineReading(word, line) {
    var w = String(word == null ? "" : word);
    var s = String(line == null ? "" : line);
    if (!s) return null;
    for (var i = 0; i < LINE_READINGS.length; i++) {
      if (LINE_READINGS[i].word !== w) continue;
      if (LINE_READINGS[i].line.test(s)) return LINE_READINGS[i].kana;
    }
    return null;
  }

  /** 歌名或整首歌词命中哪一条整首专属读音（都没有返回 null） */
  function matchSongReading(title, lyrics) {
    var t = String(title == null ? "" : title);
    var l = String(lyrics == null ? "" : lyrics);
    for (var i = 0; i < SONG_READINGS.length; i++) {
      var e = SONG_READINGS[i];
      if (e.title && t && e.title.test(t)) return e.words;
      if (e.marker && l && e.marker.test(l)) return e.words;
    }
    return null;
  }

  /**
   * 连字符标记长音：由短横线串起来的全大写罗马字音节（`MO-SO` / `KYO-SO` / `SO-ZO`）每一节
   * 都读长音 —— 用户点名要的规则（「夢現妄想世界」里 `MO-SO` モーソー、`SO-ZO` ソーゾー、
   * `KYO-SO` キョーソー）。
   *
   * 约束是宁可漏不可错：只认全大写、形如罗马字音节的词（1~2 个辅音字母 + 一个元音，共
   * 2~3 个字母），德语复合词（`Looser-Krankheit-Was`）、小写词（`mo-so`）、记号里的单字母
   * （`X-Y`，那是逐字母读的另一档）都不吃这条；短横线必须紧贴前一个词（`MO-SO` 算，
   * `MO - SO` 不算）；至少两节（孤零零一个 `MO-` 不算）。
   *
   * 扫描范围是整首歌词（拼成一段看），因为这种词常被歌词换行拆开（上一行结尾 `SO-`、
   * 下一行开头 `ZOは海をこえ`），只看一行判不出来。
   */
  var RE_LONG_SYL = /^[A-Z]{1,2}[AIUEO]$/;
  var RE_HYPHEN_HEAD = /^[-\u2010-\u2015]/;

  function collectLongVowelWords(text) {
    var out = {};
    var s = String(text == null ? "" : text);
    if (!s) return out;
    // 交替取出「词」「词后面的间隔」
    var re = /([A-Za-z]+)([^A-Za-z]*)/g;
    var words = [];
    var gaps = [];
    var m;
    while ((m = re.exec(s))) {
      words.push(m[1]);
      gaps.push(m[2]);
    }
    for (var i = 0; i < words.length; i++) {
      if (!RE_LONG_SYL.test(words[i]) || !RE_HYPHEN_HEAD.test(gaps[i] || "")) continue;
      // 从这一节往后把整串收完（A-B-C 三节都要）
      var run = [words[i]];
      var j = i;
      while (j + 1 < words.length && RE_HYPHEN_HEAD.test(gaps[j] || "") && RE_LONG_SYL.test(words[j + 1])) {
        run.push(words[j + 1]);
        j++;
      }
      if (run.length < 2) continue;
      for (var k = 0; k < run.length; k++) out[run[k]] = true;
      i = j;
    }
    return out;
  }

  /** 这个词是不是"连字符串"里的一节（见 collectLongVowelWords） */
  function isLongVowelWord(word) {
    var w = String(word == null ? "" : word);
    return !!(state.longWords && state.longWords[w]);
  }

  /** 连字符标记长音：常规读出来的尾拍补上 ー（已经有长音符就不动） */
  function withLongVowel(word, r) {
    if (!r || !r.kana || !isLongVowelWord(word)) return r;
    if (/\u30FC$/.test(r.kana)) return r;
    return { kana: r.kana + "\u30FC", source: r.source, confident: r.confident };
  }

  /**
   * 这一轮扫描时"整首专属读音"表是哪一张（换歌要重新算）。
   *
   * 歌名取播放栏那行（复用注音层认的那套选择器，见 annotate.js 的 TARGET_SELECTORS）；
   * 拿不到歌名就只靠歌词里的识别词。结果按"歌名 + 歌词开头"缓存，避免每轮都重算。
   * 顺带把「连字符串」（见 collectLongVowelWords）也算出来 —— 同一趟扫描、同一份歌词。
   */
  function updateSongScope() {
    if (!state.annotator) return;
    var title = "";
    var lyrics = "";
    try {
      var ts = state.annotator.findRegions("titles");
      if (ts && ts.length) title = ts[0].textContent || "";
    } catch (e) {
      title = "";
    }
    try {
      var ls = state.annotator.findRegions("lyrics");
      var buf = [];
      for (var i = 0; i < (ls ? ls.length : 0); i++) buf.push(ls[i].textContent || "");
      lyrics = buf.join("\n");
    } catch (e2) {
      lyrics = "";
    }
    var key = title + "\u0000" + lyrics.slice(0, 4000);
    if (songScopeCache.key === key) return;
    songScopeCache = { key: key, words: matchSongReading(title, lyrics), longWords: collectLongVowelWords(lyrics) };
    state.songWords = songScopeCache.words;
    state.longWords = songScopeCache.longWords;
  }

  /**
   * 这一行里有没有"成串的大写单字母"（`(A, B)`、`A・B`、`A B C`）。
   *
   * 用户要的：`(A, B) 退屈に打つ QTE (Why?)` 里的 A / B 该读字母名（エー / ビー），而英文行里
   * 当冠词的 A 该读 ア。只看"单个大写字母"分不出来，得看整行，但判据不能用"这行有两个单字母"：
   * `A story of love and I` 也有两个（冠词 A 和代词 I），那样 A 就被读成 エー 了。所以只认两种
   * 形状：被标点串起来的（A, B）、A・B、A&B；还有三个以上孤立的 A B C。
   */
  function lineLetterRun(line) {
    var s = String(line == null ? "" : line);
    if (!s) return false;
    if (/[A-Z]\s*[,.\u3001\u30FB\u00B7\u2022\/&|]\s*[A-Z]/.test(s)) return true;
    if (typeof WKMatcher === "undefined") return false;
    var toks;
    try {
      toks = WKMatcher.scan(s);
    } catch (e) {
      return false;
    }
    /*
     * 记号（`D/N/A`、`M・I・D・I`、`X-Y`）在 matcher 里已经拆成了一个字母一个词
     * （用户要"分别注在每个字母上"），所以这里数的是"记号零件"：有两个就说明
     * 这一行是逐字母读的。剩下的那种（`A B C` 三个以上孤立的）照旧数非粘连的单字母。
     */
    var nota = 0;
    var iso = 0;
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].notation === true) nota++;
      else if (/^[A-Z]$/.test(toks[i].text) && toks[i].glued !== true) iso++;
      if (nota >= 2 || iso >= 3) return true;
    }
    return false;
  }

  /**
   * 像打码的重复字母串：后面紧挨着平假名（`“XX”してる`、`XXの…`、`XXする`）。
   *
   * 用户先说 `YY` 要标、又说"打码的 XX 还是留白更好"，两者拼写一模一样（都是全大写 2~3 个
   * 重复字母），本地只能看用法：打码词是当句子里一个词用的，后面必然跟着日语词尾 / 助词
   * （してる・の・する…），缩写是独立写的（`「YY」`、`YY!`、`YY と`）。所以判据就是"后面紧挨着
   * 的一个字符是不是平假名"。两可的极端情况宁可留白：留白只是少一个注音，标错是错的读音。
   */
  function censorLikeRun(word, line) {
    var w = String(word == null ? "" : word);
    if (!/^([BCDFGHJKLMNPQRSTVWXYZ])\1{1,2}$/.test(w)) return false;
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 中间允许夹一个收尾的引号/括号（`“XX”してる`、`（XX）する`）
    var tail = "[\u2019\u201D\u300D\u300F\uFF09\u3011\"']*[\u3041-\u3096]";
    if (new RegExp(esc + tail).test(s)) return true;
    /*
     * 旁边就是打码符号的也算打码（用户截图 `俺の XXX ! !`）：
     * `XXX` 后面隔一个空格就是 ``，那一串和 `` 是同一个用法（把脏话抹掉），
     * 读成 エックスエックスエックス 反而错 —— 用户指名要留白。
     * 判据：这个词后面（可夹空白/引号括号）紧跟两个以上的 `*` / `＊` / `×` / `※`，
     * 或者前面紧挨着这种符号串（`XXX`）。
     */
    var marks = "[*\uFF0A\u00D7\u203B]{2,}";
    var between = "[\\s\u2019\u201D\u300D\u300F\uFF09\u3011\"']*";
    if (new RegExp(esc + between + marks).test(s)) return true;
    return new RegExp(marks + between + esc).test(s);
  }

  /**
   * 紧挨在打码符号后面的词（`ed` 里的 `ed`、`*ing` 里的 `ing`）：
   * 那是被隐去的词的一部分，单个片段没有意义 —— 不标。
   * 用户截图：`Oh, I'll be ed up` 里只有 `ed` 头上有 エド。
   *
   * 两个以上才算打码：单个 `*` / `※` 是脚注或演奏提示，后面往往是一个完整的词
   * （用户截图 `(*teto sax solo)` —— `teto` 被当成 `ed` 的碎片跳过了，
   * 那一行里 `sax` / `solo` 都标了、就它空着）。
   */
  function censoredBefore(word, line) {
    var w = String(word == null ? "" : word);
    var s = String(line == null ? "" : line);
    if (!w || !s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("[*\uFF0A\u00D7\u203B]{2,}\u200B*" + esc + "(?![A-Za-z])").test(s);
  }

  /**
   * 单个大写字母的段标（`(A:` / `B:` / `A：`）：不注音。
   *
   * 用户截图：拉丁语歌词里的 `Vindicia (A: Vanitatum sentio) (B: Sentio dolor, …)`
   * —— 这里的 A / B 是分句、分段的标记，既不是字母名也不是单词。判据只看
   * "这个字母后面紧跟冒号"，所以 `(A, B)` 那种成串的照样读字母名（用户当初要的
   * 就是那个），英文行里的冠词 A 也不受影响。
   */
  function labelLetter(word, line, token) {
    var w = String(word == null ? "" : word);
    if (!/^[A-Z]$/.test(w)) return false;
    /*
     * 注音层把 token 一起传进来时，按 token 的 `label` 标记判（位置准）：
     * `M: 匿名Mです。` 里行首那个 `M:` 是说话人标记（留白），而 `匿名M` 的 M 要读 エム ——
     * 只看"这一行里有没有 `M:`"会把两个都留白（用户截图）。
     */
    if (token) return token.label === true;
    var s = String(line == null ? "" : line);
    if (!s) return false;
    var esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 控制台调用（没有 token）时退回老判据：这一行里有"这个字母 + 冒号"
    return new RegExp(esc + "\\s*[:：]").test(s);
  }

  /** 这段文字里有没有"后面紧跟日语词尾"的重复字母串（打码）—— 给排障用 */
  function looksCensoredRun(text) {
    var s = String(text == null ? "" : text);
    var runs = s.match(/[A-Za-z]{2,3}/g);
    if (!runs) return false;
    for (var i = 0; i < runs.length; i++) {
      if (!/^([A-Za-z])\1+$/.test(runs[i])) continue;
      if (censorLikeRun(runs[i], s)) return true;
    }
    return false;
  }

  /**
   * 全角西文字母折成半角（`ＮＯ` -> `NO`、`ｄｒｅａｍ` -> `dream`）。
   *
   * 用户截图：`こんなんじゃ（ＮＯ!）` 里的 `ＮＯ` 是全角的（歌词排版常这么写），
   * 而 matcher 之前只认半角字母，于是整个词压根没被当成词，一个注音都没有。
   * 折的是判断用的副本 —— 注音层写回 DOM 的底字用的是 token.text（原文），
   * 所以页面上一个字符都不会变。
   */
  function foldFullwidthLetters(s) {
    return String(s == null ? "" : s).replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
  }

  /** 全字母逐个读成字母名（`AM` -> エーエム）；表里没的字母返回 null */
  function letterNames(word) {
    if (typeof WKReading === "undefined" || !WKReading.LETTER_KANA) return null;
    var s = String(word == null ? "" : word).toLowerCase();
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var k = WKReading.LETTER_KANA[s.charAt(i)];
      if (!k) return null;
      out += k;
    }
    return out || null;
  }

  /**
   * 全大写拉丁缩写紧贴数字（`AM6:00` / `PM11:30` / `AC30` / `MP3`）：型号、时刻那种写法。
   *
   * 用户截图：`AM6:00 目覚まし時計を起こして` 里的 `AM` 被离线词典的英语单词 `am`
   * （アム）接走了 —— 词典键都是小写，分不清 `am` 和 `AM`。这一判排在词典那一层
   * 前面：全大写又贴着数字的，是缩写不是词。
   *
   * 位置用 token 的（分词时算好的，最准）；没有 token 的调用方退回在行里找。
   */
  function capsBeforeDigit(word, line, token) {
    var w = String(word == null ? "" : word);
    if (!/^[A-Z]{2,6}$/.test(w)) return false;
    /*
     * 别误伤全大写写的真词：`LOVE2` / `HEY3` 这种是歌词在喊词，不是缩写
     * （逐字母念成 エルオーブイイー 就毁了）。判据：3 个字母以上、带元音、
     * 而且词典或英文常用词表里有它 —— 那就不算缩写。
     * `AM` / `PM` 只有两个字母，恰好是"同一个拼写的词"里最常见的例外
     * （`am` 是英语动词、`pm` 不是词），贴着数字时读字母名。
     */
    if (w.length > 2 && /[AEIOUY]/.test(w)) {
      var low = w.toLowerCase();
      var dict = typeof WKDict !== "undefined" ? WKDict.words : null;
      var enWords = typeof WKEnWords !== "undefined" ? WKEnWords.words : null;
      if ((dict && dict[low] !== undefined) || (enWords && enWords[low])) return false;
    }
    var s = String(line == null ? "" : line);
    if (!s) return false;
    if (token && typeof token.end === "number" && typeof token.start === "number" && s.slice(token.start, token.end) === w) {
      return /[0-9]/.test(s.charAt(token.end));
    }
    return new RegExp("(^|[^A-Za-z])" + w + "(?=[0-9])").test(s);
  }

  function localReading(word, line, token) {
    /*
     * 全角字母先折半角（见 foldFullwidthLetters）：词和它所在的那一行都折，
     * 后面查词典 / 沉淀 / 模型 / 语种判定 / 打码与段标那几判就都按折过的看。
     */
    word = foldFullwidthLetters(word);
    if (line != null) line = foldFullwidthLetters(line);
    /*
     * 数字后面的单位词（`300mm` ミリ、`5kg` キロ、`60Hz` ヘルツ）。
     *
     * 必须排在打码那几判前面：`mm` 长得就像打码用的重复字母串（`XX`），
     * 而它后面又紧跟着假名（`300mmの体で`）—— 放到后面就会被当成打码留白
     * （第一版就是这么错的）。用户截图：`半径300mmの体で` 的 `mm` 原来没注音，
     * 那首歌的罗马音行唱的就是 `sa n bya ku mi ri`（ミリ）。
     */
    var unitWord = UNIT_WORD[String(word).toUpperCase()];
    if (unitWord && digitBefore(word, line)) {
      return { kana: unitWord, source: "letters", confident: true };
    }
    /*
     * 段标（`(A:` / `B:`）排在所有层前面：它压根不该有读音，
     * 缓存里有没有都不该有 —— 用户机器上就攒过 `a → アー`（模型在 `(A:` 那种行里
     * 答的），那条「学会的词」会把这条规则整个绕过去。所以这一判最先做。
     */
    if (labelLetter(word, line, token)) return null;
    /*
     * 紧跟在打码符号后面的片段（`ed` 里的 ed）：不标。
     */
    if (censoredBefore(word, line)) return null;
    /*
     * 像打码的重复字母串（后面紧跟着假名，`“XX”してる`）：留白。
     * 缩写成串的（`「YY」` 这种独立的）继续往下走，按字母名读成 ワイワイ。
     */
    if (censorLikeRun(word, line)) return null;
    /*
     * ASCII art / 颜文字 行（`~i.!.|| i !!i !!~`、`( ﾟ∀ﾟ)o彡ﾟ …`）：整行不标 ——
     * 那些字母是画图案用的（见 looksLikeAsciiArt 的说明）。
     */
    if (line && looksLikeAsciiArt(line)) return null;
    /*
     * 整首专属读音（见 SONG_READINGS）：这首歌里这个词就这么读。
     * 排在所有层前面 —— 它是人工核过的（`夢現妄想世界` 的 `ZO` 是 ゾー、
     * `KYO` 是 キョー），连大模型也不该改（来源 `song` 的层序是 -1，在线层不被咨询）。
     */
    if (state.songWords) {
      var songKana = state.songWords[String(word == null ? "" : word).toLowerCase()];
      if (songKana) return { kana: songKana, source: "song", confident: true };
    }
    /*
     * 大写单字母：成串的读字母名（`(A, B)` -> エー / ビー），段标（`A:` / `B:`）留白，
     * 孤零零一个的照旧 —— `A` 是冠词（ア）、`I` 是代词（アイ），
     * 别的（`B`、`C`…）没法判，还是留白（返回 null 表示"这词不标"）。
     */
    /*
     * 颜文字里的那个单字母（`:-b ;-b boy, :-b ;-b` 的 b）：用户点名要标，
     * 而且读的是**表情的音**（`b` → ボー），不是字母名 ビー —— 所以先查这张小表。
     * 只在"这一行还有别的西文词"时标（那种行是歌词，不是纯颜文字行）。
     */
    if (
      token &&
      token.emoticon === true &&
      /^[A-Za-z]$/.test(String(word == null ? "" : word)) &&
      line &&
      lineHasOtherWord(word, line)
    ) {
      var emoLow = String(word).toLowerCase();
      var emoKana =
        EMOTICON_LETTER_KANA[emoLow] ||
        (typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[emoLow] : null);
      if (emoKana) return { kana: emoKana, source: "letters", confident: true };
    }
    if (/^[A-Z]$/.test(String(word == null ? "" : word))) {
      /*
       * 呼语 `O`（`O Chrysalis` / `O love`）读 オー。
       *
       * 用户截图点名要它标上：歌词里这个 O 是"哦 / 啊"那种呼唤语气（拉丁语、英语、
       * 意大利语都这么写），不是排版噪声；字母名本来也就是 オー，两回事一样的结果。
       */
      if (String(word) === "O") return { kana: "オー", source: "letters", confident: true };
      /*
       * 字母紧跟数字就是单位：`30W` ワット、`100V` ボルト、`5A` アンペア。
       * 用户截图 `VOX AC30W` 里的 `W` 原来一个注音都没有（孤零零一个单字母，
       * 整行又不算"字母串"，就留白了）。
       */
      if (UNIT_SYMBOL[String(word)] && digitBefore(word, line)) {
        return { kana: UNIT_SYMBOL[String(word)], source: "letters", confident: true };
      }
      if (line && lineLetterRun(line)) {
        /*
         * 整串字母都是单位符号（`（V, W, A）`）→ 读单位名（ボルト・ワット・アンペア）。
         * 用户截图指名要这个；`(A, B)` 那种（串里有非单位字母）仍旧读字母名。
         */
        if (UNIT_SYMBOL[String(word)] && lineAllUnitSymbols(line)) {
          return { kana: UNIT_SYMBOL[String(word)], source: "letters", confident: true };
        }
        var letterKana =
          typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[String(word).toLowerCase()] : null;
        if (letterKana) return { kana: letterKana, source: "letters", confident: true };
      }
      /*
       * 整句专属读音：只有 `Xだけの"人マニア"` 那一句里的 X 读 ツイッター
       * （见 LINE_READINGS）。位置卡在中间：成串的 `(X, Y)` 上面那条已经接走了，
       * 别处的 X（`X線` エックス線、英文句子里的 `X marks the spot`）一律不受影响。
       */
      var lineFix = lineReading(word, line);
      if (lineFix) return { kana: lineFix, source: "dict", confident: true };
      /*
       * 孤零零一个单字母（不成串）时，还有两种看得出"这里要读字母名"的情况：
       *   ① 紧贴日文：`T氏` / `B面` / `X線` —— 日语就是读字母名（ティーし）；
       *   ② 同一行还有别的英文词：`T Is My Everything` / `I love U` ——
       *      那是句子里的字母，不是冠词。
       * 用户截图：`T氏にすべてを捧げましょう` 和 `T Is My Everything` 里的 T
       * 一个注音都没有。`A` / `I` 在 ② 里仍旧按冠词 / 代词读（`A story` 的 A 是 ア）。
       */
      if (line && (gluedToJapanese(word, line) || (String(word) !== "A" && String(word) !== "I" && lineHasOtherWord(word, line)))) {
        var loneKana =
          typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[String(word).toLowerCase()] : null;
        if (loneKana) return { kana: loneKana, source: "letters", confident: true };
      }
      /*
       * ③ 紧挨着数字：`B4` ビー / `A4` エー / `2B` ビー —— 型号、规格里的字母。
       * 用户截图 `B4の紙切れに収まる僕の人生を` 的 `B` 原来一个注音都没有。
       * 单位符号挨着数字的走上面那条（`30W` 是 ワット，不是 ダブリュー）。
       */
      if (line && digitAdjacent(word, line)) {
        var numKana =
          typeof WKReading !== "undefined" && WKReading.LETTER_KANA ? WKReading.LETTER_KANA[String(word).toLowerCase()] : null;
        if (numKana) return { kana: numKana, source: "letters", confident: true };
      }
      if (String(word) !== "A" && String(word) !== "I") return null;
    }
    /*
     * 记号里的 `&`（`R&B` / `A&B`）：读 アンド。它是唯一有读音的分隔符，
     * 记号拆成一个字母一个词之后 `&` 自己也成了一个词（见 letters.js），
     * 不认它就会在 R 和 B 之间空一格。孤零零的 `&`（`you & me`）不是记号零件、
     * 扫描时根本不会成词，所以不受影响。
     */
    if (String(word) === "&") return { kana: "アンド", source: "letters", confident: true };
    /*
     * 紧贴假名的全大写缩写（`ATフィールド` / `OP映像`）：人工核过的那批按字母名读。
     * 表外的照旧走下面的"标成没把握"那条，交给大模型按整句判 ——
     * `YOU` / `SKY` / `DAY` / `NO` 这些也常写成全大写，那几个要按词读（见 GLUED_ACRONYM 的说明）。
     */
    if (gluedUpperCase(word, line)) {
      var acr = GLUED_ACRONYM[String(word).toLowerCase()];
      if (acr) return { kana: acr, source: "letters", confident: true };
    }
    /*
     * 孤零零一个希腊字母（不在希腊语行上）：读字母名 —— Ω 按日语习惯读 オーム
     * （电阻单位），小写 ω 读 オメガ（见 GREEK_LETTER_KANA 的说明）。
     */
    var rawLetter = String(word == null ? "" : word);
    if (rawLetter.length === 1 && /[\u0370-\u03FF\u1F00-\u1FFF]/.test(rawLetter)) {
      var letterLang = line ? lineLang(line) : null;
      if (letterLang !== "el") {
        if (rawLetter === "\u03A9" || rawLetter === "\u2126") return { kana: "オーム", source: "letters", confident: true };
        var greekName = GREEK_LETTER_KANA[rawLetter.toLowerCase()];
        if (greekName) return { kana: greekName, source: "letters", confident: true };
      }
    }
    /*
     * 全大写缩写紧贴数字（`AM6:00` / `PM11:30` / `AC30`）：按字母名逐字读（エーエム）。
     * 必须排在词典那一层前面 —— 词典键是小写，`AM` 会被当成英语单词 `am`（アム）。
     * 用户截图：`AM6:00 目覚まし時計を起こして` 的 AM 就是这么被读成 アム 的。
     */
    if (capsBeforeDigit(word, line, token)) {
      var capsKana = letterNames(word);
      if (capsKana) return { kana: capsKana, source: "letters", confident: true };
    }
    /*
     * 缩写里那几个"日语读法不是字母名"的（`LV` レベル）：排在缩写/字母名前。
     * 大小写都收 —— 歌词里 `LV` / `lv` 都是 level。
     */
    var acronymWord = ACRONYM_WORD[String(word == null ? "" : word).toLowerCase()];
    if (acronymWord) return { kana: acronymWord, source: "dict", confident: true };
    // 掩码词（`T○itter`）：按通配去词典里找一个确定答案
    var maskedKana = maskedReading(word);
    if (maskedKana) return { kana: maskedKana, source: "dict", confident: true };
    /*
     * 西里尔全大写缩写逐字母读（`СССР` エスエスエスエル）—— 见 CYRILLIC_LETTER_KANA。
     * 排在俄语引擎前面：引擎会按正字法把 `СССР` 的三个 С 并成一个，读成 スル。
     * 单个西里尔字母也走这条（用户截图 `Я らりぱっぱ…` 里的 Я 一个注音都没有）——
     * 那不是俄语行（行里有假名），按字母名读 ヤー。
     */
    if (cyrillicAcronym(word) || (/^[\u0400-\u04FF]$/.test(String(word == null ? "" : word)) && !(line && lineLang(line) === "ru"))) {
      var cyr = "";
      var cw = String(word).toLowerCase();
      for (var ci = 0; ci < cw.length; ci++) {
        var ck = CYRILLIC_LETTER_KANA[cw.charAt(ci)];
        if (!ck) {
          cyr = null;
          break;
        }
        cyr += ck;
      }
      if (cyr) return { kana: cyr, source: "letters", confident: true };
    }
    /*
     * 连字符串里的一段（`Ex-Otogibanashi`、`Looser-Krankheit-Was`）：
     *   ① 罗马音层切得干净就按罗马字读 —— 用户点名 `Ex-Otogibanashi` 的**后半进罗马音**
     *      （`Otogibanashi` → オトギバナシ，规则层会读成 …スヒ）；
     *   ② 切不出来的短片段（`Ex`）逐字母读字母名 → イーエックス。
     * 外语行（德语那种）不插队：那些片段归语种引擎管。
     */
    if (token && token.chain === true) {
      var chainWord = String(word == null ? "" : word);
      // 用户点名的"被连字符串起来的重复音"（`wa-` ウェ / `ar-` ア / `ni-` ネ）：
      // 与语种无关，命中就按表读
      var fragKana = DASH_FRAGMENT_KANA[chainWord.toLowerCase()];
      if (fragKana) return { kana: fragKana, source: "dict", confident: true };
      var chainLang = lineLang(line);
      // 真正的语种行（德 / 法 / 俄…）不插队：那些片段归语种引擎管；
      // 拉丁语和斯瓦希里语的判定对"罗马字标题"太容易命中，放它们进来
      if (!chainLang || chainLang === "la" || chainLang === "sw") {
        var chainRomaji = null;
        if (typeof WKReading !== "undefined" && WKReading.romajiToKatakana) {
          try {
            var cr = WKReading.romajiToKatakana(chainWord.toLowerCase());
            chainRomaji = cr && (typeof cr === "string" ? cr : cr.kana);
          } catch (e) {
            chainRomaji = null;
          }
        }
        if (chainRomaji) return { kana: chainRomaji, source: "romaji" };
        // 罗马音层切不出来的**短片段**（`Ex` イーエックス）逐字母读；
        // 别把正常的词（`Was`）拼成字母名
        if (/^([A-Za-z]{1,2}|[A-Z]{2,3})$/.test(chainWord)) {
          var chainNames = letterNames(chainWord);
          if (chainNames) return { kana: chainNames, source: "letters", confident: true };
        }
      }
    }
    /*
     * 点号记法里的**罗马字单词**（`K・A・I・S・A・N` = カイサン，标记见 letters.js 的
     * romajiWord）：整串交给罗马音层，不按记号逐字母念字母名。
     */
    if (token && token.romajiWord === true && typeof WKReading !== "undefined" && WKReading.romajiToKatakana) {
      var flatWord = String(word == null ? "" : word).replace(/[^A-Za-z]/g, "").toLowerCase();
      var asRomaji = null;
      try {
        var rr = WKReading.romajiToKatakana(flatWord);
        asRomaji = rr && (typeof rr === "string" ? rr : rr.kana);
      } catch (e) {
        asRomaji = null;
      }
      if (asRomaji) return { kana: asRomaji, source: "romaji" };
    }
    var r = state.reader ? state.reader.read(word) : null;
    /*
     * 「学会的词」（core/learn.js）：模型在两个不同句子里答过同一个读音 → 沉淀成
     * 离线词条，不再问模型（省钱就在这）。
     *
     * 但它排在人工词典后面：沉淀是模型给的，人工词表优先 —— 和
     * `tools/build-dict.js` 的"人工 > 沉淀 > 大模型"同一个口径。
     * 用户报的 `Ave`（拉丁语歌里的乐队名）就是这么被带歪的：模型在别的行里答过
     * アヴェ，沉淀成词条之后盖掉了人工核过的 `ave アベ`（"Ave Mujica 官方读 アベ"），
     * 结果同一首歌里两行两个读音。
     */
    if ((!r || !r.kana || r.source !== "dict") && state.learned) {
      var learned = state.learned.get(word);
      if (learned) return { kana: learned, source: "learned", confident: true };
    }
    /*
     * 外语行：拼读猜出来的答案换成那种语言的拼读，词典命中的照旧优先。
     *
     * 为什么放在这里、而不是函数末尾：下面"罗马字行/两可短音节"那两支会先返回
     * （`dans` 这种三字母词就会被它们接走），所以语言判定必须在它们之前判。
     *
     * 什么时候用引擎覆盖本地层：
     *   - 本地层读不出来 —— 西里尔/希腊字母（俄语、希腊语）词典层和罗马音层都读不了，
     *     这两个语种的支持就落在这条上；
     *   - 本地层是罗马音/规则猜的 —— 英文读音对外语词没有意义；
     *   - 这个词是同形异音（plus / son / die / Wind…，见 langs.js 的 HOMOGRAPH）。
     * 借词表命中的排在最前面（那是日语通行写法，等于人工词条）。
     * 规则层的结果一律 confident:false —— 拼写近似，配了 key 交给大模型按整句定。
     */
    var lang = line ? lineLang(line) : null;
    if (lang && typeof WKLangs !== "undefined" && WKLangs.toKatakana) {
      var loan = WKLangs.word(lang, word);
      if (loan) return { kana: loan, source: "dict", confident: true };
      var langKey = typeof WKMatcher !== "undefined" ? WKMatcher.normalize(word) : String(word == null ? "" : word).toLowerCase();
      var needEngine = !r || !r.kana || r.source === "romaji" || r.source === "rule" || WKLangs.homograph(lang, langKey);
      if (needEngine) {
        var foreign = WKLangs.toKatakana(lang, word);
        if (foreign && foreign.kana) return { kana: foreign.kana, source: "rule", confident: foreign.confident === true };
      }
    }
    if (!r || !r.kana) return null;
    /*
     * 词典是英文词典，`PI` 会被读成 パイ、`ME` 读成 ミー、
     * `PE` 甚至读成 ピーイー（把 "P E" 当字母念）—— 在一首日语歌的罗马字行里
     * 这些全错。这一行的构成已经说明它是罗马字（见 lineLooksRomaji），
     * 所以用罗马音读音覆盖词典读音，但标成没把握：在线层（大模型）
     * 拿到整句语境后可以改回去（英文行不会被读歪），离线时就按罗马音。
     */
    if (line && r.source === "dict") {
      var rom = shortRomajiOf(word);
      if (rom && rom !== r.kana) {
        if (lineLooksRomaji(line)) {
          // 罗马字行：直接按罗马音显示（离线也对：PA PI PU PE PO -> パピプペポ）
          return { kana: rom, source: "romaji", confident: false };
        }
        /*
         * 不是罗马字行，但这个词两可：词典给的是英文读音（`Do` ドゥー、
         * `Re` リー、`MI` ミー、`PE` ピーイー…），而同一串也可能是唱名/罗马音节
         * （ド/レ/ミ/ペ）。光看拼写分不出来（`do`/`re`/`no` 真是英文词），
         * 只能靠整句语境 —— 所以这里保留词典读音先显示，但标成"没把握"，
         * 让在线层（大模型）按那句话决定；离线时就用词典读音，不会被读歪。
         */
        return { kana: r.kana, source: r.source, confident: false };
      }
    }
    // 全大写缩写紧贴假名的（ATフィールド…）：标成没把握，交给大模型按整句判
    if (r.source === "dict" && r.confident !== false && gluedUpperCase(word, line)) {
      return { kana: r.kana, source: r.source, confident: false };
    }
    return r;
  }

  /**
   * 这个词是不是"两可"的短音节：词典给的是英文读音，而这一串同时也能读成
   * 罗马音节（`do` ドゥー/ド、`me` ミー/メ、`pi` パイ/ピ、`no` ノー/ノ…）。
   *
   * 两处用它：
   *   1. 显示时标成"没把握"（confident:false），交给大模型按整句语境判；
   *   2. 不把模型答案沉淀成离线词条 —— 它的正确读音取决于那句话，
   *      钉死一个只会错（这条规矩见 core/learn.js 的说明）。
   */
  function isTwoWayShort(word, dictKana) {
    var rom = shortRomajiOf(word);
    if (!rom) return false;
    var kana = dictKana;
    if (kana === undefined) {
      var d = typeof WKDict !== "undefined" ? WKDict.words : {};
      var key = typeof WKMatcher !== "undefined" ? WKMatcher.normalize(word) : String(word || "").toLowerCase();
      kana = d[key];
    }
    return !!kana && kana !== rom;
  }

  /**
   * 在线层拿回来的答案过不过关（两层共用）。
   *
   * 第一道是纯片假名（由各层自己判），第二道是首音校验：
   * `looksLikeTransliteration` 拦的是"意译 / 拟声词"——用户报的 `tick` 被回成
   * カチカチ 就是这种。
   *
   * 但那套判据是按英语拼写定的（t→タ行、v→バ行…），外语行上会误伤：
   * 拉丁语的 v 读 ヴ 也读 ワ（`vacuum` → ワクーム 被判掉过，德语 w→ヴ、
   * x→クス 英语里根本没有）。所以外语行整行不做这道校验 —— 那一行的语种
   * 我们已经认出来了，模型也拿得到整句，用英语口径去卡只会把正确答案丢掉。
   * （丢掉的后果特别难查：那条 miss 是永久的、还落盘，那个词就永远停在规则层。）
   */
  function validateAnswer(word, kana, line) {
    if (typeof WKReading === "undefined") return true;
    if (line && lineLang(line)) return true;
    return WKReading.looksLikeTransliteration(word, kana);
  }

  function resolveReading(word, line, token) {
    if (!state.reader) return null;
    // 全角字母折半角（`ＮＯ` -> `NO`）：查表 / 模型键 / 层序都得用同一个形式
    word = foldFullwidthLetters(word);
    if (line != null) line = foldFullwidthLetters(line);
    var r = withLongVowel(word, localReading(word, line, token));
    if (!r || !r.kana) return null;

    var mine = effectiveRank(r); // 没把握的答案按最低层算，在线层可以覆盖它
    for (var i = 0; i < config.layerOrder.length; i++) {
      var id = config.layerOrder[i];
      if (!ASYNC_LAYERS[id]) continue;
      // 排在当前答案后面的在线层不参与：不发请求、也不覆盖
      if (i >= mine) break;
      /*
       * 大模型这一层现在用不了（没配 key / 没开）也要记一笔：
       * 注音层只在注音那一刻走这里一次，不记的话等 key 补上/这一层重新打开时
       * 就没人再问那个词了 —— 用户看到的正是「这个单词一直是黄的」
       * （`sieh` 就是这么一直黄着的）。记下来之后，这一层一可用就会补问。
       */
      if (id === "llm" && !layerAvailable(id)) {
        if (state.llm.want) {
          try {
            state.llm.want(word, line);
          } catch (e) {
            /* 记不上不影响注音 */
          }
        }
        continue;
      }
      if (!layerAvailable(id)) continue;

      if (id === "llm") {
        if (line !== undefined && line !== null) {
          var llm = state.llm.lookup(word, line);
          if (llm) return { kana: llm, source: "llm" };
        }
        // 这个词还没问到结果：先用在别的句子里拿到的读音，其次用当前这层的读音顶上
        var seen = state.llm.peek(word);
        if (seen) return { kana: seen, source: "llm" };
        return { kana: r.kana, source: r.source };
      }

      // 免费接口（Google）
      var fixed = state.corrector.lookup(word);
      if (fixed) return { kana: fixed, source: "google" };
      return { kana: r.kana, source: r.source };
    }

    // 没有更高优先的在线层可用 —— 当前这层的答案就是最终答案
    return { kana: r.kana, source: r.source };
  }

  /** 只要读音字符串的调用方（控制台 WK.display / 老代码）走这个 */
  function readForDisplay(word, line, token) {
    var got = resolveReading(word, line, token);
    return got ? got.kana : null;
  }

  /**
   * 这个词的读音现在是不是"暂定"的（有比它更优先的在线层还在问）。
   * 注音层靠它在 ruby 上加 `wk-pending` 类 —— 样式淡一点，提示"还不一定"。
   */
  function isProvisional(word, line, token) {
    if (!word || !state.reader) return false;
    word = foldFullwidthLetters(word);
    if (line != null) line = foldFullwidthLetters(line);
    var r = localReading(word, line, token);
    if (!r) return false;
    var mine = effectiveRank(r);
    for (var i = 0; i < config.layerOrder.length; i++) {
      var id = config.layerOrder[i];
      if (!ASYNC_LAYERS[id]) continue;
      if (i >= mine) break; // 这一层不参与，后面的更不参与
      if (!layerAvailable(id)) continue;
      if (id === "llm") {
        if (state.llm.isWaiting && state.llm.isWaiting(word, line)) return true;
      } else if (state.corrector.isWaiting && state.corrector.isWaiting(word)) {
        return true;
      }
      // 这一层已经答过了（或确定给不出）—— 显示的就是最终答案，不是暂定
      return false;
    }
    return false;
  }

  // ------------------------------------------------------------ 扫描调度

  var RE_KANA_ANY = /[\u3041-\u3096\u30A1-\u30FA]/;

  /**
   * 这首歌是不是日语歌：整首歌词里有没有一行含假名。
   *
   * 为什么按整首判、而不是按行：日语歌里常有纯英文行（`I love you` 那种），
   * 按行判会把它们当成"非日语"跳过 —— 那正是要注音的行。
   * 非日语歌（纯英语/法语/中文）一行假名都没有，所以整首判定很稳。
   * 结论按歌词文本缓存：同一首歌每轮扫描都要问一次，没必要每次重算。
   */
  var japaneseSongCache = { key: "", value: true };
  /** 整首专属读音（见 SONG_READINGS）的缓存：同一首歌不必每轮重算 */
  var songScopeCache = { key: null, words: null };
  function songLooksJapanese() {
    if (!state.annotator || !state.annotator.findRegions) return true;
    var regions = [];
    try {
      regions = state.annotator.findRegions("lyrics");
    } catch (e) {
      return true;
    }
    if (!regions || !regions.length) return true; // 歌词还没加载出来：先别下结论
    var texts = [];
    var kanaLines = 0;
    for (var i = 0; i < regions.length; i++) {
      var t = "";
      try {
        t = regions[i].textContent || "";
      } catch (e2) {
        t = "";
      }
      texts.push(t);
      if (RE_KANA_ANY.test(t)) kanaLines++;
    }
    var key = kanaLines + "|" + texts.join("\n").slice(0, 4000);
    if (japaneseSongCache.key === key) return japaneseSongCache.value;
    var value = kanaLines >= 1;
    japaneseSongCache = { key: key, value: value };
    return value;
  }

  function pass() {
    if (!config.enabled || !state.annotator) return;
    if (emergencyOff()) {
      warn("检测到紧急开关，停用插件");
      disable();
      return;
    }
    /*
     * 设置里关掉「非日语歌也注音」时：整首跳过（连播放栏标题一起），
     * 并把之前已经注上的撤掉 —— 否则换歌之后还留着上一首的注音。
     */
    if (config.annotateNonJapanese === false && !songLooksJapanese()) {
      try {
        if (state.annotator.injectedCount && state.annotator.injectedCount() > 0) state.annotator.restoreAll();
      } catch (e0) {
        /* 还原失败不影响下面 */
      }
      state.lastResult = { scanned: 0, changed: 0, restored: 0, skipped: 0, unstable: 0, nonJapanese: true };
      return;
    }
    var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      /*
       * 先定"整首专属读音"是哪一张（见 SONG_READINGS）：换歌之后这一句会重算，
       * 之后注音层查到的 `state.songWords` 就是这首歌的。
       */
      updateSongScope();
      var regions = null;
      if (config.scope === "lyrics") regions = state.annotator.findRegions("lyrics");
      else if (config.scope === "titles") regions = state.annotator.findRegions("titles");
      else if (config.scope === "custom") {
        regions = state.annotator.customRegions(config.customSelector);
        if (!regions.length) regions = state.annotator.findRegions("safe");
      } else if (!config.annotateAll) {
        regions = state.annotator.findRegions("lyrics");
      }
      state.lastResult = state.annotator.pass(regions);
      /*
       * 这一轮有节点因为「文本在动」（换歌/滚动把手抖的那几轮）或「认输期」被跳过时，
       * 注音层会告诉我们过多久可以重试。必须自己排下一次扫描：
       * 换歌之后如果页面不再变动（最典型的是歌处于暂停，歌词渲染一次就不动了），
       * 就再也没有事件来触发下一轮 —— 那一行会一直空着，看着就像插件坏了。
       */
      if (state.lastResult && state.lastResult.retryInMs > 0) {
        schedule(state.lastResult.retryInMs);
      }
    } catch (e) {
      state.error = (e && e.message) || String(e);
      warn("扫描异常", e);
    } finally {
      // MutationObserver 的回调在本轮同步任务之后才跑，光靠标志位挡不住
      // 我们自己造成的变更；把记录队列清空，否则会自激成死循环。
      if (state.observer) state.observer.takeRecords();
      state.lastPassMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
      state.lastPassAt = Date.now();
    }
  }

  /**
   * 合并短时间内的多次触发，最多排一个待执行的 pass。
   *
   * delay=0 表示「观测到 DOM 变了，要立刻补注音」：必须赶在下一帧绘制之前
   * 跑完，否则那一帧画出来就是没有注音的样子 —— 肉眼就是一闪。
   */
  var MIN_PASS_GAP_MS = 40;
  function schedule(delay) {
    if (state.timer) return;
    var d = delay == null ? 250 : delay;
    if (d > 0) {
      state.timer = setTimeout(function () {
        state.timer = null;
        pass();
      }, d);
      return;
    }
    var since = Date.now() - (state.lastPassAt || 0);
    var wait = since < MIN_PASS_GAP_MS ? MIN_PASS_GAP_MS - since : 0;
    var run = function () {
      state.timer = null;
      state.timerIsRaf = false;
      pass();
    };
    if (wait > 0) {
      state.timer = setTimeout(run, wait);
      return;
    }
    if (typeof requestAnimationFrame === "function") {
      state.timer = requestAnimationFrame(run);
      state.timerIsRaf = true;
    } else {
      state.timer = setTimeout(run, 0);
    }
  }

  function startObserver() {
    if (state.observer) return;
    var observer = new MutationObserver(function (records) {
      try {
        var relevant = false;
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === "characterData" || r.type === "childList") {
            relevant = true;
            break;
          }
        }
        if (relevant) schedule(0);
      } catch (e) {
        warn("MutationObserver 回调异常", e);
      }
    });
    state.observer = observer;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // 兜底：observer 可能漏掉（React 换了元素、或我们自己在 pass 里清了记录）。
    state.tickTimer = setInterval(function () {
      if (!config.enabled || !state.annotator) return;
      schedule(0);
    }, 1500);
    if (state.tickTimer && typeof state.tickTimer.unref === "function") state.tickTimer.unref();
  }

  // ------------------------------------------------------------ 启用/禁用

  function enable() {
    if (!state.annotator) return;
    if (!state.applied) {
      state.applied = true;
      startObserver();
    }
    // 停用时把 <style> 一并摘掉了，启用时要补回来
    updateStyles();
    schedule(0);
  }

  function disable() {
    state.applied = false;
    if (state.timer) {
      clearTimeout(state.timer);
      if (state.timerIsRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.timer);
      state.timer = null;
      state.timerIsRaf = false;
    }
    if (state.annotator) state.annotator.restoreAll();
    if (typeof WKAnnotate !== "undefined" && WKAnnotate.removeStyles) {
      WKAnnotate.removeStyles(document);
    }
  }

  function rescan() {
    if (state.annotator) state.annotator.restoreAll();
    if (state.corrector) state.corrector.retryMisses();
    schedule(0);
  }

  function updateStyles() {
    if (typeof WKAnnotate !== "undefined" && WKAnnotate.applyStyles) {
      WKAnnotate.applyStyles(document, {
        rtSize: config.rtSize,
        rtOpacity: config.rtOpacity,
        colorBySource: !!config.colorBySource,
      });
    }
  }

  // ------------------------------------------------------------ 设置面板

  var REPO = REPO_URL;

  function buildConfigUI() {
    var root = document.createElement("div");
    root.id = "western-katakana-config";
    root.innerHTML =
      "<style>" +
      "#western-katakana-config { font-size: 14px; line-height: 1.9; }" +
      "#western-katakana-config h3 { margin: 12px 0 4px; font-size: 15px; }" +
      "#western-katakana-config .wk-row { margin: 3px 0; }" +
      "#western-katakana-config .wk-hint { opacity: .65; font-size: 12px; line-height: 1.5; }" +
      "#western-katakana-config input[type=text], #western-katakana-config input[type=password] { width: 300px; padding: 2px 6px; }" +
      "#western-katakana-config .wk-preview { padding: 8px 10px; border: 1px solid rgba(128,128,128,.35); border-radius: 6px; font-size: 18px; }" +
      "#western-katakana-config .wk-preview-trans { margin-top: 2px; font-size: 14px; opacity: .6; }" +
      "#western-katakana-config .wk-llm-state { margin: 2px 0; }" +
      "#western-katakana-config .wk-layer { display: flex; align-items: center; gap: 6px; line-height: 1.8; }" +
      "#western-katakana-config .wk-layer-name { min-width: 110px; }" +
      "#western-katakana-config .wk-layer-note { opacity: .6; font-size: 12px; flex: 1; }" +
      "#western-katakana-config .wk-layer-btn { min-width: 26px; }" +
      "#western-katakana-config .wk-layer-btn[disabled] { opacity: .35; }" +
      "#western-katakana-config .wk-layer-warn { color: #e8a33d; margin-top: 4px; }" +
      "#western-katakana-config .wk-warn { color: #e8a33d; }" +
      "#western-katakana-config .wk-links { margin-bottom: 4px; }" +
      "#western-katakana-config .wk-links a { margin-right: 14px; }" +
      // 高级设置整块折叠：面板默认只有"开关 / 大模型 / 预览"三块，其余收起来
      "#western-katakana-config details.wk-adv { margin-top: 12px; border-top: 1px solid rgba(128,128,128,.25); padding-top: 6px; }" +
      "#western-katakana-config details.wk-adv > summary { cursor: pointer; opacity: .8; }" +
      "#western-katakana-config details.wk-adv > summary:hover { opacity: 1; }" +
      "</style>" +
      '<div class="wk-links">' +
      '<a href="#" data-open="' + REPO + '">源码仓库</a>' +
      '<a href="#" data-open="' + REPO + '/issues">反馈问题</a>' +
      "</div>" +
      "<h3>开关</h3>" +
      '<div class="wk-row"><label><input type="checkbox" data-k="enabled"> 启用注音</label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="online"> 规则没把握时联网校正 (免费接口)</label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="annotateAll"> 也标播放栏的歌名 / 歌手</label></div>' +
      "<h3>大模型校正</h3>" +
      '<div class="wk-row"><label><input type="checkbox" data-k="llmEnabled"> 用大模型校正读音</label></div>' +
      '<div class="wk-row"><label>API Key <input type="password" data-k="llmKey" placeholder="sk-..."></label> ' +
      '<button data-a="llmTest">测试连接</button> <span data-v="llmTest"></span></div>' +
      '<div class="wk-llm-state"></div>' +
      '<div class="wk-row"><span data-v="learned"></span> ' +
      '<button data-a="learnClear">清空已学会的词</button></div>' +
      '<div class="wk-hint">Key 只存本机 localStorage, 不会进仓库; 留空则这一层不工作, 自动退回免费接口<br>' +
      "词典外的词和两可短音节 (Do / Re / PI / ME…) 由它按整句语境判; 答稳的词自动沉淀成离线词条, 以后不再问</div>" +
      "<h3>预览</h3>" +
      '<div class="wk-preview"></div>' +
      '<details class="wk-adv"><summary>高级设置（接口 / 外观 / 范围 / 读音来源顺序 / 用量 / 操作）</summary>' +
      "<h3>接口</h3>" +
      '<div class="wk-row"><label>接口地址 <input type="text" data-k="llmEndpoint"></label></div>' +
      '<div class="wk-row"><label>模型 <input type="text" data-k="llmModel"></label></div>' +
      '<div class="wk-hint">粘文档里的 <code>base_url</code> 也行, 会自动补成 <code>/chat/completions</code></div>' +
      "<h3>外观</h3>" +
      '<div class="wk-row"><label>注音字号 <input type="range" data-k="rtSize" min="30" max="120" step="1"> <span data-v="rtSize"></span></label></div>' +
      '<div class="wk-row"><label>注音不透明度 <input type="range" data-k="rtOpacity" min="10" max="100" step="1"> <span data-v="rtOpacity"></span></label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="colorBySource"> 按读音来源给注音上色 (排障)</label></div>' +
      '<div class="wk-hint">' +
      '<span style="color:#46d17e">■ 词典</span>　' +
      '<span style="color:#2fae7a">■ 学会的词</span>　' +
      '<span style="color:#3fb6d8">■ 记号/字母名</span>　' +
      '<span style="color:#6f8ff0">■ 罗马音</span>　' +
      '<span style="color:#e8a33d">■ 英文规则</span>　' +
      '<span style="color:#c07ce8">■ 大模型</span>　' +
      '<span style="color:#e0629a">■ 免费接口</span>　淡显 = 暂定值</div>' +
      "<h3>范围</h3>" +
      '<div class="wk-row"><label>标注范围 <select data-k="scope">' +
      '<option value="all">歌词 + 播放栏 (默认)</option>' +
      '<option value="lyrics">只标歌词</option>' +
      '<option value="titles">只标播放栏</option>' +
      '<option value="custom">自定义选择器</option>' +
      "</select></label></div>" +
      '<div class="wk-row"><label>自定义选择器 <input type="text" data-k="customSelector" placeholder="例如 ul.lyric > li"></label></div>' +
      '<div class="wk-row"><label><input type="checkbox" data-k="annotateNonJapanese"> 非日语歌也注音 (纯英文 / 西文各语种 / 中文歌)</label></div>' +
      '<div class="wk-hint">关掉 = 只标日语歌: 整首歌词一个假名都没有的整首跳过; ' +
      "判据看整首, 所以日语歌里的纯英文行照旧注音</div>" +
      "<h3>读音来源顺序</h3>" +
      '<div class="wk-hint">越靠上越优先; 把<b>英文音译规则</b>提到在线层前面 = 一个请求都不发 (纯离线)<br>' +
      "记号 / 缩写 / 字母名 (<code>D/N/A</code>、<code>I'll</code>、<code>LDK</code>) 不参与排序, 永远最先判</div>" +
      '<div class="wk-layers"></div>' +
      '<div class="wk-row"><button data-a="layersReset">恢复默认顺序</button> <span data-v="layersReset"></span></div>' +
      "<h3>API 用量</h3>" +
      '<div class="wk-usage"></div>' +
      '<div class="wk-row"><label>输入单价 <input type="number" data-k="usagePriceIn" min="0" step="0.01" style="width:80px"> 元/百万 token　' +
      '输出单价 <input type="number" data-k="usagePriceOut" min="0" step="0.01" style="width:80px"> 元/百万 token</label></div>' +
      '<div class="wk-row">' +
      '<button data-a="usageReset" data-scope="session">清零本次</button> ' +
      '<button data-a="usageReset" data-scope="today">清零今天</button> ' +
      '<button data-a="usageReset" data-scope="all">清零累计</button>' +
      "</div>" +
      "<h3>操作</h3>" +
      '<div class="wk-row">' +
      '<button data-a="rescan">重新扫描</button> ' +
      '<button data-a="retry">重试没结果的词</button> ' +
      '<button data-a="exportWords">导出词库素材</button> ' +
      '<button data-a="clearCache">清除校正缓存</button>' +
      "</div>" +
      "</details>";

    function fmt(key) {
      return config[key] + "%";
    }

    var preview = root.querySelector(".wk-preview");
    var layersBox = root.querySelector(".wk-layers");
    var usageBox = root.querySelector(".wk-usage");
    var llmStateBox = root.querySelector(".wk-llm-state");

    /** 每一层右边那句小字：让用户一眼看出这层现在能不能用 */
    function layerNote(id) {
      if (id === "dict") return "(" + (typeof WKDict !== "undefined" ? WKDict.count : "?") + " 条, 纯离线)";
      if (id === "romaji") return "(歌词里的日式罗马字, 纯离线)";
      if (id === "rule") return "(拼写音译, 永远给得出结果)";
      if (id === "llm") return llmAvailable() ? "(已启用)" : "(没启用 / 没填 key)";
      if (id === "google") return googleAvailable() ? "(已开启)" : "(已关闭)";
      return "";
    }

    function refreshLayers() {
      if (!layersBox) return;
      layersBox.innerHTML = "";
      for (var i = 0; i < config.layerOrder.length; i++) {
        (function (index) {
          var id = config.layerOrder[index];
          var row = document.createElement("div");
          row.className = "wk-layer";

          var name = document.createElement("span");
          name.className = "wk-layer-name";
          name.textContent = (index + 1) + ". " + (LAYER_NAMES[id] || id);
          row.appendChild(name);

          var note = document.createElement("span");
          note.className = "wk-layer-note";
          note.textContent = layerNote(id);
          row.appendChild(note);

          row.appendChild(mkMoveBtn(index, id, -1, "↑"));
          row.appendChild(mkMoveBtn(index, id, 1, "↓"));
          layersBox.appendChild(row);
        })(i);
      }
      /*
       * 挡路提醒：「英文音译规则」对每个词都给得出答案（它就是拼写猜测），
       * 所以排在它下面的同步层永远轮不到 —— 用户实际就是这么踩的：
       * 把词典往下拖了几格，于是 `the` -> 规则层的 セ、`this` 变黄（也是规则层）、
       * `I'll` 被拆成「イ + ル」= イル，而且大模型也不再被咨询（规则先答了）。
       * 面板里的 ↑↓ 已经不让这么换；这里兜住"手改配置 / 老配置"的情况。
       */
      var blocked = ruleBlocksSync();
      if (blocked.length) {
        var warnEl = document.createElement("div");
        warnEl.className = "wk-hint wk-layer-warn";
        warnEl.textContent =
          "⚠ " + blocked.join(" / ") + " 排在「英文音译规则」下面: 规则对每个词都会给答案, " +
          "这几层 (还有它下面的在线层) 就永远用不上 —— the 会变成规则猜的 セ" +
          "; 点「恢复默认顺序」即可";
        layersBox.appendChild(warnEl);
      } else if (
        config.layerOrder.indexOf("romaji") >= 0 &&
        config.layerOrder.indexOf("romaji") < config.layerOrder.indexOf("dict")
      ) {
        /*
         * 罗马音排在词典前面 —— 它同样"能切成音节就收"，英文词也会被按罗马音读：
         * Shoo→ショオ、Gimme→ギッメ、more→モレ、Do→ド、Re→レ。
         * 罗马字歌多的库这么排确实有道理（能切的都按罗马音），但要知道这个代价；
         * 不改也能用：罗马音行我们本来就会按罗马音读（lineLooksRomaji）。
         */
        var warn2 = document.createElement("div");
        warn2.className = "wk-hint wk-layer-warn";
        warn2.textContent =
          "⚠ 「日式罗马音」排在「离线词典」前面: 它同样是「能切成音节就收」, " +
          "英文词也会被按罗马音读 (Shoo→ショオ、more→モレ、Do→ド); 除非你就是想要这样, " +
          "否则点「恢复默认顺序」更稳";
        layersBox.appendChild(warn2);
      }
    }

    /**
     * 这一对层能不能互换。
     *
     * 「英文音译规则」对每个词都给得出答案（它就是拼写猜测），一旦排到
     * 离线词典 / 日式罗马音前面，那两层就永远轮不到 —— 用户实际就是这么踩的：
     * 把词典往下拖了几格，于是 `the` -> セ、`this` 变黄（规则层）、
     * `I'll` 被拆成「イ + ル」= イル，而且大模型也不再被咨询（规则先答了）。
     * 所以面板里直接不让这么换；真要"只用规则"就走控制台
     * `WK.layers(['rule','dict',...])`（文档里有）。
     */
    function canSwap(index, delta) {
      var to = index + delta;
      if (to < 0 || to >= config.layerOrder.length) return false;
      var a = config.layerOrder[index];
      var b = config.layerOrder[to];
      var sync = function (x) {
        return x === "dict" || x === "romaji";
      };
      if ((a === "rule" && sync(b)) || (b === "rule" && sync(a))) return false;
      return true;
    }

    function mkMoveBtn(index, id, delta, label) {
      var b = document.createElement("button");
      b.className = "wk-layer-btn";
      b.textContent = label;
      b.setAttribute("data-layer", id);
      b.setAttribute("data-dir", delta < 0 ? "up" : "down");
      var allowed = canSwap(index, delta);
      b.disabled = !allowed;
      if (!allowed) {
        b.title = "「英文音译规则」不能排到「离线词典 / 日式罗马音」前面: 它会给每个词都出答案, 那两层就永远用不上";
      }
      b.addEventListener("click", function () {
        moveLayer(id, delta);
      });
      return b;
    }

    /**
     * 上下调一层。改完顺序必须重扫：已经注过音的词可能要换一个来源，
     * rescan() 会先整篇还原再按新顺序重注（relabel 只管"暂定 -> 最终"）。
     */
    function moveLayer(id, delta) {
      var from = config.layerOrder.indexOf(id);
      var to = from + delta;
      if (from < 0 || to < 0 || to >= config.layerOrder.length) return;
      config.layerOrder[from] = config.layerOrder[to];
      config.layerOrder[to] = id;
      saveConfig();
      applyLayerOrder();
      rescan();
      refreshAll();
    }

    /** 用量区块：把 usage 模块的账本渲染成几行 */
    /*
     * 「学会的词」那一行：模型答案沉淀成的离线词条。
     *
     * 用户问的就是这个 —— 让模型答过的词自动进词库、以后不再花钱问。
     * 这里只说数量：具体哪些词用 `WK.learn.list()` 看（面板塞不下一长串）。
     */
    function refreshLearned() {
      var box = root.querySelector('[data-v="learned"]');
      if (!box) return;
      if (!state.learned) {
        box.textContent = "学会的词: 不可用 (core/learn.js 没注入)";
        return;
      }
      var s = state.learned.stats();
      box.textContent =
        "学会的词: " +
        s.count +
        " 个" +
        (s.pending ? " (还有 " + s.pending + " 个只听过一次, 再听一句就收)" : "") +
        (s.usedSession ? "; 本次用上 " + s.usedSession + " 个 (省下同样多次提问)" : "");
    }

    function refreshUsage() {
      if (!usageBox) return;
      usageBox.innerHTML = "";
      if (!state.usage) {
        usageBox.textContent = "用量统计不可用 (core/usage.js 没注入)";
        return;
      }
      var snap = state.usage.snapshot();
      var priceIn = Number(config.usagePriceIn) || 0;
      var priceOut = Number(config.usagePriceOut) || 0;
      var rows = [
        { label: "本次", bucket: snap.session },
        { label: "今天", bucket: snap.today },
        { label: "累计", bucket: snap.total },
      ];
      for (var i = 0; i < rows.length; i++) {
        var line = document.createElement("div");
        line.className = "wk-usage-row";
        line.textContent = rows[i].label + "：" + usageLine(rows[i].bucket, priceIn, priceOut);
        usageBox.appendChild(line);
      }
      var saved = document.createElement("div");
      saved.className = "wk-hint";
      var llmStats = state.llm ? state.llm.stats() : null;
      var savedHits = (llmStats ? llmStats.cacheHits : 0) + (state.corrector ? state.corrector.stats().memoryHits : 0);
      saved.textContent =
        "缓存命中 " + savedHits + " 次 (这些没发请求)" +
        (priceIn || priceOut ? "" : "; 填了单价才会算花费");
      usageBox.appendChild(saved);
    }

    /** 一个桶一行字：请求/成功/失败/词/字符/token */
    function usageLine(bucket, priceIn, priceOut) {
      var parts = [];
      for (var k = 0; k < USAGE_KINDS.length; k++) {
        var kind = USAGE_KINDS[k];
        var b = bucket[kind];
        if (!b || (!b.requests && !b.failures)) continue;
        var seg = (kind === "llm" ? "大模型 " : "免费接口 ") + b.requests + " 次请求";
        if (b.failures) seg += " (成功 " + b.ok + " / 失败 " + b.failures + ")";
        if (b.words) seg += "・" + b.words + " 词";
        if (b.chars) seg += "・" + b.chars + " 字符";
        // 只有大模型那层有 token（Google 那两个接口不回 usage）；免费接口就算被
        // 灌了 token 也不显示，免得账本看着像是两种计费混在一起
        if (kind === "llm" && (b.promptTokens || b.completionTokens)) {
          seg += "・输入 " + b.promptTokens + " / 输出 " + b.completionTokens + " tok";
        }
        parts.push(seg);
      }
      if (!parts.length) return "还没发过请求";
      var text = parts.join("　|　");
      var money = state.usage.cost(bucket, priceIn, priceOut);
      if (money > 0) text += "　≈ " + money.toFixed(4) + " 元";
      return text;
    }

    /** 从 usage 模块拿两层 id（别在 main.js 里写死一份） */
    var USAGE_KINDS = typeof WKUsage !== "undefined" ? WKUsage.KINDS : ["llm", "google"];

    function refreshPreview() {
      preview.innerHTML = "";
      if (typeof WKMatcher === "undefined" || !state.reader) {
        preview.textContent = "核心模块未加载";
        return;
      }
      /*
       * 预览示例句用高考英语听力那句名句（「衬衫的价格为九磅十五便士」）。
       *
       * 两行是刻意的：第一行是原文，按真实逻辑注音；第二行是中文翻译。
       * 真机上翻译层是不标的（见 annotate.js：同一个 <li> 只取第一块、
       * class 里带 trans/translated 的整层跳过），预览也照这个来 ——
       * 免得给人「翻译也会被注音」的错预期。
       */
      var demo = "The shirt is nine pounds fifteen pence.";
      var demoTrans = "衬衫的价格为九磅十五便士";
      var frag = document.createDocumentFragment();
      var pos = 0;
      var tokens = WKMatcher.scan(demo);
      var got = 0;
      for (var i = 0; i < tokens.length; i++) {
        var tk = tokens[i];
        // 和 annotate.js 一样传原始写法：折过的形式会把连字符吃掉，
        // 记号（D/N/A）和普通词（x-ray）就分不出来了
        var r = WKMatcher.looksReadable(tk) ? state.reader.read(tk.text) : null;
        if (tk.start > pos) frag.appendChild(document.createTextNode(demo.slice(pos, tk.start)));
        if (r && r.kana) {
          var ruby = document.createElement("ruby");
          ruby.className = "wk-ruby";
          ruby.appendChild(document.createTextNode(tk.text));
          var rt = document.createElement("rt");
          rt.className = "wk-rt";
          rt.textContent = r.kana;
          ruby.appendChild(rt);
          frag.appendChild(ruby);
          got++;
        } else {
          frag.appendChild(document.createTextNode(tk.text));
        }
        pos = tk.end;
      }
      if (pos < demo.length) frag.appendChild(document.createTextNode(demo.slice(pos)));
      preview.appendChild(frag);
      /*
       * 中文翻译行：真机上不注音，预览里也不注。用单独的类而不是塞进上面那段文本，
       * 是为了让样式和真机的翻译层一样淡一点，一眼能看出"这行不归我们管"。
       */
      if (demoTrans) {
        var trans = document.createElement("div");
        trans.className = "wk-preview-trans";
        trans.textContent = demoTrans;
        preview.appendChild(trans);
      }
      if (!got) {
        var hint = document.createElement("div");
        hint.className = "wk-hint";
        hint.textContent = "没能给示例词算出读音 (可在控制台调 WK.read('shirt') 查看)";
        preview.appendChild(hint);
      }
    }

    function refreshStatus() {
      // 原来的开发模式"状态转储"已经删掉: 面板上不该有这种东西, 需要数字时用控制台 WK.stats()
      return;
    }

    /**
     * 大模型这一层的当前状态（不用开 dev 模式也能看到的告警）。
     *
     * 「读音全都没矫正」是最容易让人以为插件坏了的症状：本地读音照旧、模型一条都没改。
     * 原因无非四种 —— 没配 key / 在失败退避里 / 请求全失败 / 队列还没轮上。
     * 这块把话说清，并给一个「立刻重试」。
     */
    function refreshLlmState() {
      if (!llmStateBox) return;
      llmStateBox.innerHTML = "";
      if (!state.llm) {
        llmStateBox.textContent = "大模型层没加载 (core/llm.js 没注入)";
        return;
      }
      var s = state.llm.stats();
      function say(text, cls) {
        var el = document.createElement("div");
        el.className = "wk-hint" + (cls ? " " + cls : "");
        el.textContent = text;
        llmStateBox.appendChild(el);
      }
      function sayBtn(label, action) {
        var b = document.createElement("button");
        b.textContent = label;
        b.setAttribute("data-a", action);
        b.addEventListener("click", function () {
          if (action === "llmRetryNow" && state.llm && state.llm.retryNow) {
            state.llm.retryNow();
            rescan();
          } else if (action === "layersReset") {
            config.layerOrder = normalizeLayerOrder(DEFAULTS.layerOrder);
            saveConfig();
            applyLayerOrder();
            rescan();
          }
          refreshAll();
        });
        llmStateBox.appendChild(b);
      }
      var blockedHere = ruleBlocksSync();
      if (blockedHere.length) {
        // 这条要放在最前面：层序错了的话，下面所有解释都是白搭
        say(
          "⚠ 「英文音译规则」排在 " + blockedHere.join(" / ") + " 前面 —— 规则对每个词都会给答案, " +
            "所以词典和模型都用不上 (the 变 セ、this 变黄、I'll 变 イル 都是这个原因); " +
            "点「恢复默认顺序」, 再把「大模型」往上提",
          "wk-warn"
        );
        sayBtn("恢复默认顺序", "layersReset");
        return;
      }
      if (!s.enabled) {
        say("这一层没启用 —— 所有词都用本地读音, 不会被矫正");
      } else if (!s.hasKey) {
        say("没填 API Key —— 所有词都用本地读音, 不会被矫正");
      } else if (s.cooldownMs > 0) {
        say(
          "⚠ 请求失败后退避中, 还要等 " + Math.round(s.cooldownMs / 1000) + " 秒; " +
            "这段时间里读音不会矫正" + (s.lastError ? "; 最近错误: " + s.lastError : ""),
          "wk-warn"
        );
        sayBtn("立刻重试", "llmRetryNow");
      } else if (s.failedSinceHit >= 2) {
        say(
          "⚠ 最近几次请求都没成功, 读音不会矫正" + (s.lastError ? "; 最近错误: " + s.lastError : ""),
          "wk-warn"
        );
        sayBtn("立刻重试", "llmRetryNow");
      } else if (s.pending > 0) {
        var bs = s.batchSize || 40;
        var batches = Math.ceil(s.pending / bs);
        say(
          "队列里还有 " + s.pending + " 个词在等" +
            (s.inflight ? " (正在请求)" : ", 还要发 " + batches + " 次请求, 本分钟还剩 " + s.roomThisMinute + " 次额度") +
            " —— 矫正会一批批补上, 不用管它"
        );
        if (s.pending > bs * 2) {
          say(
            "一次排这么多是因为「大模型」排在「离线词典」前面 —— 那样每个词都要问一遍; " +
              "把「离线词典」放回最上面就没这么多请求了"
          );
        }
      } else if (s.missesCached > 0) {
        say(
          "有 " + s.missesCached + " 条「问过但没收下」(不会再自动重问), 其中首音校验判掉 " +
            s.rejected + " 次 —— 想再问一次就点「重试没结果的词」"
        );
      } else if (s.hits > 0) {
        say("✓ 已生效: 命中 " + s.hits + " 次 (本次会话)");
      } else {
        say("还没问过任何词 —— 说明歌词里的拉丁词都在离线词典里, 这层没活干");
      }
    }

    function refreshAll() {
      refreshLayers();
      refreshPreview();
      refreshUsage();
      refreshLearned();
      refreshLlmState();
      refreshStatus();
    }

    /*
     * 面板开着的时候每秒轻量刷一下数字（不重跑预览和状态那种重活）。
     *
     * 为什么需要：这些数字是快照，而模型层是在持续干活的 —— 用户看到
     * 「队列里还有 184 个词在等」时，其实可能下一秒就排完了；反过来，
     * 队列真的卡住时也需要看得出来。不刷新的话，截图里那种"额度满着、
     * 队列一大坨"会让人以为它卡死了。面板一关就自己停（isConnected 检查）。
     */
    var liveTimer = setInterval(function () {
      if (!root.isConnected) {
        clearInterval(liveTimer);
        return;
      }
      refreshUsage();
      refreshLlmState();
      refreshLearned();
    }, 1000);

    var NEEDS_RESCAN = ["annotateAll", "scope", "customSelector", "annotateNonJapanese"];
    var NEEDS_RESTYLE = ["rtSize", "rtOpacity"];

    var inputs = root.querySelectorAll("[data-k]");
    for (var i = 0; i < inputs.length; i++) {
      (function (el) {
        var key = el.dataset.k;
        if (el.type === "checkbox") el.checked = !!config[key];
        else el.value = config[key];

        var commit = function () {
          if (el.type === "checkbox") config[key] = el.checked;
          else if (el.type === "range" || el.type === "number") config[key] = Number(el.value);
          else config[key] = el.value;
          /*
           * 接口地址当场纠正：多数人粘的是文档里的 base_url
           * （`https://api.deepseek.com` 或 `…/v1`），那样 POST 过去是 404。
           * 纠正后的值写回输入框，免得每次都得记住补 `/chat/completions`。
           */
          if (key === "llmEndpoint" && typeof WKLLM !== "undefined" && WKLLM.normalizeEndpoint) {
            var fixed = WKLLM.normalizeEndpoint(config.llmEndpoint);
            if (fixed !== config.llmEndpoint) {
              config.llmEndpoint = fixed;
              el.value = fixed;
            }
          }
          /*
           * key 也当场洗一遍：从网页上复制 key 很容易带上引号、空格，甚至整个
           * "Bearer xxx"。这些都会让请求 401（用户看到的就是"大模型请求全失败"），
           * 洗完之后写回输入框，免得每次都要自己盯着看有没有多余字符。
           */
          if (key === "llmKey" && typeof WKLLM !== "undefined" && WKLLM.normalizeKey) {
            var clean = WKLLM.normalizeKey(config.llmKey);
            if (clean !== config.llmKey) {
              config.llmKey = clean;
              el.value = clean;
            }
          }
          saveConfig();
          var out = root.querySelector('[data-v="' + key + '"]');
          if (out) out.textContent = fmt(key);
          updateStyles();
          if (key === "enabled") {
            config.enabled ? enable() : disable();
          } else if (key === "online") {
            if (state.corrector) state.corrector.setOnline(config.online);
            if (config.online) rescan();
          } else if (key.indexOf("llm") === 0) {
            // 接口地址 / 模型 / key 变了，把新配置推给客户端再重扫：
            // 关掉或清空 key 时，已经命中缓存的那些词也要退回去，所以必须重扫
            if (state.llm) {
              state.llm.configure({
                enabled: config.llmEnabled !== false,
                endpoint: config.llmEndpoint,
                model: config.llmModel,
                key: config.llmKey,
              });
            }
            rescan();
          } else if (NEEDS_RESCAN.indexOf(key) >= 0) {
            rescan();
          } else if (NEEDS_RESTYLE.indexOf(key) >= 0) {
            if (state.annotator) state.annotator.restoreAll();
            schedule(0);
          }
          refreshAll();
        };
        el.addEventListener("change", commit);
        if (el.type === "range") el.addEventListener("input", commit);

        var out0 = root.querySelector('[data-v="' + key + '"]');
        if (out0) out0.textContent = fmt(key);
      })(inputs[i]);
    }

    // 外链交给系统浏览器，直接跳会把网易云本身导航走
    var links = root.querySelectorAll("[data-open]");
    for (var li = 0; li < links.length; li++) {
      (function (a) {
        a.addEventListener("click", function (e) {
          e.preventDefault();
          try {
            betterncm.ncm.openUrl(a.dataset.open);
          } catch (err) {
            warn("打开链接失败", err);
          }
        });
      })(links[li]);
    }

    var actions = root.querySelectorAll("[data-a]");
    for (var ai = 0; ai < actions.length; ai++) {
      (function (b) {
        b.addEventListener("click", function () {
          var what = b.dataset.a;
          if (what === "rescan") {
            rescan();
          } else if (what === "retry") {
            // 两层一起清：免费接口那些"查过、没有"的，和模型那些"问过但没收下"的
            var n = state.corrector ? state.corrector.retryMisses() : 0;
            var m = state.llm && state.llm.retryMisses ? state.llm.retryMisses() : 0;
            rescan();
            b.textContent = "已重新排队 " + n + " + " + m + " 个";
            setTimeout(function () {
              b.textContent = "重试没结果的词";
            }, 1500);
          } else if (what === "exportWords") {
            /*
             * 导出「可以沉淀进离线词典」的素材（已学会的词 + 两层缓存命中）。
             * 面板里没有文件系统可用，所以：打一份到控制台 + 尽量复制到剪贴板，
             * 用户存成 data/learned.json 之后跑 npm run promote:learned。
             */
            var payload = collectWordExport();
            var json = JSON.stringify(payload, null, 2);
            var count = payload.learned.length + payload.llm.length + payload.google.length;
            var copied = false;
            try {
              var ta = root.ownerDocument.createElement("textarea");
              ta.value = json;
              ta.style.position = "fixed";
              ta.style.opacity = "0";
              root.ownerDocument.body.appendChild(ta);
              ta.select();
              copied = root.ownerDocument.execCommand && root.ownerDocument.execCommand("copy");
              root.ownerDocument.body.removeChild(ta);
            } catch (eCopy) {
              copied = false;
            }
            try {
              console.log("[western-katakana] 词库素材（" + count + " 条）：", json);
            } catch (eLog) {
              /* 控制台打不出来就算了 */
            }
            b.textContent = copied ? "已复制 " + count + " 条" : "已打印到控制台 " + count + " 条";
            setTimeout(function () {
              b.textContent = "导出词库素材";
            }, 2500);
          } else if (what === "clearCache") {
            if (state.corrector) state.corrector.clearCache();
            if (state.llm) state.llm.clearCache();
            rescan();
            b.textContent = "已清空";
            setTimeout(function () {
              b.textContent = "清除校正缓存";
            }, 1500);
          } else if (what === "learnClear") {
            if (state.learned) {
              var gone = state.learned.clear();
              rescan();
              b.textContent = "已清掉 " + gone + " 个";
              setTimeout(function () {
                b.textContent = "清空已学会的词";
              }, 1500);
            }
          } else if (what === "usageReset") {
            var scope = b.dataset.scope || "session";
            if (state.usage) state.usage.reset(scope);
          } else if (what === "layersReset") {
            config.layerOrder = normalizeLayerOrder(DEFAULTS.layerOrder);
            saveConfig();
            applyLayerOrder();
            rescan();
          } else if (what === "llmTest") {
            var out = root.querySelector('[data-v="llmTest"]');
            if (!state.llm) {
              if (out) out.textContent = "核心模块未加载";
            } else {
              if (out) out.textContent = "测试中…";
              state.llm.test().then(function (r) {
                if (out) out.textContent = (r.ok ? "✅ " : "❌ ") + r.message;
                refreshAll();
              });
            }
          }
          refreshAll();
        });
      })(actions[ai]);
    }

    refreshAll();
    return root;
  }

  /**
   * 收集「可以沉淀进离线词典」的素材：已学会的词 + 两层缓存的命中。
   * 只收集，不筛选 —— 筛选在构建期（tools/promote-learned.js），
   * 那里能看到完整词典、黑名单，也能调阈值。
   */
  function collectWordExport() {
    var learned = state.learned ? state.learned.list() : [];
    var llm = state.llm && state.llm.exportWords ? state.llm.exportWords() : [];
    var google = state.corrector && state.corrector.exportWords ? state.corrector.exportWords() : [];
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      learned: learned.map(function (x) {
        return { word: x.word, kana: x.kana, at: x.at };
      }),
      llm: llm,
      google: google,
    };
  }

  function notifyConfigUI() {
    try {
      if (typeof plugin !== "undefined" && plugin.onConfig && !state.configRoot) {
        state.configRoot = buildConfigUI();
      }
      if (state.configRoot && state.configRoot.isConnected === false) {
        // 面板被关掉过，下次 onConfig 会重建
        state.configRoot = null;
      }
    } catch (e) {
      /* 面板只是显示用，不能因为它把插件搞崩 */
    }
  }

  // ------------------------------------------------------------ 生命周期

  if (emergencyOff()) {
    try {
      console.log(LOG, "检测到紧急开关，插件不启动");
    } catch (e) {
      /* ignore */
    }
    return;
  }

  plugin.onConfig(function () {
    return buildConfigUI();
  });

  plugin.onLoad(function () {
    trace("boot", "onLoad 开始 off=" + emergencyOff() + " enabled=" + config.enabled +
      " scope=" + config.scope + " annotateAll=" + config.annotateAll +
      " cfgVer=" + config.configVersion +
      " 模块 matcher=" + typeof WKMatcher + " reading=" + typeof WKReading +
      " dict=" + typeof WKDict + " annotate=" + typeof WKAnnotate);

    if (typeof WKMatcher === "undefined" || typeof WKReading === "undefined" ||
        typeof WKAnnotate === "undefined" || typeof WKDict === "undefined") {
      warn("核心模块未注入，检查 manifest.json 的 injects 顺序");
      return;
    }
    // 语言层是可选的：没注入时只剩英语/罗马音（老行为），注音照常工作
    if (typeof WKLangs === "undefined") warn("core/langs.js 没注入：法语 / 德语 / 拉丁语等西文语种不生效");

    try {
      betterncm.app.getBetterNCMVersion().then(
        function (v) {
          state.betterncmVersion = v;
        },
        function () {
          /* 只是给状态区看的，拿不到就算了 */
        }
      );
    } catch (e) {
      /* ignore */
    }

    try {
      updateStyles();
      /*
       * 用量统计（本次 / 今天 / 累计）。core/usage.js 没注入时整块功能缺席，
       * 但注音本身照常工作 —— 统计是附属品，不能拖累主流程。
       */
      if (typeof WKUsage !== "undefined") {
        state.usage = WKUsage.createUsage();
      }
      state.corrector = WKCorrect.createCorrector({
        online: config.online,
        // 纯片假名还不够：还要像这个词的音译（tick 不能被回成 カチカチ）
        validate: validateAnswer,
        // 免费接口没有 token 概念，用请求数 + 字符数记账
        onUsage: function (fields) {
          if (state.usage) state.usage.add("google", fields);
        },
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
        onStatus: function (msg) {
          log(msg);
          notifyConfigUI();
        },
        onUpdate: function () {
          /*
           * 在线结果回来了 → 就地改写已有注音，不要 restoreAll。
           *
           * restoreAll 会把所有注音先撤掉再重注，而重注时那些"还没拿到结果"的词
           * 给不出读音（在线优先、规则垫底），于是整行会变空、过一会儿才补回来 ——
           * 用户报的"全英文行标注后有概率消失"就是这个。
           */
          if (!config.enabled) return;
          if (state.annotator && state.annotator.relabel) state.annotator.relabel();
          schedule(0); // 顺手把这一轮新拿到结果的词补上（已注的音一个都不动）
          notifyConfigUI();
        },
      });
      state.reader = WKReading.createReader({
        dict: WKDict.words,
        // 英文常用词表：罗马音层靠它判断"这看着像英文词"，判出来就交给在线层仲裁
        enWords: typeof WKEnWords !== "undefined" ? WKEnWords.words : null,
        // 同步层按用户排的顺序（异步层由 readForDisplay 处理，见那里）
        order: syncLayerOrder(),
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
      });
      applyLayerOrder();
      /*
       * 「学会的词」：把模型答过两次、而且纠正了本地读音的词沉淀成离线词条
       * （见 core/learn.js）。它压在最前面、按离线词典的名次参与层序 ——
       * 这些词以后不会再问模型，用户要的"自动沉淀进词典"就是这个。
       */
      if (typeof WKLearn !== "undefined") {
        state.learned = WKLearn.createLearned({
          normalize: function (word) {
            return typeof WKMatcher !== "undefined" ? WKMatcher.normalize(word) : String(word == null ? "" : word).toLowerCase();
          },
        });
      }
      // 大模型校正：没填 key 就整层不工作（lookup 一律返回 null），自动退回上面的 Google 路子
      if (typeof WKLLM !== "undefined") {
        state.llm = WKLLM.createClient({          enabled: config.llmEnabled !== false,
          endpoint: config.llmEndpoint,
          model: config.llmModel,
          key: config.llmKey,
          // 用量：token 数由接口响应里的 usage 给（没给就只记次数）
          onUsage: function (fields) {
            if (state.usage) state.usage.add("llm", fields);
          },
          /*
           * 收下了一个模型答案 -> 试着沉淀成离线词条。
           * 规矩（宁缺毋滥，理由见 core/learn.js）：
           *   - 本地层本来就对的不学（学了也没用）；
           *   - "两可"的短音节不学（读音取决于那句话）；
           *   - 要在两个不同的句子里答出同一个读音才收（learn.js 记账）。
           */
          onAnswer: function (word, kana, line) {
            if (!state.learned) return;
            /*
             * 单字母不沉淀：它的读音取决于语境（冠词 `a` ア、字母名
             * `(A, B)` エー、段标 `(A:` 不标），词级词条钉死一个必然出错 ——
             * 用户机器上那条 `a → アー` 就是这么来的（模型在 `(A:` 的行里答的），
             * 结果拉丁语歌词里的段标一直带着 アー。和"两可短音节不收"同一个道理。
             */
            if (/^[A-Za-z]$/.test(word)) return;
            var local = state.reader ? state.reader.read(word) : null;
            if (!local || !local.kana) return;
            if (isTwoWayShort(word, local.kana)) return;
            var r = state.learned.note(word, kana, line, local.kana);
            if (r === "learned" || r === "drop") {
              log(
                (r === "learned" ? "学会一个词：" : "撤销一个学会的词（模型改口）：") +
                  word +
                  " -> " +
                  kana +
                  "（已学会 " +
                  state.learned.stats().count +
                  " 个）"
              );
              // 让页面立刻用上这个读音，并把面板上的数字刷新
              if (state.annotator && state.annotator.relabel) state.annotator.relabel();
              schedule(0);
              notifyConfigUI();
            }
          },
          // 同上：拦住"意译/拟声词"（用户报的 tick -> カチカチ）
          validate: validateAnswer,
          log: function () {
            trace("llm", Array.prototype.join.call(arguments, " "));
            if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
          },
          onStatus: function (msg) {
            log(msg);
            notifyConfigUI();
          },
          onUpdate: function () {
            // 大模型的结果回来了：就地改写已有注音（见上面正确器那段的说明），
            // 再排一次扫描把新拿到结果的词补上
            if (!config.enabled) return;
            if (state.annotator && state.annotator.relabel) state.annotator.relabel();
            schedule(0);
            notifyConfigUI();
          },
        });
      }
      state.annotator = WKAnnotate.createAnnotator({
        // 返回 { kana, source }：source 用来给"按来源着色"的排障功能打标
        // 第三个参数是这个词的 token（段标 `M:` 那类判断要看 token 的位置，不能只看整行）
        lookup: function (word, line, token) {
          return resolveReading(word, line, token);
        },
        // 暂定读音（在线那层还在问）会在注音上打一个淡一点的标记
        pending: function (word, line, token) {
          return isProvisional(word, line, token);
        },
        // 排障用：这段文字里有没有被判成"打码"的重复字母串
        censoredRun: function (text) {
          return looksCensoredRun(text);
        },
        annotateAll: config.annotateAll !== false,
        log: function () {
          trace("annotate", Array.prototype.join.call(arguments, " "));
        },
      });
    } catch (e) {
      state.error = (e && e.message) || String(e);
      warn("初始化失败", e);
      return;
    }

    /*
     * 钩子：装了共存补丁的 jp-furigana 重建完一行后会直接调 window.__ktRepairLine，
     * 让我们在同一个任务里把注音补回去（等下一帧就是可见的一闪）。
     *
     * 这里必须链上去而不是覆盖：片假名终结者可能已经挂了一个同名钩子，
     * 直接赋值会把它顶掉，那边立刻开始闪。两个插件都要被叫到。
     */
    try {
      var prevHook = typeof window.__ktRepairLine === "function" ? window.__ktRepairLine : null;
      window.__ktRepairLine = function (lineEl) {
        var mine = false;
        try {
          if (config.enabled && state.annotator && state.annotator.repairLine) {
            if (state.observer) state.observer.takeRecords();
            mine = state.annotator.repairLine(lineEl);
          }
        } catch (e) {
          /* ignore */
        }
        // 再去叫前一个（可能是片假名终结者）
        if (prevHook) {
          try {
            prevHook(lineEl);
          } catch (e) {
            /* ignore */
          }
        }
        return mine;
      };
    } catch (e) {
      /* 挂不上就算了，还有 MutationObserver 那条路 */
    }

    if (config.enabled) enable();
    else state.annotator.restoreAll();

    trace("boot", "初始化完成，annotator=" + !!state.annotator + " reader=" + !!state.reader);

    window.WesternKatakana = {
      config: config,
      state: state,
      set: function (key, value) {
        config[key] = value;
        if (key === "layerOrder") config.layerOrder = normalizeLayerOrder(config.layerOrder);
        saveConfig();
        applyLayerOrder();
        updateStyles();
        if (key === "enabled") config.enabled ? enable() : disable();
        else rescan();
        return config[key];
      },
      /*
       * 读音来源顺序：WK.layers() 看当前顺序，WK.layers(['llm','dict',...]) 直接改。
       * 设置面板里那对 ↑↓ 按钮走的就是同一条路（改完同样会重扫）。
       */
      layers: function (order) {
        if (order === undefined) return config.layerOrder.slice();
        config.layerOrder = normalizeLayerOrder(order);
        saveConfig();
        applyLayerOrder();
        rescan();
        return config.layerOrder.slice();
      },
      /*
       * API 用量：WK.usage() 看账本（本次/今天/累计，两层分开），
       * WK.usageReset('session'|'today'|'all') 清零。设置面板里那几个按钮走同一条路。
       */
      usage: function () {
        return state.usage ? state.usage.snapshot() : null;
      },
      usageReset: function (scope) {
        if (state.usage) state.usage.reset(scope || "session");
        return state.usage ? state.usage.snapshot() : null;
      },
      read: function (word) {
        // 本地那几层的读音（不含大模型/联网校正）—— 看 source 就知道是谁给的
        return state.reader ? state.reader.read(word) : null;
      },
      /*
       * 「学会的词」：模型答过两次、且纠正了本地读音的词，已经沉淀成离线词条
       * （它们不再走模型，省钱就在这里）。面板上那一行显示的就是这份东西。
       *   WK.learn.list()        看学会了哪些（按最近用到的排前面）
       *   WK.learn.stats()       数量 / 待定数量 / 本次用上几个
       *   WK.learn.forget('xxx') 忘掉一个（读音不对时用）
       *   WK.learn.clear()       全清（等于回到"每次都得问模型"）
       */
      /*
       * 「把常用词沉淀进离线词典」的素材导出。
       *
       * 运行期写不进仓库里的 src/core/dict.js（那是构建产物），所以流程是：
       *   面板「操作 → 导出词库素材」或控制台 WK.exportWords()
       *   → 得到一段 JSON（已学会的词 + 大模型缓存命中 + 免费接口缓存命中）
       *   → 存成 data/learned.json
       *   → `npm run promote:learned` 筛选后写进 tools/seed-words-learned.js
       *   → `npm run build:dict` 合并进词典
       * 筛选（一致性、纯片假名、与现有词典冲突、黑名单）都在构建期做，
       * 见 tools/promote-learned.js。
       */
      exportWords: function () {
        return collectWordExport();
      },
      exportWordsJson: function () {
        return JSON.stringify(collectWordExport(), null, 2);
      },
      learn: {
        list: function () {
          return state.learned ? state.learned.list() : [];
        },
        stats: function () {
          return state.learned ? state.learned.stats() : null;
        },
        forget: function (word) {
          return state.learned ? state.learned.forget(word) : false;
        },
        clear: function () {
          var n = state.learned ? state.learned.clear() : 0;
          rescan();
          return n;
        },
        flush: function () {
          if (state.learned) state.learned.flush();
        },
      },
      learned: function () {
        // 短别名：WK.learned() 直接看列表
        return state.learned ? state.learned.list() : [];
      },
      display: function (word) {
        /*
         * 页面上实际用的那个读音：按用户排的层序取（默认
         * 词典 -> 罗马音 -> 大模型 -> Google -> 规则）。
         * 判断"某个词到底是谁给的读音"就用它：和 WK.read() 比一下，
         * 不一样就说明被大模型（或联网）换过了。
         */
        return readForDisplay(word);
      },
      /*
       * 排障：按读音来源上色。WK.colorize(true) 开、WK.colorize(false) 关、
       * 不带参数就是看当前状态。只改 CSS（wk-src-* 类名一直挂在注音节点上），
       * 所以不用重扫，开了立刻就变。
       */
      colorize: function (on) {
        if (on !== undefined) {
          config.colorBySource = !!on;
          saveConfig();
          updateStyles();
        }
        return !!config.colorBySource;
      },
      dict: function () {
        return typeof WKDict !== "undefined" ? WKDict.words : {};
      },
      /*
       * 借词表（core/loan.js）：哪些词"日语里就是这么写的"。
       * WK.loan() 看条数，WK.loan('de') 看德语那张表。
       */
      loan: function (langId) {
        if (typeof WKLoan === "undefined") return null;
        if (!langId) return { count: WKLoan.count, langs: Object.keys(WKLoan.tables) };
        return WKLoan.get(langId);
      },
      /*
       * 语言判定：WK.lang('这一行歌词') 看它被判成什么语言。
       * 插件支持法语 / 德语 / 拉丁语 / 葡萄牙语 / 荷兰语 / 斯瓦希里语 /
       * 汉语拼音 / 俄语 / 希腊语，判不出来返回 null（那就走词典/罗马音/英文规则）。
       */
      lang: function (text) {
        if (typeof WKLangs === "undefined") return null;
        var id = text === undefined || text === null ? null : WKLangs.detect(String(text));
        return { id: id, label: id ? WKLangs.label(id) : "（没判出来）" };
      },
      stats: function () {
        return {
          layers: config.layerOrder.slice(), // 当前层序（WK.layers() 改的就是它）
          lastPass: state.lastResult || null, // 含 skips：这一轮"为什么有行没注音"
          reading: state.reader ? state.reader.stats() : null,
          correct: state.corrector ? state.corrector.stats() : null,
          llm: state.llm ? state.llm.stats() : null,
          learned: state.learned ? state.learned.stats() : null,
        };
      },
      llm: {
        stats: function () {
          return state.llm ? state.llm.stats() : null;
        },
        /*
         * 「大模型到底生效了没有」——一句话回答。
         * 用户最常问的就是这个，而裸 stats() 的数字要自己解读：
         * requests=0 既可能是"没配 key"，也可能是"歌词里的词全在词典里、这层没活干"。
         * 这里把两种都分开说清楚。
         */
        check: function () {
          if (!state.llm) return "大模型层没加载（core/llm.js 没注入？）";
          var s = state.llm.stats();
          var lines = [];
          lines.push("启用：" + (s.enabled ? "是" : "否"));
          lines.push("API Key：" + (s.hasKey ? "已填" : "没填"));
          if (s.hasKey) {
            /*
             * Key 体检：真机上"请求全失败"最常见的原因不是服务端，而是粘进来的 key
             * 不干净（带引号 / 前后空格 / 整个 "Bearer xxx"）。这三样我们在配置阶段
             * 就收拾掉了，顺手在这里说清楚 —— 否则用户只能看到一句 401。
             */
            var odd = [];
            if (s.keyShape !== "sk-") odd.push("形状不像（一般以 sk- 开头）");
            if (s.keyLength < 20) odd.push("太短（只有 " + s.keyLength + " 个字符）");
            lines.push("Key 体检：" + (odd.length ? "⚠ " + odd.join("；") : "✓ 长度 " + s.keyLength));
            if (s.keyCleaned) lines.push("　（粘进去时带了引号/空格/Bearer，已自动去掉）");
          }
          lines.push("接口：" + s.endpoint + "　模型：" + s.model);
          lines.push(
            "请求 " + s.requests + " 次，命中 " + s.hits + "，模型没给 " + s.misses + "，失败 " + s.failures
          );
          lines.push("缓存 " + s.cached + " 条，队列 " + s.pending + " 个词" + (s.inflight ? "（正在请求）" : ""));
          if (s.missesCached) {
            lines.push(
              "问过但没收下（不会再自动重问）：" + s.missesCached + " 条，其中首音校验判掉 " + s.rejected + " 次"
            );
            lines.push("→ 想再问一次：点设置里的「重试没结果的词」；想查模型当时说了什么：WK.llm.rejects()");
          }
          if (typeof s.roomThisMinute === "number") lines.push("本分钟还剩 " + s.roomThisMinute + " 次请求额度");
          if (s.cooldownMs > 0) lines.push("退避中：还要等 " + Math.round(s.cooldownMs / 1000) + " 秒");
          if (s.lastError) lines.push("最后一次错误：" + s.lastError);
          if (!s.enabled) lines.push("→ 设置面板里把「用大模型校正」打开");
          else if (!s.hasKey) lines.push("→ 设置面板里填 API Key，然后点「测试连接」");
          else if (s.failures > 0 && s.hits === 0) {
            lines.push("→ 请求都没成功，照上面的错误信息对号入座：");
            lines.push("　 401/403 = key 不对；402 = 余额用完；429 = 被限流；404 = 地址少了 /chat/completions；400 = 模型名不对");
            lines.push("　 没有状态码的那句（Failed to fetch 之类）= 网络不通，或被跨域拦住（服务商得允许 music.163.com 这个来源）");
          } else if (s.hits > 0) lines.push("→ 已经生效 ✓（想看某个词是谁给的：WK.display('词') 对比 WK.read('词')）");
          else if (s.requests > 0) lines.push("→ 请求发出去了但一个都没命中，看上面「模型没给 / 失败」的数字");
          else
            lines.push(
              "→ 还没问过任何词：说明到目前为止歌词里的拉丁词**全在离线词典里**（" +
                (typeof WKDict !== "undefined" ? WKDict.count : "?") +
                " 条），这一层没活干。想立刻验证：点设置里的「测试连接」，或找一首带生僻词/英文人名的歌"
            );
          return lines.join("\n");
        },
        test: function () {
          return state.llm ? state.llm.test() : Promise.resolve({ ok: false, message: "核心模块未加载" });
        },
        flush: function () {
          return state.llm ? state.llm.flush() : Promise.resolve(null);
        },
        /*
         * 「模型当时到底回了什么、为什么没收下」—— 排障用。
         * 用户说「某个词一直不矫正」时，这里通常一眼就能看出原因
         * （首音校验误伤 / 回的不是片假名 / 服务商没给）。
         */
        rejects: function (limit) {
          if (!state.llm || !state.llm.rejects) return [];
          return state.llm.rejects(limit);
        },
        retryMisses: function () {
          return state.llm && state.llm.retryMisses ? state.llm.retryMisses() : 0;
        },
        /*
         * 手动把「大模型矫正」这根管子接回去：清掉退避，并把"要过但还没结论"的词
         * （包括注音那一刻这一层不可用、根本没问上的）立刻重新排一次。
         */
        retry: function () {
          return state.llm && state.llm.retryNow ? state.llm.retryNow() : null;
        },
        clearCache: function () {
          if (state.llm) state.llm.clearCache();
          rescan();
        },
        configure: function (next) {
          if (!state.llm) return null;
          state.llm.configure(next || {});
          if (next && next.key !== undefined) {
            config.llmKey = String(next.key || "");
            saveConfig();
          }
          if (next && next.enabled !== undefined) {
            config.llmEnabled = !!next.enabled;
            saveConfig();
          }
          rescan();
          return state.llm.stats();
        },
      },
      scan: function (text) {
        return WKMatcher.scan(text);
      },
      pass: pass,
      rescan: rescan,
      enable: enable,
      disable: disable,
      clearCache: function () {
        if (state.corrector) state.corrector.clearCache();
        rescan();
      },
      rubyLayout: function () {
        return WKAnnotate.hasRubyLayout(document);
      },
      repairLine: function (lineEl) {
        return state.annotator && state.annotator.repairLine ? state.annotator.repairLine(lineEl) : false;
      },
    };

    /*
     * 四个名字都挂着：
     *   window.WesternKatakana  长名（插件现在的身份）
     *   window.WK               短名，控制台里敲的就是它（文档里写的 WK.stats() / WK.lang()）
     *   window.LK               改名前的短名 ┐老文档 / 老脚本里是它们，各留一行别名不至于失效
     *   window.LatinKatakana    改名前的长名 ┘
     */
    window.WK = window.WesternKatakana;
    window.LK = window.WesternKatakana;
    window.LatinKatakana = window.WesternKatakana;

    log(
      "已加载" +
        (DEV ? "（开发模式）" : "") +
        "，控制台可用 WK.stats() 看统计、WK.llm.check() 看大模型有没有生效、" +
        "WK.display('light') 看某个词实际用的读音、WK.scan('light と clover') 看分词"
    );
    notifyConfigUI();
  });
})();
