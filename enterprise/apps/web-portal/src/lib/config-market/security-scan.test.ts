import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { v2ExpertManifest } from "../config-share-test-fixtures";
import {
  assertConfigMarketManifestSafe,
  ConfigMarketSecurityScanError,
  scanConfigMarketManifest,
} from "./security-scan";

describe("config market authoritative security scan", () => {
  it("blocks API keys and returns only rule/location metadata", () => {
    const manifest = v2ExpertManifest("风险专家", {
      systemPrompt: "api_key = sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    });
    expect(() => assertConfigMarketManifestSafe(manifest)).toThrow(ConfigMarketSecurityScanError);
    const findings = scanConfigMarketManifest(manifest);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "secret", field: "manifest.payload.system_prompt" }),
      ]),
    );
    expect(JSON.stringify(findings)).not.toContain("sk-proj-");
  });

  it("detects Luhn-valid bank cards and PII in selected markdown", () => {
    const content = "客户邮箱 alice@example.com，卡号 4111 1111 1111 1111";
    const manifest = v2ExpertManifest();
    manifest.resources = [{
      path: "project/CONTEXT.md",
      content,
      digest: createHash("sha256").update(content).digest("hex"),
    }];
    expect(scanConfigMarketManifest(manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "email", category: "pii" }),
        expect.objectContaining({ code: "bank_card", category: "pii" }),
      ]),
    );
  });

  it("scans release and dependency versions including SemVer build metadata", () => {
    const token = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const manifest = v2ExpertManifest();
    manifest.release_version = `1.0.0+${token}`;
    manifest.dependencies.skills = [{
      capability_id: "skill:01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
      version: `2.0.0+${token}`,
      digest: "a".repeat(64),
      required: false,
    }];
    manifest.dependencies.mcps = [{
      capability_id: "mcp:01JQMZ8K3N4P5Q6R7S8T9VWXY1",
      version: `3.0.0+${token}`,
      required: false,
    }];
    expect(scanConfigMarketManifest(manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "openai_key", field: "manifest.release_version" }),
      expect.objectContaining({ code: "openai_key", field: "manifest.dependencies.skills[0].version" }),
      expect.objectContaining({ code: "openai_key", field: "manifest.dependencies.mcps[0].version" }),
    ]));
  });

  it("independently blocks every Python portable blocking secret family", () => {
    const cases = [
      ["private_key", "-----BEGIN PRIVATE KEY-----"],
      ["openai_key", "_sk-proj-abcdefghijklmnopqrstuvwxyz123456"],
      ["anthropic_key", "_sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
      ["github_token", "_ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
      ["stripe_key", "_sk_live_abcdefghijklmnopqrstuvwxyz123456"],
      ["slack_token", "_xoxb-abcdefghijklmnop"],
      ["slack_webhook", "https://hooks.slack.com/services/TABC/BDEF/abcdefghijkl"],
      ["gcp_service_account", '{"type":"service_account"}'],
      ["azure_connection_string", "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=abcdefghijklmnopqrstuvwxyz1234567890=="],
      ["aws_access_key", "_AKIA1234567890ABCDEF"],
      ["google_api_key", "_AIza123456789012345678901234567890123"],
      ["jwt", "_eyJabcdefghijkl.eyJabcdefghijkl.eyJabcdefghijkl"],
      ["bearer_token", "_Bearer abcdefghijklmnop"],
      ["basic_auth", "_Basic YWJjZGVmZ2hpamtsbW5vcA=="],
      ["assigned_secret", "_api_key=abcdefghijklmnopqrst"],
      ["credential_url", "_https://user:password@example.com"],
    ] as const;
    const manifest = v2ExpertManifest("边界安全专家", {
      systemPrompt: cases.map(([, value]) => value).join("\n"),
    });
    const findings = scanConfigMarketManifest(manifest);
    for (const [code] of cases) {
      expect(findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code, category: "secret" }),
      ]));
    }
    expect(() => assertConfigMarketManifestSafe(manifest)).toThrow(ConfigMarketSecurityScanError);
    expect(JSON.stringify(findings)).not.toContain("abcdefghijklmnopqrst");
  });

  it("blocks country-code phones in both compact and spaced forms", () => {
    const manifest = v2ExpertManifest("手机号专家", {
      systemPrompt: "compact 8613812345679 and spaced +86 13812345679",
    });
    const findings = scanConfigMarketManifest(manifest);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "cn_phone", category: "pii" }),
    ]));
    expect(() => assertConfigMarketManifestSafe(manifest)).toThrow(ConfigMarketSecurityScanError);
  });

  it("accepts ordinary prompts and public project markdown", () => {
    expect(() => assertConfigMarketManifestSafe(v2ExpertManifest())).not.toThrow();
  });
});
