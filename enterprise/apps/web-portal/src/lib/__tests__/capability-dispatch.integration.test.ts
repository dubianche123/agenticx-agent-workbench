import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { and, eq, inArray } from "drizzle-orm";
import {
  ActionRegistry,
  ActionRuntime,
  SqlActionStore,
  issueAssistantSession,
  requestContextFromSession,
  type ActionDefinition,
  type ActionRequestContext,
} from "@agenticx/action-runtime";
import {
  __resetDatabaseForTests,
  createMysqlDb,
  deleteUserGroup,
  getIamDb,
  groupAssignmentKey,
  listUserOptOuts,
  moveDepartment,
  replaceUserOptOutSubjects,
  resetLegacyModelExclusionMigration,
  resolveDatabaseConfig,
  setUserOptOut,
  updateUserGroup,
} from "@agenticx/iam-core";
import {
  actionOperationEvents as pgActionOperationEvents,
  actionOperations as pgActionOperations,
  assistantSessions as pgAssistantSessions,
  enterpriseRuntimeTokenQuotas as pgQuotas,
  organizations as pgOrganizations,
  principals as pgPrincipals,
} from "@agenticx/db-schema";
import {
  actionOperationEvents as myActionOperationEvents,
  actionOperations as myActionOperations,
  assistantSessions as myAssistantSessions,
  enterpriseRuntimeTokenQuotas as myQuotas,
  organizations as myOrganizations,
  principals as myPrincipals,
} from "@agenticx/db-schema/mysql";
import {
  isModelOptOutSubject,
  modelOptOutSubject,
} from "@agenticx/config";
import { capabilityTableDefinitions } from "../capability-tables";
import {
  capabilityAuthorizationRevision,
  isCapabilityAllowedForUserInTransaction,
} from "../capability-packs-reader";

type Dialect = "postgresql" | "mysql";

const mysqlUrl = process.env.ONTOLOGY_TEST_MYSQL_URL?.trim();
const postgresUrl = process.env.ONTOLOGY_TEST_PG_URL?.trim();
const runIntegration = mysqlUrl && postgresUrl ? it : it.skip;

const ACTION_ID = "action:self.profile.read";
const DEPARTMENT_ACTION_ID = "action:self.quota.read";
const OPTOUT_ACTION_ID = "action:usage.summary.read";
const TENANT_B_ONLY_ACTION_ID = "action:usage.analytics.read";

function actionRuntimeTables(dialect: Dialect) {
  return dialect === "mysql"
    ? {
        sessions: myAssistantSessions,
        operations: myActionOperations,
        events: myActionOperationEvents,
      }
    : {
        sessions: pgAssistantSessions,
        operations: pgActionOperations,
        events: pgActionOperationEvents,
      };
}

async function databaseFor(dialect: Dialect, url: string): Promise<any> {
  process.env.DATABASE_URL = url;
  process.env.DATABASE_DIALECT = dialect;
  await __resetDatabaseForTests();
  if (dialect === "mysql") return (await createMysqlDb(resolveDatabaseConfig() as any)).raw;
  return getIamDb();
}

async function createFixture(db: any, dialect: Dialect) {
  const tables = capabilityTableDefinitions(dialect) as any;
  const tenantA = ulid();
  const tenantB = ulid();
  const packGroup = ulid();
  const packDepartment = ulid();
  const packOptOut = ulid();
  const packB = ulid();
  const userA = ulid();
  const userB = ulid();
  const groupA = ulid();
  const agentPrincipal = ulid();
  const legacyModelId = "legacy/provider-model";
  const orgA = ulid();
  const rootDepartment = ulid();
  const childDepartment = ulid();
  const otherDepartment = ulid();
  const now = new Date();
  const organizations = dialect === "mysql" ? myOrganizations : pgOrganizations;
  const principals = dialect === "mysql" ? myPrincipals : pgPrincipals;
  const quotas = dialect === "mysql" ? myQuotas : pgQuotas;

  await db.transaction(async (tx: any) => {
    await tx.insert(tables.tenants).values([
      { id: tenantA, code: `dispatch-${tenantA}`, name: "Dispatch tenant A" },
      { id: tenantB, code: `dispatch-${tenantB}`, name: "Dispatch tenant B" },
    ]);
    await tx.insert(organizations).values({
      id: orgA,
      tenantId: tenantA,
      name: `Dispatch org ${orgA}`,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(tables.departments).values([
      {
        id: rootDepartment,
        tenantId: tenantA,
        orgId: orgA,
        parentId: null,
        name: "Root",
        path: "/Root/",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: childDepartment,
        tenantId: tenantA,
        orgId: orgA,
        parentId: rootDepartment,
        name: "Child",
        path: "/Root/Child/",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherDepartment,
        tenantId: tenantA,
        orgId: orgA,
        parentId: null,
        name: "Other",
        path: "/Other/",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await tx.insert(tables.users).values([
      {
        id: userA,
        tenantId: tenantA,
        deptId: childDepartment,
        email: `dispatch-${userA}@example.com`,
        displayName: "Dispatch user A",
        passwordHash: "fixture",
        mustChangePassword: false,
        status: "active",
        failedLoginCount: 0,
        lockedUntil: null,
        isDeleted: false,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userB,
        tenantId: tenantB,
        deptId: null,
        email: `dispatch-${userB}@example.com`,
        displayName: "Dispatch user B",
        passwordHash: "fixture",
        mustChangePassword: false,
        status: "active",
        failedLoginCount: 0,
        lockedUntil: null,
        isDeleted: false,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await tx.insert(principals).values({
      id: agentPrincipal,
      tenantId: tenantA,
      kind: "agent",
      userId: null,
      displayName: "Dispatch test agent",
      status: "active",
      authzVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(quotas).values({
      tenantId: tenantA,
      config: {
        modelExclusions: { [userA]: [legacyModelId] },
        preservedQuotaField: "must-survive-migration",
      },
      updatedAt: now,
    });
    await tx.insert(tables.groups).values({
      id: groupA,
      tenantId: tenantA,
      name: `Dispatch group ${groupA}`,
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(tables.groupMembers).values({
      groupId: groupA,
      userId: userA,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(tables.packs).values([
      { id: packGroup, tenantId: tenantA, slug: `pack-${packGroup}`, status: "active", metadata: {}, createdAt: now, updatedAt: now },
      { id: packDepartment, tenantId: tenantA, slug: `pack-${packDepartment}`, status: "active", metadata: {}, createdAt: now, updatedAt: now },
      { id: packOptOut, tenantId: tenantA, slug: `pack-${packOptOut}`, status: "active", metadata: {}, createdAt: now, updatedAt: now },
      { id: packB, tenantId: tenantB, slug: `pack-${packB}`, status: "active", metadata: {}, createdAt: now, updatedAt: now },
    ]);
    await tx.insert(tables.assignments).values([
      { tenantId: tenantA, packId: packGroup, assignmentKey: groupAssignmentKey(groupA) },
      { tenantId: tenantA, packId: packDepartment, assignmentKey: `dept:${rootDepartment}` },
      { tenantId: tenantA, packId: packOptOut, assignmentKey: userA },
      { tenantId: tenantB, packId: packB, assignmentKey: userB },
    ]);
    await tx.insert(tables.members).values([
      { packId: packGroup, capabilityId: ACTION_ID },
      { packId: packDepartment, capabilityId: DEPARTMENT_ACTION_ID },
      { packId: packOptOut, capabilityId: OPTOUT_ACTION_ID },
      { packId: packB, capabilityId: TENANT_B_ONLY_ACTION_ID },
    ]);
  });
  return {
    tables,
    tenantA,
    tenantB,
    packGroup,
    packDepartment,
    packOptOut,
    packB,
    userA,
    userB,
    groupA,
    agentPrincipal,
    legacyModelId,
    rootDepartment,
    childDepartment,
    otherDepartment,
    orgA,
  };
}

type DispatchFixture = Awaited<ReturnType<typeof createFixture>>;

type RuntimeDispatchHarness = {
  runtime: ActionRuntime;
  request: ActionRequestContext;
  handlerEntered: Promise<void>;
  releaseHandler: () => void;
  handlerRuns: () => number;
  gateTransaction: () => unknown;
  handlerTransaction: () => unknown;
};

/**
 * Exercise the real ActionRuntime.run -> prepareDispatch -> handler path with
 * a SQL-backed operation store. The handler is intentionally a blocking test
 * fixture; the lock and operation/audit boundaries remain production code.
 */
async function createRuntimeDispatchHarness(
  fixture: DispatchFixture,
  capabilityId: string,
): Promise<RuntimeDispatchHarness> {
  const store = new SqlActionStore();
  const issued = await issueAssistantSession({
    store,
    tenantId: fixture.tenantA,
    userId: fixture.userA,
    agentPrincipalId: fixture.agentPrincipal,
    originatingPatId: null,
    originKind: "portal_cookie",
    studioSessionId: `dispatch-test:${ulid()}`,
    permissionMode: "auto",
    authorizationVersion: "v1",
  });
  const request = requestContextFromSession({
    session: issued.session,
    authorizationVersion: "v1",
    principal: {
      id: fixture.userA,
      tenantId: fixture.tenantA,
      kind: "user",
      userId: fixture.userA,
      displayName: "Dispatch test user",
      status: "active",
      authzVersion: 1,
      agentProfile: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  });

  let releaseHandler!: () => void;
  const handlerReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
  let handlerStarted!: () => void;
  const handlerEntered = new Promise<void>((resolve) => { handlerStarted = resolve; });
  let runCount = 0;
  let gateTransaction: unknown;
  let handlerTransaction: unknown;
  const action: ActionDefinition = {
    id: capabilityId.slice("action:".length),
    capabilityId,
    version: 1,
    label: "Dispatch race fixture",
    description: "Dispatch race fixture",
    effect: "query",
    requiredScopes: [],
    inputSchema: { type: "object", additionalProperties: false },
    policy: { requiresConfirmation: false, autoAllowed: true },
    handler: {
      resolveTargets: async (ctx) => [{ kind: "user", id: ctx.userId }],
      execute: async (context) => {
        handlerTransaction = context.transaction;
        runCount += 1;
        handlerStarted();
        await handlerReleased;
        return { dispatched: true };
      },
    },
  };
  const runtime = new ActionRuntime({
    registry: new ActionRegistry([action]),
    store,
    authorization: {
      authorizationVersion: async () => "v1",
      // Keep the pre-operation check permissive so a revoke that wins after
      // operation creation is decided by prepareDispatch in its transaction.
      authorize: async ({ target }) => ({
        allowed: true,
        reason: "allowed",
        publicReason: "allowed",
        requiredScopes: [],
        deniedScopes: [],
        matchedPermissions: [],
        target,
      }),
      capability: {
        authorize: async () => ({ allowed: true, reason: "allowed", publicReason: "allowed" }),
        prepareDispatch: async ({ transaction }) => {
          gateTransaction = transaction;
          const allowed = await isCapabilityAllowedForUserInTransaction({
            transaction,
            tenantId: fixture.tenantA,
            userId: fixture.userA,
            // Deliberately stale token values; only current rows are trusted.
            email: "stale-token@example.com",
            deptId: "stale-dept",
            capabilityId,
          });
          return {
            allowed,
            reason: allowed ? "allowed" : "capability_not_granted",
            publicReason: allowed ? "allowed" : "enterprise capability is not enabled for this user",
          };
        },
        requiresTransactionalDispatch: true,
      },
    },
  });

  return {
    runtime,
    request,
    handlerEntered,
    releaseHandler,
    handlerRuns: () => runCount,
    gateTransaction: () => gateTransaction,
    handlerTransaction: () => handlerTransaction,
  };
}

describe("FR3 capability dispatch gate real SQL acceptance", () => {
  afterEach(async () => {
    await __resetDatabaseForTests();
  });

  runIntegration("serializes real group and opt-out revokes with a dispatch handler on both dialects", async () => {
    const originalUrl = process.env.DATABASE_URL;
    const originalDialect = process.env.DATABASE_DIALECT;
    try {
      for (const [dialect, url] of [["postgresql", postgresUrl!], ["mysql", mysqlUrl!]] as const) {
        const db = await databaseFor(dialect, url);
        const organizations = dialect === "mysql" ? myOrganizations : pgOrganizations;
        const principals = dialect === "mysql" ? myPrincipals : pgPrincipals;
        const quotas = dialect === "mysql" ? myQuotas : pgQuotas;
        const runtimeTables = actionRuntimeTables(dialect);
        let fixture: Awaited<ReturnType<typeof createFixture>> | null = null;
        try {
          fixture = await createFixture(db, dialect);
          const transaction = async <T>(fn: (tx: any) => Promise<T>) =>
            db.transaction((tx: any) => fn(tx));
          const gate = (tx: any, capabilityId: string, deptId = "stale-dept") =>
            isCapabilityAllowedForUserInTransaction({
              transaction: { dialect, raw: tx },
              tenantId: fixture!.tenantA,
              userId: fixture!.userA,
              // These values intentionally represent an old session token.
              // The transactional gate must resolve the current users row.
              email: "old-token@example.com",
              deptId,
              capabilityId,
            });

          // Legacy model exclusions must migrate while the delivery lock is
          // already held, using this transaction's connection. The inserted
          // opt-out is then visible in the same snapshot instead of being
          // silently skipped by a second connection waiting on the tenant FK.
          // Clear any prior process memo so this exercises the cold path.
          resetLegacyModelExclusionMigration();
          const legacySubject = modelOptOutSubject(fixture.legacyModelId);
          const legacyMigrationResult = await transaction(async (tx) => {
            const revision = await capabilityAuthorizationRevision(
              fixture!.tenantA,
              fixture!.userA,
              "stale-token@example.com",
              "stale-dept",
              { dialect, raw: tx },
            );
            const rows = await tx
              .select({ subject: fixture!.tables.optOuts.subject })
              .from(fixture!.tables.optOuts)
              .where(
                and(
                  eq(fixture!.tables.optOuts.tenantId, fixture!.tenantA),
                  eq(fixture!.tables.optOuts.userId, fixture!.userA),
                  eq(fixture!.tables.optOuts.subject, legacySubject),
                ),
              );
            return { revision, subjects: rows.map((row: { subject: string }) => row.subject) };
          });
          expect(legacyMigrationResult.revision).toContain(`optout:${legacySubject}`);
          expect(legacyMigrationResult.subjects).toEqual([legacySubject]);
          // The revision captured before/inside dispatch must use the same
          // serializer as the ordinary session snapshot. A format mismatch
          // here would make every otherwise unchanged confirmation stale.
          await expect(
            capabilityAuthorizationRevision(
              fixture.tenantA,
              fixture.userA,
              "stale-token@example.com",
              "stale-dept",
            ),
          ).resolves.toBe(legacyMigrationResult.revision);

          const consumedQuotaRows = await db
            .select({ config: quotas.config })
            .from(quotas)
            .where(eq(quotas.tenantId, fixture.tenantA));
          expect(consumedQuotaRows[0]?.config).toMatchObject({
            preservedQuotaField: "must-survive-migration",
          });
          expect((consumedQuotaRows[0]?.config as Record<string, unknown> | undefined)?.modelExclusions).toBeUndefined();

          // A real model replacement can remove the newly migrated row. Once
          // the source field is consumed, a cold replica/read must not revive
          // that user choice from the old JSON.
          await expect(
            replaceUserOptOutSubjects(
              fixture.tenantA,
              fixture.userA,
              [],
              isModelOptOutSubject,
            ),
          ).resolves.toEqual([]);
          resetLegacyModelExclusionMigration();
          await expect(listUserOptOuts(fixture.tenantA, fixture.userA)).resolves.not.toContain(legacySubject);

          // The public replacement mutator must consume a cold legacy source
          // before applying the user's empty selection. Otherwise the later
          // migration/read would reinsert the source exclusion after the
          // replacement has already removed the new row.
          const replaceBeforeColdModel = "provider/replace-before-cold";
          await db
            .update(quotas)
            .set({
              config: {
                modelExclusions: { [fixture.userA]: [replaceBeforeColdModel] },
                preservedQuotaField: "must-survive-replacement-before-cold-read",
              },
              updatedAt: new Date(),
            })
            .where(eq(quotas.tenantId, fixture.tenantA));
          resetLegacyModelExclusionMigration();
          await expect(
            replaceUserOptOutSubjects(
              fixture.tenantA,
              fixture.userA,
              [],
              isModelOptOutSubject,
            ),
          ).resolves.toEqual([]);
          resetLegacyModelExclusionMigration();
          await expect(listUserOptOuts(fixture.tenantA, fixture.userA)).resolves.not.toContain(
            modelOptOutSubject(replaceBeforeColdModel),
          );
          const replaceConsumedQuotaRows = await db
            .select({ config: quotas.config })
            .from(quotas)
            .where(eq(quotas.tenantId, fixture.tenantA));
          expect((replaceConsumedQuotaRows[0]?.config as Record<string, unknown> | undefined)?.modelExclusions)
            .toBeUndefined();

          // The single-subject setter has the same ordering requirement when
          // opening an existing legacy exclusion (disabled=false): migrate it
          // in the mutation transaction, then remove the requested subject.
          const setBeforeColdModel = "provider/set-before-cold";
          await db
            .update(quotas)
            .set({
              config: {
                modelExclusions: { [fixture.userA]: [setBeforeColdModel] },
                preservedQuotaField: "must-survive-set-before-cold-read",
              },
              updatedAt: new Date(),
            })
            .where(eq(quotas.tenantId, fixture.tenantA));
          resetLegacyModelExclusionMigration();
          await expect(
            setUserOptOut(
              fixture.tenantA,
              fixture.userA,
              modelOptOutSubject(setBeforeColdModel),
              false,
            ),
          ).resolves.toBeUndefined();
          resetLegacyModelExclusionMigration();
          await expect(listUserOptOuts(fixture.tenantA, fixture.userA)).resolves.not.toContain(
            modelOptOutSubject(setBeforeColdModel),
          );
          const setConsumedQuotaRows = await db
            .select({ config: quotas.config })
            .from(quotas)
            .where(eq(quotas.tenantId, fixture.tenantA));
          expect((setConsumedQuotaRows[0]?.config as Record<string, unknown> | undefined)?.modelExclusions)
            .toBeUndefined();

          // A failed transfer must roll back both the new rows and the source
          // update. The oversized subject makes the second insert fail after
          // MySQL has attempted the first row; PG must fail the batch likewise.
          const rollbackModelId = "provider/rollback-model";
          const oversizedModelId = "x".repeat(300);
          await db.insert(quotas).values({
            tenantId: fixture.tenantB,
            config: {
              modelExclusions: { [fixture.userB]: [rollbackModelId, oversizedModelId] },
              preservedQuotaField: "must-survive-failed-migration",
            },
            updatedAt: new Date(),
          });
          resetLegacyModelExclusionMigration();
          await expect(
            transaction((tx) => capabilityAuthorizationRevision(
              fixture!.tenantB,
              fixture!.userB,
              undefined,
              null,
              { dialect, raw: tx },
            )),
          ).rejects.toThrow();
          const rollbackQuotaRows = await db
            .select({ config: quotas.config })
            .from(quotas)
            .where(eq(quotas.tenantId, fixture.tenantB));
          const rollbackConfig = rollbackQuotaRows[0]?.config as Record<string, unknown> | undefined;
          expect(rollbackConfig?.preservedQuotaField).toBe("must-survive-failed-migration");
          expect(rollbackConfig?.modelExclusions).toEqual({
            [fixture.userB]: [rollbackModelId, oversizedModelId],
          });
          const keepOnFailedMutationSubject = modelOptOutSubject("provider/keep-on-failed-mutation");
          const keepOnFailedMutationNow = new Date();
          await db.insert(fixture.tables.optOuts).values({
            tenantId: fixture.tenantB,
            userId: fixture.userB,
            subject: keepOnFailedMutationSubject,
            createdAt: keepOnFailedMutationNow,
            updatedAt: keepOnFailedMutationNow,
          });
          // A failed strict migration must abort the requested public
          // replacement before it can delete an existing model opt-out.
          resetLegacyModelExclusionMigration();
          await expect(
            replaceUserOptOutSubjects(
              fixture.tenantB,
              fixture.userB,
              [],
              isModelOptOutSubject,
            ),
          ).rejects.toThrow();
          const rollbackOptOutRows = await db
            .select({ subject: fixture.tables.optOuts.subject })
            .from(fixture.tables.optOuts)
            .where(
              and(
                eq(fixture.tables.optOuts.tenantId, fixture.tenantB),
                eq(fixture.tables.optOuts.userId, fixture.userB),
              ),
            );
          expect(rollbackOptOutRows.map((row: { subject: string }) => row.subject)).not.toContain(
            modelOptOutSubject(rollbackModelId),
          );
          expect(rollbackOptOutRows.map((row: { subject: string }) => row.subject)).toContain(
            keepOnFailedMutationSubject,
          );

          await expect(transaction((tx) => gate(tx, ACTION_ID))).resolves.toBe(true);
          await expect(transaction((tx) => gate(tx, OPTOUT_ACTION_ID))).resolves.toBe(true);
          await expect(transaction((tx) => gate(tx, DEPARTMENT_ACTION_ID))).resolves.toBe(true);
          // A capability granted only in tenant B must never satisfy tenant A.
          await expect(transaction((tx) => gate(tx, TENANT_B_ONLY_ACTION_ID))).resolves.toBe(false);
          await expect(transaction((tx) => isCapabilityAllowedForUserInTransaction({
            transaction: { dialect, raw: tx },
            tenantId: fixture!.tenantB,
            userId: fixture!.userB,
            capabilityId: TENANT_B_ONLY_ACTION_ID,
          }))).resolves.toBe(true);

          // Enter through ActionRuntime.run so this proves the production
          // prepareDispatch -> handler transaction boundary. The fixture
          // handler blocks only to make the revoke ordering observable.
          const groupHarness = await createRuntimeDispatchHarness(fixture, ACTION_ID);
          const groupDispatchPromise = groupHarness.runtime.run({
            request: groupHarness.request,
            actionId: ACTION_ID.slice("action:".length),
            arguments: {},
            idempotencyKey: `group-dispatch:${ulid()}`,
          });
          await groupHarness.handlerEntered;
          expect(groupHarness.gateTransaction()).toBe(groupHarness.handlerTransaction());

          let groupRevokeCommitted = false;
          const groupRevoke = updateUserGroup(fixture.tenantA, fixture.groupA, { memberIds: [] })
            .then(() => { groupRevokeCommitted = true; });
          await new Promise((resolve) => setTimeout(resolve, 80));
          expect(groupRevokeCommitted).toBe(false);
          groupHarness.releaseHandler();
          await expect(groupDispatchPromise).resolves.toMatchObject({ status: "succeeded", result: { dispatched: true } });
          await groupRevoke;
          expect(groupRevokeCommitted).toBe(true);
          expect(groupHarness.handlerRuns()).toBe(1);
          await expect(transaction((tx) => gate(tx, ACTION_ID))).resolves.toBe(false);
          // A revoke that won before runtime entered prepareDispatch must
          // deny the operation without entering the handler.
          await expect(groupHarness.runtime.run({
            request: groupHarness.request,
            actionId: ACTION_ID.slice("action:".length),
            arguments: {},
            idempotencyKey: `group-revoke-wins:${ulid()}`,
          })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN", status: 403 });
          expect(groupHarness.handlerRuns()).toBe(1);
          // Exercise the companion delete path as well; it uses the same
          // tenant-first boundary even after membership has been replaced.
          await expect(deleteUserGroup(fixture.tenantA, fixture.groupA)).resolves.toBe(true);

          // Repeat the same race through the real opt-out mutator and the
          // same ActionRuntime entrypoint.
          const optOutHarness = await createRuntimeDispatchHarness(fixture, OPTOUT_ACTION_ID);
          const optOutDispatchPromise = optOutHarness.runtime.run({
            request: optOutHarness.request,
            actionId: OPTOUT_ACTION_ID.slice("action:".length),
            arguments: {},
            idempotencyKey: `optout-dispatch:${ulid()}`,
          });
          await optOutHarness.handlerEntered;
          expect(optOutHarness.gateTransaction()).toBe(optOutHarness.handlerTransaction());
          let optOutRevokeCommitted = false;
          const optOutRevoke = setUserOptOut(
            fixture.tenantA,
            fixture.userA,
            OPTOUT_ACTION_ID,
            true,
          ).then(() => { optOutRevokeCommitted = true; });
          await new Promise((resolve) => setTimeout(resolve, 80));
          expect(optOutRevokeCommitted).toBe(false);
          optOutHarness.releaseHandler();
          await expect(optOutDispatchPromise).resolves.toMatchObject({ status: "succeeded", result: { dispatched: true } });
          await optOutRevoke;
          expect(optOutRevokeCommitted).toBe(true);
          expect(optOutHarness.handlerRuns()).toBe(1);
          await expect(transaction((tx) => gate(tx, OPTOUT_ACTION_ID))).resolves.toBe(false);

          // A revoke that has already committed must prevent the runtime
          // handler from being entered.
          await expect(optOutHarness.runtime.run({
            request: optOutHarness.request,
            actionId: OPTOUT_ACTION_ID.slice("action:".length),
            arguments: {},
            idempotencyKey: `optout-revoke-wins:${ulid()}`,
          })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN", status: 403 });
          expect(optOutHarness.handlerRuns()).toBe(1);

          // Department assignment is also derived from current rows. Moving
          // the user's current department must invalidate a stale root token.
          await moveDepartment({
            tenantId: fixture.tenantA,
            id: fixture.childDepartment,
            newParentId: fixture.otherDepartment,
          });
          await expect(
            transaction((tx) => gate(tx, DEPARTMENT_ACTION_ID, fixture!.rootDepartment)),
          ).resolves.toBe(false);
        } finally {
          if (fixture) {
            await db.delete(runtimeTables.events).where(
              inArray(runtimeTables.events.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(runtimeTables.operations).where(
              inArray(runtimeTables.operations.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(runtimeTables.sessions).where(
              inArray(runtimeTables.sessions.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(fixture.tables.optOuts).where(
              inArray(fixture.tables.optOuts.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(fixture.tables.packs).where(
              inArray(fixture.tables.packs.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(fixture.tables.groups).where(eq(fixture.tables.groups.id, fixture.groupA));
            await db.delete(fixture.tables.departments).where(
              inArray(fixture.tables.departments.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(organizations).where(eq(organizations.id, fixture.orgA));
            await db.delete(quotas).where(
              inArray(quotas.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(principals).where(
              inArray(principals.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(fixture.tables.users).where(
              inArray(fixture.tables.users.tenantId, [fixture.tenantA, fixture.tenantB]),
            );
            await db.delete(fixture.tables.tenants).where(
              inArray(fixture.tables.tenants.id, [fixture.tenantA, fixture.tenantB]),
            );
          }
        }
      }
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalDialect === undefined) delete process.env.DATABASE_DIALECT;
      else process.env.DATABASE_DIALECT = originalDialect;
      await __resetDatabaseForTests();
    }
  });
});
