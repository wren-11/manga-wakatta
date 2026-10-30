// 每次翻译都会注入一次，只初始化一次
if (!window.__mangaTranslatorReady) {
  window.__mangaTranslatorReady = true;

  const MIN_FONT = 8;
  const FONT_SIZES = { small: 16, medium: 22, large: 30 }; // 最大字号
  // 显示设置：tight = 只盖住原文那块，字自动缩小；grow = 字太小时把框撑大（字清楚但会挡画）
  let display = { boxMode: "tight", fontSize: "medium" };
  chrome.storage.local.get(["boxMode", "fontSize"]).then((v) => Object.assign(display, v));
  chrome.storage.onChanged.addListener((changes) => {
    for (const k of ["boxMode", "fontSize"]) if (changes[k]) display[k] = changes[k].newValue;
  });
  let host = null;
  let toastTimer = null;
  // 这里不是模块，用不了 i18n.js，只有几句提示，直接写在这里
  const zh = chrome.i18n.getUILanguage().toLowerCase().startsWith("zh");
  const TRANSLATING = zh ? "翻译中…" : "Translating…";

  function ensureHost() {
    // 阅读器全屏时，覆盖层必须放进全屏元素里才看得到
    const parent = document.fullscreenElement || document.documentElement;
    if (!host) {
      host = document.createElement("div");
      host.dataset.mangaTranslator = "";
      // 别让 Chrome 自带翻译或沉浸式翻译这类插件把译文再翻一遍（会把英文译文又机翻成中文）
      host.setAttribute("translate", "no");
      host.className = "notranslate";
      host.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        .box{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
          background:#fff;color:#111;border-radius:6px;padding:2px 3px;overflow:hidden;text-align:center;
          font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-weight:600;line-height:1.25;
          box-shadow:0 0 0 1px rgba(0,0,0,.08);word-break:break-all}
        .v{writing-mode:vertical-rl;text-orientation:upright;letter-spacing:.05em}
        .latin{word-break:normal;overflow-wrap:normal;hyphens:none;line-height:1.15;
          font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
        .dark{background:#111;color:#f5f5f5;box-shadow:none}
        .toast{position:fixed;top:16px;right:16px;max-width:320px;padding:10px 14px;border-radius:10px;
          background:rgba(20,20,20,.88);color:#fff;font:14px/1.4 -apple-system,"PingFang SC",sans-serif;
          box-shadow:0 4px 16px rgba(0,0,0,.25)}
        .toast.err{background:#b3261e}
      </style><div id="layer" translate="no" class="notranslate"></div>`;
    }
    if (host.parentNode !== parent) parent.appendChild(host);
    return host.shadowRoot;
  }

  function clear() {
    if (!host) return;
    host.shadowRoot.getElementById("layer").replaceChildren();
    clearTimeout(toastTimer);
  }

  function toast(text, isError, ms) {
    const root = ensureHost();
    const layer = root.getElementById("layer");
    layer.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " err" : "");
    el.textContent = text;
    layer.appendChild(el);
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => el.remove(), ms);
  }

  const READABLE_FONT = 13; // 小于这个字号就先把框撑大，而不是继续缩字
  const overflowing = (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;

  function shrinkFont(el, floor) {
    let size = parseFloat(el.style.fontSize);
    while (size > floor && overflowing(el)) {
      size -= 1;
      el.style.fontSize = size + "px";
    }
  }

  function fit(el) {
    const maxFont = FONT_SIZES[display.fontSize] || FONT_SIZES.medium;
    const size = Math.min(maxFont, Math.max(MIN_FONT, Math.min(el.clientWidth, el.clientHeight) * 0.5));
    el.style.fontSize = size + "px";
    if (display.boxMode !== "grow") return shrinkFont(el, MIN_FONT);
    shrinkFont(el, READABLE_FONT);
    // 竖排的旁白框往往比中文译文窄：往左加列（竖排从右往左排），横排的往下加行
    const vertical = el.classList.contains("v");
    for (let i = 0; i < 8 && overflowing(el); i++) {
      if (vertical) {
        const w = el.offsetWidth * 1.25;
        el.style.left = parseFloat(el.style.left) - (w - el.offsetWidth) + "px";
        el.style.width = w + "px";
      } else {
        el.style.height = el.offsetHeight * 1.25 + "px";
      }
    }
    shrinkFont(el, MIN_FONT);
  }

  // 中日韩文字（含假名、全角标点）
  const CJK = /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;

  function addBox(it) {
    const layer = ensureHost().getElementById("layer");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const [ymin, xmin, ymax, xmax] = it.box_2d.map((n) => Math.min(1000, Math.max(0, n)));
    // 稍微放大一点，盖住原文的边缘
    const rawW = ((xmax - xmin) / 1000) * vw;
    const rawH = ((ymax - ymin) / 1000) * vh;
    const grow = display.boxMode === "grow";
    // 竖排长条的横向位置最容易偏，撑大模式下左右多留一些余量
    const padX = grow && rawH > rawW * 1.6 ? Math.max(6, rawW * 0.2) : grow ? 6 : 3;
    const padY = grow ? 6 : 3;
    const minSide = grow ? 30 : 16;
    let width = Math.max(rawW + padX * 2, minSide);
    const height = Math.max(rawH + padY * 2, minSide);
    // 英文等拼音文字不能竖排，而且比中文长：竖长的框（原文是竖排）横向加宽，排成几行短句。
    // 不在单词中间断开：一个词放不下时由 fit() 把字缩小（overflowing 会检查横向溢出）
    const latin = !CJK.test(it.translation);
    const top = Math.max(0, Math.min(vh - height, (ymin / 1000) * vh + rawH / 2 - height / 2));
    const centerX = (xmin / 1000) * vw + rawW / 2;
    const leftFor = (w) => Math.max(0, Math.min(vw - w, centerX - w / 2));
    if (latin && height > width * 1.2) {
      // 字密的格子里加宽会盖到旁边的框：碰到已经画好的框就少加宽一点，放不下的由 fit() 缩小字号
      const base = width;
      const others = [...layer.querySelectorAll(".box")].map((b) => b.getBoundingClientRect());
      const hits = (w) =>
        others.some((r) => leftFor(w) < r.right && leftFor(w) + w > r.left && top < r.bottom && top + height > r.top);
      width = Math.max(base, Math.min(height * 0.8, vw * 0.22, rawW * 2));
      while (width > base && hits(width)) width = Math.max(base, width * 0.85);
    }
    const left = leftFor(width);
    const el = document.createElement("div");
    el.className =
      "box" + (latin ? " latin" : height > width * 1.6 ? " v" : "") + (it.dark ? " dark" : "");
    el.setAttribute("translate", "no");
    el.classList.add("notranslate");
    // 框重叠时小的叠在上面，不会被大框整个盖住
    const z = Math.max(1, 1e6 - Math.round(width * height));
    el.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;z-index:${z};`;
    el.textContent = it.translation;
    layer.appendChild(el);
    fit(el);
    if (latin) {
      // 竖排原文的框很高，英文横排只要几行：去掉多余的高度，少挡画面（保持上下居中）
      const before = el.offsetHeight;
      el.style.height = "auto";
      const need = Math.max(el.offsetHeight, minSide);
      if (need < before) el.style.top = top + (before - need) / 2 + "px";
      el.style.height = Math.min(need, before) + "px";
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "ping") return reply("pong");
    if (msg.type === "clear") clear();
    else if (msg.type === "stale") {
      // 后台发现画面变了（翻页了）：旧译文作废
      activeRun = null;
      inFlight = false;
      clear();
    }
    else if (msg.type === "begin") {
      clear();
      activeRun = msg.runId;
      inFlight = !!msg.loading;
      if (msg.loading) toast(TRANSLATING);
    } else if (msg.runId && msg.runId !== activeRun) {
      return;
    } else if (msg.type === "loading") toast(msg.text || TRANSLATING);
    else if (msg.type === "add") {
      ensureHost().querySelector(".toast")?.remove();
      addBox(msg.item);
    } else if (msg.type === "done") {
      inFlight = false;
      (msg.items || []).forEach(addBox);
      const shown = ensureHost().querySelectorAll(".box").length;
      if (!shown) toast(zh ? "这个画面里没找到需要翻译的文字。" : "No text to translate on this screen.", false, 2500);
      else if (msg.seconds) {
        const first = msg.firstSeconds.toFixed(1);
        const all = msg.seconds.toFixed(1);
        toast(zh ? `首个译文 ${first} 秒 · 全部 ${all} 秒 · ${msg.model}` : `First ${first}s · all ${all}s · ${msg.model}`, false, 4000);
      }
    } else if (msg.type === "error") {
      inFlight = false;
      toast(msg.text, true, 6000);
    }
  });

  // 翻页、滚动、缩放窗口后，旧译文就对不上了：清掉、取消还没翻完的。
  // 自动翻译由后台每秒比对画面来触发（阅读器可能拦下点击和按键，光靠事件不可靠），
  // 这里只负责马上清掉旧译文，并告诉后台"画面可能变了"
  const onPageChange = () => {
    if (activeRun === null) return;
    if (inFlight) chrome.runtime.sendMessage({ type: "cancel" }).catch(() => {});
    activeRun = null;
    inFlight = false;
    clear();
    chrome.runtime.sendMessage({ type: "cleared" }).catch(() => {});
  };
  window.addEventListener("keydown", (e) => {
    // 带修饰键的多半是快捷键（包括本插件的 Option+T），不算翻页
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== "Shift") onPageChange();
  }, true);
  // 有的阅读器会拦掉 mousedown，所以 pointerdown / touchstart 也听
  for (const type of ["pointerdown", "mousedown", "touchstart"])
    window.addEventListener(type, onPageChange, { capture: true, passive: true });
  window.addEventListener("wheel", onPageChange, { capture: true, passive: true });
  window.addEventListener("resize", onPageChange);
  document.addEventListener("fullscreenchange", onPageChange);
}
