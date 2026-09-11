/**
 * web-portal · 能力包相关表的方言解析。
 *
 * PG 与 MySQL 的 drizzle 句柄类型不同，联合类型会让链式调用无法解析。这里按实际
 * 用到的最小结构各收敛一次；表对象本身仍是各自方言的强类型，字段写错照样报错。
 */

import {
  departments as pgDepartments,
  enterpriseCapabilityAssignments as pgAssignments,
  enterpriseCapabilityPackMembers as pgMembers,
  enterpriseCapabilityPacks as pgPacks,
  enterpriseConfigMarketItems as pgConfigMarketItems,
  enterpriseConfigMarketReleases as pgConfigMarketReleases,
  enterpriseUserOptOuts as pgOptOuts,
  enterpriseUserGroupMembers as pgGroupMembers,
  enterpriseUserGroups as pgGroups,
  enterpriseSkills as pgSkills,
  mcpServers as pgMcpServers,
  tenants as pgTenants,
  users as pgUsers,
} from "@agenticx/db-schema";
import {
  departments as myDepartments,
  enterpriseCapabilityAssignments as myAssignments,
  enterpriseCapabilityPackMembers as myMembers,
  enterpriseCapabilityPacks as myPacks,
  enterpriseConfigMarketItems as myConfigMarketItems,
  enterpriseConfigMarketReleases as myConfigMarketReleases,
  enterpriseUserOptOuts as myOptOuts,
  enterpriseUserGroupMembers as myGroupMembers,
  enterpriseUserGroups as myGroups,
  enterpriseSkills as mySkills,
  mcpServers as myMcpServers,
  tenants as myTenants,
  users as myUsers,
} from "@agenticx/db-schema/mysql";
import { createMysqlDb, getIamDb, resolveDatabaseConfig } from "@agenticx/iam-core";

export type CapabilityDialect = "postgresql" | "mysql";

/** 本包用到的 drizzle 读查询子集。 */
export type DialectQuery = {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      innerJoin: (table: unknown, on: unknown) => { where: (cond: unknown) => Promise<unknown[]> };
      where: (cond: unknown) => Promise<unknown[]>;
    };
  };
};

/** 本包用到的 drizzle 写查询子集。 */
export type DialectMutation = {
  insert: (table: unknown) => { values: (rows: unknown) => Promise<unknown> };
  delete: (table: unknown) => { where: (cond: unknown) => Promise<unknown> };
};

export function requiredCapabilityTenant(): string {
  const t = process.env.DEFAULT_TENANT_ID?.trim();
  if (!t) throw new Error("DEFAULT_TENANT_ID is required to resolve enterprise capabilities.");
  return t;
}

/** Return only the schema handles for a dialect; callers can pair them with
 * an existing transaction instead of accidentally opening a second one. */
export function capabilityTableDefinitions(dialect: CapabilityDialect) {
  if (dialect === "mysql") {
    return {
      packs: myPacks,
      assignments: myAssignments,
      members: myMembers,
      skills: mySkills,
      mcp: myMcpServers,
      users: myUsers,
      departments: myDepartments,
      groups: myGroups,
      groupMembers: myGroupMembers,
      configMarketItems: myConfigMarketItems,
      configMarketReleases: myConfigMarketReleases,
      optOuts: myOptOuts,
      tenants: myTenants,
    } as const;
  }
  return {
    packs: pgPacks,
    assignments: pgAssignments,
    members: pgMembers,
    skills: pgSkills,
    mcp: pgMcpServers,
    users: pgUsers,
    departments: pgDepartments,
    groups: pgGroups,
    groupMembers: pgGroupMembers,
    configMarketItems: pgConfigMarketItems,
    configMarketReleases: pgConfigMarketReleases,
    optOuts: pgOptOuts,
    tenants: pgTenants,
  } as const;
}

export async function dialectCapabilityTables() {
  const config = resolveDatabaseConfig();
  if (config.dialect === "mysql") {
    const { raw: db } = await createMysqlDb(config);
    return {
      db,
      ...capabilityTableDefinitions("mysql"),
    } as const;
  }
  return {
    db: getIamDb(),
    ...capabilityTableDefinitions("postgresql"),
  } as const;
}
