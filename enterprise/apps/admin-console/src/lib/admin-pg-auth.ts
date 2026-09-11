import {
  LOGIN_LOCK_MINUTES,
  MAX_FAILED_LOGIN_ATTEMPTS,
  verifyPassword,
} from "@agenticx/auth";
import {
  aggregateScopesForUser,
  ensureSystemRoles,
  getDefaultOrgId,
  hasSomeScope,
  loadAuthUserByEmail,
  PgAuthUserRepository,
  reconcileUserPasswordHashByEmail,
} from "@agenticx/iam-core";
import { resolveAdminCredentials } from "./admin-session";

// Keep the unknown-account branch on the same bcrypt work path as a real
// account. The value is intentionally a fixed, non-secret hash: it is only a
// timing equalizer and can never authenticate an account.
const DUMMY_PASSWORD_HASH = "$2b$12$R5TsDDiK5/ir7TN4ps5Z.OaM.rP6ZrpSTkUcU3zV3L8.eWCeECHTC";

async function reconcileConfiguredAdminPasswordIfNeeded(input: {
  email: string;
  password: string;
  tenantId: string;
}): Promise<void> {
  const configured = resolveAdminCredentials();
  if (!configured) return;
  if (input.email.trim().toLowerCase() !== configured.email.trim().toLowerCase()) return;
  if (input.password !== configured.password) return;
  await reconcileUserPasswordHashByEmail({
    tenantId: input.tenantId,
    email: configured.email,
    password: configured.password,
  });
}

export type AdminConsoleAuthResult =
  | { ok: true; userId: string; tenantId: string; email: string }
  | {
      ok: false;
      reason: "invalid" | "disabled" | "locked" | "scope";
    };

export async function authenticateAdminConsoleUserDetailed(input: {
  email: string;
  password: string;
  tenantId: string;
}): Promise<AdminConsoleAuthResult> {
  await ensureSystemRoles(input.tenantId);
  await reconcileConfiguredAdminPasswordIfNeeded(input);
  const user = await loadAuthUserByEmail(input.tenantId, input.email.trim().toLowerCase());
  const now = Date.now();
  const hasActiveLock = Boolean(user?.lockedUntil && user.lockedUntil > now);
  const hasManualLock = user?.status === "locked" && !user.lockedUntil;

  const passwordHash =
    user && user.status !== "disabled" && !hasActiveLock && !hasManualLock
      ? user.passwordHash
      : DUMMY_PASSWORD_HASH;
  const ok = await verifyPassword(input.password, passwordHash);

  if (!user) return { ok: false, reason: "invalid" };
  if (user.status === "disabled") return { ok: false, reason: "disabled" };
  if (hasActiveLock || hasManualLock) {
    return { ok: false, reason: "locked" };
  }

  const userRepo = new PgAuthUserRepository(input.tenantId);
  if (!ok) {
    const failedCount = user.failedLoginCount + 1;
    const shouldLock = failedCount >= MAX_FAILED_LOGIN_ATTEMPTS;
    const lockedUntil = shouldLock ? now + LOGIN_LOCK_MINUTES * 60 * 1000 : null;
    await userRepo.updateFailedLogin(user.email, failedCount, lockedUntil);
    return { ok: false, reason: shouldLock ? "locked" : "invalid" };
  }

  await userRepo.resetFailedLogin(user.email);

  if (!hasSomeScope(user.scopes, ["admin:enter"])) return { ok: false, reason: "scope" };

  return { ok: true, userId: user.id, tenantId: user.tenantId, email: user.email.toLowerCase() };
}

export async function authenticateAdminConsoleUser(input: {
  email: string;
  password: string;
  tenantId: string;
}): Promise<{ userId: string; tenantId: string; email: string } | null> {
  const result = await authenticateAdminConsoleUserDetailed(input);
  return result.ok
    ? { userId: result.userId, tenantId: result.tenantId, email: result.email }
    : null;
}

export async function authenticateAdminConsoleViaOidc(input: {
  email: string;
  tenantId: string;
}): Promise<
  | { ok: true; userId: string; tenantId: string; email: string }
  | { ok: false; reason: "admin_unprovisioned" | "admin_scope_missing" | "account_disabled" }
> {
  await ensureSystemRoles(input.tenantId);
  const user = await loadAuthUserByEmail(input.tenantId, input.email.trim().toLowerCase());
  if (!user) return { ok: false, reason: "admin_unprovisioned" };
  if (user.status === "disabled" || user.status === "locked" || (user.lockedUntil && user.lockedUntil > Date.now())) {
    return { ok: false, reason: "account_disabled" };
  }
  const scopes = await aggregateScopesForUser(input.tenantId, user.id);
  if (!hasSomeScope(scopes, ["admin:enter"])) {
    return { ok: false, reason: "admin_scope_missing" };
  }
  return { ok: true, userId: user.id, tenantId: user.tenantId, email: user.email.toLowerCase() };
}

export { getDefaultOrgId };
