/**
 * Encoding for inline-button actions.
 *
 * Telegram caps `callback_data` at 64 bytes, which rules out embedding a
 * player name or a reason. So a button carries only a verb, an id and a price,
 * and everything else is looked up again when the button is pressed. That is
 * also the safer design: a price is re-validated against live funds at the
 * moment of execution rather than trusted from a message that may be hours old.
 *
 * Every money action is two taps. The first produces a confirmation button,
 * the second executes. Bids and clause payments cannot be undone, so a single
 * mis-tap must never spend the budget.
 */

export type CallbackVerb = "bid" | "clause" | "sell" | "refresh";

export interface CallbackAction {
  verb: CallbackVerb;
  playerId?: string;
  price?: number;
  /** True once the user has confirmed. */
  confirmed: boolean;
}

const SEPARATOR = ":";
const CONFIRM_PREFIX = "y";

/** Actions that spend or move money, and therefore need confirming. */
const NEEDS_CONFIRMATION: ReadonlySet<CallbackVerb> = new Set([
  "bid",
  "clause",
  "sell",
]);

export function needsConfirmation(verb: CallbackVerb): boolean {
  return NEEDS_CONFIRMATION.has(verb);
}

export function encodeCallback(action: CallbackAction): string {
  const parts: string[] = [action.confirmed ? `${CONFIRM_PREFIX}${action.verb}` : action.verb];
  if (action.playerId) parts.push(action.playerId);
  // Prices are whole euros; a decimal point would waste bytes for nothing.
  if (action.price !== undefined) parts.push(String(Math.round(action.price)));

  const encoded = parts.join(SEPARATOR);
  if (Buffer.byteLength(encoded, "utf8") > 64) {
    throw new Error(`callback_data exceeds Telegram's 64-byte limit: ${encoded}`);
  }
  return encoded;
}

export function decodeCallback(data: string): CallbackAction | null {
  const parts = data.split(SEPARATOR);
  if (parts.length === 0) return null;

  let verbToken = parts[0];
  let confirmed = false;
  if (verbToken.startsWith(CONFIRM_PREFIX) && verbToken.length > 1) {
    const candidate = verbToken.slice(CONFIRM_PREFIX.length);
    if (isVerb(candidate)) {
      verbToken = candidate;
      confirmed = true;
    }
  }
  if (!isVerb(verbToken)) return null;

  const playerId = parts[1] || undefined;
  const priceRaw = parts[2];
  const price = priceRaw === undefined ? undefined : Number(priceRaw);
  if (price !== undefined && !Number.isFinite(price)) return null;

  return { verb: verbToken, playerId, price, confirmed };
}

function isVerb(value: string): value is CallbackVerb {
  return (
    value === "bid" ||
    value === "clause" ||
    value === "sell" ||
    value === "refresh"
  );
}
