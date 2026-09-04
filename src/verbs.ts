import type { ExtensionDialogs, ExtensionNotifyType, ExtensionPaneControls, ExtensionReviewNavigation } from "hunkdiff/extension";
import {
  clearSessionNotes,
  fetchFailedLog,
  fetchPr,
  fetchSessionNotes,
  firstLine,
  mergeBaseAgainst,
  mustRun,
  postIssueComment,
  postReview,
  postThreadReply,
  reloadSession,
  rerunFailed,
  resolveBranchPr,
  resolveRepo,
  run,
  setThreadResolved,
  worktreeState,
  type SessionNote,
} from "./gh";
import { allowedMergeMethods, checksArePending, formatCheckState, formatDecision, summarizeChecks, type StackEntry } from "./model";
import { activeThread, getState, resetForPr, setState, visibleThreads } from "./store";

/** Satisfied structurally by both ExtensionCommandContext and ExtensionEventContext. */
export interface VerbContext {
  cwd: string;
  notify(message: string, type?: ExtensionNotifyType): void;
  readonly dialogs: ExtensionDialogs;
  readonly navigation: ExtensionReviewNavigation;
  panes: ExtensionPaneControls;
}

export type Settings = {
  pollSeconds: number;
  deleteBranch: boolean | null;
  logLines: number;
};

export const settings: Settings = { pollSeconds: 30, deleteBranch: null, logLines: 200 };

export let reviewFiles: { id: string; path: string }[] = [];

export function setReviewFiles(files: { id: string; path: string }[]): void {
  reviewFiles = files;
}

let fetchInFlight = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function managePolling(cwd: string): void {
  const state = getState();
  const shouldPoll = state.phase === "ready" && state.pr !== null && checksArePending(state.pr);
  if (shouldPoll && !pollTimer) {
    pollTimer = setInterval(() => void refreshPr(cwd), Math.max(settings.pollSeconds, 10) * 1000);
  } else if (!shouldPoll) {
    stopPolling();
  }
}

export async function refreshPr(cwd: string, notify?: (message: string) => void): Promise<void> {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    if (getState().phase === "idle") setState({ phase: "loading" });
    const repo = await resolveRepo(cwd);
    if (!repo) {
      setState({ phase: "no-pr", repo: null, pr: null, stack: null });
      return;
    }
    const number = await resolveBranchPr(cwd, repo);
    if (number === null) {
      setState({ phase: "no-pr", repo, pr: null, stack: null });
      return;
    }
    const previousNumber = getState().pr?.number;
    const { details, stack } = await fetchPr(cwd, repo, number);
    setState({ phase: "ready", message: undefined, repo, pr: details, stack });
    if (previousNumber !== details.number) resetForPr();
    notify?.(`PR #${details.number}: ${formatDecision(details.reviewDecision)}, ${summarizeChecks(details)} — press P`);
  } catch (error) {
    setState({ phase: "error", message: firstLine(error) });
  } finally {
    fetchInFlight = false;
    managePolling(cwd);
  }
}

function readyPr(ctx: VerbContext): { repo: string; number: number } | null {
  const state = getState();
  if (state.phase !== "ready" || !state.repo || !state.pr) {
    ctx.notify("gh-stacked-pr: no open PR for the checked-out branch", "warning");
    return null;
  }
  return { repo: state.repo, number: state.pr.number };
}

export async function submitReview(ctx: VerbContext, fallbackNotes: Map<string, SessionNote>): Promise<void> {
  const target = readyPr(ctx);
  if (!target) return;
  const pr = getState().pr!;

  let notes: SessionNote[];
  try {
    notes = await fetchSessionNotes(ctx.cwd);
  } catch {
    notes = [...fallbackNotes.values()];
  }

  const noteCount = notes.length;
  const confirmed = await ctx.dialogs.confirm({
    title: noteCount > 0
      ? `Submit ${noteCount} note${noteCount === 1 ? "" : "s"} to PR #${target.number}?`
      : `Submit a review with no inline notes to PR #${target.number}?`,
    body: pr.title,
    confirmLabel: "submit",
  });
  if (!confirmed) return;

  const choice = await ctx.dialogs.select({
    title: `Review type for PR #${target.number}`,
    options: ["Comment", "Approve", "Request changes"],
  });
  if (choice === null) return;
  const event = { Comment: "COMMENT", Approve: "APPROVE", "Request changes": "REQUEST_CHANGES" }[choice]!;

  const needsBody = noteCount === 0 && event === "COMMENT";
  const bodyInput = await ctx.dialogs.input({
    title: needsBody ? "Review body (required — no inline notes)" : "Review body (optional — escape to skip)",
    placeholder: "Top-level review comment",
  });
  if (bodyInput === null && needsBody) return;
  const body = (bodyInput ?? "").trim();
  if (needsBody && !body) {
    ctx.notify("gh-stacked-pr: a Comment review with no inline notes needs a body", "warning");
    return;
  }

  const payload = {
    event,
    ...(body ? { body } : event === "REQUEST_CHANGES" ? { body: "" } : {}),
    ...(noteCount > 0
      ? { comments: notes.map((note) => ({ path: note.filePath, line: note.line, side: note.side === "old" ? "LEFT" : "RIGHT", body: note.body })) }
      : {}),
  };
  try {
    await postReview(ctx.cwd, target.repo, target.number, payload);
  } catch (error) {
    ctx.notify(`gh-stacked-pr: GitHub rejected the review: ${firstLine(error)}`, "error");
    return;
  }
  if (noteCount > 0) {
    await clearSessionNotes(ctx.cwd).catch(() => {});
    fallbackNotes.clear();
  }
  ctx.notify(`Submitted ${choice} review on PR #${target.number}${noteCount > 0 ? ` with ${noteCount} comment${noteCount === 1 ? "" : "s"}` : ""}`);
  void refreshPr(ctx.cwd);
}

export async function mergePr(ctx: VerbContext): Promise<void> {
  const target = readyPr(ctx);
  if (!target) return;
  const state = getState();
  const pr = state.pr!;
  if (pr.isDraft) {
    ctx.notify("gh-stacked-pr: draft PR — mark it ready first (edit menu)", "warning");
    return;
  }

  const bodyLines = [
    `review: ${formatDecision(pr.reviewDecision)} · checks: ${summarizeChecks(pr)}`,
    `mergeable: ${pr.mergeable}${pr.mergeStateStatus ? ` (${pr.mergeStateStatus})` : ""} → ${pr.baseRefName}`,
  ];
  const parentEntry = state.stack?.entries.find((entry) => entry.headRefName === pr.baseRefName);
  if (parentEntry) bodyLines.push(`⚠ base is unmerged PR #${parentEntry.number} — merging mid-stack`);
  if (pr.autoMergeMethod) bodyLines.push(`auto-merge already enabled (${pr.autoMergeMethod.toLowerCase()})`);

  const confirmed = await ctx.dialogs.confirm({
    title: `Merge PR #${target.number}?`,
    body: bodyLines.join("\n"),
    confirmLabel: "continue",
  });
  if (!confirmed) return;

  const methods = allowedMergeMethods(pr.repoSettings);
  if (methods.length === 0) {
    ctx.notify("gh-stacked-pr: repository allows no merge methods?", "error");
    return;
  }
  const methodLabel = methods.length === 1
    ? methods[0].label
    : await ctx.dialogs.select({ title: "Merge method", options: methods.map((method) => method.label) });
  if (methodLabel === null) return;
  const method = methods.find((candidate) => candidate.label === methodLabel)!;

  let auto = false;
  if (checksArePending(pr)) {
    const pendingChoice = await ctx.dialogs.select({
      title: "Checks still pending",
      options: ["Enable auto-merge (merge when green)", "Merge now anyway"],
    });
    if (pendingChoice === null) return;
    auto = pendingChoice.startsWith("Enable");
  }

  const args = ["pr", "merge", String(target.number), "-R", target.repo, method.flag];
  if (auto) args.push("--auto");
  if (settings.deleteBranch === true) args.push("--delete-branch");
  try {
    await mustRun("gh", args, { cwd: ctx.cwd, timeoutMs: 120000 });
  } catch (error) {
    ctx.notify(`gh-stacked-pr: merge failed: ${firstLine(error)}`, "error");
    return;
  }
  ctx.notify(auto ? `Auto-merge enabled for PR #${target.number}` : `Merged PR #${target.number}`);
  void refreshPr(ctx.cwd);
}

export async function mergeStack(ctx: VerbContext): Promise<void> {
  const target = readyPr(ctx);
  if (!target) return;
  const state = getState();
  if (!state.stack?.tracked) {
    ctx.notify("gh-stacked-pr: stack merge needs a gh-stack-tracked branch", "warning");
    return;
  }
  const lines = state.stack.entries.map((entry) =>
    `${entry.isCurrent ? "▸" : " "} #${entry.number ?? "?"} ${formatCheckState(entry.checksState)} ${formatDecision(entry.reviewDecision)} ${entry.title || entry.headRefName}`,
  );
  const confirmed = await ctx.dialogs.confirm({
    title: `Merge the whole stack (${state.stack.entries.length} PRs) via gh stack merge?`,
    body: lines.join("\n"),
    confirmLabel: "merge stack",
  });
  if (!confirmed) return;
  try {
    await mustRun("gh", ["stack", "merge"], { cwd: ctx.cwd, timeoutMs: 300000 });
  } catch (error) {
    ctx.notify(`gh-stacked-pr: gh stack merge failed: ${firstLine(error)}`, "error");
    return;
  }
  ctx.notify("Stack merged");
  void refreshPr(ctx.cwd);
}

export async function replyToThread(ctx: VerbContext): Promise<void> {
  const target = readyPr(ctx);
  if (!target) return;
  const thread = activeThread(getState());
  if (!thread) {
    ctx.panes.open("pane");
    ctx.notify("gh-stacked-pr: select a thread in the Threads tab first", "warning");
    return;
  }
  const root = thread.comments[0];
  if (!root?.databaseId) {
    ctx.notify("gh-stacked-pr: thread root comment has no id to reply to", "error");
    return;
  }
  const body = await ctx.dialogs.input({
    title: `Reply to @${root.author} (${thread.path}:${thread.line ?? "?"})`,
    placeholder: "Reply…",
  });
  if (body === null || !body.trim()) return;
  try {
    await postThreadReply(ctx.cwd, target.repo, target.number, root.databaseId, body.trim());
  } catch (error) {
    ctx.notify(`gh-stacked-pr: reply failed: ${firstLine(error)}`, "error");
    return;
  }
  ctx.notify(`Replied to @${root.author}`);
  void refreshPr(ctx.cwd);
}

export async function toggleThreadResolved(ctx: VerbContext): Promise<void> {
  if (!readyPr(ctx)) return;
  const thread = activeThread(getState());
  if (!thread) {
    ctx.notify("gh-stacked-pr: select a thread in the Threads tab first", "warning");
    return;
  }
  try {
    await setThreadResolved(ctx.cwd, thread.id, !thread.isResolved);
  } catch (error) {
    ctx.notify(`gh-stacked-pr: ${thread.isResolved ? "unresolve" : "resolve"} failed: ${firstLine(error)}`, "error");
    return;
  }
  ctx.notify(thread.isResolved ? "Thread unresolved" : "Thread resolved");
  void refreshPr(ctx.cwd);
}

export async function postComment(ctx: VerbContext): Promise<void> {
  const target = readyPr(ctx);
  if (!target) return;
  const body = await ctx.dialogs.input({
    title: `Comment on PR #${target.number}`,
    placeholder: "Top-level PR comment",
  });
  if (body === null || !body.trim()) return;
  try {
    await postIssueComment(ctx.cwd, target.repo, target.number, body.trim());
  } catch (error) {
    ctx.notify(`gh-stacked-pr: comment failed: ${firstLine(error)}`, "error");
    return;
  }
  ctx.notify(`Commented on PR #${target.number}`);
  void refreshPr(ctx.cwd);
}

export async function editMetadata(ctx: VerbContext): Promise<void> {
  const target = readyPr(ctx);
  if (!target) return;
  const pr = getState().pr!;
  const options = ["Title", "Body", "Add labels", "Remove labels", "Request reviewers"];
  if (pr.isDraft) options.push("Mark ready for review");
  const choice = await ctx.dialogs.select({ title: `Edit PR #${target.number}`, options });
  if (choice === null) return;

  const editArgs = ["pr", "edit", String(target.number), "-R", target.repo];
  try {
    switch (choice) {
      case "Title": {
        const title = await ctx.dialogs.input({ title: "New title", initial: pr.title });
        if (title === null || !title.trim()) return;
        await mustRun("gh", [...editArgs, "--title", title.trim()], { cwd: ctx.cwd });
        break;
      }
      case "Body": {
        const body = await ctx.dialogs.input({ title: "New body", initial: pr.body });
        if (body === null) return;
        await mustRun("gh", [...editArgs, "--body", body], { cwd: ctx.cwd });
        break;
      }
      case "Add labels":
      case "Remove labels": {
        const flag = choice === "Add labels" ? "--add-label" : "--remove-label";
        const input = await ctx.dialogs.input({
          title: `${choice} (comma-separated)`,
          placeholder: "bug, needs-tests",
          initial: choice === "Remove labels" ? pr.labels.join(", ") : undefined,
        });
        if (input === null || !input.trim()) return;
        const labels = input.split(",").map((label) => label.trim()).filter(Boolean);
        await mustRun("gh", [...editArgs, ...labels.flatMap((label) => [flag, label])], { cwd: ctx.cwd });
        break;
      }
      case "Request reviewers": {
        const input = await ctx.dialogs.input({ title: "Reviewers (comma-separated logins)", placeholder: "alice, bob" });
        if (input === null || !input.trim()) return;
        const reviewers = input.split(",").map((reviewer) => reviewer.trim()).filter(Boolean);
        await mustRun("gh", [...editArgs, ...reviewers.flatMap((reviewer) => ["--add-reviewer", reviewer])], { cwd: ctx.cwd });
        break;
      }
      case "Mark ready for review":
        await mustRun("gh", ["pr", "ready", String(target.number), "-R", target.repo], { cwd: ctx.cwd });
        break;
    }
  } catch (error) {
    ctx.notify(`gh-stacked-pr: edit failed: ${firstLine(error)}`, "error");
    return;
  }
  ctx.notify(`Updated PR #${target.number} (${choice.toLowerCase()})`);
  void refreshPr(ctx.cwd);
}

export async function switchToStackEntry(ctx: VerbContext, entry: StackEntry): Promise<void> {
  const state = getState();
  if (entry.isCurrent) {
    ctx.notify("gh-stacked-pr: already reviewing that PR");
    return;
  }
  if ((await worktreeState(ctx.cwd)) === "dirty") {
    const stash = await ctx.dialogs.confirm({
      title: "Working tree has uncommitted changes",
      body: "Stash them and switch? (git stash push)",
      confirmLabel: "stash + switch",
    });
    if (!stash) return;
    try {
      await mustRun("git", ["stash", "push"], { cwd: ctx.cwd });
    } catch (error) {
      ctx.notify(`gh-stacked-pr: stash failed: ${firstLine(error)}`, "error");
      return;
    }
  }
  try {
    if (state.stack?.tracked) {
      await mustRun("gh", ["stack", "checkout", entry.headRefName], { cwd: ctx.cwd, timeoutMs: 120000 });
    } else if (entry.number !== null) {
      await mustRun("gh", ["pr", "checkout", String(entry.number)], { cwd: ctx.cwd, timeoutMs: 120000 });
    } else {
      await mustRun("git", ["checkout", entry.headRefName], { cwd: ctx.cwd });
    }
    const baseRefName = entry.baseRefName ?? state.pr?.baseRefName ?? "main";
    const mergeBase = await mergeBaseAgainst(ctx.cwd, baseRefName);
    await reloadSession(ctx.cwd, mergeBase);
  } catch (error) {
    ctx.notify(`gh-stacked-pr: switch failed: ${firstLine(error)}`, "error");
    return;
  }
  ctx.notify(`Switched to ${entry.number !== null ? `PR #${entry.number}` : entry.headRefName}`);
}

export async function switchAdjacent(ctx: VerbContext, delta: 1 | -1): Promise<void> {
  const state = getState();
  if (!state.stack) {
    ctx.notify("gh-stacked-pr: not in a stack", "warning");
    return;
  }
  const index = state.stack.entries.findIndex((entry) => entry.isCurrent);
  const targetEntry = state.stack.entries[index + delta];
  if (index < 0 || !targetEntry) {
    ctx.notify(`gh-stacked-pr: already at the ${delta === 1 ? "top" : "bottom"} of the stack`);
    return;
  }
  await switchToStackEntry(ctx, targetEntry);
}

export async function toggleLogPeek(ctx: VerbContext): Promise<void> {
  const state = getState();
  if (state.logPeek) {
    setState({ logPeek: null });
    return;
  }
  const target = readyPr(ctx);
  if (!target) return;
  const check = state.pr!.checks[state.checkIndex];
  if (!check) {
    ctx.notify("gh-stacked-pr: no check selected", "warning");
    return;
  }
  if (check.runId === null) {
    ctx.notify(`gh-stacked-pr: ${check.name} has no workflow run log`, "warning");
    return;
  }
  setState({ logPeek: { checkName: check.name, lines: ["loading…"] } });
  try {
    const lines = await fetchFailedLog(ctx.cwd, target.repo, check.runId, settings.logLines);
    setState({ logPeek: { checkName: check.name, lines: lines.length > 0 ? lines : ["(no failed-step log output)"] } });
  } catch (error) {
    setState({ logPeek: { checkName: check.name, lines: [`log fetch failed: ${firstLine(error)}`] } });
  }
}

export async function rerunFailedChecks(ctx: VerbContext): Promise<void> {
  const target = readyPr(ctx);
  if (!target) return;
  const failedRunIds = [...new Set(
    getState().pr!.checks
      .filter((check) => check.status === "COMPLETED" && check.conclusion !== "SUCCESS" && check.conclusion !== "NEUTRAL" && check.conclusion !== "SKIPPED" && check.runId !== null)
      .map((check) => check.runId!),
  )];
  if (failedRunIds.length === 0) {
    ctx.notify("gh-stacked-pr: no failed workflow runs to rerun");
    return;
  }
  for (const runId of failedRunIds) {
    try {
      await rerunFailed(ctx.cwd, target.repo, runId);
    } catch (error) {
      ctx.notify(`gh-stacked-pr: rerun of run ${runId} failed: ${firstLine(error)}`, "error");
      return;
    }
  }
  ctx.notify(`Requested rerun of ${failedRunIds.length} failed run${failedRunIds.length === 1 ? "" : "s"}`);
  void refreshPr(ctx.cwd);
}

export function revealActiveThread(ctx: VerbContext): void {
  const thread = activeThread(getState());
  if (!thread || thread.line === null) return;
  const file = reviewFiles.find((candidate) => candidate.path === thread.path);
  if (!file) return;
  ctx.navigation.revealLine(file.id, thread.side === "LEFT" ? "old" : "new", thread.line);
}

export function threadsForHighlight(): { path: string; side: "old" | "new"; line: number }[] {
  const state = getState();
  if (state.phase !== "ready") return [];
  return visibleThreads(state)
    .filter((thread) => !thread.isResolved && thread.line !== null)
    .map((thread) => ({ path: thread.path, side: thread.side === "LEFT" ? "old" as const : "new" as const, line: thread.line! }));
}
