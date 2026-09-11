import { describe, expect, it } from "vitest";
import { MemoryActionStore } from "../sql-store";
import {
  ASSISTANT_SESSION_REVOKED,
  authenticateAssistantSession,
  issueAssistantSession,
} from "../sessions";

describe("durable assistant session leases", () => {
  it("preserves the original deadline when a Studio session resumes", async () => {
    const store = new MemoryActionStore();
    const firstNow = new Date("2026-09-10T00:00:00.000Z");
    const first = await issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: 7,
      originKind: "desktop_pat",
      studioSessionId: "studio-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v1",
      now: firstNow,
    });

    const resumed = await issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: 7,
      originKind: "desktop_pat",
      studioSessionId: "studio-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v1",
      now: new Date("2026-09-10T00:10:00.000Z"),
    });

    expect(resumed.session.id).toBe(first.session.id);
    expect(resumed.session.expiresAt).toBe(first.session.expiresAt);
    expect(resumed.token).not.toBe(first.token);
  });

  it("retires the old session when the authorization snapshot changes", async () => {
    const store = new MemoryActionStore();
    const first = await issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: 7,
      originKind: "desktop_pat",
      studioSessionId: "studio-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v1",
      now: new Date("2026-09-10T00:00:00.000Z"),
    });

    const next = await issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: 7,
      originKind: "desktop_pat",
      studioSessionId: "studio-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v2",
      now: new Date("2026-09-10T00:10:00.000Z"),
    });

    expect(next.session.id).not.toBe(first.session.id);
    expect(store.sessions.get(first.session.id)?.status).toBe("revoked");
    await expect(authenticateAssistantSession({
      store,
      token: first.token,
      identity: { tenantId: "tenant-a", userId: "user-a", tokenId: 7 },
    })).rejects.toMatchObject({ code: ASSISTANT_SESSION_REVOKED });
  });

  it("keeps cookie-owned sessions PAT-free and isolated by origin", async () => {
    const store = new MemoryActionStore();
    const admin = await issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: null,
      originKind: "admin_cookie",
      studioSessionId: "support:tenant-a:user-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v1",
    });
    const portal = await issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: null,
      originKind: "portal_cookie",
      studioSessionId: "support:tenant-a:user-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v1",
    });

    expect(admin.session.originatingPatId).toBeNull();
    expect(admin.session.originKind).toBe("admin_cookie");
    expect(portal.session.id).not.toBe(admin.session.id);
    expect(portal.session.originKind).toBe("portal_cookie");
    await expect(authenticateAssistantSession({
      store,
      token: admin.token,
      identity: { tenantId: "tenant-a", userId: "user-a", tokenId: 7 },
    })).rejects.toMatchObject({ code: "ASSISTANT_REAUTH_REQUIRED" });
  });

  it("rejects a PAT id attached to a cookie-owned session", async () => {
    const store = new MemoryActionStore();
    await expect(issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: 7,
      originKind: "portal_cookie",
      studioSessionId: "portal-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v1",
    })).rejects.toMatchObject({ code: "ASSISTANT_REAUTH_REQUIRED" });
  });

  it("rejects an unknown session origin before persistence", async () => {
    const store = new MemoryActionStore();
    await expect(issueAssistantSession({
      store,
      tenantId: "tenant-a",
      userId: "user-a",
      agentPrincipalId: "agent-a",
      originatingPatId: null,
      originKind: "unknown" as never,
      studioSessionId: "portal-a",
      permissionMode: "ask",
      authorizationVersion: "auth-v1",
    })).rejects.toMatchObject({ code: "ASSISTANT_REAUTH_REQUIRED" });
    expect(store.sessions.size).toBe(0);
  });
});
