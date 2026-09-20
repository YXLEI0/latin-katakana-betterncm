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

  // options.files 给了就按它注入（用来测"某个核心模块没注入"的降级）
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

test("层序：在线那层还在问时先用暂定读音顶上（不空着），失败后转为确定值", async () => {
  // 层序：大模型 -> 免费接口 -> 英文音译规则。等待期间不去"先不标"（那样整行会空着、
  // 而且首词所在节点已有记录、后面也补不回来），而是先用规则读音当**暂定值**，
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
  assert.ok(p.querySelector("ruby.lt-ruby").classList.contains("lt-pending"), "要标成暂定");
  assert.strictEqual(baseText(p), "きらめく kaleidoscope の夜", "底字不动");

  // 免费接口的攒批窗口 1.2s + 请求失败 -> 之后转为确定（规则读音），但**不能消失**
  await sleep(2600);
  assert.strictEqual(rubyCount(p), 1, "接口失败后注音不许消失：" + p.innerHTML);
  assert.ok(!p.querySelector("ruby.lt-ruby").classList.contains("lt-pending"), "已经有结论了，不再是暂定");
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
  assert.ok(!p.querySelector("ruby.lt-ruby").classList.contains("lt-pending"), "轮不到在线层，不存在暂定");
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
        // 必须给**合法片假名**：读音会被 looksLikeTransliteration 校验，
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
  const got = [...p.querySelectorAll("ruby.lt-ruby")].map((r) => [r.childNodes[0].nodeValue, r.querySelector(".lt-rt").textContent]);
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
  // 注意 [...]: LK.layers() 里的数组是 jsdom 那个 realm 的，
  // 直接 deepStrictEqual 会因为原型不同而失败（假报错）
  assert.deepStrictEqual([...env.api.layers()], ["dict", "romaji", "llm", "google", "rule"], "默认顺序");

  const root = env.listeners.config[0]();
  const rows = root.querySelectorAll(".lk-layers .lk-layer");
  assert.strictEqual(rows.length, 5, "五层都要列出来：" + root.querySelector(".lk-layers").innerHTML);

  // 第一层的 ↓：词典和罗马音对调
  const down = rows[0].querySelector('[data-dir="down"]');
  assert.ok(down, "第一层要有 ↓ 按钮");
  down.dispatchEvent(new env.window.Event("click"));

  assert.deepStrictEqual([...env.api.layers()], ["romaji", "dict", "llm", "google", "rule"], "点完就要换过来");
  const saved = JSON.parse(env.window.localStorage.getItem("latin-katakana.config"));
  assert.deepStrictEqual(saved.layerOrder, ["romaji", "dict", "llm", "google", "rule"], "顺序要落盘");

  // 面板上第一层的 ↑ 现在是禁用的（已经在最上面）
  const rows2 = env.listeners.config[0]().querySelectorAll(".lk-layers .lk-layer");
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
   * tick / tock **没有**收进词典（用户选的：让大模型按语境决定）。
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
  // Ave 是拉丁语的"万福"（Ave Maria = アヴェ・マリア），不是 avenue 的缩写
  assert.deepStrictEqual(PAIRS(p), [
    ["Ave", "アヴェ"],
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
   * 机制有两层：
   *   1. 层序是在线优先、规则垫底，等待期间原来写的是"先不标" —— 一行里只要有一个词在等，
   *      这一行就空着；而这个词所在的原文本节点已经有记录了，后面拿到结果也不会再补注
   *      （一行的**首个词**尤其明显）。
   *   2. 在线结果回来时走的是 restoreAll + 重注，等于把整行先清空再补回来。
   * 现在：等待期间用规则读音当**暂定值**（ruby 带 lt-pending，样式淡一点），
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
  // ① 一个词都不许空着：四个词全在，词典外的三个带"暂定"标记
  assert.deepStrictEqual(
    PAIRS(p).map((x) => x[0]),
    ["kaleidoscope", "zephyr", "serendipity", "light"],
    "等待期间也不许空着：" + p.innerHTML
  );
  const zephyrEl = [...p.querySelectorAll("ruby.lt-ruby")].find((r) => r.childNodes[0].nodeValue === "zephyr");
  assert.ok(zephyrEl.classList.contains("lt-pending"), "词典外的词先标成暂定：" + zephyrEl.className);
  const lightEl = [...p.querySelectorAll("ruby.lt-ruby")].find((r) => r.childNodes[0].nodeValue === "light");
  assert.ok(!lightEl.classList.contains("lt-pending"), "词典命中的词不是暂定");

  await sleep(600);
  // ② 结果回来：读音就地改写、暂定标记去掉、**同一个节点对象**（没有拆了重建）
  const zephyrAfter = [...p.querySelectorAll("ruby.lt-ruby")].find((r) => r.childNodes[0].nodeValue === "zephyr");
  assert.strictEqual(zephyrAfter, zephyrEl, "不许把注音拆掉重建（那样就是一闪）");
  assert.strictEqual(zephyrAfter.querySelector(".lt-rt").textContent, "ゼファー");
  assert.ok(!zephyrAfter.classList.contains("lt-pending"), "有确定结果了就不是暂定");
  // ③ 模型给不出的词保持规则读音（不再标暂定），light 一直在
  const names = PAIRS(p).map((x) => x[0]);
  assert.deepStrictEqual(names, ["kaleidoscope", "zephyr", "serendipity", "light"]);
  assert.ok(PAIRS(p).some((x) => x[0] === "light" && x[1] === "ライト"));
  // ④ 同一个「词 + 语境」不该被问第二遍
  const flat = asked.flat();
  assert.strictEqual(flat.length, new Set(flat).size, "同一个词被重复问了：" + JSON.stringify(asked));
  assert.strictEqual(baseText(p), "kaleidoscope zephyr serendipity light", "底字一字不改");
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
  const saved = JSON.parse(env.window.localStorage.getItem("latin-katakana.usage"));
  assert.strictEqual(saved.total.llm.promptTokens, 321, "累计要落盘");
});

test("用量：设置面板显示账本，三个清零按钮各管一段", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  // 预置一份账本（在 onLoad 之前写进去）：证明面板读的是 localStorage 里那份
  const d = new Date();
  const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const bucket = (n) => ({ requests: n, ok: n, failures: 0, words: n, chars: n * 5, promptTokens: n * 100, completionTokens: n * 10 });
  env.window.localStorage.setItem(
    "latin-katakana.usage",
    JSON.stringify({ version: 1, day: key, today: { llm: bucket(7), google: bucket(2) }, total: { llm: bucket(9), google: bucket(3) } })
  );
  await env.runLoad();

  const u = env.api.usage();
  assert.strictEqual(u.total.llm.requests, 9, "账本要从 localStorage 读出来");
  assert.strictEqual(u.session.llm.requests, 0, "本次是新的会话");

  const root = env.listeners.config[0]();
  const usageText = root.querySelector(".lk-usage").textContent;
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
    "latin-katakana.usage",
    JSON.stringify({
      version: 1,
      day: key,
      today: { llm: { requests: 1, ok: 1, promptTokens: 1e6, completionTokens: 0 } },
      total: { llm: { requests: 1, ok: 1, promptTokens: 1e6, completionTokens: 0 } },
    })
  );
  await env.runLoad();
  const text = env.listeners.config[0]().querySelector(".lk-usage").textContent;
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
  // 用户报的「这句不透明度怎么这么低」。等待期间是暂定（淡），失败后必须**马上**不再淡 ——
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
    p.querySelectorAll("ruby.lt-ruby.lt-pending").length,
    0,
    "失败之后不该还淡着（lt-pending 会一直挂着就是那个 bug）：" + p.innerHTML
  );
  // 退避期间再扫一轮，也不能又淡上
  env.api.pass();
  await sleep(80);
  assert.strictEqual(p.querySelectorAll("ruby.lt-ruby.lt-pending").length, 0, "重扫也不许再淡");
});

test("按来源着色：类名一直在，颜色只由开关决定（开了立刻生效，不用重扫）", async () => {
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  await sleep(200);
  const p = env.document.querySelector("ul.lyric li p");
  assert.ok(p.querySelector("ruby.lt-src-dict"), "词典给的词要带 lt-src-dict：" + p.innerHTML);

  const styleText = () => env.document.getElementById("latin-katakana-style").textContent;
  assert.strictEqual(env.api.colorize(), false, "默认不开");
  assert.strictEqual(styleText().indexOf("lt-src-dict"), -1, "没开的时候一条颜色规则都不注入");

  assert.strictEqual(env.api.colorize(true), true);
  const css = styleText();
  for (const src of ["dict", "letters", "romaji", "rule", "llm", "google"]) {
    assert.ok(css.indexOf("lt-src-" + src) >= 0, "开了之后要有 " + src + " 的颜色规则");
  }
  assert.ok(css.indexOf("#46d17e") >= 0, "词典是绿色");

  assert.strictEqual(env.api.colorize(false), false);
  assert.strictEqual(styleText().indexOf("lt-src-dict"), -1, "关掉就撤掉颜色规则");
  // 但类名还在（下次开开关不用重扫）
  assert.ok(p.querySelector("ruby.lt-src-dict"), "类名不该跟着开关消失");
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
  const rubies = [...p.querySelectorAll("ruby.lt-ruby")];
  const light = rubies.find((r) => r.childNodes[0].nodeValue === "light");
  const kaleido = rubies.find((r) => r.childNodes[0].nodeValue === "kaleidoscope");
  assert.ok(light.classList.contains("lt-src-dict"), "词典命中的词是词典色：" + light.className);
  assert.ok(
    kaleido.classList.contains("lt-src-llm"),
    "被大模型换过的词要变成大模型色（lt-src-llm），类名不能再留着 lt-src-rule：" + kaleido.className
  );
  assert.strictEqual(kaleido.className.indexOf("lt-src-rule"), -1, "旧来源的类名要换掉");
});

test("注音不透明度真的生效（老版本被一条 !important 压掉了）", () => {
  const ctx = loadCore(NCM_HTML);
  ctx.LKAnnotate.applyStyles(ctx.document, { rtSize: 55, rtOpacity: 40, colorBySource: false });
  const css = ctx.document.getElementById("latin-katakana-style").textContent;
  assert.ok(/rt\.lt-rt,\s*\.lt-rt\s*\{\s*opacity:\s*0\.4\s*!important/.test(css), "注音要用用户设的 40%：" + css);
  assert.ok(
    css.indexOf("ruby.lt-ruby { opacity: 1 !important; }") >= 0,
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
  const saved = JSON.parse(env.window.localStorage.getItem("latin-katakana.config"));
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
  const pendingNow = [...p.querySelectorAll("ruby.lt-ruby")].map((r) => r.childNodes[0].nodeValue);
  assert.ok(pendingNow.indexOf("sake") >= 0, "sake 要先标上（暂定）：" + p.innerHTML);

  await sleep(1400);
  const words = [].concat.apply([], asked);
  assert.deepStrictEqual(words, ["sake"], "只该问 sake：词典词和真罗马音都不该浪费请求（实际 " + words.join(",") + "）");

  const pairs = [...p.querySelectorAll("ruby.lt-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".lt-rt").textContent,
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
  const shakeRuby = p.querySelectorAll("ruby.lt-ruby")[3];
  assert.ok(shakeRuby.classList.contains("lt-src-dict"), "shake 现在是词典命中：" + shakeRuby.className);
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
  assert.strictEqual(p.querySelectorAll("ruby.lt-ruby.lt-pending").length, 0, "也不该标成暂定");
  assert.strictEqual(rubyCount(p), 2);
});

test("换歌且页面不再变动时：被跳过的行会自己补回来（不用等用户操作）", async () => {
  // 用户报的「换歌的时候 KiLLKiSS… 还是没注音」。
  // 换歌那几下文本在动 -> 这一轮按"别追着重注"跳过；如果之后页面不再变动
  // （**歌是暂停的**，歌词只渲染一次），就没有事件来触发下一轮扫描 ——
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
  assert.ok(env.api.why().indexOf("文本在动") >= 0, "LK.why() 要说清为什么跳过：\n" + env.api.why());

  // 关键：接下来**一个 DOM 事件都不发生**，只等 —— 注音必须自己出现
  await sleep(3600);
  assert.deepStrictEqual(
    [...p.querySelectorAll("ruby.lt-ruby")].map((r) => r.childNodes[0].nodeValue),
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
  const box = env.listeners.config[0]().querySelector(".lk-layers");
  const warn = box.querySelector(".lk-layer-warn");
  assert.ok(warn, "要有挡路提醒：" + box.textContent);
  assert.ok(warn.textContent.indexOf("离线词典") >= 0, "要点名被挡住的层：" + warn.textContent);
  assert.ok(warn.textContent.indexOf("セ") >= 0, "要说明后果（the 会变成 セ）：" + warn.textContent);

  // 默认顺序下不该有这条提醒
  const okEnv = bootPlugin(NCM_HTML, { dev: true });
  await okEnv.runLoad();
  assert.strictEqual(
    okEnv.listeners.config[0]().querySelector(".lk-layer-warn"),
    null,
    "默认顺序不该出现提醒"
  );
});

test("设置面板的预览：高考听力那句 + 中文翻译行不注音", async () => {
  // 预览的示例句换成高考英语听力名句（「衬衫的价格为九磅十五便士」）之后钉住三件事：
  //   1. 每个词都从**词典**取读音（这批数字词原本不在词典里，规则层会读错：fifteen -> フィファテエン）；
  //   2. 中文翻译行照样显示、但一个字都不注音（真机行为）；
  //   3. 预览走的是真扫描 + 真读音逻辑，不是手写的字符串。
  const env = bootPlugin(NCM_HTML, { dev: true });
  await env.runLoad();
  const root = env.listeners.config[0]();
  const preview = root.querySelector(".lk-preview");
  assert.ok(preview, "面板里应该有预览区");

  const pairs = [...preview.querySelectorAll("ruby.lt-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".lt-rt").textContent,
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

  const trans = preview.querySelector(".lk-preview-trans");
  assert.ok(trans, "预览里应该带一行中文翻译");
  assert.strictEqual(trans.textContent, "衬衫的价格为九磅十五便士");
  assert.strictEqual(trans.querySelectorAll("ruby, rt").length, 0, "翻译行不许注音");
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
