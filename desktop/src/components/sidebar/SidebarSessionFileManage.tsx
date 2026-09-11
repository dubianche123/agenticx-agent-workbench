import { useAppStore } from "../../store";
import {
  dispatchWorkspacePickDir,
  dispatchWorkspacePickFile,
} from "../../utils/workspace-sidebar-events";
import { WorkspacePanel } from "../WorkspacePanel";

type Props = {
  paneId: string;
  sessionId: string;
  onBack: () => void;
};

/**
 * Trae-style in-sidebar file management for a history session.
 * Reuses Near WorkspacePanel (folder roots, tree, terminal) with a back affordance.
 */
export function SidebarSessionFileManage({ paneId, sessionId, onBack }: Props) {
  const pane = useAppStore((s) => s.panes.find((p) => p.id === paneId));
  const activeTaskspaceId = pane?.activeTaskspaceId ?? null;
  const attachmentRoutingPolicy = useAppStore((s) => s.userAccount.attachmentRouting);
  const providers = useAppStore((s) => s.settings.providers);
  const setActiveTaskspace = useAppStore((s) => s.setActiveTaskspace);
  const provider = String(pane?.modelProvider ?? "").trim();
  const model = String(pane?.modelName ?? "").trim();
  const activeModelUsesPublicRoute =
    provider === "enterprise" &&
    (providers[provider]?.modelCatalog ?? []).some(
      (item) => item.id === model && item.route === "third-party",
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-sidebar">
      <WorkspacePanel
        paneId={paneId}
        sessionId={sessionId}
        activeTaskspaceId={activeTaskspaceId}
        onActiveTaskspaceChange={(taskspaceId) => setActiveTaskspace(paneId, taskspaceId)}
        attachmentRoutingDocumentExtensions={attachmentRoutingPolicy?.documentExtensions}
        attachmentRoutingPrivateTargetLabel={attachmentRoutingPolicy?.documentTarget?.label}
        attachmentRoutingShouldWarn={activeModelUsesPublicRoute}
        backAction={{ label: "返回历史对话", onClick: onBack }}
        onPickFileForReference={(taskspaceId, path) => {
          dispatchWorkspacePickFile({ paneId, taskspaceId, path });
        }}
        onPickDirectoryForReference={({ taskspaceId, relPath, label }) => {
          dispatchWorkspacePickDir({ paneId, taskspaceId, relPath, label });
        }}
      />
    </div>
  );
}
