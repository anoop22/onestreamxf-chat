import type { AppSettings, ChatMessage } from "./types";

const SETTINGS_KEY = "onestreamxf-chat:settings";
const MESSAGES_KEY = "onestreamxf-chat:messages";

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  model: "openrouter/free",
  thinkingLevel: "medium",
  enterToSend: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  const persisted: Partial<AppSettings> = { ...settings };
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
