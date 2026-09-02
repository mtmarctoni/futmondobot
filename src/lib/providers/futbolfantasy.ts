/**
 * Start-probability provider: FútbolFantasy's LaLiga fitness page.
 *
 * Futmondo tells us a player is injured, but not whether a fit player will
 * actually be picked, and a doubtful player who does not start scores nothing.
 * This page publishes a start percentage per doubtful player, refreshed daily,
 * and is plain server-rendered HTML — which matters, because the site's
 * probable-lineup pages are client-rendered and cannot be scraped without a
 * browser.
 *
 * Scope worth being clear about: only players with a fitness question appear
 * here, roughly 60-70 across the league. That is the useful set. For everyone
 * else, recent minutes from Futmondo's own round data are a better signal than
 * anything a scrape would add, so the engine falls back to those.
 *
 * The parser is intentionally shallow — one regex pass over repeated blocks,
 * no DOM library. If the markup changes it returns nothing and the engine
 * carries on without it, which is the correct failure for an optional input.
 */

export const FUTBOLFANTASY_URL =
  "https://www.futbolfantasy.com/laliga/lesionados";

export const SOURCE_NAME = "futbolfantasy";

export interface FitnessRow {
  /** Name exactly as published, before any matching. */
  name: string;
  /** Club as published, used to disambiguate shared surnames. */
  teamName: string | null;
  /** 0..1 chance of starting, as the site reports it. */
  startProbability: number;
  /** 0 = out, rising with seriousness. Site's own grading. */
  severity: number | null;
  /** Free-text note, when present. */
  note: string | null;
}

export interface ScrapeResult {
  rows: FitnessRow[];
  /** Date the page says it was updated, if we can read it. */
  updatedOn: string | null;
  warnings: string[];
}

/**
 * A club header precedes each group of players, so team attribution comes from
 * whichever header last appeared before the row.
 */
const TEAM_HEADER = /<header[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/header>/gi;
const PLAYER_BLOCK = /<div class="elemento[^"]*">([\s\S]*?)(?=<div class="elemento|<\/section>)/gi;

const NAME = /class="jugador"[^>]*>([^<]+)</i;
const PROBABILITY = /probabilidad-widget[\s\S]{0,300}?>\s*(\d{1,3})\s*%/i;
const SEVERITY = /gravedad-(\d+)/i;
const NOTE = /class="comentario"[^>]*>([\s\S]{0,400}?)<\/div>/i;
const UPDATED = /Actualizado el\s*(\d{2})\/(\d{2})\/(\d{4})/i;

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url?: string;
}

export async function fetchFitness(
  options: FetchOptions = {},
): Promise<ScrapeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? FUTBOLFANTASY_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const res = await doFetch(url, {
      headers: {
        // A default fetch user-agent gets served a different page.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "es-ES,es;q=0.9",
      },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      return {
        rows: [],
        updatedOn: null,
        warnings: [`${url} returned HTTP ${res.status}`],
      };
    }

    return parseFitnessPage(await res.text());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { rows: [], updatedOn: null, warnings: [`${url} unreachable: ${detail}`] };
  } finally {
    clearTimeout(timer);
  }
}

export function parseFitnessPage(html: string): ScrapeResult {
  const warnings: string[] = [];

  // Record where each club heading sits so a player can be attributed to the
  // nearest preceding one.
  const headers: { index: number; team: string }[] = [];
  for (const match of html.matchAll(TEAM_HEADER)) {
    const team = stripTags(match[1]);
    if (team) headers.push({ index: match.index ?? 0, team });
  }

  const rows: FitnessRow[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(PLAYER_BLOCK)) {
    const block = match[1];
    const at = match.index ?? 0;

    const name = NAME.exec(block)?.[1]?.trim();
    if (!name) continue;

    const percentage = PROBABILITY.exec(block)?.[1];
    // A row with no published percentage tells us nothing beyond what
    // Futmondo already reports, so skip rather than invent a number.
    if (percentage === undefined) continue;

    const startProbability = Math.min(100, Math.max(0, Number(percentage))) / 100;
    const severityRaw = SEVERITY.exec(block)?.[1];
    const note = NOTE.exec(block)?.[1];

    const teamName =
      [...headers].reverse().find((h) => h.index < at)?.team ?? null;

    // The same player can appear twice when a page lists them per competition.
    const key = `${name}|${teamName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      name,
      teamName,
      startProbability,
      severity: severityRaw === undefined ? null : Number(severityRaw),
      note: note ? stripTags(note) || null : null,
    });
  }

  if (rows.length === 0) {
    warnings.push(
      "FútbolFantasy returned no readable fitness rows — the page markup has probably changed. Start probabilities fall back to recent minutes played.",
    );
  }

  const updated = UPDATED.exec(html);
  const updatedOn = updated
    ? `${updated[3]}-${updated[2]}-${updated[1]}`
    : null;

  return { rows, updatedOn, warnings };
}

/**
 * Named entities for the accented characters this page actually uses. Spanish
 * club and player names are full of them, and the page mixes literal UTF-8
 * with entity escapes, so "Alav&eacute;s" must decode to "Alavés" rather than
 * being blanked — a mangled club name would break name matching downstream.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  ntilde: "ñ",
  Ntilde: "Ñ",
  uuml: "ü",
  Uuml: "Ü",
  ccedil: "ç",
  Ccedil: "Ç",
  agrave: "à",
  egrave: "è",
  ograve: "ò",
  acirc: "â",
  ecirc: "ê",
  ocirc: "ô",
  ordm: "º",
  ordf: "ª",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => {
      const mapped = NAMED_ENTITIES[name];
      // Leave an unknown entity as a space rather than as literal markup.
      return mapped ?? (NAMED_ENTITIES[name.toLowerCase()] ?? " ");
    });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
