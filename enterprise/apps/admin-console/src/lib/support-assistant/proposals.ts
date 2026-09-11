import { randomUUID } from "node:crypto";
import type { SupportOperation, SupportProposal, StoredProposal } from "./types";

const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const MAX_PROPOSALS = 1_000;

type ProposalEntry = StoredProposal & { locked: boolean };

declare global {
  // eslint-disable-next-line no-var
  var __agenticxAdminSupportProposals: Map<string, ProposalEntry> | undefined;
}

function store(): Map<string, ProposalEntry> {
  return (globalThis.__agenticxAdminSupportProposals ??= new Map());
}

function prune(now = Date.now()): void {
  const entries = store();
  for (const [id, entry] of entries) {
    if (entry.proposal.expiresAt && Date.parse(entry.proposal.expiresAt) <= now) entries.delete(id);
  }
  if (entries.size <= MAX_PROPOSALS) return;
  const oldest = [...entries.values()]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(0, entries.size - MAX_PROPOSALS);
  for (const entry of oldest) entries.delete(entry.proposal.id);
}

export function createSupportProposal(
  operation: SupportOperation,
  input: Omit<SupportProposal, "id" | "expiresAt">,
  now = Date.now(),
): SupportProposal {
  prune(now);
  const proposal: SupportProposal = {
    id: `sap-${randomUUID()}`,
    title: input.title,
    changes: input.changes.map((change) => ({ ...change })),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
  };
  store().set(proposal.id, { proposal, operation, createdAtMs: now, locked: false });
  prune(now);
  return proposal;
}

export class ProposalNotFoundError extends Error {
  public readonly reason = "not_found";
  public constructor() {
    super("support proposal not found or expired");
    this.name = "ProposalNotFoundError";
  }
}

export class ProposalActorMismatchError extends Error {
  public readonly reason = "actor_mismatch";
  public constructor() {
    super("support proposal belongs to another administrator");
    this.name = "ProposalActorMismatchError";
  }
}

export class ProposalBusyError extends Error {
  public readonly reason = "busy";
  public constructor() {
    super("support proposal is already being confirmed");
    this.name = "ProposalBusyError";
  }
}

export async function consumeSupportProposal<T>(
  proposalId: string,
  actor: { tenantId: string; userId: string },
  handler: (operation: SupportOperation, proposal: SupportProposal) => Promise<T>,
): Promise<T> {
  prune();
  const entry = store().get(proposalId);
  if (!entry) throw new ProposalNotFoundError();
  if (entry.operation.tenantId !== actor.tenantId || entry.operation.actorUserId !== actor.userId) {
    throw new ProposalActorMismatchError();
  }
  if (entry.locked) throw new ProposalBusyError();

  // Lock synchronously before the first await so concurrent confirmations
  // cannot enter the handler together. The entry is still present while the
  // first handler runs, allowing the second request to receive a deterministic
  // busy response; it is removed in finally even when the write fails.
  entry.locked = true;
  try {
    return await handler(entry.operation, entry.proposal);
  } finally {
    store().delete(proposalId);
  }
}

export function __resetSupportProposalsForTests(): void {
  store().clear();
}
