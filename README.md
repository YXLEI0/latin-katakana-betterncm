# 拉丁字母片假名注音 · Latin Katakana for BetterNCM

在网易云音乐的日语歌词里，给**拉丁字母**上方标注**片假名读音**

默认歌词页（`I know this sky loves you.` → アイ ノウ ディス スカイ ラブズ ユー）：

![默认歌词页](src/preview.png)

全屏歌词页（同一句，同样的注音）：

![全屏歌词页](docs/images/lyrics-page.png)

## 环境

- 网易云音乐 **3.x**（在 3.1.39 上实测）
- [BetterNCM](https://github.com/BetterNCM) **1.3.0+**

## 安装

从 [Releases](../../releases) 下载 `latin-katakana.plugin`，放进 BetterNCM 的插件目录（通常是 `C:\betterncm\plugins`）后重启网易云

## 说明

- 读音按顺序取：**离线词典**（6077 条）→ **罗马音** → **大模型校正** → **免费接口** → **英文音译规则**。规则只当垫底：在线那层还没回来时先给一个**暂定的规则读音**（样式淡到 45%，`lt-pending`），拿到结果**就地改写**、不重建节点；拿不出结果就保持规则读音
- **推荐在设置面板里填一个大模型 API Key**（默认 DeepSeek，任何 OpenAI 兼容接口都行）：Key 只存在本机 localStorage，留空则这一层不工作、自动退回免费接口；一个词只问一次（**按"词 + 它所在的那句歌词"缓存**，所以同一个词在不同句子里会分别判断），命中与"问不出来"都会缓存。接口地址粘文档里的 `base_url`（`https://api.deepseek.com` 或 `…/v1`）也能用，会自动补成 `/chat/completions`
- 记号按**字母名**逐字母读：`D/N/A` → ディーエヌエー、`R&B` → アールアンドビー、`X-Y` → エックスワイ（`e-mail` / `x-ray` 这类连字符词照旧按单词读）
- 只标歌词原文行和播放栏标题，**含汉字的行也照标**；中文翻译层（默认歌词页 `li.line` 里的第二个块、RNP 的 `-translated`）和制作信息行（作词/作曲/编曲…）跳过。换歌时上一首的注音会撤掉，不会留在新歌的行里
- 可以和 [片假名终结者](https://github.com/YXLEI0/katakana-terminator-betterncm)、[jp-furigana](https://github.com/Leleawa/jp-furigana) 同时开着；jp-furigana 需要先打共存补丁：`npm run patch:furigana`
- 桌面歌词无效，那是原生窗口而不是网页
- 读音来源、规则依据（sljfaq）、词典怎么生成、排障、已知限制见 [docs/notes.md](docs/notes.md)

## 许可

插件自身的代码采用 **MIT** 协议，见 [LICENSE](LICENSE)

词典数据来源与分发注意事项见 [NOTICE.md](NOTICE.md)
