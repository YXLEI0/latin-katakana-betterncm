/*
 * Latin Katakana for BetterNCM —— 「学会的词」：把大模型给过的答案沉淀成离线词条
 *
 * 为什么要有这一份：大模型那层的缓存是按「词 + 所在那一句」存的 ——
 * 换一首歌、同一句歌词再出现一次，都要重新花钱问一遍。
 * 用户要的就是这个：「让运行期模型给的答案自动沉淀进词典」。
 *
 * 收词规矩（刻意保守，宁缺毋滥 —— 收错了它就是"离线权威"，模型再没机会纠）：
 *   1. 模型答的读音必须和本地层不一样（一样就没必要收，本地层已经对了）；
 *   2. 同一个词要在两个不同的句子里答出同一个读音才收 ——
 *      只答过一次的不收：那可能是"只在这一句的语境里才对"的答案
 *      （`read` リード / レッド 就是这种词）；
 *   3. 「两可」的词不收（`do`/`re`/`mi`/`me`/`mo`/`pi`… 英文读音和唱名·罗马音节
 *      都成立）—— 这条由上层判定（它手里有词典和罗马音表），本模块只负责记账；
 *   4. 模型后来给了另一个读音：说明这个词靠语境，立刻把已收的条目撤掉。
 *
 * 收下之后按离线词典的优先级参与层序（`source: "learned"`）——
 * 也就是说这个词以后不再问模型，钱就省在这里。
 *
 * 落盘：localStorage['western-katakana.learned.v1']；
 * 坏了 / 被手改坏 / 写不进去一律当没有（绝不能因为一份缓存把插件搞崩）。
 * 条数上限 MAX_WORDS，超了丢"最久没用过的"。
 *
 * 目标宿主是网易云内置的老 CEF，所以这里只用 ES5。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WKLearn = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STORAGE_KEY = "western-katakana.learned.v1";
  var VERSION = 1;

  /** 条数上限：够一首歌到一整张专辑的量，也不会把 localStorage 撑爆 */
  var MAX_WORDS = 3000;
  /** 待定（只答过一次）的表也有上限，免得脏数据无限长 */
  var MAX_SEEN = 800;
  /** 读音合法性：纯片假名 + 长音符（和 llm.js 那边同一口径，宽一点无妨） */
  var RE_KANA = /^[\u30A1-\u30F6\u30FC\u30FF]+$/;
  var MAX_KANA_LEN = 14;

  function nowMs() {
    return Date.now();
  }

  /** 行标识：整句原文折成一个小哈希，只用来判"是不是同一句"，不存原文 */
  function lineHash(line) {
    var s = String(line == null ? "" : line).replace(/\s+/g, " ").trim();
    if (!s) return "";
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  /** 默认规范化：和词典键一致（小写、去撇号连字符） */
  function defaultNormalize(word) {
    return String(word == null ? "" : word)
      .toLowerCase()
      .replace(/['\u2019-]/g, "");
  }

  /**
   * @param {Object} [opts]
   *   opts.storage    localStorage 形状（getItem/setItem/removeItem）；不给就用全局
   *   opts.normalize  (word) => 键；不给就用小写去符号
   *   opts.maxWords   条数上限
   *   opts.delayMs    落盘防抖（默认 1500ms；测试里直接调 flush()）
   * @returns {Object} { get, has, note, forget, clear, list, stats, flush }
   */
  function createLearned(opts) {
    opts = opts || {};
    var storage =
      opts.storage !== undefined
        ? opts.storage
        : typeof localStorage !== "undefined"
          ? localStorage
          : null;
    var normalize = typeof opts.normalize === "function" ? opts.normalize : defaultNormalize;
    var maxWords = typeof opts.maxWords === "number" && opts.maxWords > 0 ? opts.maxWords : MAX_WORDS;
    var delayMs = typeof opts.delayMs === "number" ? opts.delayMs : 1500;

    var words = {}; // word -> { k: 读音, at: 最后用到的时间 }
    var seen = {}; // word -> { k: 读音, n: 见过几句, l: 上次那句, at }
    var usedSession = {}; // 本次会话真正用上过的（只算个数给面板看）
    var timer = null;
    var dirty = false;

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
      var list = obj.words;
      if (list && typeof list === "object") {
        for (i in list) {
          if (!Object.prototype.hasOwnProperty.call(list, i)) continue;
          var rec = list[i];
          var kana = rec && typeof rec === "object" ? rec.k : rec;
          var at = rec && typeof rec === "object" && typeof rec.at === "number" ? rec.at : 0;
          if (typeof kana !== "string" || !isKana(kana)) continue;
          words[i] = { k: kana, at: at };
        }
      }
      var pend = obj.seen;
      if (pend && typeof pend === "object") {
        for (i in pend) {
          if (!Object.prototype.hasOwnProperty.call(pend, i)) continue;
          var s = pend[i];
          if (!s || typeof s !== "object") continue;
          if (typeof s.k !== "string" || !isKana(s.k)) continue;
          if (words[i]) continue; // 已经收了的不用再攒
          seen[i] = { k: s.k, n: s.n === 2 ? 2 : 1, l: typeof s.l === "string" ? s.l : "", at: typeof s.at === "number" ? s.at : 0 };
        }
      }
      trim();
      purgeSingleLetters();
    }

    /*
     * 一次性清掉「单字母」词条。
     *
     * 为什么：单字母的读音取决于语境 —— 英文里的冠词 `a`（ア）、字母名
     * （`(A, B)` エー）、段标（`(A:` 不标）。词级词条（不带语境）钉死一个必然出错：
     * 用户机器上就攒了 `a → アー`（模型在 `(A:` 那种行里答的），于是拉丁语歌词里
     * 的段标 A 一直带着 アー —— 光加"段标不注音"的规则还不够，得把这条老词条清掉。
     *
     * 只清一次（用一个小标记记住）；以后也不会再收（见 main.js 的 onAnswer 过滤）。
     */
    function purgeSingleLetters() {
      var FLAG = "western-katakana.learned.purge1";
      try {
        if (!storage || storage.getItem(FLAG)) return;
        storage.setItem(FLAG, "1");
      } catch (e) {
        return;
      }
      var dropped = 0;
      for (var k in words) {
        if (!Object.prototype.hasOwnProperty.call(words, k)) continue;
        if (k.length === 1) {
          delete words[k];
          dropped++;
        }
      }
      for (var s in seen) {
        if (!Object.prototype.hasOwnProperty.call(seen, s)) continue;
        if (s.length === 1) delete seen[s];
      }
      if (dropped) save();
    }

    function isKana(kana) {
      return typeof kana === "string" && kana.length > 0 && kana.length <= MAX_KANA_LEN && RE_KANA.test(kana);
    }

    function save() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      dirty = false;
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, words: words, seen: seen }));
      } catch (e) {
        /* 写不进去就算了：这是加速用的缓存，不是数据源 */
      }
    }

    /** 攒批落盘：收词/记账都很频繁，别每句歌词都写一次 localStorage */
    function schedule() {
      dirty = true;
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        if (dirty) save();
      }, delayMs);
    }

    function countWords() {
      var n = 0;
      for (var k in words) if (Object.prototype.hasOwnProperty.call(words, k)) n++;
      return n;
    }

    function countSeen() {
      var n = 0;
      for (var k in seen) if (Object.prototype.hasOwnProperty.call(seen, k)) n++;
      return n;
    }

    /** 超上限就丢"最久没用过"的（按 at 升序丢，够用且实现简单） */
    function trim() {
      var over = countWords() - maxWords;
      if (over > 0) {
        var keys = [];
        for (var k in words) if (Object.prototype.hasOwnProperty.call(words, k)) keys.push(k);
        keys.sort(function (a, b) {
          return (words[a].at || 0) - (words[b].at || 0);
        });
        for (var i = 0; i < over && i < keys.length; i++) delete words[keys[i]];
      }
      var overSeen = countSeen() - MAX_SEEN;
      if (overSeen > 0) {
        var skeys = [];
        for (var k2 in seen) if (Object.prototype.hasOwnProperty.call(seen, k2)) skeys.push(k2);
        skeys.sort(function (a, b) {
          return (seen[a].at || 0) - (seen[b].at || 0);
        });
        for (var j = 0; j < overSeen && j < skeys.length; j++) delete seen[skeys[j]];
      }
    }

    /** 已经学会的读音（没有就 null）。用上了就记一笔"本次省下的请求" */
    function get(word) {
      var w = normalize(word);
      if (!w) return null;
      var rec = words[w];
      if (!rec) return null;
      usedSession[w] = true;
      /*
       * 刷新"最近用过"（淘汰时按它丢最久没用过的）。
       * 只改内存、不安排落盘：这个词每轮扫描都会被读一次，
       * 每次都写 localStorage 就太吵了 —— 反正别的动作（收词/忘词）会顺手存下来。
       */
      rec.at = nowMs();
      return rec.k;
    }

    function has(word) {
      var w = normalize(word);
      return !!(w && words[w]);
    }

    /** 只看一眼，不记"本次用上了"（排障用；get() 会记） */
    function peek(word) {
      var w = normalize(word);
      if (!w || !words[w]) return null;
      return words[w].k;
    }

    /**
     * 模型刚答了一个读音。
     * @param {string} word      词（原样，内部会规范化）
     * @param {string} kana      模型给的片假名
     * @param {string} line      它所在的整句（只用来判"是不是另一句"）
     * @param {string} [localKana] 本地层原本给的读音（一样就不用学了）
     * @returns {string} "learned"（收下了）| "pending"（记了一笔，还差一句）
     *                   | "drop"（把已收的撤了：模型改口）| "skip"（不学）
     */
    function note(word, kana, line, localKana) {
      var w = normalize(word);
      if (!w || !isKana(kana)) return "skip";
      if (typeof localKana === "string" && localKana === kana) {
        // 本地层本来就对：没什么可学的，顺手把待定记录清掉
        if (seen[w]) {
          delete seen[w];
          schedule();
        }
        return "skip";
      }

      var l = lineHash(line);
      var rec = words[w];
      if (rec) {
        if (rec.k === kana) {
          rec.at = nowMs();
          schedule();
          return "learned";
        }
        /*
         * 同一个词，模型这次给了别的读音 —— 说明它靠语境（read リード/レッド、
         * 人名地名…）。那就撤掉离线条目：留着只会一直读错，而且模型没机会纠。
         */
        delete words[w];
        delete seen[w];
        schedule();
        return "drop";
      }

      var s = seen[w];
      if (!s) {
        seen[w] = { k: kana, n: 1, l: l, at: nowMs() };
        schedule();
        return "pending";
      }
      if (s.k !== kana) {
        // 两句给了不同读音：靠语境，别学
        seen[w] = { k: kana, n: 1, l: l, at: nowMs() };
        schedule();
        return "pending";
      }
      if (l && s.l !== l) {
        // 第二句也是同一个读音 —— 收下
        words[w] = { k: kana, at: nowMs() };
        delete seen[w];
        trim();
        save(); // 收词是关键时候，立刻落盘（防抖省不掉这一下）
        return "learned";
      }
      // 同一句里又见了一次（可能只是重扫）：不重复计数
      s.at = nowMs();
      return "pending";
    }

    function forget(word) {
      var w = normalize(word);
      if (!w) return false;
      var had = !!words[w] || !!seen[w];
      delete words[w];
      delete seen[w];
      if (had) save();
      return had;
    }

    function clear() {
      var n = countWords();
      words = {};
      seen = {};
      usedSession = {};
      save();
      return n;
    }

    function list() {
      var out = [];
      for (var k in words) {
        if (!Object.prototype.hasOwnProperty.call(words, k)) continue;
        out.push({ word: k, kana: words[k].k, at: words[k].at || 0 });
      }
      out.sort(function (a, b) {
        return (b.at || 0) - (a.at || 0);
      });
      return out;
    }

    function stats() {
      var used = 0;
      for (var k in usedSession) if (Object.prototype.hasOwnProperty.call(usedSession, k)) used++;
      return {
        count: countWords(),
        pending: countSeen(),
        usedSession: used,
        max: maxWords,
        key: STORAGE_KEY,
      };
    }

    load();

    return {
      get: get,
      peek: peek,
      has: has,
      note: note,
      forget: forget,
      clear: clear,
      list: list,
      stats: stats,
      flush: save,
      normalize: normalize,
      KEY: STORAGE_KEY,
      MAX_WORDS: MAX_WORDS,
    };
  }

  return {
    createLearned: createLearned,
    KEY: STORAGE_KEY,
    lineHash: lineHash,
    MAX_WORDS: MAX_WORDS,
  };
});
