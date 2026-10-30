// Claude API 调用（Anthropic 官方 SDK，打包在 vendor/ 里）
import Anthropic from "./vendor/anthropic-sdk.mjs";
import { buildPrompt, objectScanner, valid } from "./gemini.js";
import { t } from "./i18n.js";

export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";
// 只放实测过效果好的模型（Haiku 找框和翻译都不够准）
export const CLAUDE_MODELS = [
  { name: "claude-sonnet-5-5", label: "sonnet" }, // label 是 i18n.js 里的文字
  { name: "claude-opus-5-5", label: "opus" },
];

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
          translation: { type: "string" },
        },
        required: ["x1", "y1", "x2", "y2", "translation"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

function client(apiKey) {
  // 插件里的 key 是用户自己填、只存在本机的，所以允许在浏览器里直接调用
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// 新一代模型支持 effort；找框翻对白用 low 就够了，更快更省
const supportsEffort = (model) => /claude-(opus|sonnet|haiku|fable)-([5-9]|4-[5-9])/.test(model);

function friendly(e) {
  if (e instanceof Anthropic.AuthenticationError) return new Error(t("keyInvalid", { name: "Claude" }));
  if (e instanceof Anthropic.PermissionDeniedError) return new Error(t("claudeNoPermission"));
  if (e instanceof Anthropic.NotFoundError) return new Error(t("modelNotFound", { name: "Claude" }));
  if (e instanceof Anthropic.RateLimitError) return new Error(t("claudeRateLimit"));
  if (e instanceof Anthropic.APIError) return new Error(t("apiError", { name: "Claude", status: e.status ?? t("network"), msg: e.message }));
  return e;
}

// Claude 习惯给像素坐标：告诉它图片的确切尺寸，再换算回 0–1000 比例
function toBox(it, width, height) {
  if (![it.x1, it.y1, it.x2, it.y2].every(Number.isFinite)) return null;
  const nx = (x) => Math.round((Math.min(width, Math.max(0, x)) / width) * 1000);
  const ny = (y) => Math.round((Math.min(height, Math.max(0, y)) / height) * 1000);
  const [xa, xb] = [nx(it.x1), nx(it.x2)].sort((a, b) => a - b);
  const [ya, yb] = [ny(it.y1), ny(it.y2)].sort((a, b) => a - b);
  return { box_2d: [ya, xa, yb, xb], translation: it.translation };
}

export async function translateWithClaude({ apiKey, model, lang, imageBase64, width, height, onItem, signal }) {
  const boxSpec = `- x1, y1, x2, y2：这段原文在图片上的像素坐标（左上角和右下角）。图片宽 ${width} 像素、高 ${height} 像素，原点在左上角。框住整段原文，竖排文字就框住整列。`;
  const items = [];
  const scan = objectScanner((raw) => {
    const it = toBox(raw, width, height);
    if (!valid(it)) return;
    items.push(it);
    onItem?.(it);
  }, 2);
  try {
    const stream = client(apiKey).messages.stream(
      {
        model,
        max_tokens: 16000,
        output_config: {
          ...(supportsEffort(model) ? { effort: "low" } : {}),
          format: { type: "json_schema", schema: SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
              { type: "text", text: buildPrompt(lang, boxSpec).replace("没有文字就返回空数组", "没有文字就返回空的 items") },
            ],
          },
        ],
      },
      { signal }
    );
    stream.on("text", (delta) => scan(delta));
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal" && !items.length) {
      throw new Error(t("refused", { name: "Claude" }));
    }
    return items;
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError || e?.name === "AbortError") {
      const abort = new Error("aborted");
      abort.name = "AbortError";
      throw abort;
    }
    throw friendly(e);
  }
}
