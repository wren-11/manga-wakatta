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
    models: [{ name: "gpt-5-mini", label: "gpt-5-mini" }],
    split: true,
    jsonMode: "json_schema",
    extra: { reasoning_effort: "low" },
    errors: {
      insufficient_quota: "OpenAI 账户余额不足。API 和 ChatGPT 会员是分开计费的，需要到 platform.openai.com 的 Billing 里充值。", // 设置页没有 OpenAI，没翻英文
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

function toBox(it) {
  if (![it.x1, it.y1, it.x2, it.y2].every(Number.isFinite)) return null;
  const n = (v) => Math.round(Math.min(1000, Math.max(0, v)));
  const [xa, xb] = [n(it.x1), n(it.x2)].sort((a, b) => a - b);
  const [ya, yb] = [n(it.y1), n(it.y2)].sort((a, b) => a - b);
  return { box_2d: [ya, xa, yb, xb], translation: it.translation };
}

export async function translateCompat({ provider, baseUrl, apiKey, model, lang, imageBase64, onItem, signal }) {
  const cfg = { ...PROVIDERS[provider], baseOverride: baseUrl };
  const transcribe = cfg.transcribe ?? true;
  let prompt = buildPrompt(lang, BOX_SPEC + (transcribe ? TEXT_SPEC : "")).replace(
    "没有文字就返回空数组",
    "没有文字就返回空的 items"
  );
  // 结构化输出也带上格式和例子："translation 必须是译文"这句能防止它照抄日文
  prompt += shape(lang, transcribe);
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
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
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
    const it = toBox(obj);
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
    `[${cfg.name}] ${body.model}（${body.response_format.type}）：上传图片 ${Math.round(body.messages[0].content[0].image_url.url.length / 1024)} KB，` +
      `上传加排队 ${((stats.started - sent) / 1000).toFixed(1)} 秒，` +
      `等待首字 ${((stats.firstToken - stats.started) / 1000).toFixed(1)} 秒，` +
      `总共 ${((Date.now() - stats.started) / 1000).toFixed(1)} 秒，正文 ${stats.content} 字，思考 ${stats.reasoning} 字`,
    stats.usage || ""
  );
  // 有被过滤的就把模型原话打出来（同样只在 Verbose 级别显示），看是没翻译、坐标不对还是格式不对
  if (dropped || !items.length) console.debug(`[${cfg.name}] 可用 ${items.length} 条，被过滤 ${dropped} 条，原始输出：`, raw.slice(0, 3000));
  if (refusal && !items.length) throw new Error(t("refused", { name: cfg.name }));
  return items;
}
