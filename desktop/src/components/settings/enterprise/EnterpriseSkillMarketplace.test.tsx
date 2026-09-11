import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  EnterpriseSkillMarketplace,
  isEnterpriseManagedSkillInstalled,
  isPortableMarketSkillReleaseInstalled,
} from "./EnterpriseSkillMarketplace";
import type { EnterpriseCapabilitySyncState } from "../../../../shared/enterprise-capability-sync";

const noopAsync = vi.fn(async () => undefined);

describe("EnterpriseSkillMarketplace", () => {
  it("only disables market installation for the exact installed release", () => {
    const item = {
      id: "01JABCDEF0123456789ABCDEFG",
      version: "1.1.0",
      digest: "a".repeat(64),
    } as PortableMarketItem;

    expect(isPortableMarketSkillReleaseInstalled({
      itemId: item.id,
      version: item.version,
      digest: item.digest,
      name: "release-skill",
    }, item)).toBe(true);
    expect(isPortableMarketSkillReleaseInstalled({
      itemId: item.id,
      version: "1.0.0",
      digest: item.digest,
      name: "release-skill",
    }, item)).toBe(false);
    expect(isPortableMarketSkillReleaseInstalled({
      itemId: item.id,
      version: item.version,
      digest: "b".repeat(64),
      name: "release-skill",
    }, item)).toBe(false);
    expect(isPortableMarketSkillReleaseInstalled(undefined, item)).toBe(false);
  });

  it("renders only assigned skills and distinguishes push from self-service", () => {
    const html = renderToStaticMarkup(
      <EnterpriseSkillMarketplace
        capabilities={[
          {
            id: "skill:managed",
            kind: "skill",
            name: "managed-report",
            displayName: "托管报告技能",
            bundleUri: "https://portal.test/skills/managed-report/SKILL.md",
            bundleDigest: "a".repeat(64),
          },
          {
            id: "skill:self-service",
            kind: "skill",
            name: "@finance/reader",
            displayName: "批准阅读技能",
          },
          { id: "mcp:ignored", kind: "mcp", name: "private-data" },
        ]}
        syncStatuses={[{
          capabilityId: "skill:managed",
          kind: "skill",
          status: "applied",
        }]}
        onRefresh={noopAsync}
        getInstallState={(capability) =>
          capability.id === "skill:managed" ? "installed" : "idle"
        }
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain("公司 Skill 市场");
    expect(html).toContain("托管报告技能");
    expect(html).toContain("强制下发");
    expect(html).toContain("已应用");
    expect(html).toContain("批准阅读技能");
    expect(html).toContain("企业批准 · 可自行安装");
    expect(html).toContain("安装");
    expect(html).not.toContain("private-data");
    expect(html).not.toContain("官方推荐");
    expect(html).not.toContain("CLAWHUB");
    expect(html).not.toContain("访问市场");
  });

  it("does not fall back to a public catalogue when the allowlist is empty", () => {
    const html = renderToStaticMarkup(
      <EnterpriseSkillMarketplace
        capabilities={[]}
        onRefresh={noopAsync}
        getInstallState={() => "idle"}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain("管理员尚未通过能力包分配技能");
    expect(html).not.toContain("SkillHub 技能目录");
  });

  it("matches a managed scoped skill by its full cleaned enterprise directory", () => {
    const capability = {
      id: "skill:scoped",
      kind: "skill" as const,
      name: "@finance/report-reader",
    };

    expect(
      isEnterpriseManagedSkillInstalled(
        [{ base_dir: "/Users/test/.agenticx/skills/enterprise/finance-report-reader" }],
        capability,
      ),
    ).toBe(true);
    expect(
      isEnterpriseManagedSkillInstalled(
        [{ base_dir: "/Users/test/.agenticx/skills/enterprise/report-reader" }],
        capability,
      ),
    ).toBe(false);
  });

  it("does not turn an idle local fallback into a waiting-sync claim", () => {
    const html = renderToStaticMarkup(
      <EnterpriseSkillMarketplace
        capabilities={[{
          id: "skill:managed",
          kind: "skill",
          name: "managed-report",
          bundleUri: "https://portal.test/skills/managed-report/SKILL.md",
          bundleDigest: "a".repeat(64),
        }]}
        onRefresh={noopAsync}
        getInstallState={() => "idle"}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain("状态待刷新");
    expect(html).not.toContain("等待客户端同步");
  });

  it("does not infer an applied receipt from an old local managed directory", () => {
    const html = renderToStaticMarkup(
      <EnterpriseSkillMarketplace
        capabilities={[{
          id: "skill:managed-old",
          kind: "skill",
          name: "managed-report",
          bundleUri: "https://portal.test/skills/managed-report/SKILL.md",
          bundleDigest: "a".repeat(64),
        }]}
        onRefresh={noopAsync}
        getInstallState={() => "installed"}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain("状态待刷新");
    expect(html).not.toContain("已应用");
  });

  it("renders receipt states, safe failure reasons, and a retry entry", () => {
    const html = renderToStaticMarkup(
      <EnterpriseSkillMarketplace
        capabilities={[{
          id: "skill:failed",
          kind: "skill",
          name: "managed-report",
          bundleUri: "https://portal.test/skills/managed-report/SKILL.md",
          bundleDigest: "b".repeat(64),
        }]}
        syncStatuses={[{
          capabilityId: "skill:failed",
          kind: "skill",
          status: "failed",
          errorCode: "digest_mismatch",
          message: "https://secret.invalid/private/path",
        }]}
        onRefresh={noopAsync}
        onRetrySync={vi.fn()}
        getInstallState={() => "idle"}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain("同步失败");
    expect(html).toContain("SHA 校验不匹配");
    expect(html).toContain("重试");
    expect(html).not.toContain("secret.invalid");
  });

  it("uses applied receipt as the synced signal even when the local fallback is idle", () => {
    const html = renderToStaticMarkup(
      <EnterpriseSkillMarketplace
        capabilities={[{
          id: "skill:applied",
          kind: "skill",
          name: "managed-report",
          bundleUri: "https://portal.test/skills/managed-report/SKILL.md",
          bundleDigest: "c".repeat(64),
        }]}
        syncStatuses={[{ capabilityId: "skill:applied", kind: "skill", status: "applied" }]}
        onRefresh={noopAsync}
        getInstallState={() => "idle"}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain("已应用");
    expect(html).not.toContain("状态待刷新");
  });

  it.each([
    ["waiting", "等待应用"],
    ["downloading", "下载中"],
    ["verifying", "校验中"],
    ["applied", "已应用"],
    ["failed", "同步失败"],
  ] as const)("renders the %s receipt state", (status, label) => {
    const html = renderToStaticMarkup(
      <EnterpriseSkillMarketplace
        capabilities={[{
          id: `skill:${status}`,
          kind: "skill",
          name: "managed-report",
          bundleUri: "https://portal.test/skills/managed-report/SKILL.md",
          bundleDigest: "d".repeat(64),
        }]}
        syncStatuses={[{
          capabilityId: `skill:${status}`,
          kind: "skill",
          status: status as EnterpriseCapabilitySyncState,
          ...(status === "failed" ? { errorCode: "write_failed" } : {}),
        }]}
        onRefresh={noopAsync}
        getInstallState={() => "idle"}
        onInstall={vi.fn()}
      />,
    );

    expect(html).toContain(label);
  });
});
