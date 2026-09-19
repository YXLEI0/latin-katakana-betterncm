/*
 * 生成 src/preview.png —— 插件预览图（BetterNCM 商店要求 manifest 里 preview 指向的文件存在）。
 *
 * 为什么自己写 PNG 编码器
 * -----------------------
 * 这个仓库没有任何图形依赖（devDependencies 里只有 jsdom，是给测试用的），
 * 也不想为了生成一张 480x240 的小卡片去装 canvas / sharp 这类带原生二进制的包 ——
 * 那会让 CI 和不联网的机器都变难跑。PNG 的容器格式其实很简单：
 *   - 一个 8 字节签名，加若干个 chunk；
 *   - 我们只需要 IHDR（尺寸/位深/颜色类型）、IDAT（像素数据，zlib 压缩）、IEND；
 *   - chunk 头部是长度 + 类型，尾部是这两者的 CRC32（表也是这里手算出来的）。
 * zlib 用 Node 内置的 zlib.deflateSync，所以整条链路零依赖。
 *
 * 画的是什么
 * ----------
 * 没有字库，所以内置了一套 5x7 的点阵大写 ASCII 字体（只有 ASCII，没有假名/汉字
 * 字形）。为了表达"拉丁字母上方标片假名读音"这件事，注音部分画成**示意性 ruby**：
 * 上面一行小色块（偏蓝，代表片假名注音），下面一行粗色块（浅色，代表没被动过的
 * 拉丁底字）。底字和注音都是色块不是真字 —— 图是示意图，不是截图。
 *
 * 用法：node tools/make-preview.js   （在项目根目录下跑）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "src", "preview.png");

// ---------------------------------------------------------------- 画布

const W = 480;
const H = 240;
const canvas = new Uint8Array(W * H * 4);

const BG = [26, 27, 38, 255];
const CARD = [36, 40, 59, 255];
const FG = [220, 223, 244, 255]; // 底字（拉丁原文，不动）
const ACCENT = [122, 162, 247, 255]; // 注音（片假名读音）
const MUTED = [86, 95, 137, 255];

function px(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  canvas[i] = c[0];
  canvas[i + 1] = c[1];
  canvas[i + 2] = c[2];
  canvas[i + 3] = c[3];
}

function fillRect(x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, c);
}

function roundRect(x0, y0, w, h, r, c) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.min(x - x0, x0 + w - 1 - x);
      const dy = Math.min(y - y0, y0 + h - 1 - y);
      if (dx < r && dy < r) {
        const ox = r - dx;
        const oy = r - dy;
        if (ox * ox + oy * oy > r * r) continue;
      }
      px(x, y, c);
    }
  }
}

// ---------------------------------------------------------------- 5x7 点阵字体

const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "11110", "10001", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "11110", "10000", "10000", "10000", "11111"],
  F: ["11111", "10000", "11110", "10000", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "11111", "10001", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "11100", "10010", "10001", "10001", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "01110", "00001", "00001", "10001", "01110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  // 缺字形会静默画成空格，所以标题里要用的 ">" 必须显式给一张
  ">": ["10000", "01000", "00100", "00010", "00100", "01000", "10000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function drawText(text, x, y, scale, color) {
  let cx = x;
  for (const raw of text.toUpperCase()) {
    const glyph = FONT[raw] || FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === "1") fillRect(cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += 6 * scale;
  }
  return cx;
}

function textWidth(text, scale) {
  return text.length * 6 * scale;
}

// ---------------------------------------------------------------- 自绘形状

/** 画一个圆角「词条」：下方是原封不动的拉丁底字，上方是片假名注音，模拟 ruby 排版 */
function drawRubyWord(x, y, baseW, glossW, baseH, glossH) {
  // 注音（上方，细小，偏蓝）
  roundRect(x + Math.round((baseW - glossW) / 2), y, glossW, glossH, 2, ACCENT);
  // 底字（下方，粗大，浅色）
  roundRect(x, y + glossH + 4, baseW, baseH, 3, FG);
}

// ---------------------------------------------------------------- 编码

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng() {
  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(H * (W * 4 + 1));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      raw[p++] = canvas[i];
      raw[p++] = canvas[i + 1];
      raw[p++] = canvas[i + 2];
      raw[p++] = canvas[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 主流程

function main() {
  fillRect(0, 0, W, H, BG);

  // 卡片底色：比背景亮一点的一块圆角面板
  roundRect(16, 14, W - 32, H - 28, 8, CARD);

  // 顶部标题：本插件的方向是「拉丁 -> 片假名」
  const title = "LATIN -> KATAKANA";
  const ts = 2;
  drawText(title, Math.round((W - textWidth(title, ts)) / 2), 28, ts, MUTED);

  // 分隔线
  fillRect(36, 54, W - 72, 1, MUTED);

  // 主体：三个「拉丁词 + 上方片假名注音」的示意 ruby
  // 宽度按词长给：LIGHT 短、DREAM 中、CLOVER 长
  const rowY = 84;
  const baseH = 34;
  const glossH = 9;
  const words = [
    { base: 74, gloss: 44 },
    { base: 86, gloss: 48 },
    { base: 100, gloss: 56 },
  ];
  let x = 34;
  for (const w of words) {
    drawRubyWord(x, rowY, w.base, w.gloss, baseH, glossH);
    x += w.base + 20;
  }

  // 色块下面标出对应的拉丁原词
  const glossY = rowY + glossH + baseH + 14;
  drawText("LIGHT", 34, glossY, 2, FG);
  drawText("DREAM", 144, glossY, 2, FG);
  drawText("CLOVER", 254, glossY, 2, FG);

  // 底部说明：底字原封不动（这是本插件与「片假名终结者」最大的语义差别）
  drawText("BASE TEXT UNCHANGED", 34, H - 42, 2, MUTED);
  drawText("ONLY RUBY ADDED", 34, H - 26, 2, MUTED);

  fs.writeFileSync(OUT, encodePng());
  console.log(`已写入 ${path.relative(ROOT, OUT)}（${W}x${H}）`);
}

main();
