import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { v2ExpertManifest } from "../config-share-test-fixtures";

import {
  configMarketCanonicalRaw,
  configMarketManifestDigest,
  normalizeConfigMarketAudience,
  toConfigMarketDetail,
  toManagedPortablePackage,
  type ConfigMarketItem,
} from "./types";

const raw = v2ExpertManifest();

const item: ConfigMarketItem = {
  id: "01JQMZ8K3N4P5Q6R7S8T9VWXYZ",
  tenantId: "tenant-a",
  userId: "user-a",
  ownerDisplayName: "Alice",
  kind: "expert",
  sourceArtifactId: raw.artifact_id,
  manifestVersion: 2,
  releaseId: "01JQMZ8K3N4P5Q6R7S8T9VWX01",
  version: "1.0.0",
  title: raw.title,
  description: raw.description,
  digest: configMarketManifestDigest(raw),
  raw,
  releaseNotes: "首次发布",
  releasePublishedAt: "2026-08-28T00:00:00.000Z",
  downloadCount: 0,
  status: "published",
  deliveryState: "active",
  visibility: "users",
  visibleDepartmentIds: [],
  visibleUserIds: ["01JQMZ8K3N4P5Q6R7S8T9VWXY0"],
  publishedAt: "2026-08-28T00:00:00.000Z",
  unlistedAt: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

describe("config market wire contract", () => {
  it("normalizes personal visibility to an empty, non-expandable audience", () => {
    expect(normalizeConfigMarketAudience({
      visibility: "personal",
      visibleDepartmentIds: [],
      visibleUserIds: [],
    })).toEqual({ visibility: "personal", visibleDepartmentIds: [], visibleUserIds: [] });
    expect(normalizeConfigMarketAudience({
      visibility: "personal",
      visibleDepartmentIds: ["01JQMZ8K3N4P5Q6R7S8T9VWXY0"],
      visibleUserIds: [],
    })).toBeNull();
  });

  it("hashes the exact canonical raw UTF-8 string delivered to Desktop", () => {
    const canonical = configMarketCanonicalRaw(raw);
    expect(configMarketManifestDigest(raw)).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
    expect(toManagedPortablePackage(item)).toMatchObject({
      raw: canonical,
      digest: configMarketManifestDigest(raw),
    });
  });

  it("keeps raw outside detail item metadata", () => {
    const detail = toConfigMarketDetail(item);
    expect(detail.item).not.toHaveProperty("raw");
    expect(detail.item).toMatchObject({
      visibility: "users",
      visibleDepartmentCount: 0,
      visibleUserCount: 1,
    });
    expect(detail.item).not.toHaveProperty("visibleUserIds");
    expect(detail.item).not.toHaveProperty("visibleDepartmentIds");
    expect(detail.raw).toBe(configMarketCanonicalRaw(raw));
  });
});
