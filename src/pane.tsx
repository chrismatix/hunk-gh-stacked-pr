import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ExtensionPaneProps, ExtensionPaneTheme } from "hunkdiff/extension";
import { dispatch } from "./dispatch";
import {
  formatCheckState,
  formatDecision,
  summarizeChecks,
  wrapText,
  type Check,
  type PrDetails,
  type ReviewThread,
  type TimelineItem,
} from "./model";
import { getState, setState, subscribe, visibleThreads, type PaneTab, type PrState } from "./store";

function usePrState(): PrState {
  return useSyncExternalStore(subscribe, getState);
}

function checkIcon(check: Check): string {
  if (check.status !== "COMPLETED") return "…";
  switch (check.conclusion) {
    case "SUCCESS": return "✓";
    case "NEUTRAL": case "SKIPPED": return "·";
    default: return "✗";
  }
}

function checkDuration(check: Check): string {
  if (!check.startedAt || !check.completedAt) return "";
  const seconds = Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  return seconds >= 60 ? ` ${Math.floor(seconds / 60)}m${seconds % 60}s` : ` ${seconds}s`;
}

function Line({ content, fg, bg, onMouseDown }: { content: string; fg: string; bg: string; onMouseDown?: () => void }): ReactNode {
  return <text content={content} style={{ fg, bg }} onMouseDown={onMouseDown} />;
}

function Wrapped({ text, indent, width, maxLines, fg, bg }: { text: string; indent: string; width: number; maxLines: number; fg: string; bg: string }): ReactNode {
  const lines = wrapText(text, Math.max(width - indent.length - 1, 10));
  const clipped = lines.length > maxLines;
  return (
    <>
      {(clipped ? [...lines.slice(0, maxLines), "…"] : lines).map((line, i) => (
        <Line key={i} content={`${indent}${line}`} fg={fg} bg={bg} />
      ))}
    </>
  );
}

function TabBar({ tab, theme }: { tab: PaneTab; theme: ExtensionPaneTheme }): ReactNode {
  const tabs: { id: PaneTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "checks", label: "Checks" },
    { id: "threads", label: "Threads" },
  ];
  return (
    <box style={{ flexDirection: "row", backgroundColor: theme.panel }}>
      {tabs.map(({ id, label }) => (
        <text
          key={id}
          content={` ${label} `}
          style={{ fg: id === tab ? theme.text : theme.muted, bg: id === tab ? theme.selectedHunk : theme.panel }}
          onMouseDown={() => setState({ tab: id, logPeek: null })}
        />
      ))}
    </box>
  );
}

function StackSection({ state, width, theme }: { state: PrState; width: number; theme: ExtensionPaneTheme }): ReactNode {
  if (!state.stack) return null;
  return (
    <>
      <Line content="" fg={theme.muted} bg={theme.panel} />
      <Line content={` Stack${state.stack.tracked ? " (gh stack)" : ""} — [ ] switch, enter jumps`} fg={theme.accent} bg={theme.panel} />
      {state.stack.entries.map((entry, index) => {
        const selected = index === state.stackIndex;
        const rowBg = entry.isCurrent ? theme.selectedHunk : selected ? theme.panelAlt : theme.panel;
        const label = ` ${entry.isCurrent ? "▸" : " "} #${entry.number ?? "?"} ${formatCheckState(entry.checksState)} ${entry.title || entry.headRefName}`;
        return (
          <text
            key={`${entry.headRefName}-${index}`}
            id={`stack-${index}`}
            content={label.slice(0, Math.max(width - 1, 10))}
            style={{ fg: entry.isCurrent ? theme.text : theme.muted, bg: rowBg }}
            onMouseDown={() => dispatch({ kind: "switch-entry", index })}
          />
        );
      })}
    </>
  );
}

function TimelineSection({ timeline, width, theme }: { timeline: TimelineItem[]; width: number; theme: ExtensionPaneTheme }): ReactNode {
  if (timeline.length === 0) return null;
  return (
    <>
      <Line content="" fg={theme.muted} bg={theme.panel} />
      <Line content=" Timeline" fg={theme.accent} bg={theme.panel} />
      {timeline.map((item, index) => {
        switch (item.kind) {
          case "comment":
            return (
              <box key={index} style={{ flexDirection: "column", backgroundColor: theme.panel }}>
                <Line content={` @${item.author} commented` } fg={theme.text} bg={theme.panel} />
                <Wrapped text={item.body ?? ""} indent="   " width={width} maxLines={3} fg={theme.muted} bg={theme.panel} />
              </box>
            );
          case "review": {
            const verdict = item.reviewState === "APPROVED" ? "approved ✓" : item.reviewState === "CHANGES_REQUESTED" ? "requested changes ✗" : "reviewed";
            return (
              <box key={index} style={{ flexDirection: "column", backgroundColor: theme.panel }}>
                <Line content={` @${item.author} ${verdict}`} fg={item.reviewState === "APPROVED" ? theme.badgeAdded : item.reviewState === "CHANGES_REQUESTED" ? theme.badgeRemoved : theme.text} bg={theme.panel} />
                {item.body ? <Wrapped text={item.body} indent="   " width={width} maxLines={2} fg={theme.muted} bg={theme.panel} /> : null}
              </box>
            );
          }
          case "force-push":
            return <Line key={index} content={` @${item.author} force-pushed`} fg={theme.badgeRemoved} bg={theme.panel} />;
          case "commit":
            return <Line key={index} content={` ${item.author} ${item.body ?? ""}`.slice(0, width - 1)} fg={theme.muted} bg={theme.panel} />;
          case "merged":
            return <Line key={index} content={` @${item.author} merged this PR`} fg={theme.badgeAdded} bg={theme.panel} />;
          case "review-requested":
            return <Line key={index} content={` @${item.author} requested review from @${item.body}`} fg={theme.muted} bg={theme.panel} />;
        }
      })}
    </>
  );
}

function OverviewTab({ state, pr, width, theme }: { state: PrState; pr: PrDetails; width: number; theme: ExtensionPaneTheme }): ReactNode {
  return (
    <>
      <Wrapped text={pr.title} indent=" " width={width} maxLines={3} fg={theme.text} bg={theme.panel} />
      <Line content={` @${pr.author} · ${pr.headRefName} → ${pr.baseRefName}`.slice(0, width - 1)} fg={theme.muted} bg={theme.panel} />
      {pr.labels.length > 0 ? <Line content={` labels: ${pr.labels.join(", ")}`.slice(0, width - 1)} fg={theme.muted} bg={theme.panel} /> : null}
      {pr.reviewRequests.length > 0 ? <Line content={` review requested: ${pr.reviewRequests.join(", ")}`.slice(0, width - 1)} fg={theme.muted} bg={theme.panel} /> : null}
      {pr.autoMergeMethod ? <Line content={` auto-merge: ${pr.autoMergeMethod.toLowerCase()}`} fg={theme.accentMuted} bg={theme.panel} /> : null}
      <StackSection state={state} width={width} theme={theme} />
      {pr.body ? (
        <>
          <Line content="" fg={theme.muted} bg={theme.panel} />
          <Wrapped text={pr.body} indent=" " width={width} maxLines={12} fg={theme.muted} bg={theme.panel} />
        </>
      ) : null}
      <TimelineSection timeline={pr.timeline} width={width} theme={theme} />
    </>
  );
}

function ChecksTab({ state, pr, width, theme }: { state: PrState; pr: PrDetails; width: number; theme: ExtensionPaneTheme }): ReactNode {
  if (state.logPeek) {
    return (
      <>
        <Line content={` ${state.logPeek.checkName} — failed log tail (enter closes)`.slice(0, width - 1)} fg={theme.accent} bg={theme.panel} />
        {state.logPeek.lines.map((line, index) => (
          <Line key={index} content={` ${line}`.slice(0, Math.max(width - 1, 10))} fg={theme.muted} bg={theme.panel} />
        ))}
      </>
    );
  }
  if (pr.checks.length === 0) {
    return <Line content=" No checks reported on this PR" fg={theme.muted} bg={theme.panel} />;
  }
  return (
    <>
      <Line content=" enter: failed-log peek · u: rerun failed" fg={theme.accentMuted} bg={theme.panel} />
      {pr.checks.map((check, index) => {
        const selected = index === state.checkIndex;
        const icon = checkIcon(check);
        const fg = icon === "✗" ? theme.badgeRemoved : icon === "✓" ? theme.badgeAdded : theme.muted;
        return (
          <text
            key={`${check.name}-${index}`}
            id={`check-${index}`}
            content={` ${icon} ${check.name}${check.workflow ? ` (${check.workflow})` : ""}${checkDuration(check)}`.slice(0, Math.max(width - 1, 10))}
            style={{ fg, bg: selected ? theme.selectedHunk : theme.panel }}
            onMouseDown={() => {
              setState({ checkIndex: index });
              dispatch({ kind: "log-peek" });
            }}
          />
        );
      })}
    </>
  );
}

function ThreadRows({ thread, selected, index, width, theme }: { thread: ReviewThread; selected: boolean; index: number; width: number; theme: ExtensionPaneTheme }): ReactNode {
  const rowBg = selected ? theme.selectedHunk : theme.panel;
  const badges = [thread.isResolved ? "resolved" : null, thread.isOutdated ? "outdated" : null].filter(Boolean).join(", ");
  const select = () => {
    setState({ threadIndex: index });
    dispatch({ kind: "reveal-thread" });
  };
  return (
    <box id={`thread-${index}`} style={{ flexDirection: "column", backgroundColor: rowBg }}>
      <Line
        content={` ${thread.path}:${thread.line ?? "outdated"}${badges ? ` [${badges}]` : ""}`.slice(0, Math.max(width - 1, 10))}
        fg={thread.isResolved ? theme.muted : theme.text}
        bg={rowBg}
        onMouseDown={select}
      />
      {thread.comments.map((comment, commentIndex) => (
        <box key={commentIndex} onMouseDown={select} style={{ flexDirection: "column", backgroundColor: rowBg }}>
          <Line content={`${commentIndex === 0 ? "  " : "   ↳ "}@${comment.author}`} fg={theme.accent} bg={rowBg} />
          <Wrapped text={comment.body} indent={commentIndex === 0 ? "  " : "     "} width={width} maxLines={commentIndex === 0 ? 4 : 2} fg={theme.muted} bg={rowBg} />
        </box>
      ))}
      <Line content="" fg={theme.muted} bg={rowBg} />
    </box>
  );
}

function ThreadsTab({ state, width, theme }: { state: PrState; width: number; theme: ExtensionPaneTheme }): ReactNode {
  const threads = visibleThreads(state);
  const hiddenCount = (state.pr?.threads.length ?? 0) - threads.length;
  return (
    <>
      <Line
        content={` ${threads.length} thread${threads.length === 1 ? "" : "s"}${hiddenCount > 0 ? ` (${hiddenCount} resolved hidden — h shows)` : ""} · r reply · x resolve`}
        fg={theme.accentMuted}
        bg={theme.panel}
      />
      {threads.map((thread, index) => (
        <ThreadRows key={thread.id} thread={thread} selected={index === state.threadIndex} index={index} width={width} theme={theme} />
      ))}
      {threads.length === 0 ? <Line content=" No review threads" fg={theme.muted} bg={theme.panel} /> : null}
    </>
  );
}

export function PrPane({ width, theme }: ExtensionPaneProps): ReactNode {
  const state = usePrState();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    if (state.phase !== "ready") return;
    const id = state.tab === "overview" ? `stack-${state.stackIndex}` : state.tab === "checks" ? `check-${state.checkIndex}` : `thread-${state.threadIndex}`;
    scrollRef.current?.scrollChildIntoView(id);
  }, [state.tab, state.stackIndex, state.checkIndex, state.threadIndex, state.phase]);

  let body: ReactNode;
  let header: ReactNode = null;
  switch (state.phase) {
    case "idle":
    case "loading":
      body = <Line content=" Loading PR…" fg={theme.muted} bg={theme.panel} />;
      break;
    case "no-pr":
      body = <Line content=" No open PR for the checked-out branch" fg={theme.muted} bg={theme.panel} />;
      break;
    case "error":
      body = <Line content={` Error: ${state.message}`.slice(0, width - 1)} fg={theme.badgeRemoved} bg={theme.panel} />;
      break;
    case "ready": {
      const pr = state.pr!;
      const stackPosition = state.stack
        ? ` ◂${state.stack.entries.findIndex((entry) => entry.isCurrent) + 1}/${state.stack.entries.length}▸`
        : "";
      header = (
        <Line
          content={` PR #${pr.number}${pr.isDraft ? " [DRAFT]" : ""} · ${formatDecision(pr.reviewDecision)} · ${summarizeChecks(pr)}${stackPosition}`.slice(0, Math.max(width - 1, 10))}
          fg={theme.accent}
          bg={theme.panel}
        />
      );
      switch (state.tab) {
        case "overview":
          body = <OverviewTab state={state} pr={pr} width={width} theme={theme} />;
          break;
        case "checks":
          body = <ChecksTab state={state} pr={pr} width={width} theme={theme} />;
          break;
        case "threads":
          body = <ThreadsTab state={state} width={width} theme={theme} />;
          break;
      }
      break;
    }
  }

  return (
    <scrollbox
      ref={scrollRef}
      width="100%"
      height="100%"
      focused={false}
      scrollY={true}
      rootOptions={{ backgroundColor: theme.panel }}
      wrapperOptions={{ backgroundColor: theme.panel }}
      viewportOptions={{ backgroundColor: theme.panel }}
      contentOptions={{ backgroundColor: theme.panel }}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box style={{ width: "100%", flexDirection: "column", backgroundColor: theme.panel }}>
        {header}
        <TabBar tab={state.tab} theme={theme} />
        {state.modeActive ? (
          <Line content=" tab cycles · j/k move · f filter timeline · s submit · m/M merge · R refresh" fg={theme.accentMuted} bg={theme.panel} />
        ) : null}
        {body}
      </box>
    </scrollbox>
  );
}
