import { useEffect, useRef, useState } from "react";
import { durationText, type TurnTiming, timingText } from "./chat-presentation.js";
import { useTicker } from "./ticker.js";

export async function copyMessage(
  text: string,
  write: (text: string) => Promise<void>,
): Promise<void> {
  await write(text);
}

export function MessageCopy({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [state]);
  if (!text.length) return null;
  async function copy() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("copying");
    try {
      await copyMessage(text, (source) => navigator.clipboard.writeText(source));
      if (mounted.current) setState("copied");
    } catch {
      if (mounted.current) setState("failed");
    } finally {
      inFlight.current = false;
    }
  }
  return (
    <div className="message-copy">
      <button
        type="button"
        aria-label={state === "failed" ? "Retry Copy message" : "Copy message"}
        aria-disabled={state === "copying"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void copy()}
      >
        {state === "failed" ? "Retry Copy" : "Copy"}
      </button>
      <span
        className="message-copy-feedback"
        role={state === "copied" || state === "failed" ? "status" : undefined}
      >
        {state === "copied"
          ? "Copied."
          : state === "failed"
            ? "Copy failed. Check clipboard access and retry."
            : ""}
      </span>
    </div>
  );
}

export function TurnTimer({
  timing,
  visible,
}: {
  timing: TurnTiming | undefined;
  visible: boolean;
}) {
  const now = useTicker(visible && timing?.active === true);
  if (!timing) return null;
  return (
    <p className="turn-timer" aria-live="off">
      {timingText(timing, now)}
    </p>
  );
}

export function MessageAge({ at, scope }: { at: number | null | undefined; scope: string }) {
  const now = useTicker(at !== undefined && at !== null);
  return (
    <span
      role="img"
      title={`Agent text in ${scope}. Polling pause does not pause streaming.`}
      aria-label={`Agent text in ${scope}: ${
        at === undefined
          ? "No messages yet"
          : at === null
            ? "Message time unavailable"
            : `Last message ${durationText(now - at)} ago`
      }`}
    >
      {at === undefined
        ? "No messages yet"
        : at === null || !Number.isFinite(at)
          ? "Message time unavailable"
          : `Last message ${durationText(now - at)} ago`}
    </span>
  );
}
