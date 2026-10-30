// Gemini API 调用，background 和设置页共用。
const API = "https://generativelanguage.googleapis.com/v1beta";
const FALLBACK_MODEL = "models/gemini-2.5-flash";

export const LANGUAGES = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  "en": "English",
};

async function request(path, apiKey, init = {}) {
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
  });
  if (res.ok) return res;
  const data = await res.json().catch(() => ({}));
  {
    const msg = data.error?.message || res.statusText;
    if (res.status === 400 && /API key/i.test(msg)) throw new Error("API key 无效，请在设置里检查。");
    if (res.status === 429) {
      // 免费额度有"每分钟"和"每天"两种上限；每分钟的会告诉我们等几秒
      const daily = /per ?day|PerDay|daily/i.test(JSON.stringify(data));
      const retry = (data.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
      const err = new Error(
        daily
          ? "今天的免费额度用完了，明天会恢复；或者在 Google AI Studio 绑卡改成付费。"
          : "请求太快，超过了免费额度每分钟的次数限制，稍等一会儿再翻。"
      );
      err.status = 429;
      err.daily = daily;
      err.retryAfter = retry ? parseFloat(retry) : 20;
      throw err;
    }
    const err = new Error(`Gemini 返回错误（${res.status}）：${msg}`);
    err.status = res.status;
    throw err;
  }
}

async function call(path, apiKey, init) {
  return (await request(path, apiKey, init)).json();
}

// 列出能看图生成内容的模型
export async function listModels(apiKey) {
  const data = await call("models?pageSize=1000", apiKey);
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .filter((m) => /gemini/i.test(m.name) && !/(tts|image|audio|live|embedding)/i.test(m.name))
    .map((m) => ({ name: m.name, label: m.displayName || m.name }));
}

// 默认选版本号最高的正式版 Flash（不要 lite / 预览版），没有就退而求其次
export function pickDefaultModel(models) {
  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const score = (n) =>
    version(n) * 10 +
    (/flash/.test(n) ? 5 : 0) -
    (/lite/.test(n) ? 3 : 0) -
    (/(preview|exp)/.test(n) ? 2 : 0) -
    (/-\d{3}$|-\d{2}-\d{4}$/.test(n) ? 1 : 0);
  const flash = models.filter((m) => /flash/.test(m.name));
  const pool = flash.length ? flash : models;
  if (!pool.length) return FALLBACK_MODEL;
  return pool.slice().sort((a, b) => score(b.name) - score(a.name))[0].name;
}

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
      translation: { type: "STRING" },
    },
    required: ["box_2d", "translation"],
  },
};

const GEMINI_BOX = "- box_2d：[ymin, xmin, ymax, xmax]，按整张截图归一化到 0–1000，框住这段原文（竖排文字就框住整列）。";

// boxSpec：怎么描述位置，Gemini 用 0–1000 比例，Claude 用像素
export function buildPrompt(lang, boxSpec = GEMINI_BOX) {
  return `这是一张浏览器截图，里面是漫画阅读器正在显示的漫画页（通常是日文）。
请找出漫画画面里每一处需要翻译的文字：对话框、旁白框、手写的对白，以及影响理解的拟声词。
很短的也不要漏掉：只有一两个字的对白、人名、语气词（比如「えっ」「うん」「はぁ」）、画面角落的小字，都要单独列出来。
不在对话框里的文字也要翻：黑底白字的旁白、画面上直接写的独白、竖排的长段叙述、方框里的说明文字。
只有省略号或标点、没有文字的对话框可以跳过。没有文字的格子不要输出任何条目，不要写"无对白"之类的说明。
忽略浏览器和阅读器本身的界面文字（菜单、按钮、页码、书名栏等）。

对每一处文字返回：
${boxSpec}
- translation：翻译成${LANGUAGES[lang] || "简体中文"}，口语自然、贴合角色语气，保持简短，能放进原来的对话框。

按漫画的阅读顺序排列（日漫是从右到左、从上到下）。没有文字就返回空数组。`;
}

function thinkingFor(model) {
  if (/gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/gemini-([3-9]|\d\d)/.test(model)) return { thinkingLevel: /flash/.test(model) ? "minimal" : "low" };
  return null;
}

// 模型偶尔会给没字的格子写一句"（无对白）"之类的说明，这种不画
const isPlaceholder = (t) => /^[（(【\[].*[)）】\]]$/.test(t.trim()) || /无对白|无文字|没有文字|无台词/.test(t);
// 译文里有平假名，说明模型没翻、照抄了日文（目标语言都不是日文），画出来只会挡住原文
const untranslated = (t) => /[\u3040-\u309f]/.test(t);
export const valid = (it) =>
  Array.isArray(it?.box_2d) &&
  it.box_2d.length === 4 &&
  it.translation &&
  !isPlaceholder(it.translation) &&
  !untranslated(it.translation);

// 从还没写完的 JSON 数组里，把已经完整的 {...} 一个个切出来
// itemDepth：对话框对象所在的嵌套层数（Gemini 直接返回数组是 1，Claude 包了一层对象是 2）
export function objectScanner(onObject, itemDepth = 1) {
  let buf = "", pos = 0, depth = 0, inStr = false, esc = false, start = -1;
  return (chunk) => {
    buf += chunk;
    for (; pos < buf.length; pos++) {
      const c = buf[pos];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{" || c === "[") {
        if (c === "{" && depth === itemDepth) start = pos;
        depth++;
      } else if (c === "}" || c === "]") {
        depth--;
        if (c === "}" && depth === itemDepth && start >= 0) {
          try {
            onObject(JSON.parse(buf.slice(start, pos + 1)));
          } catch {}
          start = -1;
        }
      }
    }
  };
}

// 流式请求：每认出一个对话框就回调一次 onItem，不用等整页结果
export async function translateScreenshot({ apiKey, model, lang, imageBase64, onItem, signal }) {
  const body = {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          { text: buildPrompt(lang) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  };
  // 找框和翻对白不需要"深度思考"，关掉能快很多
  const thinking = thinkingFor(model);
  if (thinking) body.generationConfig.thinkingConfig = thinking;
  const path = `${model}:streamGenerateContent?alt=sse`;
  let res;
  try {
    res = await request(path, apiKey, { method: "POST", body: JSON.stringify(body), signal });
  } catch (e) {
    // 个别模型不认这个参数，就去掉再试
    if (!(thinking && e.status === 400 && /thinking/i.test(e.message))) throw e;
    delete body.generationConfig.thinkingConfig;
    res = await request(path, apiKey, { method: "POST", body: JSON.stringify(body), signal });
  }

  const items = [];
  const scan = objectScanner((it) => {
    if (!valid(it)) return;
    items.push(it);
    onItem?.(it);
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let sse = "";
  let blocked = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    sse += value;
    const lines = sse.split("\n");
    sse = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let data;
      try {
        data = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (data.promptFeedback?.blockReason) blocked = data.promptFeedback.blockReason;
      for (const p of data.candidates?.[0]?.content?.parts || []) if (p.text && !p.thought) scan(p.text);
    }
  }
  if (blocked && !items.length) throw new Error(`Gemini 拒绝处理这张图（${blocked}）。`);
  return items;
}

export { FALLBACK_MODEL };
