export type VerbEvent =
  | { kind: "submit" }
  | { kind: "merge" }
  | { kind: "merge-stack" }
  | { kind: "reply" }
  | { kind: "resolve" }
  | { kind: "comment" }
  | { kind: "edit" }
  | { kind: "refresh" }
  | { kind: "log-peek" }
  | { kind: "rerun" }
  | { kind: "switch"; delta: 1 | -1 }
  | { kind: "switch-entry"; index: number }
  | { kind: "reveal-thread" };

export const VERB_EVENT = "hunk-gh-stacked-pr:verb";

let emitter: ((event: VerbEvent) => void) | null = null;

export function setEmitter(emit: (event: VerbEvent) => void): void {
  emitter = emit;
}

export function dispatch(event: VerbEvent): void {
  emitter?.(event);
}
