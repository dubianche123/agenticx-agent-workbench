import { NextResponse } from "next/server";
import {
  preflightSkillBundle,
  SkillBundleValidationError,
  validateSkillBundleMetadata,
} from "@agenticx/iam-core";
import { requireAdminScope } from "../../../../../lib/admin-auth";
import { deleteSkill, getSkill, updateSkill } from "../../../../../lib/capability-packs-store";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["provider:read"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const skill = await getSkill(auth.session.tenantId, id);
  if (!skill) return NextResponse.json({ code: "40400", message: "skill not found" }, { status: 404 });
  return NextResponse.json({ code: "00000", message: "ok", data: { skill } });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const existing = await getSkill(auth.session.tenantId, id);
    if (!existing) {
      return NextResponse.json({ code: "40400", message: "skill not found" }, { status: 404 });
    }
    const hasBundleUri = Object.prototype.hasOwnProperty.call(body, "bundleUri");
    const hasBundleDigest = Object.prototype.hasOwnProperty.call(body, "bundleDigest");
    if (hasBundleUri && typeof body.bundleUri !== "string") {
      throw new Error("bundleUri must be a string");
    }
    if (hasBundleDigest && typeof body.bundleDigest !== "string") {
      throw new Error("bundleDigest must be a string");
    }
    // PATCH may update only one half of the pair. Validate the merged value so
    // it cannot leave an unverifiable URI/digest combination in the database.
    const mergedBundleUri = hasBundleUri ? body.bundleUri : existing.bundleUri;
    const mergedBundleDigest = hasBundleDigest ? body.bundleDigest : existing.bundleDigest;
    const bundleChanged =
      (hasBundleUri && body.bundleUri !== existing.bundleUri) ||
      (hasBundleDigest && body.bundleDigest !== existing.bundleDigest);
    let bundle: ReturnType<typeof validateSkillBundleMetadata> = null;
    if (bundleChanged) {
      bundle = validateSkillBundleMetadata(
        {
          bundleUri: mergedBundleUri,
          bundleDigest: mergedBundleDigest,
        },
        { nodeEnv: process.env.NODE_ENV },
      );
      if (bundle) {
        await preflightSkillBundle(bundle, { nodeEnv: process.env.NODE_ENV });
      }
    }
    const skill = await updateSkill(auth.session.tenantId, id, {
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      ...(hasBundleUri || hasBundleDigest
        ? {
            bundleUri: bundle?.bundleUri ?? String(mergedBundleUri ?? ""),
            bundleDigest: bundle?.bundleDigest ?? String(mergedBundleDigest ?? ""),
          }
        : {}),
      requiredCapabilities: Array.isArray(body.requiredCapabilities)
        ? (body.requiredCapabilities as string[])
        : undefined,
      status: body.status === "active" || body.status === "disabled" ? body.status : undefined,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: { skill } });
  } catch (error) {
    if (error instanceof SkillBundleValidationError) {
      return NextResponse.json(
        {
          code: `SKILL_BUNDLE_${error.code.toUpperCase()}`,
          message: error.message,
        },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : "update failed";
    const status = message === "skill not found" ? 404 : 400;
    return NextResponse.json({ code: status === 404 ? "40400" : "40000", message }, { status });
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminScope(["provider:update"]);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const removed = await deleteSkill(auth.session.tenantId, id);
  if (!removed) return NextResponse.json({ code: "40400", message: "skill not found" }, { status: 404 });
  return NextResponse.json({ code: "00000", message: "ok", data: { id } });
}
