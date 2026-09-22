/*
 * DOM 注音（core/annotate.js）的单元测试。
 *
 * 这一层的契约（从 katakana-terminator 那边继承来的，都是真机踩出来的）：
 *   - 只改文本节点、底字逐字节保持原文；
 *   - 不改任何既有元素的 class（改别人的 class 会让对方插件判定"行变了"并重建）；
 *   - 还原要干净，不留 class="" 之类的痕迹；
 *   - 「可见原文」必须把所有注音（自家的 wk-rt、别人的 kt-rt / fg-rt）都排除掉，
 *     否则别人的注音会被算成底字，我们就会每轮都判定"馊了"并重注 —— 就是一直闪。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { loadCore, makeAnnotator, forceRubyLayout } = require("./helpers");

const HTML = `<!doctype html><html><head></head><body>
<ul class="lyric">
  <li class="line"><p>きらめく light と clover</p></li>
  <li class="line"><p>ずっと dream を見てた</p></li>
</ul>
</body></html>`;

function newCtx(html) {
  const ctx = loadCore(html || HTML);
  forceRubyLayout(ctx, true);
  return ctx;
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

test("把拉丁词包成 ruby，注音是片假名读音", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();

  const p = ctx.document.querySelectorAll("ul.lyric li p")[0];
  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".wk-rt").textContent,
  ]);
  assert.deepStrictEqual(pairs, [
    ["light", "ライト"],
    ["clover", "クローバー"],
  ]);
  assert.strictEqual(baseText(p), "きらめく light と clover", "底字必须逐字节保持原文");
});

test("含汉字的行也照标（本插件不做「按行分工」）", () => {
  // 这是和 katakana-terminator 最大的不同：那边要把含汉字的行让给 jp-furigana，
  // 因为两边抢同一批字。我们标的是拉丁字母，跟振假名不是一回事，让开就是漏标。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric"><li class="line"><p>取とり戻もどしたい dream の 中なか</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const p = ctx.document.querySelector("p");
  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => r.querySelector(".wk-rt").textContent);
  assert.deepStrictEqual(pairs, ["ドリーム"], "含汉字的行里的英文也要标");
  assert.strictEqual(baseText(p), "取とり戻もどしたい dream の 中なか");
});

test("词正好在文本开头时，注音不能跑到行尾", () => {
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric"><li class="line"><p>clover と dream の 話はなし</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const p = ctx.document.querySelector("p");
  /*
   * 行首那个空的原文本节点是刻意留着的（框架还攥着它的引用，摘掉就收不到
   * 换歌时写进来的新歌词 —— 见 annotate.js 里 leadIsRuby 那段）。所以判"注音在行首"
   * 要看第一个看得见的东西，而不是 firstChild。
   */
  const firstVisible = [...p.childNodes].find(
    (n) => n.nodeType === 1 || (n.nodeValue || "").length > 0
  );
  assert.strictEqual(firstVisible.nodeType, 1);
  assert.ok(firstVisible.classList.contains("wk-ruby"));
  assert.strictEqual(firstVisible.childNodes[0].nodeValue, "clover");
  assert.strictEqual(baseText(p), "clover と dream の 話はなし");
});

test("换歌：行首是拉丁词的行，框架改写原文本节点之后必须能重新注音", () => {
  // 用户报的「换歌后 KiLLKiSS judy.., KiLLKiSS jude.., KiLLKiSS juda.., 没注音了」。
  // 这种行行首就是词，老版本会把它那个原文本节点从 DOM 里摘掉，而框架（React）
  // 还攥着那个节点的引用 —— 换歌时它执行 `node.nodeValue = 新歌词`，
  // 说给一个脱链节点听，页面上什么都不变，我们也就永远看不到"这行换了"。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric"><li class="line"><p>KiLLKiSS judy.., KiLLKiSS jude..,</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const p = ctx.document.querySelector("p");
  assert.deepStrictEqual(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue),
    ["KiLLKiSS", "judy", "KiLLKiSS", "jude"]
  );

  // 换歌：框架复用同一个文本节点，只把值换成新歌词（React 的老套路）
  const orig = p.firstChild;
  assert.strictEqual(orig.nodeType, 3, "原文本节点必须还在 DOM 里（不能被我们摘掉）");
  assert.strictEqual(orig.nodeValue, "", "行首形态下我们把它清空，词都在 ruby 里");
  orig.nodeValue = "そして light が 消えた";

  ann.pass();
  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".wk-rt").textContent,
  ]);
  assert.deepStrictEqual(pairs, [["light", "ライト"]], "只该剩新歌词里的注音：" + JSON.stringify(pairs));
  assert.strictEqual(p.textContent, "そして lightライト が 消えた", "新歌词一个字都不许丢");
  assert.strictEqual(p.textContent.indexOf("KiLLKiSS"), -1, "上一首的注音必须撤干净");
});

test("换歌：同一个元素被快速复用很多次，跳过只是暂时的（窗口一过自动重试）", async () => {
  // 用户报的「换歌后 KiLLKiSS judy.., … 没注音了」的另一个成因：
  // motion 计数器老版本只加不减，同一个元素被复用超过 3 次就永久不再注音
  // （连上一首残留的旧注音都没人清）。现在按滑动窗口计数：窗口内变太快才跳过，
  // 窗口一过自动重试。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric"><li class="line"><p>きらめく light と clover</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const skips = [];
  const ann = makeAnnotator(ctx, {
    annotator: { motionWindowMs: 60 },
    log: (m) => skips.push(String(m)),
  });
  const p = ctx.document.querySelector("p");
  const setText = (t) => {
    while (p.firstChild) p.removeChild(p.firstChild);
    p.appendChild(ctx.document.createTextNode(t));
  };

  ann.pass();
  const texts = ["新しい歌の light", "そして clover", "遠くの dream", "最後の sky"];
  for (const t of texts) {
    setText(t);
    ann.pass(); // 四次都挤在一个窗口里，第 3、4 次会被判成"文本在动"
  }
  assert.strictEqual(
    p.querySelectorAll("ruby.wk-ruby").length,
    0,
    "窗口内变太快时确实该跳过（追就是抽搐）：" + p.innerHTML
  );
  assert.ok(
    skips.join(" | ").indexOf("文本在动") >= 0,
    "跳过原因要留在轨迹里，不然『某行没注音』根本查不出来：" + skips.join(" | ")
  );

  // 窗口一过：同样的那一行必须能注回来（老版本这里就永远回不来了）
  await new Promise((r) => setTimeout(r, 80));
  ann.pass();
  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".wk-rt").textContent,
  ]);
  assert.deepStrictEqual(pairs, [["sky", "スカイ"]], "窗口过后要恢复正常注音：" + JSON.stringify(pairs));
});

test("跳过要自己安排重试：pass() 报出 retryInMs，别等页面再动", async () => {
  // 用户报的「换歌的时候…还是没注音」：换歌那几下文本在动 -> 这一轮跳过。
  // 如果之后页面不再变动（歌是暂停的，歌词渲染一次就不动了），
  // 就没有任何事件来触发下一轮 —— 那行会永远空着。所以 pass() 必须告诉我们
  // "过多久可以重试"，由上层排下一次扫描。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric"><li class="line"><p>きらめく light と clover</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx, { annotator: { motionWindowMs: 200 } });
  const p = ctx.document.querySelector("p");
  const setText = (t) => {
    while (p.firstChild) p.removeChild(p.firstChild);
    p.appendChild(ctx.document.createTextNode(t));
  };

  const clean = ann.pass();
  assert.strictEqual(clean.retryInMs, 0, "没被跳过时不该安排重试");

  let last = null;
  for (const t of ["新しい歌の light", "そして clover", "遠くの dream", "最後の sky"]) {
    setText(t);
    last = ann.pass();
  }
  assert.ok(last.unstable > 0, "窗口内变太快确实被跳过了");
  assert.ok(last.retryInMs > 0 && last.retryInMs <= 260, "要给出「多久后重试」：" + last.retryInMs);
  assert.ok((last.skips || []).join(" ").indexOf("文本在动") >= 0, "跳过原因要带在结果里：" + JSON.stringify(last.skips));

  // 窗口过了，下一次扫描必须补上
  await new Promise((r) => setTimeout(r, 260));
  ann.pass();
  assert.deepStrictEqual(
    [...p.querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue),
    ["sky"],
    "窗口过后要自动补上"
  );
});

test("单字母：a / I 要标，其它单字母不标", () => {
  // 用户报的：`Tell me a story` 里的 a 空着。a 和 I 是真正的英文单词，要标；
  // x 这种首字母缩写/排版噪声仍然跳过。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric"><li class="line"><p>a と to と sky と I と x</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();
  const p = ctx.document.querySelector("p");
  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".wk-rt").textContent,
  ]);
  assert.deepStrictEqual(pairs, [
    ["a", "ア"],
    ["to", "トゥ"],
    ["sky", "スカイ"],
    ["I", "アイ"],
  ], "a / I 要标，x 不标");
});

test("换歌：框架复用同一行只换文字时，上一首的注音必须撤掉、旧歌词不许写回来", () => {
  // 用户报的：「下一首歌会出现上一首歌的歌词」。
  // 网易云的歌词列表会复用同一批 <li>/<p>/同一个文本节点，换歌时只把
  // nodeValue 换成新歌词。我们手里还攥着上一首的 rec.plain，两个坑：
  //   1. 只判"注音还在"就跳过 -> 上一首的注音留在新歌的行里；
  //   2. 还原时照着 rec.plain 写回 -> 把上一首的歌词写进新歌的行里。
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();
  const p = ctx.document.querySelector("p");
  assert.strictEqual(baseText(p), "きらめく light と clover", "前提：先注上音");

  // 模拟换歌：复用第一个文本节点，只换值
  let firstText = null;
  for (const n of p.childNodes) if (n.nodeType === 3) { firstText = n; break; }
  assert.ok(firstText, "前提：宿主里有我们的原文本节点");
  firstText.nodeValue = "新しい歌の clover";

  ann.pass();
  assert.strictEqual(p.textContent, "新しい歌の cloverクローバー", "新歌那一行必须干净：旧注音撤掉、旧文字不许回来");
  assert.strictEqual(p.textContent.indexOf("きらめく"), -1, "旧歌词不许被写回来");
  assert.strictEqual(p.textContent.indexOf("light"), -1, "上一首的注音不该留在新歌的行里");
  // 换完歌还要能继续正常工作：新歌里那个 clover 必须标上
  const pairs = [...p.querySelectorAll("ruby.wk-ruby")].map((r) => [
    r.childNodes[0].nodeValue,
    r.querySelector(".wk-rt").textContent,
  ]);
  assert.deepStrictEqual(pairs, [["clover", "クローバー"]], "换歌之后要能重新注音");
  assert.strictEqual(ann.churnedCount(), 0, "换歌是正常重绘，不该被当成打架而认输");
});

test("认输的判据（一）：注音活了 70ms 才被重绘掉，不算打架", async () => {
  // 用户报的「MWAH 一直没注音」。查下来最可能是这里误伤：RNP 的逐字行大约每
  // 100ms 重写一次内容，而旧门槛是"活不够 150ms 就算打架"—— 于是三轮就进认输期，
  // 那一行在退避窗口里完全没有注音。可我们的补注是在 MutationObserver 回调里
  // 做的（赶在下一帧之前），100ms 的空窗根本到不了屏幕：这里没有"闪"要治。
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  const p = ctx.document.querySelector("p");
  const BASE = "きらめく light と clover";
  const wipe = () => {
    p.textContent = BASE; // 对方重建：注音没了，底字一字不改
  };

  ann.pass();
  assert.strictEqual(p.querySelectorAll("ruby.wk-ruby").length, 2, "前提：先注上：" + p.innerHTML);

  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 70));
    wipe();
    ann.pass();
    assert.strictEqual(
      p.querySelectorAll("ruby.wk-ruby").length,
      2,
      `第 ${i + 1} 次重绘后要立刻补回来：` + p.innerHTML
    );
  }
  assert.strictEqual(ann.churnedCount(), 0, "100ms 级重绘不该被当成死循环 —— 认输等于那行彻底没注音");
});

test("认输的判据（二）：同一拍就被抹掉（真死循环）仍然要认输", () => {
  // 反过来的一半契约：真的在无条件重建（注什么、同一拍就毁什么）时必须退避，
  // 否则我们每一轮都重注一遍，纯烧 CPU。
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  const p = ctx.document.querySelector("p");
  const wipe = () => {
    p.textContent = "きらめく light と clover";
  };

  for (let i = 0; i < 4; i++) {
    wipe();
    ann.pass();
  }
  assert.ok(ann.churnedCount() > 0, "同一拍连抹 4 次必须认输");

  wipe();
  const last = ann.pass();
  assert.strictEqual(p.querySelectorAll("ruby.wk-ruby").length, 0, "认输期内不再注音：" + p.innerHTML);
  assert.ok(
    (last.skips || []).join(" ").indexOf("认输期") >= 0,
    "跳过原因要写进结果，不然排障时看不到是故意的：" + JSON.stringify(last.skips)
  );
});

test("换歌：禁用/重扫时的还原也不能把上一首的歌词写回去", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();
  const p = ctx.document.querySelector("p");

  let firstText = null;
  for (const n of p.childNodes) if (n.nodeType === 3) { firstText = n; break; }
  firstText.nodeValue = "新しい歌の メロディ";

  // restoreAll 是禁用插件、改设置、大模型结果回来时都会走的路径
  ann.restoreAll();
  assert.strictEqual(p.textContent, "新しい歌の メロディ", "还原不许把 rec.plain 写回一个已经换过内容的节点");
  assert.strictEqual(p.querySelectorAll("ruby.wk-ruby").length, 0, "注音要撤干净");
});

test("重复扫描稳定，不会反复重注", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  ann.pass();
  for (let i = 0; i < 3; i++) {
    const r = ann.pass();
    assert.strictEqual(r.changed, 0, `第 ${i + 2} 轮不该改`);
    assert.strictEqual(r.restored, 0, `第 ${i + 2} 轮不该还原`);
  }
});

test("不修改任何既有元素的 class（避免触发别的歌词插件重建）", () => {
  const ctx = newCtx();
  const snapshot = () => {
    const out = [];
    const all = ctx.document.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) out.push(all[i].tagName + "#" + (all[i].getAttribute("class") || ""));
    return out;
  };
  const before = snapshot();
  const ann = makeAnnotator(ctx);
  ann.pass();
  const after = snapshot();
  // 新增的 ruby 元素可以有 class，但既有元素的 class 不能变
  const kept = after.filter((x) => before.indexOf(x) >= 0);
  assert.strictEqual(kept.length, before.length, "既有元素的 class 一个都不该变");
});

test("还原后逐字节回到原样", () => {
  const ctx = newCtx();
  const ann = makeAnnotator(ctx);
  const before = ctx.document.querySelector("ul.lyric").innerHTML;
  ann.pass();
  assert.ok(ctx.document.querySelector("ul.lyric").innerHTML !== before, "先确认确实注上了");
  ann.restoreAll();
  assert.strictEqual(ctx.document.querySelector("ul.lyric").innerHTML, before, "必须一字不差地还原");
});

test("别人的注音不算底字：kt-rt / fg-rt 都要排除", () => {
  // 真机场景：katakana-terminator（kt-rt）和 jp-furigana（fg-rt）可能同时在页面上。
  // 如果 visibleText() 把它们的注音算进"底字"，我们看到的就是一段一直在变的文本，
  // 于是每轮都判定"馊了"→ 还原 → 重注 —— 又是一直闪。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric"><li class="line"><p><ruby class="kt-ruby">コーヒー<rt class="kt-rt">coffee</rt></ruby> と dream</p></li></ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();
  const r = ann.pass();
  assert.strictEqual(r.changed + r.restored, 0, "既有的 kt-rt 不该让我们判定失效");
  const p = ctx.document.querySelector("p");
  assert.deepStrictEqual(
    [...p.querySelectorAll("ruby.wk-ruby")].map((x) => x.querySelector(".wk-rt").textContent),
    ["ドリーム"]
  );
});

test("RNP 的罗马音层和中文翻译层要跳过", () => {
  // RNP 把一行渲染成三层：-original（官方原文）/ -romaji（它自己算的罗马音）
  // / -translated（中文翻译）。后两层标片假名是噪音 —— 罗马音本身就是读音。
  const ctx = newCtx(`<!doctype html><html><body>
<div class="rnp-lyrics-line">
  <div class="rnp-lyrics-line-original">きらめく light</div>
  <div class="rnp-lyrics-line-romaji">ki ra me ku ra i to</div>
  <div class="rnp-lyrics-line-translated">闪耀的 light</div>
</div>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const orig = ctx.document.querySelector(".rnp-lyrics-line-original");
  const romaji = ctx.document.querySelector(".rnp-lyrics-line-romaji");
  const translated = ctx.document.querySelector(".rnp-lyrics-line-translated");
  assert.strictEqual(orig.querySelectorAll("ruby.wk-ruby").length, 1, "原文层要标");
  assert.strictEqual(romaji.querySelectorAll("ruby.wk-ruby").length, 0, "罗马音层要跳过");
  assert.strictEqual(translated.querySelectorAll("ruby.wk-ruby").length, 0, "翻译层要跳过");
});

test("RNP 总览页的翻译层 / 罗马音层也要跳过", () => {
  // RNP 3.0.2 的 bundle 里实际存在的 class（把标识符全捞出来核对过）：
  // rnp-lyrics-overview-line-romaji / -translation / -placeholder。
  // 老正则只认 `rnp-lyrics-line-`，这两种变体是漏的。
  const ctx = newCtx(`<!doctype html><html><body>
<div class="rnp-lyrics-overview-line">
  <div class="rnp-lyrics-overview-line-original">きらめく light</div>
  <div class="rnp-lyrics-overview-line-romaji">ki ra me ku ra i to</div>
  <div class="rnp-lyrics-overview-line-translation">闪耀的 light</div>
</div>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const orig = ctx.document.querySelector(".rnp-lyrics-overview-line-original");
  const romaji = ctx.document.querySelector(".rnp-lyrics-overview-line-romaji");
  const trans = ctx.document.querySelector(".rnp-lyrics-overview-line-translation");
  assert.strictEqual(orig.querySelectorAll("ruby.wk-ruby").length, 1, "总览页原文要标");
  assert.strictEqual(romaji.querySelectorAll("ruby.wk-ruby").length, 0, "总览页罗马音层要跳过");
  assert.strictEqual(trans.querySelectorAll("ruby.wk-ruby").length, 0, "总览页翻译层要跳过");
});

test("网易云默认歌词页：同一个 <li> 里的第二个 <p>（翻译）不许注音", () => {
  // 用户报的：「网易云默认歌词页的翻译和编曲也会被注上」。
  // 默认页结构（3.1.36 实测，见 LYRIC_SELECTORS 注释）是
  // `ul#mod_pc_lyric_record.lyric > li.line > p × 2`：p1 原文、p2 中文翻译。
  // 老版本先命中 `ul.lyric > li` 把整个 <li> 当区域，翻译那一块跟着被注了音。
  const ctx = newCtx(`<!doctype html><html><body>
<ul id="mod_pc_lyric_record" class="lyric">
  <li class="line"><p>きらめく light と clover</p><p>闪耀的 light 与 clover</p></li>
  <li class="line"><p>夢の dream を見て</p><p>看着梦里的 dream</p></li>
</ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const ps = ctx.document.querySelectorAll("ul.lyric li p");
  const first = [...ps[0].querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue);
  const second = [...ps[1].querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue);
  const third = [...ps[2].querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue);
  assert.deepStrictEqual(first, ["light", "clover"], "原文行要标");
  assert.deepStrictEqual(second, [], "翻译行一个字都不许标");
  assert.deepStrictEqual(third, ["dream"], "第二行的原文也要标");
  assert.strictEqual(ps[1].textContent, "闪耀的 light 与 clover", "翻译行必须原样不动");
});

test("网易云默认歌词页：原文是纯英文时，翻译仍然要跳过", () => {
  // 假名判据的兜底分支：两块都没假名（纯英文原文 + 中文翻译）时留第一个。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric">
  <li class="line"><p>light and clover</p><p>光与三叶草</p></li>
</ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const ps = ctx.document.querySelectorAll("ul.lyric li p");
  assert.deepStrictEqual(
    [...ps[0].querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue),
    ["light", "and", "clover"],
    "纯英文原文行要标（用户专门要求的行为）"
  );
  assert.strictEqual(ps[1].querySelectorAll("ruby.wk-ruby").length, 0, "翻译行不许标");
});

test("网易云默认歌词页：前一块是空的/没假名时，带假名的那一块要接上", () => {
  // 换行/占位行残留（p1 空）时的兜底：不能因为「第一块是空的」就把原文漏掉。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric">
  <li class="line"><p></p><p>きらめく light</p></li>
</ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const ps = ctx.document.querySelectorAll("ul.lyric li p");
  assert.strictEqual(ps[0].querySelectorAll("ruby.wk-ruby").length, 0, "空的占位块不标");
  assert.deepStrictEqual(
    [...ps[1].querySelectorAll("ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue),
    ["light"],
    "原文那一块要标上"
  );
});

test("制作信息行不注音：编曲 / 作词 / Arranged by", () => {
  // 用户报的「编曲也会被注上」：老正则里只有「作[词詞曲編编]」，
  // `编曲` 根本不在名单里，所以「编曲 : Kenji」的 Kenji 照标。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric">
  <li class="line"><p>编曲 : Kenji</p></li>
  <li class="line"><p>作詞 : Yuki</p></li>
  <li class="line"><p>Arranged by Kenji</p></li>
  <li class="line"><p>Lyrics by Yuki</p></li>
  <li class="line"><p>きらめく light</p></li>
</ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const ps = ctx.document.querySelectorAll("ul.lyric li p");
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(ps[i].querySelectorAll("ruby.wk-ruby").length, 0, "制作信息行不标：" + ps[i].textContent);
    assert.strictEqual(baseText(ps[i]), ps[i].textContent, "制作信息行原样不动");
  }
  assert.strictEqual(ps[4].querySelectorAll("ruby.wk-ruby").length, 1, "歌词行照标");
});

test("制作信息行：标签和名字分在两个 <p> 里时，名字也不许注音", () => {
  // 真机上「编曲」这两个字常常单独占一个元素，名字在下一个兄弟块里。
  // 行内正则只看得到「编曲 : 」，名字那一块得靠「同一个 <li> 只取第一块」拦住。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric">
  <li class="line"><p>编曲 : </p><p>Kenji</p></li>
  <li class="line"><p>きらめく light</p></li>
</ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();

  const ps = ctx.document.querySelectorAll("ul.lyric li p");
  assert.strictEqual(ps[0].querySelectorAll("ruby.wk-ruby").length, 0, "标签块不标");
  assert.strictEqual(ps[1].querySelectorAll("ruby.wk-ruby").length, 0, "名字块也不许标");
  assert.strictEqual(ps[1].textContent, "Kenji", "名字块原样不动");
  assert.strictEqual(ps[2].querySelectorAll("ruby.wk-ruby").length, 1, "歌词行不受影响");
});

test("歌词行里带「Music」之类词头但不带分隔符的，照标", () => {
  // 英文字符支要求后面跟 `:` / `by` / `-`，否则 "Music" 开头的歌词行会被误杀。
  const ctx = newCtx(`<!doctype html><html><body>
<ul class="lyric">
  <li class="line"><p>Music と light の 中</p></li>
</ul>
</body></html>`);
  forceRubyLayout(ctx, true);
  const ann = makeAnnotator(ctx);
  ann.pass();
  assert.deepStrictEqual(
    [...ctx.document.querySelectorAll("ul.lyric li p ruby.wk-ruby")].map((r) => r.childNodes[0].nodeValue),
    ["Music", "light"],
    "「Music」后面没有分隔符，是歌词不是制作信息"
  );
});
