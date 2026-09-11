import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIamDb: vi.fn(),
  getAdminMysqlDb: vi.fn(),
}));

vi.mock("@agenticx/iam-core", () => ({
  getIamDb: (...args: unknown[]) => mocks.getIamDb(...args),
}));
vi.mock("../db-stores/mysql/database", () => ({
  getAdminMysqlDb: (...args: unknown[]) => mocks.getAdminMysqlDb(...args),
}));

import * as mysqlStore from "../db-stores/mysql/capability-shelf-order-store";
import * as pgStore from "../db-stores/postgresql/capability-shelf-order-store";
import {
  CapabilityShelfMembershipValidationError,
  CapabilityShelfOrderValidationError,
} from "../capability-shelf-order-contract";

const TENANT_ID = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const MCP_ID = "01JQMZ8K3N4P5Q6R7S8T9VWX01";
const SKILL_ID = "01JQMZ8K3N4P5Q6R7S8T9VWX02";

function selectChain(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const terminal = {
    orderBy,
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  const where = vi.fn().mockReturnValue(terminal);
  const from = vi.fn().mockReturnValue({ where });
  return { from, where, orderBy, terminal };
}

function fakeDatabase(
  previousRows: unknown[],
  marketRows: unknown[] = [],
) {
  const dbSelect = vi.fn().mockReturnValue(selectChain(previousRows));
  const txSelect = vi.fn().mockImplementation((fields?: Record<string, unknown>) =>
    selectChain(Object.keys(fields ?? {}).includes("status") ? marketRows : previousRows),
  );
  const lock = vi.fn().mockResolvedValue(undefined);
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteCall = vi.fn().mockReturnValue({ where: deleteWhere });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertCall = vi.fn().mockReturnValue({ values: insertValues });
  const tx = {
    execute: lock,
    select: txSelect,
    delete: deleteCall,
    insert: insertCall,
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
  return {
    db: { select: dbSelect, transaction },
    dbSelect,
    txSelect,
    transaction,
    tx,
    lock,
    deleteCall,
    deleteWhere,
    insertCall,
    insertValues,
  };
}

describe.each([
  ["PostgreSQL", pgStore, mocks.getIamDb],
  ["MySQL", mysqlStore, mocks.getAdminMysqlDb],
] as const)("%s capability shelf order store", (_dialect, store, getDb) => {
  beforeEach(() => {
    mocks.getIamDb.mockReset();
    mocks.getAdminMysqlDb.mockReset();
  });

  it("reads rows by position with capability id as a deterministic tie breaker", async () => {
    const runtime = fakeDatabase([
      { capabilityId: `mcp:${MCP_ID}` },
      { capabilityId: "feature:web_search" },
    ]);
    getDb.mockReturnValue(runtime.db);

    await expect(store.getCapabilityShelfOrder(TENANT_ID)).resolves.toEqual([
      `mcp:${MCP_ID}`,
      "feature:web_search",
    ]);
    expect(runtime.dbSelect).toHaveBeenCalledOnce();
  });

  it("locks the tenant and replaces the full order with canonical dense positions", async () => {
    const runtime = fakeDatabase([{ capabilityId: "feature:web_search" }]);
    getDb.mockReturnValue(runtime.db);

    const result = await store.replaceCapabilityShelfOrder(TENANT_ID, [
      `mcp:${MCP_ID.toLowerCase()}`,
      `mcp:${MCP_ID}`,
      `skill:${SKILL_ID}`,
    ]);

    expect(result).toEqual({
      previousCapabilityIds: ["feature:web_search"],
      orderedCapabilityIds: [`mcp:${MCP_ID}`, `skill:${SKILL_ID}`],
    });
    expect(runtime.transaction).toHaveBeenCalledOnce();
    expect(runtime.lock).toHaveBeenCalledOnce();
    expect(runtime.deleteCall).toHaveBeenCalledOnce();
    expect(runtime.insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ tenantId: TENANT_ID, capabilityId: `mcp:${MCP_ID}`, position: 0 }),
      expect.objectContaining({ tenantId: TENANT_ID, capabilityId: `skill:${SKILL_ID}`, position: 1 }),
    ]);
  });

  it("deletes the tenant order without inserting when the requested list is empty", async () => {
    const runtime = fakeDatabase([{ capabilityId: "feature:web_search" }]);
    getDb.mockReturnValue(runtime.db);

    await expect(store.replaceCapabilityShelfOrder(TENANT_ID, [])).resolves.toEqual({
      previousCapabilityIds: ["feature:web_search"],
      orderedCapabilityIds: [],
    });
    expect(runtime.deleteCall).toHaveBeenCalledOnce();
    expect(runtime.insertCall).not.toHaveBeenCalled();
  });

  it("rejects malformed ids before opening a database transaction", async () => {
    const runtime = fakeDatabase([]);
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.replaceCapabilityShelfOrder(TENANT_ID, ["not-a-capability-id"]),
    ).rejects.toBeInstanceOf(CapabilityShelfOrderValidationError);
    expect(runtime.transaction).not.toHaveBeenCalled();
  });

  it("propagates an insert failure so the transaction can roll back the delete", async () => {
    const runtime = fakeDatabase([]);
    runtime.insertValues.mockRejectedValueOnce(new Error("insert failed"));
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.replaceCapabilityShelfOrder(TENANT_ID, [`mcp:${MCP_ID}`]),
    ).rejects.toThrow("insert failed");
    expect(runtime.deleteCall).toHaveBeenCalledOnce();
    expect(runtime.insertValues).toHaveBeenCalledOnce();
  });

  it("adds a published tenant expert atomically and is idempotent", async () => {
    const expertId = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
    const capabilityId = `expert:${expertId}`;
    const runtime = fakeDatabase(
      [{ capabilityId: "feature:web_search" }],
      [{ id: expertId, kind: "expert", status: "published" }],
    );
    getDb.mockReturnValue(runtime.db);

    await expect(store.addCapabilityToShelf(TENANT_ID, capabilityId)).resolves.toEqual({
      capabilityId,
      previousCapabilityIds: ["feature:web_search"],
      orderedCapabilityIds: ["feature:web_search", capabilityId],
    });
    expect(runtime.lock).toHaveBeenCalledOnce();
    expect(runtime.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        capabilityId,
        position: 1,
      }),
    );
  });

  it("adds a published admins-only market Skill to the shelf for reviewed forced delivery", async () => {
    const capabilityId = `skill:${SKILL_ID}`;
    const runtime = fakeDatabase(
      [{ capabilityId: "feature:web_search" }],
      [{ id: SKILL_ID, kind: "skill", status: "published", visibility: "admins_only" }],
    );
    getDb.mockReturnValue(runtime.db);

    await expect(store.addCapabilityToShelf(TENANT_ID, capabilityId)).resolves.toMatchObject({
      capabilityId,
      orderedCapabilityIds: ["feature:web_search", capabilityId],
    });
    expect(runtime.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityId }),
    );
  });

  it("rejects a new unlisted market Skill but keeps an existing unlisted shelf member sortable", async () => {
    const capabilityId = `skill:${SKILL_ID}`;
    const rejected = fakeDatabase([], [{ id: SKILL_ID, kind: "skill", status: "unlisted" }]);
    getDb.mockReturnValue(rejected.db);
    await expect(store.addCapabilityToShelf(TENANT_ID, capabilityId)).rejects.toBeInstanceOf(
      CapabilityShelfMembershipValidationError,
    );
    expect(rejected.insertValues).not.toHaveBeenCalled();

    const existing = fakeDatabase(
      [{ capabilityId }],
      [{ id: SKILL_ID, kind: "skill", status: "unlisted" }],
    );
    getDb.mockReturnValue(existing.db);
    await expect(store.replaceCapabilityShelfOrder(TENANT_ID, [capabilityId])).resolves.toEqual({
      previousCapabilityIds: [capabilityId],
      orderedCapabilityIds: [capabilityId],
    });
    expect(existing.insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ capabilityId, position: 0 }),
    ]);
  });

  it("rejects revoked market items for new shelf membership but preserves existing entries for cleanup", async () => {
    const expertId = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
    const capabilityId = `expert:${expertId}`;
    const revokedMarketItem = {
      id: expertId,
      kind: "expert",
      status: "published",
      deliveryState: "revoked",
    };

    const rejectedAdd = fakeDatabase([], [revokedMarketItem]);
    getDb.mockReturnValue(rejectedAdd.db);
    await expect(store.addCapabilityToShelf(TENANT_ID, capabilityId)).rejects.toBeInstanceOf(
      CapabilityShelfMembershipValidationError,
    );
    expect(rejectedAdd.insertValues).not.toHaveBeenCalled();

    const rejectedReplace = fakeDatabase([], [revokedMarketItem]);
    getDb.mockReturnValue(rejectedReplace.db);
    await expect(store.replaceCapabilityShelfOrder(TENANT_ID, [capabilityId])).rejects.toBeInstanceOf(
      CapabilityShelfMembershipValidationError,
    );
    expect(rejectedReplace.deleteCall).not.toHaveBeenCalled();

    const existing = fakeDatabase(
      [{ capabilityId }, { capabilityId: "feature:web_search" }],
      [revokedMarketItem],
    );
    getDb.mockReturnValue(existing.db);
    await expect(store.replaceCapabilityShelfOrder(TENANT_ID, ["feature:web_search", capabilityId])).resolves.toEqual({
      previousCapabilityIds: [capabilityId, "feature:web_search"],
      orderedCapabilityIds: ["feature:web_search", capabilityId],
    });
    expect(existing.insertValues).toHaveBeenCalledOnce();

    const removable = fakeDatabase([{ capabilityId }], [revokedMarketItem]);
    getDb.mockReturnValue(removable.db);
    await expect(store.removeCapabilityFromShelf(TENANT_ID, capabilityId)).resolves.toEqual({
      capabilityId,
      previousCapabilityIds: [capabilityId],
      orderedCapabilityIds: [],
    });
    expect(removable.deleteCall).toHaveBeenCalledOnce();
  });

  it("rejects an unlisted or cross-tenant portable item before writing the shelf", async () => {
    const expertId = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
    const runtime = fakeDatabase([], [{ id: expertId, kind: "expert", status: "unlisted" }]);
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.addCapabilityToShelf(TENANT_ID, `expert:${expertId}`),
    ).rejects.toBeInstanceOf(CapabilityShelfMembershipValidationError);
    expect(runtime.insertValues).not.toHaveBeenCalled();
  });

  it("rejects non-portable ids from the explicit membership endpoints", async () => {
    const runtime = fakeDatabase([]);
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.addCapabilityToShelf(TENANT_ID, "feature:web_search"),
    ).rejects.toBeInstanceOf(CapabilityShelfMembershipValidationError);
    await expect(
      store.removeCapabilityFromShelf(TENANT_ID, `mcp:${MCP_ID}`),
    ).rejects.toBeInstanceOf(CapabilityShelfMembershipValidationError);
    expect(runtime.transaction).not.toHaveBeenCalled();
  });

  it("does not let a single-item add exceed the shelf size limit", async () => {
    const expertId = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
    const runtime = fakeDatabase(
      Array.from({ length: 1000 }, (_value, index) => ({
        capabilityId: `feature:test_${index}`,
      })),
      [{ id: expertId, kind: "expert", status: "published" }],
    );
    getDb.mockReturnValue(runtime.db);

    await expect(
      store.addCapabilityToShelf(TENANT_ID, `expert:${expertId}`),
    ).rejects.toBeInstanceOf(CapabilityShelfMembershipValidationError);
    expect(runtime.insertValues).not.toHaveBeenCalled();
  });

  it("removes a shelf member and compacts positions atomically", async () => {
    const expertId = "01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
    const capabilityId = `expert:${expertId}`;
    const runtime = fakeDatabase([
      { capabilityId: "feature:web_search" },
      { capabilityId },
      { capabilityId: `mcp:${MCP_ID}` },
    ]);
    getDb.mockReturnValue(runtime.db);

    await expect(store.removeCapabilityFromShelf(TENANT_ID, capabilityId)).resolves.toEqual({
      capabilityId,
      previousCapabilityIds: ["feature:web_search", capabilityId, `mcp:${MCP_ID}`],
      orderedCapabilityIds: ["feature:web_search", `mcp:${MCP_ID}`],
    });
    expect(runtime.deleteCall).toHaveBeenCalledOnce();
    expect(runtime.insertValues).toHaveBeenCalledWith([
      expect.objectContaining({ capabilityId: "feature:web_search", position: 0 }),
      expect.objectContaining({ capabilityId: `mcp:${MCP_ID}`, position: 1 }),
    ]);
  });
});
