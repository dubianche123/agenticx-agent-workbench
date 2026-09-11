import type { AdminSession } from "../admin-auth";
import type { QuotaConfig, QuotaRule } from "../token-quota-store";
import type {
  SupportBootstrap as SharedSupportBootstrap,
  SupportChatResponse as SharedSupportChatResponse,
  SupportLink as SharedSupportLink,
  SupportMessage as SharedSupportMessage,
  SupportModelOption as SharedSupportModelOption,
  SupportPageContext,
  SupportProposal as SharedSupportProposal,
} from "@agenticx/ui/support/contracts";

// Keep the admin-only operation types local, but use the shared wire types for
// every value that can cross the Portal/admin UI boundary.
export type SupportMessage = SharedSupportMessage;
export type SupportPage = SupportPageContext;
export type SupportProposal = SharedSupportProposal;
export type SupportModelOption = SharedSupportModelOption;
export type SupportBootstrap = SharedSupportBootstrap;
export type SupportLink = SharedSupportLink;
export type SupportChatResponse = SharedSupportChatResponse;
export type SupportReply = SharedSupportChatResponse;

export type SupportActor = Pick<AdminSession, "tenantId" | "userId" | "email"> & {
  /** AdminSession intentionally stays cookie-shaped; inference needs the
   * current department claim to match Gateway policy context. */
  deptId?: string | null;
};

export type EffectiveModelState = {
  tenantId: string;
  userId: string;
  email: string;
  deptId: string | null;
  parentAllowedIds: string[];
  parentLabel: string;
  individualModelIds: string[];
  /** Raw union of the user-id and email aliases, before group filtering. */
  personalAssignmentModelIds?: string[];
  /** Per-alias snapshot so equal unions with different ownership still fail CAS. */
  personalAssignmentModelIdsByKey?: Record<string, string[]>;
  groupModelIds: string[];
  excludedGroupModelIds: string[];
  effectiveModelIds: string[];
};

export type QuotaSnapshot = {
  tenantId: string;
  userId: string;
  updatedAt: string;
  personalRule: QuotaRule | null;
  effectiveRule: QuotaRule | null;
  inherited: boolean;
  source: string;
  roleCode: string;
};

export type SupportOperation =
  | {
      kind: "quota";
      tenantId: string;
      actorUserId: string;
      targetUserId: string;
      expected: {
        updatedAt: string;
        personalRule: QuotaRule | null;
        targetRoleCodes: string[];
        roleCode: string;
        inheritedRule: QuotaRule | null;
      };
      desired: {
        inherit: boolean;
        monthlyTokens?: number;
      };
    }
  | {
      kind: "models";
      tenantId: string;
      actorUserId: string;
      targetUserId: string;
      expected: EffectiveModelState;
      desiredIndividualModelIds: string[];
    };

export type StoredProposal = {
  proposal: SupportProposal;
  operation: SupportOperation;
  createdAtMs: number;
};

export type SupportQuotaConfig = QuotaConfig;
