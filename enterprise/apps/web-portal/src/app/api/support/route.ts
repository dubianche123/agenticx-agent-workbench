import { NextResponse } from "next/server";
import { listAvailableModelsForUser } from "../../../lib/admin-providers-reader";
import { getSessionAuthFromCookies, passwordChangeRequiredResponse } from "../../../lib/session";
import {
  PORTAL_SUPPORT_TITLE,
  supportStorageKey,
} from "../../../lib/support-assistant/server";
import { suggestionsForSupportPage } from "@agenticx/ui/support/guides";

export const runtime = "nodejs";

export async function GET() {
  const auth = await getSessionAuthFromCookies();
  if (auth?.session.mustChangePassword) return passwordChangeRequiredResponse();
  if (!auth) {
    return NextResponse.json({ code: "40101", message: "unauthorized" }, { status: 401 });
  }

  const page = { path: "/workspace", tab: "chat" } as const;
  let models: Array<{ id: string; label: string }> | undefined;
  try {
    const available = await listAvailableModelsForUser(auth.session);
    models = available.map((model) => ({ id: model.id, label: model.label }));
  } catch {
    // Static page help remains useful when the model registry is unavailable.
    models = [];
  }

  return NextResponse.json({
    code: "00000",
    message: "ok",
    data: {
      storageKey: supportStorageKey(auth.session),
      title: PORTAL_SUPPORT_TITLE,
      suggestions: suggestionsForSupportPage(page),
      models,
    },
  });
}
