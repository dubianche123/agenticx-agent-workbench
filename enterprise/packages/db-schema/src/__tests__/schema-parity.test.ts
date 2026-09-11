import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { getTableConfig as getMysqlTableConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as mysqlSchema from "../mysql-schema";
import * as postgresSchema from "../schema";

type LogicalColumn = {
  name: string;
  notNull: boolean;
  type: string;
};

type LogicalTable = {
  name: string;
  columns: Map<string, LogicalColumn>;
};

const MYSQL_HELPER_COLUMNS = new Set(["active_email_key", "active_scope_key"]);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function logicalType(column: { dataType: string; columnType: string }): string {
  // Normalize dialect physical differences into logical types.
  if (column.dataType === "date") return "datetime";
  if (column.dataType === "boolean") return "boolean";
  if (column.dataType === "json") return "json";
  if (column.dataType === "array") return "json"; // PG text[] ↔ MySQL json
  return column.dataType;
}

function collectTables(schema: Record<string, unknown>): Map<string, LogicalTable> {
  const tables = new Map<string, LogicalTable>();
  for (const value of Object.values(schema)) {
    if (!is(value, Table)) continue;
    const name = getTableName(value);
    const columns = new Map(
      Object.values(getTableColumns(value)).map((column) => [
        column.name,
        {
          name: column.name,
          notNull: column.notNull,
          type: logicalType(column),
        },
      ]),
    );
    tables.set(name, { name, columns });
  }
  return tables;
}

describe("postgresql/mysql schema parity", () => {
  const pgTables = collectTables(postgresSchema);
  const mysqlTables = collectTables(mysqlSchema);

  it("mirrors all 72 PostgreSQL tables in MySQL", () => {
    expect(pgTables.size).toBe(72);
    expect([...mysqlTables.keys()].sort()).toEqual([...pgTables.keys()].sort());
  });

  it("keeps logical columns, nullability, and data types aligned", () => {
    const failures: string[] = [];
    for (const [tableName, pgTable] of pgTables) {
      const mysqlTable = mysqlTables.get(tableName);
      if (!mysqlTable) {
        failures.push(`${tableName}: missing MySQL table`);
        continue;
      }

      const mysqlColumns = new Map(
        [...mysqlTable.columns].filter(([name]) => !MYSQL_HELPER_COLUMNS.has(name)),
      );
      if ([...pgTable.columns.keys()].sort().join(",") !== [...mysqlColumns.keys()].sort().join(",")) {
        failures.push(`${tableName}: column names differ`);
        continue;
      }

      for (const [columnName, pgColumn] of pgTable.columns) {
        const mysqlColumn = mysqlColumns.get(columnName);
        if (!mysqlColumn) continue;
        if (pgColumn.notNull !== mysqlColumn.notNull) {
          failures.push(`${tableName}.${columnName}: nullability differs`);
        }
        if (pgColumn.type !== mysqlColumn.type) {
          failures.push(
            `${tableName}.${columnName}: logical type differs (${pgColumn.type} vs ${mysqlColumn.type})`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("keeps principal authorization FKs and lookup indexes aligned", () => {
    const principalTables = [
      [postgresSchema.roles, mysqlSchema.roles],
      [postgresSchema.organizations, mysqlSchema.organizations],
      [postgresSchema.departments, mysqlSchema.departments],
      [postgresSchema.principals, mysqlSchema.principals],
      [postgresSchema.agentProfiles, mysqlSchema.agentProfiles],
      [postgresSchema.principalRoleBindings, mysqlSchema.principalRoleBindings],
      [postgresSchema.userRoles, mysqlSchema.userRoles],
    ] as const;

    for (const [pgTable, mysqlTable] of principalTables) {
      const pgConfig = getPgTableConfig(pgTable);
      const mysqlConfig = getMysqlTableConfig(mysqlTable);
      const indexNames = (config: { indexes: Array<{ config?: { name?: string } }> }) =>
        config.indexes.map((index) => index.config?.name).filter((name): name is string => Boolean(name)).sort();

      expect(indexNames(pgConfig)).toEqual(indexNames(mysqlConfig));

      const foreignKeyShape = (config: {
        foreignKeys: Array<{ onDelete?: string; reference: () => { columns: Array<{ name: string }> } }>;
      }) => config.foreignKeys
        .map((foreignKey) => ({
          columns: foreignKey.reference().columns.map((column) => column.name),
          onDelete: foreignKey.onDelete,
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

      expect(foreignKeyShape(pgConfig)).toEqual(foreignKeyShape(mysqlConfig));
    }

    const bindingForeignKeys = getPgTableConfig(postgresSchema.principalRoleBindings).foreignKeys.map((foreignKey) =>
      foreignKey.reference().columns.map((column) => column.name).join(","),
    );
    expect(bindingForeignKeys).toEqual(expect.arrayContaining([
      "role_id,tenant_id",
      "scope_org_id,tenant_id",
      "scope_dept_id,tenant_id",
      "granted_by_principal_id,tenant_id",
    ]));
  });

  it("keeps assistant action identity links tenant-scoped in both dialects", () => {
    const actionTables = [
      [postgresSchema.assistantSessions, mysqlSchema.assistantSessions],
      [postgresSchema.actionOperations, mysqlSchema.actionOperations],
      [postgresSchema.actionOperationEvents, mysqlSchema.actionOperationEvents],
    ] as const;

    const foreignKeyShape = (config: {
      foreignKeys: Array<{
        onDelete?: string;
        reference: () => {
          columns: Array<{ name: string }>;
          foreignColumns: Array<{ name: string }>;
        };
      }>;
    }) => config.foreignKeys
      .map((foreignKey) => {
        const reference = foreignKey.reference();
        return {
          columns: reference.columns.map((column) => column.name),
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: foreignKey.onDelete,
        };
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

    for (const [pgTable, mysqlTable] of actionTables) {
      const pgConfig = getPgTableConfig(pgTable);
      const mysqlConfig = getMysqlTableConfig(mysqlTable);
      expect(foreignKeyShape(pgConfig)).toEqual(foreignKeyShape(mysqlConfig));
    }

    const indexNames = (config: { indexes: Array<{ config?: { name?: string } }> }) =>
      config.indexes.map((index) => index.config?.name).filter((name): name is string => Boolean(name));
    expect(indexNames(getPgTableConfig(postgresSchema.apiTokens))).toContain("api_tokens_id_tenant_uq");
    expect(indexNames(getMysqlTableConfig(mysqlSchema.apiTokens))).toContain("api_tokens_id_tenant_uq");
    expect(indexNames(getPgTableConfig(postgresSchema.assistantSessions))).toContain("assistant_sessions_id_tenant_uq");
    expect(indexNames(getMysqlTableConfig(mysqlSchema.assistantSessions))).toContain("assistant_sessions_id_tenant_uq");
    expect(indexNames(getPgTableConfig(postgresSchema.actionOperations))).toContain("action_operations_id_tenant_uq");
    expect(indexNames(getMysqlTableConfig(mysqlSchema.actionOperations))).toContain("action_operations_id_tenant_uq");

    const sessionColumns = [
      getTableColumns(postgresSchema.assistantSessions),
      getTableColumns(mysqlSchema.assistantSessions),
    ];
    for (const columns of sessionColumns) {
      // Desktop sessions retain the tenant-scoped PAT FK. Cookie-owned web
      // sessions use origin_kind and intentionally leave this provenance NULL.
      expect(columns.originatingPatId.notNull).toBe(false);
      expect(columns.originKind.notNull).toBe(true);
      expect(columns.originKind.default).toBe("desktop_pat");
    }
  });

  it("requires an explicit enterprise market audience in both dialects", () => {
    const pgColumns = getTableColumns(postgresSchema.enterpriseConfigMarketItems);
    const mysqlColumns = getTableColumns(mysqlSchema.enterpriseConfigMarketItems);

    for (const columns of [pgColumns, mysqlColumns]) {
      expect(columns.visibility.notNull).toBe(true);
      expect(columns.visibility.default).toBeUndefined();
      expect(columns.visibleDepartmentIds.notNull).toBe(true);
      expect(columns.visibleDepartmentIds.default).toBeUndefined();
      expect(columns.visibleUserIds.notNull).toBe(true);
      expect(columns.visibleUserIds.default).toBeUndefined();
      expect(columns.deliveryState.notNull).toBe(true);
      expect(columns.deliveryState.default).toBe("active");
    }
  });

  it("keeps the capability shelf order contract tenant-scoped and non-null", () => {
    const pgColumns = getTableColumns(postgresSchema.enterpriseCapabilityShelfOrder);
    const mysqlColumns = getTableColumns(mysqlSchema.enterpriseCapabilityShelfOrder);

    for (const columns of [pgColumns, mysqlColumns]) {
      expect(columns.tenantId.notNull).toBe(true);
      expect(columns.capabilityId.notNull).toBe(true);
      expect(columns.position.notNull).toBe(true);
      expect(columns.position.default).toBeUndefined();
      expect(columns.createdAt.notNull).toBe(true);
      expect(columns.updatedAt.notNull).toBe(true);
    }
  });

  it("cascades message deletion while retaining restrictive session FKs", () => {
    const configs = [
      getPgTableConfig(postgresSchema.chatMessageFeedback),
      getMysqlTableConfig(mysqlSchema.chatMessageFeedback),
    ];

    for (const config of configs) {
      const actionFor = (columns: string[]) =>
        config.foreignKeys.find(
          (foreignKey) =>
            foreignKey
              .reference()
              .columns.map((column) => column.name)
              .join(",") === columns.join(","),
        )?.onDelete;

      expect(actionFor(["tenant_id"])).toBe("cascade");
      expect(actionFor(["user_id"])).toBe("restrict");
      expect(actionFor(["session_id"])).toBe("restrict");
      expect(actionFor(["message_id"])).toBe("cascade");
      expect(actionFor(["session_id", "tenant_id", "user_id"])).toBe("restrict");
    }
  });
});

describe("chat message feedback migration deletion contract", () => {
  const migrations = [
    join(packageRoot, "drizzle/0065_chat_message_feedback.sql"),
    join(packageRoot, "drizzle-mysql/0039_chat_message_feedback.sql"),
  ];

  function hasForeignKeyAction(sql: string, column: string, table: string, action: string): boolean {
    const quote = "[`\\\"]";
    return new RegExp(
      `(?:FOREIGN KEY\\s*\\(\\s*)?${quote}${column}${quote}[\\s\\S]{0,120}?REFERENCES\\s+${quote}${table}${quote}\\s*\\(\\s*${quote}id${quote}\\s*\\)\\s+ON DELETE\\s+${action}`,
      "i",
    ).test(sql);
  }

  it("uses CASCADE for message FKs and RESTRICT for session FKs in both dialects", () => {
    for (const migration of migrations) {
      const sql = readFileSync(migration, "utf8");
      expect(hasForeignKeyAction(sql, "message_id", "chat_messages", "CASCADE")).toBe(true);
      expect(hasForeignKeyAction(sql, "message_id", "chat_messages", "RESTRICT")).toBe(false);
      expect(hasForeignKeyAction(sql, "session_id", "chat_sessions", "RESTRICT")).toBe(true);
    }
  });
});

describe("tenant-scoped legacy role binding contract", () => {
  const migrations = [
    join(packageRoot, "drizzle/0070_principals_role_bindings.sql"),
    join(packageRoot, "drizzle-mysql/0044_principals_role_bindings.sql"),
  ];

  it("replaces single-column legacy role and range FKs in both dialects", () => {
    for (const migration of migrations) {
      const sql = readFileSync(migration, "utf8");
      expect(sql).toContain("user_roles_role_tenant_fk");
      expect(sql).toContain("user_roles_user_tenant_fk");
      expect(sql).toContain("user_roles_scope_org_tenant_fk");
      expect(sql).toContain("user_roles_scope_dept_tenant_fk");
      expect(sql).toMatch(/FOREIGN KEY\s*\([^)]*role_id[^)]*tenant_id[^)]*\)/i);
      expect(sql).toMatch(/FOREIGN KEY\s*\([^)]*scope_org_id[^)]*tenant_id[^)]*\)/i);
      expect(sql).toMatch(/FOREIGN KEY\s*\([^)]*scope_dept_id[^)]*tenant_id[^)]*\)/i);
    }
    expect(readFileSync(migrations[0]!, "utf8")).toContain('DELETE FROM "user_roles" ur');
    expect(readFileSync(migrations[1]!, "utf8")).toContain("DELETE ur");
  });
});

describe("assistant session provenance migration contract", () => {
  const migrations = [
    join(packageRoot, "drizzle/0072_assistant_session_provenance.sql"),
    join(packageRoot, "drizzle-mysql/0046_assistant_session_provenance.sql"),
  ];

  it("allows NULL PAT provenance and constrains each origin kind", () => {
    for (const migration of migrations) {
      const sql = readFileSync(migration, "utf8");
      expect(sql).toMatch(/origin_kind/i);
      expect(sql).toMatch(/originating_pat_id[^\n]*(DROP NOT NULL|bigint NULL)/i);
      expect(sql).toMatch(/assistant_sessions_origin_check/i);
      expect(sql).toMatch(/desktop_pat/i);
      expect(sql).toMatch(/admin_cookie/i);
      expect(sql).toMatch(/portal_cookie/i);
      expect(sql).toMatch(/originating_pat_id[^\n]*IS NULL/i);
    }
  });
});

describe("mysql baseline migration inventory", () => {
  const migrationDir = join(packageRoot, "drizzle-mysql");
  const baselinePath = join(migrationDir, "0000_mysql_baseline.sql");

  it("contains the baseline plus incremental migrations", () => {
    const sqlFiles = readdirSync(migrationDir).filter((name) => name.endsWith(".sql"));
    expect(sqlFiles.sort()).toEqual([
      "0000_mysql_baseline.sql",
      "0001_audit_checksum_payload.sql",
      "0002_desktop_device_auth.sql",
      "0003_enterprise_runtime_web_search.sql",
      "0004_web_search_max_results_default.sql",
      "0005_enterprise_runtime_deep_research.sql",
      "0006_deep_research_enabled_default_true.sql",
      "0007_enterprise_chat_artifacts.sql",
      "0008_chat_sessions_pinned_at.sql",
      "0009_user_password_change_required.sql",
      "0010_chat_history_operations.sql",
      "0011_enterprise_chat_attachments.sql",
      "0012_chat_share_snapshots.sql",
      "0013_enterprise_deep_research_runs.sql",
      "0014_chat_artifacts_content_mediumtext.sql",
      "0015_chat_messages_content_mediumtext.sql",
      "0016_web_search_provider_pool.sql",
      "0017_web_search_call_budget.sql",
      "0018_deep_research_provider_budget.sql",
      "0019_deep_research_run_coordination.sql",
      "0020_web_search_daily_provider_quota.sql",
      "0021_calculator_enabled.sql",
      "0022_gateway_audit_trace_id.sql",
      "0023_portal_request_logs.sql",
      "0024_deep_research_runs_trace_id.sql",
      "0025_portal_request_logs_mode.sql",
      "0026_portal_request_logs_session_idx.sql",
      "0027_enterprise_capability_packs.sql",
      "0028_enterprise_user_groups.sql",
      "0029_enterprise_feature_assignments.sql",
      "0030_enterprise_user_opt_outs.sql",
      "0031_enterprise_skill_scan_result.sql",
      "0032_drop_feature_assignments.sql",
      "0033_enterprise_runtime_attachment_routing.sql",
      "0034_enterprise_config_share_snapshots.sql",
      "0035_enterprise_config_market_items.sql",
      "0036_enterprise_config_market_releases.sql",
      "0037_mcp_server_version.sql",
      "0038_enterprise_capability_shelf_order.sql",
      "0039_chat_message_feedback.sql",
      "0040_capability_sync_receipts.sql",
      "0041_chat_message_feedback_source.sql",
      "0042_config_market_delivery_state.sql",
      "0043_config_market_download_receipts.sql",
      "0044_principals_role_bindings.sql",
      "0045_assistant_actions.sql",
      "0046_assistant_session_provenance.sql",
    ]);

    const sql = readFileSync(baselinePath, "utf8");
    expect(sql.match(/CREATE TABLE `/g)).toHaveLength(42);
    expect(sql).toContain("CREATE OR REPLACE VIEW `usage_records_daily_mv`");
    expect(sql).not.toMatch(/MATERIALIZED\s+VIEW/i);
  });

  it("tracks MySQL migrations and excludes PostgreSQL orphan migrations", () => {
    const journal = JSON.parse(
      readFileSync(join(migrationDir, "meta/_journal.json"), "utf8"),
    ) as {
      dialect: string;
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.dialect).toBe("mysql");
    expect(journal.entries).toEqual([
      expect.objectContaining({ idx: 0, tag: "0000_mysql_baseline" }),
      expect.objectContaining({ idx: 1, tag: "0001_audit_checksum_payload" }),
      expect.objectContaining({ idx: 2, tag: "0002_desktop_device_auth" }),
      expect.objectContaining({ idx: 3, tag: "0003_enterprise_runtime_web_search" }),
      expect.objectContaining({ idx: 4, tag: "0004_web_search_max_results_default" }),
      expect.objectContaining({ idx: 5, tag: "0005_enterprise_runtime_deep_research" }),
      expect.objectContaining({ idx: 6, tag: "0006_deep_research_enabled_default_true" }),
      expect.objectContaining({ idx: 7, tag: "0007_enterprise_chat_artifacts" }),
      expect.objectContaining({ idx: 8, tag: "0008_chat_sessions_pinned_at" }),
      expect.objectContaining({ idx: 9, tag: "0009_user_password_change_required" }),
      expect.objectContaining({ idx: 10, tag: "0010_chat_history_operations" }),
      expect.objectContaining({ idx: 11, tag: "0011_enterprise_chat_attachments" }),
      expect.objectContaining({ idx: 12, tag: "0012_chat_share_snapshots" }),
      expect.objectContaining({ idx: 13, tag: "0013_enterprise_deep_research_runs" }),
      expect.objectContaining({ idx: 14, tag: "0014_chat_artifacts_content_mediumtext" }),
      expect.objectContaining({ idx: 15, tag: "0015_chat_messages_content_mediumtext" }),
      expect.objectContaining({ idx: 16, tag: "0016_web_search_provider_pool" }),
      expect.objectContaining({ idx: 17, tag: "0017_web_search_call_budget" }),
      expect.objectContaining({ idx: 18, tag: "0018_deep_research_provider_budget" }),
      expect.objectContaining({ idx: 19, tag: "0019_deep_research_run_coordination" }),
      expect.objectContaining({ idx: 20, tag: "0020_web_search_daily_provider_quota" }),
      expect.objectContaining({ idx: 21, tag: "0021_calculator_enabled" }),
      expect.objectContaining({ idx: 22, tag: "0022_gateway_audit_trace_id" }),
      expect.objectContaining({ idx: 23, tag: "0023_portal_request_logs" }),
      expect.objectContaining({ idx: 24, tag: "0024_deep_research_runs_trace_id" }),
      expect.objectContaining({ idx: 25, tag: "0025_portal_request_logs_mode" }),
      expect.objectContaining({ idx: 26, tag: "0026_portal_request_logs_session_idx" }),
      expect.objectContaining({ idx: 27, tag: "0027_enterprise_capability_packs" }),
      expect.objectContaining({ idx: 28, tag: "0028_enterprise_user_groups" }),
      expect.objectContaining({ idx: 29, tag: "0029_enterprise_feature_assignments" }),
      expect.objectContaining({ idx: 30, tag: "0030_enterprise_user_opt_outs" }),
      expect.objectContaining({ idx: 31, tag: "0031_enterprise_skill_scan_result" }),
      expect.objectContaining({ idx: 32, tag: "0032_drop_feature_assignments" }),
      expect.objectContaining({ idx: 33, tag: "0033_enterprise_runtime_attachment_routing" }),
      expect.objectContaining({ idx: 34, tag: "0034_enterprise_config_share_snapshots" }),
      expect.objectContaining({ idx: 35, tag: "0035_enterprise_config_market_items" }),
      expect.objectContaining({ idx: 36, tag: "0036_enterprise_config_market_releases" }),
      expect.objectContaining({ idx: 37, tag: "0037_mcp_server_version" }),
      expect.objectContaining({ idx: 38, tag: "0038_enterprise_capability_shelf_order" }),
      expect.objectContaining({ idx: 39, tag: "0039_chat_message_feedback" }),
      expect.objectContaining({ idx: 40, tag: "0040_capability_sync_receipts" }),
      expect.objectContaining({ idx: 41, tag: "0041_chat_message_feedback_source" }),
      expect.objectContaining({ idx: 42, tag: "0042_config_market_delivery_state" }),
      expect.objectContaining({ idx: 43, tag: "0043_config_market_download_receipts" }),
      expect.objectContaining({ idx: 44, tag: "0044_principals_role_bindings" }),
      expect.objectContaining({ idx: 45, tag: "0045_assistant_actions" }),
      expect.objectContaining({ idx: 46, tag: "0046_assistant_session_provenance" }),
    ]);
    expect(readdirSync(migrationDir)).not.toContain("0016_mcp_hosting.sql");
    expect(readdirSync(migrationDir)).not.toContain(
      "0025_enterprise_runtime_mcp_servers.sql",
    );
  });

  it("separates every statement with --> statement-breakpoint", () => {
    // drizzle 只按 `--> statement-breakpoint` 切分迁移文件，没有标记就把整个文件
    // 当一条查询发出去。mysql2 默认 multipleStatements:false，于是多语句的手写迁移
    // 在 MySQL 上整个执行不了——而 PG 的 simple query 允许多语句，所以只有 MySQL 炸。
    const failures: string[] = [];
    for (const name of readdirSync(migrationDir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(migrationDir, name), "utf8");
      const breakpoints = sql.split("--> statement-breakpoint").length - 1;
      const statements = countTopLevelStatements(sql);
      if (statements > 1 && breakpoints !== statements - 1) {
        failures.push(`${name}: ${statements} statements but ${breakpoints} breakpoints`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("never overrides the database collation except for binary SemVer identity", () => {
    // 写 `DEFAULT CHARSET=utf8mb4` 不是「更明确」，是覆盖掉库默认：MySQL 会取该
    // charset 的服务器级默认 collation（MySQL 8 是 utf8mb4_0900_ai_ci），而不是建
    // 库时定的那个。库若按 utf8mb4_unicode_ci 建（MySQL 5.7 迁上来的很常见），新表
    // 的 tenant_id 就和 tenants.id 对不上，外键直接 errno 3780，整条迁移链断在这。
    //
    // 什么都不写反而永远正确——表继承库的 collation，跟 tenants.id 天然一致。
    const offenders = readdirSync(migrationDir)
      .filter((name) => name.endsWith(".sql"))
      // 剥注释再判：解释「为什么不写 CHARSET」的注释本身含这个词，不该被当成违规。
      .filter((name) => {
        const sql = stripSqlComments(readFileSync(join(migrationDir, name), "utf8"))
          // SemVer identifiers are ASCII and case-sensitive. This column-level override is
          // deliberate; tenant/FK columns still inherit the database collation.
          .replace(
            /`version`\s+varchar\(64\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin/gi,
            "`version` varchar(64)",
          );
        return /\b(CHARSET|COLLATE|CHARACTER\s+SET)\b/i.test(sql);
      });

    expect(offenders, offenders.join(", ")).toEqual([]);
  });
});

/**
 * 顶层 `;` 才是语句边界——括号内、字符串内、注释内的分号都不算。
 * 注释里的分号很容易漏（`-- deep research on; align ...`），漏了就会误报。
 */
/** 去掉行注释。语句计数和 charset 检查都得先剥，否则注释里的内容会误报。 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function countTopLevelStatements(sql: string): number {
  const withoutComments = stripSqlComments(sql);

  let count = 0;
  let depth = 0;
  let inString = false;
  for (const ch of withoutComments) {
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === ";" && depth === 0) count += 1;
  }
  return count;
}
