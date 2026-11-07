export interface ChatEntry {
  id: string;
  expanded: boolean;
}

export interface Chats {
  entries: ChatEntry[];
  seen: string[];
}

export const emptyChats: Chats = { entries: [], seen: [] };

export type ChatAction =
  | { type: "sync"; ids: string[]; live: string[] }
  | { type: "open" | "minimize" | "close"; id: string }
  | { type: "move"; id: string; to: number };

export function updateChats(state: Chats, action: ChatAction): Chats {
  if (action.type === "sync") {
    const entries = state.entries.filter((entry) => action.ids.includes(entry.id));
    const added = action.live.filter((id) => !state.seen.includes(id) && action.ids.includes(id));
    if (!added.length && entries.length === state.entries.length) return state;
    return {
      entries: [...entries, ...added.map((id) => ({ id, expanded: false }))],
      seen: [...new Set([...state.seen, ...added])],
    };
  }
  if (action.type === "move") {
    const from = state.entries.findIndex((entry) => entry.id === action.id);
    if (from < 0 || !Number.isInteger(action.to)) return state;
    const to = Math.max(0, Math.min(state.entries.length - 1, action.to));
    if (from === to) return state;
    const entries = [...state.entries];
    const [entry] = entries.splice(from, 1);
    if (entry) entries.splice(to, 0, entry);
    return { ...state, entries };
  }
  const existing = state.entries.find((entry) => entry.id === action.id);
  if (action.type === "close") {
    return existing
      ? { ...state, entries: state.entries.filter((entry) => entry.id !== action.id) }
      : state;
  }
  if (action.type === "minimize" && !existing) return state;
  const expanded = action.type === "open";
  if (existing?.expanded === expanded) return state;
  return {
    entries: existing
      ? state.entries.map((entry) => (entry.id === action.id ? { ...entry, expanded } : entry))
      : [...state.entries, { id: action.id, expanded }],
    seen: state.seen.includes(action.id) ? state.seen : [...state.seen, action.id],
  };
}
