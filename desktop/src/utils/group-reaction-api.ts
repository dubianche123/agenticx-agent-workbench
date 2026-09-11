/** REST client for a human reaction on a project group message. */

export type GroupReactionApiParams = {
  apiBase: string;
  apiToken: string;
  groupId: string;
  sessionId: string;
  messageId: string;
  emoji: string;
};

export type GroupReactionApiRow = {
  emoji: string;
  actor_ids: string[];
};

export type GroupReactionApiResponse = {
  ok: boolean;
  group_id: string;
  session_id: string;
  message_id: string;
  actor_id: "user";
  emoji: string;
  active: boolean;
  reactions: GroupReactionApiRow[];
};

function responseDetail(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const row = raw as Record<string, unknown>;
  const detail = row.detail;
  if (typeof detail === "string") return detail.trim();
  if (detail && typeof detail === "object") {
    const nested = (detail as Record<string, unknown>).detail;
    if (typeof nested === "string") return nested.trim();
  }
  const error = row.error;
  return typeof error === "string" ? error.trim() : "";
}

/**
 * Toggle the fixed desktop-user actor.  The backend remains authoritative for
 * membership, message ownership, and the emoji allowlist; this helper only
 * serializes the narrow request and surfaces a rejected response to the
 * caller so the existing optimistic UI can roll back.
 */
export async function toggleGroupMessageReaction(
  params: GroupReactionApiParams,
): Promise<GroupReactionApiResponse> {
  const base = String(params.apiBase || "").replace(/\/+$/, "");
  const groupId = String(params.groupId || "").trim();
  const sessionId = String(params.sessionId || "").trim();
  const messageId = String(params.messageId || "").trim();
  const emoji = String(params.emoji || "").trim();
  if (!base || !groupId || !sessionId || !messageId || !emoji) {
    throw new Error("群消息回应参数不完整");
  }

  const response = await fetch(
    `${base}/api/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/reaction`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agx-desktop-token": params.apiToken,
      },
      body: JSON.stringify({
        session_id: sessionId,
        actor: "user",
        emoji,
      }),
    },
  );

  const payload = (await response.json().catch(() => null)) as
    | GroupReactionApiResponse
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    throw new Error(responseDetail(payload) || `群消息回应失败（HTTP ${response.status}）`);
  }
  if (!payload || payload.ok !== true) {
    throw new Error(responseDetail(payload) || "群消息回应失败");
  }
  return payload as GroupReactionApiResponse;
}
