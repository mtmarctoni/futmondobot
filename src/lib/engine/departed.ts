/**
 * Players who have left the competition.
 *
 * When a player is transferred out of the league in real life, Futmondo does
 * not remove him from the championship. He keeps a market value, a clause
 * price and a squad slot, and his card looks exactly like everyone else's --
 * but his club is now abroad, he will never appear in a fixture again, and he
 * will score zero for as long as he is held. It is the most expensive silent
 * mistake available in this game: a squad slot and, in the case that prompted
 * this check, 18.5M of capital earning nothing.
 *
 * Nothing in a player payload says "gone". The signal is indirect and comes
 * from the calendar: a club takes part in the competition if and only if it
 * has a fixture, so a player whose club has no fixtures is a player who is not
 * in the competition. That reads the transfer the day Futmondo updates his
 * club, without waiting for rounds of zero scores to accumulate.
 *
 * The check is deliberately conservative in both directions, because a false
 * positive tells you to dump a good player:
 *
 *   - It needs a near-complete calendar. With fewer clubs than a league has,
 *     the absence of a fixture means the sync has not run, not that a player
 *     has left.
 *   - It refuses to fire if it would flag an implausible share of the league.
 *     A calendar synced for the wrong competition would put every club id
 *     outside the reference set, and the honest response to that is a warning,
 *     not advice to sell the entire squad.
 */
import type { FutmondoRole } from "../futmondo/types";

export interface DepartureInput {
  playerId: string;
  name: string;
  role: FutmondoRole;
  /** The club Futmondo currently has them at. */
  clubId: string | null;
  clubName: string | null;
  value: number;
  /** True for players in our own squad, the only ones we can sell. */
  mine?: boolean;
  /** Whether they are already listed for sale. Only known for our own squad. */
  onMarket?: boolean;
  askPrice?: number | null;
}

export interface DepartedPlayer {
  playerId: string;
  name: string;
  role: FutmondoRole;
  /** The club they are at now, as Futmondo names it. */
  clubName: string | null;
  clubId: string;
  /** Value still tied up in them. */
  value: number;
  onMarket: boolean;
  askPrice: number | null;
}

export interface DepartureScan {
  /**
   * Reason text per player id, for every player who has left, ours or not.
   * Feeding this into the unavailability map is what stops a departed player
   * being picked in an XI or recommended as a clause steal.
   */
  reasons: Map<string, string>;
  /** Ours, with enough detail to act on. Most valuable first. */
  mine: DepartedPlayer[];
  warnings: string[];
}

/**
 * A calendar with fewer clubs than this cannot be trusted to enumerate the
 * competition. LaLiga has 20; a partial sync is the likely cause of a short
 * list, and flagging players off a partial list would be wrong.
 */
export const MIN_CLUBS = 18;

/**
 * Above this share of the league, the calendar is the suspect rather than the
 * players. Real departures are a handful of players out of several hundred.
 */
const MAX_DEPARTED_SHARE = 0.2;

/** Below this many players, the share test has nothing to say. */
const MIN_SAMPLE = 20;

export function scanDepartures(
  players: readonly DepartureInput[],
  competitionClubs: ReadonlyMap<string, string>,
): DepartureScan {
  const empty: DepartureScan = { reasons: new Map(), mine: [], warnings: [] };

  if (competitionClubs.size < MIN_CLUBS) {
    return {
      ...empty,
      warnings: [
        competitionClubs.size === 0
          ? "No fixtures stored, so players who have left the competition cannot be spotted. Run the calendar sync."
          : `Only ${competitionClubs.size} clubs in the stored calendar, too few to tell a transfer out of the league from a missing fixture. Run the calendar sync.`,
      ],
    };
  }

  // A player with no club id at all is unknown, not departed.
  const placed = players.filter((p) => p.clubId);
  const outside = placed.filter((p) => !competitionClubs.has(p.clubId as string));

  if (
    placed.length >= MIN_SAMPLE &&
    outside.length / placed.length > MAX_DEPARTED_SHARE
  ) {
    return {
      ...empty,
      warnings: [
        `${outside.length} of ${placed.length} players are at clubs with no fixtures, which is too many to be real transfers. The stored calendar is probably for a different competition, so the check is being skipped.`,
      ],
    };
  }

  const reasons = new Map<string, string>();
  const mine: DepartedPlayer[] = [];

  for (const p of outside) {
    reasons.set(p.playerId, reasonFor(p.clubName));
    if (!p.mine) continue;
    mine.push({
      playerId: p.playerId,
      name: p.name,
      role: p.role,
      clubName: p.clubName,
      clubId: p.clubId as string,
      value: p.value,
      onMarket: p.onMarket ?? false,
      askPrice: p.askPrice ?? null,
    });
  }

  mine.sort((a, b) => b.value - a.value);
  return { reasons, mine, warnings: [] };
}

/**
 * Phrased to read correctly where it is reused, which is inside a longer
 * sentence in the sell reasoning as well as on its own next to a name.
 */
function reasonFor(clubName: string | null): string {
  const club = clubName?.trim();
  return club
    ? `no longer in the competition (now at ${club})`
    : "no longer in the competition";
}
