export function relativeTime(iso: string, now: number): string {
  const deltaSeconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) return "";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}
