import { NextResponse } from "next/server";
import {
  LOGIN_LOCK_MINUTES,
  MAX_FAILED_LOGIN_ATTEMPTS,
} from "@agenticx/auth";
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionToken,
  isAdminCookieSecure,
  resolveAdminCredentials,
} from "../../../../lib/admin-session";
import { authenticateAdminConsoleUserDetailed } from "../../../../lib/admin-pg-auth";
import { ADMIN_LOGIN_FAILURE_MESSAGE } from "../../../../lib/admin-login-failure-message";

type DevLoginFailureState = { failedAttempts: number; lockedUntil: number | null };
const devLoginFailures = new Map<string, DevLoginFailureState>();

function recordDevLoginFailure(email: string, now = Date.now()): DevLoginFailureState {
  const previous = devLoginFailures.get(email.trim().toLowerCase()) ?? { failedAttempts: 0, lockedUntil: null };
  const failedAttempts = previous.failedAttempts + 1;
  const lockedUntil = failedAttempts >= MAX_FAILED_LOGIN_ATTEMPTS
    ? now + LOGIN_LOCK_MINUTES * 60 * 1000
    : null;
  const next = { failedAttempts, lockedUntil };
  devLoginFailures.set(email.trim().toLowerCase(), next);
  return next;
}

function getDevLoginFailure(email: string, now = Date.now()): DevLoginFailureState | null {
  const state = devLoginFailures.get(email.trim().toLowerCase());
  if (!state) return null;
  if (state.lockedUntil && state.lockedUntil <= now) {
    devLoginFailures.delete(email.trim().toLowerCase());
    return null;
  }
  return state;
}

function invalidCredentialsResponse(): NextResponse {
  return NextResponse.json(
    { code: "40100", message: ADMIN_LOGIN_FAILURE_MESSAGE },
    { status: 401 },
  );
}

function getDefaultTenantId(): string | null {
  return process.env.DEFAULT_TENANT_ID?.trim() || null;
}

function jsonWithSessionCookie(email: string, userId: string, tenantId: string) {
  const token = createAdminSessionToken(email, userId, tenantId);
  const response = NextResponse.json({ code: "00000", message: "ok" });
  response.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isAdminCookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 8,
  });
  return response;
}

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = (await request.json()) as { email?: string; password?: string };
  } catch {
    return NextResponse.json({ code: "40001", message: "invalid json" }, { status: 400 });
  }
  if (!body.email || !body.password) {
    return invalidCredentialsResponse();
  }

  const tenantId = getDefaultTenantId();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const isProd = process.env.NODE_ENV === "production";

  if (isProd && (!databaseUrl || !tenantId)) {
    return NextResponse.json(
      {
        code: "50300",
        message: "DATABASE_URL and DEFAULT_TENANT_ID are required in production",
      },
      { status: 503 }
    );
  }

  if (databaseUrl && tenantId) {
    const authed = await authenticateAdminConsoleUserDetailed({
      email: body.email,
      password: body.password,
      tenantId,
    });
    if (!authed.ok) {
      return invalidCredentialsResponse();
    }
    return jsonWithSessionCookie(authed.email, authed.userId, authed.tenantId);
  }

  if (isProd) {
    return NextResponse.json(
      { code: "50300", message: "admin login requires PostgreSQL configuration in production" },
      { status: 503 }
    );
  }

  const credentials = resolveAdminCredentials();
  if (!credentials) {
    return NextResponse.json({ code: "50300", message: "admin login is not configured" }, { status: 503 });
  }
  const normalizedEmail = body.email.trim().toLowerCase();
  const normalizedCredentialEmail = credentials.email.trim().toLowerCase();
  const devFailure = getDevLoginFailure(normalizedEmail);
  if (devFailure?.lockedUntil && devFailure.lockedUntil > Date.now()) {
    return invalidCredentialsResponse();
  }
  if (normalizedEmail !== normalizedCredentialEmail || body.password !== credentials.password) {
    if (normalizedEmail === normalizedCredentialEmail) recordDevLoginFailure(normalizedEmail);
    return invalidCredentialsResponse();
  }

  devLoginFailures.delete(normalizedEmail);

  if (!tenantId) {
    return NextResponse.json({ code: "50300", message: "DEFAULT_TENANT_ID is required" }, { status: 503 });
  }

  return jsonWithSessionCookie(credentials.email, "01J00000000000000000000004", tenantId);
}
