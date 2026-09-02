/**
 * Futmondo signals failure with HTTP 200 and `answer.error === true`, so every
 * error here is derived from the body rather than the status code.
 * See docs/futmondo-api.md.
 */
export class FutmondoError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly endpoint?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FutmondoError";
  }

  /** A stale or missing token. The client re-logs in and retries once on this. */
  get isAuthError(): boolean {
    return isAuthCode(this.code);
  }

  /** Credentials themselves are wrong — retrying will never help. */
  get isCredentialError(): boolean {
    return this.code === "api.error.not_found";
  }
}

export function isAuthCode(code: string | undefined): boolean {
  if (!code) return false;
  return code === "futmondo.access.denied" || code.toLowerCase().includes("token");
}
