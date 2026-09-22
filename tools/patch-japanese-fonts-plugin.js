/*
 * 给 JapaneseFonts 的 .plugin 包（zip）打共存补丁。
 *
 * 改的是包本身而不是解包目录：BetterNCM 每次启动都会用 plugins/*.plugin 重新解包到
 * plugins_runtime/<slug>/，改解包目录里的 main.js 下次启动就没了。
 *
 * 用法：
 *   node tools/patch-japanese-fonts-plugin.js            # 找 plugins 目录里的 JapaneseFonts*.plugin 并打补丁
 *   node tools/patch-japanese-fonts-plugin.js --file <路径>
 *   node tools/patch-japanese-fonts-plugin.js --check
 *   node tools/patch-japanese-fonts-plugin.js --revert
 *
 * 会自动备份成 <原名>.wk-bak（只备份一次）。补丁内容见 tools/patch-japanese-fonts.js。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { readZip, buildZip } = require("./patch-jp-furigana-plugin.js");
const { applyPatch, revertPatch, isPatched } = require("./patch-japanese-fonts.js");

const PLUGINS_DIR = "C:/betterncm/plugins";

function findPlugin(explicit) {
  if (explicit) return explicit;
  const names = fs.readdirSync(PLUGINS_DIR).filter((f) => /^JapaneseFonts.*\.plugin$/.test(f));
  if (!names.length) throw new Error("在 " + PLUGINS_DIR + " 里找不到 JapaneseFonts*.plugin");
  return path.join(PLUGINS_DIR, names[0]);
}

function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf("--file");
  const file = findPlugin(fi >= 0 ? args[fi + 1] : null);
  console.log("目标包: " + file);

  const bak = file + ".wk-bak";
  const entries = readZip(fs.readFileSync(file));
  const mainEntry = entries.find((e) => e.name === "main.js");
  if (!mainEntry) throw new Error("包里没有 main.js");

  const src = mainEntry.data.toString("utf8");
  const patchedNow = isPatched(src);

  if (args.includes("--check")) {
    console.log(patchedNow ? "包内已打补丁" : "包内未打补丁");
    console.log("备份存在: " + fs.existsSync(bak));
    if (patchedNow && fs.existsSync(bak)) {
      const bakMain = readZip(fs.readFileSync(bak)).find((e) => e.name === "main.js");
      if (bakMain) {
        const want = applyPatch(bakMain.data.toString("utf8"));
        if (want.error) console.log("补丁内容: 无法比对（当前工具打不上备份，锚点失配）");
        else if (want.src === src) console.log("补丁内容: 与当前工具一致");
        else console.log("补丁内容: **旧补丁**（与当前工具打出来的不一样，请重跑 --force）");
      }
    }
    return;
  }

  if (args.includes("--revert")) {
    if (fs.existsSync(bak)) {
      const orig = readZip(fs.readFileSync(bak));
      for (const e of entries) {
        const o = orig.find((x) => x.name === e.name);
        if (o) e.data = o.data;
      }
      fs.writeFileSync(file, buildZip(entries));
      console.log("已按备份还原（逐字节）：" + file);
    } else if (patchedNow) {
      mainEntry.data = Buffer.from(revertPatch(src).src, "utf8");
      fs.writeFileSync(file, buildZip(entries));
      console.log("已还原（无备份，按标记回退）：" + file);
    } else {
      console.log("包内没有补丁，无需还原。");
      return;
    }
    console.log("提示：还需删除解包目录（plugins_runtime/JapaneseFonts）才会重新解包。");
    return;
  }

  if (patchedNow && !args.includes("--force")) {
    console.log("包内已经打过补丁了，无需重复。（要重打请加 --force）");
    return;
  }

  let baseSrc = src;
  if (patchedNow && args.includes("--force")) {
    if (!fs.existsSync(bak)) {
      console.error("包内已打补丁但没有备份，无法安全重打。请先恢复原始 .plugin。");
      process.exit(4);
    }
    baseSrc = readZip(fs.readFileSync(bak))
      .find((e) => e.name === "main.js")
      .data.toString("utf8");
    console.log("已用备份作为基准重新打补丁（长度 " + baseSrc.length + "）");
  }

  const r = applyPatch(baseSrc);
  if (r.error) {
    console.error("锚点没找到，可能 JapaneseFonts 版本变了：");
    for (const m of r.error) console.error("  - " + m);
    process.exit(2);
  }
  try {
    new vm.Script(r.src, { filename: "JapaneseFonts/main.js" });
  } catch (e) {
    console.error("补丁后语法检查失败，已中止（未改动文件）：" + e.message);
    process.exit(3);
  }

  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
    console.log("已备份原包 -> " + path.basename(bak));
  }
  mainEntry.data = Buffer.from(r.src, "utf8");
  const out = buildZip(entries);
  fs.writeFileSync(file, out);
  for (const n of r.applied) console.log("已应用：" + n);
  console.log("\n补丁完成：" + file + "（" + out.length + " 字节）");
  console.log("请删除解包目录让它重新解包：");
  console.log("  Remove-Item -Recurse -Force C:\\betterncm\\plugins_runtime\\JapaneseFonts");
  console.log("然后重启网易云。");
}

if (require.main === module) main();
