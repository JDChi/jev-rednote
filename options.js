const form = document.querySelector("#settings");
const apiKey = document.querySelector("#api-key");
const enabled = document.querySelector("#enabled");
const save = form.querySelector("button");
const feedback = document.querySelector("#feedback");

function setFeedback(message, error = false) {
  feedback.toggleAttribute("data-error", error);
  feedback.textContent = message;
}

async function loadSettings() {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const { settings = {} } = await chrome.storage.local.get("settings");
    apiKey.value = settings.apiKey ?? "";
    enabled.checked = settings.enabled === true;
    apiKey.disabled = enabled.disabled = save.disabled = false;
  } catch {
    setFeedback("无法读取扩展设置。请刷新页面重试。", true);
  }
}

form.addEventListener("input", () => {
  apiKey.removeAttribute("aria-invalid");
  setFeedback("");
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const settings = { apiKey: apiKey.value.trim(), enabled: enabled.checked };
  if (settings.enabled && !settings.apiKey) {
    apiKey.setAttribute("aria-invalid", "true");
    setFeedback("请输入 TypeSafe API Key 后再开启。", true);
    apiKey.focus();
    return;
  }
  save.disabled = true;
  try {
    await chrome.storage.local.set({ settings });
    setFeedback(settings.enabled ? "已保存，自动分析已开启。" : "已保存，自动分析已关闭。");
  } catch {
    setFeedback("保存失败，请重试。", true);
  } finally {
    save.disabled = false;
  }
});

void loadSettings();
