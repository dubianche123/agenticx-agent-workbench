import {
  MODEL_CAPABILITY_PRIVATE,
  MODEL_CAPABILITY_VISION,
} from "@agenticx/config";

export type RoutingProviderRoute = "local" | "private-cloud" | "third-party";

export type RoutingAdminModel = {
  name: string;
  label: string;
  enabled: boolean;
  capabilities?: string[];
};

export type RoutingAdminProvider = {
  id: string;
  displayName: string;
  enabled: boolean;
  route: RoutingProviderRoute;
  models: RoutingAdminModel[];
};

export type RoutingCandidate = {
  id: string;
  providerId: string;
  providerLabel: string;
  modelName: string;
  modelLabel: string;
  route: "local";
};

export function isLocalProviderRoute(route: RoutingProviderRoute): route is "local" {
  return route === "local";
}

function hasCapability(model: RoutingAdminModel, capability: string): boolean {
  return (model.capabilities ?? []).some(
    (item) => String(item ?? "").trim().toLowerCase() === capability,
  );
}

/**
 * 与 Portal 下发策略相同：附件原始内容只能路由给启用的本地 provider。
 * provider 的运行位置只在「模型接入」里管理，本页不会把私有云或第三方模型
 * 伪装成本地附件处理器。
 */
export function attachmentRoutingCandidates(
  providers: readonly RoutingAdminProvider[],
): RoutingCandidate[] {
  return providers
    .flatMap((provider) => {
      const route = provider.route;
      if (!provider.enabled || !isLocalProviderRoute(route)) return [];
      return provider.models
        .filter(
          (model) =>
            model.enabled &&
            hasCapability(model, MODEL_CAPABILITY_PRIVATE) &&
            hasCapability(model, MODEL_CAPABILITY_VISION),
        )
        .map((model) => ({
          id: `${provider.id}/${model.name}`,
          providerId: provider.id,
          providerLabel: provider.displayName,
          modelName: model.name,
          modelLabel: model.label || model.name,
          route,
        }));
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * 开关“附件候选”时只维护相关标签：开启同时声明视觉与私有部署；关闭只去掉私有部署，
 * 因为这个模型可能仍然确实支持图片，不应破坏模型本身的能力描述。
 */
export function withAttachmentCandidateState(
  capabilities: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  const next = (capabilities ?? []).filter(
    (item) => String(item).trim().toLowerCase() !== MODEL_CAPABILITY_PRIVATE,
  );
  if (!enabled) return [...new Set(next)];
  if (!next.some((item) => String(item).trim().toLowerCase() === MODEL_CAPABILITY_VISION)) {
    next.push(MODEL_CAPABILITY_VISION);
  }
  next.push(MODEL_CAPABILITY_PRIVATE);
  return [...new Set(next)];
}
