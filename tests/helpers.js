/*
 * 测试用的小工具：把 src/core/*.js 按 manifest 的顺序「注入」进 jsdom 窗口，
 * 模拟 BetterNCM 的 <script> 加载方式（这些文件是 UMD，浏览器分支会挂到 globalThis）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");
const { after } = require("node:test");

const SRC = path.join(__dirname, "..", "src");

/** 按 manifest 顺序注入的核心模块（加文件时这里和 manifest 一起改） */
const CORE_FILES = ["core/latin.js", "core/dict.js", "core/reading.js", "core/correct.js", "core/llm.js", "core/annotate.js"];

/**
 * jsdom 的窗口里会有 setInterval / MutationObserver，不关掉进程就不退出。
 * 在 node:test 里注册 after 钩子，测试结束自动关。
 */
function autoClose(window) {
  try {
    after(() => {
      try {
        window.close();
      } catch (e) {
        /* 已经关了 */
      }
    });
  } catch (e) {
    // 不在 node:test 上下文里（例如被脚本直接 require）就跳过
  }
}

/** 按顺序注入任意 src/ 下的模块（浏览器分支会挂到 globalThis） */
function loadScripts(dom, files) {
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), "utf8");
    vm.runInContext(code, dom.getInternalVMContext(), { filename: f });
  }
}

/** 按顺序注入核心模块，返回 { dom, window, LK* } */
function loadCore(html, options) {
  options = options || {};
  const dom = new JSDOM(html || "<!doctype html><html><head></head><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    // 必须有真实 origin：默认的 about:blank 是 opaque origin，
    // jsdom 会拒绝 localStorage（"not available for opaque origins"），
    // 那样在线校正缓存的读写就测不到了。
    url: options.url || "https://music.163.com/",
  });
  const window = dom.window;
  autoClose(window);

  loadScripts(dom, options.files || CORE_FILES);

  const out = {
    dom,
    window,
    document: window.document,
    LKMatcher: window.LKMatcher,
    LKDict: window.LKDict,
    LKReading: window.LKReading,
    LKCorrect: window.LKCorrect,
    LKLLM: window.LKLLM,
    LKAnnotate: window.LKAnnotate,
  };

  if (options.reader !== false) {
    out.reader = out.LKReading.createReader({ dict: out.LKDict.words });
  }
  return out;
}

/** 建一个可用的 annotator（读音只走离线：词典 -> 罗马音 -> 规则） */
function makeAnnotator(ctx, opts) {
  opts = opts || {};
  const reader = opts.reader || ctx.reader;
  return ctx.LKAnnotate.createAnnotator({
    document: ctx.document,
    lookup: function (word) {
      const r = reader ? reader.read(word) : null;
      return r && r.kana ? r.kana : null;
    },
    annotateAll: opts.annotateAll !== false,
    log: opts.log || function () {},
  });
}

/** 把 jsdom 的 ruby 支持探针固定住，免得测试结果依赖布局引擎 */
function forceRubyLayout(ctx, supported) {
  // jsdom 没有布局引擎，getBoundingClientRect 全返回 0，探针必然判成「不支持」。
  // annotate.js 认这个开关，方便分别测 ruby 分支和降级分支。
  ctx.window.__LK_FORCE_RUBY__ = supported;
}

module.exports = { loadCore, makeAnnotator, forceRubyLayout, loadScripts, SRC, CORE_FILES };
