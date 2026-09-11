import type { ForwardConfirmPayload } from "../components/ForwardPicker";
import { META_AGENT_DISPLAY_NAME } from "../constants/branding";
import { useAppStore } from "../store";
import { getRememberedSessionForAvatar } from "./avatar-last-session";
import { pickConfirmedGroupSessionId } from "./group-pane-open";

type ResolveDeps = {
  addPane: (avatarId: string | null, avatarName: string, sessionId?: string) => string;
  setActivePaneId: (paneId: string) => void;
  setActiveAvatarId: (avatarId: string | null) => void;
  setPaneSessionId: (paneId: string, sessionId: string) => void;
};

type GroupTarget = { paneId: string; sessionId: string };

/** Serialize group-target resolution so two forwards cannot create siblings. */
const pendingGroupResolutions = new Map<string, Promise<GroupTarget>>();

function paneAvatarIdForPayload(avatarId: string | null | undefined): string | null {
  if (avatarId == null || String(avatarId).trim() === "") return null;
  return String(avatarId).trim();
}

function activeAvatarIdForPane(avatarId: string | null): string | null {
  if (!avatarId) return null;
  if (avatarId.startsWith("group:")) return null;
  return avatarId;
}

function displayNameForAvatar(avatarId: string | null, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim();
  if (!avatarId) return META_AGENT_DISPLAY_NAME;
  if (avatarId.startsWith("group:")) return `群聊 · ${avatarId.slice("group:".length)}`;
  return avatarId;
}

async function ensureSessionOnPane(
  paneId: string,
  create: () => Promise<{ ok: boolean; session_id?: string; error?: string }>,
  errorFallback: string,
  deps: ResolveDeps
): Promise<string> {
  const created = await create();
  if (!created.ok || !created.session_id) {
    throw new Error(created.error || errorFallback);
  }
  deps.setPaneSessionId(paneId, created.session_id);
  return created.session_id;
}

async function findExistingGroupSession(groupAvatarId: string): Promise<string | undefined> {
  let listed: Awaited<ReturnType<typeof window.agenticxDesktop.listSessions>>;
  try {
    listed = await window.agenticxDesktop.listSessions(groupAvatarId);
  } catch {
    throw new Error("无法确认群聊历史会话，请重试");
  }
  if (!listed.ok || !Array.isArray(listed.sessions)) {
    throw new Error("无法确认群聊历史会话，请重试");
  }
  // A forwarding navigation can be the first session-list request after a
  // cold start. Reconcile the server marker before resolving the target so a
  // newly opened pane sees the authoritative routing lock immediately.
  useAppStore.getState().hydrateAttachmentRoutingLocksFromSessions(listed.sessions);
  const rows = listed.sessions.filter(
    (item) =>
      item.archived !== true && String(item.avatar_id ?? "").trim() === groupAvatarId,
  );
  return pickConfirmedGroupSessionId({
    rememberedSid: getRememberedSessionForAvatar(groupAvatarId),
    listed: rows,
    groupAvatarId,
  });
}

/**
 * Resolve a ForwardPicker confirm payload into an open pane + session.
 * Opens / creates panes when the target session is not already visible.
 */
export async function resolveForwardTarget(
  payload: ForwardConfirmPayload,
  deps: ResolveDeps
): Promise<{ paneId: string; sessionId: string }> {
  const state = useAppStore.getState();

  if (payload.type === "session") {
    const sid = payload.sessionId.trim();
    if (!sid) throw new Error("目标会话无效");
    const existingBySession = state.panes.find((item) => (item.sessionId || "").trim() === sid);
    if (existingBySession) {
      deps.setActivePaneId(existingBySession.id);
      deps.setActiveAvatarId(activeAvatarIdForPane(existingBySession.avatarId ?? null));
      return { paneId: existingBySession.id, sessionId: sid };
    }
    const avatarId = paneAvatarIdForPayload(payload.avatarId);
    const displayName = displayNameForAvatar(avatarId, payload.displayName);
    let pane = state.panes.find((item) => (item.avatarId ?? null) === avatarId);
    let paneId: string;
    if (!pane) {
      paneId = deps.addPane(avatarId, displayName, sid);
    } else {
      paneId = pane.id;
      deps.setPaneSessionId(paneId, sid);
    }
    deps.setActivePaneId(paneId);
    deps.setActiveAvatarId(activeAvatarIdForPane(avatarId));
    return { paneId, sessionId: sid };
  }

  if (payload.type === "meta") {
    let pane = state.panes.find((item) => item.avatarId === null);
    if (!pane) {
      const paneId = deps.addPane(null, META_AGENT_DISPLAY_NAME, "");
      deps.setActiveAvatarId(null);
      const sessionId = await ensureSessionOnPane(
        paneId,
        () => window.agenticxDesktop.createSession({}),
        "创建主智能体会话失败",
        deps
      );
      return { paneId, sessionId };
    }
    if (payload.forceNewSession) {
      const sessionId = await ensureSessionOnPane(
        pane.id,
        () => window.agenticxDesktop.createSession({}),
        "创建主智能体会话失败",
        deps
      );
      deps.setActivePaneId(pane.id);
      deps.setActiveAvatarId(null);
      return { paneId: pane.id, sessionId };
    }
    let sid = (pane.sessionId || "").trim();
    if (!sid) {
      sid = await ensureSessionOnPane(
        pane.id,
        () => window.agenticxDesktop.createSession({}),
        "创建主智能体会话失败",
        deps
      );
    }
    deps.setActivePaneId(pane.id);
    deps.setActiveAvatarId(null);
    return { paneId: pane.id, sessionId: sid };
  }

  if (payload.type === "avatar") {
    let pane = state.panes.find((item) => item.avatarId === payload.avatarId);
    if (!pane) {
      const paneId = deps.addPane(payload.avatarId, payload.displayName, "");
      deps.setActiveAvatarId(payload.avatarId);
      const sessionId = await ensureSessionOnPane(
        paneId,
        () => window.agenticxDesktop.createSession({ avatar_id: payload.avatarId }),
        "创建专家会话失败",
        deps
      );
      return { paneId, sessionId };
    }
    if (payload.forceNewSession) {
      const sessionId = await ensureSessionOnPane(
        pane.id,
        () => window.agenticxDesktop.createSession({ avatar_id: payload.avatarId }),
        "创建专家会话失败",
        deps
      );
      deps.setActivePaneId(pane.id);
      deps.setActiveAvatarId(payload.avatarId);
      return { paneId: pane.id, sessionId };
    }
    let sid = (pane.sessionId || "").trim();
    if (!sid) {
      sid = await ensureSessionOnPane(
        pane.id,
        () => window.agenticxDesktop.createSession({ avatar_id: payload.avatarId }),
        "创建专家会话失败",
        deps
      );
    }
    deps.setActivePaneId(pane.id);
    deps.setActiveAvatarId(payload.avatarId);
    return { paneId: pane.id, sessionId: sid };
  }

  const groupAvatarId = `group:${payload.groupId}`;
  const pending = pendingGroupResolutions.get(groupAvatarId);
  if (pending) return pending;

  const resolution = (async (): Promise<GroupTarget> => {
    // Read the store again after awaiting any preceding work. The outer state
    // snapshot may predate a pane/session created by a concurrent invocation.
    const initialPane = useAppStore
      .getState()
      .panes.find((item) => item.avatarId === groupAvatarId);
    const initialSid = String(initialPane?.sessionId ?? "").trim();
    if (initialPane && initialSid) {
      deps.setActivePaneId(initialPane.id);
      deps.setActiveAvatarId(null);
      return { paneId: initialPane.id, sessionId: initialSid };
    }

    const existingSessionId = await findExistingGroupSession(groupAvatarId);
    // A different opener may have mounted/bound the pane while the server
    // lookup was in flight. Re-read before adding a pane or creating a row.
    const latestPane = useAppStore
      .getState()
      .panes.find((item) => item.avatarId === groupAvatarId);
    const latestSid = String(latestPane?.sessionId ?? "").trim();
    if (latestPane && latestSid) {
      deps.setActivePaneId(latestPane.id);
      deps.setActiveAvatarId(null);
      return { paneId: latestPane.id, sessionId: latestSid };
    }
    const paneId = latestPane
      ? latestPane.id
      : deps.addPane(groupAvatarId, `群聊 · ${payload.displayName}`, existingSessionId ?? "");
    if (existingSessionId && latestSid !== existingSessionId) {
      deps.setPaneSessionId(paneId, existingSessionId);
    }
    deps.setActivePaneId(paneId);
    deps.setActiveAvatarId(null);
    if (existingSessionId) return { paneId, sessionId: existingSessionId };

    const sessionId = await ensureSessionOnPane(
      paneId,
      () =>
        window.agenticxDesktop.createSession({
          avatar_id: groupAvatarId,
          name: payload.displayName,
        }),
      "创建群聊会话失败",
      deps,
    );
    return { paneId, sessionId };
  })();
  pendingGroupResolutions.set(groupAvatarId, resolution);
  try {
    return await resolution;
  } finally {
    if (pendingGroupResolutions.get(groupAvatarId) === resolution) {
      pendingGroupResolutions.delete(groupAvatarId);
    }
  }
}
