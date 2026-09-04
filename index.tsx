import type { ExtensionKeyEvent, ExtensionLineHighlight, HunkExtensionAPI } from "hunkdiff/extension";
import { setEmitter, VERB_EVENT, type VerbEvent } from "./src/dispatch";
import type { SessionNote } from "./src/gh";
import { patchLineText } from "./src/model";
import { PrPane } from "./src/pane";
import { cycleTab, getState, moveSelection, selectTab, setState } from "./src/store";
import {
  editMetadata,
  mergePr,
  mergeStack,
  postComment,
  refreshPr,
  replyToThread,
  rerunFailedChecks,
  revealActiveThread,
  setReviewFiles,
  settings,
  stopPolling,
  submitReview,
  switchAdjacent,
  switchToStackEntry,
  threadsForHighlight,
  toggleLogPeek,
  toggleThreadResolved,
  type VerbContext,
} from "./src/verbs";

export default function (hunk: HunkExtensionAPI) {
  if (typeof hunk.config.poll_seconds === "number") settings.pollSeconds = hunk.config.poll_seconds;
  if (typeof hunk.config.delete_branch === "boolean") settings.deleteBranch = hunk.config.delete_branch;
  if (typeof hunk.config.log_lines === "number") settings.logLines = hunk.config.log_lines;
  if (hunk.config.hide_resolved === false) setState({ hideResolved: false });

  const fallbackNotes = new Map<string, SessionNote>();
  const trackNote = (note: { id: string; draft: boolean; filePath: string; side: "old" | "new"; line: number; body: string }) => {
    if (!note.draft && note.body) {
      fallbackNotes.set(note.id, { filePath: note.filePath, side: note.side, line: note.line, body: note.body });
    }
  };
  hunk.on("note_created", ({ note }) => trackNote(note));
  hunk.on("note_edited", ({ note }) => trackNote(note));

  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    setReviewFiles(changeset.files.map((file) => ({ id: file.id, path: file.path })));
    void refreshPr(ctx.cwd, (message) => ctx.notify(message));
  });
  hunk.on("session_reload", ({ changeset }, ctx) => {
    setReviewFiles(changeset.files.map((file) => ({ id: file.id, path: file.path })));
    void refreshPr(ctx.cwd, (message) => ctx.notify(message));
  });
  hunk.on("shutdown", () => stopPolling());

  const runVerb = async (event: VerbEvent, ctx: VerbContext): Promise<void> => {
    switch (event.kind) {
      case "submit": return submitReview(ctx, fallbackNotes);
      case "merge": return mergePr(ctx);
      case "merge-stack": return mergeStack(ctx);
      case "reply": return replyToThread(ctx);
      case "resolve": return toggleThreadResolved(ctx);
      case "comment": return postComment(ctx);
      case "edit": return editMetadata(ctx);
      case "refresh": {
        await refreshPr(ctx.cwd);
        ctx.notify(getState().phase === "ready" ? "PR refreshed" : "PR unavailable for this review", getState().phase === "ready" ? "info" : "warning");
        return;
      }
      case "log-peek": return toggleLogPeek(ctx);
      case "rerun": return rerunFailedChecks(ctx);
      case "switch": return switchAdjacent(ctx, event.delta);
      case "switch-entry": {
        const entry = getState().stack?.entries[event.index];
        if (entry) await switchToStackEntry(ctx, entry);
        return;
      }
      case "reveal-thread": return revealActiveThread(ctx);
    }
  };
  setEmitter((event) => hunk.events.emit(VERB_EVENT, event));
  hunk.events.on<VerbEvent>(VERB_EVENT, (event, ctx) => void runVerb(event, ctx));

  const placementRaw = typeof hunk.config.placement === "string" ? hunk.config.placement : "right";
  const placement = (["left", "right", "top", "bottom"] as const).includes(placementRaw as "left")
    ? (placementRaw as "left" | "right" | "top" | "bottom")
    : "right";
  hunk.registerPane(
    placement === "top" || placement === "bottom"
      ? { id: "pane", title: "PR", placement, height: { preferred: 14, min: 5 }, component: PrPane }
      : { id: "pane", title: "PR", placement, width: { preferred: 46, min: 24 }, component: PrPane },
  );

  hunk.registerLineHighlighter({
    id: "threads",
    highlight(input) {
      const marks: ExtensionLineHighlight[] = [];
      for (const thread of threadsForHighlight()) {
        if (thread.path !== input.file.path) continue;
        const text = patchLineText(input.file.patch, thread.side, thread.line);
        if (text === null) continue;
        marks.push({ side: thread.side, line: thread.line, range: [0, Math.max(text.length, 1)], tone: "info" });
      }
      return marks;
    },
  });

  hunk.registerKeyboardMode({
    id: "pr",
    title: "PR review",
    onKey: (key: ExtensionKeyEvent) => {
      const char = key.sequence && key.sequence.length === 1 && key.sequence >= " " ? key.sequence : key.name;
      if (key.name === "tab" || key.name === "backtab") {
        cycleTab(key.shift || key.name === "backtab" ? -1 : 1);
        return "handled";
      }
      if (key.name === "return" || key.name === "enter") {
        const state = getState();
        if (state.tab === "overview") dispatchVerb({ kind: "switch-entry", index: state.stackIndex });
        else if (state.tab === "checks") dispatchVerb({ kind: "log-peek" });
        else dispatchVerb({ kind: "reveal-thread" });
        return "handled";
      }
      switch (char) {
        case "1": selectTab("overview"); return "handled";
        case "2": selectTab("checks"); return "handled";
        case "3": selectTab("threads"); return "handled";
        case "j": case "down": moveSelection(1); if (getState().tab === "threads") dispatchVerb({ kind: "reveal-thread" }); return "handled";
        case "k": case "up": moveSelection(-1); if (getState().tab === "threads") dispatchVerb({ kind: "reveal-thread" }); return "handled";
        case "g": moveSelection("first"); return "handled";
        case "G": moveSelection("last"); return "handled";
        case "[": dispatchVerb({ kind: "switch", delta: -1 }); return "handled";
        case "]": dispatchVerb({ kind: "switch", delta: 1 }); return "handled";
        case "s": dispatchVerb({ kind: "submit" }); return "handled";
        case "m": dispatchVerb({ kind: "merge" }); return "handled";
        case "M": dispatchVerb({ kind: "merge-stack" }); return "handled";
        case "r": dispatchVerb({ kind: "reply" }); return "handled";
        case "x": dispatchVerb({ kind: "resolve" }); return "handled";
        case "e": dispatchVerb({ kind: "edit" }); return "handled";
        case "C": dispatchVerb({ kind: "comment" }); return "handled";
        case "R": dispatchVerb({ kind: "refresh" }); return "handled";
        case "u": dispatchVerb({ kind: "rerun" }); return "handled";
        case "h":
          setState({ hideResolved: !getState().hideResolved, threadIndex: 0 });
          return "handled";
        case "q": return "exit";
        default: return "pass";
      }
    },
    onEnter: () => setState({ modeActive: true }),
    onExit: () => setState({ modeActive: false }),
  });
  const dispatchVerb = (event: VerbEvent) => hunk.events.emit(VERB_EVENT, event);

  hunk.registerCommand({ id: "open", title: "PR pane + review mode", key: "P" }, (ctx) => {
    const willOpen = !ctx.panes.isOpen("pane");
    ctx.panes.toggle("pane");
    if (willOpen) {
      ctx.highlights.refresh("threads");
      if (getState().phase === "ready") ctx.keyboardModes.enterMode("pr");
      else ctx.notify("gh-stacked-pr: no PR state for this review", "warning");
    } else if (ctx.keyboardModes.isActive("pr")) {
      ctx.keyboardModes.exitMode();
    }
  });

  hunk.registerCommand({ id: "submit", title: "Submit notes as GitHub review", key: "S" }, (ctx) => submitReview(ctx, fallbackNotes));
  hunk.registerCommand({ id: "merge", title: "Merge PR" }, (ctx) => mergePr(ctx));
  hunk.registerCommand({ id: "merge-stack", title: "Merge whole stack (gh stack)" }, (ctx) => mergeStack(ctx));
  hunk.registerCommand({ id: "reply", title: "Reply to selected PR thread" }, (ctx) => replyToThread(ctx));
  hunk.registerCommand({ id: "resolve", title: "Resolve/unresolve selected thread" }, (ctx) => toggleThreadResolved(ctx));
  hunk.registerCommand({ id: "comment", title: "Comment on PR conversation" }, (ctx) => postComment(ctx));
  hunk.registerCommand({ id: "edit", title: "Edit PR metadata" }, (ctx) => editMetadata(ctx));
  hunk.registerCommand({ id: "rerun", title: "Rerun failed checks" }, (ctx) => rerunFailedChecks(ctx));
  hunk.registerCommand({ id: "refresh", title: "Refresh PR state" }, async (ctx) => {
    await refreshPr(ctx.cwd);
    ctx.highlights.refresh("threads");
    ctx.notify(getState().phase === "ready" ? "PR refreshed" : "PR unavailable for this review", getState().phase === "ready" ? "info" : "warning");
  });
  hunk.registerCommand({ id: "stack-next", title: "Switch to next PR in stack" }, (ctx) => switchAdjacent(ctx, 1));
  hunk.registerCommand({ id: "stack-prev", title: "Switch to previous PR in stack" }, (ctx) => switchAdjacent(ctx, -1));
}
