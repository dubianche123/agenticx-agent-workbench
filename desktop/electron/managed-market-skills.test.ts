import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  enterpriseMarketSkillDirName,
  managedMarketSkillDirectoryName,
  managedMarketSkillsRoot,
  normalizeManagedMarketSkillLedger,
  normalizeManagedMarketSkillPackage,
  normalizeManagedMarketSkillSnapshot,
  planManagedMarketSkillExit,
  planManagedMarketSkills,
  removeManagedMarketSkillDirectory,
  resolveManagedMarketSkillDirectory,
  settleManagedMarketSkillDirectoryTransactions,
  stageManagedMarketSkillDirectory,
  voluntaryMarketSkillsRoot,
  writeManagedMarketSkillDirectory,
} from "./managed-market-skills";

const ITEM_ID = "skill:01JABCDEF0123456789ABCDEFG";
const OTHER_ITEM_ID = "skill:01JABCDEF0123456789ABCDEGH";
const STALE_ITEM_ID = "skill:01JABCDEF0123456789ABCDEGJ";
const SOURCE_ARTIFACT_ID = "skill:01JABCDEF0123456789ABCDEGK";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function marketSkillPackage(
  id = ITEM_ID,
  options: { name?: string; version?: string; body?: string; sourceArtifactId?: string } = {},
) {
  const name = options.name ?? "same-name";
  const description = `Description for ${name}`;
  const skillMd = options.body
    ?? `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
  const manifest = {
    // This is deliberately different from the outer market item ID.  The
    // source artifact belongs to the publisher; the outer ID belongs to the
    // capability-pack/market assignment.
    artifact_id: options.sourceArtifactId ?? SOURCE_ARTIFACT_ID,
    dependencies: { mcps: [], skills: [] },
    description,
    kind: "skill",
    payload: { description, name, skill_md: skillMd },
    recommended_permission_mode: "ask",
    release_version: options.version ?? "1.0.0",
    resources: [],
    schema_version: 2,
    title: name,
    workspace_slots: [],
  };
  const raw = canonicalJson(manifest);
  return {
    id,
    kind: "skill" as const,
    digest: crypto.createHash("sha256").update(raw, "utf8").digest("hex"),
    raw,
  };
}

function ledgerFor(...packages: ReturnType<typeof marketSkillPackage>[]) {
  return Object.fromEntries(packages.map((item) => [
    item.id,
    {
      dirName: managedMarketSkillDirectoryName(item.id)!,
      digest: item.digest,
    },
  ]));
}

describe("managed market Skill package boundaries", () => {
  it("accepts a real v2 Skill package when item and source artifact IDs differ", () => {
    const item = marketSkillPackage();
    const normalized = normalizeManagedMarketSkillPackage(item);

    expect(normalized).toMatchObject({
      id: ITEM_ID,
      kind: "skill",
      dirName: "market-01JABCDEF0123456789ABCDEFG",
      name: "same-name",
      description: "Description for same-name",
      skillMd: expect.stringContaining("name: same-name"),
      content: expect.stringContaining("# same-name"),
    });
    expect(normalized?.digest).toBe(item.digest);
  });

  it("rechecks the exact raw digest and strict Skill envelope", () => {
    const item = marketSkillPackage();
    expect(normalizeManagedMarketSkillPackage({ ...item, raw: `${item.raw} ` })).toBeNull();
    expect(normalizeManagedMarketSkillPackage({ ...item, digest: "A".repeat(64) })).toBeNull();
    expect(normalizeManagedMarketSkillPackage({
      ...item,
      kind: "expert" as unknown as "skill",
    })).toBeNull();

    const malformed = JSON.parse(item.raw) as Record<string, unknown>;
    malformed.payload = {
      name: "same-name",
      description: "Description for same-name",
      skill_md: "# no front matter",
    };
    const malformedRaw = canonicalJson(malformed);
    expect(normalizeManagedMarketSkillPackage({
      ...item,
      raw: malformedRaw,
      digest: crypto.createHash("sha256").update(malformedRaw, "utf8").digest("hex"),
    })).toBeNull();
  });

  it("derives stable ID-based directories and keeps voluntary market roots separate", () => {
    const first = managedMarketSkillDirectoryName(ITEM_ID);
    const second = enterpriseMarketSkillDirName(OTHER_ITEM_ID);
    expect(first).toBe("market-01JABCDEF0123456789ABCDEFG");
    expect(second).toBe("market-01JABCDEF0123456789ABCDEGH");
    expect(first).not.toBe(second);
    expect(managedMarketSkillDirectoryName("skill:../outside")).toBeNull();
    expect(managedMarketSkillDirectoryName("../outside")).toBeNull();

    const home = path.join(os.tmpdir(), "agenticx-managed-market-test");
    expect(managedMarketSkillsRoot(home)).toBe(
      path.join(home, "skills", "enterprise-market"),
    );
    expect(managedMarketSkillsRoot(home)).not.toBe(voluntaryMarketSkillsRoot(home));
    expect(voluntaryMarketSkillsRoot(home)).toBe(path.join(home, "skills", "market"));
  });

  it("rejects traversal and malformed market ledger rows without touching legacy state", () => {
    const valid = marketSkillPackage();
    const ledger = normalizeManagedMarketSkillLedger({
      [ITEM_ID]: { dirName: managedMarketSkillDirectoryName(ITEM_ID), digest: valid.digest },
      [OTHER_ITEM_ID]: { dirName: "../outside", digest: "b".repeat(64) },
      [STALE_ITEM_ID]: {
        dirName: managedMarketSkillDirectoryName(OTHER_ITEM_ID),
        digest: "c".repeat(64),
      },
      "skill:../../outside": { dirName: "market-outside", digest: "d".repeat(64) },
    });
    expect(ledger).toEqual({
      [ITEM_ID]: { dirName: "market-01JABCDEF0123456789ABCDEFG", digest: valid.digest },
    });
    expect(normalizeManagedMarketSkillLedger(["market-01JABCDEF0123456789ABCDEFG"])).toEqual({});

    const root = path.join(os.tmpdir(), "managed-market-root");
    expect(resolveManagedMarketSkillDirectory(root, "market-01JABCDEF0123456789ABCDEFG")).toBe(
      path.join(root, "market-01JABCDEF0123456789ABCDEFG"),
    );
    expect(resolveManagedMarketSkillDirectory(root, "../outside")).toBeNull();
    expect(resolveManagedMarketSkillDirectory(root, "market-01JABCDEF0123456789ABCDEFG/../../outside")).toBeNull();
    expect(resolveManagedMarketSkillDirectory(root, "market-01JABCDEF0123456789ABCDEFG\\..\\outside")).toBeNull();
  });
});

describe("managed market Skill snapshot planning", () => {
  it("preserves same-digest entries, installs upgrades, and removes missing IDs", () => {
    const first = marketSkillPackage(ITEM_ID, { name: "first-skill" });
    const second = marketSkillPackage(OTHER_ITEM_ID, { name: "second-skill" });
    const upgrade = marketSkillPackage(OTHER_ITEM_ID, {
      name: "second-skill",
      version: "1.1.0",
      body: "---\nname: second-skill\ndescription: Description for second-skill\n---\n\n# upgraded\n",
    });
    const stale = marketSkillPackage(STALE_ITEM_ID, { name: "stale-skill" });
    const plan = planManagedMarketSkills(
      [first, upgrade],
      ledgerFor(first, second, stale),
    );

    expect(plan.ok).toBe(true);
    expect(plan.preserve).toEqual([managedMarketSkillDirectoryName(ITEM_ID)]);
    expect(plan.install.map((item) => item.id)).toEqual([OTHER_ITEM_ID]);
    expect(plan.remove).toEqual([managedMarketSkillDirectoryName(STALE_ITEM_ID)]);
    expect(plan.managedSkillLedger).toEqual(ledgerFor(first, upgrade));
    expect(plan.install[0]?.name).toBe("second-skill");
  });

  it("rejects different market items with the same runtime Skill name", () => {
    const first = marketSkillPackage(ITEM_ID, { name: "same-name" });
    const second = marketSkillPackage(OTHER_ITEM_ID, { name: "same-name" });
    const plan = planManagedMarketSkills([first, second], {});

    expect(plan.ok).toBe(false);
    expect(plan.install).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.rejected).toContain("package[1]_name_duplicate");
  });

  it("installs distinct names into stable item-ID directories", () => {
    const first = marketSkillPackage(ITEM_ID, { name: "first-skill" });
    const second = marketSkillPackage(OTHER_ITEM_ID, { name: "second-skill" });
    const plan = planManagedMarketSkills([first, second], {});

    expect(plan.install.map((item) => item.dirName)).toEqual([
      "market-01JABCDEF0123456789ABCDEFG",
      "market-01JABCDEF0123456789ABCDEGH",
    ]);
  });

  it("fails closed for a partial or duplicate snapshot and preserves the LKG", () => {
    const current = marketSkillPackage();
    const previous = ledgerFor(current);
    const invalid = planManagedMarketSkills(
      [current, { ...current, raw: "not-json" }],
      previous,
    );
    expect(invalid).toMatchObject({ ok: false, valid: false, install: [], remove: [] });
    expect(invalid.preserve).toEqual([managedMarketSkillDirectoryName(ITEM_ID)]);
    expect(invalid.managedSkillLedger).toEqual(previous);

    const duplicate = planManagedMarketSkills([current, current], previous);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.install).toEqual([]);
    expect(duplicate.remove).toEqual([]);
    expect(duplicate.preserve).toEqual([managedMarketSkillDirectoryName(ITEM_ID)]);
    expect(planManagedMarketSkills("not-a-snapshot", previous).remove).toEqual([]);
  });

  it("treats an explicit empty snapshot as revoke and supports exit cleanup", () => {
    const first = marketSkillPackage(ITEM_ID);
    const second = marketSkillPackage(OTHER_ITEM_ID);
    const previous = ledgerFor(first, second);
    const revoke = planManagedMarketSkills([], previous);
    expect(revoke.ok).toBe(true);
    expect(revoke.install).toEqual([]);
    expect(revoke.preserve).toEqual([]);
    expect(revoke.remove).toEqual([
      managedMarketSkillDirectoryName(ITEM_ID),
      managedMarketSkillDirectoryName(OTHER_ITEM_ID),
    ]);
    expect(planManagedMarketSkillExit(previous)).toMatchObject({
      ok: true,
      install: [],
      preserve: [],
      remove: revoke.remove,
    });
  });
});

describe("managed market Skill durable transactions", () => {
  it("keeps an LKG through rollback and commits only after index confirmation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-market-skills-"));
    temporaryRoots.push(root);
    const dirName = managedMarketSkillDirectoryName(ITEM_ID)!;

    writeManagedMarketSkillDirectory(root, dirName, "last-known-good");
    const candidate = stageManagedMarketSkillDirectory(root, dirName, "candidate");
    expect(fs.readFileSync(path.join(root, dirName, "SKILL.md"), "utf8")).toBe("candidate");
    expect(candidate.backupDir).toBeTruthy();
    candidate.rollback();
    expect(fs.readFileSync(path.join(root, dirName, "SKILL.md"), "utf8")).toBe("last-known-good");

    const upgrade = stageManagedMarketSkillDirectory(root, dirName, "upgrade");
    const settled = settleManagedMarketSkillDirectoryTransactions(
      new Map([[ITEM_ID, upgrade]]),
      true,
      new Set([ITEM_ID]),
    );
    expect(settled).toMatchObject({ committed: [ITEM_ID], rolledBack: [], errors: [] });
    expect(fs.readFileSync(path.join(root, dirName, "SKILL.md"), "utf8")).toBe("upgrade");
    expect(fs.existsSync(path.join(root, dirName, ".near-managed-pending"))).toBe(false);
  });

  it("does not promote a first install when the index refresh fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-market-skills-"));
    temporaryRoots.push(root);
    const dirName = managedMarketSkillDirectoryName(ITEM_ID)!;
    const transaction = stageManagedMarketSkillDirectory(root, dirName, "candidate");
    const settled = settleManagedMarketSkillDirectoryTransactions(
      new Map([[ITEM_ID, transaction]]),
      false,
    );
    expect(settled).toMatchObject({ committed: [], rolledBack: [ITEM_ID], errors: [] });
    expect(fs.existsSync(path.join(root, dirName))).toBe(false);
  });

  it("recovers an interrupted candidate and only removes marked managed directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-market-skills-"));
    temporaryRoots.push(root);
    const dirName = managedMarketSkillDirectoryName(ITEM_ID)!;
    writeManagedMarketSkillDirectory(root, dirName, "last-known-good");
    stageManagedMarketSkillDirectory(root, dirName, "interrupted");
    // A fresh process can use the stable backup slot to restore the LKG.
    expect(fs.existsSync(path.join(root, dirName, ".near-managed-pending"))).toBe(true);
    // Calling stage again performs recovery before creating a new candidate.
    const retry = stageManagedMarketSkillDirectory(root, dirName, "retry");
    retry.rollback();
    expect(fs.readFileSync(path.join(root, dirName, "SKILL.md"), "utf8")).toBe("last-known-good");

    const unmarked = path.join(root, dirName);
    fs.rmSync(unmarked, { recursive: true, force: true });
    fs.mkdirSync(unmarked, { recursive: true });
    fs.writeFileSync(path.join(unmarked, "SKILL.md"), "user-owned");
    expect(() => removeManagedMarketSkillDirectory(root, dirName)).toThrow(/未标记/);
    expect(fs.readFileSync(path.join(unmarked, "SKILL.md"), "utf8")).toBe("user-owned");

    // The voluntary market root is never a target of this namespace helper.
    const voluntaryRoot = voluntaryMarketSkillsRoot(root);
    const voluntaryDir = path.join(voluntaryRoot, "same-name");
    fs.mkdirSync(voluntaryDir, { recursive: true });
    fs.writeFileSync(path.join(voluntaryDir, "SKILL.md"), "voluntary");
    expect(removeManagedMarketSkillDirectory(root, "market-01JABCDEF0123456789ABCDEGH")).toBe(false);
    expect(fs.existsSync(path.join(voluntaryDir, "SKILL.md"))).toBe(true);
  });
});
