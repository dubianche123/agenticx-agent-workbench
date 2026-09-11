import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  startEnterpriseActionBroker,
  type EnterpriseActionAuth,
  type EnterpriseActionBinding,
} from "../electron/enterprise-action-broker";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
  });
}

function sendJson(response: ServerResponse, payload: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test portal did not listen");
  return address.port;
}

describe("enterprise action broker", () => {
  const resources: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (resources.length) await resources.pop()?.close();
  });

  it("keeps PATs in session bootstrap, sanitizes results, and recovers operations after restart", async () => {
    const portalRequests: Array<{ path: string; authorization: string; body: string }> = [];
    const portal = createServer(async (request, response) => {
      const body = await readBody(request);
      portalRequests.push({
        path: String(request.url || ""),
        authorization: String(request.headers.authorization || ""),
        body,
      });
      const path = String(request.url || "");
      if (path === "/api/desktop/assistant/sessions") {
        sendJson(response, {
          code: "00000",
          message: "ok",
          data: {
            sessionToken: "short-lived-session-token",
            expiresAt: Date.now() + 300_000,
            authorizationVersion: "role-v1",
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/capabilities") {
        sendJson(response, {
          code: "00000",
          data: {
            authorizationVersion: "role-v1",
            actions: [{
              id: "member.quota.set",
              label: "Set quota",
              description: "change quota",
              effect: "write",
              inputSchema: {
                type: "object",
                properties: {
                  monthlyTokens: { type: "number" },
                  providerApiKey: { type: "string" },
                },
              },
            }],
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/actions") {
        sendJson(response, {
          code: "00000",
          message: "upstream echoed PAT-test-value-1234",
          data: {
            status: "awaiting_confirmation",
            operationId: "operation-1",
            authorizationVersion: "role-v1",
            proposal: { title: "Set quota", changes: { monthlyTokens: 100 } },
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/operations/operation-1/confirm") {
        sendJson(response, {
          code: "00000",
          data: {
            status: "succeeded",
            operationId: "operation-1",
            authorizationVersion: "role-v1",
            result: {
              monthlyTokens: 100,
              providerApiKey: "must-not-reach-model",
              privateKey: "must-not-reach-model",
            },
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/operations/operation-1") {
        sendJson(response, {
          code: "00000",
          data: {
            status: "succeeded",
            operationId: "operation-1",
            authorizationVersion: "role-v1",
            result: {
              monthlyTokens: 100,
              providerApiKey: "must-not-reach-model",
            },
          },
        });
        return;
      }
      response.statusCode = 404;
      sendJson(response, { code: "NOT_FOUND", message: "not found" });
    });
    const portalPort = await listen(portal);
    resources.push({
      close: () => new Promise<void>((resolve) => portal.close(() => resolve())),
    });

    const auth: EnterpriseActionAuth = {
      portalOrigin: `http://127.0.0.1:${portalPort}`,
      token: "PAT-test-value-1234",
      identityKey: "identity-1",
      scopeId: "scope-1",
      authGeneration: 7,
    };
    const resolveSession = async (sessionId: string) => sessionId === "session-1"
      ? {
          sessionId,
          purpose: "environment-assistant" as const,
          purposeScope: "scope-1",
          permissionMode: "ask" as const,
        }
      : null;
    const broker = await startEnterpriseActionBroker(() => auth, resolveSession);
    resources.push({ close: broker.close });
    const headers = {
      "content-type": "application/json",
      "x-agx-enterprise-action-broker-token": broker.token,
    };
    const call = async (path: string, init: RequestInit = {}) => fetch(`${broker.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
    });
    const binding: EnterpriseActionBinding = {
      sessionId: "session-1",
      permissionMode: "ask",
      authGeneration: 7,
    };

    const preflight = await call("/preflight", {
      method: "POST",
      body: JSON.stringify({ sessionId: "session-1", permissionMode: "ask" }),
    });
    expect((await preflight.json()).authorizationVersion).toBe("role-v1");

    const capabilities = await call("/capabilities", {
      method: "POST",
      body: JSON.stringify({ sessionId: "session-1", permissionMode: "ask" }),
    });
    const capabilityBody = await capabilities.json() as { capabilities: Array<{ inputSchema: Record<string, unknown> }> };
    expect(capabilityBody.capabilities[0]?.inputSchema.properties).toEqual({
      monthlyTokens: { type: "number" },
    });

    const forgedConfirmation = await call("/actions", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "session-1",
        permissionMode: "ask",
        actionId: "member.quota.set",
        arguments: { memberId: "member-1", monthlyTokens: 100, confirmed: true },
        idempotencyKey: "idempotency-forged",
        runId: "run-forged",
      }),
    });
    expect(forgedConfirmation.status).toBe(400);
    expect((await forgedConfirmation.json()).code).toBe("ARGUMENT_IDENTITY_OVERRIDE");

    const action = await call("/actions", {
      method: "POST",
      body: JSON.stringify({
        sessionId: "session-1",
        permissionMode: "ask",
        actionId: "member.quota.set",
        arguments: { memberId: "member-1", monthlyTokens: 100 },
        idempotencyKey: "idempotency-1",
        runId: "run-1",
      }),
    });
    const actionBody = await action.json() as { operationId?: string; message?: string };
    expect(actionBody.operationId).toBe("operation-1");
    expect(actionBody.message).not.toContain("PAT-test-value-1234");

    const confirmed = await broker.confirmOperation("operation-1", binding);
    expect(confirmed.status).toBe("succeeded");
    expect(confirmed.result).toEqual({ monthlyTokens: 100 });

    const operation = await broker.getOperation("operation-1", binding);
    expect(operation.status).toBe("succeeded");
    expect(operation.result).toEqual({ monthlyTokens: 100 });
    const operationForPython = await call("/operations/operation-1");
    expect((await operationForPython.json()).status).toBe("succeeded");

    const sessionBootstrap = portalRequests.filter((row) => row.path === "/api/desktop/assistant/sessions");
    expect(sessionBootstrap.length).toBeGreaterThan(0);
    expect(sessionBootstrap.every((row) => row.authorization === "Bearer PAT-test-value-1234")).toBe(true);
    const nonBootstrap = portalRequests.filter((row) => row.path !== "/api/desktop/assistant/sessions");
    expect(nonBootstrap.every((row) => row.authorization === "Bearer short-lived-session-token")).toBe(true);

    // A fresh broker has no pending map, but recovery still asks the Portal
    // with a newly delegated, same-session token before accepting the id.
    await broker.close();
    const recoveredBroker = await startEnterpriseActionBroker(() => auth, resolveSession);
    resources.push({ close: recoveredBroker.close });
    const recovered = await recoveredBroker.getOperation("operation-1", binding);
    expect(recovered.status).toBe("succeeded");
    expect(recovered.result).toEqual({ monthlyTokens: 100 });
  });

  it("rejects a binding for a different assistant session or permission mode", async () => {
    const portal = createServer((_request, response) => {
      sendJson(response, {
        code: "OK",
        data: {
          sessionToken: "short-lived-session-token",
          expiresAt: Date.now() + 300_000,
          authorizationVersion: "role-v1",
        },
      });
    });
    const portalPort = await listen(portal);
    resources.push({
      close: () => new Promise<void>((resolve) => portal.close(() => resolve())),
    });
    const broker = await startEnterpriseActionBroker(
      () => ({
        portalOrigin: `http://127.0.0.1:${portalPort}`,
        token: "PAT-test-value-1234",
        identityKey: "identity-1",
        scopeId: "scope-1",
        authGeneration: 7,
      }),
      async (sessionId) => sessionId === "session-1"
        ? {
            sessionId,
            purpose: "environment-assistant" as const,
            purposeScope: "scope-1",
            permissionMode: "ask" as const,
          }
        : null,
    );
    resources.push({ close: broker.close });
    await expect(broker.getOperation("operation-1", {
      sessionId: "other-session",
      permissionMode: "ask",
      authGeneration: 7,
    })).rejects.toThrow();
    await expect(broker.getOperation("operation-1", {
      sessionId: "session-1",
      permissionMode: "auto",
      authGeneration: 7,
    })).rejects.toThrow();
  });

  it("does not reuse a cached authorization version when a fresh snapshot omits it", async () => {
    let capabilityCalls = 0;
    const portal = createServer(async (request, response) => {
      await readBody(request);
      const path = String(request.url || "");
      if (path === "/api/desktop/assistant/sessions") {
        sendJson(response, {
          code: "OK",
          data: {
            sessionToken: "short-lived-session-token",
            expiresAt: Date.now() + 300_000,
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/capabilities") {
        capabilityCalls += 1;
        sendJson(response, {
          code: "OK",
          data: capabilityCalls === 1 ? { authorizationVersion: "role-v1", actions: [] } : { actions: [] },
        });
        return;
      }
      response.statusCode = 404;
      sendJson(response, { code: "NOT_FOUND" });
    });
    const portalPort = await listen(portal);
    resources.push({
      close: () => new Promise<void>((resolve) => portal.close(() => resolve())),
    });
    const broker = await startEnterpriseActionBroker(
      () => ({
        portalOrigin: `http://127.0.0.1:${portalPort}`,
        token: "PAT-test-value-1234",
        identityKey: "identity-1",
        scopeId: "scope-1",
        authGeneration: 7,
      }),
      async (sessionId) => sessionId === "session-1"
        ? {
            sessionId,
            purpose: "environment-assistant" as const,
            purposeScope: "scope-1",
            permissionMode: "ask" as const,
          }
        : null,
    );
    resources.push({ close: broker.close });

    const first = await broker.preflightAuthorization("session-1", "ask");
    expect(first.ok).toBe(true);
    expect(first.authorizationVersion).toBe("role-v1");
    const second = await broker.preflightAuthorization("session-1", "ask");
    expect(second.ok).toBe(false);
    expect(second.code).toBe("ASSISTANT_AUTH_VERSION_UNAVAILABLE");
    expect(second.authorizationVersion).toBeUndefined();
  });

  it("accepts the Portal success contract and rejects unknown or missing codes on HTTP 200", async () => {
    let capabilitiesEnvelope: unknown = {
      code: "50000",
      message: "denied",
      data: { authorizationVersion: "role-v1", actions: [] },
    };
    const portal = createServer(async (request, response) => {
      await readBody(request);
      const path = String(request.url || "");
      if (path === "/api/desktop/assistant/sessions") {
        sendJson(response, {
          code: "00000",
          message: "ok",
          data: {
            sessionToken: "short-lived-session-token",
            expiresAt: Date.now() + 300_000,
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/capabilities") {
        sendJson(response, capabilitiesEnvelope);
        return;
      }
      response.statusCode = 404;
      sendJson(response, { code: "40400", message: "not found" });
    });
    const portalPort = await listen(portal);
    resources.push({
      close: () => new Promise<void>((resolve) => portal.close(() => resolve())),
    });
    const broker = await startEnterpriseActionBroker(
      () => ({
        portalOrigin: `http://127.0.0.1:${portalPort}`,
        token: "PAT-test-value-1234",
        identityKey: "identity-1",
        scopeId: "scope-1",
        authGeneration: 7,
      }),
      async (sessionId) => sessionId === "session-1"
        ? {
            sessionId,
            purpose: "environment-assistant" as const,
            purposeScope: "scope-1",
            permissionMode: "ask" as const,
          }
        : null,
    );
    resources.push({ close: broker.close });
    const headers = {
      "content-type": "application/json",
      "x-agx-enterprise-action-broker-token": broker.token,
    };
    const call = async (path: string, init: RequestInit = {}) => fetch(`${broker.url}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers || {}) },
    });
    const request = {
      sessionId: "session-1",
      permissionMode: "ask",
    };

    const failed = await call("/capabilities", { method: "POST", body: JSON.stringify(request) });
    expect(failed.status).toBe(403);
    expect(await failed.json()).toMatchObject({ code: "50000", message: "denied" });

    capabilitiesEnvelope = {
      message: "missing code",
      data: { authorizationVersion: "role-v1", actions: [] },
    };
    const malformed = await call("/capabilities", { method: "POST", body: JSON.stringify(request) });
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ code: "ASSISTANT_PROTOCOL_INVALID" });
  });

  it("fails closed when a success-coded action envelope has no recognized status", async () => {
    const portal = createServer(async (request, response) => {
      await readBody(request);
      const path = String(request.url || "");
      if (path === "/api/desktop/assistant/sessions") {
        sendJson(response, {
          code: "00000",
          message: "ok",
          data: {
            sessionToken: "short-lived-session-token",
            expiresAt: Date.now() + 300_000,
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/actions") {
        sendJson(response, {
          code: "00000",
          message: "ok",
          data: { operationId: "operation-1" },
        });
        return;
      }
      response.statusCode = 404;
      sendJson(response, { code: "40400", message: "not found" });
    });
    const portalPort = await listen(portal);
    resources.push({
      close: () => new Promise<void>((resolve) => portal.close(() => resolve())),
    });
    const broker = await startEnterpriseActionBroker(
      () => ({
        portalOrigin: `http://127.0.0.1:${portalPort}`,
        token: "PAT-test-value-1234",
        identityKey: "identity-1",
        scopeId: "scope-1",
        authGeneration: 7,
      }),
      async (sessionId) => sessionId === "session-1"
        ? {
            sessionId,
            purpose: "environment-assistant" as const,
            purposeScope: "scope-1",
            permissionMode: "ask" as const,
          }
        : null,
    );
    resources.push({ close: broker.close });
    const response = await fetch(`${broker.url}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agx-enterprise-action-broker-token": broker.token,
      },
      body: JSON.stringify({
        sessionId: "session-1",
        permissionMode: "ask",
        actionId: "member.quota.set",
        arguments: { memberId: "member-1", monthlyTokens: 100 },
        idempotencyKey: "idempotency-1",
        runId: "run-1",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "failed",
      code: "ASSISTANT_PROTOCOL_INVALID",
    });
  });

  it("preserves terminal operation errors and maps only an actual HTTP 404 during recovery", async () => {
    let operationResponse: { status: number; body: unknown } = {
      status: 200,
      body: {
        code: "00000",
        message: "ok",
        data: {
          status: "expired",
          operationId: "operation-expired",
          errorCode: "ACTION_CONFIRMATION_EXPIRED",
          errorMessage: "confirmation window expired",
        },
      },
    };
    const portal = createServer(async (request, response) => {
      await readBody(request);
      const path = String(request.url || "");
      if (path === "/api/desktop/assistant/sessions") {
        sendJson(response, {
          code: "00000",
          message: "ok",
          data: {
            sessionToken: "short-lived-session-token",
            expiresAt: Date.now() + 300_000,
          },
        });
        return;
      }
      if (path === "/api/desktop/assistant/operations/operation-expired") {
        response.statusCode = operationResponse.status;
        sendJson(response, operationResponse.body);
        return;
      }
      response.statusCode = 404;
      sendJson(response, { code: "40400", message: "not found" });
    });
    const portalPort = await listen(portal);
    resources.push({
      close: () => new Promise<void>((resolve) => portal.close(() => resolve())),
    });
    const auth: EnterpriseActionAuth = {
      portalOrigin: `http://127.0.0.1:${portalPort}`,
      token: "PAT-test-value-1234",
      identityKey: "identity-1",
      scopeId: "scope-1",
      authGeneration: 7,
    };
    const resolveSession = async (sessionId: string) => sessionId === "session-1"
      ? {
          sessionId,
          purpose: "environment-assistant" as const,
          purposeScope: "scope-1",
          permissionMode: "ask" as const,
        }
      : null;
    const broker = await startEnterpriseActionBroker(() => auth, resolveSession);
    resources.push({ close: broker.close });
    const binding: EnterpriseActionBinding = {
      sessionId: "session-1",
      permissionMode: "ask",
      authGeneration: 7,
    };

    await expect(broker.getOperation("operation-expired", binding)).rejects.toMatchObject({
      status: 409,
      code: "ACTION_CONFIRMATION_EXPIRED",
      message: "confirmation window expired",
    });

    operationResponse = {
      status: 404,
      body: { code: "ACTION_OPERATION_NOT_FOUND", message: "operation missing" },
    };
    await expect(broker.getOperation("operation-expired", binding)).rejects.toMatchObject({
      status: 404,
      code: "ENTERPRISE_OPERATION_NOT_FOUND",
    });

    operationResponse = {
      status: 403,
      body: { code: "ASSISTANT_AUTH_REVOKED", message: "originating PAT revoked" },
    };
    await expect(broker.getOperation("operation-expired", binding)).rejects.toMatchObject({
      status: 403,
      code: "ASSISTANT_AUTH_REVOKED",
      message: "originating PAT revoked",
    });

    operationResponse = {
      status: 200,
      body: { code: "00000", message: "ok", data: { status: "not-a-real-status" } },
    };
    await expect(broker.getOperation("operation-expired", binding)).rejects.toMatchObject({
      status: 502,
      code: "ASSISTANT_PROTOCOL_INVALID",
    });
  });
});
