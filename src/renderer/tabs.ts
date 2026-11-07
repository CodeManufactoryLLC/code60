export type PageId =
  | "episodic-memory"
  | "files"
  | "chat"
  | "sessions"
  | "search"
  | "messages"
  | "events"
  | "configurations"
  | "worktrees"
  | "polling"
  | "prompts"
  | "settings";

export interface PageTabs {
  open: PageId[];
  active: PageId;
}

export const initialTabs: PageTabs = {
  open: [
    "chat",
    "episodic-memory",
    "sessions",
    "messages",
    "events",
    "search",
    "configurations",
    "worktrees",
    "polling",
    "prompts",
    "settings",
  ],
  active: "chat",
};

export type TabAction = { type: "open" | "select" | "close"; id: PageId };

export function updateTabs(state: PageTabs, action: TabAction): PageTabs {
  if (action.id === "files") action = { ...action, id: "chat" };
  switch (action.type) {
    case "open":
      return {
        open: state.open.includes(action.id) ? state.open : [...state.open, action.id],
        active: action.id,
      };
    case "select":
      return state.open.includes(action.id) ? { ...state, active: action.id } : state;
    case "close":
      return state;
  }
}
