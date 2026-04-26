import type { AppSettings, ChatMessage } from "./types";

const SETTINGS_KEY = "onestreamxf-chat:settings";
const MESSAGES_KEY = "onestreamxf-chat:messages";
const SETTINGS_VERSION = 4;

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  model: "openrouter/free",
  thinkingLevel: "low",
  autoStopSeconds: 120,
  publicWebSearch: true,
  enterToSend: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const settings = { ...DEFAULT_SETTINGS, ...parsed };

    if (parsed.settingsVersion !== SETTINGS_VERSION && parsed.thinkingLevel === "medium") {
      settings.thinkingLevel = DEFAULT_SETTINGS.thinkingLevel;
    }

    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  const persisted: Partial<AppSettings> & { settingsVersion: number } = {
    ...settings,
    settingsVersion: SETTINGS_VERSION,
  };
  if (!persisted.apiKey) {
    delete persisted.apiKey;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
}

export function clearSavedApiKey(): void {
  const settings = loadSettings();
  saveSettings({ ...settings, apiKey: "" });
}

export function loadMessages(): ChatMessage[] {
  try {
    if (shouldClearMessagesFromUrl()) {
      clearSavedMessages();
      return [];
    }

    const raw = localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMessages(messages: ChatMessage[]): void {
  localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages.slice(-30)));
}

export function clearSavedMessages(): void {
  localStorage.removeItem(MESSAGES_KEY);
}

function shouldClearMessagesFromUrl(): boolean {
  const url = new URL(window.location.href);
  const shouldClear = url.searchParams.get("clearChat") === "1" || url.searchParams.get("clearMessages") === "1";
  if (!shouldClear) return false;

  url.searchParams.delete("clearChat");
  url.searchParams.delete("clearMessages");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}
