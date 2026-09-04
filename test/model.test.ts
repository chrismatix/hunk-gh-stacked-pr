import { describe, expect, test } from "bun:test";
import {
  allowedMergeMethods,
  buildStack,
  chainStack,
  checksArePending,
  parseChecks,
  parseGhStackView,
  parsePrDetails,
  patchLineText,
  summarizeChecks,
  wrapText,
  type OpenPrSummary,
} from "../src/model";

function openPr(number: number, headRefName: string, baseRefName: string): OpenPrSummary {
  return { number, title: `PR ${number}`, headRefName, baseRefName, isDraft: false, reviewDecision: null, checksState: "SUCCESS" };
}

describe("chainStack", () => {
  const prs = [openPr(1, "feat-a", "main"), openPr(2, "feat-b", "feat-a"), openPr(3, "feat-c", "feat-b"), openPr(9, "unrelated", "main")];

  test("orders trunk-first around the current PR", () => {
    const chain = chainStack({ number: 2, headRefName: "feat-b", baseRefName: "feat-a" }, prs);
    expect(chain.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(chain[1].isCurrent).toBe(true);
  });

  test("single PR on main yields just itself", () => {
    const chain = chainStack({ number: 9, headRefName: "unrelated", baseRefName: "main" }, prs);
    expect(chain.map((entry) => entry.number)).toEqual([9]);
  });

  test("survives a base cycle", () => {
    const cyclic = [openPr(1, "a", "b"), openPr(2, "b", "a")];
    const chain = chainStack({ number: 1, headRefName: "a", baseRefName: "b" }, cyclic);
    expect(chain.length).toBeLessThanOrEqual(2);
    expect(chain.some((entry) => entry.isCurrent)).toBe(true);
  });
});

describe("buildStack", () => {
  const prs = [openPr(1, "feat-a", "main"), openPr(2, "feat-b", "feat-a")];

  test("chaining-only stack is untracked and needs two members", () => {
    expect(buildStack({ number: 9, headRefName: "solo", baseRefName: "main" }, prs, null)).toBeNull();
    const stack = buildStack({ number: 1, headRefName: "feat-a", baseRefName: "main" }, prs, null);
    expect(stack?.tracked).toBe(false);
    expect(stack?.entries.length).toBe(2);
  });

  test("gh stack marks tracked and appends unchained branches", () => {
    const stack = buildStack({ number: 1, headRefName: "feat-a", baseRefName: "main" }, prs, [
      { branch: "feat-a", prNumber: 1 },
      { branch: "feat-b", prNumber: 2 },
      { branch: "feat-unpushed", prNumber: null },
    ]);
    expect(stack?.tracked).toBe(true);
    expect(stack?.entries.map((entry) => entry.headRefName)).toEqual(["feat-a", "feat-b", "feat-unpushed"]);
  });
});

describe("parseGhStackView", () => {
  test("reads a top-level array of branch entries", () => {
    expect(parseGhStackView([{ branch: "a", pr: { number: 4 } }, { name: "b" }])).toEqual([
      { branch: "a", prNumber: 4 },
      { branch: "b", prNumber: null },
    ]);
  });

  test("reads a wrapped branches array", () => {
    expect(parseGhStackView({ stack: "s", branches: [{ branch: "a", prNumber: 7 }] })).toEqual([{ branch: "a", prNumber: 7 }]);
  });

  test("rejects shapes without branch entries", () => {
    expect(parseGhStackView({ message: "nope" })).toBeNull();
    expect(parseGhStackView("gibberish")).toBeNull();
  });
});

describe("checks", () => {
  const commits = {
    nodes: [{
      commit: {
        statusCheckRollup: {
          state: "FAILURE",
          contexts: {
            nodes: [
              { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", checkSuite: { workflowRun: { databaseId: 42, workflow: { name: "CI" } } } },
              { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: null, completedAt: null, checkSuite: null },
              { __typename: "CheckRun", name: "deploy", status: "IN_PROGRESS", conclusion: null, startedAt: null, completedAt: null, checkSuite: null },
              { __typename: "StatusContext", context: "lint", state: "PENDING", createdAt: "2026-01-01T00:00:00Z" },
            ],
          },
        },
      },
    }],
  };

  test("parses check runs and status contexts", () => {
    const checks = parseChecks(commits);
    expect(checks.length).toBe(4);
    expect(checks[0].runId).toBe(42);
    expect(checks[0].workflow).toBe("CI");
    expect(checks[3].kind).toBe("status");
    expect(checks[3].status).toBe("IN_PROGRESS");
  });

  test("pending and summary reflect mixed states", () => {
    const details = { checks: parseChecks(commits), checksState: "FAILURE" };
    expect(checksArePending(details)).toBe(true);
    expect(summarizeChecks(details)).toBe("1 ✓ 1 ✗ 2 …");
  });
});

describe("parsePrDetails", () => {
  test("shapes threads, timeline, and settings from GraphQL nodes", () => {
    const details = parsePrDetails(
      {
        number: 12,
        title: "Add thing",
        body: "Body",
        state: "OPEN",
        isDraft: true,
        author: { login: "chris" },
        baseRefName: "main",
        headRefName: "feat",
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        autoMergeRequest: null,
        labels: { nodes: [{ name: "bug" }] },
        assignees: { nodes: [{ login: "chris" }] },
        reviewRequests: { nodes: [{ requestedReviewer: { login: "alice" } }] },
        reviewThreads: {
          nodes: [{
            id: "T1", isResolved: false, isOutdated: false, path: "a.ts", line: 3, diffSide: "RIGHT",
            comments: { nodes: [{ databaseId: 100, author: { login: "alice" }, body: "why?", createdAt: "2026-01-01" }] },
          }],
        },
        commits: { nodes: [] },
        timelineItems: {
          nodes: [
            { __typename: "IssueComment", author: { login: "bob" }, body: "hi", createdAt: "2026-01-02" },
            { __typename: "PullRequestReview", author: { login: "alice" }, body: "", state: "APPROVED", createdAt: "2026-01-03" },
          ],
        },
      },
      { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false, deleteBranchOnMerge: true },
    );
    expect(details.threads[0].comments[0].databaseId).toBe(100);
    expect(details.timeline.map((item) => item.kind)).toEqual(["comment", "review"]);
    expect(details.reviewRequests).toEqual(["alice"]);
    expect(allowedMergeMethods(details.repoSettings)).toEqual([{ label: "Squash", flag: "--squash" }]);
  });
});

describe("patchLineText", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " context",
    "-removed line",
    "+added one",
    "+added two",
    " tail",
    "@@ -10,2 +11,2 @@",
    " ten",
    "-old eleven",
    "+new twelve",
  ].join("\n");

  test("resolves added, removed, and context lines per side", () => {
    expect(patchLineText(patch, "new", 2)).toBe("added one");
    expect(patchLineText(patch, "new", 3)).toBe("added two");
    expect(patchLineText(patch, "old", 2)).toBe("removed line");
    expect(patchLineText(patch, "old", 1)).toBe("context");
    expect(patchLineText(patch, "new", 12)).toBe("new twelve");
    expect(patchLineText(patch, "new", 99)).toBeNull();
  });
});

describe("wrapText", () => {
  test("wraps on word boundaries and keeps blank lines", () => {
    expect(wrapText("one two three", 8)).toEqual(["one two", "three"]);
    expect(wrapText("", 10)).toEqual([""]);
  });
});
