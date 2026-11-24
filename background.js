import { listModels, pickDefaultModel, translateScreenshot, FALLBACK_MODEL } from "./gemini.js";
import { translateWithClaude, CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from "./claude.js";
import { t } from "./i18n.js";
import { PROVIDERS, translateCompat } from "./compat.js";

const CACHE_LIMIT = 50;
// 截图在 Retina 屏上是 2 倍大小，缩到这个长边再发，上传和识别都更快
const MAX_SIDE = 1800;
// Claude 会把超过这个尺寸的图在内部缩小，坐标就对不上了；先自己缩到范围内
const CLAUDE_LIMITS = { maxSide: 1568, maxPixels: 1_150_000 };

// 每个标签页同时只跑一次翻译；新的一次开始就取消旧的，省钱
const running = new Map();

chrome.action.onClicked.addListener((tab) => run(tab));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === "translate") run(tab);
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  if (msg.type === "cancel") running.get(sender.tab.id)?.abort();
  else if (msg.type === "cleared") markCleared(sender.tab.id);
});

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
}

// 插件重新加载后，页面里留着的旧脚本已经失效：问不通就清掉重装，不用手动刷新页面
async function ensureContentScript(tabId) {
  const alive = await chrome.tabs
    .sendMessage(tabId, { type: "ping" }, { frameId: 0 })
    .catch(() => null);
  if (alive === "pong") return;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      delete window.__mangaTranslatorReady;
      document.querySelectorAll("[data-manga-translator]").forEach((el) => el.remove());
    },
  });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function getModel(apiKey, saved) {
  if (saved) return saved;
  let model = FALLBACK_MODEL;
  try {
    model = pickDefaultModel(await listModels(apiKey));
  } catch {}
  await chrome.storage.local.set({ model });
  return model;
}

async function run(tab, { auto = false } = {}) {
  if (!tab?.id) return;
  if (!auto) {
    try {
      await ensureContentScript(tab.id);
    } catch {
      return; // chrome:// 之类的页面不能注入
    }
  }

  const {
    provider: savedProvider,
    apiKey: geminiKey,
    model: savedModel,
    claudeKey,
    claudeModel: savedClaudeModel,
    lang = "zh-Hans",
  } = await chrome.storage.local.get(["provider", "apiKey", "model", "claudeKey", "claudeModel", "lang"]);
  // 设置页现在只有通义千问和 Claude；以前存的 Gemini、OpenAI（代码还留着，以后可以加回来）也按设置页显示的默认值走
  const provider = ["claude", "qwen"].includes(savedProvider) ? savedProvider : "qwen";
  const claudeModel = CLAUDE_MODELS.some((m) => m.name === savedClaudeModel) ? savedClaudeModel : CLAUDE_DEFAULT_MODEL;
  const isClaude = provider === "claude";
  // 兼容接口的服务商（通义千问等）的 key 和模型存成 qwenKey / qwenModel 这样
  const compat = PROVIDERS[provider];
  const isGemini = !isClaude && !compat;
  const compatSaved = compat
    ? await chrome.storage.local.get([`${provider}Key`, `${provider}Model`, `${provider}Base`])
    : {};
  // 存的模型已经从列表里删掉了（比如以前选过的 qwen3-vl-flash），就用默认的
  const savedCompat = compatSaved[`${provider}Model`];
  const compatModel = compat && (compat.models.some((m) => m.name === savedCompat) ? savedCompat : compat.models[0].name);
  const apiKey = isClaude ? claudeKey : compat ? compatSaved[`${provider}Key`] : geminiKey;
  if (!apiKey) {
    const name = isClaude ? "Claude" : compat ? compat.name : "Gemini";
    await send(tab.id, { type: "error", text: t("noKey", { name }) });
    chrome.runtime.openOptionsPage();
    return;
  }

  running.get(tab.id)?.abort();
  const controller = new AbortController();
  running.set(tab.id, controller);
  const runId = `${Date.now()}-${Math.random()}`;

  // 先清掉旧译文和提示，再截图，不然会把它们也截进去
  await send(tab.id, { type: "clear" });
  await new Promise((r) => setTimeout(r, 80));

  let dataUrl;
  try {
    dataUrl = await capture(tab.windowId, 85);
  } catch (e) {
    // 自动模式下截图失败（比如切到了别的窗口）就安静地跳过
    if (!auto) await send(tab.id, { type: "error", text: t("captureFailed", { msg: e.message }) });
    if (running.get(tab.id) === controller) running.delete(tab.id);
    return;
  }
  const session = watch(tab);
  session.baseline = await signature(dataUrl);
  session.boxes = [];
  session.pending = false;

  // 缓存按模型分开：换了模型再翻同一页，要能看到新模型的结果
  const cacheModel = isClaude ? claudeModel : compat ? compatModel : savedModel || "auto";
  const tag = `${provider}:${cacheModel}:${lang}`;
  const cached = await lookup(tag, session.baseline);
  if (cached) {
    session.boxes = cached.map((it) => it.box_2d);
    await send(tab.id, { type: "begin", runId });
    await send(tab.id, { type: "done", runId, items: cached });
    if (running.get(tab.id) === controller) running.delete(tab.id);
    return;
  }

  await send(tab.id, { type: "begin", runId, loading: true });
  try {
    const started = Date.now();
    let first = 0;
    const model = isClaude ? claudeModel : compat ? compatModel : await getModel(apiKey, savedModel);
    const translate = isClaude
      ? (opts) => translateWithClaude(opts)
      : compat
        ? (opts) => translateCompat({ ...opts, provider, baseUrl: compatSaved[`${provider}Base`] })
        : (opts) => translateWithFallback(tab.id, opts);
    // 切成几块同时请求：每块字少，回得快；总时间约等于最慢那一块
    // 免费 key 每分钟能发的次数很少；碰到过限速，这次会话里就不切块，一页只发一次
    const { noSplit = false } = await chrome.storage.session.get("noSplit");
    const allowSplit = isClaude || (compat ? compat.split : !noSplit);
    const limits = isClaude ? CLAUDE_LIMITS : compat?.image || {};
    const pieces = await splitScreenshot(dataUrl, allowSplit, limits);
    const shade = await shader(dataUrl);
    // GPT 给的位置常常偏一百像素左右：在附近找真正的白色对话框和里面的字，把框挪过去（找不到可靠的就用 GPT 原来的框）
    const refine =
      provider === "openai" ? await makeRefiner(dataUrl).catch((e) => (console.warn("[校正] 出错，这一页不校正：", e), null)) : null;
    // 模型有时给同一段文字返回好几个框，叠在一起会互相挡住：和已画的框大面积重叠就不画
    const shown = [];
    let nextId = 0;
    await Promise.all(
      pieces.map((piece) =>
        translate({
          apiKey,
          model,
          lang,
          imageBase64: piece.base64,
          width: piece.width,
          height: piece.height,
          signal: controller.signal,
          onItem: (raw) => {
            const item = piece.toGlobal(raw);
            if (!item) return console.debug(`[${piece.name}] 中心点不在这一块，丢掉：`, raw.box_2d, raw.translation);
            if (refine) {
              let fixed = null;
              try {
                fixed = refine(item.box_2d);
              } catch (e) {
                console.warn("[校正] 出错：", e);
              }
              // 整页模式不用"被截图边缘切开"（cut）这个结果，当作没校正
              if (fixed?.box) {
                const rb = item.box_2d;
                const fb = fixed.box;
                const ctr = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
                // GPT 给的位置离得远、校正后却和别的已经校正过的框对到同一段字上：多半是几句都被吸到了离它们最近的那个对话框，
                // 这条就用 GPT 原来的框，不去抢别人的对话框
                const near = (a, b) => {
                  const [ay, ax] = ctr(a), [by, bx] = ctr(b);
                  return Math.hypot(ay - by, ax - bx) < Math.max(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1]);
                };
                const stolen = shown.find((it) => it.refined && overlaps(it.box_2d, fb) && !near(it.rawBox, rb));
                const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
                // GPT 的误差主要是左右偏一个框宽以内。挪得比这远，多半是 GPT 原本就对、但那个对话框不是封闭白框（闪光边、爆炸框），
                // 校正找不到它，跳到了旁边别人的对话框上
                const [rcy, rcx] = ctr(rb), [fcy, fcx] = ctr(fb);
                const tooFar = Math.abs(fcx - rcx) > (rb[3] - rb[1]) + 10 || Math.abs(fcy - rcy) > (rb[2] - rb[0]) * 0.5 + 10;
                if (tooFar) {
                  console.debug(`[校正] ${item.translation.slice(0, 12)}：校正挪得太远（${rb.join(",")} → ${fb.join(",")}），用原来的框`);
                } else if (area(fb) > area(rb) * 2.5) {
                  // 校正后的框比 GPT 的大好几倍：多半是把白底的整个格子当成对话框、把格子里的画线当成了字，画出来是一大块白
                  console.debug(`[校正] ${item.translation.slice(0, 12)}：校正后的框太大（${area(fb)} vs ${area(rb)}），用原来的框`);
                } else if (area(fb) < area(rb) * 0.3) {
                  // 只找到一小部分字（大字常常只认出振假名或第一个字）：框会缩成一点，译文挤得看不见，用 GPT 原来的框
                  console.debug(`[校正] ${item.translation.slice(0, 12)}：校正后的框太小（${area(fb)} vs ${area(rb)}），用原来的框`);
                } else if (stolen) {
                  console.debug(`[校正] ${item.translation.slice(0, 12)}：校正后和「${stolen.translation.slice(0, 12)}」对到同一段字，但 GPT 给的位置离得远，用原来的框`);
                } else {
                  console.debug(`[校正] ${item.translation.slice(0, 12)}：`, rb.join(","), "→", fb.join(","));
                  item.rawBox = rb;
                  item.refined = true;
                  item.box_2d = fb;
                }
              }
            }
            if (shown.some((it) => overlaps(it.box_2d, item.box_2d)))
              return console.debug(`[${piece.name}] 和已画的框重叠，丢掉：`, item.box_2d, item.translation);
            first ||= Date.now();
            // 同一个气泡被拆成两段（竖排的两列、上下两行）：和已画的框合成一个，免得互相压住。
            // 合完的框可能又碰到别的框，所以一直合到没有为止
            let merged = item;
            // GPT 已经被要求一个对话框只给一条：挨着的框多半是两个对话框（它的位置又常常偏），只在真的叠在一起或者原文相同时才合并
            // 合出来的框比两个框加起来大太多：两个框是斜着、隔开的，不是一个对话框里的两段，合了会变成盖住半个格子的大白块
            // （合完又碰到别的框会接着合，一路滚成一大块）
            const compact = (a, b) => {
              const u = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
              return boxArea(u) <= (boxArea(a) + boxArea(b)) * 1.6;
            };
            const mergeable = (it) =>
              provider === "openai" ? gptSame(it, merged) : sameBubble(it.box_2d, merged.box_2d) && compact(it.box_2d, merged.box_2d);
            for (let i; (i = shown.findIndex(mergeable)) !== -1; ) {
              const [old] = shown.splice(i, 1);
              console.debug(`[${piece.name}] 和已画的框是同一个气泡，合并：`, old.translation, "+", merged.translation);
              send(tab.id, { type: "remove", runId, id: old.id });
              merged = mergeItems(old, merged);
            }
            merged.id = ++nextId;
            if (provider === "openai") merged.grow = true;
            // GPT 的两句不同的话框叠在一起（又没叠到要合并的程度）：把大的那个从压住的那一边切掉一截，让出位置
            if (provider === "openai") {
              for (const it of shown) {
                const big = boxArea(it.box_2d) >= boxArea(merged.box_2d) ? it : merged;
                const small = big === it ? merged : it;
                const cut = trimAway(big.box_2d, small.box_2d);
                if (!cut) continue;
                console.debug(`[重叠] 「${big.translation.slice(0, 12)}」让开「${small.translation.slice(0, 12)}」：`, big.box_2d.join(","), "→", cut.join(","));
                big.box_2d.splice(0, 4, ...cut);
                if (big === it) {
                  // 已经画出来的框：拿掉重画
                  send(tab.id, { type: "remove", runId, id: it.id });
                  send(tab.id, { type: "add", runId, item: it });
                }
              }
            }
            merged.dark = shade(merged.box_2d);
            shown.push(merged);
            session.boxes.push(merged.box_2d);
            send(tab.id, { type: "add", runId, item: merged });
          },
        })
      )
    );
    const items = shown;
    await remember(tag, session.baseline, items);
    await send(tab.id, {
      type: "done",
      runId,
      count: items.length,
      firstSeconds: first ? (first - started) / 1000 : 0,
      model: model.replace("models/", ""),
      seconds: (Date.now() - started) / 1000,
    });
  } catch (e) {
    if (e.name !== "AbortError") await send(tab.id, { type: "error", runId, text: e.message });
  } finally {
    if (running.get(tab.id) === controller) running.delete(tab.id);
  }
}

// 交叠部分占较小那个框的六成以上，就算是同一段文字
function overlaps([ay0, ax0, ay1, ax1], [by0, bx0, by1, bx1]) {
  const w = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  const h = Math.min(ay1, by1) - Math.max(ay0, by0);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0));
  return smaller > 0 && (w * h) / smaller > 0.6;
}

// 两个框是不是同一个气泡里的两段：
// - 有一点叠在一起（超过六成的已经当作重复丢掉了）
// - 或者左右紧挨着（竖排的相邻两列）/ 上下紧挨着（横排的相邻两行），并且大半对齐
// - 或者按画出来的大小（四周加边距、太小的撑到最小尺寸）会碰到一起：小气泡里的几列字，
//   模型给的框之间有一点缝，可画出来就压在一起了
const DRAW_PAD = 5; // 0–1000 的单位，比 content.js 画框时加的边距略大
const DRAW_MIN = 16;
function drawn([y0, x0, y1, x1]) {
  const grow = (a, b) => {
    const half = Math.max((b - a) / 2 + DRAW_PAD, DRAW_MIN / 2);
    const c = (a + b) / 2;
    return [c - half, c + half];
  };
  const [ya, yb] = grow(y0, y1);
  const [xa, xb] = grow(x0, x1);
  return [ya, xa, yb, xb];
}

function sameBubble(a, b) {
  const [dy0, dx0, dy1, dx1] = drawn(a);
  const [ey0, ex0, ey1, ex1] = drawn(b);
  if (Math.min(dx1, ex1) > Math.max(dx0, ex0) && Math.min(dy1, ey1) > Math.max(dy0, ey0)) return true;
  const [ay0, ax0, ay1, ax1] = a;
  const [by0, bx0, by1, bx1] = b;
  const w = Math.min(ax1, bx1) - Math.max(ax0, bx0); // 横向交叠（负数 = 中间的空隙）
  const h = Math.min(ay1, by1) - Math.max(ay0, by0);
  const aw = ax1 - ax0, ah = ay1 - ay0, bw = bx1 - bx0, bh = by1 - by0;
  if (w > 0 && h > 0) return true;
  const narrow = Math.min(aw, bw);
  const short = Math.min(ah, bh);
  // 左右挨着：空隙不到窄的那列宽度的三成，上下重合大半
  if (h > short * 0.5 && w <= 0 && -w < narrow * 0.3) return true;
  // 上下挨着：空隙不到矮的那行高度的三成，左右重合大半
  if (w > narrow * 0.5 && h <= 0 && -h < short * 0.3) return true;
  return false;
}

const boxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

// a 和 b 叠在一起时，把 a 从压住 b 的那一边切掉，返回切完的 a；没叠在一起，或者切完剩不到一半，返回 null
function trimAway(a, b) {
  const [ay0, ax0, ay1, ax1] = a;
  const [by0, bx0, by1, bx1] = b;
  if (Math.min(ax1, bx1) <= Math.max(ax0, bx0) || Math.min(ay1, by1) <= Math.max(ay0, by0)) return null;
  const gap = 2;
  const options = [
    [ay0, ax0, ay1, bx0 - gap], // 收右边
    [ay0, bx1 + gap, ay1, ax1], // 收左边
    [ay0, ax0, by0 - gap, ax1], // 收下边
    [by1 + gap, ax0, ay1, ax1], // 收上边
  ].filter((c) => c[2] > c[0] && c[3] > c[1]);
  const best = options.sort((p, q) => boxArea(q) - boxArea(p))[0];
  return best && boxArea(best) >= boxArea(a) * 0.5 ? best : null;
}

// GPT 的两条是不是同一处：只看抄下的原文是不是同一句（同一句被翻了两遍）。
// 试过"框叠在一起超过三成也合并"：一个长框叠上别的框，合完更大又叠上下一个，几个对话框的话被接成一长条。
// 不同的句子叠在一起交给 trimAway 让开，不拼接
function gptSame(a, b) {
  const norm = (x) => (x || "").replace(/[\s\p{P}\p{S}]/gu, "");
  const s1 = norm(a.src), s2 = norm(b.src);
  return sameSrc(s1, s2);
}

// 两段（已经去掉标点空格的）原文是不是同一句：完全一样才算；只是包含时，短的至少 4 个字、长度差不多（七成以上）才算。
// 太松的话，「和に」这种短句会被「和にぃだなって」包含，被当成重复删掉
function sameSrc(s1, s2) {
  if (s1.length < 2 || s2.length < 2) return false;
  if (s1 === s2) return true;
  const [a, b] = s1.length <= s2.length ? [s1, s2] : [s2, s1];
  return a.length >= 4 && a.length >= b.length * 0.7 && b.includes(a);
}

// 合成一个框，译文按阅读顺序连起来：左右并排的先右后左（日漫从右往左读），上下的先上后下
function mergeItems(a, b) {
  const [ay0, ax0, ay1, ax1] = a.box_2d;
  const [by0, bx0, by1, bx1] = b.box_2d;
  const dx = Math.abs((ax0 + ax1) - (bx0 + bx1));
  const dy = Math.abs((ay0 + ay1) - (by0 + by1));
  const [first, second] =
    dx > dy ? (ax0 + ax1 > bx0 + bx1 ? [a, b] : [b, a]) : ay0 + ay1 < by0 + by1 ? [a, b] : [b, a];
  const t1 = first.translation.trim();
  const t2 = second.translation.trim();
  // 左右两块重叠处的同一句：两块各翻一遍，措辞不一样。抄下的原文一样就只留一个译文
  const norm = (x) => (x || "").replace(/[\s\p{P}\p{S}]/gu, "");
  const s1 = norm(first.src), s2 = norm(second.src);
  const same = sameSrc(s1, s2);
  // 同一句被翻了两遍（左右两块的重叠处）：两个框常常隔得很远（一块给对了、一块偏了），合成一个大框会横跨半页，
  // 变成一大块白。只留一个：吸附到对话框的优先，都一样就留先画出来的（a）
  if (same) {
    const keep = b.refined && !a.refined ? b : a;
    return { ...keep, box_2d: keep.box_2d.slice(), translation: t1.length >= t2.length ? t1 : t2 };
  }
  let translation;
  if (t1.includes(t2)) translation = t1;
  else if (t2.includes(t1)) translation = t2;
  else translation = /[A-Za-z0-9,.!?]$/.test(t1) && /^[A-Za-z0-9]/.test(t2) ? `${t1} ${t2}` : t1 + t2;
  return {
    ...first,
    box_2d: [Math.min(ay0, by0), Math.min(ax0, bx0), Math.max(ay1, by1), Math.max(ax1, bx1)],
    translation,
  };
}

// ---------- 用截图校正模型给的框 ----------
// 从韩漫版（manhwa-arasseo）搬过来，日漫这边只给 GPT 用：GPT-5 给的位置常常左右偏一百像素左右。
// 在模型的框附近找真正的白色对话框（或白底）和里面的字，把框挪到字上、缩到字的大小。
// 找不到可靠的白底（深色对话框、字直接写在画上）就原样用模型的框。
async function makeRefiner(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  // 日漫截图是整个宽屏窗口，缩到 1000 宽时竖排小字只剩几个像素、笔画糊成浅灰；用 2000 宽
  const S = Math.min(1, 2000 / bmp.width);
  const W = Math.max(1, Math.round(bmp.width * S));
  const H = Math.max(1, Math.round(bmp.height * S));
  const ctx = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
  const LIGHT = 238; // 对话框、白底都接近纯白；浅色的天空、背景不算
  const INK = 170; // 比这深的才算字的笔画
  let cur = null;
  const dbg = (m) => console.debug("[校正] 用模型原来的框：" + m + " 框=" + cur);

  // 先在框附近找；找不到封闭的对话框（可能被窗口切到了）就看大一点再找，最后才退回"白底上的字"
  return (box) => {
    cur = box.map(Math.round).join(",") + ` 图 ${W}×${H}`;
    for (const k of [0.6, 1.2, 2]) {
      const r = attempt(box, k, false);
      if (r) return r;
    }
    return attempt(box, 0.6, true);
  };

  function attempt(box, k, allowOpen) {
    const say = (m) => allowOpen && dbg(m);
    const [ymin, xmin, ymax, xmax] = box;
    const bx0 = (xmin / 1000) * W, bx1 = (xmax / 1000) * W, by0 = (ymin / 1000) * H, by1 = (ymax / 1000) * H;
    const bw = bx1 - bx0, bh = by1 - by0;
    if (bw < 3 || bh < 3) return null;
    // 在模型的框四周多看一圈（按框的长边算）：框偏了、或者只是对话框里的一行，也能看到整个对话框
    const e = Math.max(24, Math.max(bw, bh) * k);
    const wx0 = Math.max(0, Math.floor(bx0 - e)), wx1 = Math.min(W, Math.ceil(bx1 + e));
    const wy0 = Math.max(0, Math.floor(by0 - e)), wy1 = Math.min(H, Math.ceil(by1 + e));
    const ww = wx1 - wx0, wh = wy1 - wy0;
    if (ww < 8 || wh < 8) return null;
    const at = (x, y) => gray[(wy0 + y) * W + wx0 + x];
    const light = (x, y) => at(x, y) >= LIGHT;
    // 周围 5×5 都是白的点才能当起点（避开字缝里、画里零星的亮点）
    const solid = (x, y) => {
      if (x < 2 || y < 2 || x >= ww - 2 || y >= wh - 2) return false;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (!light(x + i, y + j)) return false;
      return true;
    };
    const cx = (bx0 + bx1) / 2 - wx0, cy = (by0 + by1) / 2 - wy0;
    const cands = [];
    for (let y = 2; y < wh - 2; y += 2)
      for (let x = 2; x < ww - 2; x += 2) if (solid(x, y)) cands.push([(x - cx) ** 2 + (y - cy) ** 2, y * ww + x]);
    if (!cands.length) return say("附近没有白底"), null;
    cands.sort((p, q) => p[0] - q[0]);
    // 从离框中心最近的白点开始，把连在一起的白色铺满。优先用"封闭"的一块（对话框里面，不碰窗口边）
    const fill = (seed) => {
      const reg = new Uint8Array(ww * wh);
      const stack = [seed];
      reg[seed] = 1;
      let area = 0, touches = false, edgeTop = false, edgeBottom = false, rx0 = ww, ry0 = wh, rx1 = 0, ry1 = 0;
      while (stack.length) {
        const p = stack.pop();
        area++;
        const x = p % ww, y = (p / ww) | 0;
        if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (y < ry0) ry0 = y; if (y > ry1) ry1 = y;
        if (x === 0 || y === 0 || x === ww - 1 || y === wh - 1) touches = true;
        if (y === 0 && wy0 === 0) edgeTop = true; // 碰到整张截图的上边
        if (y === wh - 1 && wy1 === H) edgeBottom = true;
        if (x > 0 && !reg[p - 1] && light(x - 1, y)) (reg[p - 1] = 1), stack.push(p - 1);
        if (x < ww - 1 && !reg[p + 1] && light(x + 1, y)) (reg[p + 1] = 1), stack.push(p + 1);
        if (y > 0 && !reg[p - ww] && light(x, y - 1)) (reg[p - ww] = 1), stack.push(p - ww);
        if (y < wh - 1 && !reg[p + ww] && light(x, y + 1)) (reg[p + ww] = 1), stack.push(p + ww);
      }
      return { reg, area, touches, edgeTop, edgeBottom, rb: [ry0, rx0, ry1 + 1, rx1 + 1] };
    };
    let pick = null;
    const tried = [];
    for (const [d, seed] of cands) {
      if (tried.some((t) => t.reg[seed])) continue;
      if (tried.length >= 40 || d > e * e * 9) break;
      const f = fill(seed);
      tried.push(f);
      if (!f.touches && f.area >= bw * bh * 0.25) { pick = f; break; }
    }
    if (!pick && !allowOpen) return null;
    pick ||= tried[0];
    if (!pick) return say("附近没有白底"), null;
    const { reg: region, area, touches, rb, edgeTop, edgeBottom } = pick;
    if (area < bw * bh * 0.15) return say(`白的太少 ${area}/${Math.round(bw * bh)}`), null; // 白的太少：不是白底上的字
    // 3. 从窗口边上把不是白色的地方铺满（画、对话框的边线、外面）；剩下没铺到的非白点就是被白色包住的字
    const outside = new Uint8Array(ww * wh);
    const st = [];
    for (let x = 0; x < ww; x++) for (const y of [0, wh - 1]) { const p = y * ww + x; if (!region[p] && !outside[p]) (outside[p] = 1), st.push(p); }
    for (let y = 0; y < wh; y++) for (const x of [0, ww - 1]) { const p = y * ww + x; if (!region[p] && !outside[p]) (outside[p] = 1), st.push(p); }
    while (st.length) {
      const p = st.pop();
      const x = p % ww, y = (p / ww) | 0;
      for (const [q, ok] of [[p - 1, x > 0], [p + 1, x < ww - 1], [p - ww, y > 0], [p + ww, y < wh - 1]])
        if (ok && !region[q] && !outside[q]) (outside[q] = 1), st.push(q);
    }
    // 白底一直连到窗口外（大片白底上的字，不是封闭的对话框）：只认模型框附近的字，免得把旁边别的句子也算进来
    const lim = touches
      ? { x0: bx0 - wx0 - bw * 0.15, x1: bx1 - wx0 + bw * 0.15, y0: by0 - wy0 - bh * 0.15, y1: by1 - wy0 + bh * 0.15 }
      : { x0: 0, x1: ww, y0: 0, y1: wh };
    // 字的像素：被白色包住、颜色够深（JPEG 在白底上留下的浅灰杂点不算）
    const inkMask = new Uint8Array(ww * wh);
    let ink = 0;
    for (let y = 0; y < wh; y++)
      for (let x = 0; x < ww; x++) {
        const p = y * ww + x;
        if (region[p] || outside[p]) continue;
        if (x < lim.x0 || x > lim.x1 || y < lim.y0 || y > lim.y1) continue;
        if (at(x, y) > INK) continue;
        inkMask[p] = 1;
        ink++;
      }
    // 把字分成一段一段：先找出每个笔画块，再把离得近的（同一行的字、上下相邻的行）连成一段。
    // 两个连在一起的对话框（白色是通的）里的两段话离得远，会分成两段；只要和模型的框重叠的那段
    const comps = [];
    {
      const seen = new Uint8Array(ww * wh);
      const st2 = [];
      for (let p0 = 0; p0 < inkMask.length; p0++) {
        if (!inkMask[p0] || seen[p0]) continue;
        let cx0 = ww, cy0 = wh, cx1 = -1, cy1 = -1, n = 0;
        seen[p0] = 1;
        st2.push(p0);
        while (st2.length) {
          const p = st2.pop();
          n++;
          const x = p % ww, y = (p / ww) | 0;
          if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
          for (let j = -1; j <= 1; j++)
            for (let i = -1; i <= 1; i++) {
              const nx = x + i, ny = y + j;
              if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
              const q = ny * ww + nx;
              if (inkMask[q] && !seen[q]) (seen[q] = 1), st2.push(q);
            }
        }
        if (n >= 3) comps.push([cx0, cy0, cx1, cy1]);
        if (comps.length > 3000) break;
      }
    }
    const hs = comps.map((c) => c[3] - c[1] + 1).filter((h) => h >= 3).sort((a, b) => a - b);
    const glyph = hs.length ? Math.max(4, hs[Math.floor(hs.length * 0.7)]) : 8;
    const parent = comps.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < comps.length; i++)
      for (let j = i + 1; j < comps.length; j++) {
        const A = comps[i], B = comps[j];
        const gx = Math.max(0, Math.max(A[0], B[0]) - Math.min(A[2], B[2]));
        const gy = Math.max(0, Math.max(A[1], B[1]) - Math.min(A[3], B[3]));
        if (gx <= glyph * 1.2 && gy <= glyph * 0.9) parent[root(i)] = root(j);
      }
    const groups = new Map();
    comps.forEach((c, i) => {
      const r = root(i);
      const g = groups.get(r);
      if (!g) groups.set(r, c.slice());
      else (g[0] = Math.min(g[0], c[0])), (g[1] = Math.min(g[1], c[1])), (g[2] = Math.max(g[2], c[2])), (g[3] = Math.max(g[3], c[3]));
    });
    const mbx0 = bx0 - wx0, mbx1 = bx1 - wx0, mby0 = by0 - wy0, mby1 = by1 - wy0;
    const blocks = [...groups.values()];
    let picked = blocks.filter((g) => g[2] >= mbx0 && g[0] <= mbx1 && g[3] >= mby0 && g[1] <= mby1);
    if (!picked.length && blocks.length) {
      const d = (g) => Math.hypot((g[0] + g[2]) / 2 - (mbx0 + mbx1) / 2, (g[1] + g[3]) / 2 - (mby0 + mby1) / 2);
      picked = [blocks.reduce((m, g) => (d(g) < d(m) ? g : m))];
    }
    let tx0 = Infinity, ty0 = Infinity, tx1 = -1, ty1 = -1;
    for (const g of picked) {
      if (g[0] < tx0) tx0 = g[0]; if (g[1] < ty0) ty0 = g[1]; if (g[2] > tx1) tx1 = g[2]; if (g[3] > ty1) ty1 = g[3];
    }
    if (ink < 8 || tx1 < tx0) {
      // 对话框被截图的上下边切开了，框附近看不到字：告诉调用的地方"被切开"，这次先不画，等整个露出来再翻
      if (edgeBottom || edgeTop) return say("对话框被截图边缘切开"), { cut: edgeBottom ? "bottom" : "top" };
      return say(`没找到字 ink=${ink} touches=${touches}`), null;
    }
    // 字和模型的框差太远（比如找到的是别的对话框）就不信
    const rw = tx1 - tx0 + 1, rh = ty1 - ty0 + 1;
    if (rw * rh < bw * bh * 0.04 || rw * rh > bw * bh * 6) return say(`大小差太多 ${rw}×${rh} vs ${Math.round(bw)}×${Math.round(bh)}`), null;
    const pad = 2;
    // 模型的框贴着字、大部分在这个对话框里（位置本来就准，Claude 通常这样）：和找到的字合在一起用。
    // 字贴着对话框边线时（比如两头的括号），那几个字会被当成边线、找不全，模型的框能补上。
    // 模型的框比字大很多（千问常把整个对话框当成一个框，圆对话框四个角外面就是人脸）或者偏了：只用找到的字
    const textArea = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    // 找到的字离模型的框太远：多半跳到了旁边另一个对话框上，不信
    const dcx = (tx0 + tx1) / 2 - ((bx0 + bx1) / 2 - wx0), dcy = (ty0 + ty1) / 2 - ((by0 + by1) / 2 - wy0);
    if (Math.hypot(dcx, dcy) > Math.max(bw, bh) * 0.9 + 20) return say("找到的字离模型的框太远"), null;
    // 模型的框和找到的字重合得多（框本来就准）才合在一起用；偏了一半的框只用找到的字
    const ox = Math.min(bx1 - wx0, tx1 + 1) - Math.max(bx0 - wx0, tx0);
    const oy = Math.min(by1 - wy0, ty1 + 1) - Math.max(by0 - wy0, ty0);
    const agree = ox > 0 && oy > 0 && (ox * oy) / (bw * bh) >= 0.5;
    if (agree && bw * bh <= textArea * 2.5) {
      // 封闭的对话框：只取模型的框落在对话框里的部分；白底连成一片时：用模型的框本身
      const lim2 = touches ? [0, 0, wh, ww] : rb;
      const ix0 = Math.max(bx0 - wx0, lim2[1]), ix1 = Math.min(bx1 - wx0, lim2[3]);
      const iy0 = Math.max(by0 - wy0, lim2[0]), iy1 = Math.min(by1 - wy0, lim2[2]);
      if (ix1 > ix0 && iy1 > iy0 && (ix1 - ix0) * (iy1 - iy0) >= bw * bh * 0.7) {
        tx0 = Math.min(tx0, ix0); tx1 = Math.max(tx1, ix1 - 1);
        ty0 = Math.min(ty0, iy0); ty1 = Math.max(ty1, iy1 - 1);
      }
    }
    const gx = (x) => Math.round(((wx0 + x) / W) * 1000);
    const gy = (y) => Math.round(((wy0 + y) / H) * 1000);
    return {
      box: [gy(ty0 - pad), gx(tx0 - pad), gy(ty1 + 1 + pad), gx(tx1 + 1 + pad)],
      // 封闭的对话框本身的范围：同一个对话框里拆开的几行，靠它认出是一家
      bubble: touches ? null : [gy(rb[0]), gx(rb[1]), gy(rb[2]), gx(rb[3])],
    };
  }
}

// 看原文那块区域整体是深色还是浅色
async function shader(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(8, 8);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return ([ymin, xmin, ymax, xmax]) => {
    const sx = (xmin / 1000) * bmp.width;
    const sy = (ymin / 1000) * bmp.height;
    const sw = Math.max(1, ((xmax - xmin) / 1000) * bmp.width);
    const sh = Math.max(1, ((ymax - ymin) / 1000) * bmp.height);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, 8, 8);
    const px = ctx.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return sum / 64 < 110;
  };
}

// ---------- 翻页检测 ----------
// 阅读器可能拦下点击和按键，所以不靠事件：每秒截一张小图和翻译时的画面比，
// 译文框盖住的地方和右上角的提示不算。画面变了 = 翻页了；等画面停稳再自动翻译。
const WATCH_MS = 1000;
const GRID_W = 32;
const GRID_H = 24;
const CELL_DIFF = 30; // 一个格子灰度差超过这个算"变了"（0–255）
const PAGE_TURN = 0.3; // 超过三成的格子变了才算翻页（鼠标晃出工具栏只会变一小块）
const SETTLED = 0.03; // 连续两次变化不到 3%，算停稳了
const SAME_PAGE = 0.15; // 查缓存时，变化不到 15% 就当作同一页（真翻页通常七成以上都变了）
const sessions = new Map();
let watchTimer = null;
let ticking = false;

function watch(tab) {
  let s = sessions.get(tab.id);
  if (!s) {
    s = { tab, baseline: null, boxes: [], pending: false, lastSig: null };
    sessions.set(tab.id, s);
  }
  s.tab = tab;
  watchTimer ??= setInterval(tick, WATCH_MS);
  return s;
}

function unwatch(tabId) {
  sessions.delete(tabId);
  if (!sessions.size && watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}
chrome.tabs.onRemoved.addListener(unwatch);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // 真正打开了新页面才停（阅读器翻页时可能只改网址里的页码，那种不算）
  if (info.status === "loading") unwatch(tabId);
});

function markCleared(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.boxes = [];
  s.pending = true;
  s.lastSig = null;
}

// 截图每秒最多两次，撞上限就等一下再试
async function capture(windowId, quality) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality });
  } catch (e) {
    if (!/MAX_CAPTURE/i.test(e.message)) throw e;
    await sleep(600);
    return chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality });
  }
}

async function signature(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(GRID_W, GRID_H);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, GRID_W, GRID_H);
  const px = ctx.getImageData(0, 0, GRID_W, GRID_H).data;
  const sig = new Float32Array(GRID_W * GRID_H);
  for (let i = 0; i < sig.length; i++) sig[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
  return sig;
}

function maskFor(boxes) {
  const mask = new Uint8Array(GRID_W * GRID_H);
  const cover = (y0, x0, y1, x1) => {
    const cx0 = Math.max(0, Math.floor(x0 * GRID_W) - 1);
    const cx1 = Math.min(GRID_W - 1, Math.ceil(x1 * GRID_W));
    const cy0 = Math.max(0, Math.floor(y0 * GRID_H) - 1);
    const cy1 = Math.min(GRID_H - 1, Math.ceil(y1 * GRID_H));
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) mask[y * GRID_W + x] = 1;
  };
  for (const [ymin, xmin, ymax, xmax] of boxes) cover(ymin / 1000, xmin / 1000, ymax / 1000, xmax / 1000);
  cover(0, 0.75, 0.15, 1); // 右上角的提示条
  cover(0, 0, 0.1, 1); // 顶部和底部：阅读器的工具栏、页码条常在这里，鼠标一动就会出现
  cover(0.9, 0, 1, 1);
  return mask;
}

// 返回没被遮住的格子里，明显变了的比例（0–1）
function diff(a, b, mask) {
  let changed = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask[i]) continue;
    if (Math.abs(a[i] - b[i]) > CELL_DIFF) changed++;
    n++;
  }
  return n ? changed / n : 0;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const s of sessions.values()) await checkTab(s);
  } finally {
    ticking = false;
  }
}

async function checkTab(s) {
  const { id: tabId, windowId } = s.tab;
  if (running.has(tabId)) return; // 正在翻译，基准画面由翻译那边负责
  let dataUrl;
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active?.id !== tabId) return; // 只看用户正在看的那个标签页
    dataUrl = await capture(windowId, 40);
  } catch {
    return;
  }
  if (running.has(tabId)) return;
  const sig = await signature(dataUrl);

  if (!s.pending) {
    if (!s.baseline) s.baseline = sig;
    else if (diff(sig, s.baseline, maskFor(s.boxes)) > PAGE_TURN) {
      // 翻页了：清掉旧译文，等画面停稳
      s.pending = true;
      s.boxes = [];
      s.lastSig = sig;
      send(tabId, { type: "stale" });
    }
    return;
  }

  // 等待中：和上一秒几乎一样，说明翻页动画结束了
  const settled = s.lastSig && diff(sig, s.lastSig, maskFor([])) < SETTLED;
  s.lastSig = sig;
  if (!settled) return;
  s.pending = false;
  const { autoTranslate = true } = await chrome.storage.local.get("autoTranslate");
  if (autoTranslate) run(s.tab, { auto: true });
  else s.baseline = sig;
}

// 横向的画面（比如左右两页的跨页）切成左右两块，中间重叠一段，免得切断对话框；
// 每个框只归中心点所在的那一块，重叠区里的框不会出现两次。
// limits.rows = 2 时每半再上下切开：小模型在字很密的格子里容易漏看，切小了字更大、要找的框更少
const OVERLAP = 0.06;
const OVERLAP_Y = 0.1; // 竖排对话框很长，上下切要多重叠一些

function bands(n, overlap) {
  if (n === 1) return [{ a: 0, b: 1, own: [0, 1] }];
  return [
    { a: 0, b: 0.5 + overlap, own: [0, 0.5] },
    { a: 0.5 - overlap, b: 1, own: [0.5, 1] },
  ];
}

async function splitScreenshot(dataUrl, allowSplit, limits) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const W = bmp.width;
  const H = bmp.height;
  const wide = allowSplit && W > H * 1.2;
  const cols = bands(wide ? 2 : 1, OVERLAP);
  const rows = bands(allowSplit && limits.rows === 2 ? 2 : 1, OVERLAP_Y);
  const regions = rows.flatMap((r, ri) =>
    cols.map((c, ci) => ({
      name: (rows.length > 1 ? ["上", "下"][ri] : "") + (cols.length > 1 ? ["左", "右"][ci] : "") || "整页",
      x0: c.a, x1: c.b, ownX: c.own,
      y0: r.a, y1: r.b, ownY: r.own,
    }))
  );
  return Promise.all(
    regions.map(async ({ name, x0, x1, ownX, y0, y1, ownY }) => {
      const sx = Math.round(x0 * W);
      const sw = Math.round((x1 - x0) * W);
      const sy = Math.round(y0 * H);
      const sh = Math.round((y1 - y0) * H);
      const { base64, width, height } = await encode(bmp, sx, sw, sy, sh, limits);
      const toGlobal = (it) => {
        const [ymin, xmin, ymax, xmax] = it.box_2d;
        const gx = (x) => Math.round((x0 + (x / 1000) * (x1 - x0)) * 1000);
        const gy = (y) => Math.round((y0 + (y / 1000) * (y1 - y0)) * 1000);
        const box = [gy(ymin), gx(xmin), gy(ymax), gx(xmax)];
        const cx = (box[1] + box[3]) / 2000;
        const cy = (box[0] + box[2]) / 2000;
        if (cx < ownX[0] || cx >= ownX[1] || cy < ownY[0] || cy >= ownY[1]) return null;
        return { ...it, box_2d: box };
      };
      return { name, base64, width, height, toGlobal };
    })
  );
}

// shortSide：短边最多多少像素（OpenAI 会在内部把短边缩到 768，先缩好，坐标才对得上）
// grid：每隔多少像素画一条半透明红线、边上标数字（只画在发给模型的图上）。
// GPT 凭感觉估坐标误差很大，有网格可以对着读数
async function encode(bmp, sx, sw, sy, sh, { maxSide = MAX_SIDE, maxPixels = Infinity, shortSide = Infinity, quality = 0.85, grid = 0 } = {}) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh), shortSide / Math.min(sw, sh), Math.sqrt(maxPixels / (sw * sh)));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  if (grid > 0) {
    ctx.strokeStyle = "rgba(255, 0, 0, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = grid; x < w; x += grid) (ctx.moveTo(x + 0.5, 0), ctx.lineTo(x + 0.5, h));
    for (let y = grid; y < h; y += grid) (ctx.moveTo(0, y + 0.5), ctx.lineTo(w, y + 0.5));
    ctx.stroke();
    ctx.font = "bold 11px sans-serif";
    ctx.textBaseline = "top";
    const label = (text, x, y) => {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.fillRect(x, y, tw + 4, 13);
      ctx.fillStyle = "rgb(220, 0, 0)";
      ctx.fillText(text, x + 2, y + 1);
    };
    for (let x = grid; x < w; x += grid) (label(String(x), x + 2, 1), label(String(x), x + 2, h - 14));
    for (let y = grid; y < h; y += grid) (label(String(y), 1, y + 2), label(String(y), w - 30, y + 2));
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), width: w, height: h };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (e) => e.status === 500 || e.status === 503;

async function translateWithFallback(tabId, opts) {
  const { apiKey, model } = opts;
  let retired = false;
  let emitted = false;
  const tracked = { ...opts, onItem: (it) => ((emitted = true), opts.onItem(it)) };
  // 服务繁忙（500/503）通常几秒就好：同一个模型先重试两次
  for (const wait of [0, 2000, 5000]) {
    if (wait) {
      await send(tabId, { type: "loading", text: t("geminiBusy") });
      await sleep(wait);
    }
    try {
      return await translateScreenshot(tracked);
    } catch (e) {
      // 已经显示了一部分译文，再重试会重复画框，直接报错
      if (emitted) throw e;
      if (e.status === 404) {
        retired = true;
        break;
      }
      if (e.status === 429 && !e.daily && !opts.rateRetried) {
        await chrome.storage.session.set({ noSplit: true });
        const secs = Math.min(60, Math.ceil(e.retryAfter));
        await send(tabId, { type: "loading", text: t("rateLimited", { secs }) });
        await sleep(secs * 1000);
        return translateWithFallback(tabId, { ...opts, rateRetried: true });
      }
      if (!isBusy(e)) throw e;
    }
  }
  // 模型下线（404）或一直繁忙：换一个当前可用的模型再试一次
  const others = (await listModels(apiKey)).filter((m) => m.name !== model);
  const next = pickDefaultModel(others);
  await send(tabId, { type: "loading", text: t("switchModel") });
  const items = await translateScreenshot({ ...opts, model: next });
  // 只有旧模型下线了才记住新模型；繁忙只是临时借用
  if (retired) await chrome.storage.local.set({ model: next });
  return items;
}

// 同一画面不重复花钱；只记最近 CACHE_LIMIT 页。按缩略图比较，
// 截图时多了工具栏、鼠标指针附近的小变化都还算同一页
async function lookup(tag, sig) {
  const { cache = [] } = await chrome.storage.session.get("cache");
  const mask = maskFor([]);
  const hit = cache.find((c) => c.tag === tag && diff(sig, Float32Array.from(c.sig), mask) < SAME_PAGE);
  return hit?.items;
}

async function remember(tag, sig, items) {
  const { cache = [] } = await chrome.storage.session.get("cache");
  cache.push({ tag, sig: Array.from(sig, Math.round), items });
  await chrome.storage.session.set({ cache: cache.slice(-CACHE_LIMIT) });
}
