import { describe, expect, it } from "vitest";

import {
  detectEnterpriseCapabilityNameCollisions,
  enterpriseMcpMarketplaceItems,
  enterpriseCapabilitySyncFailureReason,
  enterpriseSkillCoordinate,
  enterpriseSkillDirectoryName,
  filterEnterpriseCapabilities,
  hasManagedSkillDelivery,
  hasValidManagedSkillDelivery,
  isAcceptableEnterpriseSkillBundleUri,
  isSafeEnterpriseSkillDirectoryName,
  isEnterpriseSkillMarketplaceApproved,
  type EnterpriseCapabilityLike,
} from "../shared/enterprise-capability-market";

const capabilities: EnterpriseCapabilityLike[] = [
  {
    id: "skill:1",
    kind: "skill",
    name: "@finance/report-reader",
    displayName: "报告阅读",
  },
  { id: "skill:2", kind: "skill", name: "plain-skill", displayName: "普通技能" },
  {
    id: "mcp:1",
    kind: "mcp",
    name: "market-data",
    displayName: "行情数据",
    endpointUrl: "https://gateway.invalid/mcp/market-data/streamable-http",
  },
];

describe("enterprise capability market", () => {
  it("keeps the scoped SkillHub identity instead of matching another publisher", () => {
    expect(enterpriseSkillCoordinate("@finance/report-reader")).toEqual({
      slug: "report-reader",
      namespace: "finance",
      canonicalName: "@finance/report-reader",
    });
    expect(
      isEnterpriseSkillMarketplaceApproved(capabilities, "report-reader", "finance"),
    ).toBe(true);
    expect(
      isEnterpriseSkillMarketplaceApproved(capabilities, "report-reader", "another"),
    ).toBe(false);
    expect(isEnterpriseSkillMarketplaceApproved(capabilities, "report-reader")).toBe(false);
  });

  it("allows a deliberately bare registry slug", () => {
    expect(isEnterpriseSkillMarketplaceApproved(capabilities, "plain-skill")).toBe(true);
    expect(isEnterpriseSkillMarketplaceApproved(capabilities, "plain-skill", "other")).toBe(false);
    expect(isEnterpriseSkillMarketplaceApproved(capabilities, "@other/plain-skill")).toBe(false);
    expect(isEnterpriseSkillMarketplaceApproved(capabilities, "@finance/report-reader")).toBe(true);
    expect(isEnterpriseSkillMarketplaceApproved(capabilities, "report-reader", "@finance")).toBe(true);
  });

  it("returns an empty enterprise market instead of falling back to the public catalog", () => {
    expect(filterEnterpriseCapabilities([], "skill", "")).toEqual([]);
  });

  it("filters the visible catalog by capability kind and local search", () => {
    expect(filterEnterpriseCapabilities(capabilities, "skill").map((item) => item.id)).toEqual([
      "skill:1",
      "skill:2",
    ]);
    expect(filterEnterpriseCapabilities(capabilities, "skill", "报告").map((item) => item.id)).toEqual([
      "skill:1",
    ]);
  });

  it("distinguishes managed delivery from approved self-service without a schema change", () => {
    expect(hasManagedSkillDelivery(capabilities[0])).toBe(false);
    expect(hasManagedSkillDelivery({
      ...capabilities[0],
      kind: "mcp",
      bundleUri: "https://portal.invalid/skills/report-reader/SKILL.md",
      bundleDigest: "a".repeat(64),
    })).toBe(false);
    expect(
      hasManagedSkillDelivery({
        ...capabilities[0],
        bundleUri: "https://portal.invalid/skills/report-reader/SKILL.md",
        bundleDigest: "a".repeat(64),
      }),
    ).toBe(true);
    expect(
      hasManagedSkillDelivery({
        ...capabilities[0],
        bundleUri: "http://cdn.example.invalid/skills/report-reader/SKILL.md",
        bundleDigest: "b".repeat(64),
      }),
    ).toBe(true);
    expect(
      hasManagedSkillDelivery({
        ...capabilities[0],
        bundleUri: "https://portal.invalid/skills/report-reader/SKILL.md",
        bundleDigest: "abc",
      }),
    ).toBe(true);
    expect(hasValidManagedSkillDelivery({
      ...capabilities[0],
      bundleUri: "https://portal.invalid/skills/report-reader/SKILL.md",
      bundleDigest: "a".repeat(64),
    })).toBe(true);
    expect(hasValidManagedSkillDelivery({
      ...capabilities[0],
      bundleUri: "http://cdn.example.invalid/skills/report-reader/SKILL.md",
      bundleDigest: "b".repeat(64),
    })).toBe(false);
    expect(hasValidManagedSkillDelivery({
      ...capabilities[0],
      bundleUri: "https://portal.invalid/skills/report-reader/SKILL.md",
      bundleDigest: "abc",
    })).toBe(false);
    expect(isAcceptableEnterpriseSkillBundleUri("http://127.0.0.1:3001/skills/a.md")).toBe(true);
  });

  it("uses strict URI semantics for credentials, fragments, local names, and private hosts", () => {
    const accepted = [
      "https://portal.example.invalid/skills/a.md",
      "HTTPS://PORTAL.EXAMPLE.INVALID/skills/a.md?version=1",
      "http://localhost:3001/skills/a.md",
      "http://[::1]:3001/skills/a.md",
      "http://[::ffff:127.0.0.1]:3001/skills/a.md",
    ];
    const rejected = [
      "https://user:pass@portal.example.invalid/skills/a.md",
      "https://portal.example.invalid/skills/a.md#fragment",
      "https://portal.example.invalid/skills/a.md#",
      "https://portal.local/skills/a.md",
      "https://portal.localhost/skills/a.md",
      "https://localhost./skills/a.md",
      "https://10.0.0.1/skills/a.md",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/skills/a.md",
      "https://[fd00::1]/skills/a.md",
      "https://[fe80::1]/skills/a.md",
      "https://[::ffff:192.168.1.1]/skills/a.md",
      "http://192.168.1.1/skills/a.md",
      "ftp://portal.example.invalid/skills/a.md",
    ];
    for (const uri of accepted) expect(isAcceptableEnterpriseSkillBundleUri(uri), uri).toBe(true);
    for (const uri of rejected) expect(isAcceptableEnterpriseSkillBundleUri(uri), uri).toBe(false);
  });

  it("reports MCP and Skill derived-name collisions independently", () => {
    const collisions = detectEnterpriseCapabilityNameCollisions([
      { id: "mcp:a", kind: "mcp", name: "Sales/Data" },
      { id: "mcp:b", kind: "mcp", name: "sales-data" },
      { id: "skill:a", kind: "skill", name: "finance/report-reader" },
      { id: "skill:b", kind: "skill", name: "finance-report-reader" },
      { id: "mcp:c", kind: "mcp", name: "unique" },
    ]);
    expect(collisions).toEqual([
      {
        kind: "mcp",
        derivedName: "enterprise-sales-data",
        capabilityIds: ["mcp:a", "mcp:b"],
        capabilityNames: ["Sales/Data", "sales-data"],
      },
      {
        kind: "skill",
        derivedName: "finance-report-reader",
        capabilityIds: ["skill:a", "skill:b"],
        capabilityNames: ["finance-report-reader", "finance/report-reader"],
      },
    ]);
  });

  it("keeps generated Skill directory names safe for the managed ledger", () => {
    expect(enterpriseSkillDirectoryName({ id: "skill:bad", kind: "skill", name: "../../" })).toBe("skill-bad");
    expect(isSafeEnterpriseSkillDirectoryName("report-reader")).toBe(true);
    expect(isSafeEnterpriseSkillDirectoryName("../outside")).toBe(false);
    expect(isSafeEnterpriseSkillDirectoryName("report.reader")).toBe(false);
    expect(isSafeEnterpriseSkillDirectoryName("Report-reader")).toBe(false);
  });

  it("maps only assigned MCP capabilities into managed market cards", () => {
    expect(enterpriseMcpMarketplaceItems(capabilities)).toEqual([
      expect.objectContaining({
        id: "mcp:1",
        chinese_name: "行情数据",
        enterprise_managed: true,
        endpoint_ready: true,
      }),
    ]);
  });

  it("maps stable sync error codes without exposing the raw message", () => {
    expect(enterpriseCapabilitySyncFailureReason({
      errorCode: "download_failed",
      message: "https://secret.invalid/private-bundle",
    })).toContain("地址不可达");
    expect(enterpriseCapabilitySyncFailureReason({ errorCode: "digest_mismatch" })).toContain("SHA 校验不匹配");
    expect(enterpriseCapabilitySyncFailureReason({ errorCode: "size_exceeded" })).toContain("包体积超过限制");
    expect(enterpriseCapabilitySyncFailureReason({ errorCode: "write_failed" })).toContain("写入本机失败");
    expect(enterpriseCapabilitySyncFailureReason({ errorCode: "index_refresh_failed" })).toContain("技能索引校验失败");
    expect(enterpriseCapabilitySyncFailureReason({ errorCode: "skill_not_loaded" })).toContain("本机索引未能加载该技能");
  });
});
