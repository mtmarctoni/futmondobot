/**
 * Per-browser memory of which opportunities have already been alerted.
 *
 * Deliberately not in the database. Nothing about "has this person seen a
 * toast" belongs in the ledger, it differs per device rather than per league,
 * and a table would have to be written on every page view. localStorage is the
 * right size of durability for it.
 */

/** localStorage key holding the ids alerted on the last visit. */
export const SEEN_KEY = "futmondobot.radar.seen";

/**
 * The ids in `current` that were not in `seen`, in the order `current` gives
 * them -- which is the radar's ranking, so the first alert is the best one.
 */
export function newIds(current: string[], seen: string[]): string[] {
  const known = new Set(seen);
  return current.filter((id) => !known.has(id));
}

/**
 * Parses a stored seen-list, tolerating every way the store can be wrong.
 *
 * A private window, cleared site data, a half-written value or a store written
 * by an older version all land here. None of them are worth surfacing: the
 * cost of getting it wrong is one repeated toast, and the cost of throwing is
 * a page that does not render.
 */
export function parseSeen(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/**
 * The seen list as an external store, for `useSyncExternalStore`.
 *
 * Cached deliberately. The snapshot has to mean "what this browser had seen
 * when the page loaded", so it must not change when we write our own visit
 * back -- otherwise the alert would erase itself on the very next render. Only
 * another tab, which arrives as a `storage` event, invalidates it.
 */
let cachedSnapshot: string | null = null;

export function getSeenSnapshot(): string {
  if (cachedSnapshot === null) {
    try {
      cachedSnapshot = window.localStorage.getItem(SEEN_KEY) ?? "";
    } catch {
      cachedSnapshot = "";
    }
  }
  return cachedSnapshot;
}

/** Null on the server, where there is no store and nothing has been seen. */
export function getSeenServerSnapshot(): null {
  return null;
}

export function subscribeSeen(onChange: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key !== SEEN_KEY) return;
    cachedSnapshot = null;
    onChange();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/**
 * Replaces the seen set with the current listing ids rather than adding to it,
 * so the store cannot grow without bound as listings come and go.
 */
export function writeSeen(current: string[]): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(current));
  } catch {
    // Storage unavailable. The alert simply repeats next visit.
  }
}
