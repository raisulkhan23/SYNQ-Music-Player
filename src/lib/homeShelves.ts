/**
 * Home shelf allocation.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Home filled four "discovery" shelves — Discover something new, New releases,
 * Right now, Sounds of <season> — each with its own independent search, each
 * sliced to six rows, none of them aware of the others. The queries were
 * generic ("new music friday", "morning music hits", "autumn hits"), so the
 * provider answered all four with the same handful of popular records. The
 * page then rendered that same handful four times and looked broken.
 *
 * Increasing `slice()` made it worse. The fix is allocation: one coordinator
 * decides which candidate goes in which section, so a recording appears on Home
 * once.
 *
 * Rules, in order:
 *  1. A candidate already visible elsewhere on the page (history, chart,
 *     "On repeat", recommendations) is never used in a discovery shelf.
 *  2. Within the discovery shelves, the first section that claims a recording
 *     keeps it; later sections get the next distinct candidate.
 *  3. "Same recording" means same provider id, or — across providers where ids
 *     differ — the same normalised title AND artist. Versions stay distinct
 *     because the version label is part of the title: "Willow" and
 *     "Willow (Live)" are two recordings, not one.
 *  4. A section that cannot fill `minPerSection` after allocation is dropped
 *     rather than rendered as a one-card row.
 *  5. Nothing is padded with filler. Fewer, distinct rows beat repeated ones.
 */

export interface ShelfItemLike {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
}

/** Title-and-artist identity used only when ids cannot match. */
export function recordingKey(item: {
  title: string;
  artist: string;
  album?: string;
}): string {
  const fold = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  // The album is part of the key on purpose: the same song on a studio album
  // and on a live album are different recordings, and both legitimately exist.
  return `${fold(item.title)}|${fold(item.artist)}|${fold(item.album ?? "")}`;
}

export interface AllocateOptions {
  /** How many cards a shelf may show. */
  perSection?: number;
  /** Below this, the shelf is dropped instead of shown half-empty. */
  minPerSection?: number;
  /** Recordings already on the page and therefore off-limits. */
  reserved?: Iterable<string>;
  /** Rotates the starting point so a refresh is not a carbon copy. */
  offset?: number;
}

export interface AllocatedSection<T> {
  id: string;
  items: T[];
}

/**
 * Give each section its own distinct slice of the candidate pool.
 *
 * Input order is priority order: the first section is served first. That is
 * intentional — "New releases" is a better place for a fresh record than the
 * season row, and the coordinator is the only thing that can make that call
 * because it is the only thing that sees all the candidates at once.
 */
export function allocateSections<T extends ShelfItemLike>(
  sections: Array<{ id: string; items: T[] }>,
  options: AllocateOptions = {},
): Array<AllocatedSection<T>> {
  const perSection = Math.max(1, options.perSection ?? 10);
  const minPerSection = Math.max(1, options.minPerSection ?? 3);
  const used = new Set<string>(options.reserved ?? []);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));

  return sections.map((section) => {
    // Rotating the pool keeps a refresh from being byte-identical while still
    // spending every candidate before repeating one.
    const pool =
      section.items.length > 0 && offset > 0
        ? [
            ...section.items.slice(offset % section.items.length),
            ...section.items.slice(0, offset % section.items.length),
          ]
        : section.items;

    const chosen: T[] = [];
    for (const item of pool) {
      if (chosen.length >= perSection) break;
      if (!item?.id) continue;
      if (used.has(item.id)) continue;
      const key = recordingKey(item);
      // The album is part of one entry, but a section is also blocked by a
      // title+artist match alone: history and a search row report the same
      // song under different album labels (a reissue, a deluxe edition), and
      // reserving only the full key let Anti-Hero sit in "On repeat" and
      // "Right now" at the same time. Versions still survive because they
      // differ in TITLE — "Willow (Live)" folds to a different key.
      const shortKey = recordingKey({ title: item.title, artist: item.artist });
      if (used.has(key) || used.has(shortKey)) continue;
      used.add(item.id);
      used.add(key);
      used.add(shortKey);
      chosen.push(item);
    }

    // A row of one or two cards reads as a failure, not as restraint.
    return { id: section.id, items: chosen.length >= minPerSection ? chosen : [] };
  });
}
