import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDesktopAgxHome } from "./desktop-paths";

import {
  PORTABLE_MARKET_PACKAGE_MAX_BYTES,
  normalizePortablePackagePublication,
} from "./portable-market";
import {
  commitManagedSkillDirectory,
  recoverInterruptedManagedSkillDirectory as recoverManagedSkillDirectory,
  rollbackManagedSkillDirectory,
  settleManagedSkillDirectoryTransactions,
  stageManagedSkillDirectory,
  type ManagedSkillDirectorySettlementResult,
  type ManagedSkillDirectoryTransaction,
} from "./enterprise-capability-sync";

/**
 * Market Skills delivered by an enterprise capability pack have a namespace
 * of their own.  In particular, this must not be confused with the voluntary
 * `$AGX_HOME/skills/market` directory or the legacy
 * `enterprise.managed_skills` list.
 */
export const MANAGED_MARKET_SKILL_GROUP = "enterprise-market" as const;
export const VOLUNTARY_MARKET_SKILL_GROUP = "market" as const;
export const MANAGED_MARKET_SKILL_DIRECTORY_PREFIX = "market-" as const;
export const MANAGED_MARKET_SKILL_MARKER = ".near-managed" as const;
export const MANAGED_MARKET_SKILL_PENDING_MARKER = ".near-managed-pending" as const;
export const MANAGED_MARKET_SKILL_CONTENT_MAX_BYTES = 128 * 1024;

const MARKET_ULID = "[0-9A-HJKMNP-TV-Z]{26}";
export const MANAGED_MARKET_SKILL_ID_RE = new RegExp(`^skill:${MARKET_ULID}$`, "u");
export const MANAGED_MARKET_SKILL_DIRECTORY_RE = new RegExp(
  `^${MANAGED_MARKET_SKILL_DIRECTORY_PREFIX}${MARKET_ULID}$`,
  "u",
);
export const MANAGED_MARKET_SKILL_DIGEST_RE = /^[a-f0-9]{64}$/iu;

/** Compatibility spellings used by the Electron capability-sync code. */
export const ENTERPRISE_MARKET_SKILL_GROUP = MANAGED_MARKET_SKILL_GROUP;
export const ENTERPRISE_MARKET_SKILL_DIR_RE = MANAGED_MARKET_SKILL_DIRECTORY_RE;

export type ManagedMarketSkillPackage = {
  /** `skill:<market-item-ulid>`; the outer package may omit `kind`. */
  id: string;
  digest: string;
  /** The exact canonical JSON string whose SHA-256 is `digest`. */
  raw: string;
  kind?: "skill";
  title?: string;
};

export type NormalizedManagedMarketSkillPackage = {
  id: string;
  kind: "skill";
  digest: string;
  raw: string;
  dirName: string;
  name: string;
  description: string;
  skillMd: string;
  /** Alias for the existing managed-Skill transaction helper. */
  content: string;
};

export type ManagedMarketSkillLedgerEntry = {
  dirName: string;
  digest: string;
};

/**
 * This is deliberately a different type/shape from `enterprise.managed_skills`.
 * The latter is a legacy array of derived directory names; this ledger is
 * keyed by the immutable market item ID and records the verified digest.
 */
export type ManagedMarketSkillLedger = Record<string, ManagedMarketSkillLedgerEntry>;

export type ManagedMarketSkillSnapshot = {
  /** False means no part of the snapshot is actionable. */
  valid: boolean;
  packages: NormalizedManagedMarketSkillPackage[];
  rejected: string[];
};

export type ManagedMarketSkillPlan = {
  ok: boolean;
  /** Alias for callers that describe the result as snapshot validity. */
  valid: boolean;
  /** New installs and digest-changing upgrades. */
  install: NormalizedManagedMarketSkillPackage[];
  /** Existing item directories whose ledger digest is unchanged. */
  preserve: string[];
  /** Previous managed item directories absent from an authoritative snapshot. */
  remove: string[];
  /** The desired normalized packages, or null for a rejected snapshot. */
  desired: NormalizedManagedMarketSkillPackage[] | null;
  /** Last-known-good ledger to keep when the desired snapshot is invalid. */
  previous: ManagedMarketSkillLedger;
  /** Ledger after a successful application of this plan. */
  ledger: ManagedMarketSkillLedger;
  /** Compatibility spelling used by the existing config field. */
  managedSkillLedger: ManagedMarketSkillLedger;
  rejected: string[];
  /** Compatibility spelling with the older capability planner. */
  skipped: string[];
};

export type ManagedMarketSkillLedgerNormalization = {
  ledger: ManagedMarketSkillLedger;
  rejected: string[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneLedger(value: ManagedMarketSkillLedger): ManagedMarketSkillLedger {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, entry]) => [id, { ...entry }]),
  );
}

/** Return the canonical market capability ID, or null for any other ID. */
export function normalizeManagedMarketSkillId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return MANAGED_MARKET_SKILL_ID_RE.test(id) ? id : null;
}

/**
 * Derive a directory solely from the immutable item ID.  Display names are
 * intentionally not involved, so two items called `research` cannot collide.
 */
export function managedMarketSkillDirectoryName(capabilityId: unknown): string | null {
  const id = normalizeManagedMarketSkillId(capabilityId);
  return id ? `${MANAGED_MARKET_SKILL_DIRECTORY_PREFIX}${id.slice("skill:".length)}` : null;
}

/** Compatibility aliases for the existing enterprise naming convention. */
export const enterpriseMarketSkillDirectoryName = managedMarketSkillDirectoryName;
export const enterpriseMarketSkillDirName = managedMarketSkillDirectoryName;

export function isSafeManagedMarketSkillDirectoryName(value: unknown): value is string {
  return typeof value === "string" && MANAGED_MARKET_SKILL_DIRECTORY_RE.test(value);
}

/** Compatibility alias used by ledger/path callers. */
export const isSafeEnterpriseMarketSkillDirectoryName = isSafeManagedMarketSkillDirectoryName;

/**
 * Return the dedicated enterprise root.  `agenticxRoot` is injectable for
 * tests and for callers that already resolved the user's config root.
 */
export function managedMarketSkillsRoot(
  agenticxRoot = resolveDesktopAgxHome(),
): string {
  return path.resolve(agenticxRoot, "skills", MANAGED_MARKET_SKILL_GROUP);
}

export const enterpriseMarketSkillsRoot = managedMarketSkillsRoot;

/** Useful in tests/documentation to make the two lifecycle roots explicit. */
export function voluntaryMarketSkillsRoot(
  agenticxRoot = resolveDesktopAgxHome(),
): string {
  return path.resolve(agenticxRoot, "skills", VOLUNTARY_MARKET_SKILL_GROUP);
}

/**
 * Resolve only a safe child of the caller-provided managed root.  This is a
 * lexical containment check; filesystem transactions additionally reject
 * unmarked/symlinked targets before replacing or removing anything.
 */
export function resolveManagedMarketSkillDirectory(
  root: unknown,
  dirName: unknown,
): string | null {
  if (typeof root !== "string" || !root.trim() || !isSafeManagedMarketSkillDirectoryName(dirName)) {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(resolvedRoot, dirName);
  const relative = path.relative(resolvedRoot, resolvedChild);
  return relative
    && relative !== "."
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    ? resolvedChild
    : null;
}

/** Compatibility alias; it is intentionally not the legacy Skill resolver. */
export const resolveEnterpriseMarketSkillDirectory = resolveManagedMarketSkillDirectory;

function normalizeDigest(value: unknown): string | null {
  const digest = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MANAGED_MARKET_SKILL_DIGEST_RE.test(digest) ? digest : null;
}

/**
 * Parse and verify one market Skill package.  The server/bootstrap layer also
 * checks the envelope digest, but this helper repeats the check at the disk
 * boundary so callers cannot accidentally bypass it when reusing this code.
 */
export function normalizeManagedMarketSkillPackage(
  value: unknown,
): NormalizedManagedMarketSkillPackage | null {
  if (!isPlainRecord(value)) return null;
  const id = normalizeManagedMarketSkillId(value.id);
  const digest = normalizeDigest(value.digest);
  const raw = typeof value.raw === "string" ? value.raw : null;
  if (!id || !digest || raw === null || !raw || Buffer.byteLength(raw, "utf8") > PORTABLE_MARKET_PACKAGE_MAX_BYTES) {
    return null;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "kind")
    && value.kind !== "skill"
  ) {
    return null;
  }
  const actualDigest = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  if (actualDigest !== digest) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // `id` is the market item/capability-pack identity.  The envelope's
  // `artifact_id` is the publisher-owned source artifact identity and may be
  // different (for example, a market item can point at a release of an
  // artifact).  The portable normalizer validates that source identity's
  // shape; do not conflate the two IDs here.
  const publication = normalizePortablePackagePublication(parsed, "skill");
  if (!publication) return null;
  const payload = isPlainRecord(publication.manifest.payload)
    ? publication.manifest.payload
    : null;
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const description = typeof payload?.description === "string"
    ? payload.description.trim()
    : "";
  const skillMd = typeof payload?.skill_md === "string" ? payload.skill_md : "";
  if (
    !name
    || !description
    || !skillMd.trim()
    || Buffer.byteLength(skillMd, "utf8") > MANAGED_MARKET_SKILL_CONTENT_MAX_BYTES
  ) {
    return null;
  }
  const dirName = managedMarketSkillDirectoryName(id);
  if (!dirName) return null;
  return {
    id,
    kind: "skill",
    digest,
    raw,
    dirName,
    name,
    description,
    skillMd,
    content: skillMd,
  };
}

/**
 * Normalize a ledger with path and ID binding.  Invalid rows are ignored and
 * never become paths to touch.  In particular, an array-shaped legacy
 * `enterprise.managed_skills` value is not interpreted as this ledger.
 */
export function normalizeManagedMarketSkillLedger(
  value: unknown,
): ManagedMarketSkillLedger {
  return normalizeManagedMarketSkillLedgerDetailed(value).ledger;
}

export function normalizeManagedMarketSkillLedgerDetailed(
  value: unknown,
): ManagedMarketSkillLedgerNormalization {
  if (!isPlainRecord(value)) return { ledger: {}, rejected: [] };
  const entries: Array<[string, ManagedMarketSkillLedgerEntry]> = [];
  const rejected: string[] = [];
  for (const [rawId, rawEntry] of Object.entries(value)) {
    const id = normalizeManagedMarketSkillId(rawId);
    if (!id || !isPlainRecord(rawEntry)) {
      rejected.push(rawId);
      continue;
    }
    const digest = normalizeDigest(rawEntry.digest);
    const expectedDirName = managedMarketSkillDirectoryName(id);
    const dirName = typeof rawEntry.dirName === "string" ? rawEntry.dirName.trim() : "";
    if (!digest || !expectedDirName || dirName !== expectedDirName) {
      rejected.push(rawId);
      continue;
    }
    entries.push([id, { dirName: expectedDirName, digest }]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return { ledger: Object.fromEntries(entries), rejected };
}

/**
 * Parse the complete desired set atomically.  A single malformed or duplicate
 * row invalidates the whole snapshot; callers must then retain their LKG and
 * perform neither installs nor revocations.
 */
export function normalizeManagedMarketSkillSnapshot(
  value: unknown,
): ManagedMarketSkillSnapshot {
  if (!Array.isArray(value)) {
    return { valid: false, packages: [], rejected: ["snapshot_not_array"] };
  }
  const packages: NormalizedManagedMarketSkillPackage[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  value.forEach((candidate, index) => {
    const normalized = normalizeManagedMarketSkillPackage(candidate);
    if (!normalized) {
      rejected.push(`package[${index}]_invalid`);
      return;
    }
    if (seen.has(normalized.id)) {
      rejected.push(`package[${index}]_duplicate`);
      return;
    }
    if (seenNames.has(normalized.name)) {
      // Skill invocation is name-addressed. Separate item-ID directories avoid
      // filesystem collisions, but cannot make two active Skills with the same
      // front-matter name deterministic; reject the complete desired snapshot.
      rejected.push(`package[${index}]_name_duplicate`);
      return;
    }
    seen.add(normalized.id);
    seenNames.add(normalized.name);
    packages.push(normalized);
  });
  if (rejected.length > 0) return { valid: false, packages: [], rejected };
  packages.sort((left, right) => left.id.localeCompare(right.id));
  return { valid: true, packages, rejected: [] };
}

/** Return normalized packages only for an authoritative, valid snapshot. */
export function normalizeManagedMarketSkillPackages(
  value: unknown,
): NormalizedManagedMarketSkillPackage[] {
  const snapshot = normalizeManagedMarketSkillSnapshot(value);
  return snapshot.valid ? snapshot.packages : [];
}

function planResult(
  fields: Omit<ManagedMarketSkillPlan, "managedSkillLedger" | "skipped">,
): ManagedMarketSkillPlan {
  const ledger = cloneLedger(fields.ledger);
  return {
    ...fields,
    previous: cloneLedger(fields.previous),
    ledger,
    managedSkillLedger: cloneLedger(ledger),
    skipped: [...fields.rejected],
  };
}

/**
 * Build an install/preserve/remove plan from an entire desired snapshot.
 * Missing IDs in a valid snapshot are authoritative revocations; malformed
 * snapshots are fail-closed and leave all valid previous entries preserved.
 */
export function planManagedMarketSkills(
  desiredSnapshot: unknown,
  previousLedger: unknown,
): ManagedMarketSkillPlan {
  const previous = normalizeManagedMarketSkillLedger(previousLedger);
  const snapshot = normalizeManagedMarketSkillSnapshot(desiredSnapshot);
  if (!snapshot.valid) {
    const preserve = Object.values(previous).map((entry) => entry.dirName).sort();
    return planResult({
      ok: false,
      valid: false,
      install: [],
      preserve,
      remove: [],
      desired: null,
      previous,
      ledger: previous,
      rejected: [...snapshot.rejected],
    });
  }

  const desiredById = new Map(snapshot.packages.map((item) => [item.id, item]));
  const install: NormalizedManagedMarketSkillPackage[] = [];
  const preserve: string[] = [];
  const nextEntries: Array<[string, ManagedMarketSkillLedgerEntry]> = [];
  for (const item of snapshot.packages) {
    const previousEntry = previous[item.id];
    const unchanged = previousEntry
      && previousEntry.dirName === item.dirName
      && previousEntry.digest === item.digest;
    if (unchanged) {
      preserve.push(item.dirName);
    } else {
      install.push(item);
    }
    nextEntries.push([item.id, { dirName: item.dirName, digest: item.digest }]);
  }

  const remove = Object.entries(previous)
    .filter(([id]) => !desiredById.has(id))
    .map(([, entry]) => entry.dirName)
    .sort();
  const ledger = Object.fromEntries(nextEntries);
  return planResult({
    ok: true,
    valid: true,
    install,
    preserve: [...new Set(preserve)].sort(),
    remove: [...new Set(remove)],
    desired: snapshot.packages,
    previous,
    ledger,
    rejected: [],
  });
}

export const planManagedMarketSkillDelivery = planManagedMarketSkills;
export const planManagedMarketSkillReconcile = planManagedMarketSkills;

/** Empty is an authoritative desired snapshot and therefore withdraws all IDs. */
export function planManagedMarketSkillExit(previousLedger: unknown): ManagedMarketSkillPlan {
  return planManagedMarketSkills([], previousLedger);
}

export const planManagedMarketSkillRemoval = planManagedMarketSkillExit;
export const planManagedMarketSkillWithdrawal = planManagedMarketSkillExit;

/**
 * Thin transaction wrappers keep market callers on the dedicated namespace
 * while reusing the durable pending-marker/LKG implementation.  The planner
 * remains pure; these functions are optional disk-application primitives.
 */
export function stageManagedMarketSkillDirectory(
  root: string,
  dirName: string,
  content: string,
): ManagedSkillDirectoryTransaction {
  if (!isSafeManagedMarketSkillDirectoryName(dirName)) {
    throw new Error("市场 Skill 目录名无效");
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("市场 Skill 内容无效");
  }
  if (Buffer.byteLength(content, "utf8") > MANAGED_MARKET_SKILL_CONTENT_MAX_BYTES) {
    throw new Error("市场 Skill 内容超过大小限制");
  }
  return stageManagedSkillDirectory(root, dirName, content);
}

export function recoverInterruptedManagedMarketSkillDirectory(
  root: string,
  dirName: string,
): ReturnType<typeof recoverManagedSkillDirectory> {
  if (!isSafeManagedMarketSkillDirectoryName(dirName)) {
    throw new Error("市场 Skill 目录名无效");
  }
  return recoverManagedSkillDirectory(root, dirName);
}

export const commitManagedMarketSkillDirectory = commitManagedSkillDirectory;
export const rollbackManagedMarketSkillDirectory = rollbackManagedSkillDirectory;
export const settleManagedMarketSkillDirectoryTransactions = settleManagedSkillDirectoryTransactions;
export type ManagedMarketSkillDirectorySettlementResult = ManagedSkillDirectorySettlementResult;
export type ManagedMarketSkillDirectoryTransaction = ManagedSkillDirectoryTransaction;

/** Remove one managed market directory after recovery, never an unmarked user directory. */
export function removeManagedMarketSkillDirectory(root: string, dirName: string): boolean {
  recoverInterruptedManagedMarketSkillDirectory(root, dirName);
  const target = resolveManagedMarketSkillDirectory(root, dirName);
  if (!target || !fs.existsSync(target)) return false;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("检测到非托管市场 Skill 目录，已停止删除");
  }
  if (!fs.existsSync(path.join(target, MANAGED_MARKET_SKILL_MARKER))) {
    throw new Error("检测到未标记市场 Skill 目录，已停止删除");
  }
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

export function writeManagedMarketSkillDirectory(
  root: string,
  dirName: string,
  content: string,
): void {
  const transaction = stageManagedMarketSkillDirectory(root, dirName, content);
  commitManagedMarketSkillDirectory(transaction);
}
