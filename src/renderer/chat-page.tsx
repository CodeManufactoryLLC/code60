import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  DesktopApi,
  DesktopRun,
  OrchestrationChat,
  OrchestrationChatAction,
} from "../bridge/index.js";
import type { RunEvent } from "../core/index.js";
import { delegatedActivity, sessionStatus, turnTimings } from "./chat-presentation.js";
import { Icon } from "./icons.js";
import { MessageCopy, TurnTimer } from "./message-controls.js";
import { type Block, statusSpec, transcript } from "./state.js";

function ChatMessage({ block }: { block: Block }) {
  const speaker =
    block.type === "prompt"
      ? block.automatic
        ? "Automatic worker update"
        : "You"
      : block.type === "message"
        ? "Assistant"
        : block.type === "thought"
          ? "Thinking"
          : block.type === "toolCall"
            ? "Tool"
            : block.type === "permission"
              ? "Permission"
              : block.type === "stderr"
                ? "Error"
                : "Session";
  return (
    <article className={`event ${block.type}`} aria-label={speaker}>
      {block.type !== "message" && <div className="chat-message-speaker">{speaker}</div>}
      <pre>{block.text}</pre>
      {(block.type === "message" || (block.type === "prompt" && !block.automatic)) && (
        <MessageCopy text={block.text} />
      )}
      {block.detail && <pre>{block.detail}</pre>}
    </article>
  );
}

export function ChatSidebar({
  api,
  chats,
  selectedId,
  database,
  onNavigate,
}: {
  api: DesktopApi;
  chats: readonly OrchestrationChat[];
  selectedId: string | undefined;
  database: string | null;
  onNavigate(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function action(request: OrchestrationChatAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      await api.orchestrationChatAction(request);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <nav className="chat-sidebar" aria-label="Orchestrator chats">
      <header className="chat-sidebar-heading">
        <button
          type="button"
          className="chat-sidebar-new"
          disabled={pending || !database}
          onClick={() => {
            onNavigate();
            void action({ type: "new" });
          }}
        >
          New chat
        </button>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="chat-sidebar-list">
        {chats.map(
          ({ run, error }, index) =>
            run && (
              <button
                key={run.id}
                type="button"
                className="chat-sidebar-entry"
                aria-label={`Chat ${index + 1}`}
                aria-description={error || sessionStatus(run).label}
                aria-current={run.id === selectedId ? "true" : undefined}
                disabled={pending}
                onClick={() => {
                  onNavigate();
                  void action({ type: "select", id: run.id });
                }}
                title={error || sessionStatus(run).label}
              >
                {run.stopping || ["queued", "running", "waiting"].includes(run.status) ? (
                  <span className="chat-loader" aria-hidden="true" />
                ) : null}
                <span className="chat-sidebar-label">Chat {index + 1}</span>
                <Icon name={error ? "warning--alt--filled" : sessionStatus(run).icon} />
                <span className="sr-only">{error || sessionStatus(run).label}</span>
              </button>
            ),
        )}
      </div>
    </nav>
  );
}

export function ChatPage({
  api,
  chat,
  hidden = false,
  events,
  database,
  active,
  onDatabase,
  runs,
  explorerOpen,
  onExplorer,
}: {
  api: DesktopApi;
  chat: OrchestrationChat | undefined;
  hidden?: boolean;
  events: readonly RunEvent[];
  database: string | null;
  active: boolean;
  onDatabase(): void;
  runs: readonly DesktopRun[];
  explorerOpen: boolean;
  onExplorer(): void;
}) {
  const id = useId();
  const run = chat?.run;
  const key = run ? `code60.orchestrationDraft:${run.id}` : "";
  const currentKey = useRef(key);
  currentKey.current = key;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<OrchestrationChatAction["type"] | null>(null);
  const busy = pending !== null;
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(300);
  const inFlight = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const position = useRef(0);
  const geometry = useRef({ width: 0, height: 0 });
  const working = (run?.status === "running" || run?.status === "waiting") && run.turns > 0;
  const connecting = run?.status === "queued" || (run?.status === "running" && run.turns === 0);
  const ready = run?.status === "idle" && !run.stopping;
  const ended = run && !["queued", "running", "waiting", "idle"].includes(run.status);
  const blocks = useMemo(() => transcript(events), [events]);
  const timings = useMemo(
    () => turnTimings(events, run?.status ?? "interrupted"),
    [events, run?.status],
  );
  const delegated = delegatedActivity(chat?.workers ?? [], runs);
  const items = useMemo(() => {
    const result: { key: string; activity: boolean; blocks: Block[] }[] = [];
    for (const block of blocks.slice(-visible)) {
      const activity =
        block.automatic === true ||
        ["thought", "toolCall", "permission", "note"].includes(block.type);
      const previous = result.at(-1);
      if (
        activity &&
        previous?.activity &&
        block.type !== "prompt" &&
        !previous.blocks.some((item) => item.type === "prompt")
      )
        previous.blocks.push(block);
      else result.push({ key: block.key, activity, blocks: [block] });
    }
    return result;
  }, [blocks, visible]);
  const latest = events.findLast(
    (event) => event.type !== "status" && event.type !== "turnEnd" && event.type !== "acp",
  );
  const progress =
    run?.stopping || pending === "cancel" || pending === "stop"
      ? "Stopping"
      : connecting || pending === "restart"
        ? "Connecting"
        : run?.status === "waiting"
          ? "Waiting for approval"
          : working
            ? latest?.type === "message"
              ? "Responding"
              : latest?.type === "toolCall" || latest?.type === "permission"
                ? "Working"
                : "Thinking"
            : pending === "send"
              ? "Sending"
              : "";
  const failed = run && ["failed", "timed_out", "interrupted"].includes(run.status);
  const failure = error || chat?.error || (failed ? run.reason : "");
  useEffect(() => {
    setDraft(key ? (sessionStorage.getItem(key) ?? "") : "");
    setError("");
    setVisible(300);
    follow.current = true;
    position.current = 0;
  }, [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: streamed text and expanded history change the scroll height.
  useEffect(() => {
    const element = scroll.current;
    if (!active || !element) return;
    element.scrollTop = follow.current ? element.scrollHeight : position.current;
    geometry.current = { width: element.clientWidth, height: element.clientHeight };
  }, [active, events, visible, progress]);
  useEffect(() => {
    const element = scroll.current;
    if (!active || !element) return;
    const resize = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
      geometry.current = { width: element.clientWidth, height: element.clientHeight };
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, [active]);
  function edit(text: string) {
    setDraft(text);
    if (key) sessionStorage.setItem(key, text);
  }
  async function action(request: OrchestrationChatAction) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(request.type);
    setError("");
    try {
      await api.orchestrationChatAction(request);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }
  async function send() {
    if (!ready || !run || !draft.trim()) return;
    const text = draft;
    if ((await action({ type: "send", id: run.id, text })) && currentKey.current === key) {
      setDraft((current) => (current === text ? "" : current));
      if (sessionStorage.getItem(key) === text) sessionStorage.removeItem(key);
      follow.current = true;
    }
  }
  const label = connecting
    ? "Connecting"
    : ready
      ? "Ready"
      : run
        ? statusSpec[run.status].label
        : "Not connected";
  return (
    <main className="orchestration-chat-page" aria-labelledby={id} hidden={hidden}>
      <header className="orchestration-chat-heading">
        <button type="button" aria-pressed={explorerOpen} onClick={onExplorer}>
          <Icon name="folder" /> File Explorer
        </button>
        <h1 id={id} className="sr-only">
          Chat
        </h1>
        <div className="orchestration-chat-status">
          {run && <span>{run.agent}</span>}
          {!database ? (
            <button type="button" onClick={onDatabase}>
              Connect to database
            </button>
          ) : connecting ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void action({ type: "stop", id: run?.id ?? null })}
            >
              Cancel
            </button>
          ) : (
            (!run || ended) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void action({ type: "restart", id: run?.id ?? null })}
              >
                Retry
              </button>
            )
          )}
        </div>
      </header>
      {failure && (
        <div className="error-banner" role="alert">
          {failure}
        </div>
      )}
      {run && !ended && chat?.updates.paused && (
        <div className="warning-banner" role="status">
          <span>
            Automatic worker updates are paused
            {chat.updates.pending > 0 ? ` (${chat.updates.pending} waiting)` : ""}. Sending a
            message also resumes them.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void action({ type: "resume-updates", id: run.id })}
          >
            Resume updates
          </button>
        </div>
      )}
      <div className="orchestration-chat-body">
        <div
          className="transcript"
          ref={scroll}
          role="log"
          aria-label="Orchestration conversation"
          onScroll={() => {
            if (!active || !scroll.current) return;
            const element = scroll.current;
            const resized =
              geometry.current.width !== element.clientWidth ||
              geometry.current.height !== element.clientHeight;
            if (resized && follow.current) element.scrollTop = element.scrollHeight;
            else
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            geometry.current = { width: element.clientWidth, height: element.clientHeight };
            position.current = element.scrollTop;
          }}
        >
          {blocks.length === 0 && (
            <div className="chat-empty">
              <span className="wordmark">
                Code<b>60</b>
              </span>
              <h2>New conversation</h2>
            </div>
          )}
          {blocks.length > visible && (
            <button
              type="button"
              onClick={() => {
                follow.current = false;
                setVisible((count) => count + 300);
              }}
            >
              Show earlier activity
            </button>
          )}
          {items.map((item) => (
            <div className="chat-turn-content" key={item.key}>
              {item.activity ? (
                <details className="chat-activity" key={item.key}>
                  <summary>
                    <Icon name="terminal" />
                    Activity
                  </summary>
                  <div className="chat-activity-content">
                    {item.blocks.map((block) => (
                      <ChatMessage key={block.key} block={block} />
                    ))}
                  </div>
                </details>
              ) : (
                <ChatMessage key={item.key} block={item.blocks[0] as Block} />
              )}
              {item.blocks.map((block) => {
                const timing = timings.get(block.key);
                return timing ? (
                  <TurnTimer key={block.key} timing={timing} visible={active} />
                ) : null;
              })}
            </div>
          ))}
        </div>
        <section className="composer" aria-label="Chat composer">
          {progress || delegated ? <span className="chat-loader" aria-hidden="true" /> : null}
          <label className="sr-only" htmlFor={`${id}-message`}>
            Message to orchestrator
          </label>
          <textarea
            id={`${id}-message`}
            placeholder="Message…"
            rows={2}
            value={draft}
            disabled={!run || !!ended || connecting}
            maxLength={1_000_000}
            onChange={(event) => edit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <span className="chat-progress" role="status" aria-live="polite" aria-atomic="true">
              {[progress || label, delegated].filter(Boolean).join(" · ")}
            </span>
            {working ? (
              <button
                type="button"
                disabled={busy || !!run?.stopping}
                onClick={() => void action({ type: "cancel", id: run?.id ?? null })}
              >
                <Icon name="stop" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || !ready || !draft.trim()}
                onClick={() => void send()}
              >
                Send <Icon name="arrow--up" />
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
