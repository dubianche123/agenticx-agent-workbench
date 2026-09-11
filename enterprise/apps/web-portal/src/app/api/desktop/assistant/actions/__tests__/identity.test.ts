import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSystemRoles: vi.fn(),
  listPrincipals: vi.fn(),
  createAgentPrincipal: vi.fn(),
}));

vi.mock("@agenticx/action-runtime", () => ({
  ActionRegistry: class { constructor(_definitions: unknown) {} },
  ActionRuntime: class { constructor(_options: unknown) {} },
  SqlActionStore: class {},
  AssistantSessionError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  ASSISTANT_AUTH_REVOKED: "ASSISTANT_AUTH_REVOKED",
  ASSISTANT_REAUTH_REQUIRED: "ASSISTANT_REAUTH_REQUIRED",
  ASSISTANT_SESSION_REVOKED: "ASSISTANT_SESSION_REVOKED",
  ENTERPRISE_CONTEXT_STALE: "ENTERPRISE_CONTEXT_STALE",
  authenticateAssistantSession: vi.fn(),
  hashAssistantSessionToken: vi.fn(),
  issueAssistantSession: vi.fn(),
  requestContextFromSession: vi.fn(),
  sessionTokenFromRequest: vi.fn(),
  staleContextError: vi.fn(),
}));

vi.mock("@agenticx/enterprise-domain", () => ({ createEnterpriseActionDefinitions: () => [] }));
vi.mock("@agenticx/iam-core", () => ({
  createAgentPrincipal: (...args: unknown[]) => mocks.createAgentPrincipal(...args),
  ensureSystemRoles: (...args: unknown[]) => mocks.ensureSystemRoles(...args),
  ensureUserPrincipal: vi.fn(),
  getAdminUser: vi.fn(),
  getPrincipalForUser: vi.fn(),
  getUserAuthorizationContext: vi.fn(),
  listPrincipalRoleBindings: vi.fn(),
  resolveAssignmentKeysForUser: vi.fn(async () => []),
  resolveAssignmentKeysForManagedDelivery: vi.fn(async () => []),
  listPrincipals: (...args: unknown[]) => mocks.listPrincipals(...args),
  listPats: vi.fn(),
  authorizePrincipalAction: vi.fn(),
  resolveDatabaseConfig: vi.fn(() => ({ dialect: "postgresql" })),
}));
vi.mock("../../../../../../lib/desktop-auth", () => ({ resolveDesktopIdentity: vi.fn() }));

const activeAgent = {
  id: "agent-pa",
  tenantId: "tenant-a",
  kind: "agent" as const,
  userId: null,
  displayName: "Personal Assistant",
  status: "active" as const,
  authzVersion: 1,
  agentProfile: {
    principalId: "agent-pa",
    tenantId: "tenant-a",
    mode: "delegated" as const,
    ownerUserId: "user-a",
    definitionRef: "personal_assistant",
    definitionVersion: 1,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("personal assistant durable identity bootstrap", () => {
  beforeEach(() => {
    mocks.ensureSystemRoles.mockReset();
    mocks.listPrincipals.mockReset();
    mocks.createAgentPrincipal.mockReset();
    mocks.ensureSystemRoles.mockResolvedValue(undefined);
    mocks.listPrincipals.mockResolvedValue([]);
    mocks.createAgentPrincipal.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return activeAgent;
    });
  });

  it("coalesces concurrent local bootstrap and returns one durable principal", async () => {
    const { ensurePersonalAssistantAgent } = await import("../../../../../../lib/desktop-assistant");
    const [first, second] = await Promise.all([
      ensurePersonalAssistantAgent("tenant-a", "user-a"),
      ensurePersonalAssistantAgent("tenant-a", "user-a"),
    ]);
    expect(first.id).toBe("agent-pa");
    expect(second.id).toBe("agent-pa");
    expect(mocks.createAgentPrincipal).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the durable identity exists but is disabled", async () => {
    mocks.listPrincipals.mockResolvedValue([{ ...activeAgent, status: "disabled" }]);
    const { ensurePersonalAssistantAgent } = await import("../../../../../../lib/desktop-assistant");
    await expect(ensurePersonalAssistantAgent("tenant-a", "user-a")).rejects.toMatchObject({
      code: "ASSISTANT_AUTH_REVOKED",
      status: 401,
    });
    expect(mocks.createAgentPrincipal).not.toHaveBeenCalled();
  });
});
