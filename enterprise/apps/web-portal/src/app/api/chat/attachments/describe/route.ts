import { modelSupportsVision } from "@agenticx/config";
import { NextResponse } from "next/server";
import { ulid } from "ulid";

import { listAvailableModelsForUser } from "../../../../../lib/admin-providers-reader";
import { buildAttachmentRoutingPolicy } from "../../../../../lib/attachment-routing-policy";
import {
  defaultOriginalStore,
  MAX_ORIGINAL_RETAIN_BYTES,
} from "../../../../../lib/attachments/original-store";
import { isPlatformFeatureAllowedOnSurface } from "../../../../../lib/capability-packs-reader";
import {
  describeImages,
  MAX_AUTO_DESCRIBED_IMAGES,
  MAX_IMAGE_DATA_URL_CHARS,
} from "../../../../../lib/image-understanding";
import {
  getSessionAuthFromCookies,
  passwordChangeRequiredResponse,
} from "../../../../../lib/session";

export const runtime = "nodejs";

const GATEWAY_COMPLETIONS_URL =
  process.env.GATEWAY_COMPLETIONS_URL ?? "http://127.0.0.1:8088/v1/chat/completions";

function resolveRequestedModel<T extends { id: string }>(
  models: readonly T[],
  requested: string,
): T | null {
  const exact = models.find((model) => model.id === requested);
  if (exact) return exact;
  if (requested.includes("/")) return null;
  const matches = models.filter(
    (model) => model.id.split("/").slice(1).join("/") === requested,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export async function POST(request: Request) {
  const auth = await getSessionAuthFromCookies();
  if (!auth) {
    return NextResponse.json({ error: { code: "40101", message: "unauthorized" } }, { status: 401 });
  }
  if (auth.session.mustChangePassword) return passwordChangeRequiredResponse();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: { code: "40001", message: "invalid multipart body" } },
      { status: 400 },
    );
  }

  const requestedModel = String(form.get("model") ?? "").trim();
  const files = form.getAll("files").filter((item): item is File => item instanceof File);
  if (!requestedModel) {
    return NextResponse.json({ error: { code: "40001", message: "model required" } }, { status: 400 });
  }
  if (files.length === 0) {
    return NextResponse.json({ error: { code: "40001", message: "files required" } }, { status: 400 });
  }
  if (files.length > MAX_AUTO_DESCRIBED_IMAGES) {
    return NextResponse.json(
      {
        error: {
          code: "40001",
          message: `纯文本模型单轮最多自动解析 ${MAX_AUTO_DESCRIBED_IMAGES} 张图片`,
        },
      },
      { status: 400 },
    );
  }

  const { session, accessToken } = auth;
  let models: Awaited<ReturnType<typeof listAvailableModelsForUser>>;
  try {
    models = await listAvailableModelsForUser(session.userId, session.email, session.deptId);
  } catch {
    return NextResponse.json(
      { error: { code: "50302", message: "模型权限暂时无法校验，请稍后重试" } },
      { status: 503 },
    );
  }

  const target = resolveRequestedModel(models, requestedModel);
  if (!target) {
    return NextResponse.json(
      {
        error: {
          code: "40301",
          message: "该模型已不在您的可见范围内，请刷新页面重新选择模型",
        },
      },
      { status: 403 },
    );
  }
  if (modelSupportsVision(target.provider, target.model, target.capabilities)) {
    return NextResponse.json(
      { error: { code: "40901", message: "当前模型支持原生图片输入，无需预解析" } },
      { status: 409 },
    );
  }

  const routingAllowed = await isPlatformFeatureAllowedOnSurface(
    session.tenantId,
    "attachment_routing",
    "web",
    session.userId,
    session.email,
    session.deptId,
  ).catch(() => false);
  const policy = buildAttachmentRoutingPolicy(models, { enabled: routingAllowed });
  if (!policy.enabled || policy.imageStrategy !== "vision-fallback" || !policy.visionFallback) {
    return NextResponse.json(
      {
        error: {
          code: "40002",
          message: "当前模型不支持图片，且管理员尚未配置可用的私有视觉解析模型",
        },
      },
      { status: 400 },
    );
  }

  const buffers: Buffer[] = [];
  for (const file of files) {
    if (!file.type.toLowerCase().startsWith("image/")) {
      return NextResponse.json(
        { error: { code: "40001", message: `「${file.name}」不是支持的图片类型` } },
        { status: 400 },
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const estimatedDataUrlChars = Math.ceil(buffer.byteLength / 3) * 4 + 64;
    if (estimatedDataUrlChars > MAX_IMAGE_DATA_URL_CHARS) {
      return NextResponse.json(
        { error: { code: "40001", message: `「${file.name}」超过图片解析大小上限` } },
        { status: 400 },
      );
    }
    buffers.push(buffer);
  }

  const traceId = request.headers.get("x-agenticx-trace-id")?.trim() || ulid().toLowerCase();
  let descriptions: Awaited<ReturnType<typeof describeImages>>;
  try {
    descriptions = await describeImages(
      files.map((file, index) => ({
        name: file.name || `image-${index + 1}`,
        dataUrl: `data:${file.type};base64,${buffers[index]!.toString("base64")}`,
      })),
      {
        gatewayUrl: GATEWAY_COMPLETIONS_URL,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "x-tenant-id": session.tenantId,
          "x-user-id": session.userId,
          "x-dept-id": session.deptId ?? "",
          "x-user-email": session.email,
          "x-session-id": session.sessionId,
          "x-agenticx-trace-id": traceId,
          "x-agenticx-trace-step": "1",
        },
        fallback: policy.visionFallback,
        signal: request.signal,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "图片解析失败";
    return NextResponse.json(
      { error: { code: "50201", message }, trace_id: traceId },
      { status: 502, headers: { "x-agenticx-trace-id": traceId } },
    );
  }

  const attachments = await Promise.all(
    descriptions.map(async (description, index) => {
      const file = files[index]!;
      const buffer = buffers[index]!;
      let attachmentId: string | undefined;
      if (MAX_ORIGINAL_RETAIN_BYTES > 0 && buffer.byteLength <= MAX_ORIGINAL_RETAIN_BYTES) {
        try {
          const stored = await defaultOriginalStore.put({
            tenantId: session.tenantId,
            userId: session.userId,
            fileName: file.name || description.name,
            mimeType: file.type,
            kind: "image",
            buffer,
          });
          attachmentId = stored.id;
        } catch (error) {
          console.warn(
            "[attachments/describe] original retain failed:",
            error instanceof Error ? error.message : error,
          );
        }
      }
      return {
        name: file.name || description.name,
        mime_type: file.type,
        kind: "image" as const,
        parsed_text: description.contextText,
        size: file.size,
        parse_mode: description.mode,
        ...(attachmentId ? { attachment_id: attachmentId } : {}),
      };
    }),
  );

  return NextResponse.json(
    { code: "00000", message: "ok", data: { attachments } },
    { headers: { "x-agenticx-trace-id": traceId } },
  );
}
