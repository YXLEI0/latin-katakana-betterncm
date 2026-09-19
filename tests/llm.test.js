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
    const words = JSON.parse(body.messages[0].content.slice(body.messages[0].content.indexOf("[")));
    calls.push({ url: url, model: body.model, words: words, auth: init.headers.Authorization });
    const reply = typeof opts.reply === "function" ? opts.reply(words) : opts.reply || {};
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
