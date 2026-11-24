// OpenAI 兼容接口（Chat Completions）的服务商：通义千问、OpenAI，以后的豆包等也加在 PROVIDERS 里
import { buildPrompt, objectScanner, valid } from "./gemini.js";
import { t } from "./i18n.js";

export const PROVIDERS = {
  qwen: {
    get name() {
      return t("qwenName");
    },
    // 旧的通用域名，2026-09-30 起只维护不加新功能；用户可以在设置里填业务空间专属地址覆盖
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // 设置里的 Base URL 只能填阿里云百炼的地址（和 manifest 的 host_permissions 对应），不能借这一栏接别家的接口
    hosts: [/^dashscope\.aliyuncs\.com$/, /^dashscope-intl\.aliyuncs\.com$/, /^[\w-]+(\.[\w-]+)*\.maas\.aliyuncs\.com$/],
    // 北京区没有 qwen3-vl-flash（Model not exist），只留 Plus
    models: [{ name: "qwen3-vl-plus", label: "Qwen3-VL-Plus" }],
    split: true,
    // 结构化输出：服务器按 SCHEMA 强制格式，不会再夹乱码；不支持时自动退回 json_object + 宽松解析
    jsonMode: "json_schema",
    // 要先抄原文再翻译：不抄的话，偶尔会把一整块的日文原样填进译文（会被过滤掉，看起来就是漏翻）
    transcribe: true,
    // 服务器在北京，海外上传很慢：截图压小一点（对白的字在这个尺寸下还认得清）
    // 每半页再上下切开（整页 4 块）：字密的格子不容易漏
    image: { maxSide: 1280, quality: 0.75, rows: 2 },
    // 混合思考模型：关掉思考，找框翻对白更快
    extra: { enable_thinking: false },
    // key 和 Base URL 不在同一个地域时也是 401，提示里要说到这一点
    keyInvalid: "qwenKeyInvalid",
    errors: {
      Arrearage: "qwenArrearage", // i18n.js 里的文字
      DataInspectionFailed: "qwenInspection",
    },
  },
  openai: {
    name: "OpenAI",
    base: "https://api.openai.com/v1",
    // 只连官方地址，不接中转（中转慢，也没法确认后面跑的是什么模型）
    hosts: [/^api\.openai\.com$/],
    // gpt-5-mini 在韩漫版试过，框太不准，只留 gpt-5
    models: [{ name: "gpt-5", label: "gpt-5" }],
    // 日漫常有左右跨页：不切的话整张缩到短边 768，字太小。切块时每个框只归中心所在的那块，不会重复
    split: true,
    jsonMode: "json_schema",
    // GPT 给 0–1000 比例坐标会整体往左上缩（框对不准），像 Claude 一样要像素坐标
    coords: "pixel",
    // OpenAI 收到图会先缩到短边 768（长边不超过 2048）再看；先缩好再发，它看到的像素就是我们换算用的像素。
    // 跨页只左右切时每块半页缩到 768×775 左右，小字只剩几个像素，位置估不准：再上下切一刀（一页 4 块），字大约放大 1.8 倍
    image: { shortSide: 768, maxSide: 2048, rows: 2, grid: 100 },
    detail: "high",
    // GPT 爱把一段字按行、按列拆成好几条（大字、竖排最明显），也会跳过脏话
    promptExtra:
      "\n\n特别注意：同一个对话框、同一块旁白框、同一组大字，不管分成几行几列、字有多大，都只输出一条，框住整段文字（竖排时从最右一列到最左一列），不要按行、按列或按词拆成几条。" +
      "脏话、粗口也要照实翻译成对应语气的说法，不能跳过不翻。translation 里不能留任何日文假名（比如「くそ」要翻成「可恶」，不能原样留着）。" +
      "\n\n图片上叠加了半透明的红色坐标网格：每隔 100 像素一条线，四边标着这条线的像素值。给坐标时对照网格读数：先看文字落在哪两条竖线、哪两条横线之间，再估在格子里的位置。红色网格和数字不是漫画内容，不要翻译、不要输出。",
    // 译文里零星留下的假名去掉，不整条丢
    stripKana: true,
    // 框比里面的字大太多（框了整个格子）时缩小，免得画出盖住半个格子的大白块
    capBox: true,
    dropPunct: true,
    // 每次都把 GPT 的原话记进日志（详细级别），漏翻时能看出是它没给还是被插件丢了
    logRaw: true,
    // 推理模型：找框翻对白用不着多想，调到最低更快（不认这个值时 stream() 会去掉它重发）。
    // 试过 low：一页 4 块都要先想一阵，半天出不来结果，位置也没见好，退回 minimal
    extra: { reasoning_effort: "minimal" },
    errors: {
      insufficient_quota: "openaiQuota",
      unverified: "openaiUnverified",
    },
  },
};

// 结构化输出的根必须是对象，所以把对话框数组包在 items 里
const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x1: { type: "integer" },
          y1: { type: "integer" },
          x2: { type: "integer" },
          y2: { type: "integer" },
          text: { type: "string" },
          translation: { type: "string" },
        },
        required: ["x1", "y1", "x2", "y2", "text", "translation"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

// 服务商会在内部缩放图片，像素坐标容易对不上，所以让它直接给 0–1000 的比例。
// 先抄原文再翻译：小模型不分开写，容易把原文直接当译文交上来
const BOX_SPEC = `- x1, y1, x2, y2：这段原文的左上角和右下角，按整张图片归一化到 0–1000（x 从左到右，y 从上到下）。框要紧贴文字本身，竖排文字就框住整列，不要框住整个格子或大片空白。`;
const TEXT_SPEC = "\n- text：照抄这段日文原文。";
// json_object 模式不会强制结构，要在提示词里写清楚，并给一个译好的例子
const EXAMPLE = {
  "zh-Hans": "我曾经非常幸福。",
  "zh-Hant": "我曾經非常幸福。",
  en: "I was very happy.",
};
const shape = (lang, transcribe) =>
  `\n\ntranslation 必须是译文，不能照抄日文。只输出 JSON，格式：{"items":[{"x1":612,"y1":80,"x2":690,"y2":310,${
    transcribe ? '"text":"私はとても幸せでした。",' : ""
  }"translation":"${EXAMPLE[lang] || EXAMPLE["zh-Hans"]}"}]}`;

// 设置里填的 Base URL 能不能用：空的就用默认地址；服务商没写 hosts 的不限制
export function baseAllowed(provider, url) {
  const hosts = PROVIDERS[provider]?.hosts;
  if (!url || !hosts) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

async function request(cfg, path, apiKey, init = {}) {
  const res = await fetch(`${(cfg.baseOverride || cfg.base).replace(/\/+$/, "")}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (res.ok) return res;
  const data = await res.json().catch(() => ({}));
  const msg = data.error?.message || res.statusText;
  const code = data.error?.code;
  let text = cfg.errors[code] && t(cfg.errors[code]);
  // OpenAI 的新模型要先做组织验证，没做时返回 404 "Your organization must be verified..."，别说成"找不到模型"
  if (!text && /organization must be verified/i.test(msg) && cfg.errors.unverified) text = t(cfg.errors.unverified);
  if (!text) {
    if (res.status === 401) text = cfg.keyInvalid ? t(cfg.keyInvalid) : t("keyInvalid", { name: cfg.name });
    else if (res.status === 429) text = t("rateLimit", { name: cfg.name });
    else if (res.status === 404) text = `${t("modelNotFound", { name: cfg.name })} (${msg})`;
    else text = t("apiError", { name: cfg.name, status: res.status, msg });
  }
  const err = new Error(text);
  err.status = res.status;
  err.detail = msg;
  throw err;
}

// 通义千问偶尔会在 JSON 里夹乱码，几乎都出在 y1 的位置：
//   "x1": 250, " "`36`": 250, "y1": 36,   （多一段乱码，后面还有正常的 y1）
//   "x1": 572, " "`y1": 90,               （y1 前的引号换成了反引号）
//   "x1": 325, " "`0`": 0,                （y1 的键名整个变成乱码，值还在）
// 多出的引号会让按括号切对象的解析整段错位，所以不要求整段 JSON 合法：
// 在同一个 {...} 里按名字找 x1、x2、y2 和译文；y1 先按名字找，找不到就取 x1 和 x2 之间最后一个冒号后的数字
const key = (name) => `[^a-z0-9_]${name}["'\`]?\\s*:\\s*`;
const NUM = "(-?\\d+(?:\\.\\d+)?)";
const ITEM = new RegExp(
  `${key("x1")}${NUM}([^{}]*?)${key("x2")}${NUM}[^{}]*?${key("y2")}${NUM}[^{}]*?${key("translation")}"((?:[^"\\\\]|\\\\.)*)"`,
  "g"
);
const Y1 = new RegExp(`${key("y1")}${NUM}`);
const COLON_NUM = new RegExp(`:\\s*${NUM}`, "g");

function findY1(between) {
  const named = between.match(Y1);
  if (named) return +named[1];
  const nums = [...between.matchAll(COLON_NUM)];
  return nums.length ? +nums[nums.length - 1][1] : NaN;
}

export function looseScanner(onObject) {
  let buf = "";
  let pos = 0;
  return (chunk) => {
    buf += chunk;
    ITEM.lastIndex = pos;
    for (let m; (m = ITEM.exec(buf)); pos = ITEM.lastIndex) {
      let translation;
      try {
        translation = JSON.parse(`"${m[5]}"`);
      } catch {
        translation = m[5];
      }
      onObject({ x1: +m[1], y1: findY1(m[2]), x2: +m[3], y2: +m[4], translation });
    }
  };
}

// GPT 偶尔在译文里留一两个假名（比如"くそ…"没翻），整条会被当成没翻丢掉。
// 译文里还有别的字时，只把假名去掉；整句都是假名的照旧交给后面丢掉
function stripKana(t) {
  if (!/[\u3040-\u30ff]/.test(t)) return t;
  const rest = t.replace(/[\u3040-\u30ff]+/g, "").replace(/[ \t]{2,}/g, " ").trim();
  return /[^\s\p{P}\p{S}\d]/u.test(rest) ? rest : t;
}

// GPT 有时不框字、框了一大片（整个格子），画出来是盖住半个格子的大白块。
// 按抄下的原文字数估这些字大约要多大地方（每字约 26 像素见方，留一倍余量）；框比这大 6 倍以上、又接近正方形，
// 就以框的中心为准缩到估计的两倍大小。又高又窄（竖排大字标题）或又宽又扁的不动，那种本来就该那么大
function capBox(it) {
  const w = it.x2 - it.x1, h = it.y2 - it.y1;
  if (!(w > 0 && h > 0)) return it;
  const chars = Math.max(2, (it.text || it.translation || "").replace(/[\s\p{P}\p{S}]/gu, "").length);
  const est = chars * 26 * 26 * 2;
  const thin = Math.min(w, h), long = Math.max(w, h);
  const aspect = long / thin;
  const cx = (it.x1 + it.x2) / 2, cy = (it.y1 + it.y2) / 2;
  const shrink = (nw, nh, why) => {
    console.debug(`[框太大] 「${(it.text || it.translation || "").slice(0, 12)}」${why}：${Math.round(w)}×${Math.round(h)} → ${Math.round(nw)}×${Math.round(nh)}`);
    return { ...it, x1: cx - nw / 2, x2: cx + nw / 2, y1: cy - nh / 2, y2: cy + nh / 2 };
  };
  // 1. 不管什么形状，比字数需要的大 15 倍以上：离谱，缩到需要的 4 倍
  if (w * h > est * 15) {
    const k = Math.sqrt((est * 4) / (w * h));
    return shrink(w * k, h * k, "比字数需要的大太多");
  }
  // 2. 接近正方形、大 6 倍以上：多半框了整个格子
  if (aspect < 1.6 && w * h > est * 6) {
    const k = Math.sqrt((est * 2) / (w * h));
    return shrink(w * k, h * k, "框了一大片");
  }
  // 3. 又长又扁 / 又高又窄：一行（一列）字每个字差不多跟框的粗细一样大，长度不该超过"字数 × 粗细"太多。
  //    竖排大字标题字本身就粗，长度对得上，不受影响
  const maxLong = chars * thin * 1.5 + thin * 2;
  if (aspect >= 1.6 && long > maxLong) {
    return w >= h ? shrink(maxLong, h, "长条太长") : shrink(w, maxLong, "长条太长");
  }
  return it;
}

// size：像素坐标时传图片的 { width, height }，换算成 0–1000；不传就当已经是 0–1000
function toBox(it, size) {
  if (![it.x1, it.y1, it.x2, it.y2].every(Number.isFinite)) return null;
  const sx = size ? 1000 / size.width : 1;
  const sy = size ? 1000 / size.height : 1;
  const nx = (v) => Math.round(Math.min(1000, Math.max(0, v * sx)));
  const ny = (v) => Math.round(Math.min(1000, Math.max(0, v * sy)));
  const [xa, xb] = [nx(it.x1), nx(it.x2)].sort((a, b) => a - b);
  const [ya, yb] = [ny(it.y1), ny(it.y2)].sort((a, b) => a - b);
  // src：模型抄下的日文原文，左右两块重叠处翻到同一句时靠它认出来
  return { box_2d: [ya, xa, yb, xb], translation: it.translation, ...(typeof it.text === "string" && { src: it.text }) };
}

export async function translateCompat({ provider, baseUrl, apiKey, model, lang, imageBase64, width, height, onItem, signal }) {
  // 以前存下的非官方地址（比如别家的中转）直接报错，不把 key 发过去
  if (!baseAllowed(provider, baseUrl)) throw new Error(t("baseUrlNotAllowed"));
  const cfg = { ...PROVIDERS[provider], baseOverride: baseUrl };
  const pixel = cfg.coords === "pixel" && width > 0 && height > 0;
  cfg.size = pixel ? { width, height } : null;
  const boxSpec = pixel
    ? `- x1, y1, x2, y2：这段原文在图片上的像素坐标（左上角和右下角）。图片宽 ${width} 像素、高 ${height} 像素，原点在左上角。框要紧贴文字本身，不要框住整个格子或大片空白。`
    : BOX_SPEC;
  const transcribe = cfg.transcribe ?? true;
  let prompt = buildPrompt(lang, boxSpec + (transcribe ? TEXT_SPEC : "")).replace(
    "没有文字就返回空数组",
    "没有文字就返回空的 items"
  );
  // 结构化输出也带上格式和例子："translation 必须是译文"这句能防止它照抄日文
  prompt += shape(lang, transcribe);
  if (cfg.promptExtra) prompt += cfg.promptExtra;
  const body = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16000,
    response_format:
      cfg.jsonMode === "json_schema"
        ? { type: "json_schema", json_schema: { name: "manga_text", strict: true, schema: SCHEMA } }
        : { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}`, ...(cfg.detail && { detail: cfg.detail }) } },
          { type: "text", text: prompt },
        ],
      },
    ],
    ...cfg.extra,
  };
  // OpenAI 的推理模型不认 max_tokens
  if (provider === "openai") {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  const sig = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
  try {
    try {
      return await stream(cfg, body, apiKey, sig, onItem);
    } catch (e) {
      // 这个模型不认结构化输出：退回 json_object（提示词里已经写了格式）
      // 有的模型不认结构化输出时报 400，有的报 404
      if (!([400, 404].includes(e.status) && cfg.jsonMode === "json_schema")) throw e;
      console.log(`[${cfg.name}] 不支持结构化输出，改用 json_object：`, e.detail);
      Object.assign(body, cfg.extra, { response_format: { type: "json_object" } });
      return await stream({ ...cfg, extra: {} }, body, apiKey, sig, onItem);
    }
  } catch (e) {
    // 服务器一直不回话就别让用户干等
    if (e.name === "TimeoutError") throw new Error(t("timeout", { name: cfg.name, secs: TIMEOUT_MS / 1000 }));
    throw e;
  }
}

const TIMEOUT_MS = 90_000;

async function stream(cfg, body, apiKey, signal, onItem) {
  const sent = Date.now();
  let res;
  try {
    res = await request(cfg, "chat/completions", apiKey, { method: "POST", body: JSON.stringify(body), signal });
  } catch (e) {
    // 个别模型不认额外参数，就去掉再试一次
    if (!(e.status === 400 && Object.keys(cfg.extra).length)) throw e;
    for (const k of Object.keys(cfg.extra)) delete body[k];
    res = await request(cfg, "chat/completions", apiKey, { method: "POST", body: JSON.stringify(body), signal });
  }

  const items = [];
  let dropped = 0;
  let raw = "";
  const handle = (obj) => {
    // 译文只有标点符号（「…」「!!」）：原文本来就是这些，翻了也没多出意思，画出来只会挡住画面
    if (cfg.dropPunct && typeof obj.translation === "string" && !/[^\s\p{P}\p{S}]/u.test(obj.translation)) return void dropped++;
    const it = toBox(cfg.capBox && cfg.size ? capBox(obj) : obj, cfg.size);
    if (it && cfg.stripKana) it.translation = stripKana(it.translation);
    if (!valid(it)) return void dropped++;
    items.push(it);
    onItem?.(it);
  };
  // 结构化输出保证是合法 JSON，但字段顺序不固定，按标准 JSON 解析。
  // json_object 可能夹乱码：两种解析都跑，标准解析认不出的由宽松解析补上，同一条只算一次
  let scan = objectScanner(handle, 2);
  if (body.response_format.type !== "json_schema") {
    const seen = new Set();
    const once = (obj) => {
      const k = `${obj.x1},${obj.x2},${obj.y2},${obj.translation}`;
      if (!seen.has(k)) seen.add(k), handle(obj);
    };
    const strict = objectScanner(once, 2);
    const loose = looseScanner(once);
    scan = (chunk) => (strict(chunk), loose(chunk));
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let sse = "";
  let refusal = "";
  // 排查慢的原因：等了多久才开始出字、有没有偷偷"思考"（console.debug 默认不显示，控制台日志级别选 Verbose 才看得到）
  const stats = { started: Date.now(), firstToken: 0, content: 0, reasoning: 0, usage: null };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    sse += value;
    const lines = sse.split("\n");
    sse = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = data.choices?.[0];
      const delta = choice?.delta || {};
      if (delta.content || delta.reasoning_content) stats.firstToken ||= Date.now();
      if (delta.reasoning_content) stats.reasoning += delta.reasoning_content.length;
      if (data.usage) stats.usage = data.usage;
      if (choice?.delta?.content) {
        stats.content += choice.delta.content.length;
        raw += choice.delta.content;
        scan(choice.delta.content);
      }
      if (choice?.delta?.refusal) refusal += choice.delta.refusal;
    }
  }
  console.debug(
    `[${cfg.name}] ${body.model}（${body.response_format.type}）：上传图片 ${Math.round(body.messages[0].content[0].image_url.url.length / 1024)} KB${cfg.size ? `（${cfg.size.width}×${cfg.size.height} 像素）` : ""}，` +
      `上传加排队 ${((stats.started - sent) / 1000).toFixed(1)} 秒，` +
      `等待首字 ${((stats.firstToken - stats.started) / 1000).toFixed(1)} 秒，` +
      `总共 ${((Date.now() - stats.started) / 1000).toFixed(1)} 秒，正文 ${stats.content} 字，思考 ${stats.reasoning} 字`,
    stats.usage || ""
  );
  // 有被过滤的就把模型原话打出来（同样只在 Verbose 级别显示），看是没翻译、坐标不对还是格式不对
  if (dropped || !items.length || cfg.logRaw) console.debug(`[${cfg.name}] 可用 ${items.length} 条，被过滤 ${dropped} 条，原始输出：`, raw.slice(0, 3000));
  if (refusal && !items.length) throw new Error(t("refused", { name: cfg.name }));
  return items;
}
