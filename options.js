import { LANGUAGES } from "./gemini.js";
import { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL } from "./claude.js";
import { PROVIDERS } from "./compat.js";
import { t, isZh } from "./i18n.js";

// 设置页里有自己一栏的兼容接口服务商，key 和模型存成 qwenKey / qwenModel 这样
const COMPAT_IDS = ["qwen"];

const $ = (id) => document.getElementById(id);

function status(text, isError) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function showProvider() {
  const provider = $("provider").value;
  $("claudeBox").hidden = provider !== "claude";
  for (const id of COMPAT_IDS) $(`${id}Box`).hidden = provider !== id;
}

// ---------- 页面 ----------

async function init() {
  document.documentElement.lang = isZh ? "zh" : "en";
  document.title = t("title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const [code, name] of Object.entries(LANGUAGES)) $("lang").appendChild(new Option(name, code));
  const {
    provider = "qwen",
    claudeKey = "",
    claudeModel = CLAUDE_DEFAULT_MODEL,
    lang = "zh-Hans",
    autoTranslate = true,
    boxMode = "tight",
    fontSize = "medium",
  } = await chrome.storage.local.get(["boxMode", "fontSize", "provider", "claudeKey", "claudeModel", "lang", "autoTranslate"]);
  // 以前存的服务商（比如 Gemini）已经不在列表里了，就显示默认的
  $("provider").value = provider;
  if (!$("provider").value) $("provider").value = "qwen";
  $("claudeKey").value = claudeKey;
  for (const m of CLAUDE_MODELS) $("claudeModel").appendChild(new Option(t(m.label), m.name));
  $("claudeModel").value = CLAUDE_MODELS.some((m) => m.name === claudeModel) ? claudeModel : CLAUDE_DEFAULT_MODEL;
  const compatSaved = await chrome.storage.local.get(COMPAT_IDS.flatMap((id) => [`${id}Key`, `${id}Model`, `${id}Base`]));
  for (const id of COMPAT_IDS) {
    $(`${id}Key`).value = compatSaved[`${id}Key`] || "";
    $(`${id}Base`).value = compatSaved[`${id}Base`] || "";
    for (const m of PROVIDERS[id].models) $(`${id}Model`).appendChild(new Option(m.label, m.name));
    $(`${id}Model`).value = compatSaved[`${id}Model`] || PROVIDERS[id].models[0].name;
  }
  $("lang").value = lang;
  $("autoTranslate").checked = autoTranslate;
  $("boxMode").value = boxMode;
  $("fontSize").value = fontSize;
  showProvider();
}

$("provider").addEventListener("change", () => {
  showProvider();
  status("");
});
$("save").addEventListener("click", async () => {
  const claudeKey = $("claudeKey").value.trim();
  await chrome.storage.local.set({
    provider: $("provider").value,
    claudeKey,
    claudeModel: $("claudeModel").value,
    ...Object.fromEntries(
      COMPAT_IDS.flatMap((id) => [
        [`${id}Key`, $(`${id}Key`).value.trim()],
        [`${id}Model`, $(`${id}Model`).value],
        [`${id}Base`, $(`${id}Base`).value.trim()],
      ])
    ),
    lang: $("lang").value,
    autoTranslate: $("autoTranslate").checked,
    boxMode: $("boxMode").value,
    fontSize: $("fontSize").value,
  });
  status(t("saved"));
});

init();
