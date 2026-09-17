export type ThreadComment = {
  databaseId: number | null;
  author: string;
  body: string;
  createdAt: string;
};

export type ReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  comments: ThreadComment[];
};

export type Check = {
  name: string;
  kind: "check-run" | "status";
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runId: number | null;
  workflow: string | null;
};

export type TimelineItem = {
  kind: "comment" | "review" | "force-push" | "commit" | "merged" | "review-requested";
  author: string;
  body: string | null;
  reviewState: string | null;
  createdAt: string;
};

export type RepoSettings = {
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  deleteBranchOnMerge: boolean;
};

export type OpenPrSummary = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
  checksState: string | null;
};

export type PrDetails = {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  author: string;
  baseRefName: string;
  headRefName: string;
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus: string | null;
  autoMergeMethod: string | null;
  labels: string[];
  assignees: string[];
  reviewRequests: string[];
  threads: ReviewThread[];
  checks: Check[];
  checksState: string | null;
  timeline: TimelineItem[];
  repoSettings: RepoSettings;
};

export type StackEntry = {
  number: number | null;
  title: string;
  headRefName: string;
  baseRefName: string | null;
  reviewDecision: string | null;
  checksState: string | null;
  isCurrent: boolean;
};

export type StackInfo = {
  tracked: boolean;
  entries: StackEntry[];
};

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function login(node: unknown): string {
  if (node && typeof node === "object" && "login" in node) return str((node as { login: unknown }).login, "ghost");
  return "ghost";
}

function nodes(value: unknown): unknown[] {
  if (value && typeof value === "object" && Array.isArray((value as { nodes?: unknown }).nodes)) {
    return (value as { nodes: unknown[] }).nodes;
  }
  return [];
}

export function parseRollupState(commitNodes: unknown): string | null {
  const [first] = nodes(commitNodes);
  const commit = (first as { commit?: { statusCheckRollup?: { state?: unknown } | null } } | undefined)?.commit;
  const state = commit?.statusCheckRollup?.state;
  return typeof state === "string" ? state : null;
}

export function parseChecks(commitNodes: unknown): Check[] {
  const [first] = nodes(commitNodes);
  const commit = (first as { commit?: { statusCheckRollup?: { contexts?: unknown } | null } } | undefined)?.commit;
  const checks: Check[] = [];
  for (const raw of nodes(commit?.statusCheckRollup?.contexts)) {
    const context = raw as Record<string, unknown>;
    if (context.__typename === "CheckRun") {
      const suite = context.checkSuite as { workflowRun?: { databaseId?: unknown; workflow?: { name?: unknown } } | null } | null;
      checks.push({
        name: str(context.name, "(check)"),
        kind: "check-run",
        status: str(context.status, "UNKNOWN"),
        conclusion: typeof context.conclusion === "string" ? context.conclusion : null,
        startedAt: typeof context.startedAt === "string" ? context.startedAt : null,
        completedAt: typeof context.completedAt === "string" ? context.completedAt : null,
        runId: typeof suite?.workflowRun?.databaseId === "number" ? suite.workflowRun.databaseId : null,
        workflow: typeof suite?.workflowRun?.workflow?.name === "string" ? suite.workflowRun.workflow.name : null,
      });
    } else if (context.__typename === "StatusContext") {
      const state = str(context.state, "UNKNOWN");
      checks.push({
        name: str(context.context, "(status)"),
        kind: "status",
        status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: state === "PENDING" ? null : state,
        startedAt: typeof context.createdAt === "string" ? context.createdAt : null,
        completedAt: null,
        runId: null,
        workflow: null,
      });
    }
  }
  return checks;
}

export function parsePrDetails(pullRequest: Record<string, unknown>, repository: Record<string, unknown>): PrDetails {
  const threads: ReviewThread[] = nodes(pullRequest.reviewThreads).map((raw) => {
    const thread = raw as Record<string, unknown>;
    return {
      id: str(thread.id),
      isResolved: thread.isResolved === true,
      isOutdated: thread.isOutdated === true,
      path: str(thread.path),
      line: typeof thread.line === "number" ? thread.line : null,
      side: thread.diffSide === "LEFT" ? "LEFT" : "RIGHT",
      comments: nodes(thread.comments).map((commentRaw) => {
        const comment = commentRaw as Record<string, unknown>;
        return {
          databaseId: typeof comment.databaseId === "number" ? comment.databaseId : null,
          author: login(comment.author),
          body: str(comment.body),
          createdAt: str(comment.createdAt),
        };
      }),
    };
  });

  const timeline: TimelineItem[] = [];
  for (const raw of nodes(pullRequest.timelineItems)) {
    const item = raw as Record<string, unknown>;
    switch (item.__typename) {
      case "IssueComment":
        timeline.push({ kind: "comment", author: login(item.author), body: str(item.body), reviewState: null, createdAt: str(item.createdAt) });
        break;
      case "PullRequestReview":
        timeline.push({ kind: "review", author: login(item.author), body: str(item.body) || null, reviewState: str(item.state, "COMMENTED"), createdAt: str(item.createdAt) });
        break;
      case "HeadRefForcePushedEvent":
        timeline.push({ kind: "force-push", author: login(item.actor), body: null, reviewState: null, createdAt: str(item.createdAt) });
        break;
      case "PullRequestCommit": {
        const commit = item.commit as Record<string, unknown> | undefined;
        timeline.push({
          kind: "commit",
          author: str(commit?.abbreviatedOid, "commit"),
          body: str(commit?.messageHeadline) || null,
          reviewState: null,
          createdAt: str(commit?.committedDate),
        });
        break;
      }
      case "MergedEvent":
        timeline.push({ kind: "merged", author: login(item.actor), body: null, reviewState: null, createdAt: str(item.createdAt) });
        break;
      case "ReviewRequestedEvent":
        timeline.push({
          kind: "review-requested",
          author: login(item.actor),
          body: login(item.requestedReviewer),
          reviewState: null,
          createdAt: str(item.createdAt),
        });
        break;
    }
  }

  const autoMerge = pullRequest.autoMergeRequest as { mergeMethod?: unknown } | null;
  return {
    number: typeof pullRequest.number === "number" ? pullRequest.number : 0,
    title: str(pullRequest.title),
    body: str(pullRequest.body),
    state: str(pullRequest.state, "OPEN"),
    isDraft: pullRequest.isDraft === true,
    author: login(pullRequest.author),
    baseRefName: str(pullRequest.baseRefName),
    headRefName: str(pullRequest.headRefName),
    reviewDecision: typeof pullRequest.reviewDecision === "string" ? pullRequest.reviewDecision : null,
    mergeable: str(pullRequest.mergeable, "UNKNOWN"),
    mergeStateStatus: typeof pullRequest.mergeStateStatus === "string" ? pullRequest.mergeStateStatus : null,
    autoMergeMethod: typeof autoMerge?.mergeMethod === "string" ? autoMerge.mergeMethod : null,
    labels: nodes(pullRequest.labels).map((node) => str((node as { name?: unknown }).name)).filter(Boolean),
    assignees: nodes(pullRequest.assignees).map((node) => login(node)),
    reviewRequests: nodes(pullRequest.reviewRequests).map((node) => {
      const reviewer = (node as { requestedReviewer?: unknown }).requestedReviewer as Record<string, unknown> | null;
      return str(reviewer?.login) || str(reviewer?.name);
    }).filter(Boolean),
    threads,
    checks: parseChecks(pullRequest.commits),
    checksState: parseRollupState(pullRequest.commits),
    timeline,
    repoSettings: {
      mergeCommitAllowed: repository.mergeCommitAllowed === true,
      squashMergeAllowed: repository.squashMergeAllowed === true,
      rebaseMergeAllowed: repository.rebaseMergeAllowed === true,
      deleteBranchOnMerge: repository.deleteBranchOnMerge === true,
    },
  };
}

export function parseOpenPrs(pullRequests: unknown): OpenPrSummary[] {
  return nodes(pullRequests).map((raw) => {
    const pullRequest = raw as Record<string, unknown>;
    return {
      number: typeof pullRequest.number === "number" ? pullRequest.number : 0,
      title: str(pullRequest.title),
      headRefName: str(pullRequest.headRefName),
      baseRefName: str(pullRequest.baseRefName),
      isDraft: pullRequest.isDraft === true,
      reviewDecision: typeof pullRequest.reviewDecision === "string" ? pullRequest.reviewDecision : null,
      checksState: parseRollupState(pullRequest.commits),
    };
  });
}

/** Trunk-first linear chain around the current PR, from open-PR base→head links. */
export function chainStack(current: { number: number; headRefName: string; baseRefName: string }, openPrs: OpenPrSummary[]): StackEntry[] {
  const byHead = new Map(openPrs.map((pr) => [pr.headRefName, pr]));
  const byBase = new Map<string, OpenPrSummary>();
  for (const pr of openPrs) {
    if (!byBase.has(pr.baseRefName)) byBase.set(pr.baseRefName, pr);
  }

  const toEntry = (pr: OpenPrSummary, isCurrent: boolean): StackEntry => ({
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    reviewDecision: pr.reviewDecision,
    checksState: pr.checksState,
    isCurrent,
  });

  const ancestors: StackEntry[] = [];
  const seen = new Set([current.headRefName]);
  let baseRef = current.baseRefName;
  while (byHead.has(baseRef) && !seen.has(baseRef)) {
    const parent = byHead.get(baseRef)!;
    seen.add(parent.headRefName);
    ancestors.unshift(toEntry(parent, false));
    baseRef = parent.baseRefName;
  }

  const descendants: StackEntry[] = [];
  let headRef = current.headRefName;
  while (byBase.has(headRef) && !seen.has(byBase.get(headRef)!.headRefName)) {
    const child = byBase.get(headRef)!;
    seen.add(child.headRefName);
    descendants.push(toEntry(child, false));
    headRef = child.headRefName;
  }

  const self = byHead.get(current.headRefName);
  const currentEntry: StackEntry = self
    ? toEntry(self, true)
    : { number: current.number, title: "", headRefName: current.headRefName, baseRefName: current.baseRefName, reviewDecision: null, checksState: null, isCurrent: true };
  return [...ancestors, currentEntry, ...descendants];
}

/**
 * Tolerant reader for `gh stack view --json` (schema unpinned at v0.1.0):
 * accepts a top-level array or any object holding one array of entries that
 * carry a branch name, and yields branch names plus PR numbers when present.
 */
export function parseGhStackView(parsed: unknown): { branch: string; prNumber: number | null }[] | null {
  const candidates: unknown[] = [];
  if (Array.isArray(parsed)) candidates.push(parsed);
  else if (parsed && typeof parsed === "object") {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) candidates.push(value);
    }
  }
  for (const candidate of candidates as unknown[][]) {
    const entries: { branch: string; prNumber: number | null }[] = [];
    for (const raw of candidate) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const branch = str(entry.branch) || str(entry.name) || str(entry.ref) || str(entry.headRefName);
      if (!branch) continue;
      const pr = entry.pr as Record<string, unknown> | undefined;
      const prNumber =
        typeof entry.prNumber === "number" ? entry.prNumber :
        typeof entry.number === "number" ? entry.number :
        typeof pr?.number === "number" ? pr.number : null;
      entries.push({ branch, prNumber });
    }
    if (entries.length > 0) return entries;
  }
  return null;
}

export function buildStack(
  current: { number: number; headRefName: string; baseRefName: string },
  openPrs: OpenPrSummary[],
  ghStackBranches: { branch: string; prNumber: number | null }[] | null,
): StackInfo | null {
  const chained = chainStack(current, openPrs);
  if (ghStackBranches) {
    const chainedBranches = new Set(chained.map((entry) => entry.headRefName));
    const extras = ghStackBranches
      .filter((entry) => !chainedBranches.has(entry.branch))
      .map((entry): StackEntry => {
        const open = openPrs.find((pr) => pr.number === entry.prNumber || pr.headRefName === entry.branch);
        return open
          ? { number: open.number, title: open.title, headRefName: open.headRefName, baseRefName: open.baseRefName, reviewDecision: open.reviewDecision, checksState: open.checksState, isCurrent: false }
          : { number: entry.prNumber, title: "", headRefName: entry.branch, baseRefName: null, reviewDecision: null, checksState: null, isCurrent: false };
      });
    return { tracked: true, entries: [...chained, ...extras] };
  }
  if (chained.length <= 1) return null;
  return { tracked: false, entries: chained };
}

export function allowedMergeMethods(settings: RepoSettings): { label: string; flag: string }[] {
  const methods: { label: string; flag: string }[] = [];
  if (settings.squashMergeAllowed) methods.push({ label: "Squash", flag: "--squash" });
  if (settings.mergeCommitAllowed) methods.push({ label: "Merge commit", flag: "--merge" });
  if (settings.rebaseMergeAllowed) methods.push({ label: "Rebase", flag: "--rebase" });
  return methods;
}

export function checksArePending(details: Pick<PrDetails, "checks" | "checksState">): boolean {
  if (details.checksState === "PENDING") return true;
  return details.checks.some((check) => check.status !== "COMPLETED");
}

export function summarizeChecks(details: Pick<PrDetails, "checks" | "checksState">): string {
  if (details.checks.length === 0) return "no checks";
  const failed = details.checks.filter((check) => check.status === "COMPLETED" && check.conclusion !== "SUCCESS" && check.conclusion !== "NEUTRAL" && check.conclusion !== "SKIPPED").length;
  const pending = details.checks.filter((check) => check.status !== "COMPLETED").length;
  const passed = details.checks.length - failed - pending;
  const parts = [`${passed} ✓`];
  if (failed > 0) parts.push(`${failed} ✗`);
  if (pending > 0) parts.push(`${pending} …`);
  return parts.join(" ");
}

export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    let currentLine = "";
    for (const word of words) {
      if (!currentLine) currentLine = word;
      else if (`${currentLine} ${word}`.length <= width) currentLine += ` ${word}`;
      else {
        out.push(currentLine);
        currentLine = word;
      }
    }
    out.push(currentLine);
  }
  return out.length > 0 ? out : [""];
}

/** Text of one source line as the patch carries it, for highlight extents. */
export function patchLineText(patch: string, side: "old" | "new", line: number): string | null {
  let oldLine = 0;
  let newLine = 0;
  for (const rawLine of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (header) {
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[2], 10);
      continue;
    }
    if (oldLine === 0 && newLine === 0) continue;
    const marker = rawLine[0];
    if (marker === "-") {
      if (side === "old" && oldLine === line) return rawLine.slice(1);
      oldLine += 1;
    } else if (marker === "+") {
      if (side === "new" && newLine === line) return rawLine.slice(1);
      newLine += 1;
    } else if (marker === " " || rawLine === "") {
      if (side === "old" && oldLine === line) return rawLine.slice(1);
      if (side === "new" && newLine === line) return rawLine.slice(1);
      oldLine += 1;
      newLine += 1;
    }
  }
  return null;
}

export function formatDecision(decision: string | null): string {
  switch (decision) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "REVIEW_REQUIRED": return "review required";
    default: return "no review";
  }
}

export function formatCheckState(state: string | null): string {
  switch (state) {
    case "SUCCESS": return "✓";
    case "FAILURE": case "ERROR": return "✗";
    case "PENDING": return "…";
    default: return "·";
  }
}

export function formatCheckDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "";
  const seconds = Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}
