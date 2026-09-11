import { NextResponse } from "next/server";
import { listAvailableModelsForUser } from "../../../../lib/admin-providers-reader";
import { buildAttachmentRoutingPolicy } from "../../../../lib/attachment-routing-policy";
import {
  findUnmetSkillDependencies,
  isPlatformFeatureAllowedOnSurface,
  listAvailableCapabilitiesForUser,
} from "../../../../lib/capability-packs-reader";
import { resolveDesktopIdentity } from "../../../../lib/desktop-auth";
import { withGatewayMcpEndpoints } from "../../../../lib/desktop-capability-endpoints";
import { resolveDesktopInferenceApiBase } from "../../../../lib/desktop-inference-base";
import { requestOriginFromRequest } from "../../../../lib/desktop-device-auth";
import { loadDesktopManagedPolicy } from "../../../../lib/desktop-token-policy";
import { listManagedPortablePackagesForUser } from "../../../../lib/config-market/managed";

export async function GET(request: Request) {
  const identity = await resolveDesktopIdentity(request);
  if (!identity) {
    return NextResponse.json(
      { code: "40101", message: "企业登录已失效，请重新登录" },
      { status: 401 },
    );
  }

  const [
    models,
    managedPolicy,
    capabilitySnapshot,
    attachmentRoutingAllowed,
    publicOverrideAllowed,
    managedPortablePackages,
  ] = await Promise.all([
    listAvailableModelsForUser(
      identity.userId,
      identity.email,
      identity.deptId,
    ),
    loadDesktopManagedPolicy(identity.tenantId),
    // 查询成功的 [] 是权威撤回；查询异常则省略字段，让 Desktop 保留同一
    // 稳定身份上一次成功的能力快照，不能把短暂数据库故障伪装成组织撤回。
    listAvailableCapabilitiesForUser(
      identity.tenantId,
      identity.userId,
      identity.email,
      identity.deptId,
      "desktop",
    ).then(
      (value) => ({ ok: true as const, value }),
      (error) => {
        console.error("[desktop/bootstrap] capability query failed:", error);
        return { ok: false as const };
      },
    ),
    // 这里 fail-closed，和 deep_research 的 fail-open 相反：那条要照顾「升级当天不能
    // 静默失效」的存量租户，而附件路由是新功能，没有人在依赖它。查不动时保持原样
    // （不锁模型）比"疑似授权就把会话锁到某个模型"安全得多。
    isPlatformFeatureAllowedOnSurface(
      identity.tenantId,
      "attachment_routing",
      "desktop",
      identity.userId,
      identity.email,
      identity.deptId,
    ).catch(() => false),
    isPlatformFeatureAllowedOnSurface(
      identity.tenantId,
      "attachment_public_override",
      "desktop",
      identity.userId,
      identity.email,
      identity.deptId,
    ).catch(() => false),
    listManagedPortablePackagesForUser({
      tenantId: identity.tenantId,
      userId: identity.userId,
      email: identity.email,
      deptId: identity.deptId,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error) => {
        // Omitting the field means "desired state unknown": Desktop must keep its last-known-good
        // managed packages. A successful [] is different and intentionally means remove all.
        console.error("[desktop/bootstrap] managed portable package query failed:", error);
        return { ok: false as const };
      },
    ),
  ]);
  const attachmentRouting = buildAttachmentRoutingPolicy(models, {
    enabled: attachmentRoutingAllowed,
    allowPublicOverride: publicOverrideAllowed,
  });

  const { tokenLimits: tokenBudget, capabilities: capabilityPolicy } = managedPolicy;

  const origin = requestOriginFromRequest(request);
  const apiBaseUrl = `${origin}/api/desktop/v1`;
  const directEligible = identity.scopes.includes("desktop:managed");

  const data: Record<string, unknown> = {
    user: {
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      tenantId: identity.tenantId,
      deptId: identity.deptId,
    },
    models,
    attachmentRouting,
    policy: { strict: true, tokenBudget, capabilities: capabilityPolicy },
    apiBaseUrl,
    reauthRequiredForDirect: !directEligible,
  };

  if (capabilitySnapshot.ok) {
    const capabilities = withGatewayMcpEndpoints(capabilitySnapshot.value);
    data.capabilities = capabilities;
    // 依赖没随包一起下发时 Desktop 装了也调不通，这里标出来供前端提示。
    data.unmetCapabilityDependencies = findUnmetSkillDependencies(
      capabilitySnapshot.value,
    );
  }

  if (managedPortablePackages.ok) {
    data.managedPortablePackages = managedPortablePackages.value;
  }

  if (directEligible) {
    const inference = resolveDesktopInferenceApiBase({
      configured: process.env.NEXT_PUBLIC_GATEWAY_PUBLIC_BASE_URL,
      nodeEnv: process.env.NODE_ENV,
    });
    if (inference.ok) {
      data.inferenceApiBaseUrl = inference.url;
      data.inferenceTransport = "gateway-direct-v1";
    } else {
      data.reauthRequiredForDirect = true;
    }
  }

  return NextResponse.json({
    code: "00000",
    message: "ok",
    data,
  });
}
