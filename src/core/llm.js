/*
 * latin-katakana —— 大模型校正层
 *
 * 存在意义：纯拼写规则永远读不对 hello / question / shining 这类词
 * （规则给 ヘッラオ / クワエサション，实际上没人这么唱）。实测大模型给的读音
 * 质量是碾压性的，所以规则层之后再加这一层：**规则先给一个即时结果，
 * 大模型的结果异步回来之后把它换掉**。
 *
 * 与 core/correct.js（Google 翻译接口）的分工：
 *   - 这一层要用户自己填 API key，但质量明显更好、能处理虚词（the -> ザ）与变形词；
 *   - 没填 key 就整层不工作，自动退回 correct.js 那条免费路子，功能不残缺。
 *   两层都只接受**纯片假名**的返回值 —— 唱歌要的是读音，不是翻译。
 *
 * 设计要点：
 *   1. lookup() 永远同步返回（可能是 null），绝不阻塞 DOM 注音；
 *   2. 未命中的词进队列，攒 FLUSH_DELAY_MS 或攒够 BATCH_SIZE 个再一次性问，
 *      一个词只问一次（命中与"模型也没给"都记进缓存，永久保存）；
 *   3. 请求失败不写缓存、按退避冷却重试，绝不因为网络问题把读音写坏；
 *   4. 全程 try/catch 兜住，任何异常都只是"这一层不工作"。
 *
 * 缓存落 localStorage（key 见 CACHE_KEY），条目上限 CACHE_MAX。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LKLLM = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var G = typeof globalThis !== "undefined" ? globalThis : {};

  var CACHE_KEY = "latin-katakana.llm.v1";
  var CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 半年
  var CACHE_MAX = 6000;
  var FLUSH_DELAY_MS = 400; // 攒批窗口
  var BATCH_SIZE = 30; // 一次问多少个词
  /*
   * 单个请求的超时。原来是 20 秒 —— 真机上报过「The user aborted a request.」
   * 就是被这个掐掉的（用户截图里的报错）。一批几十个词、每句都带整行语境，
   * 服务商忙的时候首字节就可能等十几秒，20 秒太紧；45 秒更稳，
   * 而且超时之后我们会**把批次减半再试**（见 send/fail 里的 batchCap）。
   */
  var REQUEST_TIMEOUT_MS = 45000;
  var MAX_REQ_PER_MIN = 20; // 限流：再准也不该把页面拖垮
  var COOLDOWN_MS = 60000; // 失败后的退避起点
  /*
   * 退避上限。原来写的是 10 分钟 —— 真机上太伤了：接口抖一下、或者一轮限流，
   * 就会进入"读数全都没矫正"的状态（本地读音还在，但一条都不再问模型），
   * 用户以为插件坏了，而且一等等十分钟。3 分钟够礼貌，也能自己恢复。
   */
  var COOLDOWN_MAX_MS = 3 * 60 * 1000;
  var MAX_WORD_LEN = 24;
  /** 上下文（整句歌词）最长留多少字符 —— 只是为了避免把整个歌词本塞进提示词 */
  var MAX_CONTEXT_LEN = 160;

  var DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";
  var DEFAULT_MODEL = "deepseek-chat";

  // 只认纯片假名（含长音符与小写 ャュョッ 那一带）
  var RE_KATAKANA = /^[\u30A1-\u30F6\u30FC]+$/;

  /**
   * 把用户填的接口地址折成**真正能 POST 的地址**。
   *
   * 为什么需要它：DeepSeek / OpenAI 的文档里给的是 `base_url`
   * （`https://api.deepseek.com` 或 `https://api.deepseek.com/v1`），
   * 顺手粘进设置面板就会 404 —— 实测（2026-09）：
   *
   *   200  https://api.deepseek.com/chat/completions
   *   200  https://api.deepseek.com/v1/chat/completions
   *   200  https://api.deepseek.com/chat/completions/     ← 结尾多一个斜杠也行
   *   404  https://api.deepseek.com/v1
   *   404  https://api.deepseek.com
   *
   * 所以这里按"少一段就补一段"的规则纠正，认不出来的路径原样返回
   * （让服务端自己报错，错误信息里会带上真实请求的地址）。
   */
  function normalizeEndpoint(raw) {
    var url = String(raw == null ? "" : raw).trim();
    // 有人会把引号、尖括号一起粘进来（从文档或终端复制的常见形态）
    url = url.replace(/^["'<]+/, "").replace(/["'>]+$/, "").trim();
    if (!url) return DEFAULT_ENDPOINT;
    url = url.replace(/\/+$/, ""); // /v1/ 与 /v1 等价
    if (/\/chat\/completions$/.test(url)) return url; // 已经是完整地址（含 /beta/ 这类前缀）
    if (/\/v\d+$/.test(url)) return url + "/chat/completions"; // 只给了 base_url（…/v1）
    if (/^https?:\/\/[^/]+$/.test(url)) return url + "/v1/chat/completions"; // 只给了主机名
    return url;
  }

  /**
   * 提示词：**带上下文**。
   *
   * 为什么要上下文：孤立地问一个词，有些词根本定不下来 ——
   * read 是 リード 还是 レッド、live 是 ライブ 还是 リブ、
   * 「Love」是歌里的词还是人名。把**它所在的那句歌词**一起给它，
   * 判断依据就完全不同了（这也是用户提的要求）。
   *
   * 条目按**下标**编号（`items` 是 [{i, w, line}]），响应也用下标当键：
   * 同一个词在两句里出现时不会互相覆盖。
   */
  function promptFor(items) {
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      rows.push({ i: items[i].i, w: items[i].w, line: items[i].line || items[i].w });
    }
    return (
      "你是日语歌词注音助手。下面是日语歌里出现的拉丁字母词，每一项带它所在的**整句歌词**" +
      "（line 字段，可能混着日文；如果 line 和词一样，说明只有这一个词）。\n" +
      "请结合整句的语境，给出这个词在日语里最自然的片假名读音。\n" +
      "要求：\n" +
      "1. 只写片假名（允许长音符 ー 和小写的 ャュョッ），不要汉字、不要平假名、不要英文、不要解释；\n" +
      "2. 用日语外来语的通行写法（love → ラブ、hello → ハロー、question → クエスチョン）；\n" +
      "3. 虚词按唱出来的音写（the → ザ、of → オブ、and → アンド）；\n" +
      "4. **同一个词在不同句子里读音不同时，按该句语境分别判断**" +
      "（read 在 “read a book” 里是 リード、在 “I read it yesterday” 里是 レッド）；\n" +
      "5. 人名/地名/乐队名按日语里的通行音译（Beatles → ビートルズ）；" +
      "字母串记号（D/N/A）按字母名念（ディーエヌエー）；\n" +
      "6. **这是音译不是翻译**：把原文的**发音**写成片假名，不要给日语词、不要给拟声词。" +
      "tick → ティック（不是「カチカチ」）、love → ラブ（不是「愛」）、" +
      "beat → ビート（不是「鼓動」）；\n" +
      "7. 词可能是**英语以外的拉丁字母语言**（法语最常见：le ル、je ジュ、monde モンド、" +
      "amour アムール、toujours トゥジュール、jamais ジャメ）—— 按**那门语言**的读音音译，" +
      "别按英语拼读；\n" +
      "8. 严格输出一个 JSON 对象，**键是 i 字段的值**（数字，写成字符串也行），值是片假名，不要多余字段。\n" +
      "条目：" +
      JSON.stringify(rows)
    );
  }

  /** 上下文规范化：折叠空白、去掉过长内容（只用来判"是不是同一句"和喂给模型） */
  function contextKey(line) {
    var s = String(line == null ? "" : line).replace(/\s+/g, " ").trim();
    if (s.length > MAX_CONTEXT_LEN) s = s.slice(0, MAX_CONTEXT_LEN);
    return s;
  }

  /** 取出响应里第一段 JSON 对象（模型偶尔会包一层 ```json 或加一句解释） */
  function pickJson(text) {
    if (typeof text !== "string") return null;
    var a = text.indexOf("{");
    var b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch (e) {
      return null;
    }
  }

  /** 尽力把响应体读成字符串（读不到就给空串，绝不 reject） */
  function readBody(res) {
    try {
      if (res && typeof res.text === "function") {
        return Promise.resolve(res.text()).catch(function () {
          return "";
        });
      }
    } catch (e) {
      /* ignore */
    }
    return Promise.resolve("");
  }

  /**
   * 把用户粘进来的 key 收拾干净。
   *
   * 真机上最常见的三种"全失败"就是这个（都不是服务端的问题）：
   *   1. 粘的时候把**引号**一起带进来了：`"sk-xxx"`；
   *   2. 前后有**空格/换行**（从网页上复制很容易带上）；
   *   3. 直接把整个请求头粘进来了：`Bearer sk-xxx`。
   * 这三种都会让 Authorization 头不合法 → 401，用户看到的就是"请求全失败"。
   */
  function normalizeKey(raw) {
    var k = typeof raw === "string" ? raw.trim() : "";
    // 引号和 Bearer 可能叠着来（"Bearer 'sk-x'"），所以循环剥几轮
    for (var i = 0; i < 3; i++) {
      var before = k;
      k = k.replace(/^Bearer\s+/i, "").trim();
      if (k.length > 1 && /^["']/.test(k) && /["']$/.test(k)) k = k.slice(1, -1).trim();
      if (k === before) break;
    }
    return k;
  }

  /**
   * 把"HTTP 4xx/5xx"变成**能照着修**的错误信息：地址 + 服务端原话。
   *
   * 为什么值得单独写一个：404 最常见的原因是地址少了 `/chat/completions`
   * （把 base_url 粘进来了），而服务端对这种情况往往回一个**空 body** ——
   * 只报 "HTTP 404" 的话，用户完全不知道该改哪儿。
   */
  function httpError(status, url, body) {
    var hint = "";
    if (status === 404) {
      hint = /\/chat\/completions$/.test(url)
        ? "（地址不对：服务端不认识这个路径）"
        : "（地址不对：接口地址一般以 /chat/completions 结尾，别只填 base_url）";
    } else if (status === 401 || status === 403) hint = "（Key 不对或没权限）";
    else if (status === 402) hint = "（余额/额度用完，去服务商那边充值或换 key）";
    else if (status === 429) hint = "（被限流了，等一会儿再试）";
    else if (status === 400) hint = "（请求被拒：多半是模型名不对，或者这家接口不认 response_format）";
    else if (status >= 500) hint = "（服务端出错，稍后再试）";
    var msg = "HTTP " + status + hint + " @ " + url;
    var s = String(body || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    if (s) msg += "　服务端说：" + s;
    var err = new Error(msg);
    err.status = status;
    err.url = url;
    return err;
  }

  /**
   * 连 HTTP 状态码都没有的失败（fetch 直接 reject）：几乎都是**网络/跨域**，
   * 而这句话本身（"Failed to fetch"）对用户毫无信息量，得翻译一下。
   */
  function networkHint(err) {
    var name = (err && err.name) || "";
    var text = ((err && err.message) || "") + " " + name;
    if (!/fetch|network|load failed|abort|timeout|ECONN|ENOTFOUND|CORS/i.test(text)) return "";
    if (/abort/i.test(text)) {
      return (
        "（我们自己的超时掐的：等了 " + Math.round(REQUEST_TIMEOUT_MS / 1000) +
        " 秒还没回来 —— 一般是批次太大或服务商在排队。插件会把批次减半自动重试，不用管它）"
      );
    }
    return (
      "（网络不通或被跨域拦住：这个接口地址要在网易云里能直接访问，" +
      "并且允许 https://music.163.com 这个来源；换成服务商的官方地址试试）"
    );
  }

  function createClient(options) {
    options = options || {};
    var log = options.log || function () {};
    var onStatus = options.onStatus || function () {};
    var onUpdate = options.onUpdate || function () {};
    /** 用量回调：每批请求成功/失败各叫一次，main.js 接过去记 token 与次数 */
    var onUsage = options.onUsage || function () {};
    /*
     * 答案校验：由上层注入（main.js 传 reading.js 的 looksLikeTransliteration）。
     * 光看"纯片假名"拦不住**意译/拟声词** —— 用户报的 tick -> カチカチ 就是这种，
     * 校验不过就按 miss 处理（记下来，别再问同一个词）。
     */
    var validate = typeof options.validate === "function" ? options.validate : null;
    /*
     * 「收下了一个模型答案」的回调：main.js 用它把答案沉淀成离线词条
     * （见 core/learn.js）。参数是 (词, 读音, 它所在的整句)。
     * 由上层决定收不收：词是不是"两可"、本地层是不是本来就对，这些只有上层知道。
     */
    var onAnswer = typeof options.onAnswer === "function" ? options.onAnswer : null;

    var cfg = {
      enabled: options.enabled !== false,
      endpoint: normalizeEndpoint(options.endpoint),
      model: options.model || DEFAULT_MODEL,
      key: normalizeKey(options.key),
      batchSize: options.batchSize || BATCH_SIZE,
    };
    // 粘进来的 key 被我们收拾过（去了引号/空格/Bearer）就记一笔，check() 里会说明
    var keyCleaned = typeof options.key === "string" && options.key !== cfg.key && !!cfg.key;

    var mem = new Map(); // key(词+语境) -> { k: kana } 命中，{ miss: true } 问过但没有
    /*
     * 词 -> 最近一次拿到的读音（不区分语境）。
     * 只给控制台/排障用（`LK.display('词')` 不带句子时要有东西可看），
     * **不参与**页面注音的判定 —— 页面必须严格按当前这句的语境取读音。
     */
    var byWord = {};
    var persisted = loadCache();
    var queue = []; // 待问的词（数组，保持入队顺序）
    var queued = new Set(); // 去重
    var inflight = false;
    var timer = null;
    var timerDelay = -1;
    var dirty = false;
    /*
     * 退避起点。正常用 COOLDOWN_MS（60s），测试里可以传个小值
     * （要看"退避结束后会不会自己重试"，等 60 秒不现实）。
     */
    var cooldownBase = typeof options.cooldownMs === "number" ? options.cooldownMs : COOLDOWN_MS;
    var cooldownMs = cooldownBase;
    var cooldownUntil = 0;
    /*
     * 自适应批次上限：0 = 用 cfg.batchSize。
     *
     * 为什么要它：请求超时（用户截图里的 "The user aborted a request."）几乎都是
     * "这批太大 / 服务商在排队"。超时之后把上限减半再试，成功的概率立刻高很多；
     * 一旦成功就恢复原大小。比单纯"退避 60 秒再原样重发同一大批"有效得多。
     */
    var batchCap = 0;
    function currentBatchSize() {
      if (batchCap > 0 && batchCap < cfg.batchSize) return batchCap;
      return cfg.batchSize;
    }
    function isTimeoutError(err) {
      var text = ((err && err.message) || "") + " " + ((err && err.name) || "");
      return /abort|timeout|timed out/i.test(text);
    }
    var requestTimes = [];
    var lastError = null;
    var stats = { hits: 0, cacheHits: 0, misses: 0, rejected: 0, requests: 0, failures: 0, words: 0, batchCap: 0 };
    /*
     * 连续失败了几批、期间一次都没成功过。用来判断"这层现在是彻底不工作"：
     * 用户看到的症状就是"读音全都没矫正"（本地读音照旧，模型一条都没改）。
     * 成功一批就清零。
     */
    var failedSinceHit = 0;
    /*
     * 最近被拒的答案（内存里留一小段，不落盘）。排障用：
     * 「某个词一直不矫正」时，这里能看到模型当时到底回了什么、被哪条判据丢的。
     */
    var REJECT_KEEP = 30;
    var rejects = [];
    function recordReject(word, said, why) {
      rejects.push({ word: word, said: said, why: why, at: Date.now() });
      if (rejects.length > REJECT_KEEP) rejects.shift();
    }

    for (var k in persisted) {
      if (!Object.prototype.hasOwnProperty.call(persisted, k)) continue;
      mem.set(k, persisted[k]);
      // 重建"词 -> 读音"索引：键是「词\0语境」，取 \0 前面那截
      if (persisted[k] && typeof persisted[k].k === "string") {
        byWord[k.split("\u0000")[0]] = persisted[k].k;
      }
      // 上次运行时被拒的答案也从缓存里恢复，重启后 LK.llm.rejects() 照样有东西看
      if (persisted[k] && persisted[k].miss === true && persisted[k].why) {
        recordReject(k.split("\u0000")[0], persisted[k].said || "", persisted[k].why);
      }
    }

    // ------------------------------------------------------------ 缓存

    function loadCache() {
      try {
        if (typeof localStorage === "undefined") return {};
        var raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return {};
        var obj = JSON.parse(raw);
        var now = Date.now();
        var out = {};
        for (var key in obj) {
          var rec = obj[key];
          if (!rec || typeof rec.t !== "number") continue;
          if (now - rec.t > CACHE_TTL_MS) continue;
          if (rec.miss === true) {
            out[key] = {
              miss: true,
              said: typeof rec.said === "string" ? rec.said : "",
              why: typeof rec.why === "string" ? rec.why : "",
              at: typeof rec.at === "number" ? rec.at : rec.t,
            };
          } else if (typeof rec.k === "string" && RE_KATAKANA.test(rec.k)) out[key] = { k: rec.k };
        }
        return out;
      } catch (e) {
        return {};
      }
    }

    var flushTimer = null;
    function saveCache(force) {
      if (!dirty) return;
      if (flushTimer && !force) return;
      if (flushTimer) clearTimeout(flushTimer);
      // 显式保存（force）要**同步**落盘：调用方（比如关闭页面、或者测试）期望
      // 返回时数据已经在 localStorage 里，不能又排一个 0ms 定时器敷衍过去。
      if (force) {
        flushTimer = null;
        writeCacheNow();
        return;
      }
      flushTimer = setTimeout(function () {
        flushTimer = null;
        writeCacheNow();
      }, 2000);
    }

    function writeCacheNow() {
      dirty = false;
      try {
        if (typeof localStorage === "undefined") return;
        var now = Date.now();
        var entries = [];
        mem.forEach(function (rec, word) {
          // miss 连"模型原话 / 拒绝原因"一起存：重启之后 LK.llm.rejects() 还能看出原因
          entries.push([
            word,
            rec.miss === true
              ? { miss: true, t: now, said: rec.said || "", why: rec.why || "" }
              : { k: rec.k, t: now },
          ]);
        });
        if (entries.length > CACHE_MAX) entries = entries.slice(entries.length - CACHE_MAX);
        var obj = {};
        for (var i = 0; i < entries.length; i++) obj[entries[i][0]] = entries[i][1];
        localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
      } catch (e) {
        log("大模型缓存写入失败（配额？）：" + (e && e.message));
      }
    }

    function clearCache() {
      mem.clear();
      dirty = true;
      saveCache(true);
      stats.cacheHits = 0;
      stats.hits = 0;
      stats.misses = 0;
    }

    // ------------------------------------------------------------ 队列

    function keyOf(word) {
      if (typeof word !== "string") return "";
      /*
       * 变音符号先折掉再当键：`Ō` / `Tōkyō` / `Café` 这种词不能因为字母带符号，
       * 就被下面那句 replace(/[^a-z]/g, "") 削成半个词
       * （`Tōkyō` 会变成 `tky`，缓存键也就对不上了）。
       * 优先用 NFD 分解再删组合用记号；引擎不支持时退回"把带符号的字母整段删掉"
       * （宁可少问一个词，也不要拿半个词去问）。
       */
      var raw = word.toLowerCase();
      try {
        if (typeof raw.normalize === "function") {
          raw = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        }
      } catch (e) {
        /* 引擎不支持就往下走兜底 */
      }
      var w = raw.replace(/[\u00C0-\u024F\u1E00-\u1EFF]/g, "").replace(/[^a-z]/g, "");
      if (!w || w.length > MAX_WORD_LEN) return "";
      return w;
    }

    /**
     * 缓存/队列的键：**词 + 它所在的那句话**。
     *
     * 为什么带上语境：`read` 在 “read a book” 里是 リード、在 “I read it” 里是 レッド；
     * 只按词缓存的话，先遇到哪句就把哪个读音钉死一辈子。
     * 带上整句之后，同一句里的同一个词仍然只问一次（每轮扫描都会命中缓存），
     * 换一句才会再问一次 —— 请求量还是很小的（一首歌的词典外词本来就不多）。
     */
    function cacheKeyOf(word, line) {
      var w = keyOf(word);
      if (!w) return "";
      return w + "\u0000" + contextKey(line);
    }

    function canAsk() {
      if (!cfg.enabled) return false;
      if (!cfg.key || !cfg.endpoint) return false;
      if (Date.now() < cooldownUntil) return false;
      return true;
    }

    function schedule(delay) {
      if (inflight) return; // 正在请求：它回来之后自己会接着排（见 send 的收尾）
      if (!queue.length) return;
      var d = typeof delay === "number" ? delay : FLUSH_DELAY_MS;
      /*
       * 在退避里**不能直接 return**（老版本就是 `if (!canAsk()) return;`）：
       * 退避期间 canAsk() 为 false，于是那次 schedule 什么都不做 ——
       * 而退避结束时**没有任何事件**会再来叫我们（页面不动就没有新的 lookup），
       * 队列就这么一直躺着：用户看到的是「读音全都没矫正」，
       * 面板上写着「队列里还有 184 个词在等，本分钟还剩 20 次额度」（额度满的、
       * 却没有请求在飞）—— 这正是用户截图里的样子。
       * 所以要**排到退避结束的那一刻**去重试。
       */
      if (!canAsk()) {
        // 这层根本没开（没 enabled / 没 key / 没地址）：排了也没用，别空转
        if (!cfg.enabled || !cfg.key || !cfg.endpoint) return;
        d = Math.max(d, cooldownUntil - Date.now() + 50);
      }
      if (timer) {
        // 已经排着一个更短的就别动它；排着更长的（攒批窗口）而现在攒够一批了，
        // 就立刻改期 —— 否则攒够 BATCH_SIZE 也得干等满 400ms 才发。
        if (d >= timerDelay) return;
        clearTimeout(timer);
        timer = null;
      }
      timerDelay = d;
      timer = setTimeout(function () {
        timer = null;
        timerDelay = -1;
        send();
      }, d);
    }

    function roomThisMinute() {
      var now = Date.now();
      var keep = [];
      for (var i = 0; i < requestTimes.length; i++) {
        if (now - requestTimes[i] < 60000) keep.push(requestTimes[i]);
      }
      requestTimes = keep;
      return MAX_REQ_PER_MIN - requestTimes.length;
    }

    /** 缓存里有多少条是"问过但没收下"的（这些词不会再自动重问） */
    function countMisses() {
      var n = 0;
      mem.forEach(function (rec) {
        if (rec && rec.miss === true) n++;
      });
      return n;
    }

    /**
     * 取一批词发出去。返回 Promise（测试与"手动刷新"都可以等它）。
     * 任何路径都不会 reject。
     */
    function send() {
      if (inflight) return Promise.resolve(null);
      if (!canAsk() || !queue.length) return Promise.resolve(null);
      if (roomThisMinute() <= 0) {
        // 这一分钟额度用完了，排到下一分钟再问
        schedule(60000 - (Date.now() - requestTimes[requestTimes.length - 1]) + 50);
        return Promise.resolve(null);
      }

      var batch = queue.splice(0, currentBatchSize());
      for (var i = 0; i < batch.length; i++) queued.delete(batch[i].key);
      if (!batch.length) return Promise.resolve(null);

      // 提示词里的条目：下标 i 用来对齐响应（同一个词在两句里不会互相覆盖）
      var items = [];
      for (var j = 0; j < batch.length; j++) {
        items.push({ i: j + 1, w: batch[j].word, line: batch[j].context });
      }

      inflight = true;
      requestTimes.push(Date.now());
      stats.requests++;
      /*
       * 用量统计：这一批送出去的词数与字符数（token 数要等响应里的 usage）。
       * gotResponse 表示"请求真的发出去并拿到了响应" —— 拿不到就别记成用量
       * （fetch 抛异常 = 请求根本没发出去）。
       */
      var usageWords = batch.length;
      var usageChars = 0;
      for (var uw = 0; uw < batch.length; uw++) usageChars += (batch[uw].word || "").length;
      var gotResponse = false;
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var to = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, REQUEST_TIMEOUT_MS);

      var p;
      try {
        p = fetch(cfg.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + cfg.key,
          },
          body: JSON.stringify({
            model: cfg.model,
            temperature: 0,
            max_tokens: 4000,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: promptFor(items) }],
          }),
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (e) {
        clearTimeout(to);
        inflight = false;
        fail(batch, e, { words: usageWords, chars: usageChars, sent: false });
        return Promise.resolve(null);
      }

      return Promise.resolve(p)
        .then(function (res) {
          gotResponse = true; // 请求发出去了（哪怕回的是 4xx/5xx，也算一次用量）
          if (res && res.ok) return res.json();
          return readBody(res).then(function (body) {
            throw httpError(res && res.status, cfg.endpoint, body);
          });
        })
        .then(function (data) {
          var content =
            data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          var obj = pickJson(content);
          if (!obj) throw new Error("响应里没有 JSON");
          // 记 token：接口给了 usage 就用它，没给就只记次数
          var u = data && data.usage;
          onUsage({
            requests: 1,
            ok: 1,
            words: usageWords,
            chars: usageChars,
            promptTokens: u && typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
            completionTokens: u && typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          });
          applyBatch(batch, obj);
          return true;
        })
        .catch(function (err) {
          fail(batch, err, { words: usageWords, chars: usageChars, sent: gotResponse });
          return false;
        })
        .then(function (okFlag) {
          clearTimeout(to);
          inflight = false;
          saveCache(false);
          if (queue.length) schedule(okFlag ? FLUSH_DELAY_MS : 0);
          return okFlag;
        });
    }

    /** 一批词回来了：合法的记命中，模型没给/给错的记 miss（不再问第二次） */
    function applyBatch(batch, obj) {
      var hits = 0;
      var missed = 0;
      /*
       * 响应可能有两种形状，都认：
       *   1. 按条目下标：{"1":"リード","2":"レッド"}（提示词要求的，能区分同词不同句）；
       *   2. 按词：{"read":"リード"}（模型没照做时的兜底）。
       */
      var byIndex = {};
      // 注意名字：**不能**叫 byWord —— 外层那个 byWord 是"词 -> 最近读音"的索引，
      // 同名局部变量会把它遮住，peek() 就永远读到空（这个坑真踩过）
      var byWordKey = {};
      for (var rawKey in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, rawKey)) continue;
        var v = obj[rawKey];
        var k = String(rawKey).trim();
        if (/^\d+$/.test(k)) byIndex[k] = v;
        else byWordKey[k.toLowerCase().replace(/[^a-z]/g, "")] = v;
      }
      for (var i = 0; i < batch.length; i++) {
        var item = batch[i];
        var v2 = byIndex[String(i + 1)];
        if (v2 === undefined) v2 = byWordKey[item.word];
        var said = typeof v2 === "string" ? v2.replace(/\s+/g, "").trim() : "";
        /*
         * 判这个答案收不收，并且**把拒绝原因和模型原话一起记下来**。
         *
         * 为什么必须记：以前这里只写 `{miss:true}`，于是用户反馈
         * 「有些词大模型一直不矫正」时，我这边一点线索都没有 —— 不知道模型说了什么、
         * 也不知道是被哪个判据丢的，只能猜。现在 LK.llm.rejects() 直接列出
         * 「哪个词 / 模型原话 / 为什么被拒」。
         */
        var why = null;
        if (!said) why = "模型没给";
        else if (!RE_KATAKANA.test(said)) why = "不是纯片假名";
        else if (said.length > 14) why = "太长了（>14）";
        else if (validate && !validate(item.word, said)) why = "没通过首音校验";
        if (!why) {
          mem.set(item.key, { k: said });
          byWord[item.word] = said; // 外层索引：给 peek()/控制台用
          stats.hits++;
          stats.words++;
          hits++;
          /*
           * 通知上层"这个答案收下了"（它可能把它沉淀成离线词条）。
           * 回调是上层的东西，抛错不能影响这一层 —— 包起来。
           */
          if (onAnswer) {
            try {
              onAnswer(item.word, said, item.context);
            } catch (e) {
              /* 学词失败不影响注音 */
            }
          }
        } else {
          /*
           * 记成"问过、没结果"：这一句里的这个词下一轮不会再发。
           *
           * 注意它是**永久**的（会落 localStorage）—— 模型当时给的答案被我们判掉了，
           * 那个词就一直用本地读音，用户看到的就是「有些词一直不矫正」。
           * 所以除了记原因，还提供 retryMisses()（设置面板「重试没结果的词」）
           * 把这类条目清掉重问。
           */
          mem.set(item.key, { miss: true, said: said, why: why, at: Date.now() });
          stats.misses++;
          if (why === "没通过首音校验") stats.rejected++;
          recordReject(item.word, said, why);
          missed++;
        }
      }
      dirty = true;
      // 失败退避要复位：能正常回来就说明接口是通的
      cooldownMs = cooldownBase;
      cooldownUntil = 0;
      failedSinceHit = 0;
      // 这一批成了 -> 自适应上限也恢复（之前可能因为超时被减半过）
      if (batchCap) {
        batchCap = 0;
        stats.batchCap = 0;
      }
      log("大模型校正回来 " + batch.length + " 个词：命中 " + hits + "，没给 " + missed);
      /*
       * **不管有没有命中都要通知上层重扫**。
       *
       * 以前写的是 `if (hits > 0) onUpdate()` —— 一批全是"给不出"时没人重扫，
       * 而层序是「在线优先、规则垫底」：这些词在等待期间是**先不标**的，
       * 没人重扫就等于一直空着（真机轨迹里 serendipity 空了 2.3 秒才补上）。
       * miss 也是状态变化（isWaiting 从 true 变 false），规则层就该接手了。
       */
      onUpdate();
      onStatus("大模型：最近一批命中 " + hits + "/" + batch.length);
    }

    /**
     * 一批词失败了：放回队列（不写缓存），按退避冷却，等会儿重试。
     * @param {Object} [usage] { words, chars, sent } —— sent=false 表示请求没发出去，
     *                        那次不算 API 用量（只记一次失败）
     */
    function fail(batch, err, usage) {
      // 有状态码的失败（httpError 已经写清了地址和该改哪儿）原样留着；
      // 连状态码都没有的（fetch 直接 reject）补一句人话，否则用户只看到 "Failed to fetch"
      var raw = (err && err.message) || String(err);
      var hint = err && err.status ? "" : networkHint(err);
      lastError = hint ? raw + " " + hint : raw;
      stats.failures++;
      /*
       * 超时（"The user aborted a request."）多半是这批太大 / 服务商在排队：
       * 把自适应批次减半，下一轮用更小的批去试，成功之后自动恢复。
       * 只减不加，所以不会来回震荡。
       */
      if (isTimeoutError(err)) {
        // 按**这一批实际的大小**减半（而不是配置里的上限）：这次发出去多少，
        // 下次就砍一半，最贴近"这批太大了"的实际原因；下限 5 个。
        var base = batch.length || (batchCap > 0 ? batchCap : cfg.batchSize);
        batchCap = Math.max(5, Math.floor(base / 2));
        stats.batchCap = batchCap;
        lastError += "（这批 " + batch.length + " 个词，下次改成 " + batchCap + " 个再试）";
      }
      var u = usage || { words: batch.length, chars: 0, sent: true };
      onUsage({
        requests: u.sent ? 1 : 0,
        failures: 1,
        words: u.sent ? u.words || 0 : 0,
        chars: u.sent ? u.chars || 0 : 0,
      });
      cooldownUntil = Date.now() + cooldownMs;
      cooldownMs = Math.min(cooldownMs * 2, COOLDOWN_MAX_MS);
      failedSinceHit++;
      for (var i = 0; i < batch.length; i++) {
        var item = batch[i];
        if (mem.has(item.key)) continue; // 已经有结论的不用重问
        if (!queued.has(item.key)) {
          queued.add(item.key);
          queue.push(item);
        }
      }
      log("大模型请求失败（" + lastError + "），" + Math.round(cooldownMs / 1000) + "s 后再试");
      onStatus("大模型请求失败：" + lastError);
      /*
       * **失败也必须叫一次 onUpdate**（和 correct.js 那边同一个道理，那边一直有）。
       *
       * 不叫会怎样（用户报的「这句不透明度怎么这么低」）：请求还在飞的时候那一轮
       * 是**暂定**（`lt-pending`，淡到 45%），失败后进入退避、isWaiting 变成 false，
       * 但没人通知注音层重新判定 —— 那行就一直淡着，直到页面因为别的原因重扫
       * （实测能淡整整一个退避周期，60 秒起）。真机歌词一行行滚动时不容易看出来，
       * 停在某一句上就很显眼。
       */
      onUpdate();
      if (queue.length) schedule(cooldownMs);
    }

    // ------------------------------------------------------------ 对外

    /**
     * 查一个词的读音。
     *   - 缓存里有 -> 立刻返回片假名字符串
     *   - 没问过 -> 入队并返回 null（结果回来后会通过 onUpdate 通知上层重扫）
     *   - 已知模型给不出 / 这一层没开 -> 返回 null
     *
     * @param {string} word  要注音的词（原样，可以带大小写/变音符号）
     * @param {string} [line] 它所在的整句歌词 —— **语境**，用来消歧
     *                        （read リード/レッド、人名地名、D/N/A 这类记号）。
     *                        不传就退化成"只看这个词"，行为与以前一致。
     */
    function lookup(word, line) {
      var key = cacheKeyOf(word, line);
      if (!key) return null;
      var rec = mem.get(key);
      if (rec) {
        if (rec.miss === true) return null;
        stats.cacheHits++;
        return rec.k;
      }
      if (!canAsk()) return null;
      if (!queued.has(key)) {
        queued.add(key);
        queue.push({ key: key, word: keyOf(word), context: contextKey(line) });
      }
      schedule(queue.length >= cfg.batchSize ? 0 : FLUSH_DELAY_MS);
      return null;
    }

    /**
     * 这个词现在是不是"还在等结果"？
     *
     * 上层靠它决定要不要先拿**英文音译规则**的结果顶上：
     * 用户要的顺序是「大模型 -> 免费接口 -> 规则」，所以等待期间**先不标**，
     * 等准确读音回来再补 —— 但这一层挂了/没配/在退避时，必须立刻放行让规则兜底，
     * 否则断网就等于一个字都不标。
     */
    function isWaiting(word, line) {
      if (!canAsk()) return false; // 没开 / 没配 key / 正在退避 -> 不等
      var key = cacheKeyOf(word, line);
      if (!key) return false;
      return !mem.has(key); // 已经有结论（命中或"给不出"）就不用等
    }

    /**
     * 只按词取"最近一次拿到的读音"，**不看语境**。
     *
     * 给控制台排障用（`LK.display('kaleidoscope')` 不带句子时总得有东西看），
     * 也用于"这个词我到底问过没有"的判断。页面注音不要用它 ——
     * 页面必须走 lookup(word, line)，否则会把上一句的读音套到这一句上。
     */
    function peek(word) {
      var w = keyOf(word);
      if (!w) return null;
      var k = byWord[w];
      return typeof k === "string" ? k : null;
    }

    /** 立刻把队列里的词发出去（不等攒批窗口） */
    function flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        timerDelay = -1;
      }
      return send();
    }

    /**
     * 自检：填完 key 之后点一下就知道通不通。
     * 只问一个词，返回 { ok, message }，绝不抛。
     */
    function test() {
      if (!cfg.key) return Promise.resolve({ ok: false, message: "还没填 API Key" });
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var to = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, REQUEST_TIMEOUT_MS);
      return Promise.resolve()
        .then(function () {
          return fetch(cfg.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
            body: JSON.stringify({
              model: cfg.model,
              temperature: 0,
              max_tokens: 100,
              response_format: { type: "json_object" },
              messages: [
                { role: "user", content: promptFor([{ i: 1, w: "clover", line: "きらめく clover の歌" }]) },
              ],
            }),
            signal: ctrl ? ctrl.signal : undefined,
          });
        })
        .then(function (res) {
          if (res && res.ok) return res.json();
          return readBody(res).then(function (body) {
            throw httpError(res && res.status, cfg.endpoint, body);
          });
        })
        .then(function (data) {
          var content =
            data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          var obj = pickJson(content);
          // 响应按条目下标（现在）或词（老形状）都可能
          var kana = obj ? (typeof obj["1"] === "string" ? obj["1"] : obj.clover) : "";
          kana = typeof kana === "string" ? kana.replace(/\s+/g, "").trim() : "";
          if (!kana) return { ok: false, message: "接口通了，但没解析出读音：" + String(content).slice(0, 80) };
          if (!RE_KATAKANA.test(kana)) return { ok: false, message: "接口通了，但返回的不是纯片假名：" + kana };
          return { ok: true, message: "接口正常（" + cfg.endpoint + "，clover -> " + kana + "）" };
        })
        .catch(function (e) {
          return { ok: false, message: "请求失败：" + ((e && e.message) || String(e)) };
        })
        .then(function (r) {
          clearTimeout(to);
          return r;
        });
    }

    return {
      lookup: lookup,
      peek: peek,
      /**
       * 导出缓存里"问出来过"的词 —— 给「把常用词沉淀进离线词典」用。
       *
       * 缓存是按「词 + 语境」存的，这里按**词**归并：同一个词在几个不同句子里
       * 得到过答案、答案是不是一致，都报出来（构建期的筛选脚本靠这些字段决定收不收）。
       * 只导出命中（miss 不导）。
       *
       * @returns {Array} [{ word, kana, lines, consistent }]
       */
      exportWords: function () {
        var grouped = {};
        mem.forEach(function (v, k) {
          if (!v || v.miss === true || typeof v.k !== "string" || !v.k) return;
          var at = String(k).indexOf("\u0000"); // 键是 word + \u0000 + 语境
          var word = at >= 0 ? String(k).slice(0, at) : String(k);
          var rec = grouped[word];
          if (!rec) rec = grouped[word] = { word: word, kana: v.k, lines: 0, consistent: true };
          rec.lines++;
          if (rec.kana !== v.k) rec.consistent = false;
        });
        var out = [];
        for (var w in grouped) {
          if (Object.prototype.hasOwnProperty.call(grouped, w)) out.push(grouped[w]);
        }
        return out;
      },
      isWaiting: isWaiting,
      flush: flush,
      test: test,
      clearCache: clearCache,
      saveCache: function () {
        saveCache(true);
      },
      configure: function (next) {
        next = next || {};
        if (next.enabled !== undefined) cfg.enabled = !!next.enabled;
        if (next.endpoint !== undefined) cfg.endpoint = normalizeEndpoint(next.endpoint);
        if (next.model) cfg.model = String(next.model);
        if (next.key !== undefined) {
          var before = String(next.key || "");
          cfg.key = normalizeKey(before);
          if (before !== cfg.key && cfg.key) keyCleaned = true;
        }
        if (next.batchSize) cfg.batchSize = Math.max(1, Math.min(60, next.batchSize | 0));
        // 改配置等于用户手动动过了（多半是刚填好 key），把失败退避清掉，别让他等十分钟
        cooldownUntil = 0;
        cooldownMs = cooldownBase;
        if (!canAsk() && queue.length) {
          queue = [];
          queued.clear();
        }
        if (canAsk() && queue.length) schedule(FLUSH_DELAY_MS);
      },
      config: function () {
        return { enabled: cfg.enabled, endpoint: cfg.endpoint, model: cfg.model, hasKey: !!cfg.key, batchSize: cfg.batchSize };
      },
      pending: function () {
        return queue.length;
      },
      /*
       * 「重试没结果的词」：把缓存里那些 miss（问过但没收下）清掉，让它们再问一次。
       *
       * 什么时候必须点它：模型当时的答案被**我们**判掉了（首音校验误伤、模型抽风、
       * 响应格式不对……），那份 miss 是永久的、还落了盘 —— 不清掉的话那个词会一直
       * 用本地读音，用户看到的就是「有些词大模型一直不矫正」。
       * 修完判据（比如 the -> ザ 那次）之后也要点一下，否则旧结论还在缓存里。
       *
       * @returns {number} 清掉了几条
       */
      retryMisses: function () {
        var removed = 0;
        var keys = [];
        mem.forEach(function (rec, key) {
          if (rec && rec.miss === true) keys.push(key);
        });
        for (var i = 0; i < keys.length; i++) {
          mem.delete(keys[i]);
          removed++;
        }
        rejects = [];
        if (removed) {
          dirty = true;
          saveCache(true);
          if (canAsk() && queue.length) schedule(FLUSH_DELAY_MS);
        }
        return removed;
      },
      /**
       * 立刻重试：把失败退避清掉，队列马上发一次。
       *
       * 什么时候用：接口抖了一下（或撞了一次限流）进了退避，用户看到的就是
       * **"读音全都没矫正"** —— 本地读音还在，但一条都不再问模型，而且一等等几分钟。
       * 这个按钮/调用就是手动把那根管子接回去；顺带把连续失败的计数也清了。
       */
      retryNow: function () {
        cooldownUntil = 0;
        cooldownMs = cooldownBase;
        failedSinceHit = 0;
        if (canAsk() && queue.length) schedule(0);
        return { pending: queue.length, inflight: inflight };
      },
      /** 最近被拒的答案（模型原话 + 原因），排障用 */
      rejects: function (limit) {
        var n = typeof limit === "number" ? limit : rejects.length;
        return rejects.slice(Math.max(0, rejects.length - n));
      },
      cached: function () {
        return mem.size;
      },
      stats: function () {
        return {
          enabled: cfg.enabled,
          hasKey: !!cfg.key,
          keyLength: cfg.key.length,
          keyShape: !cfg.key ? "none" : /^sk-/.test(cfg.key) ? "sk-" : "other",
          keyCleaned: keyCleaned,
          endpoint: cfg.endpoint,
          model: cfg.model,
          cacheHits: stats.cacheHits,
          hits: stats.hits,
          misses: stats.misses,
          rejected: stats.rejected, // 其中"没通过首音校验"被判掉的有几个
          rejects: rejects.slice(0, 5),
          requests: stats.requests,
          failures: stats.failures,
          cached: mem.size,
          missesCached: countMisses(),
          pending: queue.length,
          roomThisMinute: roomThisMinute(),
          batchCap: batchCap, // 超时之后的"临时小批"上限（0 = 正常大小）
          failedSinceHit: failedSinceHit,
          stalled: failedSinceHit >= 2 && queue.length > 0,
          inflight: inflight,
          cooldownMs: Math.max(0, cooldownUntil - Date.now()),
          cooldownMaxMs: COOLDOWN_MAX_MS,
          lastError: lastError,
        };
      },
    };
  }

  return {
    createClient: createClient,
    normalizeEndpoint: normalizeEndpoint,
    normalizeKey: normalizeKey,
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    DEFAULT_MODEL: DEFAULT_MODEL,
    RE_KATAKANA: RE_KATAKANA,
    CACHE_KEY: CACHE_KEY,
  };
});
