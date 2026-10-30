// 界面文字：浏览器语言是中文就显示中文，其他都显示英文（发给模型的提示词不在这里，一直用中文）
export const isZh = chrome.i18n.getUILanguage().toLowerCase().startsWith("zh");

const STRINGS = {
  // 设置页
  title: ["MangaWakatta! · 设置", "MangaWakatta! · Settings"],
  service: ["翻译服务", "Translation service"],
  qwenOption: ["通义千问（阿里云，北京地域新用户有免费额度）", "Qwen (Alibaba Cloud)"],
  qwenName: ["通义千问", "Qwen"],
  qwenKey: ["阿里云百炼 API key", "Alibaba Cloud Model Studio API key"],
  qwenKeyHint: [
    "在 bailian.console.aliyun.com 开通百炼，进“API Key”页面创建。key 只保存在这台电脑的浏览器里。",
    "Turn on Model Studio at bailian.console.aliyun.com and create a key on the API Key page. Your key stays in this browser.",
  ],
  model: ["模型", "Model"],
  qwenModelHint: [
    "北京地域的新用户送 100 万 token 免费额度，大约能翻 200 页。不想被扣费的话，在百炼的模型详情页打开“免费额度用完即停”（默认是关的）。其他地域没有免费额度，一屏大约 2–3 分钱。",
    "New accounts get 1M free tokens in the Beijing region, roughly 200 pages. To avoid charges, open the model's page in the console and switch on “stop when free quota runs out” (off by default). Other regions have no free quota and cost well under a US cent per screen.",
  ],
  baseUrl: ["Base URL（可选）", "Base URL (optional)"],
  baseUrlHint: [
    "在百炼的“API Key”页面找到 Base URL，复制中间那个“OpenAI 兼容地址”粘贴到这里。不填就用北京的通用地址。在海外用的话，把控制台顶部的地域切到新加坡，在那里创建 key，再复制那边的地址。",
    "Find Base URL on the API Key page and copy the middle one, “OpenAI compatible”. Leave it empty to use the default Beijing endpoint. Outside China, switch the region at the top of the console to Singapore, create a key there and copy that region's address.",
  ],
  claudeKeyHint: [
    "在 platform.claude.com 申请。key 只保存在这台电脑的浏览器里。",
    "Get one at platform.claude.com. Your key stays in this browser.",
  ],
  claudeModelHint: ["Sonnet 效果已经很好，一般用它就行。", "Sonnet is good enough for almost everything."],
  sonnet: ["Sonnet 5.5（推荐）", "Sonnet 5.5 (recommended)"],
  opus: ["Opus 5.5（更准，但更慢、更贵）", "Opus 5.5 (more accurate, slower and pricier)"],
  translateTo: ["翻译成", "Translate to"],
  boxMode: ["译文框", "Translation boxes"],
  boxTight: ["只盖住原文（不挡画面，字可能偏小）", "Cover the original text only (text may be small)"],
  boxGrow: ["字太小时自动撑大（字清楚，但会挡住一部分画面）", "Grow when text gets too small (easier to read, covers more art)"],
  fontSize: ["最大字号", "Maximum text size"],
  small: ["小", "Small"],
  medium: ["中", "Medium"],
  large: ["大", "Large"],
  fontSizeHint: ["改完保存后，翻下一页就生效。", "Takes effect from the next page after you save."],
  autoTranslate: ["翻页后自动翻译", "Translate automatically after turning the page"],
  autoTranslateHint: [
    "手动翻译过一次以后，翻页停下来约 1 秒就自动翻译新的一页。每一页都会调用一次 API（同一页不重复收费）。",
    "After your first manual translation, each new page is translated about a second after it settles. Every page is one API call (the same page is never charged twice).",
  ],
  save: ["保存", "Save"],
  saved: ["已保存。", "Saved."],
  usage: [
    "用法：在阅读器里点浏览器右上角的插件图标，或者按 Option + T。翻页、滚动后旧译文会自动消失。",
    "Click the extension icon in the toolbar or press Option + T (Alt + T on Windows) while reading. Old translations clear when you turn the page or scroll.",
  ],
  shortcuts: ["快捷键可以在 chrome://extensions/shortcuts 里改。", "Change the shortcut at chrome://extensions/shortcuts."],

  // 翻译过程中的提示
  noKey: ["还没有填 {name} API key，已为你打开设置页。", "No {name} API key yet. Settings are open so you can add one."],
  captureFailed: ["截图失败：{msg}", "Couldn't take a screenshot: {msg}"],
  geminiBusy: ["Gemini 繁忙，正在重试…", "Gemini is busy, retrying…"],
  rateLimited: ["免费额度限速，{secs} 秒后自动重试…", "Free tier rate limit hit, retrying in {secs}s…"],
  switchModel: ["换一个模型重试…", "Retrying with another model…"],

  // 服务商返回的错误
  keyInvalid: ["{name} API key 无效，请在设置里检查。", "{name} API key isn't valid. Check it in Settings."],
  rateLimit: ["{name} 请求太频繁或额度不足，稍后再试。", "{name}: too many requests or out of credit. Try again later."],
  modelNotFound: ["找不到这个 {name} 模型，请在设置里重新选。", "{name} can't find this model. Pick another one in Settings."],
  apiError: ["{name} 返回错误（{status}）：{msg}", "{name} error ({status}): {msg}"],
  timeout: ["{name} {secs} 秒没有响应，请稍后再试。", "{name} didn't respond within {secs}s. Try again later."],
  refused: ["{name} 拒绝处理这张图。", "{name} refused to process this image."],
  qwenKeyInvalid: [
    "通义千问 API key 无效。请检查 key 是否复制完整，以及 key 和 Base URL 是否属于同一个地域（Base URL 不填时用的是北京）。",
    "Qwen API key isn't valid. Check it was copied in full, and that the key and Base URL come from the same region (an empty Base URL means Beijing).",
  ],
  qwenArrearage: [
    "阿里云账户欠费或免费额度已用完，请到百炼控制台查看。",
    "Your Alibaba Cloud account is out of free quota or has an unpaid balance. Check the Model Studio console.",
  ],
  qwenInspection: ["通义千问认为这张图里有敏感内容，拒绝处理。", "Qwen flagged this image as sensitive and wouldn't process it."],
  claudeNoPermission: ["这个 Claude key 没有权限使用该模型。", "This Claude key doesn't have access to that model."],
  claudeRateLimit: [
    "Claude 请求太频繁或额度不足，稍后再试，或到 Claude Console 检查余额。",
    "Claude: too many requests or out of credit. Try again later, or check your balance in the Claude Console.",
  ],
  network: ["网络", "network"],
};

export function t(key, vars = {}) {
  const pair = STRINGS[key];
  if (!pair) return key;
  return pair[isZh ? 0 : 1].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
