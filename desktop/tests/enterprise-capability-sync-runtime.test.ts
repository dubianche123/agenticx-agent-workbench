import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildEnterpriseCapabilityReceiptPayload,
  pruneEnterpriseCapabilitySyncState,
  recordEnterpriseCapabilitySyncStatus,
  writeManagedSkillDirectory,
  type EnterpriseCapabilitySyncConfig,
  type EnterpriseCapabilitySyncConfigStore,
} from "../electron/enterprise-capability-sync";
import type { EnterpriseCapability } from "../electron/enterprise-capabilities";

const roots: string[] = [];

function capability(overrides: Partial<EnterpriseCapability> = {}): EnterpriseCapability {
  return {
    id: "skill:runtime",
    kind: "skill",
    name: "runtime",
    displayName: "Runtime",
    requires: [],
    version: "1.0.0",
    bundleDigest: "a".repeat(64),
    ...overrides,
  };
}

function storeWith(
  initial: EnterpriseCapabilitySyncConfig,
): { store: EnterpriseCapabilitySyncConfigStore<EnterpriseCapabilitySyncConfig>; read: () => EnterpriseCapabilitySyncConfig } {
  let config = initial;
  return {
    store: {
      load: () => config,
      save: (next) => {
        config = next;
      },
    },
    read: () => config,
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenticx-capability-runtime-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("enterprise capability sync runtime contract", () => {
  it("keeps LKG on a failed attempt, rejects stale PAT writes, and prunes revoked rows", () => {
    const cap = capability();
    const other = capability({ id: "skill:revoked" });
    const state = storeWith({
      enterprise: {
        enabled: true,
        token: "pat-current",
        capability_sync_statuses: [
          { capabilityId: other.id, kind: "skill", status: "applied" },
        ],
        capability_sync_last_applied: {
          [other.id]: { appliedAt: "2026-09-01T00:00:00.000Z" },
        },
      },
    });
    recordEnterpriseCapabilitySyncStatus(
      cap,
      { status: "applied", attemptedAt: "2026-09-02T00:00:00.000Z", appliedAt: "2026-09-02T00:01:00.000Z" },
      "pat-current",
      state.store,
    );
    recordEnterpriseCapabilitySyncStatus(
      cap,
      { status: "failed", errorCode: "write_failed", message: "preserve" },
      "pat-current",
      state.store,
    );
    expect(state.read().enterprise?.capability_sync_last_applied?.[`skill:${cap.id}`]).toMatchObject({
      appliedAt: "2026-09-02T00:01:00.000Z",
    });
    const before = JSON.stringify(state.read());
    expect(recordEnterpriseCapabilitySyncStatus(cap, { status: "applied" }, "stale", state.store)).toBeNull();
    expect(JSON.stringify(state.read())).toBe(before);

    pruneEnterpriseCapabilitySyncState([cap], "pat-current", state.store);
    expect(state.read().enterprise?.capability_sync_statuses?.map((row) => row.capabilityId)).toEqual([
      cap.id,
    ]);
    expect(Object.keys(state.read().enterprise?.capability_sync_last_applied ?? {})).toEqual([
      `skill:${cap.id}`,
    ]);
  });

  it("stages new and replacement Skills and refuses an unowned directory", () => {
    const root = tempRoot();
    writeManagedSkillDirectory(root, "managed", "version one");
    writeManagedSkillDirectory(root, "managed", "version two");
    expect(fs.readFileSync(path.join(root, "managed", "SKILL.md"), "utf8")).toBe("version two");

    const userDir = path.join(root, "user-owned");
    fs.mkdirSync(userDir);
    fs.writeFileSync(path.join(userDir, "SKILL.md"), "do not overwrite");
    expect(() => writeManagedSkillDirectory(root, "user-owned", "managed content")).toThrow(
      "不会覆盖",
    );
    expect(fs.readFileSync(path.join(userDir, "SKILL.md"), "utf8")).toBe("do not overwrite");
  });

  it("builds only current per-capability receipt rows", () => {
    const current = capability();
    const stale = capability({ id: "skill:stale" });
    expect(
      buildEnterpriseCapabilityReceiptPayload(
        [current],
        [
          { capabilityId: stale.id, kind: "skill", status: "failed", errorCode: "write_failed" },
          { capabilityId: current.id, kind: "skill", status: "applied", version: "1.0.0" },
        ],
        "2026-09-02T00:00:00.000Z",
      ),
    ).toEqual([
      {
        capabilityId: current.id,
        kind: "skill",
        status: "applied",
        version: "1.0.0",
      },
    ]);
  });
});
