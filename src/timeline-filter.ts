import type { TimelineItem } from "./model";

export function filterTimeline(items: TimelineItem[], filter: "all" | "comments" | "reviews"): TimelineItem[] {
  switch (filter) {
    case "comments": return items.filter((item) => item.kind === "comment");
    case "reviews": return items.filter((item) => item.kind === "review");
    default: return items;
  }
}
