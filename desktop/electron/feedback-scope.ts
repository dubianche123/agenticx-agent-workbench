/**
 * Browser-safe guards for the Enterprise feedback account handshake.
 *
 * The renderer never supplies an identity to authorize a request. It carries
 * the complete account stamp that it rendered so the main process can reject a
 * delayed operation after an account transition. The main process still
 * obtains the token and current identity from its trusted config.
 */

export const DESKTOP_FEEDBACK_SCOPE_COMPONENT_MAX = 512;

function normalizeScopeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > DESKTOP_FEEDBACK_SCOPE_COMPONENT_MAX ||
    Array.from(normalized).some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return null;
  }
  return normalized;
}

function normalizeAuthGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type DesktopFeedbackAccountStamp = {
  /** Stable JSON [origin, tenant, user] identity; null means no feedback scope. */
  scopeId: string | null;
  /** Monotonic trusted main-process account generation. */
  authGeneration: number;
};

/**
 * Parse the complete account stamp carried by load-user-account/events.
 * `scopeId: null` is valid for logout or an account without a stable
 * tenant/user identity; feedback hydration remains disabled in that state.
 */
export function normalizeDesktopFeedbackAccountStamp(
  scopeId: unknown,
  authGeneration: unknown,
): DesktopFeedbackAccountStamp | null {
  const generation = normalizeAuthGeneration(authGeneration);
  if (generation === null) return null;
  if (scopeId === null || scopeId === undefined) {
    return { scopeId: null, authGeneration: generation };
  }
  const normalizedScopeId = normalizeScopeId(scopeId);
  return normalizedScopeId
    ? { scopeId: normalizedScopeId, authGeneration: generation }
    : null;
}

/** Compare two complete renderer/main account stamps, including null scope. */
export function desktopFeedbackAccountStampsEqual(
  leftScopeId: unknown,
  leftAuthGeneration: unknown,
  rightScopeId: unknown,
  rightAuthGeneration: unknown,
): boolean {
  const left = normalizeDesktopFeedbackAccountStamp(leftScopeId, leftAuthGeneration);
  const right = normalizeDesktopFeedbackAccountStamp(rightScopeId, rightAuthGeneration);
  return Boolean(
    left &&
      right &&
      left.authGeneration === right.authGeneration &&
      left.scopeId === right.scopeId,
  );
}

/**
 * Decide whether a newly returned trusted account snapshot may replace the
 * currently rendered one. Main's generation is monotonic, so a late response
 * from an older load cannot overwrite a newer account. Equal generations must
 * still carry the same complete scope.
 */
export function shouldApplyDesktopFeedbackAccountStamp(
  currentScopeId: unknown,
  currentAuthGeneration: unknown,
  nextScopeId: unknown,
  nextAuthGeneration: unknown,
): boolean {
  const next = normalizeDesktopFeedbackAccountStamp(nextScopeId, nextAuthGeneration);
  if (!next) {
    return normalizeDesktopFeedbackAccountStamp(currentScopeId, currentAuthGeneration) === null;
  }
  const current = normalizeDesktopFeedbackAccountStamp(currentScopeId, currentAuthGeneration);
  if (!current) return true;
  if (next.authGeneration < current.authGeneration) return false;
  if (next.authGeneration > current.authGeneration) return true;
  return next.scopeId === current.scopeId;
}

/**
 * Verify a feedback scope handshake against the complete trusted auth stamp.
 * Both scope and generation are mandatory. Origin/email are deliberately not
 * accepted because equal email addresses can belong to different tenants.
 */
export function desktopFeedbackScopeHandshakeMatches(
  expectedScopeId: unknown,
  currentScopeId: unknown,
  expectedAuthGeneration: unknown,
  currentAuthGeneration: unknown,
): boolean {
  const expected = normalizeDesktopFeedbackAccountStamp(expectedScopeId, expectedAuthGeneration);
  const current = normalizeDesktopFeedbackAccountStamp(currentScopeId, currentAuthGeneration);
  return Boolean(
    expected &&
      current &&
      expected.scopeId &&
      current.scopeId &&
      expected.scopeId === current.scopeId &&
      expected.authGeneration === current.authGeneration,
  );
}

/** Parse and bound an opaque scope returned by the trusted host. */
export function normalizeDesktopFeedbackAccountScope(value: unknown): string | null {
  return normalizeScopeId(value);
}
