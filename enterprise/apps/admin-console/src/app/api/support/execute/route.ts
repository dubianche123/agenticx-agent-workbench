import { NextResponse } from "next/server";
import {
  parseSupportExecuteRequest,
  SUPPORT_MAX_BODY_BYTES,
} from "@agenticx/ui/support/contracts";
import { requireAdminScope } from "../../../../lib/admin-auth";
import {
  executeSupportProposal,
  supportErrorResponseMessage,
} from "../../../../lib/support-assistant/assistant";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const guard = await requireAdminScope(["admin:enter", "user:update"]);
  if (!guard.ok) return guard.response;

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > SUPPORT_MAX_BODY_BYTES) {
    return NextResponse.json(
      { code: "40000", message: "support request is too large" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ code: "40000", message: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseSupportExecuteRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ code: "40000", message: parsed.reason }, { status: 400 });
  }

  try {
    const message = await executeSupportProposal({
      actor: guard.session,
      proposalId: parsed.value.proposalId,
    });
    return NextResponse.json({ code: "00000", message: "ok", data: { message } });
  } catch (error) {
    const mapped = supportErrorResponseMessage(error);
    if (mapped.status >= 500) {
      console.error("[support-assistant] proposal execution failed:", error instanceof Error ? error.message : error);
    }
    return NextResponse.json(
      { code: mapped.code, message: mapped.message },
      { status: mapped.status },
    );
  }
}
