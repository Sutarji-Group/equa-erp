/** Angka lencana ringkas: 0/negatif → `null` (tidak tampil), > 99 → `"99+"`. */
export function formatBadgeCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.trunc(count));
}
