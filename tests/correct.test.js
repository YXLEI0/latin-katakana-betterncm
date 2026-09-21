/*
 * 在线校正（core/correct.js）的单元测试。
 *
 * 这一层只干一件事：对"本地规则猜的、没把握"的词问一次 Google 的 en->ja，
 * **只接受纯片假名的结果**（clover -> クローバー），
 * 回汉字/平假名的（love -> 愛）对唱歌没用，丢掉并记为"查过、没有"。
 *
 * 这里全部用桩 fetch，不碰真接口；重点是几种边界：
 *   - 结果不是片假名 -> 丢掉而不是标成"爱"
 *   - 行数对不上   -> 整批作废（宁可标不上，也不能把 A 词的读音标到 B 词头上）
 *   - 查不到要记下来 -> 否则每个扫描周期都为同一个词重发请求
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore } = require("./helpers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** dict-chrome-ex 形状：[[ "行1\n行2\n..." ]]（json[0][0] 是那个拼接好的字符串） */
function dictResponse(lines) {
  return [[lines.join("\n")]];
}
/** gtx 形状：[[["译文","原文",...], ...], ...] */
function gtxResponse(pairs) {
  return [[pairs.map(([t, s]) => [t, s, null, null, 10])]];
}

/**
 * 造一个正确器。
 * 注意 correct.js 里请求是按批走的：lookup() 只入队并返回 null，
 * 真正发请求要等一个短计时器 —— 所以测试里要 await 一小会儿。
 */
function makeCorrector(ctx, opts) {
  opts = opts || {};
  const calls = [];
  ctx.window.fetch = function (url) {
    calls.push(url);
    const data = typeof opts.reply === "function" ? opts.reply(url) : opts.reply;
    if (data instanceof Error) return Promise.reject(data);
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve(data);
      },
    });
  };
  const updates = [];
  const usages = [];
  const corrector = ctx.WKCorrect.createCorrector({
    online: true,
    validate: opts.validate,
    log: function () {},
    onStatus: function () {},
    onUsage: function (fields) {
      usages.push(fields);
    },
    onUpdate: function () {
      updates.push(1);
    },
  });
  return { corrector, calls, updates, usages };
}

test("用量：成功一批记一次请求 + 词数 + 字符数，失败那批记成失败", async () => {
  const ctx = loadCore();
  const ok = makeCorrector(ctx, { reply: () => dictResponse(["クローバー", "ドリーム"]) });
  ok.corrector.lookup("clover");
  ok.corrector.lookup("dream");
  await sleep(1600);
  assert.strictEqual(ok.usages.length, 1, "一批只记一笔");
  assert.strictEqual(ok.usages[0].requests, 1);
  assert.strictEqual(ok.usages[0].ok, 1);
  assert.strictEqual(ok.usages[0].words, 2);
  assert.strictEqual(ok.usages[0].chars, 11, "clover(6) + dream(5)：送出去的字符数");

  const bad = makeCorrector(ctx, { reply: () => new Error("offline") });
  bad.corrector.lookup("kaleidoscope");
  await sleep(1600);
  assert.strictEqual(bad.usages.length, 1, "失败也要记一笔");
  assert.strictEqual(bad.usages[0].failures, 1);
  assert.strictEqual(bad.usages[0].requests, 1);
  assert.strictEqual(bad.usages[0].words, 1);
  assert.strictEqual(bad.usages[0].chars, 12);
});

test("isWaiting：排队/请求中为 true，回来或失败后为 false", async () => {
  const ctx = loadCore();
  const { corrector } = makeCorrector(ctx, { reply: () => dictResponse(["クローバー"]) });

  assert.strictEqual(corrector.isWaiting("clover"), false, "还没问过：不是等待中（上层会先看规则）");
  corrector.lookup("clover");
  assert.strictEqual(corrector.isWaiting("clover"), true, "排了队 = 在等结果");
  await sleep(1600);
  assert.strictEqual(corrector.isWaiting("clover"), false, "拿到结果了就不用等");
  assert.strictEqual(corrector.lookup("clover"), "クローバー");

  // 失败：记成"查过、没有"，也不该再让上层等（断网时规则要能顶上）
  const down = makeCorrector(ctx, { reply: () => new Error("offline") });
  down.corrector.lookup("clover");
  assert.strictEqual(down.corrector.isWaiting("clover"), true);
  await sleep(1600);
  assert.strictEqual(down.corrector.isWaiting("clover"), false, "失败了就别等");
});

test("拦住意译/拟声词：Google 把 tick 回成 カチカチ 时不许用", async () => {
  // 用户报的 tick -> カチカチ：Google 的 en→ja 会回拟声词，纯片假名，字符集拦不住
  const ctx = loadCore();
  const V = ctx.WKReading.looksLikeTransliteration;
  const { corrector } = makeCorrector(ctx, { validate: V, reply: () => dictResponse(["カチカチ"]) });
  corrector.lookup("tick");
  await sleep(1600);
  assert.strictEqual(corrector.lookup("tick"), null, "拟声词不是读音");
  assert.strictEqual(corrector.stats().onlineHits, 0);

  // 正确音译照收
  const ok = makeCorrector(ctx, { validate: V, reply: () => dictResponse(["ティック"]) });
  ok.corrector.lookup("tick");
  await sleep(1600);
  assert.strictEqual(ok.corrector.lookup("tick"), "ティック");
});

test("纯片假名的结果被接受（clover -> クローバー）", async () => {
  const ctx = loadCore();
  const { corrector } = makeCorrector(ctx, { reply: () => dictResponse(["クローバー"]) });

  assert.strictEqual(corrector.lookup("clover"), null, "第一次是入队，本次还没有结果");
  await sleep(1600);
  assert.strictEqual(corrector.lookup("clover"), "クローバー", "批处理回来之后应该能查到");
});

test("回汉字的结果被丢掉，不会被当成读音标上去", async () => {
  const ctx = loadCore();
  const { corrector } = makeCorrector(ctx, { reply: () => dictResponse(["愛"]) });

  corrector.lookup("love");
  await sleep(1600);
  assert.strictEqual(corrector.lookup("love"), null, "「愛」不是读音，必须丢掉");
  const s = corrector.stats();
  assert.strictEqual(s.onlineHits, 0, "不该算命中");
});

test("被丢掉的结果要记为「查过、没有」，否则会周期性重发请求", async () => {
  const ctx = loadCore();
  const { corrector, calls } = makeCorrector(ctx, { reply: () => dictResponse(["愛"]) });

  corrector.lookup("love");
  await sleep(1600);
  const afterFirst = calls.length;
  // 再来几轮：既然记了 miss，就不该再发请求
  for (let i = 0; i < 5; i++) {
    corrector.lookup("love");
    await sleep(60);
  }
  await sleep(1200);
  assert.strictEqual(calls.length, afterFirst, "miss 是终态，不该反复请求：" + JSON.stringify(calls));
});

test("行数对不上时整批作废（不能把 A 词的读音标到 B 词头上）", async () => {
  const ctx = loadCore();
  const { corrector } = makeCorrector(ctx, {
    reply: () => dictResponse(["クローバー", "ドリーム", "ライト", "スカイ", "スター"]),
  });

  corrector.lookup("clover");
  corrector.lookup("dream");
  await sleep(1600);
  // 两个词只回了一行（或回了 5 行）—— 对不上就一个都不采纳
  assert.strictEqual(corrector.lookup("clover"), null, "行数对不上时不能采纳");
  const s = corrector.stats();
  assert.ok(s.failures >= 1, "应该记为失败：" + JSON.stringify(s));
});

test("成功的结果会写进缓存，新实例能直接读到", async () => {
  const ctx = loadCore();
  const { corrector } = makeCorrector(ctx, { reply: () => dictResponse(["クローバー"]) });
  corrector.lookup("clover");
  await sleep(1600);
  assert.strictEqual(corrector.lookup("clover"), "クローバー");
  // 写盘是防抖的：非强制路径延迟 2 秒才落盘（避免每来一个词就写一次 localStorage）
  await sleep(2200);

  // 同一个 window（同一份 localStorage）里再造一个实例
  const again = ctx.WKCorrect.createCorrector({ online: true, log: function () {} });
  assert.strictEqual(again.lookup("clover"), "クローバー", "缓存要跨实例生效");
});

test("clearCache 之后缓存里不再有这个词", async () => {
  const ctx = loadCore();
  const { corrector } = makeCorrector(ctx, { reply: () => dictResponse(["クローバー"]) });
  corrector.lookup("clover");
  await sleep(1600);
  assert.strictEqual(corrector.lookup("clover"), "クローバー");

  corrector.clearCache();
  // 清掉之后再查：本地缓存没了，会重新入队（本次返回 null）
  assert.strictEqual(corrector.lookup("clover"), null, "clearCache 之后应该当没查过");
});

test("retryMisses 把查不到的词重新排队", async () => {
  const ctx = loadCore();
  const { corrector, calls } = makeCorrector(ctx, { reply: () => dictResponse(["愛"]) });
  corrector.lookup("love");
  await sleep(1600);
  const before = calls.length;

  const n = corrector.retryMisses();
  assert.ok(n >= 1, "应该有词被重新排队");
  await sleep(1600);
  assert.ok(calls.length > before, "重排之后应该真的再发一次请求");
});

test("接口失败不会崩，也不会无限重试", async () => {
  const ctx = loadCore();
  const { corrector, calls } = makeCorrector(ctx, { reply: () => new Error("HTTP 500") });
  corrector.lookup("clover");
  await sleep(1600);
  assert.strictEqual(corrector.lookup("clover"), null);
  const s = corrector.stats();
  assert.ok(s.failures >= 1);
  assert.ok(s.lastError, "应该记下最后一个错误原因");

  const before = calls.length;
  for (let i = 0; i < 4; i++) {
    corrector.lookup("clover");
    await sleep(60);
  }
  await sleep(1200);
  assert.strictEqual(calls.length, before, "失败后不该自动重排队（避免接口挂了疯狂重试）");
});

test("关掉在线之后不再发请求", async () => {
  const ctx = loadCore();
  const { corrector, calls } = makeCorrector(ctx, { reply: () => dictResponse(["クローバー"]) });
  corrector.setOnline(false);
  corrector.lookup("clover");
  await sleep(1600);
  assert.strictEqual(calls.length, 0, "关掉在线就不该发请求");
});

test("gtx 形状的响应也能解析", async () => {
  // 四个候选接口里前两个是 dict 形状、后两个是 gtx 形状，桩要按 url 回对应形状
  // —— 真接口就是这样，回错形状时解析器会抛"响应形状异常"。
  const ctx = loadCore();
  const { corrector, calls } = makeCorrector(ctx, {
    reply: (url) => (/dict-chrome-ex/.test(url) ? dictResponse(["クローバー"]) : gtxResponse([["クローバー", "clover"]])),
  });
  corrector.lookup("clover");
  await sleep(1600);
  assert.strictEqual(corrector.lookup("clover"), "クローバー");
  assert.ok(calls.length >= 1, "应该真的发过请求");
});
