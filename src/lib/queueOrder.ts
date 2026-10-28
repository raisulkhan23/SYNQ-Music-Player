/**
 * Key/ordering helpers for the "Playing next" list in the queue panel.
 *
 * Framer Motion's `Reorder.Group` needs every item value to be unique, and
 * React needs a stable key per row. The queue can legitimately contain the
 * same track twice, so a bare track id is not unique — and a bare row index is
 * unique but *not stable*: the moment a row moves, every index below it
 * changes, React remounts those rows, and the reorder animation never plays
 * because there is no existing row to animate.
 */

/**
 * Fisher–Yates on a copy, so the caller's list keeps its order.
 *
 * Shared because four pages each grew their own copy while their "Shuffle"
 * buttons were switching the app's GLOBAL shuffle preference on as a
 * side effect. Ordering the list yourself is the whole job, and it leaves
 * the user's actual shuffle setting alone.
 */
export function shuffleList<T>(list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Unique, reorder-stable keys for a list of rows.
 *
 * The occurrence suffix counts how many times each id has already been seen,
 * so a list `[A, B, A]` yields `["A~0", "B~0", "A~1"]`. Reordering cannot
 * change that multiset — the two copies of `A` are indistinguishable, so
 * whichever sits first is always occurrence `0` — which is exactly what makes
 * the keys survive a move and lets the rows animate instead of remounting.
 */
export function queueReorderKeys<T extends { id: string }>(
  rows: readonly T[],
): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const occurrence = seen.get(row.id) ?? 0;
    seen.set(row.id, occurrence + 1);
    return `${row.id}~${occurrence}`;
  });
}

/**
 * Reorder `keys` by moving the entry at `from` to `to`, returning a new array.
 * Returns null when the move is out of bounds or a no-op, so callers can skip
 * a pointless state update (and skip a pointless queue write).
 */
export function moveQueueRow(
  keys: readonly string[],
  from: number,
  to: number,
): string[] | null {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= keys.length ||
    to >= keys.length
  ) {
    return null;
  }
  const next = [...keys];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return null;
  next.splice(to, 0, moved);
  return next;
}
