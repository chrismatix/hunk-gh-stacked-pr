import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStack,
  parseGhStackView,
  parseOpenPrs,
  parsePrDetails,
  type PrDetails,
  type StackInfo,
} from "./model";

export function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    }
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

export async function mustRun(command: string, args: string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || `${command} exited ${result.code}`);
  }
  return result.stdout;
}

export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/** owner/repo of the current branch's tracking remote (else origin); null when unresolvable. */
export async function resolveRepo(cwd: string): Promise<string | null> {
  let remote = "origin";
  try {
    const branch = (await mustRun("git", ["branch", "--show-current"], { cwd })).trim();
    if (branch) {
      const configured = await run("git", ["config", `branch.${branch}.remote`], { cwd });
      if (configured.code === 0 && configured.stdout.trim()) remote = configured.stdout.trim();
    }
  } catch {
    return null;
  }
  const url = await run("git", ["remote", "get-url", remote], { cwd });
  if (url.code !== 0) return null;
  const match = url.stdout.trim().replace(/^git@[^:]+:/, "").replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
  return match || null;
}

export async function resolveBranchPr(cwd: string, repo: string): Promise<number | null> {
  const result = await run("gh", ["pr", "view", "--json", "number", "--jq", ".number", "-R", repo], { cwd });
  if (result.code !== 0) return null;
  const number = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(number) ? number : null;
}

const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequests(states: OPEN, first: 100) {
      nodes {
        number title headRefName baseRefName isDraft reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    pullRequest(number: $number) {
      number title body state isDraft baseRefName headRefName
      reviewDecision mergeable mergeStateStatus
      author { login }
      autoMergeRequest { mergeMethod }
      labels(first: 20) { nodes { name } }
      assignees(first: 10) { nodes { login } }
      reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line diffSide
          comments(first: 50) { nodes { databaseId author { login } body createdAt } }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion startedAt completedAt
                    checkSuite { workflowRun { databaseId workflow { name } } }
                  }
                  ... on StatusContext { context state createdAt }
                }
              }
            }
          }
        }
      }
      timelineItems(last: 30, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_COMMIT, MERGED_EVENT, REVIEW_REQUESTED_EVENT]) {
        nodes {
          __typename
          ... on IssueComment { author { login } body createdAt }
          ... on PullRequestReview { author { login } body state createdAt }
          ... on HeadRefForcePushedEvent { actor { login } createdAt }
          ... on PullRequestCommit { commit { abbreviatedOid messageHeadline committedDate } }
          ... on MergedEvent { actor { login } createdAt }
          ... on ReviewRequestedEvent { actor { login } createdAt requestedReviewer { ... on User { login } } }
        }
      }
    }
  }
}`;

export async function fetchPr(cwd: string, repo: string, number: number): Promise<{ details: PrDetails; stack: StackInfo | null }> {
  const [owner, name] = repo.split("/");
  const output = await mustRun("gh", [
    "api", "graphql",
    "-f", `query=${PR_QUERY}`,
    "-f", `owner=${owner}`,
    "-f", `name=${name}`,
    "-F", `number=${number}`,
  ], { cwd });
  const repository = JSON.parse(output)?.data?.repository;
  if (!repository?.pullRequest) throw new Error(`PR #${number} not found in ${repo}`);
  const details = parsePrDetails(repository.pullRequest, repository);
  const openPrs = parseOpenPrs(repository.pullRequests);
  const ghStackBranches = await fetchGhStackBranches(cwd);
  const stack = buildStack(
    { number: details.number, headRefName: details.headRefName, baseRefName: details.baseRefName },
    openPrs,
    ghStackBranches,
  );
  return { details, stack };
}

async function fetchGhStackBranches(cwd: string): Promise<{ branch: string; prNumber: number | null }[] | null> {
  const result = await run("gh", ["stack", "view", "--json"], { cwd, timeoutMs: 15000 });
  if (result.code !== 0) return null;
  try {
    return parseGhStackView(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

export async function postReview(
  cwd: string,
  repo: string,
  number: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const temporaryPath = join(tmpdir(), `hunk-gh-stacked-pr-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(temporaryPath, JSON.stringify(payload));
  try {
    await mustRun("gh", ["api", `repos/${repo}/pulls/${number}/reviews`, "--method", "POST", "--input", temporaryPath], { cwd });
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {}
  }
}

export async function postThreadReply(cwd: string, repo: string, number: number, commentId: number, body: string): Promise<void> {
  await mustRun("gh", ["api", `repos/${repo}/pulls/${number}/comments/${commentId}/replies`, "--method", "POST", "-f", `body=${body}`], { cwd });
}

export async function postIssueComment(cwd: string, repo: string, number: number, body: string): Promise<void> {
  await mustRun("gh", ["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "-f", `body=${body}`], { cwd });
}

export async function setThreadResolved(cwd: string, threadId: string, resolved: boolean): Promise<void> {
  const mutation = resolved
    ? "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }"
    : "mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }";
  await mustRun("gh", ["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${threadId}`], { cwd });
}

export async function fetchFailedLog(cwd: string, repo: string, runId: number, maxLines: number): Promise<string[]> {
  const result = await run("gh", ["run", "view", String(runId), "--log-failed", "-R", repo], { cwd, timeoutMs: 60000 });
  const text = result.code === 0 ? result.stdout : result.stdout || result.stderr;
  const lines = text.split("\n").filter((line) => line.length > 0);
  return lines.slice(-maxLines);
}

export async function rerunFailed(cwd: string, repo: string, runId: number): Promise<void> {
  await mustRun("gh", ["run", "rerun", String(runId), "--failed", "-R", repo], { cwd });
}

export type WorktreeState = "clean" | "dirty";

export async function worktreeState(cwd: string): Promise<WorktreeState> {
  const status = await mustRun("git", ["status", "--porcelain"], { cwd });
  return status.split("\n").some((line) => line.length > 0 && !line.startsWith("??")) ? "dirty" : "clean";
}

export async function mergeBaseAgainst(cwd: string, baseRefName: string): Promise<string> {
  await run("git", ["fetch", "origin", baseRefName, "--quiet"], { cwd, timeoutMs: 60000 });
  const viaRemote = await run("git", ["merge-base", "HEAD", `origin/${baseRefName}`], { cwd });
  if (viaRemote.code === 0 && viaRemote.stdout.trim()) return viaRemote.stdout.trim();
  return (await mustRun("git", ["merge-base", "HEAD", baseRefName], { cwd })).trim();
}

export async function reloadSession(cwd: string, mergeBase: string): Promise<void> {
  await mustRun("hunk", ["session", "reload", "--repo", cwd, "--", "diff", mergeBase], { cwd });
}

export type SessionNote = { filePath: string; side: "old" | "new"; line: number; body: string };

export async function fetchSessionNotes(cwd: string): Promise<SessionNote[]> {
  const output = await mustRun("hunk", ["session", "comment", "list", "--repo", cwd, "--type", "user", "--json"], { cwd });
  const parsed = JSON.parse(output);
  const items: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : parsed.comments ?? [];
  const notes: SessionNote[] = [];
  for (const item of items) {
    const filePath = (item.filePath ?? item.path) as string | undefined;
    const body = (item.body as string | undefined) ?? [item.summary, item.rationale].filter(Boolean).join("\n\n");
    let side: "old" | "new";
    let line: number | undefined;
    if (typeof item.newLine === "number") {
      side = "new";
      line = item.newLine;
    } else if (typeof item.oldLine === "number") {
      side = "old";
      line = item.oldLine;
    } else {
      side = item.side === "old" ? "old" : "new";
      line = typeof item.line === "number" ? item.line : undefined;
    }
    if (filePath && typeof line === "number" && body) notes.push({ filePath, side, line, body });
  }
  return notes;
}

export async function clearSessionNotes(cwd: string): Promise<void> {
  await run("hunk", ["session", "comment", "clear", "--repo", cwd, "--include-user", "--yes"], { cwd });
}
