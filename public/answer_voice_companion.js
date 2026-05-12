const KEY_STORAGE = "pdfCompanionGeminiApiKey";
const MODEL_STORAGE = "codexRagCompanionLiveModel";
const VOICE_STORAGE = "codexRagCompanionVoice";
const DEPTH_STORAGE = "codexRagCompanionAnswerDepth";
const THINKING_STORAGE = "codexRagCompanionThinkingLevel";
const LEGACY_MODEL_STORAGE = ["htmlAnswerCompanionLiveModel", "pdfCompanionLiveModel"];
const LEGACY_VOICE_STORAGE = ["htmlAnswerCompanionVoice", "pdfCompanionVoice"];
const LEGACY_DEPTH_STORAGE = ["htmlAnswerCompanionAnswerDepth", "pdfCompanionAnswerDepth"];
const LEGACY_THINKING_STORAGE = ["htmlAnswerCompanionThinkingLevel", "pdfCompanionThinkingLevel"];

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const DEFAULT_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const DEFAULT_VOICE = "Zephyr";
const STATE_EVENT = "onestreamxf:voice-state";

let genAiModulePromise = null;
let activeContext = {
  id: "",
  question: "",
  answer: "",
  conversation: "",
  skillSummary: "",
  pageTitle: document.title,
};
let geminiKey = readStoredSetting(KEY_STORAGE, [], "");
let isLiveMode = false;
let connectionState = "idle";
let isModelSpeaking = false;
let isUserSpeaking = false;
let isAwaitingModelResponse = false;
let currentInputTranscript = "";
let currentOutputTranscript = "";
let fullTurnInput = "";
let fullTurnOutput = "";
let turnHistory = [];
let sessionPromise = null;
let activeSessionToken = 0;
let contextDebounceTimer = null;
let userSpeechTimer = null;
let outputNoticeTimer = null;
let onDemandStopTimer = null;
let selectionDebounceTimer = null;
let stopAfterPlayback = false;
let audioResources = null;
let voiceOverlay = null;
let voiceStateText = null;
let micStateText = null;
let micLight = null;
let subtitleUser = null;
let subtitleAssistant = null;
let subtitleFocus = null;
let focusShareStatus = "";
let focusPreviewText = "";
let lastStableSelectionText = "";
let lastStableSelectionContext = "";
let isPointerSelecting = false;

function loadGenAI() {
  if (!genAiModulePromise) {
    genAiModulePromise = import("https://esm.sh/@google/genai@1.26.0");
  }
  return genAiModulePromise;
}

function truncateForLog(value, limit = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function appLog(_type, _payload = {}) {
  // Reserved for optional local diagnostics.
}

function appTranscript(_role, _text, _payload = {}) {
  // Reserved for optional local diagnostics.
}

function readStoredSetting(primaryKey, fallbackKeys = [], fallback = "") {
  const primaryValue = window.localStorage.getItem(primaryKey);
  if (primaryValue) return primaryValue;
  for (const key of fallbackKeys) {
    const legacyValue = window.localStorage.getItem(key);
    if (legacyValue) {
      window.localStorage.setItem(primaryKey, legacyValue);
      return legacyValue;
    }
  }
  return fallback;
}

function writeStoredSetting(primaryKey, fallbackKeys = [], value = "") {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) return;
  window.localStorage.setItem(primaryKey, cleanValue);
  for (const key of fallbackKeys) window.localStorage.setItem(key, cleanValue);
}

function currentLiveModel() {
  return readStoredSetting(MODEL_STORAGE, LEGACY_MODEL_STORAGE, DEFAULT_LIVE_MODEL);
}

function currentVoiceName() {
  return readStoredSetting(VOICE_STORAGE, LEGACY_VOICE_STORAGE, DEFAULT_VOICE);
}

function currentAnswerDepth() {
  return readStoredSetting(DEPTH_STORAGE, LEGACY_DEPTH_STORAGE, "balanced");
}

function currentThinkingLevel() {
  return readStoredSetting(THINKING_STORAGE, LEGACY_THINKING_STORAGE, "medium");
}

function refreshGeminiKey() {
  geminiKey = window.localStorage.getItem(KEY_STORAGE) || "";
  return geminiKey;
}

function normalizeContext(context = {}) {
  return {
    id: String(context.id || ""),
    question: String(context.question || ""),
    answer: String(context.answer || ""),
    conversation: String(context.conversation || ""),
    skillSummary: String(context.skillSummary || ""),
    pageTitle: String(context.pageTitle || document.title || "OneStream XF Skill Chat"),
  };
}

function encode(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function decode(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes;
}

function createAudioBlob(data) {
  const int16 = new Int16Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, data[index]));
    int16[index] = sample * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
  };
}

async function decodeAudioData(data, audioContext, sampleRate, channels) {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / channels;
  const buffer = audioContext.createBuffer(channels, frameCount, sampleRate);
  for (let channel = 0; channel < channels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let index = 0; index < frameCount; index += 1) {
      channelData[index] = dataInt16[index * channels + channel] / 32768.0;
    }
  }
  return buffer;
}

function clampText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[Context clipped at ${maxLength} characters.]`;
}

function slidingTranscript(value) {
  const text = String(value || "").trim();
  if (text.length <= 160) return text;
  const slicePoint = text.lastIndexOf(" ", text.length - 80);
  return slicePoint > -1 ? `...${text.slice(slicePoint + 1)}` : `...${text.slice(-160)}`;
}

function nativeSelectedText() {
  return window.getSelection()?.toString().trim() || "";
}

function selectedText() {
  return nativeSelectedText() || lastStableSelectionText;
}

function selectionContextText() {
  const selection = window.getSelection();
  const selected = selection?.toString().trim() || "";
  if (!selected && lastStableSelectionContext) return lastStableSelectionContext;
  if (!selected && lastStableSelectionText) return lastStableSelectionText;
  if (!selected || !selection.rangeCount) return selected;
  const range = selection.getRangeAt(0);
  const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const container = element?.closest?.("[data-answer-message-id], .message, main") || element;
  const sourceText = container?.innerText?.replace(/\s+/g, " ").trim() || "";
  if (!sourceText) return selected;
  const normalizedSelection = selected.replace(/\s+/g, " ").trim();
  const index = sourceText.indexOf(normalizedSelection);
  if (index < 0) return selected;
  const start = Math.max(0, index - 450);
  const end = Math.min(sourceText.length, index + normalizedSelection.length + 450);
  return sourceText.slice(start, end).trim();
}

function activeFocusContext() {
  const selected = nativeSelectedText() || lastStableSelectionText;
  if (!selected) return "";
  const nearby = nativeSelectedText() ? selectionContextText() : lastStableSelectionContext;
  if (!nearby || nearby === selected) return selected;
  return `Selected text:\n${selected}\n\nNearby context:\n${nearby}`;
}

function answerContextText() {
  return [
    `Page: ${activeContext.pageTitle}`,
    `Question that produced this answer:\n${activeContext.question || "Unknown"}`,
    `Assistant answer:\n${activeContext.answer || "No answer text was provided."}`,
    `Recent chat context:\n${activeContext.conversation || "None"}`,
    `Loaded OneStream skill documents:\n${activeContext.skillSummary || "Not provided"}`,
  ].join("\n\n");
}

function conversationText() {
  return turnHistory
    .slice(-8)
    .map((turn) => `User: ${turn.user}\nGemini: ${turn.assistant}`)
    .join("\n\n");
}

function answerDepthInstruction() {
  return ({
    concise: "Be concise: answer directly in a few tight spoken paragraphs.",
    balanced: "Be balanced: explain clearly, include important caveats, and offer to go deeper.",
    deep: "Go deeper: include implementation detail, edge cases, evidence caveats, and a practical checklist.",
  }[currentAnswerDepth()] || "Be balanced and practical.");
}

function thinkingInstruction() {
  return ({
    minimal: "Use a quick pass over the selected text and answer context.",
    low: "Use a quick pass over the selected text and answer context.",
    medium: "Inspect the selected text, answer, and recent chat context before answering.",
    high: "Work carefully through the selected text, answer, and context; reconcile contradictions before answering.",
  }[currentThinkingLevel()] || "Inspect the context before answering.");
}

function buildContextText() {
  return [
    `[EXPLICIT_SELECTION priority=highest freshness=current]\n${activeFocusContext() || "None"}\n[/EXPLICIT_SELECTION]`,
    `[ANSWER_BUBBLE_CONTEXT priority=high freshness=current_chat_answer]\n${clampText(answerContextText(), 65000)}\n[/ANSWER_BUBBLE_CONTEXT]`,
    `[VOICE_CONVERSATION priority=medium freshness=past]\n${conversationText() || "None"}\n[/VOICE_CONVERSATION]`,
  ].join("\n\n");
}

function buildSystemInstruction() {
  return `You are Gemini Live beside a OneStream XF chat answer.

The user is reading one specific assistant answer and talking to you by voice. Use the selected text and answer bubble context as your main evidence.

Context source priority:
1. EXPLICIT_SELECTION: selected text in the answer or nearby passage.
2. ANSWER_BUBBLE_CONTEXT: the answer, the question that produced it, recent chat, and loaded skill docs.
3. VOICE_CONVERSATION: continuity only.
4. General knowledge: use only when the answer context is insufficient or the user asks beyond it.

Rules:
- When the user says "this", "that", "here", or "this answer", start from EXPLICIT_SELECTION, then the current answer.
- If the answer context does not support something, say that and suggest what to verify in OneStream.
- Do not invent OneStream API names, Business Rule signatures, dashboard object names, or UI labels.
- Speak naturally and do not lecture unless the user asks for depth.
- ${answerDepthInstruction()}
- ${thinkingInstruction()}

Context:
${buildContextText()}`;
}

function voiceState() {
  if (connectionState === "error") return "error";
  if (connectionState === "connecting") return "connecting";
  if (isModelSpeaking) return "speaking";
  if (isAwaitingModelResponse) return "thinking";
  if (isUserSpeaking) return "listening";
  if (connectionState === "connected") return "connected";
  return "idle";
}

function currentState() {
  return {
    activeMessageId: activeContext.id,
    connectionState,
    mode: isLiveMode ? "live" : "on-demand",
    voiceState: voiceState(),
    isModelSpeaking,
    isUserSpeaking,
    isAwaitingModelResponse,
    hasGeminiKey: Boolean(refreshGeminiKey().trim()),
    focusPreview: truncateForLog(focusPreviewText || activeFocusContext(), 160),
  };
}

function forceDispatchState() {
  window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: currentState() }));
}

function dispatchState() {
  if (nativeSelectedText()) return;
  forceDispatchState();
}

function ensureVoiceOverlay() {
  if (voiceOverlay) return;
  if (!document.getElementById("answer-voice-overlay-style")) {
    const style = document.createElement("style");
    style.id = "answer-voice-overlay-style";
    style.textContent = `
      .answer-voice-overlay {
        position: fixed;
        left: 50%;
        bottom: 92px;
        z-index: 2147483000;
        display: grid;
        gap: 9px;
        width: min(780px, calc(100vw - 28px));
        transform: translateX(-50%);
        pointer-events: none;
        color: #fff;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .answer-voice-overlay-row {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .answer-voice-pill,
      .answer-voice-subtitle,
      .answer-voice-focus-pill {
        border: 1px solid rgba(255,255,255,.18);
        background: rgba(10, 18, 28, .62);
        box-shadow: 0 14px 42px rgba(0,0,0,.22);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
      }
      .answer-voice-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        border-radius: 999px;
        padding: 6px 11px;
        font-size: 12px;
        font-weight: 850;
      }
      .answer-voice-light {
        width: 9px;
        height: 9px;
        border-radius: 999px;
        background: #94a3b8;
        box-shadow: 0 0 0 4px rgba(148,163,184,.15);
      }
      .answer-voice-overlay[data-voice-state="connected"] .answer-voice-light,
      .answer-voice-overlay[data-voice-state="listening"] .answer-voice-light {
        background: #22c55e;
        box-shadow: 0 0 0 4px rgba(34,197,94,.2);
      }
      .answer-voice-overlay[data-voice-state="speaking"] .answer-voice-light {
        background: #38bdf8;
        box-shadow: 0 0 0 4px rgba(56,189,248,.2);
      }
      .answer-voice-overlay[data-voice-state="thinking"] .answer-voice-light,
      .answer-voice-overlay[data-voice-state="connecting"] .answer-voice-light {
        background: #f59e0b;
        box-shadow: 0 0 0 4px rgba(245,158,11,.2);
      }
      .answer-voice-overlay[data-voice-state="error"] .answer-voice-light {
        background: #ef4444;
        box-shadow: 0 0 0 4px rgba(239,68,68,.2);
      }
      .answer-voice-subtitle {
        border-radius: 14px;
        padding: 10px 14px;
        font-size: clamp(15px, 2vw, 20px);
        font-weight: 750;
        line-height: 1.35;
        text-align: center;
        text-wrap: balance;
      }
      .answer-voice-subtitle.user {
        justify-self: start;
        max-width: 86%;
      }
      .answer-voice-subtitle.assistant {
        justify-self: end;
        max-width: 90%;
        background: rgba(16, 58, 67, .68);
      }
      .answer-voice-focus-pill {
        max-width: min(640px, calc(100vw - 38px));
        overflow: hidden;
        border-radius: 999px;
        padding: 6px 11px;
        color: rgba(255,255,255,.9);
        font-size: 12px;
        font-weight: 750;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      @media (max-width: 760px) {
        .answer-voice-overlay { bottom: 88px; }
        .answer-voice-subtitle.user,
        .answer-voice-subtitle.assistant { justify-self: center; max-width: 100%; }
      }
    `;
    document.head.appendChild(style);
  }

  voiceOverlay = document.createElement("div");
  voiceOverlay.className = "answer-voice-overlay";
  voiceOverlay.hidden = true;
  voiceOverlay.innerHTML = `
    <div class="answer-voice-overlay-row">
      <span class="answer-voice-pill"><span class="answer-voice-light" aria-hidden="true"></span><span id="answer-voice-mic-state">Mic off</span></span>
      <span class="answer-voice-pill" id="answer-voice-state">Voice idle</span>
      <span class="answer-voice-focus-pill" id="answer-voice-focus" hidden></span>
    </div>
    <div class="answer-voice-subtitle user" id="answer-voice-subtitle-user" hidden></div>
    <div class="answer-voice-subtitle assistant" id="answer-voice-subtitle-assistant" hidden></div>
  `;
  document.body.appendChild(voiceOverlay);
  voiceStateText = document.getElementById("answer-voice-state");
  micStateText = document.getElementById("answer-voice-mic-state");
  micLight = voiceOverlay.querySelector(".answer-voice-light");
  subtitleUser = document.getElementById("answer-voice-subtitle-user");
  subtitleAssistant = document.getElementById("answer-voice-subtitle-assistant");
  subtitleFocus = document.getElementById("answer-voice-focus");
}

function updateVoiceOverlay() {
  ensureVoiceOverlay();
  const state = voiceState();
  voiceOverlay.dataset.voiceState = state;
  const micCopy = connectionState === "connected"
    ? (isUserSpeaking ? "Mic listening" : "Mic on")
    : connectionState === "connecting"
      ? "Mic starting"
      : "Mic off";
  const stateCopy = ({
    connected: isLiveMode ? "Live, ready" : "On demand, ready",
    connecting: "Connecting",
    listening: "Listening",
    speaking: "Gemini speaking",
    thinking: "Gemini is thinking",
    error: "Voice error",
    idle: "Voice idle",
  }[state] || "Voice idle");
  micStateText.textContent = micCopy;
  voiceStateText.textContent = stateCopy;
  if (micLight) micLight.title = micCopy;

  const userText = currentInputTranscript || (connectionState === "connected" && isUserSpeaking ? "Listening..." : "");
  const assistantText = currentOutputTranscript || (isAwaitingModelResponse ? "Gemini is thinking..." : "");
  subtitleUser.hidden = !userText;
  subtitleUser.textContent = userText;
  subtitleAssistant.hidden = !assistantText;
  subtitleAssistant.textContent = assistantText;

  const focus = focusPreviewText || selectedText();
  const showFocus = Boolean(focus && activeContext.id && !["idle", "disconnected"].includes(connectionState));
  const showOverlay = Boolean(userText || assistantText || showFocus || !["idle", "disconnected"].includes(connectionState));
  voiceOverlay.hidden = !showOverlay;
  subtitleFocus.hidden = !showFocus;
  subtitleFocus.textContent = showFocus
    ? `${focusShareStatus === "shared" ? "Focus shared" : focusShareStatus === "sharing" ? "Focus syncing" : "Focus ready"}: ${truncateForLog(focus, 120)}`
    : "";
}

function updateLiveUi() {
  updateVoiceOverlay();
  dispatchState();
}

function setConnectionState(nextState) {
  connectionState = nextState;
  appLog("app.voice.connection_state", {
    state: nextState,
    activeMessageId: activeContext.id,
    mode: isLiveMode ? "live" : "on-demand",
    model: currentLiveModel(),
    voice: currentVoiceName(),
  });
  updateLiveUi();
}

function setLiveNotice(text, isError = false) {
  currentOutputTranscript = text;
  if (isError) connectionState = "error";
  updateLiveUi();
}

function addConversationTurn(user, assistant) {
  turnHistory.push({ user, assistant });
  if (turnHistory.length > 12) turnHistory = turnHistory.slice(-12);
  appLog("app.voice.turn_complete", {
    activeMessageId: activeContext.id,
    userTranscript: truncateForLog(user, 1600),
    assistantTranscript: truncateForLog(assistant, 1600),
    turnCount: turnHistory.length,
  });
  appTranscript("user", user, { surface: "answer-voice", activeMessageId: activeContext.id });
  appTranscript("assistant", assistant, { surface: "answer-voice", activeMessageId: activeContext.id });
}

function markUserSpeechActivity(inputData) {
  let sumSquares = 0;
  for (let index = 0; index < inputData.length; index += 1) {
    sumSquares += inputData[index] * inputData[index];
  }
  const rms = Math.sqrt(sumSquares / inputData.length);
  if (rms < 0.015) return;
  isUserSpeaking = true;
  if (focusShareStatus === "ready" && activeFocusContext()) {
    shareLiveContextImmediately();
  }
  if (userSpeechTimer) clearTimeout(userSpeechTimer);
  userSpeechTimer = window.setTimeout(() => {
    isUserSpeaking = false;
    updateLiveUi();
  }, 650);
  updateLiveUi();
}

function stopBufferedModelAudio() {
  if (audioResources) {
    const { sources, outputAudioContext } = audioResources;
    for (const source of Array.from(sources)) {
      try {
        source.stop();
      } catch (_error) {
        // Source may already be stopped.
      }
      sources.delete(source);
    }
    audioResources.nextStartTime = outputAudioContext.currentTime;
  }
  isModelSpeaking = false;
  updateLiveUi();
}

function cleanupAudio() {
  if (userSpeechTimer) {
    clearTimeout(userSpeechTimer);
    userSpeechTimer = null;
  }
  if (outputNoticeTimer) {
    clearTimeout(outputNoticeTimer);
    outputNoticeTimer = null;
  }
  if (onDemandStopTimer) {
    clearTimeout(onDemandStopTimer);
    onDemandStopTimer = null;
  }
  stopAfterPlayback = false;
  if (!audioResources) {
    isModelSpeaking = false;
    isUserSpeaking = false;
    isAwaitingModelResponse = false;
    updateLiveUi();
    return;
  }
  const { stream, inputAudioContext, outputAudioContext, scriptProcessor, sources } = audioResources;
  stream.getTracks().forEach((track) => track.stop());
  scriptProcessor.disconnect();
  for (const source of Array.from(sources)) {
    try {
      source.stop();
    } catch (_error) {
      // Source may already be stopped.
    }
  }
  sources.clear();
  if (inputAudioContext.state !== "closed") inputAudioContext.close();
  if (outputAudioContext.state !== "closed") outputAudioContext.close();
  audioResources = null;
  isModelSpeaking = false;
  isUserSpeaking = false;
  isAwaitingModelResponse = false;
  updateLiveUi();
}

async function stopLiveSession() {
  const promise = sessionPromise;
  activeSessionToken += 1;
  sessionPromise = null;
  if (promise) {
    try {
      const session = await promise;
      session.close();
    } catch (_error) {
      // Ignore close errors.
    }
  }
  cleanupAudio();
  currentInputTranscript = "";
  currentOutputTranscript = "";
  setConnectionState("idle");
}

function interruptLiveSession() {
  stopBufferedModelAudio();
  isAwaitingModelResponse = false;
  setLiveNotice("Interrupted Gemini audio. You can continue speaking.");
}

function requestOnDemandStopAfterPlayback(sessionToken, delay = 1400) {
  if (isLiveMode || activeSessionToken !== sessionToken) return;
  stopAfterPlayback = true;
  if (onDemandStopTimer) clearTimeout(onDemandStopTimer);
  onDemandStopTimer = window.setTimeout(() => {
    onDemandStopTimer = null;
    if (isLiveMode || activeSessionToken !== sessionToken) {
      stopAfterPlayback = false;
      return;
    }
    if (audioResources?.sources?.size || isModelSpeaking) {
      requestOnDemandStopAfterPlayback(sessionToken, 350);
      return;
    }
    stopAfterPlayback = false;
    stopLiveSession();
  }, delay);
}

async function startLiveSession() {
  refreshGeminiKey();
  if (!geminiKey.trim()) {
    appLog("app.voice.start_blocked", {
      reason: "missing_gemini_key",
      activeMessageId: activeContext.id,
    });
    setLiveNotice("Add a Gemini API key in Settings before starting voice.", true);
    return;
  }

  await stopLiveSession();
  const sessionToken = activeSessionToken + 1;
  activeSessionToken = sessionToken;
  fullTurnInput = "";
  fullTurnOutput = "";
  currentInputTranscript = "";
  currentOutputTranscript = "";
  isAwaitingModelResponse = false;
  stopAfterPlayback = false;
  if (onDemandStopTimer) {
    clearTimeout(onDemandStopTimer);
    onDemandStopTimer = null;
  }
  focusPreviewText = selectedText();
  focusShareStatus = focusPreviewText ? "ready" : "";
  setConnectionState("connecting");
  appLog("app.voice.session_start_requested", {
    ...currentState(),
    contextPreview: truncateForLog(answerContextText(), 1600),
    selectedTextPreview: truncateForLog(selectedText(), 1200),
  });
  currentOutputTranscript = "Connecting to Gemini Live...";
  updateLiveUi();

  const isActiveSession = () => activeSessionToken === sessionToken;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (!isActiveSession()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const {
      ActivityHandling,
      EndSensitivity,
      GoogleGenAI,
      Modality,
      StartSensitivity,
    } = await loadGenAI();
    const ai = new GoogleGenAI({ apiKey: geminiKey.trim() });
    const model = currentLiveModel();
    const voiceName = currentVoiceName();
    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          prefixPaddingMs: 80,
          silenceDurationMs: 650,
        },
        activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      systemInstruction: buildSystemInstruction(),
    };
    if (model.startsWith("gemini-3.1")) {
      liveConfig.thinkingConfig = {
        thinkingLevel: currentThinkingLevel(),
      };
    }

    sessionPromise = ai.live.connect({
      model,
      config: liveConfig,
      callbacks: {
        onopen: async () => {
          if (!isActiveSession()) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          currentOutputTranscript = "";
          setConnectionState("connected");
          appLog("app.voice.session_open", {
            activeMessageId: activeContext.id,
            mode: isLiveMode ? "live" : "on-demand",
            model,
            voice: voiceName,
          });

          const inputAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
          const outputAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
          await inputAudioContext.resume().catch(() => {});
          await outputAudioContext.resume().catch(() => {});

          const sources = new Set();
          const source = inputAudioContext.createMediaStreamSource(stream);
          const scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
          scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
            if (!isActiveSession()) return;
            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
            markUserSpeechActivity(inputData);
            const pcmBlob = createAudioBlob(inputData);
            sessionPromise?.then((session) => {
              if (isActiveSession()) session.sendRealtimeInput({ audio: pcmBlob });
            }).catch((error) => {
              if (isActiveSession()) console.error("Failed to send realtime audio:", error);
            });
          };
          source.connect(scriptProcessor);
          scriptProcessor.connect(inputAudioContext.destination);
          audioResources = { stream, inputAudioContext, outputAudioContext, scriptProcessor, sources, nextStartTime: 0 };
          updateLiveUi();
        },
        onmessage: async (message) => {
          if (!isActiveSession()) return;
          await handleLiveMessage(message, isActiveSession, sessionToken);
        },
        onerror: (error) => {
          if (!isActiveSession()) return;
          console.error("Gemini Live session error:", error);
          sessionPromise = null;
          cleanupAudio();
          setConnectionState("error");
          appLog("app.voice.session_error", {
            activeMessageId: activeContext.id,
            message: truncateForLog(error.message || String(error), 1000),
          });
          setLiveNotice(error.message || "Gemini Live session error.", true);
        },
        onclose: () => {
          if (!isActiveSession()) return;
          sessionPromise = null;
          cleanupAudio();
          setConnectionState("disconnected");
          appLog("app.voice.session_closed", {
            activeMessageId: activeContext.id,
            mode: isLiveMode ? "live" : "on-demand",
          });
        },
      },
    });
  } catch (error) {
    if (!isActiveSession()) return;
    console.error("Failed to start Gemini Live:", error);
    sessionPromise = null;
    cleanupAudio();
    setConnectionState("error");
    appLog("app.voice.session_error", {
      activeMessageId: activeContext.id,
      message: truncateForLog(error.message || String(error), 1000),
    });
    setLiveNotice(error.message || "Failed to start Gemini Live.", true);
  }
}

async function handleLiveMessage(message, isActiveSession, sessionToken) {
  if (message.serverContent?.outputTranscription?.text) {
    const text = message.serverContent.outputTranscription.text.trim();
    if (text) {
      fullTurnOutput += `${fullTurnOutput ? " " : ""}${text}`;
      currentOutputTranscript = slidingTranscript(fullTurnOutput);
      isAwaitingModelResponse = false;
      updateLiveUi();
    }
  }

  const playAudioPart = async (base64Audio) => {
    isAwaitingModelResponse = false;
    if (!isModelSpeaking) isModelSpeaking = true;
    currentOutputTranscript = slidingTranscript(fullTurnOutput);
    updateLiveUi();

    if (!audioResources) return;
    const { outputAudioContext, sources } = audioResources;
    audioResources.nextStartTime = Math.max(audioResources.nextStartTime, outputAudioContext.currentTime);
    const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, OUTPUT_SAMPLE_RATE, 1);
    const sourceNode = outputAudioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(outputAudioContext.destination);
    sourceNode.addEventListener("ended", () => {
      sources.delete(sourceNode);
      if (isActiveSession() && sources.size === 0) {
        isModelSpeaking = false;
        updateLiveUi();
        if (stopAfterPlayback && !isLiveMode) {
          requestOnDemandStopAfterPlayback(sessionToken, 250);
        }
      }
    });
    sourceNode.start(audioResources.nextStartTime);
    audioResources.nextStartTime += audioBuffer.duration;
    sources.add(sourceNode);
  };

  const modelParts = message.serverContent?.modelTurn?.parts || [];
  for (const part of modelParts) {
    if (part.text) {
      fullTurnOutput += `${fullTurnOutput ? " " : ""}${part.text.trim()}`;
      currentOutputTranscript = slidingTranscript(fullTurnOutput);
    }
    if (part.inlineData?.data) await playAudioPart(part.inlineData.data);
  }

  if (modelParts.length === 0 && message.data) await playAudioPart(message.data);

  if (message.serverContent?.inputTranscription?.text) {
    fullTurnInput += message.serverContent.inputTranscription.text;
    currentInputTranscript = slidingTranscript(fullTurnInput);
    isAwaitingModelResponse = true;
    updateLiveUi();
  }

  if (message.serverContent?.interrupted) interruptLiveSession();

  if (message.serverContent?.turnComplete) {
    isAwaitingModelResponse = false;
    currentInputTranscript = slidingTranscript(fullTurnInput.trim());
    currentOutputTranscript = slidingTranscript(fullTurnOutput.trim());
    const finalInput = fullTurnInput.trim();
    const finalOutput = fullTurnOutput.trim();

    if (finalInput && finalOutput) {
      addConversationTurn(finalInput, finalOutput);
    } else if (finalInput && !finalOutput) {
      currentOutputTranscript = "Gemini heard that, but did not return an answer. Please try once more.";
      if (outputNoticeTimer) clearTimeout(outputNoticeTimer);
      outputNoticeTimer = window.setTimeout(() => {
        currentOutputTranscript = "";
        updateLiveUi();
      }, 3500);
    }

    fullTurnInput = "";
    fullTurnOutput = "";
    updateLiveUi();

    if (!isLiveMode) requestOnDemandStopAfterPlayback(sessionToken);
  }
}

async function sendLiveContextUpdate() {
  if (!sessionPromise || connectionState !== "connected") return;
  focusShareStatus = activeFocusContext() || focusPreviewText ? "sharing" : focusShareStatus;
  updateVoiceOverlay();
  try {
    const session = await sessionPromise;
    session.sendClientContent({
      turns: [{
        role: "user",
        parts: [{
          text: `[LIVE_ATTENTION_UPDATE]\nThis is a silent update of the user's current selected text and answer focus. Do not answer yet. Use it only to ground the next spoken question.\n\n${buildContextText()}\n[/LIVE_ATTENTION_UPDATE]`,
        }],
      }],
      turnComplete: false,
    });
    const sharedFocus = selectedText() || focusPreviewText;
    appLog("app.voice.context_shared", {
      activeMessageId: activeContext.id,
      focusPreview: truncateForLog(sharedFocus, 900),
      selectedTextPreview: truncateForLog(selectedText(), 900),
      connectionState,
    });
    focusShareStatus = sharedFocus ? "shared" : "";
    focusPreviewText = sharedFocus;
    updateLiveUi();
  } catch (error) {
    console.error("Failed to send live context update:", error);
    appLog("app.voice.context_share_error", {
      activeMessageId: activeContext.id,
      message: truncateForLog(error.message || String(error), 900),
    });
    setLiveNotice("Could not send the focus update to Gemini Live.", true);
  }
}

function scheduleLiveContextUpdate(delay = 200) {
  if (!sessionPromise || connectionState !== "connected") return;
  if (activeFocusContext() || focusPreviewText) {
    focusShareStatus = "sharing";
    updateVoiceOverlay();
  }
  if (contextDebounceTimer) clearTimeout(contextDebounceTimer);
  contextDebounceTimer = window.setTimeout(() => {
    contextDebounceTimer = null;
    if (!isModelSpeaking && !isAwaitingModelResponse) {
      sendLiveContextUpdate();
    } else {
      scheduleLiveContextUpdate(250);
    }
  }, delay);
}

function shareLiveContextImmediately() {
  if (!sessionPromise || connectionState !== "connected") return;
  if (contextDebounceTimer) {
    clearTimeout(contextDebounceTimer);
    contextDebounceTimer = null;
  }
  sendLiveContextUpdate();
}

function handleSelectionChanged() {
  if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
  selectionDebounceTimer = window.setTimeout(() => {
    const selected = nativeSelectedText();
    if (!selected) return;
    lastStableSelectionText = selected;
    lastStableSelectionContext = selectionContextText();
    if (activeContext.id) {
      appLog("app.selection.changed", {
        source: "answer_voice_selection",
        activeMessageId: activeContext.id,
        text: truncateForLog(selected, 1200),
      });
    }
    focusShareStatus = sessionPromise && connectionState === "connected" ? "ready" : "";
    focusPreviewText = selected;
    updateVoiceOverlay();
    if (isPointerSelecting) {
      scheduleLiveContextUpdate(300);
    } else {
      shareLiveContextImmediately();
    }
  }, isPointerSelecting ? 120 : 450);
}

async function start(context = {}, mode = "on-demand") {
  activeContext = normalizeContext(context);
  isLiveMode = mode === "live";
  focusPreviewText = selectedText();
  focusShareStatus = focusPreviewText ? "ready" : "";
  appLog("app.voice.answer_control_start", {
    activeMessageId: activeContext.id,
    mode: isLiveMode ? "live" : "on-demand",
    questionPreview: truncateForLog(activeContext.question, 900),
    answerPreview: truncateForLog(activeContext.answer, 1200),
    selectedTextPreview: truncateForLog(focusPreviewText, 1200),
  });
  await startLiveSession();
}

async function setContext(context = {}) {
  activeContext = normalizeContext(context);
  focusPreviewText = selectedText();
  focusShareStatus = sessionPromise && connectionState === "connected" ? "ready" : "";
  updateLiveUi();
  scheduleLiveContextUpdate();
}

function getState() {
  return currentState();
}

function saveSettings(settings = {}) {
  if (settings.apiKey) window.localStorage.setItem(KEY_STORAGE, String(settings.apiKey).trim());
  if (settings.model) writeStoredSetting(MODEL_STORAGE, LEGACY_MODEL_STORAGE, settings.model);
  if (settings.voice) writeStoredSetting(VOICE_STORAGE, LEGACY_VOICE_STORAGE, settings.voice);
  if (settings.answerDepth) writeStoredSetting(DEPTH_STORAGE, LEGACY_DEPTH_STORAGE, settings.answerDepth);
  if (settings.thinkingLevel) writeStoredSetting(THINKING_STORAGE, LEGACY_THINKING_STORAGE, settings.thinkingLevel);
  refreshGeminiKey();
  appLog("app.voice.settings_saved", {
    hasGeminiKey: Boolean(geminiKey),
    model: currentLiveModel(),
    voice: currentVoiceName(),
    answerDepth: currentAnswerDepth(),
    thinkingLevel: currentThinkingLevel(),
  });
  updateLiveUi();
}

function readSettings() {
  return {
    hasKey: Boolean(refreshGeminiKey().trim()),
    model: currentLiveModel(),
    voice: currentVoiceName(),
    answerDepth: currentAnswerDepth(),
    thinkingLevel: currentThinkingLevel(),
  };
}

async function clearKey() {
  await stopLiveSession();
  window.localStorage.removeItem(KEY_STORAGE);
  refreshGeminiKey();
  appLog("app.voice.key_cleared", { hasGeminiKey: false });
  updateLiveUi();
}

async function reset() {
  await stopLiveSession();
  if (contextDebounceTimer) {
    clearTimeout(contextDebounceTimer);
    contextDebounceTimer = null;
  }
  if (selectionDebounceTimer) {
    clearTimeout(selectionDebounceTimer);
    selectionDebounceTimer = null;
  }
  activeContext = normalizeContext({});
  isLiveMode = false;
  currentInputTranscript = "";
  currentOutputTranscript = "";
  fullTurnInput = "";
  fullTurnOutput = "";
  turnHistory = [];
  focusShareStatus = "";
  focusPreviewText = "";
  lastStableSelectionText = "";
  lastStableSelectionContext = "";
  window.getSelection()?.removeAllRanges?.();
  appLog("app.voice.reset", {});
  updateVoiceOverlay();
  forceDispatchState();
}

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  isPointerSelecting = true;
});
document.addEventListener("pointerup", () => {
  window.setTimeout(() => {
    isPointerSelecting = false;
    const selected = nativeSelectedText();
    if (!selected) return;
    lastStableSelectionText = selected;
    lastStableSelectionContext = selectionContextText();
    focusPreviewText = selected;
    focusShareStatus = sessionPromise && connectionState === "connected" ? "ready" : "";
    updateVoiceOverlay();
    shareLiveContextImmediately();
  }, 80);
});
document.addEventListener("selectionchange", handleSelectionChanged);
window.addEventListener("storage", (event) => {
  const watchedKeys = new Set([
    KEY_STORAGE,
    MODEL_STORAGE,
    VOICE_STORAGE,
    DEPTH_STORAGE,
    THINKING_STORAGE,
    ...LEGACY_MODEL_STORAGE,
    ...LEGACY_VOICE_STORAGE,
    ...LEGACY_DEPTH_STORAGE,
    ...LEGACY_THINKING_STORAGE,
  ]);
  if (!watchedKeys.has(event.key)) return;
  refreshGeminiKey();
  updateLiveUi();
});

window.OneStreamAnswerVoice = {
  start,
  stop: stopLiveSession,
  reset,
  interrupt: interruptLiveSession,
  setContext,
  getState,
  saveSettings,
  readSettings,
  clearKey,
  isAvailable: () => true,
};

ensureVoiceOverlay();
dispatchState();
