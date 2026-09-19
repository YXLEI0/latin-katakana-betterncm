/*
 * 集成测试：像 BetterNCM 那样把 7 个文件注入到一个页面里，
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
  const ctx = loadCore(html || NCM_HTML, { reader: false });
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
    window.localStorage.setItem("latin-katakana.config", JSON.stringify(saved));
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
    pluginPath: "C:/betterncm/plugins/latin-katakana",
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

  loadScripts(dom, FILES);

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
  // window.LatinKatakana 要到 onLoad 之后才存在（BetterNCM 就是这个顺序），
  // 所以这里用 getter 延迟取值，别在 boot 阶段就抄一份 undefined。
  Object.defineProperty(env, "api", {
    get: function () {
      return window.LatinKatakana;
    },
  });
  return env;
}

function rubyCount(root) {
  return root.querySelectorAll("ruby.lt-ruby").length;
}

/** 底字文本（剔掉注音）——标准 ruby 里 <rt> 的文本也算 textContent，必须显式去掉 */
function baseText(el) {
  const clone = el.cloneNode(true);
  const anns = clone.querySelectorAll("rt, .lt-rt, .kt-rt, .fg-rt, rp");
  for (let i = 0; i < anns.length; i++) {
    if (anns[i].parentNode) anns[i].parentNode.removeChild(anns[i]);
  }
  return clone.textContent;
}

const PAIRS = (p) =>
  [...p.querySelectorAll("ruby.lt-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".lt-rt").textContent]);

test("注入 7 个文件后，插件注册了 onLoad / onConfig 并导出 API", async () => {
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
  const rubies = env.document.querySelectorAll(".m-playbar ruby.lt-ruby");
  for (let i = 0; i < rubies.length; i++) pairs.push(rubies[i].querySelector(".lt-rt").textContent);
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
// 片假名终结者的 <rt class="kt-rt"> 里装的偏偏是**英文原词**（dream、hello…），
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
  // 别人的注音节点内部一个 lt-ruby 都不能有
  assert.strictEqual(p.querySelectorAll(".kt-rt ruby.lt-ruby, .fg-rt ruby.lt-ruby").length, 0);
  assert.strictEqual(p.querySelector(".kt-rt").textContent, "dream", "片假名终结者的英文注释不能被改写");
  assert.strictEqual(p.querySelector(".fg-rt").textContent, "よつば", "jp-furigana 的振假名不能被改写");
  // 底字不变（别人的 <rt> 不算底字）
  assert.strictEqual(baseText(p), "きらめく ドリーム と 四葉 clover");
});

/*
 * 上面的用例走的是「人家用真 <ruby>/<rt>」这条路 —— 那条路上 <rt> 标签本身
 * 就在 SKIP_TAGS 里，所以它证明不了我们认识对方的 **class**。
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
  assert.strictEqual(p.querySelectorAll(".kt-ruby ruby.lt-ruby, .kt-rt ruby.lt-ruby").length, 0, p.innerHTML);
  assert.strictEqual(p.querySelector(".kt-rt").textContent, "dream", "别人的注音文字不许被改写");
  assert.deepStrictEqual(PAIRS(p), [["clover", "クローバー"]], "同一行里我们该标的照样标");
});

/*
 * 三个插件同时开着时最要紧的一条：**反复扫描不能重注、不能进入认输期**。
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
  const pairs = [...line.querySelectorAll("ruby.lt-ruby")].map((r) => r.querySelector(".lt-rt").textContent);
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
  const pairs = [...p.querySelectorAll("ruby.lt-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".lt-rt").textContent]);
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
  // 记号整体一个 ruby，读音是字母名；不是把 A 单独读成 ア
  assert.deepStrictEqual(PAIRS(p), [["D/N/A", "ディーエヌエー"]]);
  assert.strictEqual(baseText(p), "だって D/N/Aじゃ 騙れない", "原文一字不改");
  const stats = env.api.stats();
  assert.ok(stats.reading.letterHits >= 1, "应该记在 letters 这一类上：" + JSON.stringify(stats.reading));
});

test("控制台诊断：LK 短别名存在，llm.check() 能一句话回答「生效了没有」", async () => {
  const env = bootPlugin();
  await env.runLoad();

  assert.strictEqual(typeof env.window.LK, "object", "文档里写的是 LK.xxx，别名必须挂上");
  assert.strictEqual(env.window.LK, env.window.LatinKatakana, "两个名字应该是同一个对象");
  assert.strictEqual(typeof env.window.LK.llm.check, "function");

  // 没填 key：check() 要说清是"没填 key"，而不是含糊的"没生效"
  const noKey = env.window.LK.llm.check();
  assert.ok(noKey.indexOf("API Key：没填") >= 0, noKey);
  assert.ok(noKey.indexOf("填 API Key") >= 0, noKey);

  // 填了 key 但还没问过任何词（歌词里的词全在词典里）：要解释"这层没活干"，而不是让人以为坏了
  env.window.LK.state.llm.configure({ key: "sk-test", enabled: true });
  const idle = env.window.LK.llm.check();
  assert.ok(idle.indexOf("请求 0 次") >= 0, idle);
  assert.ok(idle.indexOf("全在离线词典里") >= 0, idle);
});

test("控制台诊断：LK.display() 给的是页面上实际用的读音（可能是大模型换过的）", async () => {
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
  const local = env.window.LK.read("kaleidoscope");
  assert.strictEqual(local.source, "rule", "前提：词典里没有这个词：" + JSON.stringify(local));
  assert.strictEqual(env.window.LK.display("kaleidoscope"), "カレイドスコープ");
  assert.notStrictEqual(env.window.LK.display("kaleidoscope"), local.kana, "display 和 read 应该不一样");

  const verdict = env.window.LK.llm.check();
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
  assert.deepStrictEqual(PAIRS(p), [
    ["Mr", "ミスター"],
    ["Brown", "ブラウン"],
    ["Dr", "ドクター"],
    ["LDK", "エルディーケー"],
  ]);
  assert.strictEqual(baseText(p), "Mr. Brown と Dr. K、それから LDK の部屋", "原文（含句点）一字不改");
});

test("层序：规则的结果要等在线那层 —— 等待期间先不标，失败后立刻回落", async () => {
  // 用户要的顺序：大模型 -> 免费接口 -> 英文音译规则。
  // 所以有在线可用时，规则猜出来的读音**先不显示**（等准确的那个），
  // 但接口失败之后必须马上回落，不能一直空着。
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>きらめく kaleidoscope の夜</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  // 默认桩：所有请求都失败（离线）
  const env = bootPlugin(HTML);
  await env.runLoad();

  await sleep(300);
  const p = env.document.querySelector("ul.lyric li p");
  assert.strictEqual(rubyCount(p), 0, "在线那层还没回来：先不标规则猜的读音");
  assert.strictEqual(p.textContent, "きらめく kaleidoscope の夜", "底字当然不动");

  // 免费接口的攒批窗口 1.2s + 请求失败 -> 之后必须回落到规则
  await sleep(2600);
  assert.strictEqual(rubyCount(p), 1, "接口失败后要用规则兜底，不能一直空着：" + p.innerHTML);
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

test("用户报的 tick：离线也必须注成 ティック，不能是 カチカチ", async () => {
  const HTML = `<!doctype html><html><head></head><body>
<div id="root">
  <div class="m-lyric">
    <ul class="lyric">
      <li class="line"><p>時計の tick が カチカチ と鳴る</p></li>
    </ul>
  </div>
</div>
</body></html>`;
  const env = bootPlugin(HTML);
  await env.runLoad();
  await sleep(600);

  const p = env.document.querySelector("ul.lyric li p");
  // カチカチ 是日文原文（不是拉丁词），不该被碰；tick 要读成 ティック
  assert.deepStrictEqual(PAIRS(p), [["tick", "ティック"]]);
  assert.strictEqual(baseText(p), "時計の tick が カチカチ と鳴る", "原文一字不改");
});

test("修复钩子：既挂上自己的，也不把别人（片假名终结者）的顶掉", async () => {
  // 真机上两个插件都会插注音。共存补丁重建完一行只调一个全局钩子，
  // 谁后加载谁就得**链上去**，直接覆盖会让另一个插件立刻开始闪。
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
  assert.ok(!env.document.body.innerHTML.includes("lt-ruby"), "禁用后 DOM 里不该有痕迹");
  assert.strictEqual(env.document.getElementById("latin-katakana-style"), null, "注入的样式表要收走");

  env.api.set("enabled", true);
  await sleep(600);
  assert.strictEqual(env.document.body.innerHTML, annotated, "重新启用后应该回到同样的结果");
  assert.ok(env.document.getElementById("latin-katakana-style"), "样式要补回来");
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

test("设置面板能构建出来，改动落盘到 localStorage", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  assert.ok(root, "onConfig 应该返回一个元素");
  assert.strictEqual(root.id, "latin-katakana-config");

  const enabled = root.querySelector('[data-k="enabled"]');
  assert.ok(enabled && enabled.type === "checkbox" && enabled.checked === true);

  const rtSize = root.querySelector('[data-k="rtSize"]');
  assert.strictEqual(rtSize.value, "55");
  rtSize.value = "70";
  rtSize.dispatchEvent(new env.window.Event("change"));

  const raw = env.window.localStorage.getItem("latin-katakana.config");
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
  for (const k of ["LKMatcher", "LKDict", "LKReading", "LKCorrect", "LKLLM", "LKAnnotate"]) delete window[k];

  assert.doesNotThrow(() => {
    loadScripts(ctx.dom, ["main.js"]);
    for (const fn of listeners) fn();
  }, "缺依赖时不应抛异常");
  assert.strictEqual(window.LatinKatakana, undefined, "初始化失败就不该导出 API");
});
