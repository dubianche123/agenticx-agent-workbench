import type { CapabilityChoice } from "./capability-pack-form";

export type ConfigMarketKind = "expert" | "group" | "skill";
export type ConfigMarketStatus = "published" | "unlisted";
export type ConfigMarketDeliveryState = "active" | "revoked";
export type ConfigMarketAction = "unlist" | "restore" | "revoke_delivery" | "restore_delivery";
export type ConfigMarketVisibility = "company" | "departments" | "users" | "personal" | "admins_only";

/** 管理端企业专家/群聊货架的稳定传输结构。 */
export type ConfigMarketItem = {
  id: string;
  capabilityId: string;
  kind: ConfigMarketKind;
  title: string;
  description: string;
  ownerUserId: string;
  ownerDisplayName: string;
  visibility: ConfigMarketVisibility;
  visibleDepartmentIds: string[];
  visibleUserIds: string[];
  status: ConfigMarketStatus;
  /** Independent from listing visibility: revoke stops managed delivery immediately. */
  deliveryState?: ConfigMarketDeliveryState;
  releaseId: string;
  version: string;
  /** Number of successful, unique account/version downloads reported by the server. */
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ConfigMarketPromptMember = {
  name: string;
  role: string;
  systemPrompt: string;
};

export type ConfigMarketPromptPreview =
  | ({ kind: "expert" } & ConfigMarketPromptMember)
  | {
      kind: "group";
      hostMemberIndex: number;
      members: ConfigMarketPromptMember[];
    }
  | {
      kind: "skill";
      name: string;
      description: string;
      skillMd: string;
      checkResult: {
        status: "passed" | "needs_review" | "failed";
        findings: string[];
        frontMatter: { name: string | null; description: string | null };
      };
    };

export type ConfigMarketItemDetail = {
  item: ConfigMarketItem;
  promptPreview: ConfigMarketPromptPreview;
  runtimeReview: {
    recommendedPermissionMode: "plan" | "ask" | "auto";
    expertPermissions: Array<{
      name: string;
      defaultPermissionMode: "plan" | "ask" | "auto";
    }>;
    dependencies: Array<{
      kind: "skill" | "mcp";
      capabilityId: string;
      version: string;
      digest: string | null;
      required: boolean;
    }>;
    resources: Array<{ path: string; content: string; digest: string }>;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseItem(value: unknown): ConfigMarketItem | null {
  const item = asRecord(value);
  if (!item) return null;
  const kind = item.kind;
  const status = item.status;
  const visibility = item.visibility;
  if (kind !== "expert" && kind !== "group" && kind !== "skill") return null;
  if (status !== "published" && status !== "unlisted") return null;
  if (
    visibility !== "company" &&
    visibility !== "departments" &&
    visibility !== "users" &&
    visibility !== "personal" &&
    visibility !== "admins_only"
  ) return null;

  const deliveryState = item.deliveryState === undefined ? "active" : item.deliveryState;
  if (deliveryState !== "active" && deliveryState !== "revoked") return null;

  const requiredStrings = [
    "id",
    "capabilityId",
    "title",
    "description",
    "ownerUserId",
    "ownerDisplayName",
    "releaseId",
    "version",
    "createdAt",
    "updatedAt",
  ] as const;
  if (requiredStrings.some((key) => typeof item[key] !== "string")) return null;

  const capabilityId = item.capabilityId as string;
  // capabilityId 由服务端生成。这里仅防止错误 kind 混入另一栏；不要在前端重新拼 ID。
  if (!capabilityId.startsWith(`${kind}:`) || capabilityId.length <= kind.length + 1) return null;
  const visibleDepartmentIds = Array.isArray(item.visibleDepartmentIds)
    ? item.visibleDepartmentIds.filter((id): id is string => typeof id === "string")
    : [];
  const visibleUserIds = Array.isArray(item.visibleUserIds)
    ? item.visibleUserIds.filter((id): id is string => typeof id === "string")
    : [];
  if (
    ((visibility === "company" || visibility === "admins_only") && (visibleDepartmentIds.length > 0 || visibleUserIds.length > 0)) ||
    (visibility === "personal" && (visibleDepartmentIds.length > 0 || visibleUserIds.length > 0)) ||
    (visibility === "departments" && (visibleDepartmentIds.length === 0 || visibleUserIds.length > 0)) ||
    (visibility === "users" && (visibleUserIds.length === 0 || visibleDepartmentIds.length > 0))
  ) {
    return null;
  }
  if (!Number.isSafeInteger(item.downloadCount) || (item.downloadCount as number) < 0) return null;

  return {
    id: item.id as string,
    capabilityId,
    kind,
    title: item.title as string,
    description: item.description as string,
    ownerUserId: item.ownerUserId as string,
    ownerDisplayName: item.ownerDisplayName as string,
    visibility,
    visibleDepartmentIds: [...new Set(visibleDepartmentIds)],
    visibleUserIds: [...new Set(visibleUserIds)],
    status,
    ...(item.deliveryState === undefined ? {} : { deliveryState }),
    releaseId: item.releaseId as string,
    version: item.version as string,
    downloadCount: item.downloadCount as number,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

export function configMarketVisibilityLabel(item: ConfigMarketItem): string {
  if (item.visibility === "personal") return "仅自己";
  if (item.visibility === "departments") {
    return `指定部门（${item.visibleDepartmentIds.length}）`;
  }
  if (item.visibility === "users") return `指定同事（${item.visibleUserIds.length}）`;
  if (item.visibility === "admins_only") return "仅管理员";
  return "全公司";
}

function parsePromptMember(value: unknown): ConfigMarketPromptMember | null {
  const member = asRecord(value);
  if (
    !member ||
    typeof member.name !== "string" ||
    typeof member.role !== "string" ||
    typeof member.systemPrompt !== "string"
  ) {
    return null;
  }
  return {
    name: member.name,
    role: member.role,
    systemPrompt: member.systemPrompt,
  };
}

/** 读取管理员核对弹窗所需的完整提示词；格式异常时拒绝选择，不做宽松降级。 */
export function configMarketDetailFromPayload(payload: unknown): ConfigMarketItemDetail | null {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const item = parseItem(data?.item);
  const preview = asRecord(data?.promptPreview);
  const runtime = asRecord(data?.runtimeReview);
  const permission = runtime?.recommendedPermissionMode;
  const expertPermissions = Array.isArray(runtime?.expertPermissions)
    ? runtime.expertPermissions.map((value) => {
        const expert = asRecord(value);
        const defaultPermissionMode = expert?.defaultPermissionMode;
        if (
          !expert ||
          typeof expert.name !== "string" ||
          !expert.name.trim() ||
          (defaultPermissionMode !== "plan" && defaultPermissionMode !== "ask" && defaultPermissionMode !== "auto")
        ) return null;
        return { name: expert.name, defaultPermissionMode };
      })
    : [];
  if (
    !item ||
    !preview ||
    preview.kind !== item.kind ||
    !runtime ||
    (permission !== "plan" && permission !== "ask" && permission !== "auto") ||
    (item.kind !== "skill" && expertPermissions.length === 0) ||
    expertPermissions.some((value) => value === null) ||
    !Array.isArray(runtime.dependencies) ||
    !Array.isArray(runtime.resources)
  ) return null;
  const dependencies = runtime.dependencies.map((value) => {
    const dependency = asRecord(value);
    if (
      !dependency ||
      (dependency.kind !== "skill" && dependency.kind !== "mcp") ||
      typeof dependency.capabilityId !== "string" ||
      typeof dependency.version !== "string" ||
      (dependency.digest !== null && typeof dependency.digest !== "string") ||
      typeof dependency.required !== "boolean"
    ) return null;
    return {
      kind: dependency.kind,
      capabilityId: dependency.capabilityId,
      version: dependency.version,
      digest: dependency.digest,
      required: dependency.required,
    };
  });
  const resources = runtime.resources.map((value) => {
    const resource = asRecord(value);
    if (
      !resource ||
      typeof resource.path !== "string" ||
      typeof resource.content !== "string" ||
      typeof resource.digest !== "string"
    ) return null;
    return { path: resource.path, content: resource.content, digest: resource.digest };
  });
  if (dependencies.some((value) => value === null) || resources.some((value) => value === null)) {
    return null;
  }
  const runtimeReview: ConfigMarketItemDetail["runtimeReview"] = {
    recommendedPermissionMode: permission,
    expertPermissions: expertPermissions as ConfigMarketItemDetail["runtimeReview"]["expertPermissions"],
    dependencies: dependencies as ConfigMarketItemDetail["runtimeReview"]["dependencies"],
    resources: resources as ConfigMarketItemDetail["runtimeReview"]["resources"],
  };

  if (preview.kind === "expert") {
    const member = parsePromptMember(preview);
    return member ? { item, promptPreview: { kind: "expert", ...member }, runtimeReview } : null;
  }
  if (preview.kind === "skill") {
    if (
      typeof preview.name !== "string" ||
      typeof preview.description !== "string" ||
      typeof preview.skillMd !== "string" ||
      !asRecord(preview.checkResult)
    ) return null;
    const check = asRecord(preview.checkResult)!;
    const checkStatus = check.status;
    const findings = Array.isArray(check.findings)
      ? check.findings.filter((value): value is string => typeof value === "string")
      : null;
    const frontMatter = asRecord(check.frontMatter);
    if (
      (checkStatus !== "passed" && checkStatus !== "needs_review" && checkStatus !== "failed") ||
      !findings ||
      !frontMatter ||
      (frontMatter.name !== null && typeof frontMatter.name !== "string") ||
      (frontMatter.description !== null && typeof frontMatter.description !== "string")
    ) return null;
    return {
      item,
      promptPreview: {
        kind: "skill",
        name: preview.name,
        description: preview.description,
        skillMd: preview.skillMd,
        checkResult: {
          status: checkStatus,
          findings,
          frontMatter: {
            name: frontMatter.name as string | null,
            description: frontMatter.description as string | null,
          },
        },
      },
      runtimeReview,
    };
  }
  if (
    preview.kind !== "group" ||
    typeof preview.hostMemberIndex !== "number" ||
    !Number.isInteger(preview.hostMemberIndex) ||
    !Array.isArray(preview.members)
  ) {
    return null;
  }
  const members = preview.members.map(parsePromptMember);
  if (
    members.length === 0 ||
    members.some((member) => member === null) ||
    preview.hostMemberIndex < 0 ||
    preview.hostMemberIndex >= members.length
  ) {
    return null;
  }
  return {
    item,
    promptPreview: {
      kind: "group",
      hostMemberIndex: preview.hostMemberIndex,
      members: members as ConfigMarketPromptMember[],
    },
    runtimeReview,
  };
}

/** 只读取当前稳定契约 `{ data: { items } }`；其它结构按格式错误处理。 */
export function configMarketItemsFromPayload(payload: unknown): ConfigMarketItem[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const candidates = data?.items;
  if (!Array.isArray(candidates)) return [];
  return candidates.map(parseItem).filter((item): item is ConfigMarketItem => item !== null);
}

/**
 * Expose both listed and previously listed entries. An unlisted/revoked item
 * must remain discoverable when it is already on the shelf or in a pack so an
 * administrator can inspect and remove it; the disabled flag prevents adding
 * it to a new shelf/package.
 */
export function configMarketCapabilityChoices(
  items: readonly ConfigMarketItem[],
): CapabilityChoice[] {
  return items
    .filter((item) => item.status === "published" || item.status === "unlisted")
    .map((item) => ({
      id: item.capabilityId,
      kind: item.kind,
      name: item.capabilityId,
      displayName: item.title,
      disabled: item.status === "unlisted" || item.deliveryState === "revoked",
      ...(item.kind === "skill" ? { shelfManaged: true } : {}),
      description: [
        item.description,
        `当前版本：v${item.version}`,
        `市场可见：${configMarketVisibilityLabel(item)}；能力包下发范围由管理员另行决定`,
      ].filter(Boolean).join(" · "),
    }));
}

export function configMarketActionForStatus(status: ConfigMarketStatus): ConfigMarketAction {
  return status === "published" ? "unlist" : "restore";
}

export function filterConfigMarketItems(
  items: readonly ConfigMarketItem[],
  status: ConfigMarketStatus | "all",
  query: string,
): ConfigMarketItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (!normalizedQuery) return true;
    return [
      item.title,
      item.description,
      item.ownerDisplayName,
      item.ownerUserId,
      item.capabilityId,
      configMarketVisibilityLabel(item),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}
