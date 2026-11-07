import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { DesktopApi, Snapshot } from "../bridge/index.js";
import type { RunEvent } from "../core/index.js";
import { ChatPopup } from "./chat-popup.js";
import { sessionStatus } from "./chat-presentation.js";
import { emptyChats, updateChats } from "./chats.js";
import { Icon } from "./icons.js";
import { statusSpec } from "./state.js";

export interface OpenChat {
  id: string;
  serial: number;
  /** Also focus the chat's composer. */
  compose?: boolean;
  eventIndex?: number;
}

export function ChatDock({
  api,
  snapshot,
  events,
  request,
  active,
  onSelect,
}: {
  api: DesktopApi;
  snapshot: Snapshot;
  events: Record<string, RunEvent[]>;
  request: OpenChat | undefined;
  active: boolean;
  onSelect(id: string): void;
}) {
  const [chats, dispatch] = useReducer(updateChats, emptyChats);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [overflow, setOverflow] = useState(false);
  const [drag, setDrag] = useState<{ id: string; to: number }>();
  const viewport = useRef<HTMLDivElement>(null);
  const heads = useRef(new Map<string, HTMLButtonElement>());
  const positions = useRef(new Map<string, number>());
  const moves = useRef(new Map<string, Animation>());
  const exits = useRef(new Map<string, Animation[]>());
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const consumed = useRef<number | undefined>(undefined);
  const previous = useRef(chats.entries);
  const focusId = useRef<string | undefined>(undefined);
  const pointer = useRef<
    | {
        id: string;
        x: number;
        startX: number;
        startY: number;
        dragging: boolean;
        to: number;
      }
    | undefined
  >(undefined);
  const pending = snapshot.runs.reduce((sum, run) => sum + (run.view?.pending.length ?? 0), 0);

  useEffect(() => {
    dispatch({
      type: "sync",
      ids: snapshot.runs.map((run) => run.record.id),
      live: snapshot.liveIds,
    });
  }, [snapshot.runs, snapshot.liveIds]);

  useEffect(() => {
    if (
      !request ||
      consumed.current === request.serial ||
      !snapshot.runs.some((run) => run.record.id === request.id)
    )
      return;
    consumed.current = request.serial;
    const animations = exits.current.get(request.id);
    if (animations) {
      exits.current.delete(request.id);
      for (const animation of animations) animation.cancel();
      setClosing((current) => new Set([...current].filter((id) => id !== request.id)));
    }
    dispatch({ type: "open", id: request.id });
  }, [request, snapshot.runs]);

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const entry of chats.entries) {
      const head = heads.current.get(entry.id);
      const slot = head?.parentElement;
      if (!slot || !head) continue;
      const left = slot.offsetLeft;
      next.set(entry.id, left);
      const old = positions.current.get(entry.id);
      const running = moves.current.get(entry.id);
      const offset = new DOMMatrixReadOnly(getComputedStyle(slot).transform).m41;
      running?.cancel();
      moves.current.delete(entry.id);
      if (!active || reduced) continue;
      if (old !== undefined && Math.abs(old + offset - left) > 1) {
        moves.current.set(
          entry.id,
          slot.animate(
            [{ transform: `translateX(${old + offset - left}px)` }, { transform: "translateX(0)" }],
            { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
          ),
        );
      }
    }
    for (const [id, animation] of moves.current) {
      if (!next.has(id)) {
        animation.cancel();
        moves.current.delete(id);
      }
    }
    positions.current = next;
  }, [chats.entries, active]);

  useEffect(() => {
    const runningMoves = moves.current;
    const runningExits = exits.current;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      for (const animation of runningMoves.values()) animation.cancel();
      for (const animations of runningExits.values())
        for (const animation of animations) animation.cancel();
    };
    const change = () => {
      if (media.matches) stop();
    };
    media.addEventListener("change", change);
    return () => {
      media.removeEventListener("change", change);
      // Clearing first prevents exit completions from updating an unmounted dock.
      const animations = [...runningExits.values()].flat();
      runningExits.clear();
      stop();
      for (const animation of animations) animation.cancel();
    };
  }, []);

  function close(id: string, index: number) {
    if (exits.current.has(id)) return;
    const target = chats.entries[index + 1]?.id ?? chats.entries[index - 1]?.id;
    if (target) heads.current.get(target)?.focus({ preventScroll: true });
    else document.querySelector<HTMLButtonElement>(".page-tabs [aria-selected='true']")?.focus();
    const slot = heads.current.get(id)?.parentElement;
    if (!slot || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dispatch({ type: "close", id });
      return;
    }
    setClosing((current) => new Set([...current, id]));
    const animation = slot.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 140,
      easing: "ease-in",
      fill: "forwards",
    });
    const animations = [animation];
    exits.current.set(id, animations);
    void animation.finished
      .catch(() => {})
      .then(() => {
        if (exits.current.get(id) !== animations) return;
        exits.current.delete(id);
        dispatch({ type: "close", id });
        setClosing((current) => new Set([...current].filter((value) => value !== id)));
      });
  }

  useLayoutEffect(() => {
    if (!active) return;
    const opened = chats.entries.find(
      (entry) =>
        entry.expanded && !previous.current.some((old) => old.id === entry.id && old.expanded),
    );
    const target = focusId.current ?? opened?.id;
    if (target) {
      const button = heads.current.get(target);
      if (focusId.current) button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
      focusId.current = undefined;
    }
    previous.current = chats.entries;
  }, [chats.entries, active]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);

  function insertion(x: number, id: string) {
    return chats.entries
      .filter((entry) => entry.id !== id)
      .reduce((position, entry) => {
        const box = heads.current.get(entry.id)?.getBoundingClientRect();
        return position + (box && x > box.left + box.width / 2 ? 1 : 0);
      }, 0);
  }
  const insertionRef = useRef(insertion);
  insertionRef.current = insertion;

  const draggingId = drag?.id;
  useEffect(() => {
    if (!draggingId || !active) return;
    let frame: number;
    const tick = () => {
      const current = pointer.current;
      const element = viewport.current;
      if (!current?.dragging || !element) return;
      const box = element.getBoundingClientRect();
      const step = current.x < box.left + 36 ? -12 : current.x > box.right - 36 ? 12 : 0;
      if (step) {
        element.scrollLeft += step;
        current.to = insertionRef.current(current.x, current.id);
        setDrag((old) => (old?.to === current.to ? old : { id: current.id, to: current.to }));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draggingId, active]);

  useEffect(() => {
    if (!active) {
      pointer.current = undefined;
      setDrag(undefined);
    }
  }, [active]);

  function move(id: string, to: number) {
    const index = Math.max(0, Math.min(chats.entries.length - 1, to));
    dispatch({ type: "move", id, to: index });
    focusId.current = id;
    setAnnouncement(`Chat ${id.slice(-6)}, position ${index + 1} of ${chats.entries.length}.`);
  }
  function finishDrag(cancelled: boolean) {
    const current = pointer.current;
    if (current?.dragging) {
      if (!cancelled) move(current.id, current.to);
    }
    pointer.current = undefined;
    setDrag(undefined);
  }
  const others = chats.entries.filter((entry) => entry.id !== drag?.id);

  return (
    <div className="chat-dock-region">
      {pending > 0 && (
        <span className="footer-note">
          {pending} approval{pending === 1 ? "" : "s"} waiting
        </span>
      )}
      <div className="chat-dock-anchor">
        <div className="chat-dock" ref={viewport}>
          <nav className="chat-heads" aria-label="Chats">
            {chats.entries.map((entry, index) => {
              const run = snapshot.runs.find((run) => run.record.id === entry.id);
              if (!run) return null;
              const id = entry.id;
              const waiting = run.view?.pending.length ?? 0;
              const presentation = run.view
                ? sessionStatus(run.view)
                : statusSpec[run.record.status];
              const drop =
                drag && id === others[drag.to]?.id
                  ? "before"
                  : drag?.to === others.length && id === others.at(-1)?.id
                    ? "after"
                    : undefined;
              return (
                <div
                  className={`chat-slot${entry.expanded ? " open" : ""}`}
                  key={id}
                  data-chat-id={id}
                  inert={closing.has(id)}
                  data-dragging={drag?.id === id}
                  data-drop={drop}
                >
                  <ChatPopup
                    api={api}
                    run={run}
                    live={snapshot.liveIds.includes(id)}
                    orchestrated={snapshot.workers.includes(id)}
                    streamed={events[id]}
                    expanded={entry.expanded}
                    active={active}
                    matchRequest={
                      request?.id === id && request.eventIndex !== undefined
                        ? { serial: request.serial, index: request.eventIndex }
                        : undefined
                    }
                    composeRequest={
                      request?.compose && request.id === id ? request.serial : undefined
                    }
                    draft={drafts[id] ?? ""}
                    onDraft={(text) => setDrafts((current) => ({ ...current, [id]: text }))}
                    onSent={(text) =>
                      setDrafts((current) => ({
                        ...current,
                        [id]: current[id] === text ? "" : (current[id] ?? ""),
                      }))
                    }
                    onMinimize={() => {
                      focusId.current = id;
                      dispatch({ type: "minimize", id });
                    }}
                    onClose={() => close(id, index)}
                  />
                  <button
                    type="button"
                    className="chat-head"
                    ref={(element) => {
                      if (element) heads.current.set(id, element);
                      else heads.current.delete(id);
                    }}
                    aria-pressed={entry.expanded}
                    aria-label={`${run.record.agent} / ${id.slice(-6)} / ${presentation.label}${
                      waiting > 0 ? ` / ${waiting} approval${waiting === 1 ? "" : "s"}` : ""
                    }`}
                    data-emphasis={presentation.emphasis}
                    aria-controls={`chat-${id}`}
                    aria-describedby="chat-drag-help"
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    title="Click to open or minimize. Alt+Left/Right to reorder."
                    onClick={() => {
                      dispatch({ type: entry.expanded ? "minimize" : "open", id });
                      onSelect(id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && pointer.current?.dragging) {
                        event.preventDefault();
                        finishDrag(true);
                      } else if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                        event.preventDefault();
                        move(id, index + (event.key === "ArrowLeft" ? -1 : 1));
                      }
                    }}
                  >
                    <Icon name={presentation.icon} />
                    <span className="chat-head-summary">
                      <span>
                        {run.record.agent} / {id.slice(-6)}
                      </span>
                      <span className="chat-head-status">
                        <span>{presentation.label}</span>
                        {waiting > 0 && <span className="chat-approval-count">({waiting})</span>}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="chat-drag-handle"
                    aria-label={`Reorder chat ${run.record.agent} ${id.slice(-6)}`}
                    aria-describedby="chat-drag-help"
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    data-tooltip="Drag to reorder"
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && pointer.current?.dragging) {
                        event.preventDefault();
                        finishDrag(true);
                      } else if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                        event.preventDefault();
                        move(id, index + (event.key === "ArrowLeft" ? -1 : 1));
                      }
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      pointer.current = {
                        id,
                        x: event.clientX,
                        startX: event.clientX,
                        startY: event.clientY,
                        dragging: false,
                        to: index,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const current = pointer.current;
                      if (!current || current.id !== id) return;
                      current.x = event.clientX;
                      if (
                        !current.dragging &&
                        Math.hypot(event.clientX - current.startX, event.clientY - current.startY) <
                          6
                      )
                        return;
                      current.dragging = true;
                      current.to = insertion(event.clientX, id);
                      setDrag({ id, to: current.to });
                    }}
                    onPointerUp={(event) => {
                      const box = viewport.current?.getBoundingClientRect();
                      const head = event.currentTarget.getBoundingClientRect();
                      finishDrag(
                        !box ||
                          event.clientX < box.left ||
                          event.clientX > box.right ||
                          event.clientY < head.top ||
                          event.clientY > head.bottom,
                      );
                    }}
                    onPointerCancel={() => finishDrag(true)}
                    onLostPointerCapture={() => {
                      if (pointer.current) finishDrag(true);
                    }}
                  >
                    <Icon name="draggable" />
                  </button>
                  {!entry.expanded && (
                    <button
                      type="button"
                      className="chat-head-close"
                      aria-label="Close minimized chat"
                      data-tooltip="Close chat (agent keeps running)"
                      onClick={(event) => {
                        event.stopPropagation();
                        close(id, index);
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </div>
              );
            })}
          </nav>
        </div>
        {overflow && (
          <div className="dock-scroll-controls">
            <button
              type="button"
              aria-label="Scroll chats left"
              onClick={() => viewport.current?.scrollBy({ left: -480 })}
            >
              <Icon name="chevron--right" style={{ transform: "scaleX(-1)" }} />
            </button>
            <button
              type="button"
              aria-label="Scroll chats right"
              onClick={() => viewport.current?.scrollBy({ left: 480 })}
            >
              <Icon name="chevron--right" />
            </button>
          </div>
        )}
      </div>
      <span className="sr-only" id="chat-drag-help">
        Drag the handle to reorder chats, or press Alt+Left or Alt+Right.
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
