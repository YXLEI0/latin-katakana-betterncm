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
  var REQUEST_TIMEOUT_MS = 20000;
  var MAX_REQ_PER_MIN = 20; // 限流：再准也不该把页面拖垮
  var COOLDOWN_MS = 60000; // 失败后的退避起点
  var COOLDOWN_MAX_MS = 10 * 60 * 1000;
  var MAX_WORD_LEN = 24;

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

  function promptFor(words) {
    return (
      "你是日语歌词注音助手。下面这些拉丁字母词要唱进日语歌里，请给出日语里最自然的片假名读音。\n" +
      "要求：\n" +
      "1. 只写片假名（允许长音符 ー 和小写的 ャュョッ），不要汉字、不要平假名、不要英文、不要解释；\n" +
      "2. 用日语外来语的通行写法（love → ラブ、hello → ハロー、question → クエスチョン）；\n" +
      "3. 虚词按唱出来的音写（the → ザ、of → オブ、and → アンド）；\n" +
      "4. 严格输出一个 JSON 对象，键是原词（小写），值是片假名读音，不要多余字段。\n" +
      "词表：" +
      JSON.stringify(words)
    );
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
    else if (status === 429) hint = "（被限流了，等一会儿再试）";
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

  function createClient(options) {
    options = options || {};
    var log = options.log || function () {};
    var onStatus = options.onStatus || function () {};
    var onUpdate = options.onUpdate || function () {};

    var cfg = {
      enabled: options.enabled !== false,
      endpoint: normalizeEndpoint(options.endpoint),
      model: options.model || DEFAULT_MODEL,
      key: options.key || "",
      batchSize: options.batchSize || BATCH_SIZE,
    };

    var mem = new Map(); // word -> { k: kana } 表示命中，{ miss: true } 表示问过但没有
    var persisted = loadCache();
    var queue = []; // 待问的词（数组，保持入队顺序）
    var queued = new Set(); // 去重
    var inflight = false;
    var timer = null;
    var timerDelay = -1;
    var dirty = false;
    var cooldownMs = COOLDOWN_MS;
    var cooldownUntil = 0;
    var requestTimes = [];
    var lastError = null;
    var stats = { hits: 0, cacheHits: 0, misses: 0, requests: 0, failures: 0, words: 0 };

    for (var k in persisted) {
      if (Object.prototype.hasOwnProperty.call(persisted, k)) mem.set(k, persisted[k]);
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
          if (rec.miss === true) out[key] = { miss: true };
          else if (typeof rec.k === "string" && RE_KATAKANA.test(rec.k)) out[key] = { k: rec.k };
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
          entries.push([word, rec.miss === true ? { miss: true, t: now } : { k: rec.k, t: now }]);
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

    function canAsk() {
      if (!cfg.enabled) return false;
      if (!cfg.key || !cfg.endpoint) return false;
      if (Date.now() < cooldownUntil) return false;
      return true;
    }

    function schedule(delay) {
      if (inflight) return;
      if (!canAsk()) return;
      if (!queue.length) return;
      var d = typeof delay === "number" ? delay : FLUSH_DELAY_MS;
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

      var batch = queue.splice(0, cfg.batchSize);
      for (var i = 0; i < batch.length; i++) queued.delete(batch[i]);
      if (!batch.length) return Promise.resolve(null);

      inflight = true;
      requestTimes.push(Date.now());
      stats.requests++;
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
            max_tokens: 2000,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: promptFor(batch) }],
          }),
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (e) {
        clearTimeout(to);
        inflight = false;
        fail(batch, e);
        return Promise.resolve(null);
      }

      return Promise.resolve(p)
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
          if (!obj) throw new Error("响应里没有 JSON");
          applyBatch(batch, obj);
          return true;
        })
        .catch(function (err) {
          fail(batch, err);
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
      // 模型的键可能有大小写差异，统一折一遍
      var lower = {};
      for (var rawKey in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, rawKey)) {
          lower[String(rawKey).toLowerCase().replace(/[^a-z]/g, "")] = obj[rawKey];
        }
      }
      for (var i = 0; i < batch.length; i++) {
        var w = batch[i];
        var v = lower[w];
        var kana = typeof v === "string" ? v.replace(/\s+/g, "").trim() : "";
        if (kana && RE_KATAKANA.test(kana) && kana.length <= 14) {
          mem.set(w, { k: kana });
          stats.hits++;
          stats.words++;
          hits++;
        } else {
          // 模型明说给不出的，记成终态 miss；下一轮不会再发这个词
          mem.set(w, { miss: true });
          stats.misses++;
          missed++;
        }
      }
      dirty = true;
      // 失败退避要复位：能正常回来就说明接口是通的
      cooldownMs = COOLDOWN_MS;
      cooldownUntil = 0;
      log("大模型校正回来 " + batch.length + " 个词：命中 " + hits + "，没给 " + missed);
      if (hits > 0) onUpdate();
      onStatus("大模型：最近一批命中 " + hits + "/" + batch.length);
    }

    /** 一批词失败了：放回队列（不写缓存），按退避冷却，等会儿重试 */
    function fail(batch, err) {
      lastError = (err && err.message) || String(err);
      stats.failures++;
      cooldownUntil = Date.now() + cooldownMs;
      cooldownMs = Math.min(cooldownMs * 2, COOLDOWN_MAX_MS);
      for (var i = 0; i < batch.length; i++) {
        var w = batch[i];
        if (mem.has(w)) continue; // 已经有结论的不用重问
        if (!queued.has(w)) {
          queued.add(w);
          queue.push(w);
        }
      }
      log("大模型请求失败（" + lastError + "），" + Math.round(cooldownMs / 1000) + "s 后再试");
      onStatus("大模型请求失败：" + lastError);
      if (queue.length) schedule(cooldownMs);
    }

    // ------------------------------------------------------------ 对外

    /**
     * 查一个词的读音。
     *   - 缓存里有 -> 立刻返回片假名字符串
     *   - 没问过 -> 入队并返回 null（结果回来后会通过 onUpdate 通知上层重扫）
     *   - 已知模型给不出 / 这一层没开 -> 返回 null
     */
    function lookup(word) {
      var w = keyOf(word);
      if (!w) return null;
      var rec = mem.get(w);
      if (rec) {
        if (rec.miss === true) return null;
        stats.cacheHits++;
        return rec.k;
      }
      if (!canAsk()) return null;
      if (!queued.has(w)) {
        queued.add(w);
        queue.push(w);
      }
      schedule(queue.length >= cfg.batchSize ? 0 : FLUSH_DELAY_MS);
      return null;
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
              messages: [{ role: "user", content: promptFor(["clover"]) }],
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
          var kana = obj && typeof obj.clover === "string" ? obj.clover : "";
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
        if (next.key !== undefined) cfg.key = String(next.key || "");
        if (next.batchSize) cfg.batchSize = Math.max(1, Math.min(60, next.batchSize | 0));
        // 改配置等于用户手动动过了（多半是刚填好 key），把失败退避清掉，别让他等十分钟
        cooldownUntil = 0;
        cooldownMs = COOLDOWN_MS;
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
      cached: function () {
        return mem.size;
      },
      stats: function () {
        return {
          enabled: cfg.enabled,
          hasKey: !!cfg.key,
          endpoint: cfg.endpoint,
          model: cfg.model,
          cacheHits: stats.cacheHits,
          hits: stats.hits,
          misses: stats.misses,
          requests: stats.requests,
          failures: stats.failures,
          cached: mem.size,
          pending: queue.length,
          inflight: inflight,
          cooldownMs: Math.max(0, cooldownUntil - Date.now()),
          lastError: lastError,
        };
      },
    };
  }

  return {
    createClient: createClient,
    normalizeEndpoint: normalizeEndpoint,
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    DEFAULT_MODEL: DEFAULT_MODEL,
    RE_KATAKANA: RE_KATAKANA,
    CACHE_KEY: CACHE_KEY,
  };
});
