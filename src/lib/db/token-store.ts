import type { Session, TokenStore } from "../futmondo/client";
import { hasDatabase } from "./client";
import { clearSession, loadSession, saveSession } from "./repo";

/**
 * Persists the Futmondo session in Postgres. Serverless functions lose module
 * state on every cold start, so an in-memory store would log in far too often
 * and risk locking the account.
 *
 * Reads are memoised for the life of the instance: the token changes only when
 * we replace it, so re-reading per request would add a query for nothing.
 */
export class DbTokenStore implements TokenStore {
  private memo: Session | null = null;

  async get(): Promise<Session | null> {
    if (this.memo) return this.memo;
    if (!hasDatabase()) return null;
    try {
      this.memo = await loadSession();
      return this.memo;
    } catch {
      // A database problem must not stop us reaching Futmondo; the client
      // simply logs in again.
      return null;
    }
  }

  async set(session: Session): Promise<void> {
    this.memo = session;
    if (!hasDatabase()) return;
    try {
      await saveSession(session.token, session.userid);
    } catch {
      /* the in-memory copy still serves this instance */
    }
  }

  async clear(): Promise<void> {
    this.memo = null;
    if (!hasDatabase()) return;
    try {
      await clearSession();
    } catch {
      /* nothing to recover */
    }
  }
}

/** Shared instance so every client in one lambda reuses the same token. */
export const dbTokenStore = new DbTokenStore();
