import type { PrDetails, ReviewThread, StackInfo } from "./model";

export type PaneTab = "overview" | "checks" | "threads";

export type PrState = {
  phase: "idle" | "loading" | "no-pr" | "error" | "ready";
  message?: string;
  repo: string | null;
  pr: PrDetails | null;
  stack: StackInfo | null;
  tab: PaneTab;
  stackIndex: number;
  checkIndex: number;
  threadIndex: number;
  hideResolved: boolean;
  logPeek: { checkName: string; lines: string[] } | null;
  modeActive: boolean;
};

let snapshot: PrState = {
  phase: "idle",
  repo: null,
  pr: null,
  stack: null,
  tab: "overview",
  stackIndex: 0,
  checkIndex: 0,
  threadIndex: 0,
  hideResolved: true,
  logPeek: null,
  modeActive: false,
};

const listeners = new Set<() => void>();

export function getState(): PrState {
  return snapshot;
}

export function setState(update: Partial<PrState>): void {
  snapshot = { ...snapshot, ...update };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function visibleThreads(state: PrState): ReviewThread[] {
  if (!state.pr) return [];
  return state.hideResolved ? state.pr.threads.filter((thread) => !thread.isResolved) : state.pr.threads;
}

const TABS: PaneTab[] = ["overview", "checks", "threads"];

export function cycleTab(delta: 1 | -1): void {
  const index = (TABS.indexOf(snapshot.tab) + delta + TABS.length) % TABS.length;
  setState({ tab: TABS[index], logPeek: null });
}

export function selectTab(tab: PaneTab): void {
  setState({ tab, logPeek: null });
}

function clamp(value: number, length: number): number {
  return Math.min(Math.max(value, 0), Math.max(length - 1, 0));
}

export function moveSelection(delta: number | "first" | "last"): void {
  const state = snapshot;
  const move = (current: number, length: number): number => {
    if (length === 0) return 0;
    if (delta === "first") return 0;
    if (delta === "last") return length - 1;
    return clamp(current + delta, length);
  };
  switch (state.tab) {
    case "overview":
      setState({ stackIndex: move(state.stackIndex, state.stack?.entries.length ?? 0) });
      break;
    case "checks":
      setState({ checkIndex: move(state.checkIndex, state.pr?.checks.length ?? 0) });
      break;
    case "threads":
      setState({ threadIndex: move(state.threadIndex, visibleThreads(state).length) });
      break;
  }
}

export function activeThread(state: PrState): ReviewThread | null {
  const threads = visibleThreads(state);
  return threads[clamp(state.threadIndex, threads.length)] ?? null;
}

export function resetForPr(): void {
  setState({ tab: "overview", stackIndex: 0, checkIndex: 0, threadIndex: 0, logPeek: null });
}

export type TimelineFilter = "all" | "comments" | "reviews";

export function cycleTimelineFilter(current: TimelineFilter): TimelineFilter {
  const order: TimelineFilter[] = ["all", "comments", "reviews"];
  return order[(order.indexOf(current) + 1) % order.length];
}
