/*
 * western-katakana —— 翻译层
 *
 * 三级来源，按顺序：
 *   1. 会话缓存（内存 Map）—— 命中就同步返回，零延迟；
 *   2. 离线词典（core/dict.js）—— 断网也能标，同步返回；
 *   3. 在线校正（Google 的 dict-chrome-ex 接口）—— 批量、去重、按需排队。
 *
 * 为什么第 2 步在在线之前：原版 Katakana Terminator 完全依赖在线接口，
 * 接口一挂插件就废了（参考 jp-furigana 的在线 API 失效记录）。这里把
 * 词典放在在线前面，保证「离线可用、在线更准」：词典里没有的词才发请求。
 *
 * 在线部分是非阻塞的：lookup() 永远立刻返回（可能返回 null）。
 * 未命中的词进队列，攒一小会儿再批量请求，拿到结果后通过 onUpdate 通知
 * 调用方重扫，所以「先不标 -> 稍后补上」是预期行为。
 *
 * 缓存落 localStorage，带 TTL 和条数上限。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKCorrect = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 不能直接用上面 UMD 壳里的 root：仓库里 require 这份文件时，factory 是在
  // 模块作用域里跑的，那里没有 root。统一用 globalThis。
  var G = typeof globalThis !== "undefined" ? globalThis : {};


  var CACHE_KEY = "western-katakana.cache.v1";
  var CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
  var CACHE_MAX = 4000;
  var FLUSH_DELAY_MS = 1200; // 攒批窗口
  var BATCH_SIZE = 50;
  var REQUEST_TIMEOUT_MS = 12000;

  /*
   * 依次尝试的接口。全部是 Google 翻译的前端接口，换 host / 换响应形状而已：
   *
   *   a) dict-chrome-ex  -> /translate_a/t        返回 ["行1\n行2\n..."]，最好解析
   *   b) gtx（single）   -> /translate_a/single   返回 [[["译文","原文",...],...]]，需拼句
   *
   * 为什么要两个形状：某些网络环境下 translate.google.cn 被 hosts 改写或者被限流，
   * 换 host、换接口经常能绕过；gtx 那条路径在部分节点上比 dict-chrome-ex 更稳。
   * 实测（2026-02）：translate.google.cn 的 dict-chrome-ex 最快，所以排第一。
   */
  var ENDPOINTS = [
    { label: "google.cn/dict", host: "translate.google.cn", kind: "dict" },
    { label: "google.com/dict", host: "translate.google.com", kind: "dict" },
    { label: "googleapis/gtx", host: "translate.googleapis.com", kind: "gtx" },
    { label: "google.cn/gtx", host: "translate.google.cn", kind: "gtx" },
  ];

  function createCorrector(options) {
    options = options || {};
    var onUpdate = options.onUpdate || function () {};
    var onStatus = options.onStatus || function () {};
    /** 用量回调：每批请求成功/失败各叫一次（免费接口没有 token，用请求数 + 字符数衡量） */
    var onUsage = options.onUsage || function () {};
    var onlineEnabled = options.online !== false;
    var log = options.log || function () {};
    /*
     * 答案校验：由上层注入（main.js 传 reading.js 的 looksLikeTransliteration）。
     * Google 的 en→ja 对 tick 会回「カチカチ」这种拟声词，纯片假名，光看字符集
     * 拦不住 —— 用户报的就是这个。校验不过按 miss 处理。
     */
    var validate = typeof options.validate === "function" ? options.validate : null;

    var mem = new Map(); // word -> gloss | null(null 表示查过但没有)
    var persisted = loadCache();
    var queue = new Set();
    var inflight = new Set();
    var timer = null;
    var dirty = false;
    var stats = { memoryHits: 0, onlineHits: 0, misses: 0, requests: 0, failures: 0 };
    var lastError = null;

    for (var k in persisted) mem.set(k, persisted[k]);

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
          if (typeof rec.g === "string" && rec.g) out[key] = rec.g;
        }
        return out;
      } catch (e) {
        return {};
      }
    }

    var flushTimer = null;
    function flushCache(force) {
      if (!dirty) return;
      if (flushTimer && !force) return;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(function () {
        flushTimer = null;
        dirty = false;
        try {
          if (typeof localStorage === "undefined") return;
          var now = Date.now();
          var entries = [];
          mem.forEach(function (gloss, word) {
            if (typeof gloss === "string" && gloss) entries.push([word, { g: gloss, t: now }]);
          });
          if (entries.length > CACHE_MAX) entries = entries.slice(entries.length - CACHE_MAX);
          var obj = {};
          for (var i = 0; i < entries.length; i++) obj[entries[i][0]] = entries[i][1];
          localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
        } catch (e) {
          log("缓存写入失败（配额？）：", e && e.message);
        }
      }, force ? 0 : 2000);
    }

    function clearCache() {
      mem.clear();
      dirty = false;
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(CACHE_KEY);
      } catch (e) {
        /* ignore */
      }
      stats.memoryHits = stats.onlineHits = stats.misses = 0;
    }

    // ------------------------------------------------------------ 查询

    /**
     * 同步查询。返回英文字符串或 null（null 表示「暂时没有，稍后可能补上」）。
     * 只有同时启用在线、且确实排进了队列，才需要等 onUpdate。
     */
    function lookup(word) {
      if (!word) return null;

      // 1. 会话/持久缓存
      if (mem.has(word)) {
        var cached = mem.get(word);
        // 有译文就直接给；记的是 null 表示「查过了、没有」——这是终态，
        // 直接返回 null 并且不再排队。否则每次扫描都会把同一个查不到的词
        // 重新排队，接口一慢就变成请求风暴。想再给一次机会走 retryMisses()。
        if (cached) stats.memoryHits++;
        return cached || null;
      }

      // 2. 在线：排队，本次先返回 null
      stats.misses++;
      // 关键：立刻记成「查过、没有」。否则同一个词在每个扫描周期都会被重新
      // 排队（lookup 每次都走到这里），接口一慢就是请求风暴。
      // 成功后会被真正的译文覆盖；想再试走 retryMisses()。
      mem.set(word, null);
      dirty = true;
      if (onlineEnabled && !inflight.has(word)) {
        queue.add(word);
        scheduleFlush();
      }
      return null;
    }

    /**
     * 这个词是不是"还在等在线结果"（排了队或正在请求）。
     *
     * 上层靠它决定要不要先用英文音译规则的结果顶上：用户要的顺序是
     * 「大模型 -> 免费接口 -> 规则」，所以等待期间先不标；接口失败/关掉之后
     * （fail 时会把词记成"查过、没有"并清出队列）这里立刻变 false，让规则兜底 ——
     * 断网也照标。
     */
    function isWaiting(word) {
      if (!word) return false;
      return queue.has(word) || inflight.has(word);
    }

    // ------------------------------------------------------------ 在线请求

    function scheduleFlush() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        flush();
      }, FLUSH_DELAY_MS);
    }

    /**
     * 取一批待翻译的词，并把它们从队列移到 inflight。
     * 一个词同时只应存在于 queue 或 inflight 之一 —— 早些时候是先 add(inflight)
     * 再从 queue 删除候选，结果每次 flush 都会把同一批词重发一遍。
     */
    function takeBatch() {
      var words = [];
      queue.forEach(function (w) {
        if (words.length < BATCH_SIZE && !inflight.has(w)) words.push(w);
      });
      for (var i = 0; i < words.length; i++) {
        queue.delete(words[i]);
        inflight.add(words[i]);
      }
      return words;
    }

    function flush() {
      if (!onlineEnabled) return;
      var words = takeBatch();
      if (!words.length) return;
      var usageChars = 0;
      for (var uc = 0; uc < words.length; uc++) usageChars += (words[uc] || "").length;
      request(words).then(
        function (glosses) {
          var got = 0;
          for (var i = 0; i < words.length; i++) {
            var g = glosses[i];
            inflight.delete(words[i]);
            // 光"纯片假名"不够：还要像这个词的音译（tick 不能被回成 カチカチ）
            if (typeof g === "string" && g && (!validate || validate(words[i], g))) {
              mem.set(words[i], g);
              dirty = true;
              got++;
            } else {
              /*
               * 结果不是纯片假名（Google 把这个词翻译成汉字/平假名了），
               * 判为「查过、没有」。
               *
               * 必须记下来：不记的话 lookup 返回 null、下一轮又把它排进队列，
               * 于是每个扫描周期都为同一个普通词发一次请求 —— 接口会被打爆。
               */
              mem.set(words[i], null);
              dirty = true;
            }
          }
          stats.onlineHits += got;
          stats.requests++;
          onUsage({ requests: 1, ok: 1, words: words.length, chars: usageChars });
          lastError = null;
          if (got) {
            flushCache();
            onStatus("在线校正：" + got + " 个词");
          }
          /*
           * 不管有没有命中都要通知上层重扫：层序是「在线优先、规则垫底」，
           * 等待期间那些词是先不标的；一批全被丢掉（回汉字/不是纯片假名）时
           * 如果没人重扫，规则层就没机会接手，那些词会一直空着。
           */
          onUpdate();
          // 还有积压就接着发
          if (queue.size) scheduleFlush();
        },
        function (err) {
          stats.requests++;
          stats.failures++;
          onUsage({ requests: 1, failures: 1, words: words.length, chars: usageChars });
          lastError = (err && err.message) || String(err);
          for (var i = 0; i < words.length; i++) {
            inflight.delete(words[i]);
            // 记成「查过、没有」，否则每个扫描周期都会重新排队同一个词，
            // 接口一挂就变成无限请求。
            // 记 null 之后：lookup 直接返回 null 不再排队；想再给一次机会
            // 走 retryMisses()（设置面板的「重试未翻译的词」）。
            mem.set(words[i], null);
          }
          dirty = true;
          flushCache();
          onStatus("在线校正失败：" + lastError);
          log("在线校正失败：", lastError);
          // 失败后不再自动重排队，避免接口挂了以后疯狂重试。
          // 用户改设置或手动 rescan 时会重新排队。
          //
          // 但必须叫一次 onUpdate：现在层序是「大模型/免费接口 -> 规则」，
          // 在线的结果没回来之前那一轮是"先不标"的 —— 失败了不重扫，
          // 那些词就会一直空着（页面看着像坏了）。重扫之后规则层立刻兜底。
          onUpdate();
        }
      );
    }

    function buildUrl(endpoint, words) {
      var q = encodeURIComponent(words.join("\n"));
      if (endpoint.kind === "gtx") {
        return (
          "https://" +
          endpoint.host +
          "/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=" +
          q
        );
      }
      return "https://" + endpoint.host + "/translate_a/t?client=dict-chrome-ex&dt=t&sl=en&tl=ja&q=" + q;
    }

    /**
     * 解析 dict-chrome-ex 的响应：["行1\n行2\n..."]
     */
    function parseDict(json, expected) {
      var joined = Array.isArray(json) && Array.isArray(json[0]) ? json[0][0] : json[0];
      if (typeof joined !== "string") throw new Error("响应形状异常");
      var lines = joined.split("\n");
      if (lines.length !== expected) throw new Error("行数对不上（要 " + expected + " 行，回 " + lines.length + " 行）");
      return lines.map(cleanGloss);
    }

    /**
     * 解析 gtx 的响应：[[["译文","原文",...],["译文2","原文2",...]], ...]
     *
     * 把 query 按 \n 拆成 N 行发过去，接口会把相邻的短句合并成一条句子返回，
     * 靠第二项（原文）里有没有换行来分界：
     *   - 原文里出现 N-1 个换行 -> 每条句子正好对应一行，按顺序产出；
     *   - 没有换行（短查询被合并成一句）-> 说明它按 \n 原样回，把译文按 \n 拆开。
     * 最后必须核对行数，对不上就抛错失败换接口 —— 宁可注不上音，
     * 也不能把 A 词的英文标到 B 词头上。
     */
    function parseGtx(json, expected) {
      if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error("响应形状异常");
      var chunks = json[0];
      var segments = [];
      var newlines = 0;
      for (var i = 0; i < chunks.length; i++) {
        var c = chunks[i];
        if (!c) continue;
        segments.push(cleanGloss(c[0]));
        var src = typeof c[1] === "string" ? c[1] : "";
        for (var j = 0; j < src.length; j++) if (src[j] === "\n") newlines++;
      }
      var out = null;
      if (newlines >= expected - 1 && segments.length >= expected) {
        out = segments.slice(0, expected);
      } else {
        var split = [];
        for (var k = 0; k < segments.length; k++) {
          var parts = segments[k].split("\n");
          for (var m = 0; m < parts.length; m++) split.push(parts[m]);
        }
        if (split.length === expected) out = split;
      }
      if (!out) throw new Error("gtx 行数对不上（要 " + expected + " 行）");
      return out;
    }

    /*
     * 只要纯片假名的结果。
     *
     * 这是这一层唯一的判据，也是它存在的意义：Google 的 en->ja 对"外来语"通常回
     * 片假名（clover -> クローバー），对普通词回汉字/平假名（love -> 愛）。
     * 后者对唱歌没用（我们要的是读音，不是翻译），直接判为 miss、保留本地规则的结果。
     *
     * 顺带去掉空格：接口偶尔回 "クローバー " 这种带尾空的。
     */
    function cleanGloss(s) {
      var out = String(s == null ? "" : s).replace(/\s+/g, "").trim();
      if (!out) return "";
      if (!/^[\u30A0-\u30FF\u30FC]+$/.test(out)) return ""; // 不是纯片假名 -> 丢掉
      return out;
    }
    /** 空字符串代表"这个结果不能用"，统一在下面按 miss 处理 */

    function requestOnce(endpoint, words) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var t = setTimeout(function () {
        if (ctrl) ctrl.abort();
      }, REQUEST_TIMEOUT_MS);
      return fetch(buildUrl(endpoint, words), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (json) {
          return endpoint.kind === "gtx" ? parseGtx(json, words.length) : parseDict(json, words.length);
        })
        .finally(function () {
          clearTimeout(t);
        });
    }

    function request(words, attempt) {
      attempt = attempt || 0;
      var endpoint = ENDPOINTS[Math.min(attempt, ENDPOINTS.length - 1)];
      return requestOnce(endpoint, words).catch(function (err) {
        if (attempt + 1 < ENDPOINTS.length) {
          log("接口 " + endpoint.label + " 失败（" + err.message + "），换下一个再试");
          // 注意参数顺序：这里是 (words, attempt)，别把 endpoint 当成了 words
          return request(words, attempt + 1);
        }
        throw err;
      });
    }

    // ------------------------------------------------------------ 对外

    return {
      lookup: lookup,
      /**
       * 导出这份缓存里"问出来过"的词（给控制台/构建期把常用词沉淀进离线词典用）。
       * 键就是词本身，值是片假名读音；给不出结果的（null）不导。
       */
      exportWords: function () {
        var out = [];
        mem.forEach(function (v, k) {
          if (typeof v === "string" && v) out.push({ word: String(k), kana: v });
        });
        return out;
      },
      isWaiting: isWaiting,
      clearCache: clearCache,
      flushCache: function () {
        flushCache(true);
      },
      setOnline: function (on) {
        onlineEnabled = !!on;
        if (!onlineEnabled) {
          queue.clear();
        } else {
          // 重新排队所有「在词典里查不到」的历史 miss，让用户打开开关就生效
          mem.forEach(function (v, k) {
            if (!v) queue.add(k);
          });
          scheduleFlush();
        }
      },
      /** 忘了曾经查不到的结论，重新排队（接口恢复后再给一次机会） */
      retryMisses: function () {
        var n = 0;
        mem.forEach(function (v, k) {
          if (!v) {
            mem.delete(k);
            if (onlineEnabled) {
              queue.add(k);
              n++;
            }
          }
        });
        if (n) scheduleFlush();
        return n;
      },
      /** 已排队/在飞的词数，给设置面板显示 */
      pending: function () {
        return queue.size + inflight.size;
      },
      stats: function () {
        var s = {};
        for (var k in stats) s[k] = stats[k];
        s.cached = mem.size;
        s.lastError = lastError;
        return s;
      },
    };
  }

  return { createCorrector: createCorrector, CACHE_KEY: CACHE_KEY, ENDPOINTS: ENDPOINTS };
});
