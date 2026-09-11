import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildEnterpriseMcpEntry,
  detectEnterpriseCapabilityNameCollisions,
  enterpriseMcpEntryName,
  enterpriseSkillDirName,
  isEnterpriseSkillMarketplaceApproved,
  isAcceptableBundleUri,
  isSafeManagedSkillDirectoryName,
  normalizeManagedSkillLedger,
  normalizeEnterpriseCapabilities,
  planEnterpriseSkills,
  resolveManagedSkillDirectory,
  removeEnterpriseMcpDocument,
  syncEnterpriseMcpDocument,
  type EnterpriseCapability,
} from "../electron/enterprise-capabilities";

const MCP_ID = "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXYZ";
const SKILL_ID = "skill:01JQMZ8K3N4P5Q6R7S8T9VWXY0";

function mcp(overrides: Partial<EnterpriseCapability> = {}): EnterpriseCapability {
  return {
    id: MCP_ID,
    kind: "mcp",
    name: "market-data",
    displayName: "行情数据",
    requires: [],
    endpointUrl: "https://gw.example.invalid/v1/mcp/01JQMZ8K3N4P5Q6R7S8T9VWXYZ/",
    ...overrides,
  };
}

function skill(overrides: Partial<EnterpriseCapability> = {}): EnterpriseCapability {
  return {
    id: SKILL_ID,
    kind: "skill",
    name: "research",
    displayName: "研究",
    requires: [],
    bundleUri: "https://portal.example.invalid/skills/research/SKILL.md",
    bundleDigest: "A".repeat(64),
    ...overrides,
  };
}

describe("normalizeEnterpriseCapabilities", () => {
  it("drops entries with an unknown kind rather than passing them through", () => {
    expect(normalizeEnterpriseCapabilities([{ id: "x:1", kind: "plugin", name: "n" }])).toEqual([]);
  });

  it("dedupes by capability id", () => {
    expect(normalizeEnterpriseCapabilities([mcp(), mcp({ displayName: "另一个" })])).toHaveLength(1);
  });

  it("survives a config written by an older desktop that had no capabilities", () => {
    expect(normalizeEnterpriseCapabilities(undefined)).toEqual([]);
  });
});

describe("isEnterpriseSkillMarketplaceApproved", () => {
  it("requires an exact publisher match for a scoped capability", () => {
    const approved = [skill({ name: "@finance/report-reader" })];
    expect(isEnterpriseSkillMarketplaceApproved(approved, "report-reader", "finance")).toBe(true);
    expect(isEnterpriseSkillMarketplaceApproved(approved, "report-reader", "another")).toBe(false);
    expect(isEnterpriseSkillMarketplaceApproved(approved, "report-reader")).toBe(false);
  });

  it("allows a deliberately bare approved slug", () => {
    expect(isEnterpriseSkillMarketplaceApproved([skill({ name: "plain-skill" })], "plain-skill"))
      .toBe(true);
    expect(isEnterpriseSkillMarketplaceApproved([skill({ name: "plain-skill" })], "@other/plain-skill"))
      .toBe(false);
    expect(isEnterpriseSkillMarketplaceApproved([skill({ name: "plain-skill" })], "plain-skill", "other"))
      .toBe(false);
  });
});

describe("syncEnterpriseMcpDocument", () => {
  const token = "agx-pat-test";

  it("registers a delivered MCP under the enterprise prefix", () => {
    const result = syncEnterpriseMcpDocument({}, [mcp()], token, []);
    expect(result.managedNames).toEqual(["enterprise-market-data"]);
    expect(result.document.mcpServers).toEqual({
      "enterprise-market-data": buildEnterpriseMcpEntry(mcp(), token),
    });
  });

  it("removes an entry it wrote once the capability stops being delivered", () => {
    // 后台撤销后，能力就不在下发列表里；本地留着等于撤销没生效。
    const result = syncEnterpriseMcpDocument(
      { mcpServers: { "enterprise-market-data": { url: "x" } } },
      [],
      token,
      ["enterprise-market-data"],
    );
    expect(result.document.mcpServers).toEqual({});
    expect(result.managedNames).toEqual([]);
  });

  it("never touches an entry the employee configured themselves", () => {
    const mine = { command: "node", args: ["server.js"] };
    const result = syncEnterpriseMcpDocument({ mcpServers: { mine } }, [mcp()], token, [
      "enterprise-gone",
    ]);
    expect((result.document.mcpServers as Record<string, unknown>).mine).toEqual(mine);
  });

  it("reports a conflict instead of overwriting a same-named entry it did not write", () => {
    const theirs = { url: "https://mine.example.invalid/" };
    const result = syncEnterpriseMcpDocument(
      { mcpServers: { "enterprise-market-data": theirs } },
      [mcp()],
      token,
      [],
    );
    expect(result.conflicts).toEqual(["enterprise-market-data"]);
    expect((result.document.mcpServers as Record<string, unknown>)["enterprise-market-data"]).toEqual(
      theirs,
    );
  });

  it("skips a capability with no gateway endpoint rather than writing a dead server", () => {
    const result = syncEnterpriseMcpDocument({}, [mcp({ endpointUrl: undefined })], token, []);
    expect(result.managedNames).toEqual([]);
    expect(result.unavailable).toEqual(["enterprise-market-data"]);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps unavailable and local-name conflicts as separate sync outcomes", () => {
    const result = syncEnterpriseMcpDocument(
      { mcpServers: { "enterprise-conflicted": { url: "https://mine.example.invalid" } } },
      [
        mcp({ id: "mcp:missing", name: "missing", endpointUrl: undefined }),
        mcp({ id: "mcp:conflicted", name: "conflicted" }),
      ],
      token,
      [],
    );
    expect(result.unavailable).toEqual(["enterprise-missing"]);
    expect(result.conflicts).toEqual(["enterprise-conflicted"]);
  });

  it("sanitizes names into a safe tool prefix", () => {
    expect(enterpriseMcpEntryName(mcp({ name: "行情 Data/v2" }))).toBe("enterprise-data-v2");
  });
});

describe("removeEnterpriseMcpDocument", () => {
  it("withdraws only what it wrote on logout", () => {
    const doc = {
      mcpServers: { "enterprise-market-data": { url: "x" }, mine: { command: "node" } },
    };
    expect(removeEnterpriseMcpDocument(doc, ["enterprise-market-data"]).mcpServers).toEqual({
      mine: { command: "node" },
    });
  });
});

describe("planEnterpriseSkills", () => {
  it("refuses a bundle without a digest, since it cannot be verified", () => {
    const plan = planEnterpriseSkills([skill({ bundleDigest: "" })], []);
    expect(plan.install).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("no-digest");
  });

  it("refuses a plain-http bundle from a non-loopback host", () => {
    const plan = planEnterpriseSkills(
      [skill({ bundleUri: "http://cdn.example.invalid/s.md" })],
      ["research"],
    );
    expect(plan.skipped[0]?.reason).toBe("insecure-uri");
    expect(plan.preserve).toEqual(["research"]);
    expect(plan.remove).toEqual([]);
  });

  it("does not preserve a previous managed copy after delivery is deliberately removed", () => {
    const plan = planEnterpriseSkills([skill({ bundleUri: "", bundleDigest: "" })], ["research"]);
    expect(plan.preserve).toEqual([]);
    expect(plan.remove).toEqual(["research"]);
  });

  it("allows http on loopback so local development still works", () => {
    expect(isAcceptableBundleUri("http://127.0.0.1:3001/skills/a.md")).toBe(true);
  });

  it("lowercases the digest so a hex-case difference is not read as tampering", () => {
    expect(planEnterpriseSkills([skill()], []).install[0]?.bundleDigest).toBe("a".repeat(64));
  });

  it("rejects a short or non-hex digest and preserves a previous managed copy", () => {
    const short = planEnterpriseSkills([skill({ bundleDigest: "abcd" })], ["research"]);
    const nonHex = planEnterpriseSkills([skill({ bundleDigest: "g".repeat(64) })], ["research"]);
    expect(short.skipped[0]?.reason).toBe("invalid-digest");
    expect(short.preserve).toEqual(["research"]);
    expect(short.remove).toEqual([]);
    expect(nonHex.skipped[0]?.reason).toBe("invalid-digest");
  });

  it("rejects credentials and private HTTPS bundle endpoints", () => {
    expect(isAcceptableBundleUri("https://user:pass@cdn.example.invalid/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://127.0.0.1/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://192.168.1.10/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://localhost/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://[::ffff:c0a8:101]/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://[::ffff:7f00:1]/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://[::ffff:172.16.0.1]/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://portal.local/skill.md")).toBe(false);
    expect(isAcceptableBundleUri("https://portal.example.invalid/skill.md#fragment")).toBe(false);
    expect(isAcceptableBundleUri("http://[::ffff:127.0.0.1]/skill.md")).toBe(true);
  });

  it("uses one derived-name collision policy for MCP and Skill capabilities", () => {
    expect(detectEnterpriseCapabilityNameCollisions([
      mcp({ id: "mcp:a", name: "sales/data" }),
      mcp({ id: "mcp:b", name: "sales-data" }),
      skill({ id: "skill:a", name: "finance/report-reader" }),
      skill({ id: "skill:b", name: "finance-report-reader" }),
    ])).toEqual([
      {
        kind: "mcp",
        derivedName: "enterprise-sales-data",
        capabilityIds: ["mcp:a", "mcp:b"],
        capabilityNames: ["sales-data", "sales/data"],
      },
      {
        kind: "skill",
        derivedName: "finance-report-reader",
        capabilityIds: ["skill:a", "skill:b"],
        capabilityNames: ["finance-report-reader", "finance/report-reader"],
      },
    ]);
  });

  it("does not silently pick one MCP when derived names collide", () => {
    const first = mcp({ id: "mcp:a", name: "sales/data", endpointUrl: "https://a.example.invalid" });
    const second = mcp({ id: "mcp:b", name: "sales-data", endpointUrl: "https://b.example.invalid" });
    const result = syncEnterpriseMcpDocument({}, [first, second], "token", []);
    expect(result.conflicts).toEqual(["enterprise-sales-data"]);
    expect(result.managedNames).toEqual([]);
    expect(result.document.mcpServers).toEqual({});
  });

  it("keeps a last-known-good MCP entry when a later snapshot collides", () => {
    const first = mcp({ id: "mcp:a", name: "sales/data", endpointUrl: "https://a.example.invalid" });
    const second = mcp({ id: "mcp:b", name: "sales-data", endpointUrl: "https://b.example.invalid" });
    const result = syncEnterpriseMcpDocument(
      { mcpServers: { "enterprise-sales-data": { url: "https://old.example.invalid" } } },
      [first, second],
      "token",
      ["enterprise-sales-data"],
    );
    expect(result.managedNames).toEqual(["enterprise-sales-data"]);
    expect(result.document.mcpServers).toEqual({
      "enterprise-sales-data": { url: "https://old.example.invalid" },
    });
  });

  it("filters ledger names and resolves only contained managed Skill directories", () => {
    const root = path.join("/tmp", "enterprise-skills");
    expect(normalizeManagedSkillLedger(["report-reader", "../outside", "report-reader", ""])).toEqual([
      "report-reader",
    ]);
    expect(isSafeManagedSkillDirectoryName("report-reader")).toBe(true);
    expect(isSafeManagedSkillDirectoryName("../outside")).toBe(false);
    expect(isSafeManagedSkillDirectoryName("report.reader")).toBe(false);
    expect(resolveManagedSkillDirectory(root, "report-reader")).toBe(path.join(root, "report-reader"));
    expect(resolveManagedSkillDirectory(root, "../outside")).toBeNull();
    expect(resolveManagedSkillDirectory(root, ".")).toBeNull();
    expect(resolveManagedSkillDirectory("/", "report-reader")).toBe("/report-reader");
    expect(enterpriseSkillDirName(skill({ name: "../../" }))).toBe("skill-01jqmz8k3n4p5q6r7s8t9vwxy0");
  });

  it("removes a skill directory it installed once the skill stops being delivered", () => {
    expect(planEnterpriseSkills([], ["research"]).remove).toEqual(["research"]);
  });

  it("plans an assigned Skill A to B replacement in one sync", () => {
    const plan = planEnterpriseSkills(
      [
        skill({
          id: "skill:replacement",
          name: "analysis-b",
          bundleUri: "https://portal.example.invalid/skills/analysis-b/SKILL.md",
        }),
      ],
      ["research"],
    );
    expect(plan.install.map((item) => item.dirName)).toEqual(["analysis-b"]);
    expect(plan.remove).toEqual(["research"]);
  });
});
