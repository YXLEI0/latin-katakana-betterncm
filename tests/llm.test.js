/*
 * 大模型校正层（core/llm.js）的单元测试。
 *
 * 这一层的职责是：把**规则拼写音译**读歪的词送到大模型换一个正确读音
 * （hello ヘッラオ -> ハロー、question クワエサション -> クエスチョン）。
 *
 * 全部用桩 fetch，不碰真接口。重点盯住几件事：
 *   - 没填 key / 关掉了 -> 一个请求都不许发；
 *   - 结果不是纯片假名 -> 丢掉并记"问过、没有"，绝不把汉字标到歌词上；
 *   - 一个词只问一次（命中与 miss 都进缓存），否则每个扫描周期都在烧钱；
 *   - 请求失败不写缓存、不抛异常，退避重试；
 *   - 缓存要落 localStorage，重启网易云不用重新花钱问一遍。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./helpers");

/** 造一个带桩 fetch 的客户端。reply(words) 返回一个 {词: 读音} 映射，或 Error 表示网络失败 */
function makeClient(ctx, opts) {
  opts = opts || {};
  const calls = [];
  ctx.window.fetch = function (url, init) {
    const body = JSON.parse(init.body);
    // 现在提示词里的条目是 [{i, w, line}]：w 是要注音的词，line 是它所在的整句歌词
    const items = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
    const words = items.map((it) => (it && typeof it === "object" ? it.w : it));
    calls.push({
      url: url,
      model: body.model,
      words: words,
      items: items,
      auth: init.headers.Authorization,
      maxTokens: body.max_tokens,
    });
    // httpFail：模拟"HTTP 有状态码的失败"（402 / 401 / 404…），走 httpError 那条路。
    // 放在 reply 之前判：这条路的重点是状态码，不是 reply 的内容。
    if (opts.httpFail) {
      return Promise.resolve({
        ok: false,
        status: opts.httpFail.status,
        text: function () {
          return Promise.resolve(opts.httpFail.body || "");
        },
      });
    }
    const reply = typeof opts.reply === "function" ? opts.reply(words, items) : opts.reply || {};
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }],
        });
      },
    });
  };

  const updates = [];
  const statuses = [];
  const client = ctx.LKLLM.createClient({
    enabled: opts.enabled !== false,
    endpoint: opts.endpoint || "https://api.example.com/chat/completions",
    model: "test-model",
    key: opts.key === undefined ? "sk-test" : opts.key,
    validate: opts.validate,
    log: function () {},
    onStatus: function (m) {
      statuses.push(m);
    },
    onUpdate: function () {
      updates.push(1);
    },
  });
  return { client, calls, updates, statuses };
}

// ============================================================ 被拒的答案要留痕

/** 和 main.js 一样把首音校验注入进去（不注入的话什么答案都会被收下） */
function withValidate(ctx, opts) {
  const merged = Object.assign({}, opts);
  merged.validate = (w, k) => ctx.LKReading.looksLikeTransliteration(w, k);
  return makeClient(ctx, merged);
}

test("被拒的答案要留痕：模型原话 + 原因（不然「一直不矫正」查不出来）", async () => {
  const ctx = loadCore();
  // 模型对 tick 回了拟声词 カチカチ、对 kaleidoscope 回了 ダニ（蜱虫）—— 都会被首音校验判掉
  const c = withValidate(ctx, { reply: () => ({ 1: "カチカチ", 2: "ダニ" }) });
  c.client.lookup("tick", "tick tock");
  c.client.lookup("kaleidoscope", "a kaleidoscope");
  await c.client.flush();

  const rj = c.client.rejects();
  assert.strictEqual(rj.length, 2, "两条都要留痕：" + JSON.stringify(rj));
  assert.strictEqual(rj[0].word, "tick");
  assert.strictEqual(rj[0].said, "カチカチ", "要记住模型原话");
  assert.strictEqual(rj[0].why, "没通过首音校验");
  assert.strictEqual(c.client.stats().rejected, 2, "stats 里也要能看出有几个是被校验判掉的");
  assert.ok(c.client.stats().missesCached >= 2, "miss 条目数：这些词不会再自动重问");
});

test("retryMisses：把「问过但没收下」的清掉，让它们能再问一次", async () => {
  const ctx = loadCore();
  let answer = "カチカチ"; // 先给一个一定被拒的
  const c = withValidate(ctx, { reply: () => ({ 1: answer }) });

  c.client.lookup("tick", "tick tock");
  await c.client.flush();
  assert.strictEqual(c.calls.length, 1);
  assert.strictEqual(c.client.stats().missesCached, 1, "缓存里有一条 miss");

  // 同一句再查：有结论（miss）了，不会再发请求
  c.client.lookup("tick", "tick tock");
  await c.client.flush();
  assert.strictEqual(c.calls.length, 1, "有 miss 结论时不该重问");

  // 用户点「重试没结果的词」之后：能再问一次，而且这次收下正确答案
  answer = "ティック";
  assert.strictEqual(c.client.retryMisses(), 1, "应该清掉 1 条");
  assert.strictEqual(c.client.stats().missesCached, 0);
  c.client.lookup("tick", "tick tock");
  await c.client.flush();
  assert.strictEqual(c.calls.length, 2, "重试之后要真的再问一次");
  assert.strictEqual(c.client.peek("tick"), "ティック", "这次要收下");
});

test("被拒的答案会落盘：重启之后 rejects() 还看得出原因", async () => {
  const ctx = loadCore();
  const a = withValidate(ctx, { reply: () => ({ 1: "カチカチ" }) });
  a.client.lookup("tick", "tick tock");
  await a.client.flush();
  a.client.saveCache(); // 正常是 2s 防抖落盘，这里手动触发
  const saved = JSON.parse(ctx.window.localStorage.getItem("latin-katakana.llm.v1"));
  const key = Object.keys(saved)[0];
  assert.strictEqual(saved[key].said, "カチカチ", "原话要落盘：" + JSON.stringify(saved));
  assert.strictEqual(saved[key].why, "没通过首音校验");

  // 新客户端读同一份 localStorage（同一个窗口 = 模拟重启后读缓存）
  const b = withValidate(ctx, { reply: () => ({}) });
  const rj = b.client.rejects();
  assert.ok(
    rj.some((r) => r.word === "tick" && r.said === "カチカチ"),
    "重启后 rejects() 要能还原：" + JSON.stringify(rj)
  );
});

// ============================================================ 停摆与恢复

test("请求体：max_tokens 给足（4000），免得一批词回来被截断成坏 JSON", async () => {
  const ctx = loadCore();
  const c = makeClient(ctx, { reply: () => ({ 1: "テスト" }) });
  c.client.lookup("clover", "clover");
  await c.client.flush();
  assert.strictEqual(c.calls[0].maxTokens, 4000);
});

test("退避有上限：最多 3 分钟（原来是 10 分钟：接口抖一下就有十分钟读数不矫正）", async () => {
  const ctx = loadCore();
  const c = makeClient(ctx, { reply: () => new Error("offline") });
  c.client.lookup("clover", "clover");
  await c.client.flush();
  const s = c.client.stats();
  assert.ok(s.cooldownMs > 0, "失败之后要在退避中");
  assert.strictEqual(s.cooldownMaxMs, 3 * 60 * 1000, "上限就是 3 分钟");
  assert.ok(s.cooldownMs <= s.cooldownMaxMs, "退避不能超过上限");
});

test("retryNow：把退避清掉、马上重发（用户看到「全都没矫正」时的救命按钮）", async () => {
  const ctx = loadCore();
  let fail = true;
  const c = makeClient(ctx, {
    reply: () => (fail ? new Error("offline") : { 1: "クローバー" }),
  });
  c.client.lookup("clover", "clover");
  await c.client.flush();
  assert.ok(c.client.stats().cooldownMs > 0, "先进入退避");
  assert.strictEqual(c.client.stats().stalled, false, "只失败一次还不算 stalled");

  // 退避期间再问：不该发请求
  c.client.lookup("clover", "clover");
  await c.client.flush();
  const before = c.calls.length;

  // 用户点「立刻重试」：退避清掉、马上再发一次，而且这次成功
  fail = false;
  c.client.retryNow();
  await c.client.flush();
  assert.strictEqual(c.client.stats().cooldownMs, 0, "退避要清掉");
  assert.strictEqual(c.client.stats().failedSinceHit, 0, "连续失败计数也要清");
  assert.ok(c.calls.length > before, "要真的重发（" + before + " -> " + c.calls.length + "）");
  assert.strictEqual(c.client.peek("clover"), "クローバー", "重试之后要收下答案");
});

test("stalled：连着失败而且队列还有词 = 这层现在彻底不工作（面板据此报警告）", async () => {
  const ctx = loadCore();
  const c = makeClient(ctx, { reply: () => new Error("offline") });
  c.client.lookup("alpha", "line a");
  c.client.lookup("beta", "line b");
  await c.client.flush();
  assert.ok(c.client.stats().pending >= 2, "失败的词要留在队列里：" + c.client.stats().pending);

  // 第二次失败：退避期间不会自己发，用 configure()（改配置会清退避，但不清连续失败计数）
  c.client.configure({ key: "sk-test" });
  await c.client.flush();
  const s = c.client.stats();
  assert.ok(s.failedSinceHit >= 2, "连续失败要累计：" + s.failedSinceHit);
  assert.ok(s.pending >= 1, "队列里还有词：" + s.pending);
  assert.strictEqual(s.stalled, true, "连续失败 + 队列有词 = 停摆");
});

// ============================================================ key / 错误信息

test("key 清洗：带引号 / 前后空格 / 整个 Bearer 都能收拾干净（这是「请求全失败」的常见元凶）", () => {
  const ctx = loadCore();
  for (const raw of ['"sk-abc123456789012345"', "  sk-abc123456789012345  ", "Bearer sk-abc123456789012345", "Bearer  'sk-abc123456789012345'"]) {
    assert.strictEqual(ctx.LKLLM.normalizeKey(raw), "sk-abc123456789012345", "洗不干净：" + JSON.stringify(raw));
  }
  assert.strictEqual(ctx.LKLLM.normalizeKey(""), "");
  assert.strictEqual(ctx.LKLLM.normalizeKey(null), "");
  assert.strictEqual(ctx.LKLLM.normalizeKey("sk-abc"), "sk-abc", "本来就是干净的别乱动");
});

test("key 清洗：真的发出去的 Authorization 里不能有多余字符", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { key: ' "sk-abc123456789012345" ', reply: () => ({ 1: "テスト" }) });
  client.lookup("clover", "clover");
  await client.flush();
  assert.strictEqual(calls[0].auth, "Bearer sk-abc123456789012345");
});

test("402（余额用完）要说清楚是余额，不是让用户去查 key", async () => {
  const ctx = loadCore();
  const { client, statuses, updates } = makeClient(ctx, {
    // 走 httpError 那条路：响应非 2xx
    httpFail: { status: 402, body: '{"error":{"message":"Insufficient Balance"}}' },
  });
  client.lookup("clover", "clover");
  await client.flush();
  const text = statuses.join(" | ");
  assert.ok(text.indexOf("402") >= 0 && text.indexOf("余额") >= 0, "要提示余额：" + text);
  assert.ok(text.indexOf("Insufficient Balance") >= 0, "服务端原话也要带上：" + text);
  assert.ok(updates.length >= 1, "失败也要叫 onUpdate");
});

test("没有状态码的失败（Failed to fetch）要翻译成人话：网络/跨域", async () => {
  const ctx = loadCore();
  const boom = new TypeError("Failed to fetch");
  const { client, statuses } = makeClient(ctx, { reply: () => boom });
  client.lookup("clover", "clover");
  await client.flush();
  const text = statuses.join(" | ");
  assert.ok(text.indexOf("Failed to fetch") >= 0, "原话保留：" + text);
  assert.ok(text.indexOf("跨域") >= 0 || text.indexOf("网络不通") >= 0, "要给出人话提示：" + text);
});

test("stats 里带 key 体检信息（长度 / 形状 / 有没有被洗过）", () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, { key: '"sk-abc123456789012345"' });
  const s = client.stats();
  assert.strictEqual(s.keyShape, "sk-");
  assert.strictEqual(s.keyLength, 21);
  assert.strictEqual(s.keyCleaned, true, "粘的时候带了引号，要记一笔");
});

// ============================================================ 失败也要通知上层

test("请求失败必须叫 onUpdate：否则「暂定」标记会一直挂在页面上", async () => {
  // 用户报的「这句不透明度怎么这么低」：请求还在飞的时候那一轮是暂定的（淡到 45%），
  // 失败后进入退避、isWaiting 变成 false，但如果没人通知注音层重新判定，
  // 那行就一直淡着，直到页面因为别的原因重扫（实测能淡一个完整退避周期）。
  const ctx = loadCore();
  const { client, updates, statuses } = makeClient(ctx, { reply: () => new Error("offline") });

  assert.strictEqual(client.lookup("kaleidoscope", "きらめく kaleidoscope"), null, "先入队");
  await client.flush();
  assert.ok(updates.length >= 1, "失败也要叫一次 onUpdate（现在有 " + updates.length + " 次）");
  assert.ok(
    statuses.join(" ").indexOf("失败") >= 0,
    "顺带要有失败提示：" + statuses.join(" | ")
  );
  assert.strictEqual(client.isWaiting("kaleidoscope", "きらめく kaleidoscope"), false, "退避期间不算在等");
});

// ============================================================ 没配 key

test("没填 key：整层不工作，一个请求都不发", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { key: "" });

  assert.strictEqual(client.lookup("hello"), null);
  await client.flush();
  assert.strictEqual(calls.length, 0, "没 key 不该发请求");
  assert.strictEqual(client.stats().hasKey, false);
  assert.strictEqual(client.pending(), 0, "也不该堆在队列里");
});

test("关掉这一层：同样不发请求，但命中过的缓存仍然能用", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: (w) => ({ hello: "ハロー" }) });
  client.lookup("hello");
  await client.flush();
  assert.strictEqual(client.lookup("hello"), "ハロー");

  client.configure({ enabled: false });
  assert.strictEqual(client.lookup("hello"), "ハロー", "关掉之后已有的缓存结果不该丢");
  const before = calls.length;
  assert.strictEqual(client.lookup("brandnew"), null);
  await client.flush();
  assert.strictEqual(calls.length, before, "关掉之后不该再有新请求");
});

// ============================================================ 基本流程

test("入队 -> 批量问一次 -> 命中：结果通过 onUpdate 通知上层重扫", async () => {
  const ctx = loadCore();
  const { client, calls, updates } = makeClient(ctx, {
    reply: (words) => {
      const out = {};
      for (const w of words) out[w] = w === "hello" ? "ハロー" : "クエスチョン";
      return out;
    },
  });

  assert.strictEqual(client.lookup("hello"), null, "第一次只能入队，本次没有结果");
  assert.strictEqual(client.lookup("question"), null);
  assert.strictEqual(client.pending(), 2);

  await client.flush();
  assert.strictEqual(calls.length, 1, "两个词应该合成一次请求");
  assert.deepStrictEqual(calls[0].words.slice().sort(), ["hello", "question"]);
  assert.strictEqual(calls[0].auth, "Bearer sk-test");
  assert.strictEqual(client.lookup("hello"), "ハロー");
  assert.strictEqual(client.lookup("question"), "クエスチョン");
  assert.strictEqual(updates.length, 1, "命中之后要叫上层重扫一次（把读音换上）");
});

test("同一个词只问一次：命中进缓存，之后再 lookup 不再发请求", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ hello: "ハロー" }) });
  client.lookup("hello");
  await client.flush();
  assert.strictEqual(calls.length, 1);

  for (let i = 0; i < 5; i++) assert.strictEqual(client.lookup("hello"), "ハロー");
  await client.flush();
  assert.strictEqual(calls.length, 1, "缓存命中不该再发请求");
  assert.strictEqual(client.stats().cacheHits, 5);
});

test("词会先规范化：大写、连字符、脏字符都折成同一个键", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ email: "イーメール" }) });
  assert.strictEqual(client.lookup("E-Mail!"), null);
  await client.flush();
  assert.deepStrictEqual(calls[0].words, ["email"]);
  assert.strictEqual(client.lookup("e-mail"), "イーメール", "同一个键要能命中");
  assert.strictEqual(client.lookup("EMAIL"), "イーメール");
});

test("带变音符号的词：键要折成 ASCII（Tōkyō -> tokyo），不能削成半截", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ tokyo: "トーキョー" }) });
  assert.strictEqual(client.lookup("Tōkyō"), null);
  await client.flush();
  assert.deepStrictEqual(calls[0].words, ["tokyo"], "折之前会变成 tky 这种半个词");
  assert.strictEqual(client.lookup("Tōkyō"), "トーキョー");
  assert.strictEqual(client.lookup("TŌKYŌ"), "トーキョー", "大小写与符号都归到同一个键");
  assert.strictEqual(client.lookup("Café"), null, "Café 也要能进队列（键是 cafe）");
  await client.flush();
  assert.ok(calls[calls.length - 1].words.indexOf("cafe") >= 0, JSON.stringify(calls[calls.length - 1].words));
});

// ============================================================ 校验

test("只接受纯片假名：汉字 / 平假名 / 英文 / 空都被丢掉并记成 miss", async () => {
  const ctx = loadCore();
  const { client, calls, updates } = makeClient(ctx, {
    reply: () => ({ love: "愛", hello: "ハロー", dream: "dream", star: "", light: "ヒカリ" }),
  });
  for (const w of ["love", "hello", "dream", "star", "light"]) client.lookup(w);
  await client.flush();

  assert.strictEqual(client.lookup("love"), null, "汉字不是读音，必须丢掉");
  assert.strictEqual(client.lookup("dream"), null, "英文原样返回也不能用");
  assert.strictEqual(client.lookup("star"), null);
  assert.strictEqual(client.lookup("light"), "ヒカリ", "平假名不算（这一层只认片假名，和 Google 层一致）");
  assert.strictEqual(client.lookup("hello"), "ハロー");

  const s = client.stats();
  assert.strictEqual(s.hits, 2);
  assert.strictEqual(s.misses, 3);
  assert.strictEqual(updates.length, 1, "有命中才重扫");

  const before = calls.length;
  for (const w of ["love", "dream", "star"]) client.lookup(w);
  await client.flush();
  assert.strictEqual(calls.length, before, "模型明说给不出的词不该反复问（那是在烧钱）");
});

test("模型漏掉某个词 -> 记 miss，也不会为它单独重问", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ hello: "ハロー" }) });
  client.lookup("hello");
  client.lookup("nobody");
  await client.flush();

  assert.strictEqual(client.lookup("nobody"), null);
  assert.strictEqual(client.stats().misses, 1);
  const before = calls.length;
  client.lookup("nobody");
  await client.flush();
  assert.strictEqual(calls.length, before);
});

test("模型输出带 markdown 代码块或前后废话时也能解析", async () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, {
    reply: '好的，读音如下：\n```json\n{"clover":"クローバー"}\n```\n希望有帮助！',
  });
  client.lookup("clover");
  await client.flush();
  assert.strictEqual(client.lookup("clover"), "クローバー");
});

test("输出根本不是 JSON -> 整批算失败（不写缓存，不把词标错）", async () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, { reply: "我不知道" });
  client.lookup("clover");
  const ok = await client.flush();
  assert.strictEqual(ok, false);
  assert.strictEqual(client.lookup("clover"), null);
  assert.strictEqual(client.stats().failures, 1);
});

// ============================================================ 失败与退避

test("请求失败：不抛异常、不写缓存、按退避冷却，冷却期间不再打接口", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => new Error("network down") });

  client.lookup("hello");
  const ok = await client.flush();
  assert.strictEqual(ok, false, "失败要如实返回 false");
  assert.strictEqual(client.lookup("hello"), null, "失败不能写进缓存");
  assert.strictEqual(client.stats().failures, 1);
  assert.ok(client.stats().cooldownMs > 0, "应该进入退避");
  assert.ok(client.stats().lastError.indexOf("network down") >= 0);

  const before = calls.length;
  client.lookup("hello");
  await client.flush();
  assert.strictEqual(calls.length, before, "退避期间不该再打接口");
  assert.strictEqual(client.lookup("hello"), null);
});

test("失败之后改了配置（比如刚填好 key）就能立刻重试", async () => {
  const ctx = loadCore();
  let fail = true;
  const { client, calls } = makeClient(ctx, {
    reply: (words) => {
      if (fail) return new Error("boom");
      const out = {};
      for (const w of words) out[w] = "ハロー";
      return out;
    },
  });
  client.lookup("hello");
  await client.flush();
  assert.strictEqual(calls.length, 1);

  fail = false;
  client.configure({ key: "sk-ok" });
  client.lookup("hello");
  await client.flush();
  assert.strictEqual(calls.length, 2, "改完配置应该能马上重试");
  assert.strictEqual(client.lookup("hello"), "ハロー");
});

test("HTTP 非 200 也算失败（比如 key 写错）", async () => {
  const ctx = loadCore();
  const calls = [];
  ctx.window.fetch = function () {
    calls.push(1);
    return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
  };
  const client = ctx.LKLLM.createClient({ enabled: true, key: "sk-bad", endpoint: "https://x/y" });
  client.lookup("hello");
  const ok = await client.flush();
  assert.strictEqual(ok, false);
  assert.ok(client.stats().lastError.indexOf("401") >= 0);
});

// ============================================================ 缓存持久化

test("缓存落 localStorage：新客户端（相当于重启网易云）不用重新问一遍", async () => {
  const ctx = loadCore();
  const first = makeClient(ctx, { reply: () => ({ hello: "ハロー" }) });
  first.client.lookup("hello");
  await first.client.flush();
  assert.strictEqual(first.client.lookup("hello"), "ハロー");
  first.client.saveCache(); // 正常是 2s 防抖落盘，这里手动触发

  const second = makeClient(ctx, { reply: () => ({ hello: "绝不该用到" }) });
  assert.strictEqual(second.client.lookup("hello"), "ハロー", "应该从 localStorage 里读到");
  await second.client.flush();
  assert.strictEqual(second.calls.length, 0, "缓存命中不该发请求");
});

test("miss 也落盘：重启之后不会又去问一遍模型给不出的词", async () => {
  const ctx = loadCore();
  const first = makeClient(ctx, { reply: () => ({}) });
  first.client.lookup("zzzz");
  await first.client.flush();
  first.client.saveCache();

  const second = makeClient(ctx, { reply: () => ({ zzzz: "ズズズ" }) });
  assert.strictEqual(second.client.lookup("zzzz"), null);
  await second.client.flush();
  assert.strictEqual(second.calls.length, 0, "记得它问不出来，就别再问了");
});

test("clearCache 之后会重新问", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ hello: "ハロー" }) });
  client.lookup("hello");
  await client.flush();
  client.clearCache();
  assert.strictEqual(client.lookup("hello"), null);
  await client.flush();
  assert.strictEqual(calls.length, 2);
});

// ============================================================ test()

test("自检：填好 key 时返回 ok 与示例读音", async () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, { reply: () => ({ clover: "クローバー" }) });
  const r = await client.test();
  assert.strictEqual(r.ok, true);
  assert.ok(r.message.indexOf("クローバー") >= 0, r.message);
});

test("自检：没填 key、请求失败、返回非片假名 都要给出人话", async () => {
  const ctx = loadCore();
  const noKey = makeClient(ctx, { key: "" });
  assert.strictEqual((await noKey.client.test()).ok, false);
  assert.ok((await noKey.client.test()).message.indexOf("Key") >= 0);

  const bad = makeClient(ctx, { reply: () => new Error("timeout") });
  const r1 = await bad.client.test();
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.message.indexOf("timeout") >= 0);

  const hanzi = makeClient(ctx, { reply: () => ({ clover: "四葉" }) });
  const r2 = await hanzi.client.test();
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.message.indexOf("片假名") >= 0);
});

test("自检不会抛：fetch 直接抛同步异常也算失败", async () => {
  const ctx = loadCore();
  ctx.window.fetch = function () {
    throw new Error("no fetch");
  };
  const client = ctx.LKLLM.createClient({ enabled: true, key: "sk-test", endpoint: "https://x/y" });
  const r = await client.test();
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.indexOf("no fetch") >= 0);
});

// ============================================================ 边界

test("超长词与非字母词直接忽略，不占队列", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({}) });
  assert.strictEqual(client.lookup("!!!!!!!!!!"), null);
  assert.strictEqual(client.lookup("a".repeat(40)), null);
  assert.strictEqual(client.lookup(undefined), null);
  assert.strictEqual(client.lookup(123), null);
  await client.flush();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(client.pending(), 0);
});

test("队列攒够 batchSize 就立刻发，不等攒批窗口", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({}) });
  // 默认 batchSize = 30：第 30 个词入队时应该立刻发出去（schedule(0)）
  // 注意词必须是纯字母：keyOf 会把数字/符号折掉，word0 / word1 会变成同一个键
  const words = [];
  for (let i = 0; i < 30; i++) words.push("w" + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  for (const w of words) client.lookup(w);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls.length, 1, "攒够一批就该发");
  assert.strictEqual(calls[0].words.length, 30);
});

test("stats 返回的是快照，改它不影响内部状态", async () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, { reply: () => ({ hello: "ハロー" }) });
  const s = client.stats();
  s.hits = 999;
  assert.notStrictEqual(client.stats().hits, 999);
});

// ============================================================ 上下文

test("请求里带上整句歌词：同一个词在不同句子里分别问、分别记", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, {
    // 按**下标**回答（提示词要求的形状），模拟"看语境判断"
    reply: (words, items) => {
      const out = {};
      items.forEach((it, idx) => {
        out[String(idx + 1)] = it.line.indexOf("yesterday") >= 0 ? "レッド" : "リード";
      });
      return out;
    },
  });

  assert.strictEqual(client.lookup("read", "I read a book every day"), null);
  assert.strictEqual(client.lookup("read", "I read it yesterday"), null);
  await client.flush();

  assert.strictEqual(calls.length, 1, "两句里的同一个词合成一次请求");
  assert.strictEqual(calls[0].items.length, 2);
  assert.deepStrictEqual(
    calls[0].items.map((it) => it.line),
    ["I read a book every day", "I read it yesterday"],
    "每一条都要带上它所在的整句歌词"
  );
  assert.strictEqual(client.lookup("read", "I read a book every day"), "リード");
  assert.strictEqual(client.lookup("read", "I read it yesterday"), "レッド", "同一个词、不同语境 = 不同读音");
});

test("同一句里的同一个词只问一次（语境相同就命中缓存）", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ "1": "リード" }) });
  const line = "I read a book every day";
  client.lookup("read", line);
  client.lookup("read", line); // 同一句 → 队列里只有一条
  client.lookup("read", "  I   read a book every day  "); // 空白差别不影响（折叠过）
  await client.flush();
  assert.strictEqual(calls[0].items.length, 1, "同一句里的同一个词只算一条：" + JSON.stringify(calls[0].items));
  assert.strictEqual(client.lookup("read", line), "リード");
  assert.strictEqual(client.lookup("read", line), "リード");
  assert.strictEqual(client.stats().cacheHits, 2);
});

test("不带语境也能用（退化成只看这个词，行为与以前一致）", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ "1": "ハロー" }) });
  assert.strictEqual(client.lookup("hello"), null);
  await client.flush();
  assert.deepStrictEqual(calls[0].items, [{ i: 1, w: "hello", line: "hello" }], "没有语境时 line 用词本身顶上");
  assert.strictEqual(client.lookup("hello"), "ハロー");
});

test("模型不按下标回答时，按词兜底也能收（老形状兼容）", async () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, { reply: () => ({ hello: "ハロー" }) });
  client.lookup("hello", "say hello to me");
  await client.flush();
  assert.strictEqual(client.lookup("hello", "say hello to me"), "ハロー");
});

test("语境过长会截断，不会把整本歌词塞进提示词", async () => {
  const ctx = loadCore();
  const { client, calls } = makeClient(ctx, { reply: () => ({ "1": "ハロー" }) });
  client.lookup("hello", "あ".repeat(500));
  await client.flush();
  assert.ok(calls[0].items[0].line.length <= 160, "长度 " + calls[0].items[0].line.length);
});

// ============================================================ isWaiting

test("isWaiting：等待期间 true；有结论/退避/没配 key 时 false", async () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, { reply: () => ({ "1": "ハロー" }) });

  // 还没有结论 -> 上层应该"先不标规则猜的读音"
  assert.strictEqual(client.isWaiting("hello", "say hello to me"), true);
  client.lookup("hello", "say hello to me");
  assert.strictEqual(client.isWaiting("hello", "say hello to me"), true, "排了队还是等待中");
  await client.flush();
  assert.strictEqual(client.isWaiting("hello", "say hello to me"), false, "拿到结果了就不用等");
  assert.strictEqual(client.lookup("hello", "say hello to me"), "ハロー");

  // 模型给不出（终态 miss）-> 不用等，让规则兜底
  const miss = makeClient(ctx, { reply: () => ({}) });
  miss.client.lookup("zzz", "zzz");
  await miss.client.flush();
  assert.strictEqual(miss.client.isWaiting("zzz", "zzz"), false, "问过没有就别等了");

  // 请求失败进退避 -> 不用等（断网时规则要能立刻顶上）
  const down = makeClient(ctx, { reply: () => new Error("network down") });
  down.client.lookup("hello", "say hello");
  await down.client.flush();
  assert.strictEqual(down.client.isWaiting("hello", "say hello"), false, "退避期间不等");

  // 没配 key -> 整层不工作，也不该让上层等
  const noKey = makeClient(ctx, { key: "" });
  assert.strictEqual(noKey.client.isWaiting("hello", "say hello"), false);
});

// ============================================================ 答案校验

test("拦住意译/拟声词：tick 被回成 カチカチ 时按 miss 处理，不再重问", async () => {
  // 用户报的：tick 注成 カチカチ。光看"纯片假名"拦不住，所以由上层注入校验函数。
  const ctx = loadCore();
  const V = ctx.LKReading.looksLikeTransliteration;
  const bad = makeClient(ctx, {
    validate: V,
    reply: () => ({ "1": "カチカチ" }), // 拟声词
  });
  bad.client.lookup("tick", "時計の tick が聞こえる");
  await bad.client.flush();
  assert.strictEqual(bad.client.lookup("tick", "時計の tick が聞こえる"), null, "不能收这种答案");
  assert.strictEqual(bad.client.stats().hits, 0);
  assert.strictEqual(bad.client.stats().misses, 1, "按 miss 记下来，别反复问");
  const callsBefore = bad.calls.length;
  bad.client.lookup("tick", "時計の tick が聞こえる");
  await bad.client.flush();
  assert.strictEqual(bad.calls.length, callsBefore, "miss 之后不再重问");

  // 同一个词给对读音就照收
  const good = makeClient(ctx, { validate: V, reply: () => ({ "1": "ティック" }) });
  good.client.lookup("tick", "時計の tick が聞こえる");
  await good.client.flush();
  assert.strictEqual(good.client.lookup("tick", "時計の tick が聞こえる"), "ティック");

  // 没注入校验时保持老行为（只判纯片假名）—— 免得别的调用方被误伤
  const noCheck = makeClient(ctx, { reply: () => ({ "1": "カチカチ" }) });
  noCheck.client.lookup("tick", "x");
  await noCheck.client.flush();
  assert.strictEqual(noCheck.client.lookup("tick", "x"), "カチカチ");
});

// ============================================================ 接口地址纠正

test("接口地址会自动补全：粘 base_url 也能用（这就是 404 的常见原因）", () => {
  const ctx = loadCore();
  const N = ctx.LKLLM.normalizeEndpoint;
  // 文档里给的是 base_url，直接粘进来 POST 过去就是 404（实测 2026-09）
  assert.strictEqual(N("https://api.deepseek.com"), "https://api.deepseek.com/v1/chat/completions");
  assert.strictEqual(N("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
  assert.strictEqual(N("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
  assert.strictEqual(N("  https://api.deepseek.com/v1  "), "https://api.deepseek.com/v1/chat/completions");
  // 从文档/终端复制时带上的引号、尖括号也要能吃掉
  assert.strictEqual(N('"https://api.deepseek.com/v1"'), "https://api.deepseek.com/v1/chat/completions");
  assert.strictEqual(N("<https://api.deepseek.com>"), "https://api.deepseek.com/v1/chat/completions");
  // 已经是完整地址的：原样（结尾多一个斜杠也去掉）
  assert.strictEqual(N("https://api.deepseek.com/chat/completions"), "https://api.deepseek.com/chat/completions");
  assert.strictEqual(N("https://api.deepseek.com/chat/completions/"), "https://api.deepseek.com/chat/completions");
  // 带别的前缀（DeepSeek 的 beta、本地网关之类）不猜，原样交给服务端
  assert.strictEqual(N("https://api.deepseek.com/beta/chat/completions"), "https://api.deepseek.com/beta/chat/completions");
  assert.strictEqual(N("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1/chat/completions");
  // 空的就用默认
  assert.strictEqual(N(""), ctx.LKLLM.DEFAULT_ENDPOINT);
  assert.strictEqual(N(undefined), ctx.LKLLM.DEFAULT_ENDPOINT);
});

test("客户端内部用的就是纠正后的地址（配置里存 base_url 也不影响）", async () => {
  const ctx = loadCore();
  const calls = [];
  ctx.window.fetch = function (url) {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"hello":"ハロー"}' } }] }),
    });
  };
  const client = ctx.LKLLM.createClient({ enabled: true, key: "sk-test", endpoint: "https://api.deepseek.com/v1" });
  client.lookup("hello");
  await client.flush();
  assert.deepStrictEqual(calls, ["https://api.deepseek.com/v1/chat/completions"]);
  client.configure({ endpoint: "https://api.example.com" });
  assert.strictEqual(client.stats().endpoint, "https://api.example.com/v1/chat/completions");
});

test("404 的报错要指出地址问题，并把服务端原话带上（不然没法照着修）", async () => {
  const ctx = loadCore();
  ctx.window.fetch = function () {
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    });
  };
  const client = ctx.LKLLM.createClient({ enabled: true, key: "sk-test", endpoint: "https://api.deepseek.com/v1" });
  const r = await client.test();
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.indexOf("404") >= 0, r.message);
  assert.ok(r.message.indexOf("/chat/completions") >= 0, "要提示正确写法：" + r.message);
  assert.ok(r.message.indexOf("api.deepseek.com/v1/chat/completions") >= 0, "要带上实际请求的地址：" + r.message);

  // 服务端有说明时也要带出来
  ctx.window.fetch = function () {
    return Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('{"error":"bad key"}') });
  };
  const c2 = ctx.LKLLM.createClient({ enabled: true, key: "sk-bad", endpoint: "https://api.deepseek.com" });
  const r2 = await c2.test();
  assert.ok(r2.message.indexOf("bad key") >= 0, r2.message);
  assert.ok(r2.message.indexOf("Key") >= 0, r2.message);
});

test("自检成功时把实际用的地址一起报出来", async () => {
  const ctx = loadCore();
  const { client } = makeClient(ctx, { reply: () => ({ clover: "クローバー" }) });
  const r = await client.test();
  assert.strictEqual(r.ok, true);
  assert.ok(r.message.indexOf("https://api.example.com/chat/completions") >= 0, r.message);
});
