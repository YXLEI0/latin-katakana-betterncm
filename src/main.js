/*
 * 拉丁字母片假名注音 · BetterNCM 插件入口
 *
 * 干的事：日语歌歌词里的**拉丁字母**（clover / light / diorama / Sekai …）上方
 * 标出片假名读音。和 katakana-terminator（片假名 -> 英文）方向正好相反，
 * 两个可以同时开：一行里既有片假名又有英文时，两种注音会同时出现。
 *
 * 读音来源（core/reading.js 定顺序）：
 *   1. 离线词典（core/dict.js，399 条，真实外来语写法）
 *   2. 罗马音切分（sekai -> セカイ，歌词里官方写的罗马音）
 *   3. 英文音译规则（light -> ライト，兜底，永远能给一个结果）
 *   4. 联网校正（core/correct.js）：只对"规则猜的、且没把握"的词查一次，
 *      且只接受**纯片假名**的结果 —— 翻译成汉字的（love -> 愛）对唱歌没用，丢掉。
 */
(function () {
  "use strict";

  var LOG = "[latin-katakana]";
  var REPO_URL = "https://github.com/YXLEI0/latin-katakana-betterncm";

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
  var TRACE_KEY = "latin-katakana.trace";
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
  var CONFIG_KEY = "latin-katakana.config";

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
    scope: "all", // titles | lyrics | all | custom
    customSelector: "",
    rtSize: 55, // 注音字号（相对底字百分比）
    rtOpacity: 80, // 注音不透明度
    focusDebug: false, // 给已注音区域描边，排障用
    colorBySource: false, // 按读音来源给注音上色（排障用，见设置面板的图例）
    verbose: false,
  };

  // ------------------------------------------------------------ 读音来源与顺序

  /*
   * 用户可以在设置面板里给这几层上下调。越靠前越优先，语义是：
   *   "排在当前答案前面的在线层"才有资格覆盖它 —— 所以把**英文音译规则**提到
   *   大模型/免费接口前面，就等于**一个请求都不发**（这正是"不想联网"的用法）；
   *   把**大模型**提到词典前面，则连词典命中的词也会让大模型判一遍。
   *
   * 记号 / 缩写 / 字母名 / 长音符罗马字（`D/N/A`、`I'll`、`LDK`、`Tōkyō`）
   * 不在这张表里：它们决定的不是"读音该信谁"，而是"这个词该怎么断"，永远最先判。
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
   * 一个本地答案在"谁说了算"这件事上的**实际名次**。
   *
   * 一般情况下就是它所在层的名次，但有个例外：**没把握的答案（confident:false）
   * 一律按最低那层（英文音译规则）算** —— 于是排在它后面的在线层就有资格覆盖它。
   *
   * 为什么：罗马音层只是"整串能切成日语音节"，`shake`(sha-ke) / `open`(o-pe-n)
   * 这种英文词会被它读成 シャケ / オペン。如果按名次拍板（罗马音排在在线层前面），
   * 这些词就永远读错、大模型也没机会纠。标成"没把握"之后再按这个名次算，
   * 在线层就能接手；而用户如果把「英文音译规则」拖到在线层前面（纯离线用法），
   * 这个名次也跟着变成最优先，在线层照样不会被打扰。
   */
  function effectiveRank(r) {
    if (!r) return -1;
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
   *     localStorage['latin-katakana.off'] = '1'   // 并重启
   */
  function emergencyOff() {
    try {
      return localStorage.getItem("latin-katakana.off") === "1";
    } catch (e) {
      return false;
    }
  }

  function devMode() {
    try {
      if (typeof plugin !== "undefined" && plugin.devMode) return true;
      return localStorage.getItem("latin-katakana.dev") === "1";
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
  };

  // ------------------------------------------------------------ 读音

  /*
   * 取一个词的显示读音，连同"这个读音最终是谁给的"一起返回：
   *   { kana, source }   source ∈ dict / romaji / rule / letters / llm / google
   *
   * 层序由用户在设置面板里定，默认：
   *
   *   离线词典 > 罗马音 > 大模型校正 > 免费接口 > 英文音译规则
   *
   * 同步层（词典/罗马音/规则）当场给答案；异步层（大模型/免费接口）要发请求。
   * 规则是拼写音译（hello -> ヘッラオ、question -> クワエサション），所以默认把它
   * 排在在线层后面 —— 但它同时也是一切的兜底：**在线层挂了/没配/在退避时立刻放行**，
   * 否则断网就等于一个字都不标。
   *
   * 排序带来的两个直接可用的用法：
   *   - 把「英文音译规则」提到在线层前面 -> 这一步**一个请求都不发**，纯离线；
   *   - 把「大模型」提到词典前面       -> 连词典命中的词也让大模型判一遍
   *                                        （词典偶有错条目，这是逃生门）。
   *
   * 底线不变：**绝不返回 null 让这行空着**。高优先的在线层还在问的时候，用现成的
   * 答案顶上并标成"暂定"（`lt-pending`，样式淡一点），结果回来由 annotate.relabel()
   * 就地改写 —— 用户报过的"全英文行标注后有概率消失"就是这么修的。
   *
   * source 是给排障用的（「按来源着色」把每一层染成不同颜色），
   * 单独一个 readForDisplay() 只返回 kana，控制台 LK.display() 用它。
   */
  function resolveReading(word, line) {
    if (!state.reader) return null;
    var r = state.reader.read(word);
    if (!r || !r.kana) return null;

    var mine = effectiveRank(r); // 没把握的答案按最低层算，在线层可以覆盖它
    for (var i = 0; i < config.layerOrder.length; i++) {
      var id = config.layerOrder[i];
      if (!ASYNC_LAYERS[id]) continue;
      // 排在当前答案后面的在线层不参与：不发请求、也不覆盖
      if (i >= mine) break;
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

  /** 只要读音字符串的调用方（控制台 LK.display / 老代码）走这个 */
  function readForDisplay(word, line) {
    var got = resolveReading(word, line);
    return got ? got.kana : null;
  }

  /**
   * 这个词的读音现在是不是"暂定"的（有比它更优先的在线层还在问）。
   * 注音层靠它在 ruby 上加 `lt-pending` 类 —— 样式淡一点，提示"还不一定"。
   */
  function isProvisional(word, line) {
    if (!word || !state.reader) return false;
    var r = state.reader.read(word);
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

  function pass() {
    if (!config.enabled || !state.annotator) return;
    if (emergencyOff()) {
      warn("检测到紧急开关，停用插件");
      disable();
      return;
    }
    var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
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
       * 注音层会告诉我们**过多久可以重试**。必须自己排下一次扫描：
       * 换歌之后如果页面不再变动（最典型的是**歌处于暂停**，歌词渲染一次就不动了），
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
   * delay=0 表示「观测到 DOM 变了，要立刻补注音」：必须**赶在下一帧绘制之前**
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
    if (typeof LKAnnotate !== "undefined" && LKAnnotate.removeStyles) {
      LKAnnotate.removeStyles(document);
    }
  }

  function rescan() {
    if (state.annotator) state.annotator.restoreAll();
    if (state.corrector) state.corrector.retryMisses();
    schedule(0);
  }

  function updateStyles() {
    if (typeof LKAnnotate !== "undefined" && LKAnnotate.applyStyles) {
      LKAnnotate.applyStyles(document, {
        rtSize: config.rtSize,
        rtOpacity: config.rtOpacity,
        focus: config.focusDebug,
        colorBySource: !!config.colorBySource,
      });
    }
  }

  // ------------------------------------------------------------ 设置面板

  var REPO = REPO_URL;

  function buildConfigUI() {
    var root = document.createElement("div");
    root.id = "latin-katakana-config";
    root.innerHTML =
      "<style>" +
      "#latin-katakana-config { font-size: 14px; line-height: 2; }" +
      "#latin-katakana-config h3 { margin: 14px 0 6px; font-size: 15px; }" +
      "#latin-katakana-config .lk-row { margin: 4px 0; }" +
      "#latin-katakana-config .lk-hint { opacity: .65; font-size: 12px; line-height: 1.6; }" +
      "#latin-katakana-config input[type=text] { width: 320px; padding: 2px 6px; }" +
      "#latin-katakana-config .lk-preview { padding: 10px 12px; border: 1px solid rgba(128,128,128,.35); border-radius: 6px; font-size: 18px; }" +
      "#latin-katakana-config .lk-preview-trans { margin-top: 4px; font-size: 14px; opacity: .6; }" +
      "#latin-katakana-config .lk-status { white-space: pre-wrap; font-family: monospace; font-size: 12px; opacity: .8; }" +
      "#latin-katakana-config .lk-layer { display: flex; align-items: center; gap: 6px; line-height: 1.9; }" +
      "#latin-katakana-config .lk-layer-name { min-width: 110px; }" +
      "#latin-katakana-config .lk-layer-note { opacity: .6; font-size: 12px; flex: 1; }" +
      "#latin-katakana-config .lk-layer-btn { min-width: 26px; }" +
      "#latin-katakana-config .lk-layer-btn[disabled] { opacity: .35; }" +
      "#latin-katakana-config .lk-layer-warn { color: #e8a33d; margin-top: 4px; }" +
      "#latin-katakana-config .lk-links a { margin-right: 14px; }" +
      "</style>" +
      '<div class="lk-links">' +
      '<a href="#" data-open="' + REPO + '">源码仓库</a>' +
      '<a href="#" data-open="' + REPO + '/issues">反馈问题</a>' +
      "</div>" +
      "<h3>预览</h3>" +
      '<div class="lk-preview"></div>' +
      "<h3>开关</h3>" +
      '<div class="lk-row"><label><input type="checkbox" data-k="enabled"> 启用拉丁字母注音</label></div>' +
      '<div class="lk-row"><label><input type="checkbox" data-k="online"> 规则没把握时联网校正读音</label></div>' +
      '<div class="lk-row"><label><input type="checkbox" data-k="annotateAll"> 除歌词外，也标注播放栏的歌曲名 / 歌手</label></div>' +
      '<div class="lk-hint">只处理歌词原文行和播放栏标题 —— 不会扫描整个页面。' +
      "RNP 歌词页的<b>罗马音层</b>和<b>中文翻译层</b>会跳过：那两层本身已经是读音或译文，标上去是噪音。</div>" +
      "<h3>外观</h3>" +
      '<div class="lk-row"><label>注音字号 <input type="range" data-k="rtSize" min="30" max="120" step="1"> <span data-v="rtSize"></span></label></div>' +
      '<div class="lk-row"><label>注音不透明度 <input type="range" data-k="rtOpacity" min="10" max="100" step="1"> <span data-v="rtOpacity"></span></label></div>' +
      '<div class="lk-row"><label><input type="checkbox" data-k="focusDebug"> 给已注音区域描边（排障）</label></div>' +
      '<div class="lk-row"><label><input type="checkbox" data-k="colorBySource"> 按读音来源给注音上色（排障）</label></div>' +
      '<div class="lk-hint">' +
      '<span style="color:#46d17e">■ 离线词典</span>　' +
      '<span style="color:#3fb6d8">■ 记号 / 字母名</span>　' +
      '<span style="color:#6f8ff0">■ 罗马音</span>　' +
      '<span style="color:#e8a33d">■ 英文规则（拼写猜的）</span>　' +
      '<span style="color:#c07ce8">■ 大模型</span>　' +
      '<span style="color:#e0629a">■ 免费接口</span><br>' +
      "淡显（暂定）的是在线层还在问、先拿低优先层的读音顶着的词；等结果回来会换成对应颜色。" +
      "</div>" +
      "<h3>范围</h3>" +
      '<div class="lk-row"><label>标注范围 <select data-k="scope">' +
      '<option value="all">歌词 + 播放栏（默认）</option>' +
      '<option value="lyrics">只标歌词</option>' +
      '<option value="titles">只标播放栏</option>' +
      '<option value="custom">自定义选择器</option>' +
      "</select></label></div>" +
      '<div class="lk-row"><label>自定义选择器 <input type="text" data-k="customSelector" placeholder="例如 ul.lyric > li"></label></div>' +
      '<div class="lk-hint">选择器留空或匹配不到元素时会自动回退。</div>' +
      "<h3>读音来源顺序</h3>" +
      '<div class="lk-hint">越靠上越优先。把<b>英文音译规则</b>提到在线层前面 = <b>一个请求都不发</b>（纯离线）；' +
      "把<b>大模型</b>提到词典前面 = 连词典命中的词也让大模型判一遍（词典偶有错条目，这是逃生门）。<br>" +
      "记号 / 缩写 / 字母名 / 长音符罗马字（<code>D/N/A</code>、<code>I'll</code>、<code>LDK</code>、" +
      "<code>Tōkyō</code>）不参与排序 —— 它们定的是「这个词该怎么断」，永远最先判。</div>" +
      '<div class="lk-layers"></div>' +
      '<div class="lk-row"><button data-a="layersReset">恢复默认顺序</button> <span data-v="layersReset"></span></div>' +
      "<h3>大模型校正（推荐）</h3>" +
      '<div class="lk-row"><label><input type="checkbox" data-k="llmEnabled"> 用大模型校正规则读出来的词</label></div>' +
      '<div class="lk-row"><label>接口地址 <input type="text" data-k="llmEndpoint"></label></div>' +
      '<div class="lk-row"><label>模型 <input type="text" data-k="llmModel"></label></div>' +
      '<div class="lk-row"><label>API Key <input type="password" data-k="llmKey" placeholder="sk-..."></label></div>' +
      '<div class="lk-row"><button data-a="llmTest">测试连接</button> <span data-v="llmTest"></span></div>' +
      '<div class="lk-hint">规则层是拼写音译（<code>hello</code> 会读成 ヘッラオ、' +
      "<code>question</code> 读成 クワエサション），所以词典之外交给大模型更准。" +
      "Key <b>只存在本机 localStorage</b>，除了你填的这个接口地址之外不会发到别处，也永远不会进仓库。" +
      "留空则整层不工作，自动退回下面的免费接口。</div>" +
      "<h3>API 用量</h3>" +
      '<div class="lk-usage"></div>' +
      '<div class="lk-row"><label>输入单价 <input type="number" data-k="usagePriceIn" min="0" step="0.01" style="width:90px"> 元/百万 token</label></div>' +
      '<div class="lk-row"><label>输出单价 <input type="number" data-k="usagePriceOut" min="0" step="0.01" style="width:90px"> 元/百万 token</label></div>' +
      '<div class="lk-row">' +
      '<button data-a="usageReset" data-scope="session">清零本次</button> ' +
      '<button data-a="usageReset" data-scope="today">清零今天</button> ' +
      '<button data-a="usageReset" data-scope="all">清零累计</button>' +
      "</div>" +
      '<div class="lk-hint">只统计<b>发出去的请求</b>：命中缓存不算（省下来的量另外显示）。' +
      "token 数取自接口响应里的 <code>usage</code>；免费接口没有 token，用请求数与字符数衡量。" +
      "填了单价就会多算一行估算花费（单价按你接口的现价来，默认 0 = 不算钱）。</div>" +
      "<h3>操作</h3>" +
      '<div class="lk-row">' +
      '<button data-a="rescan">重新扫描</button> ' +
      '<button data-a="retry">重试未校正的词</button> ' +
      '<button data-a="clearCache">清除校正缓存</button>' +
      "</div>" +
      '<div class="lk-status"></div>';

    function fmt(key) {
      return config[key] + "%";
    }

    var preview = root.querySelector(".lk-preview");
    var status = root.querySelector(".lk-status");
    var layersBox = root.querySelector(".lk-layers");
    var usageBox = root.querySelector(".lk-usage");

    /** 每一层右边那句小字：让用户一眼看出这层现在能不能用 */
    function layerNote(id) {
      if (id === "dict") return "（" + (typeof LKDict !== "undefined" ? LKDict.count : "?") + " 条，纯离线）";
      if (id === "romaji") return "（歌词里的日式罗马字，纯离线）";
      if (id === "rule") return "（拼写音译，永远给得出结果）";
      if (id === "llm") return llmAvailable() ? "（已启用）" : "（未启用 / 没填 key）";
      if (id === "google") return googleAvailable() ? "（已开启）" : "（已关闭）";
      return "";
    }

    function refreshLayers() {
      if (!layersBox) return;
      layersBox.innerHTML = "";
      for (var i = 0; i < config.layerOrder.length; i++) {
        (function (index) {
          var id = config.layerOrder[index];
          var row = document.createElement("div");
          row.className = "lk-layer";

          var name = document.createElement("span");
          name.className = "lk-layer-name";
          name.textContent = (index + 1) + ". " + (LAYER_NAMES[id] || id);
          row.appendChild(name);

          var note = document.createElement("span");
          note.className = "lk-layer-note";
          note.textContent = layerNote(id);
          row.appendChild(note);

          row.appendChild(mkMoveBtn(index, id, -1, "↑"));
          row.appendChild(mkMoveBtn(index, id, 1, "↓"));
          layersBox.appendChild(row);
        })(i);
      }
      /*
       * 挡路提醒：「英文音译规则」对**每个词**都给得出答案（它就是拼写猜测），
       * 所以排在它下面的同步层永远轮不到 —— 很容易踩的坑：
       * 把词典拖到规则下面，`the` 就变成规则层的 セ 了（用户报过）。
       * 只提醒、不阻止：真要"只用规则"也是合法选择。
       */
      var ruleIdx = config.layerOrder.indexOf("rule");
      var blocked = [];
      for (var b = 0; b < config.layerOrder.length; b++) {
        var idb = config.layerOrder[b];
        if (b > ruleIdx && (idb === "dict" || idb === "romaji")) blocked.push(LAYER_NAMES[idb] || idb);
      }
      if (blocked.length) {
        var warnEl = document.createElement("div");
        warnEl.className = "lk-hint lk-layer-warn";
        warnEl.textContent =
          "⚠ " + blocked.join(" / ") + " 排在「英文音译规则」下面：规则对每个词都会给答案，" +
          "这两层就永远用不上了（比如 the 会变成规则猜的 セ）。要恢复的话点「恢复默认顺序」。";
        layersBox.appendChild(warnEl);
      }
    }

    function mkMoveBtn(index, id, delta, label) {
      var b = document.createElement("button");
      b.className = "lk-layer-btn";
      b.textContent = label;
      b.setAttribute("data-layer", id);
      b.setAttribute("data-dir", delta < 0 ? "up" : "down");
      b.disabled = delta < 0 ? index === 0 : index === config.layerOrder.length - 1;
      b.addEventListener("click", function () {
        moveLayer(id, delta);
      });
      return b;
    }

    /**
     * 上下调一层。改完顺序必须**重扫**：已经注过音的词可能要换一个来源，
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
    function refreshUsage() {
      if (!usageBox) return;
      usageBox.innerHTML = "";
      if (!state.usage) {
        usageBox.textContent = "用量统计不可用（core/usage.js 没注入）";
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
        line.className = "lk-usage-row";
        line.textContent = rows[i].label + "：" + usageLine(rows[i].bucket, priceIn, priceOut);
        usageBox.appendChild(line);
      }
      var saved = document.createElement("div");
      saved.className = "lk-hint";
      var llmStats = state.llm ? state.llm.stats() : null;
      var savedHits = (llmStats ? llmStats.cacheHits : 0) + (state.corrector ? state.corrector.stats().memoryHits : 0);
      saved.textContent =
        "缓存命中 " + savedHits + " 次（这些没发请求）" +
        (priceIn || priceOut ? "" : "；填了单价才会算花费");
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
        if (b.failures) seg += "（成功 " + b.ok + " / 失败 " + b.failures + "）";
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
    var USAGE_KINDS = typeof LKUsage !== "undefined" ? LKUsage.KINDS : ["llm", "google"];

    function refreshPreview() {
      preview.innerHTML = "";
      if (typeof LKMatcher === "undefined" || !state.reader) {
        preview.textContent = "核心模块未加载";
        return;
      }
      /*
       * 预览示例句用高考英语听力那句名句（「衬衫的价格为九磅十五便士」）。
       *
       * 两行是刻意的：第一行是原文，按真实逻辑注音；第二行是**中文翻译**。
       * 真机上翻译层是不标的（见 annotate.js：同一个 <li> 只取第一块、
       * class 里带 trans/translated 的整层跳过），预览也照这个来 ——
       * 免得给人「翻译也会被注音」的错预期。
       */
      var demo = "The shirt is nine pounds fifteen pence.";
      var demoTrans = "衬衫的价格为九磅十五便士";
      var frag = document.createDocumentFragment();
      var pos = 0;
      var tokens = LKMatcher.scan(demo);
      var got = 0;
      for (var i = 0; i < tokens.length; i++) {
        var tk = tokens[i];
        // 和 annotate.js 一样传**原始写法**：折过的形式会把连字符吃掉，
        // 记号（D/N/A）和普通词（x-ray）就分不出来了
        var r = LKMatcher.looksReadable(tk) ? state.reader.read(tk.text) : null;
        if (tk.start > pos) frag.appendChild(document.createTextNode(demo.slice(pos, tk.start)));
        if (r && r.kana) {
          var ruby = document.createElement("ruby");
          ruby.className = "lt-ruby";
          ruby.appendChild(document.createTextNode(tk.text));
          var rt = document.createElement("rt");
          rt.className = "lt-rt";
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
        trans.className = "lk-preview-trans";
        trans.textContent = demoTrans;
        preview.appendChild(trans);
      }
      if (!got) {
        var hint = document.createElement("div");
        hint.className = "lk-hint";
        hint.textContent = "没能给示例词算出读音（可在控制台调 LK.read('shirt') 查看）";
        preview.appendChild(hint);
      }
    }

    function refreshStatus() {
      if (!status) return;
      if (!DEV) return; // 状态区只在开发模式显示
      var lines = [];
      var c = state.corrector ? state.corrector.stats() : null;
      lines.push("BetterNCM: " + (state.betterncmVersion || "未知"));
      lines.push("读音词典: " + (typeof LKDict !== "undefined" ? LKDict.count : "未加载") + " 条");
      lines.push("已注音节点: " + (state.annotator ? state.annotator.injectedCount() : 0));
      if (state.annotator && state.annotator.churnedCount && state.annotator.churnedCount() > 0) {
        lines.push("已避让: " + state.annotator.churnedCount() + " 行（对方反复重建，见轨迹里的 churn）");
      }
      lines.push("上一轮: " + state.lastPassMs + "ms " + JSON.stringify(state.lastResult || {}));
      if (state.reader) lines.push("读音来源: " + JSON.stringify(state.reader.stats()));
      if (c) {
        lines.push("在线校正: 命中 " + c.onlineHits + " / 请求 " + c.requests + " / 失败 " + c.failures + (c.lastError ? "（" + c.lastError + "）" : ""));
        lines.push("待校正: " + (state.corrector ? state.corrector.pending() : 0) + "，缓存条目 " + c.cached);
      }
      if (state.llm) {
        var s = state.llm.stats();
        lines.push(
          "大模型: " + (s.hasKey ? (s.enabled ? "已启用" : "已停用") : "未填 key") +
            " 命中 " + s.hits + " / 缓存 " + s.cached + " / 待问 " + s.pending + " / 请求 " + s.requests +
            " / 失败 " + s.failures + (s.lastError ? "（" + s.lastError + "）" : "")
        );
      }
      if (state.error) lines.push("错误: " + state.error);
      if (state.usage) {
        var u = state.usage.snapshot();
        lines.push(
          "用量: 本次 大模型 " + u.session.llm.requests + " 次 / 免费接口 " + u.session.google.requests + " 次，" +
            "今天 大模型 " + u.today.llm.requests + " 次（输入 " + u.today.llm.promptTokens + " / 输出 " +
            u.today.llm.completionTokens + " tok）"
        );
      }
      status.textContent = lines.join("\n");
    }

    function refreshAll() {
      refreshLayers();
      refreshPreview();
      refreshUsage();
      refreshStatus();
    }

    if (!DEV && status) status.style.display = "none";

    var NEEDS_RESCAN = ["annotateAll", "scope", "customSelector"];
    var NEEDS_RESTYLE = ["rtSize", "rtOpacity", "focusDebug"];

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
          if (key === "llmEndpoint" && typeof LKLLM !== "undefined" && LKLLM.normalizeEndpoint) {
            var fixed = LKLLM.normalizeEndpoint(config.llmEndpoint);
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
          if (key === "llmKey" && typeof LKLLM !== "undefined" && LKLLM.normalizeKey) {
            var clean = LKLLM.normalizeKey(config.llmKey);
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
            var n = state.corrector ? state.corrector.retryMisses() : 0;
            b.textContent = "已重新排队 " + n + " 个";
            setTimeout(function () {
              b.textContent = "重试未校正的词";
            }, 1500);
          } else if (what === "clearCache") {
            if (state.corrector) state.corrector.clearCache();
            if (state.llm) state.llm.clearCache();
            rescan();
            b.textContent = "已清空";
            setTimeout(function () {
              b.textContent = "清除校正缓存";
            }, 1500);
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
      " 模块 matcher=" + typeof LKMatcher + " reading=" + typeof LKReading +
      " dict=" + typeof LKDict + " annotate=" + typeof LKAnnotate);

    if (typeof LKMatcher === "undefined" || typeof LKReading === "undefined" ||
        typeof LKAnnotate === "undefined" || typeof LKDict === "undefined") {
      warn("核心模块未注入，检查 manifest.json 的 injects 顺序");
      return;
    }

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
      if (typeof LKUsage !== "undefined") {
        state.usage = LKUsage.createUsage();
      }
      state.corrector = LKCorrect.createCorrector({
        online: config.online,
        // 纯片假名还不够：还要像这个词的音译（tick 不能被回成 カチカチ）
        validate: function (word, kana) {
          return typeof LKReading === "undefined" ? true : LKReading.looksLikeTransliteration(word, kana);
        },
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
           * 在线结果回来了 → **就地改写**已有注音，不要 restoreAll。
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
      state.reader = LKReading.createReader({
        dict: LKDict.words,
        // 英文常用词表：罗马音层靠它判断"这看着像英文词"，判出来就交给在线层仲裁
        enWords: typeof LKEnWords !== "undefined" ? LKEnWords.words : null,
        // 同步层按用户排的顺序（异步层由 readForDisplay 处理，见那里）
        order: syncLayerOrder(),
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
      });
      applyLayerOrder();
      // 大模型校正：没填 key 就整层不工作（lookup 一律返回 null），自动退回上面的 Google 路子
      if (typeof LKLLM !== "undefined") {
        state.llm = LKLLM.createClient({          enabled: config.llmEnabled !== false,
          endpoint: config.llmEndpoint,
          model: config.llmModel,
          key: config.llmKey,
          // 用量：token 数由接口响应里的 usage 给（没给就只记次数）
          onUsage: function (fields) {
            if (state.usage) state.usage.add("llm", fields);
          },
          // 同上：拦住"意译/拟声词"（用户报的 tick -> カチカチ）
          validate: function (word, kana) {
            return typeof LKReading === "undefined" ? true : LKReading.looksLikeTransliteration(word, kana);
          },
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
      state.annotator = LKAnnotate.createAnnotator({
        // 返回 { kana, source }：source 用来给"按来源着色"的排障功能打标
        lookup: function (word, line) {
          return resolveReading(word, line);
        },
        // 暂定读音（在线那层还在问）会在注音上打一个淡一点的标记
        pending: function (word, line) {
          return isProvisional(word, line);
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
     * 这里**必须链上去而不是覆盖**：片假名终结者可能已经挂了一个同名钩子，
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

    window.LatinKatakana = {
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
       * 读音来源顺序：LK.layers() 看当前顺序，LK.layers(['llm','dict',...]) 直接改。
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
       * API 用量：LK.usage() 看账本（本次/今天/累计，两层分开），
       * LK.usageReset('session'|'today'|'all') 清零。设置面板里那几个按钮走同一条路。
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
      display: function (word) {
        /*
         * **页面上实际用的**那个读音：按用户排的层序取（默认
         * 词典 -> 罗马音 -> 大模型 -> Google -> 规则）。
         * 判断"某个词到底是谁给的读音"就用它：和 LK.read() 比一下，
         * 不一样就说明被大模型（或联网）换过了。
         */
        return readForDisplay(word);
      },
      /*
       * 排障：按读音来源上色。LK.colorize(true) 开、LK.colorize(false) 关、
       * 不带参数就是看当前状态。只改 CSS（lt-src-* 类名一直挂在注音节点上），
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
        return typeof LKDict !== "undefined" ? LKDict.words : {};
      },
      stats: function () {
        return {
          layers: config.layerOrder.slice(), // 当前层序（LK.layers() 改的就是它）
          lastPass: state.lastResult || null, // 含 skips：这一轮"为什么有行没注音"
          reading: state.reader ? state.reader.stats() : null,
          correct: state.corrector ? state.corrector.stats() : null,
          llm: state.llm ? state.llm.stats() : null,
        };
      },
      /*
       * 「这一行/这几行为什么没注音」——一句话回答。
       *
       * 排障时最难受的就是"某行没注音"不留痕：现在每一轮扫描都会带上跳过原因
       * （文本在动 / 认输期 / 无译文 / 切不出词 / 不在区域里…），这里直接给结论。
       */
      why: function () {
        var r = state.lastResult;
        if (!r) return "还没扫过（插件没启用？）";
        var lines = [];
        lines.push(
          "上一轮：区域 " + r.scanned + "，注音 " + r.changed + "，还原 " + r.restored +
            "，跳过 " + r.skipped + "，放弃 " + (r.unstable || 0) + "，用时 " + state.lastPassMs + "ms"
        );
        if (r.retryInMs) lines.push("已安排 " + Math.round(r.retryInMs) + "ms 后再扫一轮（跳过是暂时的）");
        var skips = r.skips || [];
        if (skips.length) {
          // 同一种原因可能连着出现很多次（一个区域里有好几个节点），压成计数
          var seen = {};
          for (var i = 0; i < skips.length; i++) {
            var key = String(skips[i]).replace(/@\S+\s+".*$/, "").trim();
            seen[key] = (seen[key] || 0) + 1;
          }
          lines.push("跳过原因：");
          for (var k in seen) {
            if (Object.prototype.hasOwnProperty.call(seen, k)) lines.push("　× " + seen[k] + "　" + k);
          }
        } else if (!r.unstable) {
          lines.push("没有跳过 —— 还有行没注音的话，看那一行是不是不在标注区域里（LK.scan('那行的文本') 看分词）");
        }
        if (state.error) lines.push("错误：" + state.error);
        return lines.join("\n");
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
          if (s.cooldownMs > 0) lines.push("退避中：还要等 " + Math.round(s.cooldownMs / 1000) + " 秒");
          if (s.lastError) lines.push("最后一次错误：" + s.lastError);
          if (!s.enabled) lines.push("→ 设置面板里把「用大模型校正」打开");
          else if (!s.hasKey) lines.push("→ 设置面板里填 API Key，然后点「测试连接」");
          else if (s.failures > 0 && s.hits === 0) {
            lines.push("→ 请求都没成功，照上面的错误信息对号入座：");
            lines.push("　 401/403 = key 不对；402 = 余额用完；429 = 被限流；404 = 地址少了 /chat/completions；400 = 模型名不对");
            lines.push("　 没有状态码的那句（Failed to fetch 之类）= 网络不通，或被跨域拦住（服务商得允许 music.163.com 这个来源）");
          } else if (s.hits > 0) lines.push("→ 已经生效 ✓（想看某个词是谁给的：LK.display('词') 对比 LK.read('词')）");
          else if (s.requests > 0) lines.push("→ 请求发出去了但一个都没命中，看上面「模型没给 / 失败」的数字");
          else
            lines.push(
              "→ 还没问过任何词：说明到目前为止歌词里的拉丁词**全在离线词典里**（" +
                (typeof LKDict !== "undefined" ? LKDict.count : "?") +
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
        return LKMatcher.scan(text);
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
        return LKAnnotate.hasRubyLayout(document);
      },
      repairLine: function (lineEl) {
        return state.annotator && state.annotator.repairLine ? state.annotator.repairLine(lineEl) : false;
      },
    };

    /*
     * 短别名 `LK`：日志、README、排障文档里写的都是 LK.xxx，
     * 以前只挂了 window.LatinKatakana，照着敲会 "LK is not defined"。
     * 两个名字都留着（长名给不认识这个插件的人看，短名给控制台用）。
     */
    window.LK = window.LatinKatakana;

    log(
      "已加载" +
        (DEV ? "（开发模式）" : "") +
        "，控制台可用 LK.stats() 看统计、LK.llm.check() 看大模型有没有生效、" +
        "LK.display('light') 看某个词实际用的读音、LK.scan('light と clover') 看分词"
    );
    notifyConfigUI();
  });
})();
