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
  var CONFIG_VERSION = 1;
  var CONFIG_KEY = "latin-katakana.config";

  var DEFAULTS = {
    enabled: true,
    online: true, // 词典/规则都没把握时是否联网校正（Google 接口，不用填 key）
    // ---- 大模型校正（质量比规则高一个数量级，需要自己填 key）
    llmEnabled: true,
    llmEndpoint: "https://api.deepseek.com/chat/completions",
    llmModel: "deepseek-chat",
    llmKey: "",
    annotateAll: true, // 除歌词外，也标播放栏的歌名/歌手
    scope: "all", // titles | lyrics | all | custom
    customSelector: "",
    rtSize: 55, // 注音字号（相对底字百分比）
    rtOpacity: 80, // 注音不透明度
    focusDebug: false, // 给已注音区域描边，排障用
    verbose: false,
  };

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
   * 取一个词的显示读音。层序（越靠前越优先）：
   *
   *   1. 词典（人工核过的外来语写法）—— 不等请求，也不让联网结果覆盖；
   *   2. 罗马音（歌词本来就是罗马音的，切出来是确定的）；
   *   3. **大模型校正**：只对"规则猜出来的"词生效。命中缓存就立刻用，
   *      没命中就入队（lookup 返回 null），结果异步回来时通过 onUpdate 重扫换上；
   *   4. Google 校正：没配大模型 key 时才轮到它，且只对"没把握"的词；
   *   5. 规则结果。
   *
   * 为什么规则结果可以被大模型盖掉：规则是拼写音译，hello 会读成 ヘッラオ、
   * question 会读成 クワエサション —— 那不是人唱的音。词典之外没有更可靠的来源。
   */
  function readForDisplay(word) {
    if (!state.reader) return null;
    var r = state.reader.read(word);
    if (!r || !r.kana) return null;

    // 词典与罗马音的结果是确定的，不该被覆盖，也没必要发请求
    if (r.source === "rule") {
      if (state.llm) {
        var llm = state.llm.lookup(word);
        if (llm) return llm;
      }
      if (config.online && state.corrector && !r.confident) {
        var fixed = state.corrector.lookup(word);
        if (fixed) return fixed;
      }
    }
    return r.kana;
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
      "#latin-katakana-config .lk-status { white-space: pre-wrap; font-family: monospace; font-size: 12px; opacity: .8; }" +
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
      "<h3>范围</h3>" +
      '<div class="lk-row"><label>标注范围 <select data-k="scope">' +
      '<option value="all">歌词 + 播放栏（默认）</option>' +
      '<option value="lyrics">只标歌词</option>' +
      '<option value="titles">只标播放栏</option>' +
      '<option value="custom">自定义选择器</option>' +
      "</select></label></div>" +
      '<div class="lk-row"><label>自定义选择器 <input type="text" data-k="customSelector" placeholder="例如 ul.lyric > li"></label></div>' +
      '<div class="lk-hint">选择器留空或匹配不到元素时会自动回退。</div>' +
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

    function refreshPreview() {
      preview.innerHTML = "";
      if (typeof LKMatcher === "undefined" || !state.reader) {
        preview.textContent = "核心模块未加载";
        return;
      }
      // 用真实的扫描 + 读音逻辑做预览，保证预览和实际效果一致
      var demo = "きらめく light と clover、それから Sekai へ。";
      var frag = document.createDocumentFragment();
      var pos = 0;
      var tokens = LKMatcher.scan(demo);
      var got = 0;
      for (var i = 0; i < tokens.length; i++) {
        var tk = tokens[i];
        var r = LKMatcher.looksReadable(tk) ? state.reader.read(tk.norm) : null;
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
      if (!got) {
        var hint = document.createElement("div");
        hint.className = "lk-hint";
        hint.textContent = "没能给示例词算出读音（可在控制台调 LK.read('light') 查看）";
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
      status.textContent = lines.join("\n");
    }

    function refreshAll() {
      refreshPreview();
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
          else if (el.type === "range") config[key] = Number(el.value);
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
      state.corrector = LKCorrect.createCorrector({
        online: config.online,
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
        onStatus: function (msg) {
          log(msg);
          notifyConfigUI();
        },
        onUpdate: function () {
          // 校正回来了：把已有的注音撤掉重扫，新读音就能换上
          if (!config.enabled) return;
          if (state.annotator) state.annotator.restoreAll();
          schedule(0);
          notifyConfigUI();
        },
      });
      state.reader = LKReading.createReader({
        dict: LKDict.words,
        log: function () {
          if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
        },
      });
      // 大模型校正：没填 key 就整层不工作（lookup 一律返回 null），自动退回上面的 Google 路子
      if (typeof LKLLM !== "undefined") {
        state.llm = LKLLM.createClient({
          enabled: config.llmEnabled !== false,
          endpoint: config.llmEndpoint,
          model: config.llmModel,
          key: config.llmKey,
          log: function () {
            trace("llm", Array.prototype.join.call(arguments, " "));
            if (config.verbose) console.log.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
          },
          onStatus: function (msg) {
            log(msg);
            notifyConfigUI();
          },
          onUpdate: function () {
            // 大模型的结果回来了：撤掉已有注音重扫，新的读音就能换上
            if (!config.enabled) return;
            if (state.annotator) state.annotator.restoreAll();
            schedule(0);
            notifyConfigUI();
          },
        });
      }
      state.annotator = LKAnnotate.createAnnotator({
        lookup: function (word) {
          return readForDisplay(word);
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
        saveConfig();
        updateStyles();
        if (key === "enabled") config.enabled ? enable() : disable();
        else rescan();
        return config[key];
      },
      read: function (word) {
        return state.reader ? state.reader.read(word) : null;
      },
      dict: function () {
        return typeof LKDict !== "undefined" ? LKDict.words : {};
      },
      stats: function () {
        return {
          reading: state.reader ? state.reader.stats() : null,
          correct: state.corrector ? state.corrector.stats() : null,
          llm: state.llm ? state.llm.stats() : null,
        };
      },
      llm: {
        stats: function () {
          return state.llm ? state.llm.stats() : null;
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

    log(
      "已加载" +
        (DEV ? "（开发模式）" : "") +
        "，控制台可用 LK.stats() 看统计、LK.read('light') 查单个词、LK.scan('light と clover') 看分词"
    );
    notifyConfigUI();
  });
})();
