import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents, gatewayAuditEvents, users } from "@agenticx/db-schema/mysql";

const getAuditMysqlDbMock = vi.hoisted(() => vi.fn());
const getAuditRetentionCutoffMock = vi.hoisted(() => vi.fn());

vi.mock("./mysql-database", () => ({
  getAuditMysqlDb: (...args: unknown[]) => getAuditMysqlDbMock(...args),
}));

vi.mock("@agenticx/iam-core", () => ({
  getAuditRetentionCutoff: (...args: unknown[]) => getAuditRetentionCutoffMock(...args),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
    asc: (column: unknown) => ({ kind: "asc", column }),
    count: () => ({ kind: "count" }),
    desc: (column: unknown) => ({ kind: "desc", column }),
    eq: (column: unknown, value: unknown) => ({ kind: "eq", column, value }),
    gte: (column: unknown, value: unknown) => ({ kind: "gte", column, value }),
    lte: (column: unknown, value: unknown) => ({ kind: "lte", column, value }),
    or: (...conditions: unknown[]) => ({ kind: "or", conditions }),
  };
});

type GatewayRow = typeof gatewayAuditEvents.$inferSelect;
type IamRow = typeof auditEvents.$inferSelect;

type QueryCapture = {
  source: "gateway" | "iam";
  count: boolean;
  where?: unknown;
  join?: unknown;
  limit?: number;
};

function gatewayRow(overrides: Partial<GatewayRow> = {}): GatewayRow {
  return {
    id: "gw-1",
    tenantId: "tenant-1",
    eventTime: new Date("2026-08-10T00:00:00.000Z"),
    eventType: "chat_call",
    userId: "user-1",
    userEmail: "user-1@example.invalid",
    departmentId: "dept-1",
    sessionId: "session-1",
    traceId: "trace-1",
    clientType: "web-portal",
    clientIp: null,
    provider: "private",
    model: "private/model",
    route: "private-cloud",
    channelId: null,
    channelKeyRef: null,
    apiTokenId: null,
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    latencyMs: 4,
    digest: null,
    policiesHit: null,
    toolsCalled: null,
    mcpServer: null,
    mcpToolName: null,
    mcpInputHash: null,
    mcpOutputHash: null,
    mcpStatus: null,
    srcRegion: null,
    dstRegion: null,
    crossBorder: false,
    residencyRule: null,
    prevChecksum: "GENESIS",
    checksum: "checksum-1",
    checksumVersion: "v1",
    checksumPayload: null,
    signature: null,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  } as GatewayRow;
}

function iamRow(overrides: Partial<IamRow> = {}): IamRow {
  return {
    id: "iam-1",
    tenantId: "tenant-1",
    actorUserId: "user-1",
    eventType: "attachment_routing.public_override",
    targetKind: "chat_session",
    targetId: "session-1",
    detail: {
      surface: "desktop",
      decision: "public",
      recommendedRoute: "private",
      privateRouteAccepted: false,
      requestedModel: "cloud/model",
      privateTarget: "private/model",
      attachmentCount: 1,
      attachmentExtensions: [".docx"],
    },
    createdAt: new Date("2026-08-09T00:00:00.000Z"),
    updatedAt: new Date("2026-08-09T00:00:00.000Z"),
    ...overrides,
  } as IamRow;
}

function createFakeDb(gatewayRows: GatewayRow[], iamRows: Array<{ audit: IamRow; userEmail: string | null; departmentId: string | null }>) {
  const captures: QueryCapture[] = [];
  const select = vi.fn((projection?: Record<string, unknown>) => {
    const isCount = projection?.n != null;
    let source: "gateway" | "iam" | undefined;
    let capture: QueryCapture | undefined;
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = (table: unknown) => {
      source = table === gatewayAuditEvents ? "gateway" : "iam";
      capture = { source, count: isCount };
      captures.push(capture);
      return chain;
    };
    chain.leftJoin = (_table: unknown, join: unknown) => {
      if (capture) capture.join = join;
      return chain;
    };
    chain.where = (where: unknown) => {
      if (capture) capture.where = where;
      return chain;
    };
    chain.orderBy = self;
    chain.limit = (limit: number) => {
      if (capture) capture.limit = limit;
      return chain;
    };
    chain.offset = self;
    chain.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
      const rows = source === "gateway" ? gatewayRows : iamRows;
      const result = isCount ? [{ n: rows.length }] : rows.slice(0, capture?.limit);
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  });
  return { db: { select }, captures };
}

function flattenConditions(condition: unknown): Array<{ column: unknown; value: unknown }> {
  if (!condition || typeof condition !== "object") return [];
  const value = condition as { kind?: string; column?: unknown; value?: unknown; conditions?: unknown[] };
  if (value.kind === "eq") return [{ column: value.column, value: value.value }];
  if (value.kind === "and" || value.kind === "or") return (value.conditions ?? []).flatMap(flattenConditions);
  return [];
}

describe("MysqlAuditStore attachment override query", () => {
  beforeEach(() => {
    getAuditMysqlDbMock.mockReset();
    getAuditRetentionCutoffMock.mockReset().mockResolvedValue(null);
  });

  it("merges IAM Desktop override records with gateway rows without adding them to the hash chain", async () => {
    const oldGateway = gatewayRow({
      id: "gw-old",
      eventTime: new Date("2026-08-08T00:00:00.000Z"),
      createdAt: new Date("2026-08-08T00:00:00.000Z"),
      updatedAt: new Date("2026-08-08T00:00:00.000Z"),
      checksum: "checksum-old",
    });
    const newestGateway = gatewayRow({
      id: "gw-new",
      eventTime: new Date("2026-08-10T00:00:00.000Z"),
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      updatedAt: new Date("2026-08-10T00:00:00.000Z"),
      prevChecksum: "checksum-old",
      checksum: "checksum-new",
    });
    const iam = iamRow();
    const configIam = iamRow({
      id: "iam-routing-config-1",
      actorUserId: "admin-1",
      eventType: "attachment_routing.update",
      targetKind: "attachment_routing_config",
      targetId: "tenant-1",
      detail: {
        before: { allowPublicOverride: false },
        after: { allowPublicOverride: true },
      },
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
      updatedAt: new Date("2026-08-09T12:00:00.000Z"),
    });
    const fake = createFakeDb([newestGateway, oldGateway], [
      { audit: iam, userEmail: "user-1@example.invalid", departmentId: "dept-1" },
      { audit: configIam, userEmail: "admin-1@example.invalid", departmentId: "dept-1" },
    ]);
    getAuditMysqlDbMock.mockReturnValue(fake.db);

    const { MysqlAuditStore } = await import("./mysql-store");
    const result = await new MysqlAuditStore().query(
      { tenantId: "tenant-1", userId: "admin-1", scopes: ["audit:read:all"] },
      { tenant_id: "tenant-1", limit: 10, offset: 0 },
    );

    expect(result.total).toBe(4);
    expect(result.items.map((item) => item.id)).toEqual([
      "gw-new",
      "iam-routing-config-1",
      "iam-1",
      "gw-old",
    ]);
    expect(result.items[1]).toMatchObject({
      event_type: "attachment_routing.update",
      client_type: "admin-console",
      user_id: "admin-1",
      session_id: undefined,
      audit_source: "iam",
      detail: {
        before: { allowPublicOverride: false },
        after: { allowPublicOverride: true },
      },
      prev_checksum: "",
      checksum: "",
    });
    expect(result.items[2]).toMatchObject({
      event_type: "attachment_routing.public_override",
      client_type: "desktop",
      model: "cloud/model",
      session_id: "session-1",
      audit_source: "iam",
      prev_checksum: "",
      checksum: "",
      detail: expect.objectContaining({ privateRouteAccepted: false }),
    });
    expect(result.chain_valid).toBe(true);
    expect(result.chain_verification).toBe("partial");
    expect(result.chain_verified_count).toBe(0);
    expect(result.chain_legacy_unverified).toBe(2);
  });

  it("keeps IAM rows tenant- and scope-bound and joins user department safely", async () => {
    const fake = createFakeDb([], []);
    getAuditMysqlDbMock.mockReturnValue(fake.db);

    const { MysqlAuditStore } = await import("./mysql-store");
    await new MysqlAuditStore().query(
      { tenantId: "tenant-1", userId: "user-1", deptId: "dept-1", scopes: ["audit:read:dept"] },
      { tenant_id: "tenant-1", department_id: "dept-1" },
    );

    const iamQueries = fake.captures.filter((capture) => capture.source === "iam");
    expect(iamQueries).toHaveLength(2);
    expect(iamQueries.every((capture) => capture.join != null)).toBe(true);
    const iamConditionValues = flattenConditions(iamQueries[0]?.where);
    expect(iamConditionValues.map((entry) => entry.value)).toEqual(
      expect.arrayContaining([
        "tenant-1",
        "dept-1",
        "attachment_routing.public_override",
        "chat_session",
        "attachment_routing.update",
        "attachment_routing_config",
      ]),
    );
    expect(iamConditionValues.some((entry) => entry.column === users.deptId && entry.value === "dept-1")).toBe(true);
    expect(iamQueries[0]?.join).toMatchObject({ kind: "and" });
    const joinValues = flattenConditions(iamQueries[0]?.join);
    expect(joinValues).toEqual(
      expect.arrayContaining([
        { column: users.id, value: auditEvents.actorUserId },
        { column: users.tenantId, value: auditEvents.tenantId },
      ]),
    );
  });

  it("does not claim IAM records match gateway-only filters", async () => {
    const fake = createFakeDb([gatewayRow()], [
      { audit: iamRow(), userEmail: "user-1@example.invalid", departmentId: "dept-1" },
    ]);
    getAuditMysqlDbMock.mockReturnValue(fake.db);

    const { MysqlAuditStore } = await import("./mysql-store");
    const result = await new MysqlAuditStore().query(
      { tenantId: "tenant-1", userId: "admin-1", scopes: ["audit:read:all"] },
      { tenant_id: "tenant-1", trace_id: "trace-1" },
    );

    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual(["gw-1"]);
    expect(fake.captures.filter((capture) => capture.source === "iam")).toHaveLength(0);
  });

  it("keeps tenant-level routing updates out of session-scoped queries", async () => {
    const fake = createFakeDb([], []);
    getAuditMysqlDbMock.mockReturnValue(fake.db);

    const { MysqlAuditStore } = await import("./mysql-store");
    await new MysqlAuditStore().query(
      { tenantId: "tenant-1", userId: "admin-1", scopes: ["audit:read:all"] },
      { tenant_id: "tenant-1", session_id: "session-1" },
    );

    const iamQuery = fake.captures.find((capture) => capture.source === "iam" && !capture.count);
    const iamConditionValues = flattenConditions(iamQuery?.where);
    expect(iamConditionValues).toEqual(
      expect.arrayContaining([
        { column: auditEvents.targetKind, value: "chat_session" },
        { column: auditEvents.targetId, value: "session-1" },
      ]),
    );
  });

  it("applies offset after merging both MySQL sources", async () => {
    const fake = createFakeDb(
      [
        gatewayRow({ id: "gw-new", eventTime: new Date("2026-08-10T00:00:00.000Z") }),
        gatewayRow({ id: "gw-old", eventTime: new Date("2026-08-08T00:00:00.000Z") }),
      ],
      [
        {
          audit: iamRow({ id: "iam-middle", createdAt: new Date("2026-08-09T00:00:00.000Z") }),
          userEmail: "user-1@example.invalid",
          departmentId: "dept-1",
        },
      ],
    );
    getAuditMysqlDbMock.mockReturnValue(fake.db);

    const { MysqlAuditStore } = await import("./mysql-store");
    const result = await new MysqlAuditStore().query(
      { tenantId: "tenant-1", userId: "admin-1", scopes: ["audit:read:all"] },
      { tenant_id: "tenant-1", limit: 1, offset: 1 },
    );

    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.id)).toEqual(["iam-middle"]);
    expect(fake.captures.filter((capture) => !capture.count).map((capture) => capture.limit)).toEqual([2, 2]);
  });
});
