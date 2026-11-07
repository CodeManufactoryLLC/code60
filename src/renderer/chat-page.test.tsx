import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DesktopApi, DesktopRun, OrchestrationChat } from "../bridge/index.js";
import type { RunStatus, RunView } from "../core/index.js";
import { ChatPage } from "./chat-page.js";
import { MessageCopy } from "./message-controls.js";

const run = (id: string, status: RunStatus): RunView => ({
  id,
  agent: "fake",
  branch: null,
  worktree: "/project",
  status,
  turns: 1,
  pending: [],
  stopping: false,
});
const worker = (id: string, status: RunStatus): DesktopRun =>
  ({ record: { id }, view: run(id, status) }) as DesktopRun;
function render(status: RunStatus, workers: string[], runs: DesktopRun[]) {
  return renderToStaticMarkup(
    <ChatPage
      api={{} as DesktopApi}
      chat={
        {
          run: run("orchestrator", status),
          workers,
          updates: { paused: true, pending: 1 },
        } as OrchestrationChat
      }
      events={[]}
      database="/db"
      active
      onDatabase={() => {}}
      runs={runs}
      explorerOpen={false}
      onExplorer={() => {}}
    />,
  );
}

describe("orchestration activity presentation", () => {
  it("shows concurrent owned workers while updates are paused without changing own controls", () => {
    const html = render(
      "idle",
      ["one", "two"],
      [worker("one", "running"), worker("two", "waiting"), worker("unrelated", "running")],
    );
    expect(html).toContain('class="chat-loader"');
    expect(html).toContain("2 subagents: waiting for approval");
    expect(html).toContain("Automatic worker updates are paused");
    expect(html).not.toContain(">Stop<");
    expect(html).toMatch(/<textarea(?![^>]*disabled)[^>]*>/);
  });
  it("removes delegated activity after failure, cancellation or idle, and isolates selection", () => {
    const runs = [worker("one", "failed"), worker("two", "cancelled"), worker("three", "idle")];
    expect(render("idle", ["one", "two", "three"], runs)).not.toContain('class="chat-loader"');
    expect(render("idle", [], [worker("other-chat", "running")])).not.toContain(
      'class="chat-loader"',
    );
  });
  it("keeps the own approval wait active with its own Stop action", () => {
    const html = render("waiting", [], []);
    expect(html).toContain('class="chat-loader"');
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("Stop</button>");
  });
  it("does not offer text Copy for empty or attachment-only source", () => {
    expect(renderToStaticMarkup(<MessageCopy text="" />)).toBe("");
  });
});
