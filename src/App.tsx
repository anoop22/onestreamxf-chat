import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import {
  Bot,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  KeyRound,
  Loader2,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createOneStreamAgent } from "./agent";
import { loadOneStreamSkill } from "./skillLoader";
import { renderMarkdown } from "./markdown";
import {
  clearSavedApiKey,
  clearSavedMessages,
  DEFAULT_SETTINGS,
  loadMessages,
  loadSettings,
  saveMessages,
  saveSettings,
} from "./storage";
import type { ActivityItem, AppSettings, ChatMessage, SkillDoc, SkillState } from "./types";

const SAMPLE_PROMPTS = [
  "How do I pass Dashboard parameters into a Dashboard Data Set Business Rule that uses FdxExecuteCubeView?",
  "When should I use DataBuffer logic instead of looping through DataCells in a Finance Business Rule?",
  "Why does a Cube View return different data in a dashboard than when I run it directly?",
];

const MAX_REASONING_CHARS = 1400;

export function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages());
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [skillState, setSkillState] = useState<SkillState>({
    status: "loading",
    docs: [],
    message: "Loading OneStream XF skill from GitHub...",
  });
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(!loadSettings().apiKey);
  const [activityOpen, setActivityOpen] = useState(true);

  const agentRef = useRef<Agent | null>(null);
  const agentKeyRef = useRef("");
  const activeReasoningIdRef = useRef<string | null>(null);
  const activeReasoningTextRef = useRef("");
  const assistantTextSeenRef = useRef(new Set<string>());

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveMessages(messages.filter((message) => message.content.trim().length > 0));
  }, [messages]);

  useEffect(() => {
    const controller = new AbortController();
    setSkillState({ status: "loading", docs: [], message: "Loading OneStream XF skill from GitHub..." });
    loadOneStreamSkill(controller.signal)
      .then((docs) => {
        setSkillState({
          status: "ready",
          docs,
          message: `Loaded ${docs.length} public skill documents from anoop22/onestreamxf-skill.`,
        });
        addActivity("skill", "OneStream skill loaded", `${docs.length} Markdown documents are available to the agent.`);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setSkillState({ status: "error", docs: [], message });
        addActivity("error", "Skill load failed", message);
      });

    return () => controller.abort();
  }, []);

  const canAsk = skillState.status === "ready" && settings.apiKey.trim().length > 0 && !isRunning;

  const skillDocs = skillState.docs;
  const docsByPath = useMemo(() => new Map(skillDocs.map((doc) => [doc.path, doc])), [skillDocs]);

  async function handleSubmit(event?: FormEvent | KeyboardEvent<HTMLTextAreaElement>, forcedPrompt?: string) {
    event?.preventDefault();
    const question = (forcedPrompt ?? input).trim();
    if (!question || isRunning) return;

    if (!settings.apiKey.trim()) {
      setSettingsOpen(true);
      addActivity("error", "OpenRouter key needed", "Enter an OpenRouter API key. It stays in this browser and is sent only to OpenRouter.");
      return;
    }

    if (skillState.status !== "ready") {
      addActivity("error", "Skill not ready", skillState.message);
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      createdAt: Date.now(),
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };

    const history = messages;
    activeReasoningIdRef.current = null;
    activeReasoningTextRef.current = "";
    assistantTextSeenRef.current.delete(assistantId);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");
    setIsRunning(true);
    addActivity("thinking", "Thinking with OneStream skill", "Preparing to search the loaded skill before answering.");

    const agent = getAgent(history);
    const unsubscribe = agent.subscribe((agentEvent) => handleAgentEvent(agentEvent, assistantId));

    try {
      await agent.prompt(question);
      await agent.waitForIdle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addActivity("error", "Agent run failed", message);
      appendAssistantText(assistantId, `\n\nError: ${message}`);
    } finally {
      unsubscribe();
      setIsRunning(false);
    }
  }

  function getAgent(history: ChatMessage[]): Agent {
    const docsSignature = skillDocs.map((doc) => `${doc.path}:${doc.content.length}`).join("|");
    const key = `${settings.model}:${settings.thinkingLevel}:${settings.apiKey.slice(-8)}:${docsSignature}`;
    if (!agentRef.current || agentKeyRef.current !== key) {
      agentRef.current = createOneStreamAgent(settings, skillDocs);
      agentRef.current.state.messages = toAgentMessages(history);
      agentKeyRef.current = key;
    }
    return agentRef.current;
  }

  function handleAgentEvent(event: AgentEvent, assistantId: string) {
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "text_delta") {
        assistantTextSeenRef.current.add(assistantId);
        appendAssistantText(assistantId, assistantEvent.delta);
      }
      if (assistantEvent.type === "thinking_delta") {
        appendReasoningDelta(assistantEvent.delta);
      }
      if (assistantEvent.type === "toolcall_end") {
        addActivity("tool", "Tool selected", `${assistantEvent.toolCall.name} ${JSON.stringify(assistantEvent.toolCall.arguments)}`);
      }
    }

    if (event.type === "tool_execution_start") {
      addActivity("tool", "Searching OneStream skill", summarizeToolArgs(event.args));
    }

    if (event.type === "tool_execution_end") {
      const hits = event.result?.details?.hits ?? [];
      const body =
        hits.length > 0
          ? hits.map((hit: { path: string; heading: string }) => `${hit.path} -> ${hit.heading}`).join("\n")
          : "No matching skill sections returned.";
      addActivity(event.isError ? "error" : "tool", event.isError ? "Tool error" : `Skill search returned ${hits.length} hits`, body);
    }

    if (event.type === "agent_end") {
      activeReasoningIdRef.current = null;
      activeReasoningTextRef.current = "";
      if (assistantTextSeenRef.current.has(assistantId)) {
        addActivity("answer", "Answer complete", "The final response has been streamed into the chat.");
      } else {
        addActivity("error", "No final answer text", "The model run ended without producing visible answer text. Try again with Thinking set to Off or Low.");
      }
    }
  }

  function appendAssistantText(assistantId: string, delta: string) {
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantId ? { ...message, content: `${message.content}${delta}` } : message,
      ),
    );
  }

  function appendReasoningDelta(delta: string) {
    const cleanDelta = delta.replace(/\s+/g, " ");
    if (!cleanDelta.trim()) return;

    const nextText = clipReasoning(`${activeReasoningTextRef.current}${cleanDelta}`);
    activeReasoningTextRef.current = nextText;

    if (!activeReasoningIdRef.current) {
      const id = crypto.randomUUID();
      activeReasoningIdRef.current = id;
      setActivity((current) =>
        [
          {
            id,
            kind: "thinking" as const,
            title: "Model reasoning",
            body: nextText,
            createdAt: Date.now(),
          },
          ...current,
        ].slice(0, 50),
      );
      return;
    }

    const id = activeReasoningIdRef.current;
    setActivity((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              body: nextText,
              createdAt: Date.now(),
            }
          : item,
      ),
    );
  }

  function startNewChat() {
    agentRef.current?.reset();
    agentRef.current = null;
    agentKeyRef.current = "";
    activeReasoningIdRef.current = null;
    activeReasoningTextRef.current = "";
    assistantTextSeenRef.current.clear();
    setMessages([]);
    setActivity([]);
    clearSavedMessages();
  }

  function reloadSkill() {
    agentRef.current = null;
    agentKeyRef.current = "";
    setSkillState({ status: "loading", docs: [], message: "Reloading OneStream XF skill from GitHub..." });
    loadOneStreamSkill()
      .then((docs) => {
        setSkillState({
          status: "ready",
          docs,
          message: `Loaded ${docs.length} public skill documents from anoop22/onestreamxf-skill.`,
        });
        addActivity("skill", "OneStream skill reloaded", `${docs.length} Markdown documents are now available.`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setSkillState({ status: "error", docs: [], message });
        addActivity("error", "Skill reload failed", message);
      });
  }

  function clearApiKey(): boolean {
    const confirmed = window.confirm(
      "Delete the OpenRouter API key saved in this browser? This removes it from localStorage and resets the current agent session.",
    );
    if (!confirmed) return false;

    clearSavedApiKey();
    agentRef.current?.reset();
    agentRef.current = null;
    agentKeyRef.current = "";
    activeReasoningIdRef.current = null;
    activeReasoningTextRef.current = "";
    assistantTextSeenRef.current.clear();
    setSettings((current) => ({ ...current, apiKey: "" }));
    setSettingsOpen(true);
    addActivity("skill", "OpenRouter key cleared", "The saved API key was removed from this browser.");
    return true;
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;

    if (settings.enterToSend && !event.shiftKey) {
      event.preventDefault();
      handleSubmit(event);
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      handleSubmit(event);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={20} />
          </div>
          <div>
            <h1>OneStream XF</h1>
            <p>Skill Chat</p>
          </div>
        </div>

        <div className={`status-box ${skillState.status}`}>
          <div className="status-line">
            {skillState.status === "loading" ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
            <span>{skillState.status === "ready" ? "Skill ready" : skillState.status}</span>
          </div>
          <p>{skillState.message}</p>
          <button type="button" className="icon-text-button" onClick={reloadSkill}>
            <RefreshCw size={15} />
            Reload
          </button>
        </div>

        <div className="sidebar-section">
          <div className="section-title">Documents</div>
          <div className="doc-list">
            {skillDocs.map((doc) => (
              <a href={doc.url} target="_blank" rel="noreferrer" key={doc.path}>
                <span>{doc.path}</span>
                <ExternalLink size={13} />
              </a>
            ))}
          </div>
        </div>

        <div className="sidebar-actions">
          <button type="button" onClick={startNewChat} className="secondary-button">
            <Plus size={16} />
            New Chat
          </button>
          <a className="secondary-button" href="https://github.com/anoop22/onestreamxf-skill" target="_blank" rel="noreferrer">
            <GitBranch size={16} />
            Skill Repo
          </a>
        </div>
      </aside>

      <main className="chat-panel">
        <header className="topbar">
          <div>
            <div className="eyebrow">
              <Sparkles size={15} />
              Public skill demo
            </div>
            <h2>Ask a OneStream-specific question</h2>
          </div>
          <div className="topbar-actions">
            <button type="button" className="icon-button" aria-label="Toggle activity" onClick={() => setActivityOpen((open) => !open)}>
              <PanelRightOpen size={18} />
            </button>
            <button type="button" className="icon-button" aria-label="Settings" onClick={() => setSettingsOpen((open) => !open)}>
              <Settings size={18} />
            </button>
          </div>
        </header>

        {settingsOpen && <SettingsPanel settings={settings} setSettings={setSettings} onClearKey={clearApiKey} />}

        <div className="message-list">
          {messages.length === 0 && (
            <div className="empty-state">
              <Bot size={30} />
              <h3>Ready for OneStream questions</h3>
              <p>
                The agent uses the public onestreamxf skill as its working reference and can search across the loaded skill docs before answering.
              </p>
              <div className="prompt-grid">
                {SAMPLE_PROMPTS.map((prompt) => (
                  <button key={prompt} type="button" onClick={() => handleSubmit(undefined, prompt)} disabled={!canAsk}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} isStreaming={isRunning && message.role === "assistant" && !message.content} />
          ))}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask about Cube Views, Dashboard parameters, Business Rules, BRApi..."
            rows={2}
            onKeyDown={handleComposerKeyDown}
          />
          <button type="submit" disabled={!canAsk || !input.trim()}>
            {isRunning ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            Ask
          </button>
        </form>
      </main>

      {activityOpen && <ActivityPanel activity={activity} docsByPath={docsByPath} onClose={() => setActivityOpen(false)} />}
    </div>
  );

  function addActivity(kind: ActivityItem["kind"], title: string, body?: string) {
    setActivity((current) =>
      [
        {
          id: crypto.randomUUID(),
          kind,
          title,
          body,
          createdAt: Date.now(),
        },
        ...current,
      ].slice(0, 50),
    );
  }
}

function clipReasoning(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trimStart();
  if (normalized.length <= MAX_REASONING_CHARS) return normalized;
  return `...${normalized.slice(normalized.length - MAX_REASONING_CHARS).trimStart()}`;
}

function SettingsPanel({
  settings,
  setSettings,
  onClearKey,
}: {
  settings: AppSettings;
  setSettings: (next: AppSettings | ((current: AppSettings) => AppSettings)) => void;
  onClearKey: () => boolean;
}) {
  const [draftApiKey, setDraftApiKey] = useState(settings.apiKey);
  const [appliedFlash, setAppliedFlash] = useState(false);
  const keyChanged = draftApiKey !== settings.apiKey;
  const canApplyKey = draftApiKey.trim().length > 0 && keyChanged;

  useEffect(() => {
    setDraftApiKey(settings.apiKey);
  }, [settings.apiKey]);

  function applyApiKey() {
    if (!draftApiKey.trim()) return;
    setSettings((current) => ({ ...current, apiKey: draftApiKey.trim() }));
    setAppliedFlash(true);
    window.setTimeout(() => setAppliedFlash(false), 1800);
  }

  function clearDraftAndAppliedKey() {
    const cleared = onClearKey();
    if (!cleared) return;
    setDraftApiKey("");
    setAppliedFlash(false);
  }

  return (
    <section className="settings-panel" aria-label="Settings">
      <label>
        <span>
          <KeyRound size={15} />
          OpenRouter API key
        </span>
        <div className="key-input-row">
          <input
            type="password"
            value={draftApiKey}
            placeholder="sk-or-v1-..."
            onChange={(event) => {
              setDraftApiKey(event.target.value);
              setAppliedFlash(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyApiKey();
              }
            }}
          />
          <button
            type="button"
            className={`apply-key-button ${appliedFlash || (!keyChanged && settings.apiKey.trim()) ? "applied" : ""}`}
            onClick={applyApiKey}
            disabled={!canApplyKey}
          >
            {appliedFlash || (!keyChanged && settings.apiKey.trim()) ? (
              <>
                <CheckCircle2 size={15} />
                Applied
              </>
            ) : (
              "Apply"
            )}
          </button>
          <button type="button" className="clear-key-button" onClick={clearDraftAndAppliedKey} disabled={!draftApiKey.trim() && !settings.apiKey.trim()} aria-label="Clear saved OpenRouter key">
            <Trash2 size={15} />
            Clear
          </button>
        </div>
      </label>
      <label>
        <span>Model</span>
        <input
          value={settings.model}
          onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value || DEFAULT_SETTINGS.model }))}
        />
      </label>
      <label>
        <span>Thinking</span>
        <select
          value={settings.thinkingLevel}
          onChange={(event) =>
            setSettings((current) => ({
              ...current,
              thinkingLevel: event.target.value as AppSettings["thinkingLevel"],
            }))
          }
        >
          <option value="off">Off</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.enterToSend}
          onChange={(event) => setSettings((current) => ({ ...current, enterToSend: event.target.checked }))}
        />
        <span>Enter sends, Shift+Enter adds a line</span>
      </label>
      <p>
        The key is stored in this browser only. GitHub Pages serves static files; model calls go directly from your browser to OpenRouter.
      </p>
    </section>
  );
}

function MessageBubble({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const html = useMemo(() => renderMarkdown(message.content), [message.content]);
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">{message.role === "assistant" ? <Bot size={17} /> : "You"}</div>
      <div className="bubble">
        {isStreaming && (
          <div className="thinking-placeholder">
            <Loader2 className="spin" size={16} />
            Reading the skill and preparing the answer...
          </div>
        )}
        {message.content && <div className="rich-text" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </article>
  );
}

function ActivityPanel({
  activity,
  docsByPath,
  onClose,
}: {
  activity: ActivityItem[];
  docsByPath: Map<string, SkillDoc>;
  onClose: () => void;
}) {
  return (
    <aside className="activity-panel">
      <div className="activity-head">
        <div>
          <div className="eyebrow">
            <Search size={14} />
            Agent workbench
          </div>
          <h2>Reasoning & tool use</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close activity">
          <PanelRightOpen size={18} />
        </button>
      </div>
      <div className="activity-list">
        {activity.length === 0 && <p className="muted">Reasoning, searches, and tool calls will appear here.</p>}
        {activity.map((item) => (
          <div className={`activity-item ${item.kind}`} key={item.id}>
            <div className="activity-title">{item.title}</div>
            {item.body && <ActivityBody body={item.body} docsByPath={docsByPath} />}
          </div>
        ))}
      </div>
    </aside>
  );
}

function ActivityBody({ body, docsByPath }: { body: string; docsByPath: Map<string, SkillDoc> }) {
  const lines = body.split("\n").slice(0, 8);
  return (
    <div className="activity-body">
      {lines.map((line, index) => {
        const path = line.match(/([\w.-]+\.md)/)?.[1];
        const doc = path ? docsByPath.get(path) : undefined;
        if (doc) {
          return (
            <a key={`${line}-${index}`} href={doc.url} target="_blank" rel="noreferrer">
              {line}
            </a>
          );
        }
        return <p key={`${line}-${index}`}>{line}</p>;
      })}
    </div>
  );
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  return [record.query, record.focus].filter(Boolean).join(" | ");
}

function toAgentMessages(messages: ChatMessage[]) {
  return messages.slice(-16).map((message) => {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content,
        timestamp: message.createdAt,
      };
    }

    return {
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: "openai-completions",
      provider: "openrouter",
      model: "openrouter/free",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: message.createdAt,
    };
  }) as never[];
}
