import { describe, expect, it } from "vitest";
import { v2ExpertManifest } from "../config-share-test-fixtures";
import { createMemoryConfigShareStore } from "./store";

const manifest = v2ExpertManifest("投研专家", { description: "内部配置" });

describe("config share store boundaries", () => {
  it("keeps snapshots immutable, tenant-scoped, and author-revocable", async () => {
    const store = createMemoryConfigShareStore();
    const created = await store.create({
      tenantId: "tenant-a",
      userId: "author-a",
      ownerDisplayName: "Alice",
      kind: "expert",
      manifestVersion: 2,
      manifest,
    });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await store.get(created.token, "tenant-b")).toBeNull();

    created.manifest.payload.name = "mutated by caller";
    const loaded = await store.get(created.token, "tenant-a");
    expect(loaded?.manifest.payload.name).toBe("投研专家");

    expect(await store.revoke(created.token, "tenant-a", "someone-else")).toBe(false);
    expect(await store.revoke(created.token, "tenant-b", "author-a")).toBe(false);
    expect(await store.revoke(created.token, "tenant-a", "author-a")).toBe(true);
    expect(await store.get(created.token, "tenant-a")).toBeNull();
  });
});
