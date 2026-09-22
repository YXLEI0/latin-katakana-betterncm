/*
 * 集成测试：像 BetterNCM 那样把 core 下的模块 + main.js 注入到一个页面里，
 * 提供 plugin / betterncm 全局桩，然后观察插件是否真的开始工作。
 *
 * 这是最接近真机的一层：manifest 的 injects 顺序、main.js 里的生命周期注册、
 * 扫描调度、设置面板构建，都会在这里跑到。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore, loadScripts, CORE_FILES } = require("./helpers");

const FILES = CORE_FILES.concat(["main.js"]);

// 贴近真机：默认播放页的歌词结构 + RNP 歌词页的三层结构
const NCM_HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-playbar">
    <div class="words">
      <span class="name"><a href="#">light と clover</a></span>
      <span class="by"><a href="#">dreamer</a></span>
    </div>
  </div>
  <div class="m-lyric">
    <ul id="mod_pc_lyric_record" class="lyric">
      <li class="line"><p>きらめく light と clover</p></li>
      <li class="line"><p>ずっと dream を見てた</p></li>
    </ul>
  </div>
  <div class="rnp-lyrics-line">
    <div class="rnp-lyrics-line-original">いざなった clover へ</div>
    <div class="rnp-lyrics-line-romaji">i za na tta clover</div>
    <div class="rnp-lyrics-line-translated">走向那株四叶草</div>
  </div>
</div>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个假的 BetterNCM 环境并注入插件 */
function bootPlugin(html, options) {
  options = options || {};
  // 默认注入全部核心模块；options.files 用来测"某个模块没注入"时的降级
  const ctx = loadCore(html || NCM_HTML, { reader: false, files: options.files });
  const dom = ctx.dom;
  const window = ctx.window;

  // 网络：默认全部失败，保证测试不碰真接口
  window.fetch = options.fetch || function () {
    return Promise.reject(new Error("offline (test)"));
  };

  // main.js 是在「注入时」读 localStorage 里的配置，所以要在 loadScripts 之前种进去
  if (options.config) {
    const saved = {};
    for (const k of Object.keys(options.config)) saved[k] = options.config[k];
    window.localStorage.setItem("western-katakana.config", JSON.stringify(saved));
  }
  // 改名前的键（用来测"老键搬家"那条）
  if (options.legacyKeys) {
    for (const k of Object.keys(options.legacyKeys)) window.localStorage.setItem(k, options.legacyKeys[k]);
  }

  const opened = [];
  const listeners = { load: [], config: [] };
  const betterncm = {
    app: {
      getBetterNCMVersion: function () {
        return Promise.resolve("1.3.4-test");
      },
    },
    ncm: {
      openUrl: function (u) {
        opened.push(u);
      },
    },
    fs: {},
  };
  const plugin = {
    devMode: !!options.dev,
    pluginPath: "C:/betterncm/plugins/western-katakana",
    onLoad: function (fn) {
      listeners.load.push(fn);
    },
    onConfig: function (fn) {
      listeners.config.push(fn);
    },
  };

  // BetterNCM 是把 plugin / betterncm 作为全局注入的，挂到 window 上即可
  window.betterncm = betterncm;
  window.plugin = plugin;

  // options.files 给了就按它注入，没给就注入全部
  loadScripts(dom, options.files ? options.files.concat(["main.js"]) : FILES);

  const env = {
    ctx,
    dom,
    window,
    document: window.document,
    plugin,
    betterncm,
    opened,
    listeners,
    runLoad: async function () {
      for (const fn of listeners.load) await fn();
    },
  };
  // window.WK 要到 onLoad 之后才存在（BetterNCM 就是这个顺序），
  // 所以这里用 getter 延迟取值，别在 boot 阶段就抄一份 undefined。
  Object.defineProperty(env, "api", {
    get: function () {
      return window.WK;
    },
  });
  return env;
}

function rubyCount(root) {
  return root.querySelectorAll("ruby.wk-ruby").length;
}

/** 离线词典里有没有这个词（写测试前提用；直接读 src/core/dict.js） */
function envDictHas(word) {
  const D = require("../src/core/dict.js");
  return Object.prototype.hasOwnProperty.call(D.words, word);
}

/** 底字文本（剔掉注音）——标准 ruby 里 <rt> 的文本也算 textContent，必须显式去掉 */
function baseText(el) {
  const clone = el.cloneNode(true);
  const anns = clone.querySelectorAll("rt, .wk-rt, .kt-rt, .fg-rt, rp");
  for (let i = 0; i < anns.length; i++) {
    if (anns[i].parentNode) anns[i].parentNode.removeChild(anns[i]);
  }
  return clone.textContent;
}

const PAIRS = (p) =>
  [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);

test("注入全部模块后，插件注册了 onLoad / onConfig 并导出 API", async () => {
  const env = bootPlugin();
  assert.strictEqual(env.listeners.load.length, 1, "应该注册了 onLoad");
  assert.strictEqual(env.listeners.config.length, 1, "应该注册了 onConfig");
  await env.runLoad();
  assert.strictEqual(typeof env.api, "object", "onLoad 后应该导出 API");
  assert.strictEqual(typeof env.api.read, "function");
});

test("默认：歌词里的拉丁词标上片假名读音，底字一字不改", async () => {
  const env = bootPlugin();
  await env.runLoad();
  await sleep(600);

  const lines = env.document.querySelectorAll("ul.lyric li p");
  assert.deepStrictEqual(PAIRS(lines[0]), [
    ["light", "ライト"],
    ["clover", "クローバー"],
  ]);
  assert.strictEqual(baseText(lines[0]), "きらめく light と clover");
  assert.deepStrictEqual(PAIRS(lines[1]), [["dream", "ドリーム"]]);
});

test("播放栏的歌名 / 歌手也标", async () => {
  const env = bootPlugin();
  await env.runLoad();
  await sleep(600);
  const pairs = [];
  const rubies = env.document.querySelectorAll(".m-playbar ruby.wk-ruby");
  for (let i = 0; i < rubies.length; i++) pairs.push(rubies[i].querySelector(".wk-rt").textContent);
  // dreamer 是变形词（规则会读成 ドレアメー），所以它必须在词典里 —— 见 tools/seed-words.js 第二批
  assert.deepStrictEqual(pairs.sort(), ["クローバー", "ドリーマー", "ライト"].sort());
  assert.strictEqual(baseText(env.document.querySelector(".m-playbar .name")), "light と clover");
});

test("RNP 的罗马音层和中文翻译层不标，只标原文层", async () => {
  const env = bootPlugin();
  await env.runLoad();
  await sleep(600);
  assert.strictEqual(rubyCount(env.document.querySelector(".rnp-lyrics-line-original")), 1, "原文层要标");
  assert.strictEqual(rubyCount(env.document.querySelector(".rnp-lyrics-line-romaji")), 0, "罗马音层要跳过");
  assert.strictEqual(rubyCount(env.document.querySelector(".rnp-lyrics-line-translated")), 0, "翻译层要跳过");
});

// 三个插件同时开着时，一行里会同时有别人的注音节点。
// 片假名终结者的 <rt class="kt-rt"> 里装的偏偏是英文原词（dream、hello…），
// 正是我们要标的对象 —— 如果不把别人的注音节点整棵跳过，
// 就会在英文注释上面再注一层片假名，等于给注解做注解。
const COEXIST_HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>きらめく <ruby class="kt-ruby">ドリーム<rt class="kt-rt">dream</rt></ruby> と <ruby class="fg-ruby">四葉<rt class="fg-rt">よつば</rt></ruby> clover</p></li>
    </ul>
  </div>
</div>
</body></html>`;

test("已经带别人注音的行：只标底字，绝不往别人的注音里再注一层", async () => {
  const env = bootPlugin(COEXIST_HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  // 我们自己该标的那个词标上了
  assert.deepStrictEqual(PAIRS(p), [["clover", "クローバー"]]);
  // 别人的注音节点内部一个 wk-ruby 都不能有
  assert.strictEqual(p.querySelectorAll(".kt-rt ruby.wk-ruby, .fg-rt ruby.wk-ruby").length, 0);
  assert.strictEqual(p.querySelector(".kt-rt").textContent, "dream", "片假名终结者的英文注释不能被改写");
  assert.strictEqual(p.querySelector(".fg-rt").textContent, "よつば", "jp-furigana 的振假名不能被改写");
  // 底字不变（别人的 <rt> 不算底字）
  assert.strictEqual(baseText(p), "きらめく ドリーム と 四葉 clover");
});

/*
 * 上面的用例走的是「人家用真 <ruby>/<rt>」这条路 —— 那条路上 <rt> 标签本身
 * 就在 SKIP_TAGS 里，所以它证明不了我们认识对方的 class。
 * 内核不支持 ruby 时三家都降级成 <span class="xx-rt">，那时只剩 class 可认；
 * 这里就把那条路单独钉住（片假名终结者的降级节点是 span.kt-ruby / span.kt-rt）。
 */
const COEXIST_FALLBACK_HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>きらめく <span class="kt-ruby">ドリーム<span class="kt-rt">dream</span></span> と clover</p></li>
    </ul>
  </div>
</div>
</body></html>`;

test("降级成 <span> 的别人注音，靠 class 也要认出来（不能给 dream 再注一层）", async () => {
  const env = bootPlugin(COEXIST_FALLBACK_HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(p.querySelectorAll(".kt-ruby ruby.wk-ruby, .kt-rt ruby.wk-ruby").length, 0, p.innerHTML);
  assert.strictEqual(p.querySelector(".kt-rt").textContent, "dream", "别人的注音文字不许被改写");
  assert.deepStrictEqual(PAIRS(p), [["clover", "クローバー"]], "同一行里我们该标的照样标");
});

/*
 * 三个插件同时开着时最要紧的一条：反复扫描不能重注、不能进入认输期。
 * 上面两条用例只证明"别人的注音我们不碰"；这条证明"待在别人的注音旁边我们也不抖" ——
 * 如果 visibleText() 把别人的注音算进底字，或者把对方的 <rt> 当成"底字变了"，
 * 每一轮都会"还原 → 重注"，真机上就是一直在闪。
 */
const THREE_PLUGIN_HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p><span class="fg-line">きらめく <span class="kt-ruby">ドリーム<span class="kt-rt">dream</span></span> と <ruby class="fg-ruby">四葉<rt class="fg-rt">よつば</rt></ruby> の light</span></p></li>
    </ul>
  </div>
</div>
</body></html>`;

test("和被注音过的行待在一起：反复扫描既不重注也不认输", async () => {
  const env = bootPlugin(THREE_PLUGIN_HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  // 只标我们该标的词。对方的注音节点里装的是 dream（拉丁词，正是我们要标的对象），
  // 一旦我们走进去了，这里就会多出 ["dream", "ドリーム"]
  assert.deepStrictEqual(PAIRS(p), [["light", "ライト"]], "只标我们该标的那个词：" + p.innerHTML);
  const before = p.innerHTML;

  // 不 await：五轮同步扫描中间不允许有别的东西插进来
  for (let i = 0; i < 5; i++) {
    env.api.pass();
    const r = env.api.state.lastResult;
    assert.strictEqual(r.changed, 0, `第 ${i + 1} 轮不该重注：${JSON.stringify(r)}`);
    assert.strictEqual(r.restored, 0, `第 ${i + 1} 轮不该还原：${JSON.stringify(r)}`);
    assert.strictEqual(r.unstable, 0, `第 ${i + 1} 轮不该出现失效判定：${JSON.stringify(r)}`);
  }
  assert.strictEqual(p.innerHTML, before, "DOM 必须原样");
  assert.strictEqual(env.api.state.annotator.churnedCount(), 0, "不该有任何一行进入认输期");
  assert.strictEqual(p.querySelector(".kt-rt").textContent, "dream");
  assert.strictEqual(p.querySelector(".fg-rt").textContent, "よつば");
});

// 用来测大模型层的一行：kaleidoscope 是词典里没有的词（6046 条的词典也覆盖不到它），
// 所以它必然落到规则层（读成乱七八糟的拼写音译），正好用来看"结果回来之后有没有被换掉"。
const LLM_HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>きらめく kaleidoscope の light</p></li>
    </ul>
  </div>
</div>
</body></html>`;

test("大模型层：规则读歪的词，结果回来之后注音会被换上（先即时、后修正）", async () => {
  // 走整条真实链路：boot -> 规则先给一个即时读音 -> 入队 -> 一批问完 ->
  // onUpdate 重扫 -> DOM 里的注音被换成大模型的写法。
  const requests = [];
  const env = bootPlugin(LLM_HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions" },
    fetch: function (url, init) {
      // 免费那层（core/correct.js）也会调 fetch，而且是 GET、没有 body ——
      // 这里一并当"离线"拒掉，免得它把下面的 JSON.parse 搞炸（测试噪音）
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      // 提示词里的条目是 [{i, w, line}]：w 是词，line 是整句歌词（语境）
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      const words = items.map((it) => it.w);
      requests.push({ url: url, words: words, items: items, auth: init.headers.Authorization });
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = it.w === "kaleidoscope" ? "カレイドスコープ" : "ダミー";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1400);

  assert.ok(requests.length >= 1, "应该向大模型发过请求");
  assert.strictEqual(requests[0].auth, "Bearer sk-test", "key 要按 Bearer 发出去");
  assert.ok(requests[0].words.indexOf("kaleidoscope") >= 0, "词典里没有的词要进队列：" + requests[0].words.join(","));
  assert.ok(requests[0].words.indexOf("light") < 0, "词典命中的词不该浪费请求：" + requests[0].words.join(","));
  // 语境要一起发过去：line 是那一整句歌词
  assert.ok(
    requests[0].items[0].line.indexOf("kaleidoscope") >= 0,
    "请求里要带上整句歌词当语境：" + JSON.stringify(requests[0].items)
  );

  const s = env.api.stats().llm;
  assert.ok(s && s.hasKey === true && s.requests >= 1 && s.hits >= 1, JSON.stringify(s));

  // 关键：DOM 里那个词现在必须是大模型给的读音，不是规则拼出来的
  const line = env.document.querySelector("ul.lyric li p");
  const pairs = [...line.querySelectorAll("ruby.wk-ruby")].map((r) => r.querySelector(".wk-rt").textContent);
  assert.ok(pairs.indexOf("カレイドスコープ") >= 0, "注音应该被换成大模型的读音：" + pairs.join(","));
  assert.strictEqual(baseText(line), "きらめく kaleidoscope の light", "底字不许动");
});

test("大模型层没配 key 时：一切照旧走本地，不发任何请求", async () => {
  let called = 0;
  const env = bootPlugin(NCM_HTML, {
    fetch: function () {
      called++;
      return Promise.reject(new Error("offline (test)"));
    },
  });
  await env.runLoad();
  await sleep(600);
  assert.strictEqual(called, 0, "没填 key 不该发请求");
  assert.ok(rubyCount(env.document.querySelector("ul.lyric")) >= 3, "本地照样要标上");
  const s = env.api.stats();
  assert.strictEqual(s.llm.hasKey, false);
});

test("用户报的那行：Tell me a story 里的 a 也要注音", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>Tell me a story tell me a story 叶うなら</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  assert.deepStrictEqual(pairs, [
    ["Tell", "テル"],
    ["me", "ミー"],
    ["a", "ア"],
    ["story", "ストーリー"],
    ["tell", "テル"],
    ["me", "ミー"],
    ["a", "ア"],
    ["story", "ストーリー"],
  ]);
  assert.strictEqual(baseText(p), "Tell me a story tell me a story 叶うなら", "底字一字不改");
});

test("用户截图的四张图：颜文字不标、ATフィールド エーティー、Ω オーム、I'm 要连 `'m` 一起标", async () => {
  // 用户截图里读错的几处：颜文字 `勝算なくても行っちゃえ！とか(#^ω^)` 里的 ω 被标成 オメガ（该留白）；
  // `対バンにはATフィールド` 的 `AT` 命中词典的 at、读成 アット（该 エーティー）；
  // `I-I-I-I-I-I-I'm mine` 的记号在 `'` 前就断了，最后只注到 `I`，`'m` 整个丢了；
  // `無限増幅回路（Ω）` 的 Ω 是电阻单位、该读 オーム，原来整行被判成希腊语、引擎读成 オ；
  // `（V, W, A）` 是单位符号（ボルト・ワット・アンペア），而 `(A, B)` 仍是字母名。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>勝算なくても行っちゃえ！とか(#^ω^)</p></li>
  <li class="line"><p>対バンにはATフィールド</p></li>
  <li class="line"><p>I-I-I-I-I-I-I'm mine</p></li>
  <li class="line"><p>〈想い〉の無限増幅回路（Ω）</p></li>
  <li class="line"><p>誰にも邪魔されないような（V, W, A）</p></li>
  <li class="line"><p>(A, B) 退屈に打つ QTE</p></li>
  <li class="line"><p>GOしろ！ NOと言えない YOUと一緒に</p></li>
  <li class="line"><p>Θάλασσα και ουρανός</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  // 颜文字行一个注音都不该有（`^` 之类在 letters.js 里算"装饰符号粘连"）
  assert.strictEqual(rubyCount(ps[0]), 0, "颜文字不该注音：" + ps[0].innerHTML);
  assert.strictEqual(baseText(ps[0]), "勝算なくても行っちゃえ！とか(#^ω^)", "原文一字不改");
  // `AT` 紧贴假名，全大写缩写按字母名读
  assert.strictEqual(pairsOf(ps[1]).get("AT"), "エーティー", "AT 该读 エーティー：" + ps[1].innerHTML);
  // 记号带缩写尾巴：`'m` 要跟最后一个 I 合成一个词（アイム）
  const l2 = pairsOf(ps[2]);
  assert.strictEqual(l2.get("I'm"), "アイム", "I'm 要整体标（含 'm）：" + ps[2].innerHTML);
  assert.strictEqual(l2.get("mine"), "マイン");
  assert.strictEqual([...ps[2].querySelectorAll("ruby.wk-ruby")].filter((r) => r.childNodes[0].nodeValue === "I").length, 6);
  // 单个希腊字母：Ω 是大写的电阻单位，小写 ω 才读字母名
  assert.strictEqual(pairsOf(ps[3]).get("Ω"), "オーム", "Ω 该读 オーム：" + ps[3].innerHTML);
  // `（V, W, A）` 整串都是单位，读单位名（用户指名要的）
  const l4 = pairsOf(ps[4]);
  assert.strictEqual(l4.get("V"), "ボルト", "V 该读 ボルト：" + ps[4].innerHTML);
  assert.strictEqual(l4.get("W"), "ワット");
  assert.strictEqual(l4.get("A"), "アンペア");
  // 反面：串里有非单位字母的（`(A, B)`）仍读字母名
  const l4b = pairsOf(ps[5]);
  assert.strictEqual(l4b.get("A"), "エー", "`(A, B)` 的 A 是字母名：" + ps[5].innerHTML);
  assert.strictEqual(l4b.get("B"), "ビー");
  // 反面：全大写的英文词照旧按词读（别被缩写表带跑）
  const l6 = pairsOf(ps[6]);
  assert.strictEqual(l6.get("GO"), "ゴー", JSON.stringify([...l6]));
  assert.strictEqual(l6.get("NO"), "ノー");
  assert.strictEqual(l6.get("YOU"), "ユー");
  // 反面：真希腊语行上的单字母照旧走引擎（`ουρανός` ウラノス），不是字母名
  const l7 = pairsOf(ps[7]);
  assert.strictEqual(l7.get("ουρανός"), "ウラノス", JSON.stringify([...l7]));
  assert.strictEqual(l7.get("και"), "カイ");
});

test("英文词不许被罗马音层抢读：daze デイズ / Shone ショーン / rime ライム / boon ブーン / Hoo~ フー", async () => {
  // 用户五张英文歌词截图：`daze` ダゼ、`Shone` ショネ、`rime` リメ、`boon` ボオン、
  // `Hoo~` ホオ —— 全是蓝色的（罗马音层）。病根：这些词既不在离线词典、也不在
  // 英文词表里，罗马音层就按日语音节切开（da-ze / sho-ne / ri-me / bo-on / ho-o），
  // 还标成"确定"，层序里罗马音排在在线层前面，大模型也没机会纠。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Don't stand in a daze looking for a sign</p></li>
  <li class="line"><p>Shone on you and I</p></li>
  <li class="line"><p>Thaw winter's rime anew</p></li>
  <li class="line"><p>Woven memories your boon</p></li>
  <li class="line"><p>Hoo~</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );
  const l0 = pairsOf(ps[0]);
  assert.strictEqual(l0.get("daze"), "デイズ", JSON.stringify([...l0]));
  assert.strictEqual(l0.get("stand"), "スタンド");
  assert.strictEqual(l0.get("looking"), "ルッキング");
  assert.strictEqual(l0.get("sign"), "サイン");
  const l1 = pairsOf(ps[1]);
  assert.strictEqual(l1.get("Shone"), "ショーン", JSON.stringify([...l1]));
  const l2 = pairsOf(ps[2]);
  assert.strictEqual(l2.get("rime"), "ライム", JSON.stringify([...l2]));
  assert.strictEqual(l2.get("anew"), "アニュー");
  assert.strictEqual(l2.get("Thaw"), "ソー");
  const l3 = pairsOf(ps[3]);
  assert.strictEqual(l3.get("boon"), "ブーン", JSON.stringify([...l3]));
  assert.strictEqual(l3.get("Woven"), "ウォーヴン");
  const l4 = pairsOf(ps[4]);
  assert.strictEqual(l4.get("Hoo"), "フー", JSON.stringify([...l4]));
  // 来源是词典（绿色、确定），不再是罗马音层的猜测
  assert.strictEqual(env.api.read("daze").source, "dict");
  assert.strictEqual(env.api.read("daze").confident, true);
  assert.strictEqual(env.api.read("boon").kana, "ブーン");
});

test("全角西文字母也注音（`こんなんじゃ（ＮＯ!）` → ＮＯ ノー）", async () => {
  // 用户截图：歌词里的 `ＮＯ` 是全角的（排版写法），原来一个注音都没有 ——
  // matcher 只认半角字母。现在全角折半角再查，底字仍旧是原文（一个字符不改）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>こんなんじゃ（ＮＯ!）</p></li>
  <li class="line"><p>光こうならＤＲＥＡＭ</p></li>
  <li class="line"><p>no と NO と ＮＯ</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(500);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  assert.deepStrictEqual(PAIRS(ps[0]), [["\uFF2E\uFF2F", "ノー"]], ps[0].innerHTML);
  assert.strictEqual(baseText(ps[0]), "こんなんじゃ（ＮＯ!）", "原文一字不改（还是全角）");
  assert.deepStrictEqual(PAIRS(ps[1]), [["\uFF24\uFF32\uFF25\uFF21\uFF2D", "ドリーム"]], ps[1].innerHTML);
  // 半角和全角读同一个音
  const l2 = new Map(
    [...ps[2].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(l2.get("no"), "ノー", JSON.stringify([...l2]));
  assert.strictEqual(l2.get("NO"), "ノー");
  assert.strictEqual(l2.get("\uFF2E\uFF2F"), "ノー");
  assert.strictEqual(env.api.display("\uFF2E\uFF2F"), "ノー", "控制台 WK.display 也认全角");
});

test("ASCII art / 颜文字行不标；数字后面的单位字母要标；打码旁边的重复字母串留白", async () => {
  // 用户四张截图：图案行 `~i.!.|| i !!i !!~` 和颜文字行 `( ﾟ∀ﾟ)o彡ﾟ えーりん！` 里的字母
  // 被标了注音（都该留白）；`VOX AC30W` 里数字后面的 W 一个注音都没有（该读 ワット）；
  // `とめらんない本能 俺の XXX !` 里 XXX 贴着打码符号，也不该读 エックス。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>~i.!.|| i !!i !!~</p></li>
  <li class="line"><p>( ﾟ∀ﾟ)o彡ﾟ えーりん！えーりん！</p></li>
  <li class="line"><p>VOX AC30W</p></li>
  <li class="line"><p>とめらんない本能 俺の XXX ****! ****! Say Good Bye</p></li>
  <li class="line"><p>100V と 5A と 30W の電源</p></li>
  <li class="line"><p>Wow!!! すごいね!!!</p></li>
  <li class="line"><p>(A, B) 退屈に打つ QTE</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );
  // 图案行、颜文字行：整行零注音，底字不动
  assert.strictEqual(rubyCount(ps[0]), 0, "图案行不该注音：" + ps[0].innerHTML);
  assert.strictEqual(baseText(ps[0]), "~i.!.|| i !!i !!~");
  assert.strictEqual(rubyCount(ps[1]), 0, "颜文字行不该注音：" + ps[1].innerHTML);
  assert.strictEqual(baseText(ps[1]), "( ﾟ∀ﾟ)o彡ﾟ えーりん！えーりん！");
  // 数字后面的单位字母
  const l2 = pairsOf(ps[2]);
  assert.strictEqual(l2.get("W"), "ワット", "30W 的 W 该读 ワット：" + ps[2].innerHTML);
  // 打码旁边的重复字母串留白，同行的普通词照标
  const l3 = pairsOf(ps[3]);
  assert.strictEqual(l3.get("XXX"), undefined, "XXX 旁边就是 ****，该留白：" + ps[3].innerHTML);
  assert.strictEqual(l3.get("Say"), "セイ");
  assert.strictEqual(l3.get("Good"), "グッド");
  assert.strictEqual(l3.get("Bye"), "バイ");
  // 反面：数字本身不是"图案"，单位照标；`Wow!!!` 这种正常行照标
  const l4 = pairsOf(ps[4]);
  assert.strictEqual(l4.get("V"), "ボルト", JSON.stringify([...l4]));
  assert.strictEqual(l4.get("A"), "アンペア");
  assert.strictEqual(l4.get("W"), "ワット");
  assert.strictEqual(pairsOf(ps[5]).get("Wow"), "ワウ", "正常歌词行不能被当成图案");
  // 反面：`(A, B)` 仍读字母名（符号只有 3 个，不够"图案"）
  const l6 = pairsOf(ps[6]);
  assert.strictEqual(l6.get("A"), "エー", JSON.stringify([...l6]));
  assert.strictEqual(l6.get("B"), "ビー");
});

test("全大写缩写贴着数字是字母名：AM6:00 -> エーエム（英语单词 am 不许抢）", async () => {
  // 用户截图：`AM6:00 目覚まし時計を起こして` 的 AM 被离线词典里的英语单词 `am`（アム）
  // 接走了 —— 词典键都是小写，分不清 `am` / `AM`。全大写又紧贴数字的是缩写
  // （时刻 / 型号），这一判排在词典前面。
  // 反面：全大写写的真词贴着数字照旧走词典（LOVE2 -> ラブ、HEY3 -> ヘイ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>AM6:00 目覚まし時計を起こして</p></li>
  <li class="line"><p>PM11:30 の電車に飛び乗る</p></li>
  <li class="line"><p>MP3 を聴きながら</p></li>
  <li class="line"><p>LOVE2 なんてない</p></li>
  <li class="line"><p>HEY3 なんて呼ばないで</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  const l0 = pairsOf(ps[0]);
  assert.strictEqual(l0.get("AM"), "エーエム", "AM6:00 的 AM 该读字母名：" + ps[0].innerHTML);
  const l1 = pairsOf(ps[1]);
  assert.strictEqual(l1.get("PM"), "ピーエム", "PM11:30 的 PM 该读字母名：" + ps[1].innerHTML);
  const l2 = pairsOf(ps[2]);
  assert.strictEqual(l2.get("MP"), "エムピー", "MP3 的 MP 该读字母名：" + ps[2].innerHTML);
  // 反面：全大写的真词贴数字不许逐字母念
  const l3 = pairsOf(ps[3]);
  assert.strictEqual(l3.get("LOVE"), "ラブ", "LOVE2 是词，不是缩写：" + ps[3].innerHTML);
  const l4 = pairsOf(ps[4]);
  assert.strictEqual(l4.get("HEY"), "ヘイ", "HEY3 是词，不是缩写：" + ps[4].innerHTML);
});

test("西里尔全大写缩写逐字母读：СССР -> エスエスエスエル（不是 スル）", async () => {
  // 用户截图：苏联国歌那几行的 `СССР` 被读成 スル —— 俄语引擎把它当词，
  // 又按正字法把三个 С 并成一个，于是只剩 С+Р。缩写不是词：西里尔全大写、
  // 又没有元音的（СССР / РФ / КГБ）逐字母读，和拉丁的 SOS エスオーエス 同一个口径；
  // 带元音的（`ГИМН` ギムン）照旧当词。同一条截图上的长音/软化问题也在这一轮改了：
  // Государственный ゴスダールストヴェンヌイ（人工借词表核的长音）、
  // Александров アレクサンドロフ（词尾 в 清音化、д 连缀不再 ドゥ、л+е 不写 リェ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>ГИМН СССР</p></li>
  <li class="line"><p>РФ と КГБ の話</p></li>
  <li class="line"><p>А. В. Александров</p></li>
  <li class="line"><p>Государственный гимн СССР</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  const l0 = pairsOf(ps[0]);
  assert.strictEqual(l0.get("СССР"), "エスエスエスエル", "ССР 该逐字母读：" + ps[0].innerHTML);
  assert.strictEqual(l0.get("ГИМН"), "ギムン", "带元音的不是缩写，照旧当词：" + ps[0].innerHTML);
  const l1 = pairsOf(ps[1]);
  assert.strictEqual(l1.get("РФ"), "エルエフ", "РФ 该逐字母读：" + ps[1].innerHTML);
  assert.strictEqual(l1.get("КГБ"), "カーゲーベー", "КГБ 该逐字母读：" + ps[1].innerHTML);
  const l2 = pairsOf(ps[2]);
  assert.strictEqual(l2.get("Александров"), "アレクサンドロフ", "词尾 в 清音化、д 连缀读 ド：" + ps[2].innerHTML);
  const l3 = pairsOf(ps[3]);
  assert.strictEqual(l3.get("Государственный"), "ゴスダールストヴェンヌイ", "нн 收拨音 + 人工核的长音：" + ps[3].innerHTML);
  assert.strictEqual(l3.get("гимн"), "ギムン");
  assert.strictEqual(l3.get("СССР"), "エスエスエスエル");
});

test("ツイッター只在 `Xだけの…` 那一句命中；别的 X 照旧字母名/留白", async () => {
  // 用户点名：`Xだけの"人マニア"` 的 X 要读 ツイッター（官方翻译那行写着 X(Twitter)），
  // 但只在这一句歌词命中 —— 别的行里孤立的 X 不许跟着变。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Xだけの"人マニア"</p></li>
  <li class="line"><p>X だけの"人マニア"</p></li>
  <li class="line"><p>X が導く</p></li>
  <li class="line"><p>X線の写真とX軸</p></li>
  <li class="line"><p>(X, Y) の座標</p></li>
  <li class="line"><p>X marks the spot</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  assert.strictEqual(pairsOf(ps[0]).get("X"), "ツイッター", "这一句的 X 要读 ツイッター：" + ps[0].innerHTML);
  assert.strictEqual(pairsOf(ps[1]).get("X"), "ツイッター", "带空格的那句也算：" + ps[1].innerHTML);
  assert.strictEqual(pairsOf(ps[2]).size, 0, "别的行里孤立的 X 不许跟着变 ツイッター：" + ps[2].innerHTML);
  const l3 = [...ps[3].querySelectorAll("ruby.wk-ruby")].map((r) => r.querySelector(".wk-rt").textContent);
  assert.deepStrictEqual(l3, ["エックス", "エックス"], "X線 / X軸 是字母 X：" + ps[3].innerHTML);
  assert.strictEqual(pairsOf(ps[4]).get("X"), "エックス", "成串的 X 读字母名：" + ps[4].innerHTML);
  assert.strictEqual(pairsOf(ps[5]).get("X"), "エックス", "英文句子里的 X 读字母名：" + ps[5].innerHTML);
});

test("整首专属读音：`the EmpErroR` 里 the 读 ジ（官方 ジエンペラー）", async () => {
  // 这一档的读音来自官方歌名读音（tools/vendor/sekai/musics.json），按词切开后
  // 只在这一首里生效：`the EmpErroR` 官方读 ジエンペラー —— 标题里的 `the` 就是 ジ，
  // 而默认层会给 ザ（词典）。判据两条：歌名命中（播放栏那行），
  // 或者歌名读不到时靠歌词里的识别词（这里用歌名里独特的 `EmpErroR` 写法）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-playbar"><div class="words">
    <span class="name"><a href="#">the EmpErroR</a></span>
    <span class="by"><a href="#">sasakure.UK</a></span>
  </div></div>
  <div class="m-lyric"><ul class="lyric">
    <li class="line"><p>the EmpErroR が笑う</p></li>
  </ul></div>
</div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );
  const l0 = pairsOf(ps[0]);
  assert.strictEqual(l0.get("the"), "ジ", "这首里 the 是 ジ：" + ps[0].innerHTML);
  assert.strictEqual(l0.get("EmpErroR"), "エンペラー", "EmpErroR 是 エンペラー：" + ps[0].innerHTML);
  // 来源是专属读音表（不是词典 / 模型），而且不许是"暂定"
  assert.ok(/wk-src-song/.test(ps[0].innerHTML), "来源应当是 song：" + ps[0].innerHTML);
  assert.ok(!/wk-pending/.test(ps[0].innerHTML), "官方读音不该是暂定");
});

test("整首专属读音只在那一首里生效：别的歌里 No 照旧读 ノー", async () => {
  // 同一行歌词，换个歌名就不该吃那张表（`Disco No.39` 官方把 No. 读成 ナンバー）
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-playbar"><div class="words">
    <span class="name"><a href="#">Disco No.39</a></span>
    <span class="by"><a href="#">sasakure.UK</a></span>
  </div></div>
  <div class="m-lyric"><ul class="lyric">
    <li class="line"><p>No.39 のディスコ</p></li>
  </ul></div>
</div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(500);
  const p = env.document.querySelector("ul.lyric li p");
  const got = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  assert.deepStrictEqual(got, [["No", "ナンバー"]], "这一首里 No. 是 ナンバー：" + p.innerHTML);

  const HTML2 = HTML.replace("Disco No.39", "別の歌");
  const env2 = bootPlugin(HTML2, { config: { online: false, llmEnabled: false } });
  await env2.runLoad();
  await sleep(500);
  const p2 = env2.document.querySelector("ul.lyric li p");
  const got2 = [...p2.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  assert.deepStrictEqual(got2, [["No", "ノー"]], "别的歌里 No 不许跟着变 ナンバー：" + p2.innerHTML);
});

test("连字符标记长音：`MO-SO` / `KYO-SO` / 换行拆开的 `SO-` + `ZO` 都读长音", async () => {
  // 用户点名要的通用规则（不针对某一首歌）：全大写、形如罗马字音节、被短横线串起来的，
  // 每一节都读长音 —— `MO-SO` モーソー、`SO-ZO` ソーゾー、`KYO-SO` キョーソー。
  // 扫描范围是整首歌词：这种词常被换行拆开（上一行结尾 `SO-`、下一行开头 `ZOは海をこえ`），
  // 只看一行的话 `ZO` 那行自己什么线索都没有（罗马音层会给 ゾ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>夢限大 MO-SOは風にのり</p></li>
  <li class="line"><p>夢限大 SO-ZOは海をこえ</p></li>
  <li class="line"><p>ZOは海をこえ</p></li>
  <li class="line"><p>夢限大 KYO-SOは宇宙行き</p></li>
  <li class="line"><p>Looser-Krankheit-Was の話</p></li>
  <li class="line"><p>Looser の話</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  const l0 = pairsOf(ps[0]);
  assert.strictEqual(l0.get("MO"), "モー", "MO-SO 的 MO：" + ps[0].innerHTML);
  assert.strictEqual(l0.get("SO"), "ソー", "MO-SO 的 SO");
  assert.strictEqual(pairsOf(ps[1]).get("ZO"), "ゾー", "SO-ZO 的 ZO：" + ps[1].innerHTML);
  // 换行拆开的那行也吃这条规则（整首扫描）
  assert.strictEqual(pairsOf(ps[2]).get("ZO"), "ゾー", "单独一行的 ZO 也是长音：" + ps[2].innerHTML);
  assert.strictEqual(pairsOf(ps[3]).get("KYO"), "キョー", "KYO-SO 的 KYO：" + ps[3].innerHTML);
  // 反面：德语复合词（混合大小写、音节长）不许被这条规则带跑 ——
  // 和"没有连字符的那一行"读出来必须一模一样
  const de = pairsOf(ps[4]);
  assert.ok(!/\u30FC$/.test(de.get("Krankheit") || ""), "Krankheit 不该被加长音：" + ps[4].innerHTML);
  assert.strictEqual(de.get("Looser"), pairsOf(ps[5]).get("Looser"), "连字符串里的 Looser 要和普通行一样：" + ps[4].innerHTML);
});

test("整首专属读音：歌名里含假名/汉字/符号的也按表读（potato ポテト / bit ビット）", async () => {
  // 官方读音是整首歌名的，遇到"西文 + 假名汉字"混排时，切分靠假名段锚定
  // （假名的读音就是它自己），汉字/数字/符号当通配段。这两条就是自动切出来的。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-playbar"><div class="words">
    <span class="name"><a href="#">potatoになっていく</a></span>
    <span class="by"><a href="#">Neru</a></span>
  </div></div>
  <div class="m-lyric"><ul class="lyric">
    <li class="line"><p>potatoになっていく</p></li>
    <li class="line"><p>bit の話</p></li>
  </ul></div>
</div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(500);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const p0 = [...ps[0].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  assert.deepStrictEqual(p0, [["potato", "ポテト"]], "potato 该按整首表读：" + ps[0].innerHTML);
  // 别的歌名不命中时，bit 照旧走词典/规则（不是这张表的事）
  assert.ok(!/bit/.test(ps[1].innerHTML) || !/wk-src-song/.test(ps[1].innerHTML), "别的歌里 bit 不该吃整首表：" + ps[1].innerHTML);
});

test("缩写与单字母的四张截图：LV レベル / Я ヤー / A A A A A エー / feat. フィーチャリング", async () => {
  // 四张用户截图：
  //   ① `LVあげすぎて` 的 LV 被逐字母读成 エルブイ —— 日语里 LV 就是 level，读 レベル；
  //   ② `Я らりぱっぱ…` 的 Я（西里尔）一个注音都没有 —— 不是俄语行，按字母名读 ヤー；
  //   ③ `A A A A A じゃないか` 的每个 A 被读成 アンペア —— 单位那条判据要的是
  //      "两种以上不同的单位符号"（`（V, W, A）` ✓），同一个字母重复是字母名 エー；
  //   ④ `“feat. きみ”を ねえ` 的 feat. 被规则层读成 フェアット —— 该读 フィーチャリング。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>LVあげすぎて スラ</p></li>
  <li class="line"><p>Я らりぱっぱらっぱっぱらっぱ</p></li>
  <li class="line"><p>A A A A A じゃないか</p></li>
  <li class="line"><p>“feat. きみ”を ねえ</p></li>
  <li class="line"><p>100V と 5A と 30W</p></li>
  <li class="line"><p>（V, W, A）</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  assert.strictEqual(pairsOf(ps[0]).get("LV"), "レベル", "LV 该读 レベル：" + ps[0].innerHTML);
  assert.strictEqual(pairsOf(ps[1]).get("Я"), "ヤー", "单个西里尔字母按字母名读：" + ps[1].innerHTML);
  const aa = [...ps[2].querySelectorAll("ruby.wk-ruby")].map((r) => r.querySelector(".wk-rt").textContent);
  assert.deepStrictEqual(aa, ["エー", "エー", "エー", "エー", "エー"], "重复的 A 是字母名：" + ps[2].innerHTML);
  assert.strictEqual(pairsOf(ps[3]).get("feat"), "フィーチャリング", "feat. 该读 フィーチャリング：" + ps[3].innerHTML);
  // 反面：数字后面的单位字母、以及"几种不同的单位符号排成一串"照旧读单位名
  const unit = pairsOf(ps[4]);
  assert.strictEqual(unit.get("V"), "ボルト", "100V 仍是 ボルト：" + ps[4].innerHTML);
  assert.strictEqual(unit.get("A"), "アンペア", "5A 仍是 アンペア：" + ps[4].innerHTML);
  assert.strictEqual(unit.get("W"), "ワット", "30W 仍是 ワット：" + ps[4].innerHTML);
  const list = pairsOf(ps[5]);
  assert.strictEqual(list.get("V"), "ボルト", "（V, W, A）仍是单位名：" + ps[5].innerHTML);
  assert.strictEqual(list.get("W"), "ワット");
  assert.strictEqual(list.get("A"), "アンペア");
});

test("拆行 DOM 里的单字母 / 颜文字里的 b / 点号记法是罗马字单词", async () => {
  // 用户三张截图：
  //   ① `T氏にすべてを捧げましょう` 的 T 一直没注音 —— 真机上行被拆成了好几个节点
  //      （逐字歌词，或者别的注音插件给 `氏` 包了 `<ruby>`），T 自己成了一个长度 1 的
  //      文本节点，被"太短就跳过"那条挡掉了，而且语境里也没有假名；
  //   ② `:-b ;-b boy, :-b ;-b` 里的 b 没注音 —— 它算"粘着分隔符的单字母"，被当成
  //      `A.` 那种排版噪声；用户要它标（ビー）；
  //   ③ `K・A・I・S・A・N!` 被逐字母念成 ケーエー…，官方罗马音那行写的是 KAISAN ——
  //      拼起来是罗马字单词的记法整串交给罗马音层（カイサン），短的（`M・I・D・I`）
  //      照旧逐字母。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p><span class="fg-line">T<ruby class="fg-ruby">氏<rt>し</rt></ruby>にすべてを捧げましょう</span></p></li>
  <li class="line"><p>:-b ;-b boy, :-b ;-b</p></li>
  <li class="line"><p>K・A・I・S・A・N!</p></li>
  <li class="line"><p>M・I・D・I</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  assert.strictEqual(pairsOf(ps[0]).get("T"), "ティー", "拆行之后 T 也要注上：" + ps[0].innerHTML);
  const bs = [...ps[1].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  assert.deepStrictEqual(
    bs,
    [["b", "ボ"], ["b", "ボ"], ["boy", "ボーイ"], ["b", "ボ"], ["b", "ボ"]],
    "颜文字里的 b 要注音（读表情的音 ボ，不带长音）：" + ps[1].innerHTML
  );
  assert.strictEqual(pairsOf(ps[2]).get("K・A・I・S・A・N"), "カイサン", "整串是罗马字单词：" + ps[2].innerHTML);
  const midi = [...ps[3].querySelectorAll("ruby.wk-ruby")].map((r) => r.querySelector(".wk-rt").textContent);
  assert.deepStrictEqual(midi, ["エム", "アイ", "ディー", "アイ"], "短的记号照旧逐字母：" + ps[3].innerHTML);
});

test("混排歌词：字母夹在假名中间读默认音；逐字 / 原文+翻译的 DOM 也要注上", async () => {
  // 用户两张截图：
  //   ① `三日月の舟で(らLa ラR ア 羅rA 乱)`：这几个字母是在给前面的假名配罗马字
  //      （`らLa` = ララ、`ラR` = ララ、`羅rA` = ララ），所以 `ラR ア` 里的 R 读 ラ，
  //      不是字母名 アール；
  //   ② 另一首歌整页一个注音都没有：原文和中文翻译在同一个 <li> 的两个 <p> 里，
  //      语境取长的那个（两块拼起来），翻译里那几个全角标点就把整行凑成了
  //      "ASCII 图案"（符号 ≥ 6 个），于是 `ズ干Cャ` 整行被跳过。逐字歌词
  //      （一个字一个 `<span>`）本来也因为语境退化成宿主自己那一两个字而漏标。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>三日月の舟で(らLa ラR ア 羅rA 乱)</p></li>
  <li class="line"><p>(十枚)：、ズ干Cャ</p><p>（十枚）…、ズ干Cャ</p></li>
  <li class="line"><p>タイプRの車 / のRって何だっけ</p></li>
</ul></div>
<div class="lyric"><div class="rnp-lyrics">
  <div class="rnp-lyrics-line-karaoke"><span>(</span><span>十</span><span>枚</span><span>)</span><span>：</span><span>、</span><span>ズ</span><span>干</span><span>C</span><span>ャ</span></div>
</div></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (el) =>
    new Map(
      [...el.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  const first = pairsOf(ps[0]);
  assert.strictEqual(first.get("La"), "ラ", "`らLa` 的 La 读 ラ：" + ps[0].innerHTML);
  assert.strictEqual(first.get("R"), "ラ", "`ラR ア` 的 R 当假名用，读 ラ（不是 アール）：" + ps[0].innerHTML);
  assert.strictEqual(first.get("rA"), "ラ", "`羅rA` 的 rA 读 ラ：" + ps[0].innerHTML);

  assert.strictEqual(pairsOf(ps[1]).get("C"), "チ", "原文 + 翻译拼出来的语境别当成图案：" + ps[1].innerHTML);

  const karaoke = env.document.querySelector("div.rnp-lyrics-line-karaoke");
  assert.strictEqual(pairsOf(karaoke).get("C"), "チ", "逐字歌词（一个字一个 span）也要注上：" + karaoke.innerHTML);

  // 反面：正常的型号写法不能被这条规则吃掉（`タイプRの車` 是 アール）
  const third = [...env.document.querySelectorAll("ul.lyric li")[2].querySelectorAll("ruby.wk-ruby")].map(
    (r) => r.querySelector(".wk-rt").textContent
  );
  assert.deepStrictEqual(third, ["アール", "アール"], "型号 / 单独的 R 仍是字母名：" + ps[3].innerHTML);
});

test("连字符串：被切断的重复音（wa- ウェ / ar- ア / ni- ネ）与 Ex-Otogibanashi 的分工", async () => {
  // 用户逐条点名：
  //   ① `wa-wa-wait` 里的 `wa-` 是在重复 wait 的开头音 → ウェ（不是单独一个 wa 的 ワ）；
  //   ② `ar-ar-ar-ar` 里的 `ar-` → ア（不是字母名 アール）；
  //   ③ `Ni-ni-ni-ni-ni-` 里的 `ni-` → ネ；
  //   ④ `Ex-Otogibanashi`：`Ex` 罗马音层切不出来 → 逐字母 イーエックス，
  //      后半 `Otogibanashi` 交给罗马音层 → オトギバナシ（规则层会读成 …スヒ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>the process (wa-wa-wait)</p></li>
  <li class="line"><p>Up, up, ar-ar-ar-ar</p></li>
  <li class="line"><p>"go", why night? Ni-ni-ni-ni-ni-</p></li>
  <li class="line"><p>Ex-Otogibanashi</p></li>
  <li class="line"><p>I do my beat as thy- hy - hy - hy -)</p></li>
  <li class="line"><p>Looser-Krankheit-Was</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const rubies = (p) => [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);

  assert.deepStrictEqual(
    rubies(ps[0]).slice(-3),
    [["wa", "ウェ"], ["wa", "ウェ"], ["wait", "ウェイト"]],
    "wa- 是在重复 wait 的开头音：" + ps[0].innerHTML
  );
  assert.deepStrictEqual(
    rubies(ps[1]).slice(-4),
    [["ar", "ア"], ["ar", "ア"], ["ar", "ア"], ["ar", "ア"]],
    "ar- 读 ア：" + ps[1].innerHTML
  );
  assert.deepStrictEqual(
    rubies(ps[2]).slice(-5),
    [["Ni", "ネ"], ["ni", "ネ"], ["ni", "ネ"], ["ni", "ネ"], ["ni", "ネ"]],
    "ni- 读 ネ：" + ps[2].innerHTML
  );
  assert.deepStrictEqual(
    rubies(ps[3]),
    [["Ex", "イーエックス"], ["Otogibanashi", "オトギバナシ"]],
    "Ex 逐字母、后半走罗马音：" + ps[3].innerHTML
  );
  // `hy -`（空格 + 连字符的写法）读 アイ
  assert.deepStrictEqual(
    rubies(ps[4]).slice(-3),
    [["hy", "アイ"], ["hy", "アイ"], ["hy", "アイ"]],
    "hy- 读 アイ：" + ps[4].innerHTML
  );
  // 反面：整行是德语时，连字符串归德语引擎管（别被罗马音/字母名那条抢走）
  const de = rubies(ps[5]).map((r) => r[1]);
  assert.ok(
    de.indexOf("ワス") < 0 && de.indexOf("ダブリューエーエス") < 0,
    "德语行照旧走德语引擎：" + ps[5].innerHTML
  );
});

test("缩写展开与掩码词：OMG オーマイゴッド、被涂掉一个字的 T○itter ツイッター", async () => {
  // 用户两张截图：
  //   ① `OMG 情けない 最早` 的 OMG 要**展开**成 oh my god，不是逐字母 オーエムジー；
  //   ② `君へのT○itter` 的 `○` 是"一个字被涂掉"，整串仍是一个词 —— 按一个字母的通配
  //      去词典里找（t○itter → twitter 唯一命中）→ ツイッター，而不是拆成 T + itter。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>OMG 情けない 最早</p></li>
  <li class="line"><p>君へのT○itter</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(500);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const rubies = (p) => [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);

  assert.deepStrictEqual(rubies(ps[0]), [["OMG", "オーマイゴッド"]], "OMG 要展开：" + ps[0].innerHTML);
  assert.deepStrictEqual(rubies(ps[1]), [["T○itter", "ツイッター"]], "掩码词整串读：" + ps[1].innerHTML);
});

test("段标的冒号被拆到下一个节点时，A / B 仍然留白", async () => {
  // 用户截图：`Vindicia (A: Vanitatum sentio) (B: Sentio dolor, ah dolores)` 里
  // 的 A / B 被注成了 ア / ビー。真机上这一行被拆成了好几个节点（逐字/分段），
  // token 自己看不到冒号，段标判定失效 —— 现在会跨节点往后瞟一眼。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p><span>Vindicia (</span><span>A</span><span>: Vanitatum sentio) (</span><span>B</span><span>: Sentio dolor)</span></p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(500);
  const p = env.document.querySelector("ul.lyric li p");
  const got = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  const bases = got.map((g) => g[0]);
  assert.ok(bases.indexOf("A") < 0 && bases.indexOf("B") < 0, "段标 A / B 不该注音：" + JSON.stringify(got));
  assert.ok(bases.indexOf("Vanitatum") >= 0, "同行的词照常标：" + JSON.stringify(got));
});

test("单个大写字母贴日文/在英文句子里要标；数字后面的单位词；`PV:` 算制作信息行", async () => {
  // 用户三张截图：`T氏にすべてを捧げましょう` 和 `T Is My Everything` 里的单字母 T
  // 一个注音都没有（该 ティー）；`半径300mmの体で必死に鳴いてる` 的 `mm` 没注音
  // （那首歌罗马音行唱的就是 mi ri）；`PV: 羽生まゐご`（上一行是 `曲絵: 瀬川あをじ`）
  // 两行都是制作信息，PV 不该标。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>T氏にすべてを捧げましょう</p></li>
  <li class="line"><p>T Is My Everything</p></li>
  <li class="line"><p>半径300mmの体で必死に鳴いてる</p></li>
  <li class="line"><p>曲絵: 瀬川あをじ</p></li>
  <li class="line"><p>PV: 羽生まゐご</p></li>
  <li class="line"><p>A story of love and I</p></li>
  <li class="line"><p>B面の曲と X線</p></li>
  <li class="line"><p>mm~ と 5kg と 60Hz と 3km</p></li>
  <li class="line"><p>Music と light の 中</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );
  // 紧贴日文的单字母和英文句子里的单字母
  assert.strictEqual(pairsOf(ps[0]).get("T"), "ティー", "T氏 的 T 该读 ティー：" + ps[0].innerHTML);
  assert.strictEqual(baseText(ps[0]), "T氏にすべてを捧げましょう");
  const l1 = pairsOf(ps[1]);
  assert.strictEqual(l1.get("T"), "ティー", JSON.stringify([...l1]));
  assert.strictEqual(l1.get("Everything"), "エブリシング");
  // 数字后面的单位词
  assert.strictEqual(pairsOf(ps[2]).get("mm"), "ミリ", "300mm 该读 ミリ：" + ps[2].innerHTML);
  // 两行制作信息都不标
  assert.strictEqual(rubyCount(ps[3]), 0, "`曲絵:` 行不该注音：" + ps[3].innerHTML);
  assert.strictEqual(rubyCount(ps[4]), 0, "`PV:` 行不该注音：" + ps[4].innerHTML);
  // 反面：A / I 仍是冠词 / 代词；单字母贴日文另有 B面 / X線
  const l5 = pairsOf(ps[5]);
  assert.strictEqual(l5.get("A"), "ア", JSON.stringify([...l5]));
  assert.strictEqual(l5.get("I"), "アイ");
  const l6 = pairsOf(ps[6]);
  assert.strictEqual(l6.get("B"), "ビー", JSON.stringify([...l6]));
  assert.strictEqual(l6.get("X"), "エックス");
  // 反面：`mm~`（语气词）不标；带数字的单位词照标
  const l7 = pairsOf(ps[7]);
  assert.strictEqual(l7.get("mm"), undefined, "mm~ 不是单位：" + ps[7].innerHTML);
  assert.strictEqual(l7.get("kg"), "キロ");
  assert.strictEqual(l7.get("Hz"), "ヘルツ");
  assert.strictEqual(l7.get("km"), "キロ");
  // 反面：`Music と light` 这种正常歌词行不能被制作信息误杀
  assert.strictEqual(pairsOf(ps[8]).get("Music"), "ミュージック", "正常歌词行不能被误杀");
});

test("`AH!!` 读 アー（不是字母名）、`B4` 的 B 读 ビー、`tofu` 读 トウフ", async () => {
  // 用户三张截图：`ゆらゆら (AH!!)` 的 `AH` 被 spellOutAcronym 逐字母读成 エーエイチ（该 アー）；
  // `B4の紙切れに収まる僕の人生を` 的 `B` 一个注音都没有（该 ビー）；
  // `my tofu mentality` 的 `tofu` 被罗马音层读成 トフ（该 トウフ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>ゆらゆら (AH!!)</p></li>
  <li class="line"><p>B4の紙切れに収まる僕の人生を</p></li>
  <li class="line"><p>I wanna change change change my tofu mentality</p></li>
  <li class="line"><p>A4 と 2B と 30W と 100V</p></li>
  <li class="line"><p>A story of love and I</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );
  // 感叹词：有元音的 2~3 字母缩写靠"词典里有这个词"挡住（ah / oh / uh）
  assert.strictEqual(pairsOf(ps[0]).get("AH"), "アー", "AH 该读 アー：" + ps[0].innerHTML);
  // 紧挨数字的单字母读字母名
  assert.strictEqual(pairsOf(ps[1]).get("B"), "ビー", "B4 该读 ビー：" + ps[1].innerHTML);
  // 罗马音层抢读的日式英语词
  const l2 = pairsOf(ps[2]);
  assert.strictEqual(l2.get("tofu"), "トウフ", JSON.stringify([...l2]));
  assert.strictEqual(l2.get("mentality"), "メンタリティー");
  // 反面：单位符号挨着数字的仍走单位（不是字母名）
  const l3 = pairsOf(ps[3]);
  assert.strictEqual(l3.get("A"), "エー", "A4 的 A 该读 エー：" + ps[3].innerHTML);
  assert.strictEqual(l3.get("B"), "ビー");
  assert.strictEqual(l3.get("W"), "ワット", "30W 仍是单位，不是 ダブリュー");
  assert.strictEqual(l3.get("V"), "ボルト");
  // 反面：冠词 A / 代词 I 不受影响
  const l4 = pairsOf(ps[4]);
  assert.strictEqual(l4.get("A"), "ア", JSON.stringify([...l4]));
  assert.strictEqual(l4.get("I"), "アイ");
});

test("用户报的那行：D/N/A 逐字母读，不能当成英文冠词读成 ア", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>だって D/N/Aじゃ 騙れない</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  // 记号一个字母一个 ruby，读音是字母名；不是把 A 单独读成 ア
  assert.deepStrictEqual(PAIRS(p), [
    ["D", "ディー"],
    ["N", "エヌ"],
    ["A", "エー"],
  ]);
  assert.strictEqual(baseText(p), "だって D/N/Aじゃ 騙れない", "原文一字不改");
  // 来源是字母名那一层（`letters`）：类名一直在，颜色只由开关决定
  const first = p.querySelector("ruby.wk-ruby");
  assert.ok(/wk-src-letters/.test(first.className), "应该记在 letters 这一类上：" + first.className);
});

test("用户报的那行：`M・I・D・I` 分别注在每个字母上（不是压一整条）", async () => {
  // 用户截图：播放栏歌名 `M·I·D·I` 上面压着一整条 `エムアイディーアイ`，
  // 和每个字母对不上 —— "能不能分别注在每个字母上"。
  // 中间点三种写法（`・` U+30FB / `·` U+00B7 / `•` U+2022）都要认。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-playbar"><div class="words"><span class="name"><a href="#">M\u30FBI\u30FBD\u30FBI</a></span></div></div>
  <div class="m-lyric"><ul class="lyric">
    <li class="line"><p>R&B と M\u00B7I\u00B7D\u00B7I と M\u2022I\u2022D\u2022I</p></li>
  </ul></div>
</div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(600);

  const title = env.document.querySelector(".m-playbar .name");
  assert.deepStrictEqual(PAIRS(title), [
    ["M", "エム"],
    ["I", "アイ"],
    ["D", "ディー"],
    ["I", "アイ"],
  ]);

  // `R&B`：`&` 是唯一有读音的分隔符，自己一个 ruby（アンド）
  const line = env.document.querySelector("ul.lyric li p");
  const pairs = PAIRS(line);
  assert.deepStrictEqual(pairs.slice(0, 3), [
    ["R", "アール"],
    ["&", "アンド"],
    ["B", "ビー"],
  ]);
  assert.deepStrictEqual(
    pairs.slice(3).map((x) => x[0]),
    ["M", "I", "D", "I", "M", "I", "D", "I"]
  );
  assert.strictEqual(baseText(line), "R&B と M\u00B7I\u00B7D\u00B7I と M\u2022I\u2022D\u2022I", "原文一字不改");
});

test("控制台诊断：WK 短别名存在，llm.check() 能一句话回答「生效了没有」", async () => {
  const env = bootPlugin();
  await env.runLoad();

  assert.strictEqual(typeof env.window.WK, "object", "文档里写的是 WK.xxx，别名必须挂上");
  assert.strictEqual(env.window.WK, env.window.WesternKatakana, "长名和短名应该是同一个对象");
  // 改名前的两个名字留着当别名（老文档 / 老脚本里是它们）
  assert.strictEqual(env.window.WK, env.window.LK);
  assert.strictEqual(env.window.WK, env.window.LatinKatakana);
  assert.strictEqual(typeof env.window.WK.llm.check, "function");

  // 没填 key：check() 要说清是"没填 key"，而不是含糊的"没生效"
  const noKey = env.window.WK.llm.check();
  assert.ok(noKey.indexOf("API Key：没填") >= 0, noKey);
  assert.ok(noKey.indexOf("填 API Key") >= 0, noKey);

  // 填了 key 但还没问过任何词（歌词里的词全在词典里）：要解释"这层没活干"，而不是让人以为坏了
  env.window.WK.state.llm.configure({ key: "sk-test", enabled: true });
  const idle = env.window.WK.llm.check();
  assert.ok(idle.indexOf("请求 0 次") >= 0, idle);
  assert.ok(idle.indexOf("全在离线词典里") >= 0, idle);
});

test("控制台诊断：WK.display() 给的是页面上实际用的读音（可能是大模型换过的）", async () => {
  const env = bootPlugin(LLM_HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions" },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = it.w === "kaleidoscope" ? "カレイドスコープ" : "ダミー";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1400);

  // 本地规则给的是一个拼出来的读音，display() 应该是大模型换上的那个
  const local = env.window.WK.read("kaleidoscope");
  assert.strictEqual(local.source, "rule", "前提：词典里没有这个词：" + JSON.stringify(local));
  assert.strictEqual(env.window.WK.display("kaleidoscope"), "カレイドスコープ");
  assert.notStrictEqual(env.window.WK.display("kaleidoscope"), local.kana, "display 和 read 应该不一样");

  const verdict = env.window.WK.llm.check();
  assert.ok(verdict.indexOf("已经生效") >= 0, verdict);
});

test("用户报的那行：带变音符号的 Ō 也要注音（Tōkyō -> トーキョー）", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>Tōkyōの夜を arigatō と歌う</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  assert.deepStrictEqual(PAIRS(p), [
    ["Tōkyō", "トーキョー"],
    ["arigatō", "アリガトー"],
  ]);
  assert.strictEqual(baseText(p), "Tōkyōの夜を arigatō と歌う", "原文一字不改");
});

test("用户报的缩写：Mr. / Dr. 念整个词，LDK 这类缩写逐字母读", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>Mr. Brown と Dr. K、それから LDK の部屋</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  /*
   * `Dr. K` 的 `K` 现在也读 ケー：单个大写字母只要"同一行还有别的西文词"就按字母名读
   * （用户后来的截图：`T Is My Everything` 的 T 要 ティー）—— `Dr. K` = ドクター・ケー，
   * 日语也是这么念的。
   */
  assert.deepStrictEqual(PAIRS(p), [
    ["Mr", "ミスター"],
    ["Brown", "ブラウン"],
    ["Dr", "ドクター"],
    ["K", "ケー"],
    ["LDK", "エルディーケー"],
  ]);
  assert.strictEqual(baseText(p), "Mr. Brown と Dr. K、それから LDK の部屋", "原文（含句点）一字不改");
});

test("层序：在线那层还在问时先用暂定读音顶上（不空着），失败后转为确定值", async () => {
  // 层序：大模型 -> 免费接口 -> 英文音译规则。等待期间不去"先不标"（那样整行会空着、
  // 而且首词所在节点已有记录、后面也补不回来），而是先用规则读音当暂定值，
  // 标注上会带一个淡一点的标记；接口失败/给不出之后它就是最终值。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>きらめく kaleidoscope の夜</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML); // 默认桩：所有请求都失败（离线）
  await env.runLoad();
  await sleep(300);

  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(rubyCount(p), 1, "等待期间也要注上（暂定），不能空着");
  assert.ok(p.querySelector("ruby.wk-ruby").classList.contains("wk-pending"), "要标成暂定");
  assert.strictEqual(baseText(p), "きらめく kaleidoscope の夜", "底字不动");

  // 免费接口的攒批窗口 1.2s + 请求失败 -> 之后转为确定（规则读音），但不能消失
  await sleep(2600);
  assert.strictEqual(rubyCount(p), 1, "接口失败后注音不许消失：" + p.innerHTML);
  assert.ok(!p.querySelector("ruby.wk-ruby").classList.contains("wk-pending"), "已经有结论了，不再是暂定");
});

test("层序：完全离线设置（关掉联网）时规则立刻生效，不等任何请求", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>きらめく kaleidoscope の夜</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(rubyCount(p), 1, "没有在线可用时不该等：" + p.innerHTML);
});

test("层序可调：把英文规则提到在线层前面 = 一个请求都不发", async () => {
  // 用户把「英文音译规则」拖到大模型/免费接口上面，就是"纯离线，别联网"的用法。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>きらめく kaleidoscope の夜</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  let called = 0;
  const env = bootPlugin(HTML, {
    // 大模型配了 key（这层可用），免费接口也开着 —— 但只要规则排在它们前面，
    // 这两个请求都不该发出去
    config: {
      llmEnabled: true,
      llmKey: "sk-test",
      llmEndpoint: "https://api.example.com/v1/chat/completions",
      layerOrder: ["dict", "romaji", "rule", "llm", "google"],
    },
    fetch: function () {
      called++;
      return Promise.reject(new Error("offline (test)"));
    },
  });
  await env.runLoad();
  await sleep(1600); // 超过攒批窗口，够任何"想联网"的实现发请求了

  assert.strictEqual(called, 0, "规则排在在线层前面时不许发请求");
  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(rubyCount(p), 1, "规则照样要注上：" + p.innerHTML);
  assert.ok(!p.querySelector("ruby.wk-ruby").classList.contains("wk-pending"), "轮不到在线层，不存在暂定");
  const s = env.api.stats();
  assert.strictEqual(s.llm.requests, 0, "大模型一次都没问");
});

test("层序可调：把大模型提到词典前面，词典命中的词也会被模型改写", async () => {
  // 词典偶有错条目（tick / ave 这类用户报过的），这是逃生门：
  // 把大模型排到词典上面，词典命中的词也交给它判一遍。
  const requests = [];
  const env = bootPlugin(LLM_HTML, {
    config: {
      llmEnabled: true,
      llmKey: "sk-test",
      llmEndpoint: "https://api.example.com/v1/chat/completions",
      layerOrder: ["llm", "dict", "romaji", "google", "rule"],
    },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      requests.push(items.map((it) => it.w));
      const out = {};
      items.forEach((it, i) => {
        // 必须给合法片假名：读音会被 looksLikeTransliteration 校验，
        // 带全角括号这种"不是音译"的答案会被丢掉（那正是那层该干的事）
        out[String(i + 1)] = it.w === "light" ? "レフト" : "カレイドスコープ";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1400);

  const words = [].concat.apply([], requests);
  assert.ok(words.indexOf("light") >= 0, "词典命中的 light 也要问（它排在模型下面）：" + words.join(","));
  const p = env.document.querySelector("ul.lyric li p");
  const got = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  assert.deepStrictEqual(
    got,
    [
      ["kaleidoscope", "カレイドスコープ"],
      ["light", "レフト"],
    ],
    "两个词都要换成模型给的读音：" + JSON.stringify(got)
  );
  assert.strictEqual(baseText(p), "きらめく kaleidoscope の light");
});

test("层序可调：默认顺序下词典压过大模型（词典命中的词不进队列）", async () => {
  // 这是默认口径，上面那条测试正是它的反面 —— 两条一起钉住"顺序真的起作用"
  const requests = [];
  const env = bootPlugin(LLM_HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions" },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      requests.push(items.map((it) => it.w));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "カレイドスコープ";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1400);
  const words = [].concat.apply([], requests);
  assert.ok(words.indexOf("light") < 0, "默认顺序下词典命中不该问模型：" + words.join(","));
});

test("层序可调：设置面板的 ↑↓ 按钮能改顺序、落盘，并立刻重扫", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  // `[...]` 是必须的：WK.layers() 里那个数组来自 jsdom 的 realm，
  // 直接 deepStrictEqual 会因为原型不同而假报错
  assert.deepStrictEqual([...env.api.layers()], ["dict", "romaji", "llm", "google", "rule"], "默认顺序");

  const root = env.listeners.config[0]();
  const rows = root.querySelectorAll(".wk-layers .wk-layer");
  assert.strictEqual(rows.length, 5, "五层都要列出来：" + root.querySelector(".wk-layers").innerHTML);

  // 第一层的 ↓：词典和罗马音对调
  const down = rows[0].querySelector('[data-dir="down"]');
  assert.ok(down, "第一层要有 ↓ 按钮");
  down.dispatchEvent(new env.window.Event("click"));

  assert.deepStrictEqual([...env.api.layers()], ["romaji", "dict", "llm", "google", "rule"], "点完就要换过来");
  const saved = JSON.parse(env.window.localStorage.getItem("western-katakana.config"));
  assert.deepStrictEqual(saved.layerOrder, ["romaji", "dict", "llm", "google", "rule"], "顺序要落盘");

  // 面板上第一层的 ↑ 现在是禁用的（已经在最上面）
  const rows2 = env.listeners.config[0]().querySelectorAll(".wk-layers .wk-layer");
  assert.strictEqual(rows2[0].querySelector('[data-dir="up"]').disabled, true, "最上面那层不该还能往上");
  assert.strictEqual(rows2[4].querySelector('[data-dir="down"]').disabled, true, "最下面那层不该还能往下");

  // 「恢复默认顺序」
  const reset = [...env.listeners.config[0]().querySelectorAll("[data-a]")].find((b) => b.dataset.a === "layersReset");
  assert.ok(reset, "要有恢复默认按钮");
  reset.dispatchEvent(new env.window.Event("click"));
  assert.deepStrictEqual([...env.api.layers()], ["dict", "romaji", "llm", "google", "rule"], "恢复默认");
});

test("层序可调：配置里的顺序坏了也不会少一层（去重 + 补齐）", async () => {
  const env = bootPlugin(NCM_HTML, { config: { layerOrder: ["rule", "rule", "乱七八糟"] } });
  await env.runLoad();
  await sleep(200); // 注音是排在下一帧做的
  assert.deepStrictEqual([...env.api.layers()], ["rule", "dict", "romaji", "llm", "google"], "认识的留下、缺的补上");
  assert.strictEqual(rubyCount(env.document.querySelector("ul.lyric li p")), 2, "坏配置也要正常注音");
});

test("用户报的缩写：you're / I'll / it's / I'd 都要注对（不能撞上 ill / id）", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>you're my everything, I'll be there, it's ok, I'd say</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  assert.deepStrictEqual(PAIRS(p), [
    ["you're", "ユア"],
    ["my", "マイ"],
    ["everything", "エブリシング"],
    ["I'll", "アイル"],
    ["be", "ビー"],
    ["there", "ゼア"],
    ["it's", "イッツ"],
    ["ok", "オーケー"],
    ["I'd", "アイド"],
    ["say", "セイ"],
  ]);
  assert.strictEqual(baseText(p), "you're my everything, I'll be there, it's ok, I'd say", "原文含撇号一字不改");
});

test("用户报的 tick：不许是 カチカチ（拟声词）；没在线可用时用规则读音兜底", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>時計の tick が カチカチ と鳴る</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  /*
   * tick / tock 没有收进词典（用户选的：让大模型按语境决定）。
   * 所以这里把在线两层都关掉，看规则兜底给什么 —— 必须是 ティック，
   * 不能是 Google 那种拟声词 カチカチ。
   * （配了 key 的机器上不会走到这里：大模型那层会先按语境给答案，
   *   而 カチカチ 这种"不像音译"的答案会被首音校验直接拦掉。）
   */
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  // カチカチ 是日文原文（不是拉丁词），不该被碰；tick 要读成 ティック
  assert.deepStrictEqual(PAIRS(p), [["tick", "ティック"]]);
  assert.strictEqual(baseText(p), "時計の tick が カチカチ と鳴る", "原文一字不改");
});

test("用户报的一行：Ave Mujica 不能被展开成 アベニュー", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>Ave Mujica の 世界へ</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  /*
   * 关键是不能被展开成 アベニュー（那是把 Ave 当成地址缩写）。
   * 读音 2025 版按用户口径改成 アベ：乐队 Ave Mujica 的官方读法就是 アベ ムジカ
   * （Ave Maria 写成 アベ・マリア 也通行，所以这一步不亏）。
   */
  assert.deepStrictEqual(PAIRS(p), [
    ["Ave", "アベ"],
    ["Mujica", "ムジカ"],
  ]);
  assert.strictEqual(baseText(p), "Ave Mujica の 世界へ", "原文一字不改");
});

test("用户报的 Georgette：专有名词要注成 ジョージェット，不能是规则瞎猜的 ゲオーゲターテ", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>Georgette の ドレスを着て</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  assert.deepStrictEqual(PAIRS(p), [["Georgette", "ジョージェット"]]);
  assert.strictEqual(baseText(p), "Georgette の ドレスを着て", "原文一字不改");
});

test("全英文的一行：等待在线结果期间先用暂定读音顶上，拿到结果就地改写（不消失、不重建）", async () => {
  /*
   * 用户报的：全英文行"标注后有概率消失"。
   *
   * 两个原因叠在一起：层序是在线优先、规则垫底，等待期间原来写的是"先不标" ——
   * 一行里只要有一个词在等，这一行就空着；而这个词所在的原文本节点已经有记录了，
   * 后面拿到结果也不会再补注（一行的首个词尤其明显）。另一个是在线结果回来时
   * 走的是 restoreAll + 重注，等于把整行先清空再补回来。
   * 现在：等待期间用规则读音当暂定值（ruby 带 wk-pending，样式淡一点），
   * 结果回来由 annotate.relabel() 就地改写，DOM 节点一个都不动。
   */
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>kaleidoscope zephyr serendipity light</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const asked = [];
  const env = bootPlugin(HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions" },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      asked.push(items.map((it) => it.w));
      const out = {};
      items.forEach((it, i) => {
        if (it.w === "zephyr") out[String(i + 1)] = "ゼファー"; // 其余"给不出"
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(300);

  const p = env.document.querySelector("ul.lyric li p");
  // 一个词都不许空着：四个词全在，词典外的三个带"暂定"标记
  assert.deepStrictEqual(
    PAIRS(p).map((x) => x[0]),
    ["kaleidoscope", "zephyr", "serendipity", "light"],
    "等待期间也不许空着：" + p.innerHTML
  );
  const zephyrEl = [...p.querySelectorAll("ruby.wk-ruby")].find((r) => r.childNodes[0].nodeValue === "zephyr");
  assert.ok(zephyrEl.classList.contains("wk-pending"), "词典外的词先标成暂定：" + zephyrEl.className);
  const lightEl = [...p.querySelectorAll("ruby.wk-ruby")].find((r) => r.childNodes[0].nodeValue === "light");
  assert.ok(!lightEl.classList.contains("wk-pending"), "词典命中的词不是暂定");

  await sleep(600);
  // 结果回来：读音就地改写、暂定标记去掉，ruby 还是原来那个节点对象
  const zephyrAfter = [...p.querySelectorAll("ruby.wk-ruby")].find((r) => r.childNodes[0].nodeValue === "zephyr");
  assert.strictEqual(zephyrAfter, zephyrEl, "不许把注音拆掉重建（那样就是一闪）");
  assert.strictEqual(zephyrAfter.querySelector(".wk-rt").textContent, "ゼファー");
  assert.ok(!zephyrAfter.classList.contains("wk-pending"), "有确定结果了就不是暂定");
  // 模型给不出的词保持规则读音（不再标暂定），light 一直在
  const names = PAIRS(p).map((x) => x[0]);
  assert.deepStrictEqual(names, ["kaleidoscope", "zephyr", "serendipity", "light"]);
  assert.ok(PAIRS(p).some((x) => x[0] === "light" && x[1] === "ライト"));
  // 同一个「词 + 语境」不该被问第二遍
  const flat = asked.flat();
  assert.strictEqual(flat.length, new Set(flat).size, "同一个词被重复问了：" + JSON.stringify(asked));
  assert.strictEqual(baseText(p), "kaleidoscope zephyr serendipity light", "底字一字不改");
});

test("修复钩子：既挂上自己的，也不把别人（片假名终结者）的顶掉", async () => {
  // 真机上两个插件都会插注音。共存补丁重建完一行只调一个全局钩子，
  // 谁后加载谁就得链上去，直接覆盖会让另一个插件立刻开始闪。
  const env = bootPlugin();
  const called = [];
  env.window.__ktRepairLine = function () {
    called.push("prev");
  };
  await env.runLoad();

  assert.strictEqual(typeof env.window.__ktRepairLine, "function");
  const li = env.document.querySelectorAll("ul.lyric li")[0];
  env.window.__ktRepairLine(li);
  assert.ok(called.indexOf("prev") >= 0, "前一个钩子必须被调到（否则片假名终结者会闪）");
});

test("钩子：对方重建完一行直接叫我们时，注音要在同一次调用里补好", async () => {
  const env = bootPlugin();
  await env.runLoad();
  await sleep(600);

  const li = env.document.querySelectorAll("ul.lyric li")[0];
  const p = li.querySelector("p");
  // 模拟对方整行重建（我们的注音随之消失）
  while (p.firstChild) p.removeChild(p.firstChild);
  p.appendChild(env.document.createTextNode("きらめく light と clover"));
  assert.strictEqual(rubyCount(p), 0, "重建后注音应已消失");

  const ok = env.window.__ktRepairLine(li);
  assert.strictEqual(ok, true, "钩子应该返回 true");
  assert.ok(rubyCount(p) >= 1, "钩子返回时注音必须已经就位（等下一帧就是可见的一闪）");
  assert.strictEqual(baseText(p), "きらめく light と clover");
});

test("禁用后 DOM 完全还原并收走样式，重新启用又能标注", async () => {
  const env = bootPlugin();
  await env.runLoad();
  await sleep(600);
  const annotated = env.document.body.innerHTML;
  assert.ok(rubyCount(env.document.body) > 0);

  env.api.set("enabled", false);
  await sleep(200);
  assert.strictEqual(rubyCount(env.document.body), 0, "禁用后不该有注音");
  assert.ok(!env.document.body.innerHTML.includes("wk-ruby"), "禁用后 DOM 里不该有痕迹");
  assert.strictEqual(env.document.getElementById("western-katakana-style"), null, "注入的样式表要收走");

  env.api.set("enabled", true);
  await sleep(600);
  assert.strictEqual(env.document.body.innerHTML, annotated, "重新启用后应该回到同样的结果");
  assert.ok(env.document.getElementById("western-katakana-style"), "样式要补回来");
});

test("断网时依然能标（词典 + 罗马音 + 规则全在本地）", async () => {
  const env = bootPlugin();
  await env.runLoad();
  await sleep(600);
  // fetch 全程失败，但读音全部来自本地
  assert.ok(rubyCount(env.document.querySelector("ul.lyric")) >= 3, "离线也要能标");
  const stats = env.api.stats();
  assert.ok(stats.reading, "应该有读音统计");
  assert.ok(stats.reading.dictHits + stats.reading.romajiHits + stats.reading.ruleHits >= 3, JSON.stringify(stats.reading));
});

test("用量：大模型返回的 token 数会记进账本（本次 / 今天 / 累计 + 落盘）", async () => {
  const env = bootPlugin(LLM_HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions" },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "カレイドスコープ";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            // 真接口会带 usage —— 账本要的就是这个
            usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 366 },
            choices: [{ message: { content: JSON.stringify(out) } }],
          }),
      });
    },
  });
  await env.runLoad();
  await sleep(1400);

  const u = env.api.usage();
  assert.ok(u, "要有账本");
  assert.strictEqual(u.session.llm.requests, 1, "一次请求");
  assert.strictEqual(u.session.llm.ok, 1);
  assert.strictEqual(u.session.llm.promptTokens, 321, "输入 token 取自响应里的 usage");
  assert.strictEqual(u.session.llm.completionTokens, 45, "输出 token 同上");
  assert.strictEqual(u.session.llm.words, 1, "这批只问了词典外的那个词（light 在词典里）");
  assert.strictEqual(u.session.llm.chars, "kaleidoscope".length, "送出去的字符数");
  assert.strictEqual(u.session.google.requests, 0, "大模型排在免费接口前面，Google 那层不该被咨询");
  assert.deepStrictEqual(
    [u.session.llm.requests, u.today.llm.requests, u.total.llm.requests],
    [1, 1, 1],
    "本次 / 今天 / 累计 三份账一起涨"
  );
  const saved = JSON.parse(env.window.localStorage.getItem("western-katakana.usage"));
  assert.strictEqual(saved.total.llm.promptTokens, 321, "累计要落盘");
});

test("用量：设置面板显示账本，三个清零按钮各管一段", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  // 预置一份账本（在 onLoad 之前写进去）：证明面板读的是 localStorage 里那份
  const d = new Date();
  const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const bucket = (n) => ({ requests: n, ok: n, failures: 0, words: n, chars: n * 5, promptTokens: n * 100, completionTokens: n * 10 });
  env.window.localStorage.setItem(
    "western-katakana.usage",
    JSON.stringify({ version: 1, day: key, today: { llm: bucket(7), google: bucket(2) }, total: { llm: bucket(9), google: bucket(3) } })
  );
  await env.runLoad();

  const u = env.api.usage();
  assert.strictEqual(u.total.llm.requests, 9, "账本要从 localStorage 读出来");
  assert.strictEqual(u.session.llm.requests, 0, "本次是新的会话");

  const root = env.listeners.config[0]();
  const usageText = root.querySelector(".wk-usage").textContent;
  assert.ok(usageText.indexOf("累计：大模型 9 次请求") >= 0, "面板要显示累计：" + usageText);
  assert.ok(usageText.indexOf("今天：大模型 7 次请求") >= 0, "面板要显示今天：" + usageText);
  assert.ok(usageText.indexOf("免费接口 3 次请求") >= 0, "免费接口单独记：" + usageText);
  assert.ok(usageText.indexOf("缓存命中") >= 0, "顺带说一句省下的请求：" + usageText);

  const clickReset = (scope) => {
    const b = [...env.listeners.config[0]().querySelectorAll("[data-a]")].find(
      (x) => x.dataset.a === "usageReset" && x.dataset.scope === scope
    );
    assert.ok(b, "要有清零按钮：" + scope);
    b.dispatchEvent(new env.window.Event("click"));
  };

  clickReset("today");
  assert.strictEqual(env.api.usage().today.llm.requests, 0, "清零今天");
  assert.strictEqual(env.api.usage().total.llm.requests, 9, "累计不该被清");

  clickReset("all");
  const after = env.api.usage();
  assert.strictEqual(after.total.llm.requests, 0, "清零累计");
  assert.strictEqual(after.total.google.requests, 0);
});

test("用量：单价填了就算花费，单价 0 就不显示钱", async () => {
  const env = bootPlugin(NCM_HTML, { config: { usagePriceIn: 2, usagePriceOut: 8 } });
  const d = new Date();
  const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  env.window.localStorage.setItem(
    "western-katakana.usage",
    JSON.stringify({
      version: 1,
      day: key,
      today: { llm: { requests: 1, ok: 1, promptTokens: 1e6, completionTokens: 0 } },
      total: { llm: { requests: 1, ok: 1, promptTokens: 1e6, completionTokens: 0 } },
    })
  );
  await env.runLoad();
  const text = env.listeners.config[0]().querySelector(".wk-usage").textContent;
  assert.ok(text.indexOf("2.0000 元") >= 0, "输入 1M token × 2 元 = 2 元：" + text);
});

test("用量：core/usage.js 没注入时注音照常，只是没有账本", async () => {
  const env = bootPlugin(NCM_HTML, { files: CORE_FILES.filter((f) => f.indexOf("usage") < 0) });
  await env.runLoad();
  await sleep(200);
  assert.strictEqual(env.api.usage(), null, "没有模块就没有账本");
  assert.strictEqual(rubyCount(env.document.querySelector("ul.lyric li p")), 2, "注音不受影响");
});

test("暂定标记不会卡住：大模型失败后那一行立刻恢复成确定值", async () => {
  // 用户报的「这句不透明度怎么这么低」。等待期间是暂定（淡），失败后必须马上不再淡 ——
  // 老版本失败路径没叫 onUpdate，那行会淡一整个退避周期（60 秒起）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>KiLLKiSS judy jude juda</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions" },
    fetch: function () {
      return Promise.reject(new Error("offline (test)"));
    },
  });
  await env.runLoad();
  // 攒批窗口 400ms 之后才发请求，失败立刻回来
  await sleep(1500);

  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(rubyCount(p), 4, "四个词都要标上：" + p.innerHTML);
  assert.strictEqual(
    p.querySelectorAll("ruby.wk-ruby.wk-pending").length,
    0,
    "失败之后不该还淡着（wk-pending 会一直挂着就是那个 bug）：" + p.innerHTML
  );
  // 退避期间再扫一轮，也不能又淡上
  env.api.pass();
  await sleep(80);
  assert.strictEqual(p.querySelectorAll("ruby.wk-ruby.wk-pending").length, 0, "重扫也不许再淡");
});

test("按来源着色：类名一直在，颜色只由开关决定（开了立刻生效，不用重扫）", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  await sleep(200);
  const p = env.document.querySelector("ul.lyric li p");
  assert.ok(p.querySelector("ruby.wk-src-dict"), "词典给的词要带 wk-src-dict：" + p.innerHTML);

  const styleText = () => env.document.getElementById("western-katakana-style").textContent;
  assert.strictEqual(env.api.colorize(), false, "默认不开");
  assert.strictEqual(styleText().indexOf("wk-src-dict"), -1, "没开的时候一条颜色规则都不注入");

  assert.strictEqual(env.api.colorize(true), true);
  const css = styleText();
  for (const src of ["dict", "letters", "romaji", "rule", "llm", "google"]) {
    assert.ok(css.indexOf("wk-src-" + src) >= 0, "开了之后要有 " + src + " 的颜色规则");
  }
  assert.ok(css.indexOf("#46d17e") >= 0, "词典是绿色");

  assert.strictEqual(env.api.colorize(false), false);
  assert.strictEqual(styleText().indexOf("wk-src-dict"), -1, "关掉就撤掉颜色规则");
  // 但类名还在（下次开开关不用重扫）
  assert.ok(p.querySelector("ruby.wk-src-dict"), "类名不该跟着开关消失");
});

test("按来源着色：大模型换过的词，颜色跟着来源一起变", async () => {
  const env = bootPlugin(LLM_HTML, {
    config: {
      llmEnabled: true,
      llmKey: "sk-test",
      llmEndpoint: "https://api.example.com/v1/chat/completions",
      colorBySource: true,
    },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "カレイドスコープ";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1400);

  const p = env.document.querySelector("ul.lyric li p");
  const rubies = [...p.querySelectorAll("ruby.wk-ruby")];
  const light = rubies.find((r) => r.childNodes[0].nodeValue === "light");
  const kaleido = rubies.find((r) => r.childNodes[0].nodeValue === "kaleidoscope");
  assert.ok(light.classList.contains("wk-src-dict"), "词典命中的词是词典色：" + light.className);
  assert.ok(
    kaleido.classList.contains("wk-src-llm"),
    "被大模型换过的词要变成大模型色（wk-src-llm），类名不能再留着 wk-src-rule：" + kaleido.className
  );
  assert.strictEqual(kaleido.className.indexOf("wk-src-rule"), -1, "旧来源的类名要换掉");
});

test("注音不透明度真的生效（老版本被一条 !important 压掉了）", () => {
  const ctx = loadCore(NCM_HTML);
  ctx.WKAnnotate.applyStyles(ctx.document, { rtSize: 55, rtOpacity: 40, colorBySource: false });
  const css = ctx.document.getElementById("western-katakana-style").textContent;
  assert.ok(/rt\.wk-rt,\s*\.wk-rt\s*\{\s*opacity:\s*0\.4\s*!important/.test(css), "注音要用用户设的 40%：" + css);
  assert.ok(
    css.indexOf("ruby.wk-ruby { opacity: 1 !important; }") >= 0,
    "底字仍要锁死 1（别人的 opacity 不许把它压淡）"
  );
  // 暂定按比例再淡一档（40% * 0.6 = 24%），不是写死的 45%
  assert.ok(css.indexOf("opacity: 0.24 !important") >= 0, "暂定要跟着设置走：" + css);
  ctx.window.close();
});

test("设置面板：粘进来的 key 会自动洗掉引号 / 空格 / Bearer，并写回输入框", async () => {
  // 用户报的「大模型请求怎么全失败了」里最常见的一种：key 粘进来时带了多余字符，
  // 请求头不合法 -> 401 -> 满屏失败。这里确认面板当场洗掉并写回，落盘的也是干净的。
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  const input = root.querySelector('[data-k="llmKey"]');
  input.value = ' Bearer "sk-abc123456789012345" ';
  input.dispatchEvent(new env.window.Event("change"));

  assert.strictEqual(input.value, "sk-abc123456789012345", "输入框里要写成干净的值");
  assert.strictEqual(env.api.config.llmKey, "sk-abc123456789012345");
  const saved = JSON.parse(env.window.localStorage.getItem("western-katakana.config"));
  assert.strictEqual(saved.llmKey, "sk-abc123456789012345", "落盘的也要是干净的");
});

test("罗马音像英文词时交给大模型仲裁；真罗马音一个请求都不发", async () => {
  // 用户报的「the pretender up, … shake, shake, shake it up, it up 里只有 the 没被矫正」。
  // the/up/it 是词典命中（本来就对，按设计不问模型）；shake 是罗马音层读成了 シャケ。
  // 现在：罗马音答案若在英文词表里就标成"没把握"，让在线层接手；
  // 真正的日语罗马字（sekai）仍然是确定的，不会被无谓地送去问模型。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>sake sekai the shake</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const asked = [];
  const env = bootPlugin(HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions", online: false },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      asked.push(items.map((it) => it.w));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = it.w === "sake" ? "セイク" : "ダミー";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(200); // 趁模型还没回来：本地答案是"暂定"
  const p = env.document.querySelector("ul.lyric li p");
  const pendingNow = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue);
  assert.ok(pendingNow.indexOf("sake") >= 0, "sake 要先标上（暂定）：" + p.innerHTML);

  await sleep(1400);
  const words = [].concat.apply([], asked);
  assert.deepStrictEqual(words, ["sake"], "只该问 sake：词典词和真罗马音都不该浪费请求（实际 " + words.join(",") + "）");

  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".wk-rt").textContent,
  ]);
  assert.deepStrictEqual(
    pairs,
    [
      ["sake", "セイク"],
      ["sekai", "セカイ"],
      ["the", "ザ"],
      ["shake", "シェイク"],
    ],
    "sake 要被模型换成 セイク；其它三个保持本地答案：" + JSON.stringify(pairs)
  );
  const shakeRuby = p.querySelectorAll("ruby.wk-ruby")[3];
  assert.ok(shakeRuby.classList.contains("wk-src-dict"), "shake 现在是词典命中：" + shakeRuby.className);
  assert.strictEqual(baseText(p), "sake sekai the shake");
});

test("罗马音像英文词：用户把「英文规则」提到在线层前面时，照样一个请求都不发", async () => {
  // 排序是用户说了算：规则提到最上面 = 纯离线。这条不因为"没把握"就被破坏。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
<li class="line"><p>sake の sekai</p></li>
</ul></div></div>
</body></html>`;
  let called = 0;
  const env = bootPlugin(HTML, {
    config: {
      llmEnabled: true,
      llmKey: "sk-test",
      llmEndpoint: "https://api.example.com/v1/chat/completions",
      layerOrder: ["dict", "rule", "romaji", "llm", "google"],
    },
    fetch: function () {
      called++;
      return Promise.reject(new Error("offline (test)"));
    },
  });
  await env.runLoad();
  await sleep(1600);
  assert.strictEqual(called, 0, "纯离线顺序下一个请求都不该发");
  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(p.querySelectorAll("ruby.wk-ruby.wk-pending").length, 0, "也不该标成暂定");
  assert.strictEqual(rubyCount(p), 2);
});

test("换歌且页面不再变动时：被跳过的行会自己补回来（不用等用户操作）", async () => {
  // 用户报的「换歌的时候 KiLLKiSS… 还是没注音」。
  // 换歌那几下文本在动 -> 这一轮按"别追着重注"跳过；如果之后页面不再变动
  // （歌是暂停的，歌词只渲染一次），就没有事件来触发下一轮扫描 ——
  // 老版本那行会永远空着。现在 pass() 会报出重试时间，插件自己排下一轮。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
<li class="line"><p>きらめく light</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(150);
  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(rubyCount(p), 1, "前提：第一轮注上了");

  // 连着换 4 次（都在 motion 窗口内），每次只扫一轮 —— 模拟"框架渲染完就不动了"
  for (const t of ["そして clover", "遠くの dream", "KiLLKiSS judy", "最後の sky"]) {
    p.textContent = t;
    env.api.pass();
    await sleep(20);
  }
  assert.strictEqual(rubyCount(p), 0, "前提：窗口内变太快，这几轮被跳过");
  assert.ok(env.api.stats().lastPass.retryInMs > 0, "要安排下一轮：", JSON.stringify(env.api.stats().lastPass));
  // 跳过原因留在 lastPass.skips 里（以前有个 WK.why() 专门读它，那个 API 已经删了）
  assert.ok(
    env.api.stats().lastPass.skips.join(" ").indexOf("文本在动") >= 0,
    "要留痕说清为什么跳过：" + JSON.stringify(env.api.stats().lastPass.skips)
  );

  // 关键：接下来一个 DOM 事件都不发生，只等 —— 注音必须自己出现
  await sleep(3600);
  assert.deepStrictEqual(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue),
    ["sky"],
    "窗口过后必须自己补上来（暂停时换歌就是这个场景）：" + p.innerHTML
  );
});

test("设置面板：把词典拖到「英文音译规则」下面会给出挡路提醒", async () => {
  // 规则层对每个词都给得出答案，排在它下面的层就永远轮不到 ——
  // 用户把层序拖乱之后 `the` 变成规则层的 セ 就是这么来的（提示要指出来）。
  const env = bootPlugin(NCM_HTML, {
    config: { layerOrder: ["llm", "romaji", "google", "rule", "dict"] },
  });
  await env.runLoad();
  const box = env.listeners.config[0]().querySelector(".wk-layers");
  const warn = box.querySelector(".wk-layer-warn");
  assert.ok(warn, "要有挡路提醒：" + box.textContent);
  assert.ok(warn.textContent.indexOf("离线词典") >= 0, "要点名被挡住的层：" + warn.textContent);
  assert.ok(warn.textContent.indexOf("セ") >= 0, "要说明后果（the 会变成 セ）：" + warn.textContent);

  // 默认顺序下不该有这条提醒
  const okEnv = bootPlugin(NCM_HTML, { dev: true });
  await okEnv.runLoad();
  assert.strictEqual(
    okEnv.listeners.config[0]().querySelector(".wk-layer-warn"),
    null,
    "默认顺序不该出现提醒"
  );
});

test("层序：面板不让把「英文音译规则」换到词典/罗马音前面（这个坑出过三次报告）", async () => {
  // 用户报的：the -> セ、this 变黄、I'll -> イル、而且读数"全都没矫正"。
  // 全都来自同一件事 —— 把词典往下拖，规则层跑到它前面：规则对每个词都给答案，
  // 词典和在线层就永远轮不到。面板直接不让换，并给出说明。
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const rows = env.listeners.config[0]().querySelectorAll(".wk-layers .wk-layer");
  // 默认序：1 词典 2 罗马音 3 大模型 4 免费接口 5 规则
  assert.strictEqual(rows[0].querySelector('[data-dir="down"]').disabled, false, "词典往下换（和罗马音）是允许的");
  assert.strictEqual(rows[2].querySelector('[data-dir="up"]').disabled, false, "大模型往上换（和罗马音）是允许的");
  assert.strictEqual(rows[3].querySelector('[data-dir="down"]').disabled, false, "免费接口和规则互换是允许的");

  // 但要和"规则"互换同步层就不行：先点两次把罗马音挪到规则下面，再试
  const click = (rowIndex, dir) =>
    env.listeners.config[0]().querySelectorAll(".wk-layers .wk-layer")[rowIndex].querySelector('[data-dir="' + dir + '"]').dispatchEvent(new env.window.Event("click"));
  // 现序：dict romaji llm google rule
  assert.deepStrictEqual([...env.api.layers()], ["dict", "romaji", "llm", "google", "rule"]);
  // 罗马音的 ↓（与 llm 换）-> dict llm romaji google rule
  click(1, "down");
  assert.deepStrictEqual([...env.api.layers()], ["dict", "llm", "romaji", "google", "rule"]);
  // 罗马音再 ↓（与 google 换）-> dict llm google romaji rule
  click(2, "down");
  assert.deepStrictEqual([...env.api.layers()], ["dict", "llm", "google", "romaji", "rule"]);
  // 现在罗马音紧挨着规则：它的 ↓ 必须被禁用（换了就等于把罗马音藏起来）
  const rows2 = env.listeners.config[0]().querySelectorAll(".wk-layers .wk-layer");
  assert.strictEqual(rows2[3].querySelector('[data-dir="down"]').disabled, true, "罗马音不能换到规则后面");
  assert.strictEqual(rows2[4].querySelector('[data-dir="up"]').disabled, true, "规则不能换到罗马音前面");
  assert.ok(rows2[4].querySelector('[data-dir="up"]').title.indexOf("永远用不上") >= 0, "要说清为什么禁用");

  // 手改配置（控制台 WK.layers）绕过去的话，面板要报警告
  env.api.layers(["llm", "romaji", "google", "rule", "dict"]);
  const root = env.listeners.config[0]();
  const warn = root.querySelector(".wk-layer-warn");
  assert.ok(warn, "要有挡路提醒：" + root.querySelector(".wk-layers").textContent);
  assert.ok(warn.textContent.indexOf("离线词典") >= 0 && warn.textContent.indexOf("永远用不上") >= 0, "要说清后果：" + warn.textContent);
  // 而且大模型那块的告警要排在第一位（先修层序，再看别的）
  const state = root.querySelector(".wk-llm-state").textContent;
  assert.ok(state.indexOf("英文音译规则") >= 0, "大模型状态区也要提这件事：" + state);
});

test("设置面板：有「重试没结果的词」按钮，点了不会炸", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  const btn = [...root.querySelectorAll("[data-a]")].find((b) => b.dataset.a === "retry");
  assert.ok(btn, "要有重试按钮");
  assert.ok(btn.textContent.indexOf("没结果") >= 0, "文案要说清它重试的是哪些：" + btn.textContent);
  btn.dispatchEvent(new env.window.Event("click"));
  assert.ok(btn.textContent.indexOf("已重新排队") >= 0, "点了要有反馈：" + btn.textContent);
});

test("设置面板：模型层停摆时给出大白话告警 + 「立刻重试」（不用开 dev 也能看到）", async () => {
  // 用户报的「第四首歌时读音全都没矫正」：接口抖一下进了退避，本地读音照旧、
  // 模型一条都没改，面板上却什么都不说 —— 看着就像插件坏了。
  const env = bootPlugin(LLM_HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions", online: false },
    fetch: function () {
      return Promise.reject(new Error("offline (test)"));
    },
  });
  await env.runLoad();
  await sleep(1600); // 攒批窗口 + 失败

  const root = env.listeners.config[0]();
  const box = root.querySelector(".wk-llm-state");
  assert.ok(box, "要有模型层状态区");
  const text = box.textContent;
  assert.ok(/退避|没成功/.test(text), "要说清现在为什么不矫正：" + text);
  assert.ok(text.indexOf("不会矫正") >= 0, "要说清后果：" + text);

  const btn = [...box.querySelectorAll("[data-a]")].find((b) => b.dataset.a === "llmRetryNow");
  assert.ok(btn, "要有「立刻重试」按钮：" + box.innerHTML);
  assert.ok(env.api.llm.stats().cooldownMs > 0, "前提：确实在退避中");
  btn.dispatchEvent(new env.window.Event("click"));
  assert.strictEqual(env.api.llm.stats().cooldownMs, 0, "点了之后退避要清掉");
});

test("罗马音节行：短音节按罗马音读（PI→ピ / ME→メ），普通英文行不受影响", async () => {
  // 用户报的：`Yes, PA PI PU PE PO POP UP!(Hey!!)Yes, MA MI MU ME MO MORE JUMP!(Yeah!!)`
  // 用词典（英文词典）效果很差：PI→パイ、PE→ピーイー（把 "P E" 当字母念）、ME→ミー…
  // 一行里同时出现 5 个以上"词典读音 vs 罗马音读音打架"的短音节 -> 这是罗马字行。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Yes, PA PI PU PE PO POP UP!(Hey!!)Yes, MA MI MU ME MO MORE JUMP!(Yeah!!)</p></li>
  <li class="line"><p>No, no, no, I need you so</p></li>
  <li class="line"><p>we can go to the sea</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const reading = (p) =>
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
      r.childNodes[0].nodeValue,
      r.querySelector(".wk-rt").textContent,
    ]);

  const romaji = new Map(reading(ps[0]));
  // 短音节：罗马音读法
  assert.strictEqual(romaji.get("PI"), "ピ", "PI 该是 ピ，不是词典的 パイ");
  assert.strictEqual(romaji.get("PE"), "ペ", "PE 该是 ペ，不是词典把 P E 念成 ピーイー");
  assert.strictEqual(romaji.get("PO"), "ポ");
  assert.strictEqual(romaji.get("MI"), "ミ");
  assert.strictEqual(romaji.get("ME"), "メ", "ME 该是 メ，不是 ミー");
  assert.strictEqual(romaji.get("MO"), "モ");
  assert.strictEqual(romaji.get("PA"), "パ");
  assert.strictEqual(romaji.get("MU"), "ム");
  // 真英文词照旧走词典
  assert.strictEqual(romaji.get("POP"), "ポップ");
  assert.strictEqual(romaji.get("UP"), "アップ");
  assert.strictEqual(romaji.get("MORE"), "モア");
  assert.strictEqual(romaji.get("JUMP"), "ジャンプ");

  // 普通英文行：词典读音一个字都不许变（no/so/go/to/you 这些短词不是罗马音节）
  const en = new Map(reading(ps[1]));
  assert.strictEqual(en.get("No"), "ノー", "英文行里的 No 是 ノー：" + JSON.stringify([...en]));
  assert.strictEqual(en.get("I"), "アイ");
  assert.strictEqual(en.get("you"), "ユー");
  assert.strictEqual(en.get("so"), "ソー");
  const en2 = new Map(reading(ps[2]));
  assert.strictEqual(en2.get("go"), "ゴー", "英文行里的 go 是 ゴー：" + JSON.stringify([...en2]));
  assert.strictEqual(en2.get("to"), "トゥ");
  assert.strictEqual(en2.get("we"), "ウィー");
  assert.strictEqual(en2.get("sea"), "シー");
});

test("英文行里有 th/ck 这类拼写时，绝不当成罗马字行（`me` 不许读成 メ）", async () => {
  // 用户报的截图：`Knock knock! Let me go in and get the ace` 里的 `me` 被标成 メ。
  // 病因是"数短词"这条判据分不开英文行和罗马字行：这行本来只有 4 个打架的短词，
  // 可整首歌里再随便多一个（so/no/you…）就凑够 5 个门槛，于是整行改按罗马音读。
  // 能分开的是拼写：日语罗马字写不出 ck / th / wh / q / x。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Knock knock! Let me go in and get the ace, so no, do you know</p></li>
  <li class="line"><p>Knock knock! Let me go in and get the ace</p></li>
  <li class="line"><p>Yes, PA PI PU PE PO POP UP!(Hey!!)Yes, MA MI MU ME MO MORE JUMP!(Yeah!!)</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const reading = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
        r.childNodes[0].nodeValue,
        r.querySelector(".wk-rt").textContent,
      ])
    );

  // 前提：这一行按老判据会被当成罗马字行（6 个打架短词、80% 短词）
  const long = reading(ps[0]);
  assert.strictEqual(long.get("me"), "ミー", "带 ck/th 的英文行里 me 要读 ミー：" + JSON.stringify([...long]));
  assert.strictEqual(long.get("go"), "ゴー");
  assert.strictEqual(long.get("so"), "ソー");
  assert.strictEqual(long.get("no"), "ノー");
  assert.strictEqual(long.get("you"), "ユー");
  assert.strictEqual(long.get("the"), "ザ");
  assert.strictEqual(long.get("Knock"), "ノック", "knock 的 k 是哑音：" + JSON.stringify([...long]));

  const short = reading(ps[1]);
  assert.strictEqual(short.get("me"), "ミー");

  // 反向的一半：真正的罗马音行（没有 ck/th/q/x）照旧按罗马音读
  const romaji = reading(ps[2]);
  assert.strictEqual(romaji.get("PI"), "ピ", "PA PI PU PE PO 那一行仍然是罗马字行");
  assert.strictEqual(romaji.get("ME"), "メ");
});

test("不发音字母的英文词：直接进词典（用户问的「没歧义就写进词典」）", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>knock knee knit knob knot wrist wreck</p></li>
  <li class="line"><p>comb climb lamb bomb thumb tomb dumb plumber</p></li>
  <li class="line"><p>subtle island aisle castle listen whistle fasten sword</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const reading = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
        r.childNodes[0].nodeValue,
        r.querySelector(".wk-rt").textContent,
      ])
    );
  const want = [
    ["knock", "ノック"], ["knee", "ニー"], ["knit", "ニット"], ["knob", "ノブ"], ["knot", "ノット"],
    ["wrist", "リスト"], ["wreck", "レック"],
    ["comb", "コーム"], ["climb", "クライム"], ["lamb", "ラム"], ["bomb", "ボム"],
    ["thumb", "サム"], ["tomb", "トゥーム"], ["dumb", "ダム"], ["plumber", "プラマー"],
    ["subtle", "サトル"], ["island", "アイランド"], ["aisle", "アイル"], ["castle", "キャッスル"],
    ["listen", "リスン"], ["whistle", "ウィッスル"], ["fasten", "ファスン"], ["sword", "ソード"],
  ];
  const got = new Map();
  for (const p of ps) for (const [k, v] of reading(p)) got.set(k, v);
  for (const [w, kana] of want) {
    assert.strictEqual(got.get(w), kana, w + " 该是 " + kana + "：" + JSON.stringify([...got]));
  }
  // 词典是"人工核过"的，要标成确定（不然大模型还要再问一遍，白白花钱）
  assert.strictEqual(env.api.read("knock").source, "dict");
  assert.strictEqual(env.api.read("knock").confident, true);
});

test("know 一族：know ノウ 本身是对的，同族那几个错读也一起修正", async () => {
  // 用户问「know 的读音是否正确」——`know` 一直是对的（词典 ノウ，确定值）。
  // 顺手把同族核对了一遍，发现四个确实错的（都在这次补进人工词表）：
  //   knowing → ノーイング✗（该 ノウイング）／know-how → ノワアウ✗（该 ノウハウ）
  //   throwing → スロウィン✗（throw 是 スロー）／flowing、blowing 同理
  //   unforgettable → ウンフォーゲタタブブル✗（该 アンフォーゲタブル）
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>You know, knowing, know-how, throwing</p></li>
  <li class="line"><p>flowing blowing unforgettable knowledge</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const got = new Map();
  for (const p of ps) {
    for (const [k, v] of [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
      r.childNodes[0].nodeValue,
      r.querySelector(".wk-rt").textContent,
    ])) {
      got.set(k, v);
    }
  }
  for (const [w, kana] of [
    ["You", "ユー"],
    ["know", "ノウ"],
    ["knowing", "ノウイング"],
    // `know-how` 这种连字符词现在按段各标一个 ruby（见 letters.js 的 splitDashes），
    // 读音和整词一样是 ノウ + ハウ
    ["how", "ハウ"],
    ["throwing", "スローイング"],
    ["flowing", "フロウイング"],
    ["blowing", "ブロウイング"],
    ["unforgettable", "アンフォーゲタブル"],
    ["knowledge", "ナレッジ"],
  ]) {
    assert.strictEqual(got.get(w), kana, w + " 该是 " + kana + "：" + JSON.stringify([...got]));
  }
  // know 是词典给的确定答案（所以永远不会去问模型、也不会被别的层改掉）
  assert.strictEqual(env.api.read("know").source, "dict");
  assert.strictEqual(env.api.read("know").confident, true);
});

test("notes 一族：复数/变形形的读音（notes→ノーツ，不是单数 ノート）", async () => {
  // 用户问「notes 的读音」。`note` ノート 一直是对的，但复数被写成了单数读音
  // （notes ノート ✗，该 ノーツ），同族的 dates デイツ / rates レーツ 反而是对的。
  // 一起修的还有"词尾哑 e + s/ing"那一类：bites ビテス✗ → バイツ、noting ノティン✗
  // → ノーティング，以及 footnote フォオタノテ✗ → フットノート。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>little notes, noting bites and kites</p></li>
  <li class="line"><p>footnote keynote bones zones mates</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const got = new Map();
  for (const p of env.document.querySelectorAll("ul.lyric li p")) {
    for (const [k, v] of [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
      r.childNodes[0].nodeValue,
      r.querySelector(".wk-rt").textContent,
    ])) {
      got.set(k, v);
    }
  }
  for (const [w, kana] of [
    ["notes", "ノーツ"],
    ["noting", "ノーティング"],
    ["bites", "バイツ"],
    ["kites", "カイツ"],
    ["mates", "メイツ"],
    ["bones", "ボーンズ"],
    ["zones", "ゾーンズ"],
    ["footnote", "フットノート"],
    ["keynote", "キーノート"],
  ]) {
    assert.strictEqual(got.get(w), kana, w + " 该是 " + kana + "：" + JSON.stringify([...got]));
  }
  // 单数照旧
  assert.strictEqual(env.api.read("note").kana, "ノート");
});

test("音乐术语：`(Lento, presto, andante larghetto)` 离线也要读对", async () => {
  // 用户发的截图。四个读音都对，但当时离线是两个错的（presto→プレサト、
  // larghetto→ラーーエタト），对大模型临时给的 —— 每听一遍都要花一次请求。
  // 整个音乐术语区在词典里都是空的（只有 tempo/opera/symphony 这种通用词），
  // 而这一区读法唯一，所以整批人工钉进词表（75 个）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>(Lento, presto, andante larghetto)</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const p = env.document.querySelector("ul.lyric li p");
  const got = new Map(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(got.get("Lento"), "レント", JSON.stringify([...got]));
  assert.strictEqual(got.get("presto"), "プレスト", JSON.stringify([...got]));
  assert.strictEqual(got.get("andante"), "アンダンテ");
  assert.strictEqual(got.get("larghetto"), "ラルゲット");

  // 规则层原本读歪的那批也一起锁住（离线、零请求）
  for (const [w, kana] of [
    ["adagio", "アダージョ"],
    ["allegro", "アレグロ"],
    ["vivace", "ヴィヴァーチェ"],
    ["crescendo", "クレッシェンド"],
    ["decrescendo", "デクレッシェンド"],
    ["forte", "フォルテ"],
    ["pianissimo", "ピアニッシモ"],
    ["dolce", "ドルチェ"],
    ["cantabile", "カンタービレ"],
    ["fermata", "フェルマータ"],
    ["scherzo", "スケルツォ"],
    ["fugue", "フーガ"],
    ["etude", "エチュード"],
    ["pizzicato", "ピッツィカート"],
    ["glissando", "グリッサンド"],
    ["waltz", "ワルツ"],
    ["rhapsody", "ラプソディー"],
    ["concerto", "コンチェルト"],
    ["quartet", "カルテット"],
    ["octave", "オクターヴ"],
    ["chord", "コード"],
    ["trill", "トリル"],
  ]) {
    const r = env.api.read(w);
    assert.strictEqual(r.kana, kana, w + " 该是 " + kana);
    assert.strictEqual(r.source, "dict", w + " 要来自离线词典（不花请求）");
    assert.strictEqual(r.confident, true, w + " 要是确定值");
  }
  // 两可的 `grave`（意大利语 グラーヴェ / 英语"墓" グレイヴ）故意不收，交给模型判
  assert.strictEqual(env.api.read("grave").source !== "dict", true, "grave 是有歧义的，不该钉死");
});

test("`Every night … keeps me awake` 这一行：读音离线也要全对", async () => {
  // 用户第二张截图。读音都对，但 `relentlessly` / `awake` 是大模型临时给的：
  // 离线时 relentlessly 会被规则读成 レレントレスライー、awake 被罗马音层读成 アワケ。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Every night brings a dream but the day, relentlessly, keeps me awake</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const p = env.document.querySelector("ul.lyric li p");
  const got = new Map(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  for (const [w, kana] of [
    ["Every", "エブリ"],
    ["night", "ナイト"],
    ["brings", "ブリングス"],
    ["dream", "ドリーム"],
    ["but", "バット"],
    ["the", "ザ"],
    ["day", "デイ"],
    ["relentlessly", "リレントレスリー"],
    ["keeps", "キープス"],
    ["me", "ミー"],
    ["awake", "アウェイク"],
  ]) {
    assert.strictEqual(got.get(w), kana, w + " 该是 " + kana + "：" + JSON.stringify([...got]));
  }
  // 这一行一个词都不该去问模型（全是离线词条/规则确定值）
  for (const w of ["every", "relentless", "relentlessly", "awake", "asleep", "memorize", "memorable"]) {
    const r = env.api.read(w);
    assert.strictEqual(r.confident, true, w + " 要是确定值（不然又会去问模型）");
    assert.ok(r.source === "dict" || r.source === "rule", w + " 的来源：" + r.source);
  }
});

test("缩写 / 喊叫 / 署名行：SOS・QTE・AAAAA 读对，署名行的碎片不注音", async () => {
  // 用户一口气发了七张截图，这里是其中五类：署名行 `混音&母带处理：宫奇Gon` 的 `Gon` 被注音
  // （同一行署名被拆成了两个节点）；`対バンにはATフィールド` 的 AT 被读成词典里的 at アット
  // （该 エーティー）；`空中散歩のSOS` 读成 ソス（该 エスオーエス）；
  // `邪魔者は成敗いたAAAAAす！` 的 AAAAA 一个音都没有（该 アアアアア）；
  // `QTE` 读成 クテ（该 キューティーイー）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>対バンにはATフィールド</p></li>
  <li class="line"><p>空中散歩のSOS</p></li>
  <li class="line"><p>邪魔者は成敗いたAAAAAす！</p></li>
  <li class="line"><p>(A, B) 退屈に打つ QTE (Why?)</p></li>
  <li class="line"><p>混音&母带处理：宫奇Gon</p></li>
  <li class="line"><p>制作人：蔡近翰Zoe</p></li>
  <li class="line"><p>Music と light の 中</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  assert.strictEqual(pairsOf(ps[1]).get("SOS"), "エスオーエス", "SOS 要逐字母：" + ps[1].innerHTML);
  assert.strictEqual(pairsOf(ps[2]).get("AAAAA"), "アアアアア", "喊叫要按元音叠出来：" + ps[2].innerHTML);
  assert.strictEqual(pairsOf(ps[3]).get("QTE"), "キューティーイー", "QTE 要逐字母：" + ps[3].innerHTML);
  // 署名行整行不注音 —— 包括被拆到另一个节点里的名字
  assert.strictEqual(rubyCount(ps[4]), 0, "`混音&母带处理：宫奇Gon` 整行都不该注音：" + ps[4].innerHTML);
  assert.strictEqual(rubyCount(ps[5]), 0, "`制作人：蔡近翰Zoe` 整行都不该注音：" + ps[5].innerHTML);
  // 反向：只是带 Music 这个词头的正常歌词，照标（这条有老测试，这里再守一次）
  assert.strictEqual(pairsOf(ps[6]).get("Music"), "ミュージック", "正常歌词行不能被误杀");

  /*
   * 第二遍：配一个假模型。`AT` 现在离线就有确定答案 —— 它紧贴假名，属于日语里通行的
   * 那批首字母缩写（main.js 的 GLUED_ACRONYM），读 エーティー，letters 层名次又最前，
   * 所以根本不用问模型。这里守住两点：页面上显示的是 エーティー（不是词典里的 at アット），
   * 而且 `AT` 不进请求；`SOS` 和署名行的名字同样不进。
   */
  const asked = [];
  const env2 = bootPlugin(HTML, {
    config: { online: false, llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions" },
    fetch: function (url, init) {
      const items = JSON.parse(JSON.parse(init.body).messages[0].content.slice(JSON.parse(init.body).messages[0].content.indexOf("[")));
      asked.push(items.map((it) => String(it.w).toLowerCase()));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "テスト";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env2.runLoad();
  await sleep(1600);
  const p2 = env2.document.querySelector("ul.lyric li p");
  assert.strictEqual(pairsOf(p2).get("AT"), "エーティー", "贴假名的缩写要按字母名：" + p2.innerHTML);
  const words = [].concat.apply([], asked).map((w) => String(w).toLowerCase());
  assert.ok(words.indexOf("at") < 0, "AT 有确定答案（字母名），不该问模型：" + words.join(","));
  assert.ok(words.indexOf("sos") < 0, "SOS 有确定答案（字母名），不该问：" + words.join(","));
  assert.ok(words.indexOf("gon") < 0, "署名行的名字不该问：" + words.join(","));
});

test("`KiLLKiSS judy / jude / juda` 与乐队名 `Ave Mujica`（アベ ムジカ）", async () => {
  // 用户截图：三行 KiLLKiSS 后面跟 judy / jude / juda。原来 judy 被规则读成
  // ジュダイー ✗、jude 被罗马音层读成 ジュデ ✗、KiLLKiSS 被规则读成 キララキス ✗。
  // 另外用户指出乐队 `Ave Mujica` 的官方读法是 アベ ムジカ
  //（词典里原本定的是拉丁语的 アヴェ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>KiLLKiSS judy... KiLLKiSS jude... KiLLKiSS juda...</p></li>
</ul></div>
<div class="m-playbar"><div class="words"><span class="by"><a href="#">Ave Mujica</a></span></div></div>
</div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const p = env.document.querySelector("ul.lyric li p");
  const got = new Map(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(got.get("KiLLKiSS"), "キルキス", JSON.stringify([...got]));
  assert.strictEqual(got.get("judy"), "ジュディ");
  assert.strictEqual(got.get("jude"), "ジュード");
  assert.strictEqual(got.get("juda"), "ジュダ");
  // 歌手栏的乐队名（Ave / Mujica 是两个词，分别注音）
  assert.strictEqual(env.api.read("ave").kana, "アベ");
  assert.strictEqual(env.api.read("mujica").kana, "ムジカ");
  // 都是离线词条，不该去问模型
  for (const w of ["judy", "jude", "juda", "killkiss", "ave", "mujica", "rude", "gratitude"]) {
    const r = env.api.read(w);
    assert.strictEqual(r.confident, true, w);
    assert.strictEqual(r.source, "dict", w + " 要来自离线词典：" + r.source);
  }
});

test("`YY` 标字母名、打码的 `XX` 留白；成串的大写单字母读字母名（`(A, B)`）", async () => {
  // 用户三句话依次是：「YY 要标」「同一行里成串的大写单字母 → 字母名」
  // 「打码的 XX 还是留白更好」。前两条照做；第三条和第一条冲突（XX / YY 拼写一样），
  // 只能看用法：打码词后面必然跟日语词尾/助词（`“XX”してる`、`XXの…`），
  // 缩写是独立写的（`「YY」`、`YY!`）。判据就是"后面紧挨着（可夹收尾引号）的
  // 一个字符是不是平假名"。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>きみがひとり“XX”してるの知ってるよ</p></li>
  <li class="line"><p>合言葉は「YY」</p></li>
  <li class="line"><p>YY! XXの うた</p></li>
  <li class="line"><p>(A, B) 退屈に打つ QTE (Why?)</p></li>
  <li class="line"><p>A story of love and I</p></li>
  <li class="line"><p>B面の うた</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (p) =>
    new Map(
      [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  // 打码：后面跟日语词尾 -> 留白
  assert.strictEqual(rubyCount(ps[0]), 0, "打码的 XX 要留白：" + ps[0].innerHTML);
  // 缩写：独立写的 -> 标字母名
  assert.strictEqual(pairsOf(ps[1]).get("YY"), "ワイワイ", "YY 要标：" + ps[1].innerHTML);
  // 同一行里两种都有：YY 标、XX（后面跟 の）留白
  const mixed = pairsOf(ps[2]);
  assert.strictEqual(mixed.get("YY"), "ワイワイ", ps[2].innerHTML);
  assert.strictEqual(mixed.has("XX"), false, "XXの… 也按打码留白：" + ps[2].innerHTML);
  // 成串的大写单字母
  assert.strictEqual(pairsOf(ps[3]).get("A"), "エー", "成串的 A 读字母名：" + ps[3].innerHTML);
  assert.strictEqual(pairsOf(ps[3]).get("B"), "ビー", "成串的 B 读字母名：" + ps[3].innerHTML);
  assert.strictEqual(pairsOf(ps[3]).get("QTE"), "キューティーイー");
  // 反向：英文行里的冠词 A 还是 ア、代词 I 还是 アイ（这行只有两个单字母，不算成串）
  assert.strictEqual(pairsOf(ps[4]).get("A"), "ア", "冠词 A 不能读成 エー：" + ps[4].innerHTML);
  assert.strictEqual(pairsOf(ps[4]).get("I"), "アイ");
  /*
   * 孤零零一个大写字母：紧贴日文的读字母名（用户后来的截图：
   * `T氏` ティー / `B面` ビー / `X線` エックス —— 日语就是这么念的）。
   * 只有 `A` / `I` 例外（冠词 / 代词），而且夹在英文句子里的 A 也仍是 ア。
   */
  assert.strictEqual(pairsOf(ps[5]).get("B"), "ビー", "B面 的 B 该读 ビー：" + ps[5].innerHTML);
});

test("署名行：中文制作信息的各种写法都不注音（演唱/美工/策划/导唱/封面/曲绘…）", async () => {
  // 用户两张截图里的署名行。原来只认 作词/作曲/编曲/混音/母带/制作人 这几种，
  // `演唱：`、`美工：`、`策划：`、`导唱：`、`封面：`、`曲绘：`、`调校：`、`后期：`
  // 全都没认出来 —— 名字里的拉丁字母（如 `作曲/和声编写：CC` 的 CC）就被注上音了。
  // 还有 `/` 这种分隔符也要能跨过（`作曲/和声编写：`）。
  const lines = [
    "演唱：CC",
    "美工：CC",
    "策划：CC",
    "作词：CC&DD",
    "作曲/和声编写：CC",
    "编曲：sea云",
    "导唱：CC",
    "混音&母带处理：Gon",
    "制作人：Zoe",
    "和声：CC",
    "封面：CC",
    "曲绘：CC",
    "调校：CC",
    "后期：CC",
    "混音师：CC",
    "Lyrics by CC",
  ];
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
${lines.map((l) => `  <li class="line"><p>${l}</p></li>`).join("\n")}
  <li class="line"><p>Music と light の 中</p></li>
  <li class="line"><p>I love you CC</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  for (let i = 0; i < lines.length; i++) {
    assert.strictEqual(rubyCount(ps[i]), 0, "署名行不该注音：" + lines[i] + " -> " + ps[i].innerHTML);
  }
  // 反向：只是带词头的正常歌词、以及名字出现在歌词里，照标
  const lyric1 = new Map(
    [...ps[lines.length].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(lyric1.get("Music"), "ミュージック", "正常歌词不能被误杀：" + ps[lines.length].innerHTML);
  assert.strictEqual(lyric1.get("light"), "ライト");
  const lyric2 = new Map(
    [...ps[lines.length + 1].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(lyric2.get("love"), "ラブ", "歌词里的词照标：" + ps[lines.length + 1].innerHTML);
  assert.strictEqual(lyric2.get("CC"), "シーシー");
});

test("波浪号拉长音：`この feel~ing go~od` 读 フィーリング / グッド", async () => {
  // 用户截图的歌词。波浪号是拉长音的排版写法，原来被当成词边界切开，
  // 读成了 フィール + イング、ゴー + オッド。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>この feel~ing go~od</p></li>
  <li class="line"><p>go~ の love~</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const got = new Map(
    [...ps[0].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(got.get("feel~ing"), "フィーリング", "波浪号要连起来读：" + ps[0].innerHTML);
  assert.strictEqual(got.get("go~od"), "グッド", "go~od 是 good：" + ps[0].innerHTML);
  assert.strictEqual(baseText(ps[0]), "この feel~ing go~od", "底字一字不改");
  // 结尾的波浪号不算连接符：还是 go / love
  const got2 = new Map(
    [...ps[1].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(got2.get("go"), "ゴー", ps[1].innerHTML);
  assert.strictEqual(got2.get("love"), "ラブ", ps[1].innerHTML);
});

test("打码的 `****ed`、采样行、以及全大写的 `DIVA`", async () => {
  // 用户三张截图：`Oh, I'll be ed up…` 里只有打码碎片 `ed` 被注了 エド；
  // `采样：QUIX - Deep Home` 是采样署名，整行不该注音（QUIX 也别逐字母念）；
  // `憧れた DIVA なん だ` 的 DIVA 被逐字母念成 ディーアイブイエー（该 ディーヴァ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Oh, I'll be ****ed up, if you can't be right here</p></li>
  <li class="line"><p>采样：QUIX - Deep Home</p></li>
  <li class="line"><p>憧れた DIVA なん だ</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const got = new Map(
    [...ps[0].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(got.has("ed"), false, "打码碎片 ed 不该注音：" + ps[0].innerHTML);
  assert.strictEqual(got.get("Oh"), "オー", "其它词照标：" + JSON.stringify([...got]));
  assert.strictEqual(got.get("can't"), "キャント");
  assert.strictEqual(got.get("right"), "ライト");

  assert.strictEqual(rubyCount(ps[1]), 0, "采样署名行整行不注音：" + ps[1].innerHTML);

  // 单个 `*` 是脚注 / 演奏提示，不是打码：`(*teto sax solo)` 里的 teto 要标
  // （用户截图：那一行 sax サックス / solo ソロ 都标了，就 teto 空着）
  const NOTE_HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>(*teto sax solo)</p></li>
</ul></div></div>
</body></html>`;
  const env2 = bootPlugin(NOTE_HTML, { config: { online: false, llmEnabled: false } });
  await env2.runLoad();
  await sleep(300);
  const noteP = env2.document.querySelector("ul.lyric li p");
  const note = new Map(
    [...noteP.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(note.get("teto"), "テト", "单个 * 后面的完整词要标：" + noteP.innerHTML);
  assert.strictEqual(note.get("solo"), "ソロ", JSON.stringify([...note]));

  assert.strictEqual(
    new Map([...ps[2].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])).get("DIVA"),
    "ディーヴァ",
    "DIVA 是词，不是字母名：" + ps[2].innerHTML
  );
  // 全大写但有元音、4 个字母以上的，都不该逐字母念
  assert.strictEqual(env.api.read("QUIX").source !== "letters", true, "QUIX 不该逐字母：" + JSON.stringify(env.api.read("QUIX")));
  assert.strictEqual(env.api.read("DIVA").kana, "ディーヴァ");
});

test("法语歌词：整行用「法语拼读」，常用词走人工词表", async () => {
  // 用户要求"添加对法语的支持"，并给了一整首法语歌词当例子（L'Assasymphonie 那类）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Ah, si je pouvais vivre dans l'eau,</p></li>
  <li class="line"><p>le monde serait-il plus beau ?</p></li>
  <li class="line"><p>L'eau dans son courant fait danser nos vies.</p></li>
  <li class="line"><p>Et la cité, elle nourrit.</p></li>
  <li class="line"><p>Non, le grand amour ne suffit pas.</p></li>
  <li class="line"><p>Moi, je suis et serai toujours là,</p></li>
  <li class="line"><p>Et ça ne changera jamais, jamais..</p></li>
  <li class="line"><p>I love you so much</p></li>
  <li class="line"><p>きらめく light と clover</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (i) =>
    new Map(
      [...ps[i].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  const l0 = pairsOf(0);
  assert.strictEqual(l0.get("si"), "スィ", JSON.stringify([...l0]));
  assert.strictEqual(l0.get("je"), "ジュ");
  assert.strictEqual(l0.get("vivre"), "ヴィーヴル");
  assert.strictEqual(l0.get("dans"), "ダン");
  assert.strictEqual(l0.get("l'eau"), "ロー");

  const l1 = pairsOf(1);
  assert.strictEqual(l1.get("monde"), "モンド");
  assert.strictEqual(l1.get("plus"), "プリュ", "英法同形异音的词要按法语读：" + JSON.stringify([...l1]));
  assert.strictEqual(l1.get("beau"), "ボー");

  const l2 = pairsOf(2);
  assert.strictEqual(l2.get("son"), "ソン", "son 在法语行读 ソン：" + JSON.stringify([...l2]));
  assert.strictEqual(l2.get("courant"), "クラン");
  assert.strictEqual(l2.get("vies"), "ヴィ");

  const l4 = pairsOf(4);
  assert.strictEqual(l4.get("grand"), "グラン");
  assert.strictEqual(l4.get("amour"), "アムール");
  assert.strictEqual(l4.get("pas"), "パ");

  const l5 = pairsOf(5);
  assert.strictEqual(l5.get("toujours"), "トゥジュール");
  assert.strictEqual(l5.get("serai"), "スレ");

  const l6 = pairsOf(6);
  assert.strictEqual(l6.get("jamais"), "ジャメ");
  assert.strictEqual(l6.get("changera"), "シャンジェラ");

  // 反向：英文行和日语行不能被法语规则带歪
  const en = pairsOf(7);
  assert.strictEqual(en.get("love"), "ラブ", "英文行照旧：" + JSON.stringify([...en]));
  assert.strictEqual(en.get("much"), "マッチ");
  const jp = pairsOf(8);
  assert.strictEqual(jp.get("light"), "ライト", "日语行照旧：" + JSON.stringify([...jp]));
  assert.strictEqual(jp.get("clover"), "クローバー");
});

test("RNP 的复制模式（总览视图）整块不注音", async () => {
  // 用户要求「不要在 RNP 的复制模式上注音」。RNP 3.0.2 那颗按钮的 title 就是
  // 「复制模式」：打开后正常歌词整块隐藏（.rnp-lyrics 加 overview-mode-hide），
  // 另渲染 .rnp-lyrics-overview-container（CSS 里是 user-select:text，用来选中复制）。
  // 我们以前两边都注音 —— 复制出来就会带上 <ruby>/<rt> 的注音文字。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="lyric">
    <div class="rnp-lyrics overview-mode-hide">
      <div class="rnp-lyrics-line"><div class="rnp-lyrics-line-original">きらめく light と clover</div></div>
    </div>
    <div class="rnp-lyrics-overview-container">
      <div class="rnp-lyrics-overview">
        <div class="rnp-lyrics-overview-line">きらめく light と clover</div>
        <div class="rnp-lyrics-overview-line current">ずっと dream を見てた</div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(300);
  const overview = env.document.querySelector(".rnp-lyrics-overview-container");
  assert.strictEqual(rubyCount(overview), 0, "复制模式的歌词不许注音：" + overview.innerHTML);
  const hidden = env.document.querySelector(".rnp-lyrics.overview-mode-hide");
  assert.strictEqual(rubyCount(hidden), 0, "被复制模式隐藏的那块也不许注音：" + hidden.innerHTML);
});

test("法语借词表只作用于法语行（`rose`：法语行 ロゼ / 英文行 ローズ）", async () => {
  // 用户给的 sljfaq 借词表是"日语里就这么写"，但它只该在法语行上生效：
  // rose 在英语歌里是 ローズ、在法语歌里是 ロゼ；lame 在英语里是 レイム、法语里是 ラメ。
  // 这就是把法语判定放在整行级别的原因。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>La rose et le château, merci !</p></li>
  <li class="line"><p>a rose is a rose is a rose</p></li>
  <li class="line"><p>Merci, mon ami. Bonjour !</p></li>
  <li class="line"><p>Copyright MGMT :Fann</p></li>
  <li class="line"><p>℗ 2024 Some Label</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(350);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const pairsOf = (i) =>
    new Map(
      [...ps[i].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
    );

  const fr = pairsOf(0);
  assert.strictEqual(fr.get("rose"), "ロゼ", "法语行的 rose 是 ロゼ：" + JSON.stringify([...fr]));
  assert.strictEqual(fr.get("château"), "シャトー");
  assert.strictEqual(fr.get("merci"), "メルシー");
  const en = pairsOf(1);
  assert.strictEqual(en.get("rose"), "ローズ", "英文行的 rose 还是 ローズ：" + JSON.stringify([...en]));
  const fr2 = pairsOf(2);
  assert.strictEqual(fr2.get("Merci"), "メルシー");
  assert.strictEqual(fr2.get("ami"), "アミ");
  assert.strictEqual(fr2.get("Bonjour"), "ボンジュール");
  // 版权行：关键词开头就足以判定（冒号在名字后面，老判据够不着）
  assert.strictEqual(rubyCount(ps[3]), 0, "`Copyright MGMT :Fann` 不许注音：" + ps[3].innerHTML);
  assert.strictEqual(rubyCount(ps[4]), 0, "`℗ 2024 Some Label` 不许注音：" + ps[4].innerHTML);
});

// ---------------------------------------------------------------- 西文各语种（用户给的 7 组用例）

/** 把第 i 行的 ruby 收成 Map（底字 -> 注音） */
function linePairs(ps, i) {
  return new Map(
    [...ps[i].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
}

test("德语歌词（用例 1）：整行走德语拼读，英文行不受影响", async () => {
  // 用户给的第一组用例是德语歌词（Regentropfen sind meine Tränen 那首），
  // 一首歌里德语段和英文段交替 —— 所以判定必须在整行级别。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>die Ruinenstadt ist immer noch schön</p></li>
  <li class="line"><p>ich warte lange Zeit auf deine Rückkehr</p></li>
  <li class="line"><p>in der Hand ein Vergissmeinnicht</p></li>
  <li class="line"><p>It might be just like a bird in the cage</p></li>
  <li class="line"><p>I need you to be stronger than anyone</p></li>
  <li class="line"><p>Regentropfen sind meine Tränen</p></li>
  <li class="line"><p>Wind ist mein Atem und meine Erzählung</p></li>
  <li class="line"><p>denn mein Körper ist in Wurzeln gehüllt</p></li>
  <li class="line"><p>werde ich wach und singe ein Lied</p></li>
  <li class="line"><p>erinnerst du dich noch?</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  assert.strictEqual(l0.get("die"), "ディー", JSON.stringify([...l0]));
  assert.strictEqual(l0.get("ist"), "イスト");
  assert.strictEqual(l0.get("immer"), "イマー");
  assert.strictEqual(l0.get("noch"), "ノッホ");
  assert.strictEqual(l0.get("schön"), "シェーン");

  const l1 = linePairs(ps, 1);
  assert.strictEqual(l1.get("ich"), "イッヒ");
  assert.strictEqual(l1.get("warte"), "ヴァルテ");
  assert.strictEqual(l1.get("Zeit"), "ツァイト");
  assert.strictEqual(l1.get("deine"), "ダイネ");
  assert.strictEqual(l1.get("Rückkehr"), "リュックケーア");

  const l2 = linePairs(ps, 2);
  assert.strictEqual(l2.get("der"), "デア");
  assert.strictEqual(l2.get("Hand"), "ハント");
  // フェアギスマインニヒト（不是引擎拼的 フェアギスマイニッヒト）：这句是
  // Vergiss-mein-nicht，"mein" 的 n 要跟后面的 "nicht" 合成 ンニ —— 真机素材
  // 沉淀进词典的就是这个写法（见 tools/seed-words-learned.js）
  assert.strictEqual(l2.get("Vergissmeinnicht"), "フェアギスマインニヒト");

  // 英文行照旧走词典/英文规则（没被德语带歪）
  const en = linePairs(ps, 3);
  assert.strictEqual(en.get("the"), "ザ", JSON.stringify([...en]));
  assert.strictEqual(en.get("bird"), "バード");
  assert.strictEqual(en.get("cage"), "ケイジ");
  const en2 = linePairs(ps, 4);
  assert.strictEqual(en2.get("stronger"), "ストロンガー", JSON.stringify([...en2]));
  assert.strictEqual(en2.get("need"), "ニード");

  const l5 = linePairs(ps, 5);
  assert.strictEqual(l5.get("Regentropfen"), "レーゲントロプフェン");
  assert.strictEqual(l5.get("sind"), "ズィント");
  assert.strictEqual(l5.get("Tränen"), "トレーネン");

  const l6 = linePairs(ps, 6);
  assert.strictEqual(l6.get("Wind"), "ヴィント");
  assert.strictEqual(l6.get("Atem"), "アーテム");
  assert.strictEqual(l6.get("und"), "ウント");
  assert.strictEqual(l6.get("Erzählung"), "エアツェールング");

  const l9 = linePairs(ps, 9);
  assert.strictEqual(l9.get("dich"), "ディッヒ");
  assert.strictEqual(l9.get("noch"), "ノッホ");
});

test("拉丁语歌词（用例 2 / 5 / 7）：古典式拼读 + 短句靠整首投票", async () => {
  // 用例 7 里有好几个两三个词的短行（`Venu` / `Resurgito` / `Illusio`），
  // 单看一行判不出来 —— 整首都是拉丁语时按拉丁语读（main.js 的 songLanguage）。
  // `Vindicia … Vanitatum sentio … dolor, ah dolores` 那行要和用户截图里的
  // 参考答案一致（ヴィンディキア / ヴァニタトゥム / センティオ / ドロル / ドロレス）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Vosmet vetat res coelica</p></li>
  <li class="line"><p>Iam premet letum vastum te</p></li>
  <li class="line"><p>Vae gnari sunt suimet quis in oculis</p></li>
  <li class="line"><p>Dominatus</p></li>
  <li class="line"><p>Igni, cinis</p></li>
  <li class="line"><p>Resurgito</p></li>
  <li class="line"><p>Novum mundum omnibus aequum condemus</p></li>
  <li class="line"><p>In fine ab Anastasia servati sumus, aurora orietur</p></li>
  <li class="line"><p>Vindicia (A: Vanitatum sentio) (B: Sentio dolor, ah dolores)</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  assert.strictEqual(l0.get("Vosmet"), "ヴォスメト", JSON.stringify([...l0]));
  assert.strictEqual(l0.get("vetat"), "ヴェタト");
  assert.strictEqual(l0.get("coelica"), "コエリカ");

  const l2 = linePairs(ps, 2);
  assert.strictEqual(l2.get("Vae"), "ヴァエ");
  assert.strictEqual(l2.get("gnari"), "グナリ");
  assert.strictEqual(l2.get("quis"), "クイス");

  const l4 = linePairs(ps, 4);
  assert.strictEqual(l4.get("Igni"), "イグニ");
  assert.strictEqual(l4.get("cinis"), "キニス");

  // 短行：整首投票兜底也应该是拉丁语（不是英语规则）
  const l3 = linePairs(ps, 3);
  assert.strictEqual(l3.get("Dominatus"), "ドミナトゥス", JSON.stringify([...l3]));
  const l5 = linePairs(ps, 5);
  assert.strictEqual(l5.get("Resurgito"), "レスルギト", JSON.stringify([...l5]));

  const l6 = linePairs(ps, 6);
  assert.strictEqual(l6.get("Novum"), "ノヴム");
  assert.strictEqual(l6.get("omnibus"), "オムニブス");
  assert.strictEqual(l6.get("aequum"), "アエクウム");

  const l8 = linePairs(ps, 8);
  assert.strictEqual(l8.get("Vindicia"), "ヴィンディキア", JSON.stringify([...l8]));
  assert.strictEqual(l8.get("Vanitatum"), "ヴァニタトゥム");
  assert.strictEqual(l8.get("sentio"), "センティオ");
  assert.strictEqual(l8.get("dolor"), "ドロル");
  assert.strictEqual(l8.get("dolores"), "ドロレス");
});

test("斯瓦希里语歌词（用例 3 / 4）：按开音节直读，中文译文不注音", async () => {
  // 用户给的两大段斯瓦希里语用例都带中文译文（同一行里用 `/` 隔开），
  // 中文那边一个字都不该有注音（它本来也没有值得注音的字母）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Shambulia! Beba silaha / 出征，肩负一切</p></li>
  <li class="line"><p>Kwa nchi yetu tutaunguza damu yoyote / 为了家园燃尽最后的血</p></li>
  <li class="line"><p>Ushujaa waangaza mbingu na ardhi / 勇气点亮天空与大地</p></li>
  <li class="line"><p>Unasafirini kwa matakwa ya watu wako / 为了愿望而步上巡礼</p></li>
  <li class="line"><p>Ukuu ukuu / 荣耀终将归于</p></li>
  <li class="line"><p>Geuka kama alfajiri / 如曙光而行吧</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  assert.strictEqual(l0.get("Shambulia"), "シャンブリア", JSON.stringify([...l0]));
  assert.strictEqual(l0.get("Beba"), "ベバ");
  assert.strictEqual(l0.get("silaha"), "シラハ");

  const l1 = linePairs(ps, 1);
  assert.strictEqual(l1.get("nchi"), "ンチ");
  assert.strictEqual(l1.get("yetu"), "イェトゥ");
  assert.strictEqual(l1.get("damu"), "ダム");

  const l2 = linePairs(ps, 2);
  assert.strictEqual(l2.get("waangaza"), "ワアンガザ");
  assert.strictEqual(l2.get("mbingu"), "ンビング", JSON.stringify([...l2]));

  const l3 = linePairs(ps, 3);
  assert.strictEqual(l3.get("Unasafirini"), "ウナサフィリニ");
  assert.strictEqual(l3.get("matakwa"), "マタクワ");

  // 中文译文部分一个注音都没有
  for (let i = 0; i < ps.length; i++) {
    const rubies = [...ps[i].querySelectorAll("ruby.wk-ruby")];
    for (const r of rubies) {
      assert.ok(!/[\u4e00-\u9fa5]/.test(r.childNodes[0].nodeValue), "中文不许注音：" + ps[i].innerHTML);
    }
  }
});

test("拉丁语行的段标 `(A:` / `(B:` 不注音，同行的词照常标", async () => {
  // 用户截图：用例 7 里 `Vindicia (A: Vanitatum sentio) (B: Sentio dolor, ah dolores)`
  // —— A / B 是分句标记，头上却出现了读音。判据只看"这个字母后面紧跟冒号"，
  // 所以 `(A, B)` 那种成串的照样读字母名（用户当初要的就是那个）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Vindicia (A: Vanitatum sentio) (B: Sentio dolor, ah dolores)</p></li>
  <li class="line"><p>(A, B) 退屈に打つ QTE</p></li>
  <li class="line"><p>A story of love and I</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  assert.strictEqual(l0.get("A"), undefined, "段标 A 不许注音：" + JSON.stringify([...l0]));
  assert.strictEqual(l0.get("B"), undefined, "段标 B 不许注音：" + JSON.stringify([...l0]));
  // 同行的词一个都不能少
  assert.strictEqual(l0.get("Vindicia"), "ヴィンディキア");
  assert.strictEqual(l0.get("Vanitatum"), "ヴァニタトゥム");
  assert.strictEqual(l0.get("sentio"), "センティオ");
  assert.strictEqual(l0.get("dolores"), "ドロレス");

  // 反向：成串的大写单字母还是读字母名（这是用户之前点名要的）
  const l1 = linePairs(ps, 1);
  assert.strictEqual(l1.get("A"), "エー", JSON.stringify([...l1]));
  assert.strictEqual(l1.get("B"), "ビー");
  // 英文行里的冠词 A 照旧
  const l2 = linePairs(ps, 2);
  assert.strictEqual(l2.get("A"), "ア", JSON.stringify([...l2]));
});

test("段标不会被「学会的词」带出读音；呼语 O 读 オー", async () => {
  // 两条都是用户截图上来的。一是 `Ah senta (A: …` 里的 A 一直带着 アー ——
  // 光加"段标不注音"还不够：机器上早就攒了一条词级的 `a → アー`（模型在 `(A:` 那种行里
  // 答的、答稳了两次被沉淀成离线词条），而"学会的词"排在所有规则前面，把规则绕过去了；
  // 现在段标判定摆到最前面，单字母不再沉淀，老词条也一次性清掉。
  // 二是 `O Chrysalis` 里的 O 是呼语（"哦 / 啊"），该读 オー —— 用户点名要它标上。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Ah senta (A: Dolores sentio)</p></li>
  <li class="line"><p>O Chrysalis</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, {
    config: { online: false, llmEnabled: false },
    // 模拟真机：老版本攒下来的单字母词条
    legacyKeys: {
      "western-katakana.learned.v1": JSON.stringify({ version: 1, words: { a: { k: "アー", at: 1 } }, seen: {} }),
    },
  });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  assert.strictEqual(l0.get("A"), undefined, "段标 A 不许注音（学会的词也不行）：" + JSON.stringify([...l0]));
  assert.strictEqual(l0.get("Ah"), "アー", JSON.stringify([...l0]));
  assert.strictEqual(l0.get("Dolores"), "ドロレス");
  // 老的单字母词条要被一次性清掉（以后也不会再收）
  assert.deepStrictEqual([...env.api.learn.list()], [], "单字母的老词条要清掉：" + JSON.stringify([...env.api.learn.list()]));

  const l1 = linePairs(ps, 1);
  assert.strictEqual(l1.get("O"), "オー", "呼语 O 要注音：" + JSON.stringify([...l1]));
});

test("说话人段标 `M:` 留白，同一行里 `匿名M` 的 M 照读 エム", async () => {
  // 用户截图：`M: 匿名Mです。` —— 行首那个 M 是说话人标记（该留白），
  // 而 `匿名M` 里的 M 是名字的一部分，该读 エム。
  // 老判据是"这一行里有没有 `M` 跟着冒号"，于是两个 M 一起被留白（一个字都没有）。
  // 现在按 token 的位置判：单字母后面（可夹空白）紧跟冒号才算段标。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>M: 匿名Mです。</p></li>
  <li class="line"><p>M 匿名Mです。</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  // 第一行：只有 `匿名M` 那个 M 有注音，行首的段标一个字都不许加
  const rubies0 = [...ps[0].querySelectorAll("ruby.wk-ruby")];
  assert.deepStrictEqual(
    rubies0.map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]),
    [["M", "エム"]],
    "段标留白、名字里的 M 要注音：" + ps[0].innerHTML
  );
  // 有注音的那个 M 前面是 `匿名`（名字里的 M），不是行首的段标
  assert.strictEqual(String(rubies0[0].previousSibling.nodeValue).slice(-2), "匿名", "注音的该是名字里的 M");
  // 原文一个字都没动（只多了 <ruby> 里的注音）
  const rtText = rubies0.map((r) => r.querySelector(".wk-rt").textContent).join("");
  assert.strictEqual(ps[0].textContent.replace(rtText, ""), "M: 匿名Mです。", "原文一个字都不能改：" + ps[0].innerHTML);

  // 第二行没有冒号，行首的 M 就不是段标（照字母名读）
  const l1 = [...ps[1].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]);
  assert.deepStrictEqual(l1, [["M", "エム"], ["M", "エム"]], "没有冒号时行首 M 不是段标：" + ps[1].innerHTML);
});

test("外语行不做首音校验：拉丁语 vacuum 的 ワクーム 也会被收下（英文行仍然卡）", async () => {
  // 用户报的「Vacuum 的读音一直是黄的」：黄的 = 规则层（暂定），说明模型答案没被收下。
  // 根因是首音校验 —— 那套判据按英语拼写定的（v → バ行/ヴ），拉丁语的
  // vacuum 读 ワクーム 就被判成"不是音译"丢掉，而 miss 是永久的（还落盘），
  // 于是那个词永远停在规则层。现在外语行整行跳过这道校验。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Vacuum, fatuus</p></li>
  <li class="line"><p>the blorf is loud</p></li>
</ul></div></div>
</body></html>`;
  const asked = [];
  const env = bootPlugin(HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions", online: false },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const content = JSON.parse(init.body).messages[0].content;
      const items = JSON.parse(content.slice(content.indexOf("[")));
      asked.push(items.map((it) => it.w + "@" + String(it.line).slice(0, 12)));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "ワクーム"; // 模型给的拉丁语读音（英语口径下会被判掉）
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1800);

  const ps = env.document.querySelectorAll("ul.lyric li p");
  assert.ok(asked.length >= 1, "应该问过模型：" + JSON.stringify(asked));
  assert.ok(asked.some((batch) => batch.some((w) => w.indexOf("vacuum@") === 0)), "vacuum 要问模型：" + JSON.stringify(asked));
  assert.ok(asked.some((batch) => batch.some((w) => w.indexOf("blorf@") === 0)), "英文行的 blorf 也要问：" + JSON.stringify(asked));

  const latin = linePairs(ps, 0);
  assert.strictEqual(latin.get("Vacuum"), "ワクーム", "外语行要收下模型答案：" + JSON.stringify([...latin]));
  assert.strictEqual(latin.get("fatuus"), "ワクーム", "外语行要收下模型答案：" + JSON.stringify([...latin]));

  // 英文行：同一个答案仍然要被首音校验拦住（b 开头的音译首音必须落在 バ行）
  const en = linePairs(ps, 1);
  assert.notStrictEqual(en.get("blorf"), "ワクーム", "英文行不许放这种答案进来：" + JSON.stringify([...en]));
  const rejected = env.api.llm.rejects().filter((r) => String(r.word).toLowerCase() === "blorf");
  assert.ok(rejected.length >= 1 && rejected[0].why === "没通过首音校验", "英文行要记一条被拒：" + JSON.stringify(env.api.llm.rejects()));
});

test("一次性清掉旧的「问过但没收下」记录：被误伤的答案会重新问一遍", async () => {
  // 用户报的「Vacuum 一直是黄的」在真机上还有第二层原因：那条 miss 是永久的、
  // 还落了盘（当时被首音校验判掉了）。校验放宽之后老记录就成了误伤，所以
  // core/llm.js 载入缓存时会一次性把它们清掉（用一个小标记记住，命中不动）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Vacuum, fatuus</p></li>
</ul></div></div>
</body></html>`;
  const legacy = {};
  legacy["vacuum\u0000Vacuum, fatuus"] = { miss: true, t: Date.now(), said: "ワクーム", why: "没通过首音校验", at: Date.now() };
  legacy["fatuus\u0000Vacuum, fatuus"] = { k: "ファトゥウス", t: Date.now() }; // 命中：一条都不许动

  const asked = [];
  const env = bootPlugin(HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions", online: false },
    legacyKeys: { "western-katakana.llm.v1": JSON.stringify(legacy) },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const content = JSON.parse(init.body).messages[0].content;
      const items = JSON.parse(content.slice(content.indexOf("[")));
      asked.push(items.map((it) => it.w));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "ワクーム";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1800);

  const words = [].concat.apply([], asked).map((w) => String(w).toLowerCase());
  assert.ok(words.indexOf("vacuum") >= 0, "被误伤的 vacuum 要重新问：" + JSON.stringify(asked));
  assert.strictEqual(words.indexOf("fatuus"), -1, "命中过的词不该重问：" + JSON.stringify(asked));
  // 页面上的 Vacuum 换成了模型答案（不再是规则层的暂定值）
  const got = linePairs(env.document.querySelectorAll("ul.lyric li p"), 0);
  assert.strictEqual(got.get("Vacuum"), "ワクーム", JSON.stringify([...got]));
  // 落盘的缓存里也不该再有那条 miss
  const raw = JSON.parse(env.window.localStorage.getItem("western-katakana.llm.v1"));
  assert.ok(!raw["vacuum\u0000Vacuum, fatuus"] || raw["vacuum\u0000Vacuum, fatuus"].miss !== true, "老的 miss 要清掉：" + JSON.stringify(raw));
});

test("拉丁语行的呼语 O 与连词 o：大写读 オー、小写读 オ（截图里的 `(O … o …`）", async () => {
  // 用户截图：`Lucis, lapsus (O tragedia o splendidae)` 一类行 —— 大写的 O
  // （呼语，读 オー）标上了，小写的 o（拉丁语连词"或"，读 オ）全空着。
  // 两个都补上：小写 o 进"单字母真词"白名单（letters.js），大写 O 那条在 main.js。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Lucis, lapsus (O tragedia o splendidae)</p></li>
  <li class="line"><p>Fatua, caeca (O fatalita o infaustae)</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  assert.strictEqual(l0.get("O"), "オー", "呼语 O 读 オー：" + JSON.stringify([...l0]));
  assert.strictEqual(l0.get("o"), "オ", "连词 o 读 オ：" + JSON.stringify([...l0]));
  assert.strictEqual(l0.get("Lucis"), "ルキス");
  assert.strictEqual(l0.get("lapsus"), "ラプスス");
  assert.strictEqual(l0.get("tragedia"), "トラゲディア");
  assert.strictEqual(l0.get("splendidae"), "スプレンディダエ");

  const l1 = linePairs(ps, 1);
  assert.strictEqual(l1.get("O"), "オー");
  assert.strictEqual(l1.get("o"), "オ");
  assert.strictEqual(l1.get("fatalita"), "ファタリタ", JSON.stringify([...l1]));
  assert.strictEqual(l1.get("infaustae"), "インファウスタエ");
});

test("整块署名表：关键词表有长尾，靠「周围一整片都是署名行」兜住", async () => {
  // 用户贴了一整块 HOYO-MiX 的署名（作词/作曲/编曲/演唱/尺八/乐队/录音棚/录音师/
  // 出品/音频编辑/混音师/母带制作），截图里 `尺八 Shakuhachi：顾剑楠 Jiannan Gu`
  // 那行的 Shakuhachi / Jiannan / Gu 被注了音 —— 关键词表里没有"尺八"，
  // 而这一类长尾（乐器 / 声部 / 工种）永远补不完。
  // 现在两层保险：补了一批长尾关键词、允许标签里带括号；周围 ≥3 行像署名、
  // 且占四成以上时，整片都当署名表跳过。
  const CREDITS = [
    "作词 Lyricist：项柳 Hsiang Liu",
    "作曲 Composer：陈致逸 Yu-Peng Chen (HOYO-MiX)",
    "管弦配器 Orchestrator：陈致逸 Yu-Peng Chen (HOYO-MiX)",
    "编曲（电子） Arranger：姜以君 Yijun Jiang (HOYO-MiX)",
    "演唱 Voice：Paolo Andrea Di Pietro",
    "尺八 Shakuhachi：顾剑楠 Jiannan Gu",
    // 这一行的标签两个表里都没有（杖鼓 = 长鼓），只能靠"前后都是署名行"那条局部规则兜住
    "杖鼓 Janggu：李三 San Li",
    "乐队 Orchestra：Budapest Scoring Orchestra / Art of Loong Orchestra 龙之艺交响乐团",
    "录音棚 Recording Studio：Budapest Scoring / 上海音像公司录音棚 YX STUDIO",
    "录音师 Recording Engineer：Dénes Rédly / 莫家伟 Jiawei Mo / 黄巍 Zach Huang",
    "出品 Produced by：HOYO-MiX",
    "音频编辑 Editing Engineer：徐威 Aaron Xu",
    "混音师 Mixing Engineer：黄巍 Zach Huang",
    "母带制作 Mastering Engineer：黄巍 Zach Huang",
  ];
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>きらめく light と clover</p></li>
  <li class="line"><p>Music と light の 中で</p></li>
${CREDITS.map((c) => '  <li class="line"><p>' + c + "</p></li>").join("\n")}
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  // 前两行是真歌词，照常注音（尤其 `Music と light の 中で`：不能因为以 Music 开头就杀）
  assert.ok(rubyCount(ps[0]) >= 2, "真歌词要注音：" + ps[0].innerHTML);
  const lyric = new Map([...ps[1].querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent]));
  assert.strictEqual(lyric.get("Music"), "ミュージック", "以 Music 开头但后面是空格的**真歌词**不该被当署名：" + JSON.stringify([...lyric]));
  assert.strictEqual(lyric.get("light"), "ライト", JSON.stringify([...lyric]));

  // 整块署名：一行都不许有注音（含关键词表里没有的"尺八 / 乐队 / 音频编辑"）
  for (let i = 0; i < CREDITS.length; i++) {
    const p = ps[i + 2];
    assert.strictEqual(rubyCount(p), 0, "署名行不许注音：" + CREDITS[i] + " → " + p.innerHTML);
  }

  // 反向：同一条"长尾署名"单独出现（周围不是署名行）时不跳过 —— 那条局部规则只看邻居
  const ALONE = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>きらめく light と clover</p></li>
  <li class="line"><p>杖鼓 Janggu：李三 San Li</p></li>
  <li class="line"><p>ずっと dream を見てた</p></li>
</ul></div></div>
</body></html>`;
  const env2 = bootPlugin(ALONE, { config: { online: false, llmEnabled: false } });
  await env2.runLoad();
  await sleep(300);
  const ps2 = env2.document.querySelectorAll("ul.lyric li p");
  assert.ok(rubyCount(ps2[1]) > 0, "周围不是署名行时不该连它也跳过：" + ps2[1].innerHTML);
});

test("日语行里的拉丁词走词典：同一个 `Ave` 不许两行两个读音", async () => {
  // 用户截图：`Ave Musica...仮面の民は誘う(Fortuna)` 里 Ave 被读成 アヴェ（拉丁语引擎），
  // 而同一首歌的 `Ave Musica...安らかな世界へ(Lacrima)` 里是 アベ（词典，用户点名
  // "Ave Mujica 官方读 アベ"）。根因：前者被判成了拉丁语行（`ave` 在拉丁语词表里），
  // 整行走规则层、把词典盖掉了；后者没判成拉丁语，所以词典生效。
  //
  // 现在：有假名的行就是日语行，不做外语判定 —— 日语歌里的拉丁词照旧"词典优先"。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Ave Musica...仮面の民は誘う(Fortuna)</p></li>
  <li class="line"><p>Ave Musica...安らかな世界へ(Lacrima)</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  const l1 = linePairs(ps, 1);
  assert.strictEqual(l0.get("Ave"), "アベ", "日语行里走词典：" + JSON.stringify([...l0]));
  assert.strictEqual(l1.get("Ave"), "アベ", JSON.stringify([...l1]));
  assert.strictEqual(l0.get("Ave"), l1.get("Ave"), "同一个词两行必须同一个读音");
  // 纯拉丁语行仍然走引擎（那才是拉丁语），这条由 langs.test.js 的用例守着
  assert.strictEqual(env.api.lang("Ave Musica...仮面の民は誘う(Fortuna)").id, null, "有假名的行不判外语");
});

test("人工词典优先于「学会的词」：模型沉淀的 `ave アヴェ` 不许盖掉人工的 アベ", async () => {
  // 用户截图：`ゆこう（Ave Mujica | 世界）へと` 里的 Ave 是 アヴェ，而人工词表里
  // 明明写着 `ave アベ`（用户点名过"Ave Mujica 官方读 アベ"）。
  // 从真机的 localStorage 里读出来：学会的词里有一条 `ave => アヴェ` ——
  // 模型在别的行里答过 アヴェ 被沉淀成词条，而"学会的词"当时排在所有层前面，
  // 于是人工条目被绕过去了。现在它排到词典后面（人工 > 沉淀 > 大模型）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>ゆこう（Ave Mujica | 世界）へと</p></li>
  <li class="line"><p>ゆこう（Ave Fortuna の 世界）へと</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, {
    config: { online: false, llmEnabled: false },
    legacyKeys: {
      // 照抄真机：ave 被沉淀成了 アヴェ（错的）；fortuna 词典里没有，沉淀的 フォルトゥーナ 该用
      "western-katakana.learned.v1": JSON.stringify({
        version: 1,
        words: { ave: { k: "アヴェ", at: 2 }, fortuna: { k: "フォルトゥーナ", at: 3 } },
        seen: {},
      }),
    },
  });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  const got = linePairs(ps, 0);
  assert.strictEqual(got.get("Ave"), "アベ", "人工词典条目要赢：" + JSON.stringify([...got]));
  assert.strictEqual(got.get("Mujica"), "ムジカ", JSON.stringify([...got]));
  // 词典里没有的词，学会的词照旧生效（沉淀的意义就在这）
  const got2 = linePairs(ps, 1);
  assert.strictEqual(got2.get("Fortuna"), "フォルトゥーナ", "词典外的词照旧用学会的：" + JSON.stringify([...got2]));
});

test("德语行 `Sieh mit deinen Augen`：`mit` 不许念成 MIT 的字母名", async () => {
  // 用户截图：`mit` 被读成 エムアイティー（词典里的 MIT = 学院缩写）。
  // 根因两层：这行判不出德语（词表里只有 mit 一个词、分数不够），于是走了英文词典，
  // 而词典里 `mit` 就是 MIT 的字母名。现在补了一批德语独有词（sieh/deinen/augen…），
  // 整行能判成德语；人工词表又把 `mit` 钉成 ミット（德语最常用的介词，读法唯一）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Sieh mit deinen Augen</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const got = linePairs(env.document.querySelectorAll("ul.lyric li p"), 0);
  assert.strictEqual(env.api.lang("Sieh mit deinen Augen").id, "de", "这一行要判成德语");
  assert.strictEqual(got.get("mit"), "ミット", "mit 不许念字母名：" + JSON.stringify([...got]));
  assert.strictEqual(got.get("deinen"), "ダイネン", JSON.stringify([...got]));
  assert.strictEqual(got.get("Augen"), "アウゲン", JSON.stringify([...got]));
});

test("连字符串起来的长词：一行里每个词各自一个 ruby（不许压一整条超长注音）", async () => {
  // 用户截图：`A-Z Looser-Krankheit-Was IS das?` 那行，`Looser-Krankheit-` 上面
  // 压着一整条 `ルーザークランクハイトヴァス`，比底字还宽、和每个词都对不上
  //（"有些单词超长了效果不好"）。原因是整条连字符链被当成一个词。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>A-Z Looser-Krankheit-Was IS das?</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);

  const p = env.document.querySelectorAll("ul.lyric li p")[0];
  const bases = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue);
  assert.ok(!bases.includes("Looser-Krankheit-Was"), "整条链不许当成一个词：" + JSON.stringify(bases));
  // `A-Z` 是记号 -> 拆成 A / Z 两个字母各一个 ruby；连字符链 -> 拆成三个词
  assert.deepStrictEqual(bases, ["A", "Z", "Looser", "Krankheit", "Was", "IS", "das"], JSON.stringify(bases));
  // 底字一个字符都不能变（连字符还是普通文本，夹在几个 ruby 中间）
  assert.strictEqual(baseText(p), "A-Z Looser-Krankheit-Was IS das?");
  // 这一行判成德语（was / das + Krankheit 的 -heit，`A-Z` 里的 A 不再吃英语惩罚）
  assert.strictEqual(env.api.lang("A-Z Looser-Krankheit-Was IS das?").id, "de", "这一行要判成德语");
  // 每个词有自己的读音：`was` 是德语同形异音，走引擎的 ヴァス（不是英语词典的 ワズ）
  const got = linePairs(env.document.querySelectorAll("ul.lyric li p"), 0);
  assert.strictEqual(got.get("A"), "エー", "A-Z 是记号，逐字母读");
  assert.strictEqual(got.get("Z"), "ゼット");
  assert.strictEqual(got.get("Was"), "ヴァス", "德语行：was 不许读成英语的 ワズ：" + JSON.stringify([...got]));
  assert.strictEqual(got.get("Krankheit"), "クランクハイト");
});

test("德语人名 `Erika`：一行只有一个词也读 エーリカ（不许被罗马音层当日语罗马字）", async () => {
  // 用户截图：德语歌《Erika》里有一行只有 `Erika`（下一行是翻译「艾丽卡」）。
  // 整行一个词、判不出语种 → 罗马音层把它当日语罗马字切成 エリカ，还标成"确定"
  // （蓝色），大模型那一层永远不会被问到；德语引擎也兜不住 —— 词首 `er-` 那条规则
  // 是给 erinnern / Erzählung 那种非重读前缀定的（エア…），套到名字上是 エアイーカ。
  // 德语 Erika 是长音 [ˈeːʁika]，所以人工钉进词典（エーリカ / エーリク）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Erika</p></li>
  <li class="line"><p>艾丽卡</p></li>
</ul></div></div></body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");
  assert.deepStrictEqual(PAIRS(ps[0]), [["Erika", "エーリカ"]], "德语人名要读长音");
  assert.strictEqual(env.api.read("Erika").source, "dict", "要有确定答案，不许停在罗马音层");
  assert.strictEqual(env.api.read("erik").kana, "エーリク");
  // 中文翻译行不注音；英文拼法的 Erica 仍是 エリカ（两回事）
  assert.strictEqual(rubyCount(ps[1]), 0, "翻译行不注音");
  assert.strictEqual(env.api.read("Erica").kana, "エリカ", "英文拼法 Erica 是短音");
});

test("俄语歌词（用例 6）：西里尔字母也注音（词典和罗马音层都读不了它）", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Мы Отчизну отстоим и восславим себя в веках / 保家卫国之人的荣光</p></li>
  <li class="line"><p>Виват Анастасия / 荣耀啊，吾皇安娜丝塔夏</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(400);
  const ps = env.document.querySelectorAll("ul.lyric li p");

  const l0 = linePairs(ps, 0);
  assert.strictEqual(l0.get("Мы"), "ムイ", JSON.stringify([...l0]));
  assert.strictEqual(l0.get("Отчизну"), "オチズヌ");
  assert.strictEqual(l0.get("отстоим"), "オトストイム");
  assert.strictEqual(l0.get("и"), "イ");
  assert.strictEqual(l0.get("восславим"), "ヴォスラヴィム");
  assert.strictEqual(l0.get("себя"), "セビャ");
  assert.strictEqual(l0.get("веках"), "ヴェカフ");

  const l1 = linePairs(ps, 1);
  assert.strictEqual(l1.get("Виват"), "ヴィヴァト", JSON.stringify([...l1]));
  assert.strictEqual(l1.get("Анастасия"), "アナスタシヤ");
});

test("非日语歌是否注音可以开关（默认注音，关掉只标日语歌）", async () => {
  // 用户要的「非日语歌可选是否标注」。判据看整首：整首歌词里一个假名都没有
  // （纯英文歌 / 法语歌 / 中文歌）才算非日语歌 —— 所以日语歌里的纯英文行不会被误伤。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>I love you so much</p></li>
  <li class="line"><p>Every night brings a dream</p></li>
</ul></div></div>
</body></html>`;
  const JP_HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>きらめく light と clover</p></li>
  <li class="line"><p>I love you so much</p></li>
</ul></div></div>
</body></html>`;

  // 默认（annotateNonJapanese 缺省 true）：照旧注音
  const envOn = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await envOn.runLoad();
  await sleep(300);
  assert.strictEqual(
    envOn.document.querySelectorAll("ul.lyric li p ruby.wk-ruby").length > 0,
    true,
    "默认要照旧注音（英文歌也标）"
  );

  // 关掉它：英文歌整首跳过，而且之前注上的要撤掉
  const envOff = bootPlugin(HTML, { config: { online: false, llmEnabled: false, annotateNonJapanese: false } });
  await envOff.runLoad();
  await sleep(300);
  assert.strictEqual(
    envOff.document.querySelectorAll("ul.lyric li p ruby.wk-ruby").length,
    0,
    "关掉之后英文歌不许注音：" + envOff.document.querySelector("ul.lyric").innerHTML
  );
  assert.strictEqual(envOff.api.state.lastResult.nonJapanese, true, "统计里要能看出是「非日语歌」跳过");

  // 日语歌：即使有纯英文行，也照旧注音
  const envJp = bootPlugin(JP_HTML, { config: { online: false, llmEnabled: false, annotateNonJapanese: false } });
  await envJp.runLoad();
  await sleep(300);
  const ps = envJp.document.querySelectorAll("ul.lyric li p");
  assert.ok(rubyCount(ps[0]) >= 2, "日语歌照常注音：" + ps[0].innerHTML);
  assert.ok(rubyCount(ps[1]) >= 3, "日语歌里的纯英文行也要注音：" + ps[1].innerHTML);
});

test("导出词库素材：已学会的词 + 两层缓存命中", async () => {
  // 用户要的「从学会的词和缓存中筛选填进离线词典」：运行期写不进 src/core/dict.js，
  // 所以先导出素材，再由 npm run promote:learned 筛选、npm run build:dict 合并。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>serendipity の 夜</p></li>
  <li class="line"><p>また serendipity を 探して</p></li>
</ul></div></div>
</body></html>`;
  const CONFIG = {
    llmEnabled: true,
    llmKey: "sk-test",
    llmEndpoint: "https://api.example.com/v1/chat/completions",
    online: false,
  };
  const env = bootPlugin(HTML, {
    config: CONFIG,
    fetch: function (url, init) {
      const items = JSON.parse(JSON.parse(init.body).messages[0].content.slice(JSON.parse(init.body).messages[0].content.indexOf("[")));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "セレンディピティ";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1600);

  const dump = env.api.exportWords();
  assert.strictEqual(dump.version, 1);
  assert.deepStrictEqual(
    [...dump.learned].map((x) => [x.word, x.kana]),
    [["serendipity", "セレンディピティ"]],
    "已学会的词要出现在素材里：" + JSON.stringify(dump.learned)
  );
  // 大模型缓存也按词归并导出（构建期靠 lines / consistent 决定收不收）
  const llmHit = [...dump.llm].find((x) => x.word === "serendipity");
  assert.ok(llmHit, "缓存命中要出现在素材里：" + JSON.stringify(dump.llm));
  assert.strictEqual(llmHit.kana, "セレンディピティ");
  assert.ok(llmHit.lines >= 1);
  assert.strictEqual(llmHit.consistent, true);
  // JSON 版给面板按钮用（要能 parse 回来）
  const back = JSON.parse(env.api.exportWordsJson());
  assert.strictEqual(back.learned.length, 1);
  // 免费接口那层即使没开也占一个字段，构建期脚本不用判空
  assert.ok(Array.isArray(dump.google));
});

test("罗马音节行：这些短音节标成「没把握」，会送去问大模型按语境判", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>PA PI PU PE PO MA MI MU ME MO</p></li>
  <li class="line"><p>No, no, I need you so</p></li>
</ul></div></div>
</body></html>`;
  const asked = [];
  const env = bootPlugin(HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions", online: false },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      asked.push(items.map((it) => it.w));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = "テスト";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1400);

  const words = [].concat.apply([], asked).map((w) => String(w).toLowerCase());
  for (const w of ["pi", "pe", "po", "mi", "me", "mo"]) {
    assert.ok(words.indexOf(w) >= 0, w + " 该送去问模型（罗马音节行，词典会读歪）：" + words.join(","));
  }
  // 「PA」没有词典条目、罗马音本来就是对的，不必浪费请求
  assert.ok(words.indexOf("pa") < 0, "PA 不用问：" + words.join(","));
  // 两可的英文短词也要问：`no` 既可能是 ノー（英文）也可能是 ノ（唱名/罗马字），
  // 只能靠整句语境 —— 模型给不出来就保持词典读音。
  assert.ok(words.indexOf("no") >= 0, "no 两可，要问模型：" + words.join(","));
  // 确定的英文词不问
  assert.ok(words.indexOf("need") < 0, "need 是确定的，不该问：" + words.join(","));
});

test("两可的短音节：大模型按整句语境判（Do→ド / Re→レ），英文里仍是 ドゥー/リー", async () => {
  // 用户报的：「Do」「Re」「Meet」 を重ねて 效果差 —— 词典给的是英文读音
  // （Do ドゥー、Re リー），但唱名/罗马音节要 ド/レ。光看拼写分不出来，
  // 所以这些词标成"没把握"，交给模型按那句话决定。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>「Do」「Re」「Meet」 を重ねて</p></li>
</ul></div></div>
</body></html>`;
  const asked = [];
  const env = bootPlugin(HTML, {
    config: { llmEnabled: true, llmKey: "sk-test", llmEndpoint: "https://api.example.com/v1/chat/completions", online: false },
    fetch: function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
      asked.push(items.map((it) => it.w));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = it.w === "Do" || it.w === "do" ? "ド" : it.w === "Re" || it.w === "re" ? "レ" : "テスト";
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1500);

  const words = [].concat.apply([], asked).map((w) => String(w).toLowerCase());
  assert.ok(words.indexOf("do") >= 0 && words.indexOf("re") >= 0, "do/re 要问模型：" + words.join(","));

  const p = env.document.querySelector("ul.lyric li p");
  const got = new Map(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(got.get("Do"), "ド", "唱名要按语境读成 ド：" + JSON.stringify([...got]));
  assert.strictEqual(got.get("Re"), "レ", "唱名要按语境读成 レ：" + JSON.stringify([...got]));
  assert.strictEqual(got.get("Meet"), "ミート", "确定的词保持词典读音");
  assert.strictEqual(baseText(p), "「Do」「Re」「Meet」 を重ねて");
});

test("Shoo / Gimme / Yeah：词典里补上，不再被罗马音层抢走", async () => {
  // 用户报的：Shoo 读成 ショオ、Gimme 读成 ギッメ（这两个词词典里根本没有，
  // 于是被"能切成音节就收"的罗马音层抢走了）；Yeah 读成 イェア（该是 イェイ）。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>Shoo, Gimme more, Yeah!</p></li>
</ul></div></div>
</body></html>`;
  const env = bootPlugin(HTML, { config: { online: false, llmEnabled: false } });
  await env.runLoad();
  await sleep(250);
  const p = env.document.querySelector("ul.lyric li p");
  const got = new Map(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".wk-rt").textContent])
  );
  assert.strictEqual(got.get("Shoo"), "シュー", "Shoo 该是 シュー：" + JSON.stringify([...got]));
  assert.strictEqual(got.get("Gimme"), "ギミー", "Gimme 该是 ギミー");
  assert.strictEqual(got.get("more"), "モア", "more 该是 モア");
  assert.strictEqual(got.get("Yeah"), "イェイ", "Yeah 该是 イェイ");
});

test("学会的词：模型在两个句子里答同一个读音 -> 沉淀成离线词条，重启后不再问", async () => {
  // 用户要的：「让运行期模型给的答案自动沉淀进词典」。
  // 模型那层是按「词 + 那一句」缓存的，换首歌同一句再来就得重新花钱问；
  // 沉淀之后它就是离线词条（source: learned），以后一个请求都不发。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>serendipity の 夜</p></li>
  <li class="line"><p>また serendipity を 探して</p></li>
</ul></div></div>
</body></html>`;
  // 前提：这个词词典里没有（不然根本不会去问模型）
  assert.strictEqual(envDictHas("serendipity"), false, "前提：serendipity 不在离线词典里");

  const asked = [];
  const fakeLlm = (answer) =>
    function (url, init) {
      if (!init || !init.body) return Promise.reject(new Error("offline (test)"));
      const items = JSON.parse(JSON.parse(init.body).messages[0].content.slice(JSON.parse(init.body).messages[0].content.indexOf("[")));
      asked.push(items.map((it) => String(it.w).toLowerCase()));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = answer(it.w);
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    };
  const CONFIG = {
    llmEnabled: true,
    llmKey: "sk-test",
    llmEndpoint: "https://api.example.com/v1/chat/completions",
    online: false,
  };

  const env = bootPlugin(HTML, { config: CONFIG, fetch: fakeLlm(() => "セレンディピティ") });
  await env.runLoad();
  await sleep(1600);

  // 页面用的是模型答案
  const ps = env.document.querySelectorAll("ul.lyric li p");
  for (const p of ps) {
    const rt = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => r.querySelector(".wk-rt").textContent);
    assert.deepStrictEqual(rt, ["セレンディピティ"], "两句都要用模型答案：" + p.innerHTML);
  }
  // 两句 -> 收下
  const learned = env.api.learn.list();
  assert.deepStrictEqual(
    [...learned].map((x) => [x.word, x.kana]),
    [["serendipity", "セレンディピティ"]],
    "两句答同一个读音就该沉淀：" + JSON.stringify(learned)
  );
  // 沉淀之后页面上的来源就是 learned（排障上色会显示成"学会的词"）
  assert.strictEqual(env.api.state.learned.peek("serendipity"), "セレンディピティ");

  /*
   * 重开一次（模拟重启网易云）：把沉淀下来的那份 localStorage 搬到新的页面里，
   * 换成"什么都不许问"的 fetch —— 只要还在注音，就说明它没再花请求。
   */
  const saved = env.window.localStorage.getItem("western-katakana.learned.v1");
  assert.ok(saved && saved.indexOf("セレンディピティ") >= 0, "要落盘：" + saved);

  let calls = 0;
  const env2 = bootPlugin(HTML, {
    config: CONFIG,
    fetch: function () {
      calls++;
      return Promise.reject(new Error("不该有任何请求"));
    },
  });
  env2.window.localStorage.setItem("western-katakana.learned.v1", saved);
  await env2.runLoad();
  await sleep(600);

  const ps2 = env2.document.querySelectorAll("ul.lyric li p");
  const got2 = [...ps2[0].querySelectorAll("ruby.wk-ruby")].map((r) => r.querySelector(".wk-rt").textContent);
  assert.deepStrictEqual(got2, ["セレンディピティ"], "重启后离线也要读对：" + ps2[0].innerHTML);
  assert.strictEqual(calls, 0, "已经学会的词一个字都不该再问模型（这就是省钱的地方）");
  // 来源标记也要是 learned（按来源上色时显示成"学会的词"）
  assert.ok(ps2[0].querySelector("ruby.wk-src-learned"), "要标成 learned 来源：" + ps2[0].innerHTML);
  // 面板上那一行也要报出来
  assert.ok(
    env2.api.learn.stats().count === 1 && env2.api.learn.stats().usedSession >= 1,
    "本次用上了几个要能数出来：" + JSON.stringify(env2.api.learn.stats())
  );

  // 读音不对时能忘掉：忘掉之后它又变成"要问模型"的词
  assert.strictEqual(env2.api.learn.forget("serendipity"), true);
  assert.strictEqual(env2.api.learn.stats().count, 0);
  assert.strictEqual(env2.api.learn.list().length, 0);
});

test("学会的词：只答过一次不收、两可的短音节不收、模型改口就撤销", async () => {
  // 收词的边界（收错了就是"错读音被钉成离线权威"）。三种都过一遍：只在一个句子里答过的不收；
  // 两可的短音节（do/re/mi…）不收，读音取决于那句话；后来改成别的读音的，把已收的撤销。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root"><div class="m-lyric"><ul class="lyric">
  <li class="line"><p>serendipity の 夜</p></li>
  <li class="line"><p>「Do」を 重ねて</p></li>
</ul></div></div>
</body></html>`;
  const CONFIG = {
    llmEnabled: true,
    llmKey: "sk-test",
    llmEndpoint: "https://api.example.com/v1/chat/completions",
    online: false,
  };
  const answerFor = (w) => (String(w).toLowerCase() === "do" ? "ド" : "セレンディピティ");
  const env = bootPlugin(HTML, {
    config: CONFIG,
    fetch: function (url, init) {
      const items = JSON.parse(JSON.parse(init.body).messages[0].content.slice(JSON.parse(init.body).messages[0].content.indexOf("[")));
      const out = {};
      items.forEach((it, i) => {
        out[String(i + 1)] = answerFor(it.w);
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(out) } }] }),
      });
    },
  });
  await env.runLoad();
  await sleep(1600);

  const learned = [...env.api.learn.list()].map((x) => x.word);
  assert.deepStrictEqual(learned, [], "只答过一次的不收；do 是两可的不收：" + JSON.stringify(learned));
  assert.ok(env.api.learn.stats().pending >= 1, "serendipity 要记成'待定'：" + JSON.stringify(env.api.learn.stats()));
  // do 连待定都不该有（两可词由上层直接挡掉）
  assert.strictEqual(env.api.state.learned.peek("do"), null);
});

test("设置面板：罗马音排在词典前面时给出提醒（它会把英文词按罗马音读）", async () => {
  const env = bootPlugin(NCM_HTML, { config: { layerOrder: ["romaji", "dict", "llm", "google", "rule"] } });
  await env.runLoad();
  const box = env.listeners.config[0]().querySelector(".wk-layers");
  const warn = box.querySelector(".wk-layer-warn");
  assert.ok(warn, "要有提醒：" + box.textContent);
  assert.ok(warn.textContent.indexOf("Shoo") >= 0, "要举例子说清后果：" + warn.textContent);

  const okEnv = bootPlugin(NCM_HTML, { dev: true });
  await okEnv.runLoad();
  assert.strictEqual(
    okEnv.listeners.config[0]().querySelector(".wk-layer-warn"),
    null,
    "默认顺序不该有提醒"
  );
});

test("设置面板：默认只有三块（开关 / 大模型 / 预览），其余收进「高级设置」", async () => {
  // 面板这些轮下来加了太多东西（外观/范围/层序/用量/排障/操作），用户要求简化。
  // 现在默认只留最常用的，其余折进一个 details。
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  const adv = root.querySelector("details.wk-adv");
  assert.ok(adv, "要有「高级设置」折叠块");
  assert.strictEqual(adv.open, false, "默认应该收起");

  const outside = [
    '[data-k="enabled"]',
    '[data-k="online"]',
    '[data-k="annotateAll"]',
    '[data-k="llmEnabled"]',
    '[data-k="llmKey"]',
    '[data-a="llmTest"]',
    ".wk-llm-state",
    ".wk-preview",
  ];
  for (const sel of outside) {
    const el = root.querySelector(sel);
    assert.ok(el, "要有 " + sel);
    assert.strictEqual(adv.contains(el), false, sel + " 应该默认就能看到（别收进高级）");
  }

  const inside = [
    '[data-k="llmEndpoint"]',
    '[data-k="llmModel"]',
    '[data-k="rtSize"]',
    '[data-k="rtOpacity"]',
    '[data-k="scope"]',
    ".wk-layers",
    ".wk-usage",
    '[data-a="rescan"]',
  ];
  for (const sel of inside) {
    const el = root.querySelector(sel);
    assert.ok(el, "高级里也要有 " + sel);
    assert.strictEqual(adv.contains(el), true, sel + " 应该收在高级设置里");
  }
  // 折叠块里仍然按标题分好组（别把东西堆成一坨）
  const titles = [...adv.querySelectorAll("h3")].map((h) => h.textContent);
  assert.deepStrictEqual(
    titles,
    ["接口", "外观", "范围", "读音来源顺序", "API 用量", "操作"],
    "高级里的分组：" + titles.join(" / ")
  );
});

test("设置面板的预览：高考听力那句 + 中文翻译行不注音", async () => {
  // 预览的示例句换成高考英语听力名句（「衬衫的价格为九磅十五便士」）。这里钉住三点：
  // 每个词的读音都从词典取（这批数字词原本不在词典里，规则层会读错：fifteen -> フィファテエン）；
  // 中文翻译行照样显示、但一个字都不注音（真机行为）；预览走的是真扫描 + 真读音逻辑，
  // 不是手写的字符串。
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  const preview = root.querySelector(".wk-preview");
  assert.ok(preview, "面板里应该有预览区");

  const pairs = [...preview.querySelectorAll("ruby.wk-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".wk-rt").textContent,
  ]);
  assert.deepStrictEqual(
    pairs,
    [
      ["The", "ザ"],
      ["shirt", "シャツ"],
      ["is", "イズ"],
      ["nine", "ナイン"],
      ["pounds", "パウンズ"],
      ["fifteen", "フィフティーン"],
      ["pence", "ペンス"],
    ],
    "预览示例句的读音"
  );

  const trans = preview.querySelector(".wk-preview-trans");
  assert.ok(trans, "预览里应该带一行中文翻译");
  assert.strictEqual(trans.textContent, "衬衫的价格为九磅十五便士");
  assert.strictEqual(trans.querySelectorAll("ruby, rt").length, 0, "翻译行不许注音");
});

test("改名搬家：老的 latin-katakana.* 键会复制到 western-katakana.*，老键留着", async () => {
  // 插件从 latin-katakana 改名成 western-katakana 之后，localStorage 的键前缀也换了。
  // 老用户的配置（含 API Key）、学会的词、模型缓存、用量账本不该因为一次改名全丢 ——
  // main.js 开头有一段一次性搬家：新键不存在、老键存在才复制，老键不删。
  const env = bootPlugin(NCM_HTML, {
    legacyKeys: {
      "latin-katakana.config": JSON.stringify({ rtSize: 99, rtOpacity: 42, llmKey: "sk-legacy", enabled: true }),
      "latin-katakana.usage": JSON.stringify({ session: {}, today: {}, total: {} }),
      "latin-katakana.learned.v1": JSON.stringify({ version: 1, words: { legacyword: { k: "レガシー", at: 1 } }, seen: {} }),
    },
  });
  await env.runLoad();

  // 配置跟着过来了（面板上显示的就是老值）
  assert.strictEqual(env.api.config.rtSize, 99, "老配置要搬过来");
  assert.strictEqual(env.api.config.llmKey, "sk-legacy");
  const root = env.listeners.config[0]();
  assert.strictEqual(root.querySelector('[data-k="rtSize"]').value, "99");
  assert.strictEqual(root.querySelector('[data-k="llmKey"]').value, "sk-legacy");

  // 新键都写出来了
  for (const suffix of [".config", ".usage", ".learned.v1"]) {
    assert.ok(env.window.localStorage.getItem("western-katakana" + suffix), "要写出 western-katakana" + suffix);
    assert.ok(env.window.localStorage.getItem("latin-katakana" + suffix), "老键留着不删：" + suffix);
  }
  // 学会的词也读得到（不是空表）
  const learned = env.api.learn.list();
  assert.ok(
    learned.some((r) => r.word === "legacyword" && r.kana === "レガシー"),
    JSON.stringify(learned)
  );

  // 反过来：新键已经存在时，不再被老键覆盖（否则用户改了设置又被老值盖回去）
  const env2 = bootPlugin(NCM_HTML, {
    config: { rtSize: 66 },
    legacyKeys: { "latin-katakana.config": JSON.stringify({ rtSize: 11 }) },
  });
  await env2.runLoad();
  assert.strictEqual(env2.api.config.rtSize, 66, "新键优先，老键不许盖回来");
});

test("设置面板能构建出来，改动落盘到 localStorage", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  assert.ok(root, "onConfig 应该返回一个元素");
  assert.strictEqual(root.id, "western-katakana-config");

  const enabled = root.querySelector('[data-k="enabled"]');
  assert.ok(enabled && enabled.type === "checkbox" && enabled.checked === true);

  const rtSize = root.querySelector('[data-k="rtSize"]');
  assert.strictEqual(rtSize.value, "55");
  rtSize.value = "70";
  rtSize.dispatchEvent(new env.window.Event("change"));

  const raw = env.window.localStorage.getItem("western-katakana.config");
  assert.ok(raw, "配置应该写进 localStorage");
  assert.strictEqual(JSON.parse(raw).rtSize, 70);
});

test("缺核心模块时优雅退出，不抛异常", () => {
  const ctx = loadCore(NCM_HTML, { reader: false });
  const window = ctx.window;
  window.fetch = () => Promise.reject(new Error("offline"));
  const listeners = [];
  window.plugin = {
    devMode: false,
    pluginPath: "",
    onLoad: (fn) => listeners.push(fn),
    onConfig: () => {},
  };
  window.betterncm = { app: {}, ncm: {}, fs: {} };
  for (const k of ["WKMatcher", "WKDict", "WKReading", "WKCorrect", "WKLLM", "WKAnnotate"]) delete window[k];

  assert.doesNotThrow(() => {
    loadScripts(ctx.dom, ["main.js"]);
    for (const fn of listeners) fn();
  }, "缺依赖时不应抛异常");
  assert.strictEqual(window.WK, undefined, "初始化失败就不该导出 API");
  assert.strictEqual(window.WesternKatakana, undefined);
});
