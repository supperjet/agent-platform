import { FormEvent, KeyboardEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AgentServerClient,
  createAgentConsoleState,
  decodePublicEvent,
  reduceConsoleEvent,
  type AgentConsoleState,
  type AgentEvent,
  type CommandMode
} from "./index.js";

const EVENT_TYPES: AgentEvent["type"][] = [
  "run_started", "message_started", "assistant_delta", "message_finished",
  "tool_started", "tool_progress", "tool_finished", "run_finished", "run_failed"
];
const FILTERS = [
  { key: "all", label: "All Events" },
  { key: "model", label: "Messages", group: "MODEL" },
  { key: "tool", label: "Tool activity", group: "TOOL" },
  { key: "lifecycle", label: "Run state", group: "LIFECYCLE" },
  { key: "error", label: "Errors", group: "ERRORS" }
] as const;

type Filter = typeof FILTERS[number]["key"];
type Toast = { id: number; message: string; error: boolean };
type ConsoleAction = { type: "reset"; sessionId: string } | { type: "event"; event: AgentEvent };

function consoleReducer(state: AgentConsoleState, action: ConsoleAction) {
  return action.type === "reset"
    ? createAgentConsoleState(action.sessionId)
    : reduceConsoleEvent(state, action.event);
}

export function AgentConsole() {
  const client = useMemo(() => new AgentServerClient(import.meta.env.VITE_AGENT_SERVER_URL ?? ""), []);
  const initialSession = useMemo(readStoredSessionId, []);
  const [state, dispatch] = useReducer(consoleReducer, initialSession, createAgentConsoleState);
  const [sessionInput, setSessionInput] = useState(initialSession);
  const [connected, setConnected] = useState(false);
  const [connectionLabel, setConnectionLabel] = useState("Connecting");
  const [connectedAt, setConnectedAt] = useState(Date.now());
  const [elapsed, setElapsed] = useState("00:00:00");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const [mode, setMode] = useState<CommandMode>("prompt");
  const [commandText, setCommandText] = useState("");
  const [sending, setSending] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSequence = useRef(0);
  const conversationRef = useRef<HTMLDivElement>(null);

  const showToast = (message: string, error = false) => {
    const id = ++toastSequence.current;
    setToasts((current) => [...current, { id, message, error }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  };

  useEffect(() => {
    let active = true;
    localStorage.setItem("course15.sessionId", state.sessionId);
    setConnected(false);
    setConnectionLabel("Connecting");
    setSelectedIndex(undefined);

    const source = new EventSource(client.eventStreamUrl(state.sessionId));
    source.addEventListener("connected", () => {
      setConnected(true);
      setConnectionLabel("SSE Live");
      setConnectedAt(Date.now());
    });
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        if (!active) return;
        try {
          const event = decodePublicEvent(JSON.parse(message.data));
          dispatch({ type: "event", event });
          if (event.type === "run_failed") showToast(event.message, true);
          setSelectedIndex((index) => index === undefined ? 0 : index + 1);
        } catch {
          showToast("收到无法解析的 SSE 事件", true);
        }
      });
    }
    source.onerror = () => {
      setConnected(false);
      setConnectionLabel("Reconnecting");
    };

    void client.history(state.sessionId)
      .then((events) => {
        if (!active) return;
        for (const event of events) dispatch({ type: "event", event });
      })
      .catch((error: unknown) => {
        if (active) showToast(readErrorMessage(error), true);
      });

    return () => {
      active = false;
      source.close();
    };
  }, [client, state.sessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(formatElapsed(Date.now() - connectedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [connectedAt]);

  useEffect(() => {
    const panel = conversationRef.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [state.messages]);

  const counts = useMemo(() => {
    const result: Record<Filter, number> = { all: state.events.length, model: 0, tool: 0, lifecycle: 0, error: 0 };
    for (const event of state.events) result[classifyEvent(event)] += 1;
    return result;
  }, [state.events]);

  const visibleEvents = useMemo(() => state.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => (filter === "all" || classifyEvent(event) === filter)
      && (!search || JSON.stringify(event).toLowerCase().includes(search.toLowerCase())))
    .reverse(), [filter, search, state.events]);
  const selectedEvent = selectedIndex === undefined ? undefined : state.events[selectedIndex];

  const switchSession = (rawSessionId: string) => {
    const sessionId = rawSessionId.trim();
    if (!sessionId) {
      showToast("Session ID 不能为空", true);
      return;
    }
    setSessionInput(sessionId);
    dispatch({ type: "reset", sessionId });
  };

  const createSession = () => {
    const sessionId = createSessionId();
    setSessionInput(sessionId);
    switchSession(sessionId);
  };

  const sendCommand = async (event: FormEvent) => {
    event.preventDefault();
    const text = commandText.trim();
    if (!text) return;
    setSending(true);
    try {
      const receipt = await client.send(state.sessionId, mode, text);
      if (!receipt.accepted) throw new Error(`${formatMode(mode)} 要求先用 Prompt 创建会话。`);
      setCommandText("");
      showToast(`${formatMode(mode)} 已被 Fastify 接收`);
    } catch (error) {
      showToast(readErrorMessage(error), true);
    } finally {
      setSending(false);
    }
  };

  const abortRun = async () => {
    try {
      const receipt = await client.abort(state.sessionId);
      if (!receipt.accepted) throw new Error("当前 Session 尚未创建。");
      showToast("Abort 命令已发送");
    } catch (error) {
      showToast(readErrorMessage(error), true);
    }
  };

  const copyPayload = async () => {
    await navigator.clipboard.writeText(selectedEvent ? JSON.stringify(stripInternalFields(selectedEvent), null, 2) : "");
    showToast("Raw payload 已复制");
  };

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div><h1>Agent Session Console</h1><p>Browser → Fastify → Agent</p></div></div>
      <label className="session-control">
        <span>Session ID</span>
        <span className="session-input-row">
          <input value={sessionInput} onChange={(event) => setSessionInput(event.target.value)} onBlur={() => switchSession(sessionInput)} onKeyDown={(event) => event.key === "Enter" && switchSession(sessionInput)} autoComplete="off" spellCheck={false} aria-label="Session ID" />
          <button className="text-button" type="button" onClick={createSession}>新建</button>
        </span>
      </label>
      <dl className="runtime-status">
        <div><dt>Connection</dt><dd><span className={`status-dot${connected ? " is-live" : ""}`} /><span>{connectionLabel}</span></dd></div>
        <div><dt>Elapsed</dt><dd>{elapsed}</dd></div>
        <div><dt>Status</dt><dd><span className={`status-badge${state.isRunning ? " is-running" : ""}`}>{state.isRunning ? "RUNNING" : "IDLE"}</span></dd></div>
      </dl>
    </header>

    <main className="workspace">
      <aside className="event-sidebar" aria-label="事件筛选">
        <div className="panel-heading"><div><strong>Live Event Ledger</strong></div><span className={`live-badge${connected ? " is-live" : ""}`}>{connected ? "LIVE" : "OFFLINE"}</span></div>
        <div className="filters">
          {FILTERS.map((item) => <div key={item.key}>
            {"group" in item && <p className="filter-group">{item.group}</p>}
            <button className={`filter${filter === item.key ? " is-active" : ""}`} onClick={() => setFilter(item.key)}><span>{item.label}</span><b>{counts[item.key]}</b></button>
          </div>)}
        </div>
        <div className="legend"><p><span className="legend-dot browser" />Browser consumer</p><p><span className="legend-dot fastify" />Fastify session</p><p><span className="legend-dot agent" />Agent runtime</p></div>
      </aside>

      <section className="ledger-panel" aria-label="事件账本">
        <div className="ledger-toolbar">
          <label className="search-box"><span className="sr-only">搜索事件</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search events…" /></label>
          <div><span>{state.events.length} events</span><button className="quiet-button" type="button" onClick={() => dispatch({ type: "reset", sessionId: state.sessionId })}>Clear</button></div>
        </div>
        <div className="event-table-wrap">
          <table className="event-table"><thead><tr><th>Timestamp</th><th>Source</th><th>Event type</th><th>Summary</th></tr></thead><tbody>
            {visibleEvents.map(({ event, index }) => {
              const source = eventSource(event);
              return <tr key={`${index}-${event.type}`} className={`event-row${selectedIndex === index ? " is-selected" : ""}`} onClick={() => setSelectedIndex(index)} title={summarizeEvent(event)}>
                <td>{formatTime(event.receivedAt)}</td><td className={`source-${source.className}`}>{source.label}</td><td className={`type-${classifyEvent(event)}`}>{event.type}</td><td>{summarizeEvent(event)}</td>
              </tr>;
            })}
          </tbody></table>
          {!visibleEvents.length && <div className="empty-state"><strong>等待事件</strong><span>发送 Prompt 后，Agent 事件会实时出现在这里。</span></div>}
        </div>
        <section className="payload-panel">
          <div className="subpanel-heading"><strong>Raw Payload</strong><button className="quiet-button" type="button" onClick={() => void copyPayload()}>Copy</button></div>
          <pre>{selectedEvent ? JSON.stringify(stripInternalFields(selectedEvent), null, 2) : "选择一条事件查看完整 JSON。"}</pre>
        </section>
      </section>

      <aside className="conversation-panel" aria-label="会话消息">
        <div className="panel-heading"><strong>Conversation</strong><span>{state.messages.length} messages</span></div>
        <div ref={conversationRef} className="conversation">
          {!state.messages.length && <div className="empty-state"><strong>暂无消息</strong><span>会话消息会在这里按角色聚合。</span></div>}
          {state.messages.map((message) => <article key={message.id} className={`message ${message.role}${message.streaming ? " is-streaming" : ""}`}><header><strong>{message.role}</strong><time>{formatTime(message.receivedAt)}</time></header><p>{message.text || "…"}</p></article>)}
        </div>
      </aside>
    </main>

    <form className="command-dock" onSubmit={(event) => void sendCommand(event)}>
      <div className="command-modes" role="tablist" aria-label="命令类型">
        {(["prompt", "steer", "follow-up"] as const).map((item) => <button key={item} className={`mode-button${mode === item ? " is-active" : ""}`} type="button" onClick={() => setMode(item)}>{formatMode(item)}</button>)}
      </div>
      <label className="command-input"><span>{formatMode(mode)}</span><textarea value={commandText} onChange={(event) => setCommandText(event.target.value)} onKeyDown={(event) => submitWithShortcut(event)} rows={2} placeholder={commandPlaceholder(mode)} required /><small>Ctrl / ⌘ + Enter 发送</small></label>
      <button className="primary-button" type="submit" disabled={sending}>{sending ? "Sending…" : "Send"}</button>
      <button className="danger-button" type="button" disabled={!state.isRunning} onClick={() => void abortRun()}>Abort</button>
    </form>

    <div className="toast-region" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast${toast.error ? " error" : ""}`}>{toast.message}</div>)}</div>
  </div>;
}

function classifyEvent(event: AgentEvent): Exclude<Filter, "all"> {
  if (event.type === "run_failed") return "error";
  if (event.type.startsWith("tool_")) return event.type === "tool_finished" && event.isError ? "error" : "tool";
  if (event.type.startsWith("run_")) return "lifecycle";
  return "model";
}

function eventSource(event: AgentEvent) {
  if (event.type.startsWith("tool_")) return { label: "Tool", className: "tool" };
  if (event.type.startsWith("run_")) return { label: "Fastify", className: "fastify" };
  const browser = "role" in event && event.role === "user";
  return { label: browser ? "Browser" : "Agent", className: browser ? "browser" : "agent" };
}

function summarizeEvent(event: AgentEvent) {
  if (event.type === "run_started") return "Session run started";
  if (event.type === "run_finished") return "Session run finished";
  if (event.type === "run_failed") return `${event.errorCode}: ${event.message}`;
  if (event.type === "assistant_delta") return event.delta;
  if (event.type === "message_started" || event.type === "message_finished") return `${event.role}: ${event.text || "message"}`;
  if (event.type === "tool_started") return `${event.toolName}(${compactJson(event.args)})`;
  if (event.type === "tool_progress") return event.text;
  if (event.type === "tool_finished") return `${event.isError ? "failed" : "completed"}: ${event.text}`;
  return event.type;
}

function submitWithShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((value) => String(value).padStart(2, "0")).join(":");
}
function formatTime(value = new Date().toISOString()) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false }).format(new Date(value)); }
function formatMode(mode: CommandMode) { return mode === "follow-up" ? "Follow-up" : `${mode[0]?.toUpperCase()}${mode.slice(1)}`; }
function commandPlaceholder(mode: CommandMode) { return mode === "prompt" ? "输入一个新任务…" : mode === "steer" ? "输入当前运行的引导指令…" : "输入下一轮任务…"; }
function compactJson(value: unknown) { const text = JSON.stringify(value); return text.length > 80 ? `${text.slice(0, 77)}…` : text; }
function stripInternalFields(event: AgentEvent) { const { receivedAt: _, ...publicEvent } = event; return publicEvent; }
function createSessionId() { return `session-${crypto.randomUUID().slice(0, 8)}`; }
function readStoredSessionId() { return localStorage.getItem("course15.sessionId") || createSessionId(); }
function readErrorMessage(error: unknown) { return error instanceof Error ? error.message : "请求失败"; }
