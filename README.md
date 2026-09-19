# 拉丁字母片假名注音 · Latin Katakana for BetterNCM

在网易云音乐的日语歌词里，给**拉丁字母**上方标注**片假名读音**

![效果](src/preview.png)

## 环境

- 网易云音乐 **3.x**（在 3.1.39 上实测）
- [BetterNCM](https://github.com/BetterNCM) **1.3.0+**

## 安装

从 [Releases](../../releases) 下载 `latin-katakana.plugin`，放进 BetterNCM 的插件目录（通常是 `C:\betterncm\plugins`）后重启网易云

## 说明

- 读音按顺序取：**离线词典**（6046 条，覆盖英文词频前 6000）→ **罗马音切分** → **英文音译规则** → **大模型校正** → 免费接口。词典与罗马音是确定的，只有规则拼出来的词会被后两层替换
- **推荐在设置面板里填一个大模型 API Key**（默认 DeepSeek，任何 OpenAI 兼容接口都行）：Key 只存在本机 localStorage，留空则这一层不工作、自动退回免费接口；一个词只问一次，命中与"问不出来"都会缓存。接口地址粘文档里的 `base_url`（`https://api.deepseek.com` 或 `…/v1`）也能用，会自动补成 `/chat/completions`
- 记号按**字母名**逐字母读：`D/N/A` → ディーエヌエー、`R&B` → アールアンドビー、`X-Y` → エックスワイ（`e-mail` / `x-ray` 这类连字符词照旧按单词读）
- 只标歌词原文行和播放栏标题，**含汉字的行也照标**；RNP 歌词页的罗马音层与中文翻译层跳过。换歌时上一首的注音会撤掉，不会留在新歌的行里
- 可以和 [片假名终结者](https://github.com/YXLEI0/katakana-terminator-betterncm)、[jp-furigana](https://github.com/Leleawa/jp-furigana) 同时开着；jp-furigana 需要先打共存补丁：`npm run patch:furigana`
- 桌面歌词无效，那是原生窗口而不是网页
- 读音来源、规则依据（sljfaq）、词典怎么生成、排障、已知限制见 [docs/notes.md](docs/notes.md)

## 许可

插件自身的代码采用 **MIT** 协议，见 [LICENSE](LICENSE)

词典数据来源与分发注意事项见 [NOTICE.md](NOTICE.md)
