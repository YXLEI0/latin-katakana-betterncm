/*
 * 西文字母片假名注音 (western-katakana) —— 在线接口用量统计
 *
 * 单独记一份的原因：两层在线接口都会烧钱或吃配额（大模型按 token 计费、免费接口
 * 按次数限流），而它们各自的 stats() 只在内存里，重启就归零，也不记 token。
 * 这里记三份账：
 *
 *   本次（会话内） / 今天 / 累计
 *
 * 「今天」和「累计」落 localStorage（key 见 STORAGE_KEY），重启后还在；跨天时
 * 「今天」自动归零，累计不动。
 *
 * 两层分开记这几个字段：
 *   requests            发出去的请求次数
 *   ok / failures       成功 / 失败次数
 *   words               问过的词数
 *   chars               送出去的字符数（免费接口没有 token 概念，用它衡量）
 *   promptTokens / completionTokens   大模型响应里的 usage（接口不给就保持 0）
 *
 * 目标宿主是网易云内置的老 CEF，所以这里只用 ES5。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKUsage = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STORAGE_KEY = "western-katakana.usage";
  var VERSION = 1;

  /** 两层在线接口分开记账，键名就是配置和面板里用的 id */
  var KINDS = ["llm", "google"];

  /** 每个桶里记的字段；别的键一律忽略（脏数据进不来） */
  var FIELDS = ["requests", "ok", "failures", "words", "chars", "promptTokens", "completionTokens"];

  function zero() {
    var o = {};
    for (var i = 0; i < FIELDS.length; i++) o[FIELDS[i]] = 0;
    return o;
  }

  function blank() {
    var o = {};
    for (var i = 0; i < KINDS.length; i++) o[KINDS[i]] = zero();
    return o;
  }

  function clone(obj) {
    var out = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      out[k] = zero();
      for (var f in obj[k]) {
        if (Object.prototype.hasOwnProperty.call(obj[k], f)) out[k][f] = obj[k][f];
      }
    }
    return out;
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** 只吃有限且不小于 0 的数字：localStorage 里的东西不可信 */
  function num(v) {
    return typeof v === "number" && isFinite(v) && v >= 0 ? v : 0;
  }

  /** 把 src 里认识的字段累加进 dst */
  function accumulate(dst, src) {
    if (!src || typeof src !== "object") return;
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      if (src[f] === undefined) continue;
      dst[f] += num(src[f]);
    }
  }

  /**
   * @param {Object} [opts]
   *   opts.storage  localStorage 的形状（getItem/setItem），不给就用全局的
   *   opts.now      返回 Date 的函数，测试跨天时替换
   * @returns {Object} { add, reset, snapshot, cost, flush }
   */
  function createUsage(opts) {
    opts = opts || {};
    var storage =
      opts.storage !== undefined
        ? opts.storage
        : typeof localStorage !== "undefined"
          ? localStorage
          : null;
    var now = typeof opts.now === "function" ? opts.now : function () { return new Date(); };

    var session = blank();
    var today = blank();
    var total = blank();
    var day = dayKey();

    function dayKey() {
      var d = now();
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }

    function save() {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, day: day, today: today, total: total }));
      } catch (e) {
        /* 写不进去就算了：统计而已，绝不能因为它把插件搞崩 */
      }
    }

    function load() {
      if (!storage) return;
      var raw = null;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch (e) {
        return;
      }
      if (!raw) return;
      var obj = null;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        return; /* 坏了就当没有 */
      }
      if (!obj || typeof obj !== "object") return;
      var i;
      for (i = 0; i < KINDS.length; i++) {
        if (obj.today && obj.today[KINDS[i]]) accumulate(today[KINDS[i]], obj.today[KINDS[i]]);
        if (obj.total && obj.total[KINDS[i]]) accumulate(total[KINDS[i]], obj.total[KINDS[i]]);
      }
      // 日期对得上才算「今天」，对不上就把今天清零；累计上面已经读进来了
      day = typeof obj.day === "string" && obj.day === dayKey() ? obj.day : dayKey();
      if (typeof obj.day === "string" && obj.day !== dayKey()) today = blank();
    }

    /** 发现跨天了就清掉「今天」，顺手落一次盘 */
    function rollDay() {
      var d = dayKey();
      if (d === day) return;
      day = d;
      today = blank();
      save();
    }

    /**
     * 记一笔。
     * @param {string} kind  "llm" | "google"
     * @param {Object} fields 只认 FIELDS 里的字段，例如
     *                        { requests: 1, ok: 1, words: 8, promptTokens: 220, completionTokens: 60 }
     */
    function add(kind, fields) {
      if (KINDS.indexOf(kind) < 0 || !fields) return;
      rollDay();
      accumulate(session[kind], fields);
      accumulate(today[kind], fields);
      accumulate(total[kind], fields);
      save();
    }

    /**
     * 清零。
     * @param {string} [scope] "session"（默认）| "today" | "all"
     */
    function reset(scope) {
      var what = scope || "session";
      if (what === "session" || what === "all") session = blank();
      if (what === "today" || what === "all") {
        today = blank();
        day = dayKey();
      }
      if (what === "all") total = blank();
      save();
    }

    /** 当前账本的副本，调用方随便改 */
    function snapshot() {
      rollDay();
      return { version: VERSION, day: day, session: clone(session), today: clone(today), total: clone(total) };
    }

    /**
     * 估算花费，单位元。单价按「元 / 百万 token」给，传 0 就不算这一项。
     * 免费接口不按 token 计费，所以只有大模型那层参与。
     */
    function cost(bucket, priceIn, priceOut) {
      var b = bucket && bucket.llm ? bucket.llm : null;
      if (!b) return 0;
      var pin = num(priceIn);
      var pout = num(priceOut);
      return (b.promptTokens / 1e6) * pin + (b.completionTokens / 1e6) * pout;
    }

    load();

    return {
      add: add,
      reset: reset,
      snapshot: snapshot,
      cost: cost,
      flush: save,
      KEY: STORAGE_KEY,
    };
  }

  return {
    createUsage: createUsage,
    KEY: STORAGE_KEY,
    KINDS: KINDS,
    FIELDS: FIELDS,
  };
});
