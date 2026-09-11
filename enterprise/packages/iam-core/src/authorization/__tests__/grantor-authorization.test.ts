import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizePrincipalAction } from "../authorize";
import { assertGrantable } from "../grantability";
import { createAgentPrincipal, updateAgentPrincipal } from "../principals";
import { roleMutationSnapshotMatches, roleScopeFingerprint } from "../types";

const mocks = vi.hoisted(() => ({
  repository: {} as Record<string, any>,
  getUserAuthorizationContext: vi.fn(),
}));

vi.mock("../repository", () => ({
  getPrincipalRepository: () => mocks.repository,
}));

vi.mock("../context", () => ({
  getUserAuthorizationContext: (...args: unknown[]) => mocks.getUserAuthorizationContext(...args),
  effectivePermissionsFromBindings: (bindings: any[]) => bindings.flatMap((binding) => binding.scopes.map((scope: string) => ({
    scope,
    roleCode: binding.roleCode,
    bindingId: binding.id,
    dataScope: binding.dataScope,
    scopeOrgId: binding.scopeOrgId,
    scopeDeptId: binding.scopeDeptId,
    expiresAt: binding.expiresAt,
    resolution: binding.resolution,
    grantedByPrincipalId: binding.grantedByPrincipalId ?? null,
    canDelegate: Boolean(binding.canDelegate),
    grantorApprovalRef: binding.grantorApprovalRef ?? null,
  }))),
}));

const actorPrincipal = {
  id: "principal-actor",
  tenantId: "tenant-a",
  kind: "user" as const,
  userId: "user-actor",
  displayName: "Actor",
  status: "active" as const,
  authzVersion: 3,
  agentProfile: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const targetPrincipal = {
  ...actorPrincipal,
  id: "principal-target",
  userId: "user-target",
};

function permission(overrides: Record<string, unknown> = {}) {
  return {
    scope: "user:read",
    roleCode: "operator",
    bindingId: "binding-1",
    dataScope: "tenant" as const,
    scopeOrgId: null,
    scopeDeptId: null,
    expiresAt: null,
    resolution: "resolved" as const,
    grantedByPrincipalId: null,
    canDelegate: false,
    grantorApprovalRef: null,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-a",
    userId: "user-actor",
    userPrincipal: actorPrincipal,
    agentPrincipal: null,
    userStatus: "active" as const,
    roleCodes: ["admin"],
    scopes: ["user:read"],
    bindings: [],
    effectivePermissions: [permission()],
    authzVersion: 3,
    unresolvedBindingIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.repository = {
    resolveAuthorizationTarget: vi.fn(async (_tenantId: string, target: { kind: string; id: string }) => ({
      kind: target.kind,
      id: target.id,
      tenantId: "tenant-a",
      deptId: target.id === "dept-a" || target.id === "dept-b" ? target.id : "dept-a",
      ownerUserId: target.kind === "user" ? target.id : null,
    })),
    getPrincipal: vi.fn(async (_tenantId: string, principalId: string) => principalId === targetPrincipal.id ? targetPrincipal : null),
    getPrincipalEffectivePermissions: vi.fn(async () => []),
    getUserStatus: vi.fn(async () => "active"),
    getRoleDefinition: vi.fn(async () => ({ id: "role-operator", tenantId: "tenant-a", code: "operator", scopes: ["user:read"], immutable: false })),
    departmentScopeContains: vi.fn(async (_tenantId: string, sourceDept: string, targetDept: string) => sourceDept === targetDept),
    listLegacyUserRoleBindings: vi.fn(async () => []),
    listPrincipalRoleBindings: vi.fn(async () => []),
    countActiveUsersWithRole: vi.fn(async () => 2),
    listRoleDefinitions: vi.fn(async () => []),
  };
  mocks.getUserAuthorizationContext.mockReset();
  mocks.getUserAuthorizationContext.mockResolvedValue(context());
});

describe("principal action authorization", () => {
  it("matches the action and data range on one effective binding", async () => {
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "user:update", dataScope: "department", scopeDeptId: "dept-a", bindingId: "same-binding" })],
    }));
    mocks.repository.resolveAuthorizationTarget.mockResolvedValue({
      kind: "user",
      id: "user-target",
      tenantId: "tenant-a",
      deptId: "dept-a",
      ownerUserId: "user-target",
    });

    const decision = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      requiredScopes: ["user:update"],
      target: { kind: "user", id: "user-target" },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPermissions).toEqual([
      expect.objectContaining({ bindingId: "same-binding", scopeDeptId: "dept-a" }),
    ]);
  });

  it("requires both user and delegated-agent permission for an action", async () => {
    const agent = {
      ...targetPrincipal,
      id: "agent-pa",
      kind: "agent" as const,
      userId: null,
      agentProfile: {
        principalId: "agent-pa",
        tenantId: "tenant-a",
        mode: "delegated" as const,
        ownerUserId: "user-actor",
        definitionRef: "personal_assistant",
        definitionVersion: 1,
      },
    };
    mocks.repository.getPrincipal.mockResolvedValue(agent);
    const agentBinding = {
      id: "agent-binding",
      roleCode: "personal_assistant",
      scopes: ["user:read"],
      dataScope: "tenant",
      scopeOrgId: null,
      scopeDeptId: null,
      expiresAt: null,
      status: "active",
      resolution: "resolved",
      source: "explicit",
      grantedByPrincipalId: "principal-actor",
      canDelegate: false,
      grantorApprovalRef: null,
    };
    mocks.repository.listPrincipalRoleBindings.mockResolvedValue([agentBinding]);
    mocks.repository.getPrincipalEffectivePermissions.mockResolvedValue([agentBinding]);
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "user:read", bindingId: "user-binding" })],
    }));
    mocks.repository.resolveAuthorizationTarget.mockResolvedValue({
      kind: "user",
      id: "user-target",
      tenantId: "tenant-a",
      deptId: "dept-a",
      ownerUserId: "user-target",
    });

    const decision = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      agentPrincipalId: "agent-pa",
      requiredScopes: ["user:read"],
      target: { kind: "user", id: "user-target" },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPermissions.map((item) => item.bindingId)).toEqual(["agent-binding", "user-binding"]);

    mocks.repository.getPrincipalEffectivePermissions.mockResolvedValue([]);
    const denied = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      agentPrincipalId: "agent-pa",
      requiredScopes: ["user:read"],
      target: { kind: "user", id: "user-target" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("missing_scope");
  });

  it("inherits the owner's live permissions when no agent ceiling is bound", async () => {
    const agent = {
      ...targetPrincipal,
      id: "agent-pa",
      kind: "agent" as const,
      userId: null,
      agentProfile: {
        principalId: "agent-pa",
        tenantId: "tenant-a",
        mode: "delegated" as const,
        ownerUserId: "user-actor",
        definitionRef: "personal_assistant",
        definitionVersion: 1,
      },
    };
    mocks.repository.getPrincipal.mockResolvedValue(agent);
    mocks.repository.listPrincipalRoleBindings.mockResolvedValue([]);
    mocks.repository.getPrincipalEffectivePermissions.mockResolvedValue([]);
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "user:read", bindingId: "owner-binding" })],
    }));
    mocks.repository.resolveAuthorizationTarget.mockResolvedValue({
      kind: "user",
      id: "user-target",
      tenantId: "tenant-a",
      deptId: "dept-a",
      ownerUserId: "user-target",
    });

    const decision = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      agentPrincipalId: "agent-pa",
      requiredScopes: ["user:read"],
      target: { kind: "user", id: "user-target" },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPermissions.map((item) => item.bindingId)).toEqual(["owner-binding"]);
  });

  it("does not turn a revoked legacy assistant template row into a ceiling", async () => {
    const agent = {
      ...targetPrincipal,
      id: "agent-pa",
      kind: "agent" as const,
      userId: null,
      agentProfile: {
        principalId: "agent-pa",
        tenantId: "tenant-a",
        mode: "delegated" as const,
        ownerUserId: "user-actor",
        definitionRef: "personal_assistant",
        definitionVersion: 1,
      },
    };
    mocks.repository.getPrincipal.mockResolvedValue(agent);
    mocks.repository.listPrincipalRoleBindings.mockResolvedValue([{
      id: "legacy-template",
      roleCode: "personal_assistant",
      scopes: ["user:read"],
      dataScope: "tenant",
      scopeOrgId: null,
      scopeDeptId: null,
      expiresAt: null,
      status: "revoked",
      resolution: "resolved",
      // Compatibility marker for the pre-inheritance auto-provisioning path:
      // it used the personal_assistant role but had no creator user.
      source: "explicit",
      createdByUserId: null,
      grantedByPrincipalId: null,
      canDelegate: false,
      grantorApprovalRef: null,
    }]);
    mocks.repository.getPrincipalEffectivePermissions.mockResolvedValue([]);
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "user:read", bindingId: "owner-binding" })],
    }));
    mocks.repository.resolveAuthorizationTarget.mockResolvedValue({
      kind: "user",
      id: "user-target",
      tenantId: "tenant-a",
      deptId: "dept-a",
      ownerUserId: "user-target",
    });

    const decision = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      agentPrincipalId: "agent-pa",
      requiredScopes: ["user:read"],
      target: { kind: "user", id: "user-target" },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.matchedPermissions[0]?.bindingId).toBe("owner-binding");
  });

  it.each([
    ["revoked", { status: "revoked", expiresAt: null }],
    ["expired", { status: "active", expiresAt: "2020-01-01T00:00:00.000Z" }],
  ] as const)("keeps an explicit %s ceiling from widening after removal", async (_label, state) => {
    const agent = {
      ...targetPrincipal,
      id: "agent-pa",
      kind: "agent" as const,
      userId: null,
      agentProfile: {
        principalId: "agent-pa",
        tenantId: "tenant-a",
        mode: "delegated" as const,
        ownerUserId: "user-actor",
        definitionRef: "personal_assistant",
        definitionVersion: 1,
      },
    };
    mocks.repository.getPrincipal.mockResolvedValue(agent);
    mocks.repository.listPrincipalRoleBindings.mockResolvedValue([{
      id: `${_label}-explicit-ceiling`,
      roleCode: "operator",
      scopes: ["user:read"],
      dataScope: "tenant",
      scopeOrgId: null,
      scopeDeptId: null,
      ...state,
      resolution: "resolved",
      source: "explicit",
      createdByUserId: "admin-user",
      grantedByPrincipalId: "principal-actor",
      canDelegate: false,
      grantorApprovalRef: null,
    }]);
    mocks.repository.getPrincipalEffectivePermissions.mockResolvedValue([]);
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "user:read", bindingId: "owner-binding" })],
    }));
    mocks.repository.resolveAuthorizationTarget.mockResolvedValue({
      kind: "user",
      id: "user-target",
      tenantId: "tenant-a",
      deptId: "dept-a",
      ownerUserId: "user-target",
    });

    const decision = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      agentPrincipalId: "agent-pa",
      requiredScopes: ["user:read"],
      target: { kind: "user", id: "user-target" },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing_scope");
  });

  it("reports expired and revoked bindings as denied in live decisions", async () => {
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      bindings: [
        {
          ...permission({ scope: "user:read", bindingId: "expired-binding", expiresAt: "2020-01-01T00:00:00.000Z" }),
          roleId: "role-operator",
          roleCode: "operator",
          scopes: ["user:read"],
          status: "active",
          resolution: "resolved",
        },
        {
          ...permission({ scope: "user:read", bindingId: "revoked-binding" }),
          roleId: "role-operator",
          roleCode: "operator",
          scopes: ["user:read"],
          status: "revoked",
          resolution: "resolved",
        },
      ],
      effectivePermissions: [],
    }));
    const expired = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      requiredScopes: ["user:read"],
      target: { kind: "user", id: "user-target" },
    });
    expect(expired.reason).toBe("binding_expired");

    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      bindings: [{
        ...permission({ scope: "user:read", bindingId: "revoked-binding" }),
        roleId: "role-operator",
        roleCode: "operator",
        scopes: ["user:read"],
        status: "revoked",
        resolution: "resolved",
      }],
      effectivePermissions: [],
    }));
    const revoked = await authorizePrincipalAction({
      tenantId: "tenant-a",
      userId: "user-actor",
      requiredScopes: ["user:read"],
      target: { kind: "user", id: "user-target" },
    });
    expect(revoked.reason).toBe("missing_scope");
  });
});

describe("principal mutation authorization snapshot", () => {
  it("carries the actor permission expiry into agent create", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "agent:create", expiresAt })],
      authzVersion: 9,
      userPrincipal: { ...actorPrincipal, authzVersion: 9 },
    }));
    const create = vi.fn(async () => ({ ...targetPrincipal, kind: "agent" as const }));
    mocks.repository.createAgentPrincipal = create;

    await createAgentPrincipal({
      tenantId: "tenant-a",
      displayName: "Agent",
      mode: "service",
      actorUserId: "user-actor",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSnapshot: {
        actorPrincipalId: "principal-actor",
        actorAuthzVersion: 9,
        actorPermissionExpiresAt: expiresAt,
        targetPrincipalId: null,
        targetAuthzVersion: null,
        targetStatus: null,
      },
    }));
  });

  it("carries the locked target version and status into agent update", async () => {
    const targetAgent = {
      ...targetPrincipal,
      id: "agent-target",
      kind: "agent" as const,
      userId: null,
      agentProfile: {
        principalId: "agent-target",
        tenantId: "tenant-a",
        mode: "service" as const,
        ownerUserId: null,
        definitionRef: null,
        definitionVersion: 1,
      },
      authzVersion: 12,
    };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "agent:update", expiresAt })],
      authzVersion: 9,
      userPrincipal: { ...actorPrincipal, authzVersion: 9 },
    }));
    mocks.repository.getPrincipal.mockResolvedValue(targetAgent);
    const update = vi.fn(async () => targetAgent);
    mocks.repository.updateAgentPrincipal = update;

    await updateAgentPrincipal({
      tenantId: "tenant-a",
      principalId: "agent-target",
      displayName: "Updated agent",
      actorUserId: "user-actor",
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSnapshot: {
        actorPrincipalId: "principal-actor",
        actorAuthzVersion: 9,
        actorPermissionExpiresAt: expiresAt,
        targetPrincipalId: "agent-target",
        targetAuthzVersion: 12,
        targetStatus: "active",
      },
    }));
  });
});

describe("role mutation freshness contract", () => {
  it("uses a deterministic scope fingerprint and rejects a widened locked role", () => {
    const snapshot = {
      roleId: "role-operator",
      roleScopes: ["user:read", "user:update"],
      roleScopeFingerprint: roleScopeFingerprint(["user:update", "user:read"]),
    } as const;

    expect(roleScopeFingerprint(["user:update", "user:read", "user:read"])).toBe(snapshot.roleScopeFingerprint);
    expect(roleMutationSnapshotMatches(snapshot, "role-operator", ["user:read", "user:update"])).toBe(true);
    expect(roleMutationSnapshotMatches(snapshot, "role-operator", ["user:read", "user:update", "user:delete"])).toBe(false);
    expect(roleMutationSnapshotMatches(snapshot, "role-other", ["user:read", "user:update"])).toBe(false);
  });
});

describe("grantor bounded delegation", () => {
  const upstreamExpiry = new Date(Date.now() + 60 * 60 * 1000);

  beforeEach(() => {
    mocks.repository.getPrincipal.mockImplementation(async (_tenantId: string, principalId: string) => {
      if (principalId === targetPrincipal.id) return targetPrincipal;
      if (principalId === "principal-grantor") return {
        ...actorPrincipal,
        id: "principal-grantor",
        userId: "user-grantor",
      };
      return null;
    });
    mocks.repository.getPrincipalEffectivePermissions.mockResolvedValue([{
      id: "upstream-binding",
      roleCode: "delegator",
      scopes: ["role:assign", "user:read"],
      dataScope: "department",
      scopeOrgId: "org-a",
      scopeDeptId: "dept-a",
      expiresAt: upstreamExpiry.toISOString(),
      status: "active",
      resolution: "resolved",
      grantedByPrincipalId: "principal-owner",
      canDelegate: true,
      grantorApprovalRef: null,
    }]);
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      effectivePermissions: [permission({ scope: "role:assign", dataScope: "tenant", bindingId: "actor-assign" })],
    }));
  });

  it("accepts a grantor-approved redelegation within upstream range and expiry", async () => {
    const verifier = vi.fn().mockResolvedValue(true);
    await expect(assertGrantable({
      tenantId: "tenant-a",
      actorUserId: "user-actor",
      targetPrincipalId: targetPrincipal.id,
      roleCode: "operator",
      dataScope: "department",
      scopeOrgId: "org-a",
      scopeDeptId: "dept-a",
      expiresAt: new Date(upstreamExpiry.getTime() - 1_000).toISOString(),
      grantedByPrincipalId: "principal-grantor",
      canDelegate: true,
      grantorApprovalRef: "resource-owner-approval-1",
      grantorApprovalVerifier: verifier,
    })).resolves.toEqual(expect.objectContaining({
      actorPrincipalId: "principal-actor",
      grantorPrincipalId: "principal-grantor",
      targetPrincipalId: targetPrincipal.id,
    }));
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorUserId: "user-actor",
      grantorPrincipalId: "principal-grantor",
      approvalRef: "resource-owner-approval-1",
      targetPrincipalId: targetPrincipal.id,
      roleId: null,
      roleCode: "operator",
      dataScope: "department",
      scopeOrgId: "org-a",
      scopeDeptId: "dept-a",
      expiresAt: expect.any(String),
      canDelegate: true,
    }));
  });

  it("rejects a redelegation that exceeds the grantor range or validity", async () => {
    await expect(assertGrantable({
      tenantId: "tenant-a",
      actorUserId: "user-actor",
      targetPrincipalId: targetPrincipal.id,
      roleCode: "operator",
      dataScope: "department",
      scopeOrgId: "org-a",
      scopeDeptId: "dept-b",
      expiresAt: new Date(upstreamExpiry.getTime() - 1_000).toISOString(),
      grantedByPrincipalId: "principal-grantor",
      canDelegate: true,
      grantorApprovalRef: "resource-owner-approval-1",
      grantorApprovalVerifier: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("grant_scope_exceeded");

    await expect(assertGrantable({
      tenantId: "tenant-a",
      actorUserId: "user-actor",
      targetPrincipalId: targetPrincipal.id,
      roleCode: "operator",
      dataScope: "department",
      scopeOrgId: "org-a",
      scopeDeptId: "dept-a",
      expiresAt: new Date(upstreamExpiry.getTime() + 1_000).toISOString(),
      grantedByPrincipalId: "principal-grantor",
      canDelegate: true,
      grantorApprovalRef: "resource-owner-approval-1",
      grantorApprovalVerifier: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("grant_scope_exceeded");
  });

  it("rejects an opaque approval reference without a trusted verifier", async () => {
    await expect(assertGrantable({
      tenantId: "tenant-a",
      actorUserId: "user-actor",
      targetPrincipalId: targetPrincipal.id,
      roleCode: "operator",
      dataScope: "tenant",
      grantedByPrincipalId: "principal-grantor",
      grantorApprovalRef: "forged-superadmin-approval",
    })).rejects.toThrow("resource_approval_unverified");
  });

  it("fails closed when the grantor is disabled", async () => {
    mocks.repository.getPrincipal.mockImplementation(async (_tenantId: string, principalId: string) => {
      if (principalId === targetPrincipal.id) return targetPrincipal;
      if (principalId === "principal-grantor") return {
        ...actorPrincipal,
        id: "principal-grantor",
        userId: "user-grantor",
        status: "disabled" as const,
      };
      return null;
    });
    await expect(assertGrantable({
      tenantId: "tenant-a",
      actorUserId: "user-actor",
      targetPrincipalId: targetPrincipal.id,
      roleCode: "operator",
      dataScope: "department",
      scopeDeptId: "dept-a",
      grantedByPrincipalId: "principal-grantor",
      grantorApprovalRef: "resource-owner-approval-1",
      grantorApprovalVerifier: vi.fn().mockResolvedValue(true),
    })).rejects.toThrow("grantor_inactive");
  });

  it("fails closed when the human actor is disabled", async () => {
    mocks.getUserAuthorizationContext.mockResolvedValue(context({
      userPrincipal: { ...actorPrincipal, status: "disabled" as const },
      userStatus: "disabled" as const,
    }));
    await expect(assertGrantable({
      tenantId: "tenant-a",
      actorUserId: "user-actor",
      targetPrincipalId: targetPrincipal.id,
      roleCode: "operator",
      dataScope: "tenant",
    })).rejects.toThrow("actor_inactive");
  });
});
