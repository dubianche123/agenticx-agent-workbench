/**
 * Shared password-login policy. Keep this in the auth package so the portal,
 * admin console, and non-HTTP AuthService expose the same lockout contract.
 */
export const MAX_FAILED_LOGIN_ATTEMPTS = 10;
export const LOGIN_LOCK_MINUTES = 15;

export type LoginFailureDetails = {
  failedAttempts: number;
  maxFailedAttempts: number;
  lockedUntil: number | null;
  lockMinutes: number;
};

export function buildLoginFailureDetails(
  failedAttempts: number,
  lockedUntil: number | null = null,
  now = Date.now(),
): LoginFailureDetails {
  const normalizedFailedAttempts = Math.max(0, Math.trunc(failedAttempts));
  const normalizedLockedUntil = lockedUntil && lockedUntil > now ? lockedUntil : null;
  return {
    failedAttempts: normalizedFailedAttempts,
    maxFailedAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
    lockedUntil: normalizedLockedUntil,
    lockMinutes: LOGIN_LOCK_MINUTES,
  };
}

export class LoginFailureError extends Error {
  public readonly details?: LoginFailureDetails;

  public constructor(message: string, details?: LoginFailureDetails) {
    super(message);
    this.name = "LoginFailureError";
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
