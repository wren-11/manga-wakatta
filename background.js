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
  // 设置页现在只有通义千问和 Claude；以前存的 Gemini（代码还留着，以后可以加回来）也按设置页显示的默认值走
  const provider = savedProvider === "claude" || savedProvider === "qwen" ? savedProvider : "qwen";
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
    // 模型有时给同一段文字返回好几个框，叠在一起会互相挡住：和已画的框大面积重叠就不画
    const shown = [];
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
            if (shown.some((it) => overlaps(it.box_2d, item.box_2d)))
              return console.debug(`[${piece.name}] 和已画的框重叠，丢掉：`, item.box_2d, item.translation);
            shown.push(item);
            item.dark = shade(item.box_2d);
            first ||= Date.now();
            session.boxes.push(item.box_2d);
            send(tab.id, { type: "add", runId, item });
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

async function encode(bmp, sx, sw, sy, sh, { maxSide = MAX_SIDE, maxPixels = Infinity, quality = 0.85 } = {}) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh), Math.sqrt(maxPixels / (sw * sh)));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
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
