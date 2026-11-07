import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Action, DesktopApi, DesktopRun } from "../bridge/index.js";
import type { RunEvent } from "../core/index.js";
import { sessionStatus, turnTimings } from "./chat-presentation.js";
import { Icon } from "./icons.js";
import { MessageCopy, TurnTimer } from "./message-controls.js";
import { continueBlocker } from "./recovery.js";
import { statusSpec, transcript } from "./state.js";

const noEvents: RunEvent[] = [];
const endedStatuses = new Set(["finished", "failed", "cancelled", "timed_out", "interrupted"]);

export function ChatPopup({
  api,
  run,
  live,
  orchestrated = false,
  streamed,
  expanded,
  active,
  composeRequest,
  matchRequest,
  draft,
  onDraft,
  onSent,
  onMinimize,
  onClose,
}: {
  api: DesktopApi;
  run: DesktopRun;
  live: boolean;
  /** Dispatched by the orchestration chat, with a fixed allow-all policy. */
  orchestrated?: boolean;
  streamed: RunEvent[] | undefined;
  expanded: boolean;
  active: boolean;
  composeRequest: number | undefined;
  matchRequest: { serial: number; index: number } | undefined;
  draft: string;
  onDraft(text: string): void;
  onSent(text: string): void;
  onMinimize(): void;
  onClose(): void;
}) {
  const id = run.record.id;
  const titleId = useId();
  const replyId = useId();
  const [history, setHistory] = useState<RunEvent[]>([]);
  const [historyLoading, setLoading] = useState(false);
  const loading = !live && historyLoading;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(300);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const savedScroll = useRef(0);
  const popup = useRef<HTMLElement>(null);
  const fullScreenButton = useRef<HTMLButtonElement>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const matched = useRef<number | undefined>(undefined);
  const composed = useRef<number | undefined>(undefined);
  const status = run.view?.status ?? run.record.status;
  const ended = endedStatuses.has(status);
  const blocker = ended ? continueBlocker(run) : undefined;
  const inactive = ended && run.record.discardedAt !== undefined;
  const editable = run.view?.status === "idle" && !run.view.stopping;
  // Sending a message to an ended run resumes it: ACP restore first, else a fresh handoff session.
  const resumable = ended && blocker === undefined;
  const sendable = editable || resumable;
  const events = live ? (streamed ?? noEvents) : history;
  const blocks = useMemo(() => transcript(events), [events]);
  const timings = useMemo(() => turnTimings(events, status), [events, status]);
  const presentation = run.view ? sessionStatus(run.view) : statusSpec[status];
  const runPending = run.view?.pending ?? [];

  useLayoutEffect(() => {
    const element = popup.current;
    if (!fullScreen || !element) return;
    if (!expanded || !active) {
      setFullScreen(false);
      return;
    }
    const workspace = element.closest(".app")?.querySelector(".app-workspace");
    if (!workspace) return;
    const fitPanel = () => {
      const panel = workspace.querySelector(".page-panel:not([hidden])");
      if (!panel) return;
      const box = panel.getBoundingClientRect();
      element.style.left = `${box.left + 8}px`;
      element.style.top = `${box.top + 8}px`;
      element.style.width = `${Math.max(0, box.width - 16)}px`;
      element.style.height = `${Math.max(0, box.height - 16)}px`;
    };
    fitPanel();
    element.showPopover();
    fullScreenButton.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(fitPanel);
    observer.observe(workspace);
    window.addEventListener("resize", fitPanel);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fitPanel);
      if (element.matches(":popover-open")) element.hidePopover();
      for (const property of ["left", "top", "width", "height"])
        element.style.removeProperty(property);
    };
  }, [fullScreen, expanded, active]);

  useEffect(() => {
    if (composeRequest === undefined || composed.current === composeRequest || !expanded) return;
    composed.current = composeRequest;
    composer.current?.focus({ preventScroll: true });
  }, [composeRequest, expanded]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (live) return;
    setLoading(true);
    void api
      .action({ type: "events", id })
      .then((result) => {
        if (!cancelled && Array.isArray(result)) setHistory(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, id, live]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: streaming blocks change the scroll height.
  useEffect(() => {
    if (!expanded || !scroll.current) return;
    scroll.current.scrollTop = follow.current ? scroll.current.scrollHeight : savedScroll.current;
  }, [blocks, expanded, fullScreen]);

  useEffect(() => {
    if (
      !matchRequest ||
      matched.current === matchRequest.serial ||
      !expanded ||
      !active ||
      loading ||
      !blocks.length
    )
      return;
    const blockIndex = blocks.findIndex((block) => block.key === String(matchRequest.index));
    if (blockIndex < 0) return;
    if (blocks.length - blockIndex > visible) {
      setVisible(blocks.length - blockIndex);
      return;
    }
    const target = scroll.current?.querySelector<HTMLElement>(
      `[data-event-index="${matchRequest.index}"]`,
    );
    if (!target) return;
    follow.current = false;
    target.scrollIntoView({ block: "center" });
    savedScroll.current = scroll.current?.scrollTop ?? 0;
    target.focus({ preventScroll: true });
    matched.current = matchRequest.serial;
  }, [matchRequest, expanded, active, loading, blocks, visible]);

  async function act(action: Action): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await api.action(action);
      return true;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function send() {
    if (!sendable || busy || !draft.trim()) return;
    const text = draft;
    if (await act({ type: resumable ? "continue" : "reply", id, text })) {
      onSent(text);
      follow.current = true;
    }
  }

  return (
    <section
      ref={popup}
      className="chat-popup"
      data-full-screen={fullScreen}
      popover={fullScreen ? "auto" : undefined}
      onToggle={(event) => {
        if (!event.currentTarget.matches(":popover-open")) setFullScreen(false);
      }}
      onKeyDown={(event) => {
        if (fullScreen && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setFullScreen(false);
          fullScreenButton.current?.focus({ preventScroll: true });
        }
      }}
      role="dialog"
      id={`chat-${id}`}
      aria-labelledby={titleId}
      hidden={!expanded}
      inert={!expanded}
    >
      <header className="chat-header">
        <div className="chat-title">
          <h2 id={titleId}>
            {run.record.agent} / {id.slice(-6)}
          </h2>
          <span className="status-label" data-status={status}>
            <Icon name={presentation.icon} />
            {presentation.label}
          </span>
          {orchestrated && (
            <span
              className="status-label chat-worker-label"
              data-tooltip="Dispatched by the orchestration chat. It allows each of its tool calls once without asking."
            >
              <Icon name="chat" />
              Orchestrator worker, allows all
            </span>
          )}
          <div className="chat-window-actions">
            <button
              ref={fullScreenButton}
              type="button"
              className="icon-button"
              aria-label={fullScreen ? "Exit full screen" : "View chat full screen"}
              data-tooltip={fullScreen ? "Exit full screen" : "View chat full screen"}
              data-tooltip-keys={fullScreen ? "Esc" : undefined}
              aria-pressed={fullScreen}
              onClick={() => setFullScreen((value) => !value)}
            >
              <Icon name={fullScreen ? "minimize" : "maximize"} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Minimize chat"
              data-tooltip="Minimize chat"
              onClick={onMinimize}
            >
              <Icon name="subtract" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Close chat"
              data-tooltip="Close chat (agent keeps running)"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}{" "}
      {run.record.branch === null && (
        <div className="warning-banner">
          This agent works directly in your folder. Changes are not isolated; diff and discard are
          unavailable.
        </div>
      )}
      <div
        className="transcript"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el && expanded) {
            savedScroll.current = el.scrollTop;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }
        }}
      >
        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {blocks.length > visible && (
              <button
                type="button"
                onClick={() => {
                  follow.current = false;
                  setVisible((n) => n + 300);
                }}
              >
                Show earlier activity
              </button>
            )}
            {blocks.length === 0 && (
              <div className="activity-empty">
                <p>
                  {sendable
                    ? "Send a prompt below to start this agent's first turn."
                    : "Agent activity will appear here."}
                </p>
              </div>
            )}
            {blocks.slice(-visible).map((block) => (
              <Fragment key={block.key}>
                <article
                  className={`event ${block.type}${matchRequest?.index === Number(block.key) ? " search-match" : ""}`}
                  key={block.key}
                  data-event-index={block.key}
                  tabIndex={-1}
                >
                  {block.text && <pre>{block.text}</pre>}
                  {(block.type === "message" || (block.type === "prompt" && !block.automatic)) && (
                    <MessageCopy text={block.text} />
                  )}
                  {block.detail && (
                    <details>
                      <summary>Handoff summary</summary>
                      <pre>{block.detail}</pre>
                    </details>
                  )}
                </article>
                {timings.get(block.key) && (
                  <TurnTimer timing={timings.get(block.key)} visible={active && expanded} />
                )}
              </Fragment>
            ))}
          </>
        )}
      </div>
      {runPending.length > 0 && (
        <section className="approvals" aria-label="Pending approvals">
          {runPending.map((permission) => (
            <div className="approval" key={permission.id}>
              <div>
                <strong>Approval needed / {permission.kind}</strong>
                <pre>{permission.title}</pre>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ type: "permission", id: permission.id, answer: "deny" })}
              >
                Deny
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void act({ type: "permission", id: permission.id, answer: "allow" })}
              >
                Allow once
              </button>
            </div>
          ))}
        </section>
      )}
      {inactive ? (
        <div className="composer composer-inactive" role="status">
          Agent is inactive. Its worktree was deleted.
        </div>
      ) : (
        <section className="composer">
          <label className="sr-only" htmlFor={replyId}>
            Message
          </label>
          <textarea
            id={replyId}
            ref={composer}
            placeholder="Send a message..."
            value={draft}
            disabled={!sendable || busy}
            onChange={(event) => {
              onDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <span>
              {run.view?.stopping
                ? "Stopping agent…"
                : editable
                  ? ""
                  : resumable
                    ? busy
                      ? "Resuming session…"
                      : ""
                    : (blocker ?? "Prompts are available between turns.")}
            </span>
            <button
              type="button"
              className="primary"
              disabled={busy || !sendable || !draft.trim()}
              onClick={() => void send()}
            >
              Send <Icon name="arrow--up" />
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
