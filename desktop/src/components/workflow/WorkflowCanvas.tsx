import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useAppStore } from "../../store";
import type { WorkflowDocument, WorkflowEdge, WorkflowNodeKind, WorkflowPosition } from "./workflow-types";
import {
  addWorkflowEdge,
  addWorkflowNode,
  canConnectWorkflow,
  connectionToWorkflowEdge,
  isWorkflowNodeKind,
  workflowToFlowEdges,
  workflowToFlowNodes,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from "./workflow-utils";
import { WorkflowNodeView } from "./WorkflowNodeView";

const nodeTypes = { "workflow-node": WorkflowNodeView };

type Props = {
  document: WorkflowDocument;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onChange: (document: WorkflowDocument) => void;
  onConnectRejected?: (reason: string) => void;
  readOnly?: boolean;
};

function CanvasInner({ document, selectedNodeId, onSelectNode, onChange, onConnectRejected, readOnly = false }: Props) {
  const theme = useAppStore((state) => state.theme);
  const colorMode = theme === "light" ? "light" : "dark";
  const { fitView, screenToFlowPosition } = useReactFlow();
  const initialNodes = useMemo(() => workflowToFlowNodes(document), [document]);
  const initialEdges = useMemo(() => workflowToFlowEdges(document), [document]);
  const [nodes, setNodes] = useNodesState<WorkflowFlowNode>(initialNodes);
  const [edges, setEdges] = useEdgesState<WorkflowFlowEdge>(initialEdges);
  const [isDragOver, setIsDragOver] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasSizeRef = useRef<{ width: number; height: number } | null>(null);
  const fitFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const scheduleFit = () => {
      if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = window.requestAnimationFrame(() => {
        fitFrameRef.current = null;
        void fitView({ duration: 0 });
      });
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = Math.round(entry?.contentRect.width ?? element.clientWidth);
      const height = Math.round(entry?.contentRect.height ?? element.clientHeight);
      const previous = canvasSizeRef.current;
      if (previous?.width === width && previous.height === height) return;
      canvasSizeRef.current = { width, height };
      // React Flow's initial fitView covers the first mount. Scheduling here
      // also handles the first observer sample when the canvas was initially
      // hidden and keeps a newly visible layout in bounds.
      scheduleFit();
    });
    observer.observe(element);
    canvasSizeRef.current = { width: element.clientWidth, height: element.clientHeight };
    scheduleFit();

    return () => {
      observer.disconnect();
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
  }, [fitView]);

  useEffect(() => {
    setNodes((previous) => {
      const localById = new Map(previous.map((node) => [node.id, node] as const));
      return initialNodes.map((node) => {
        const local = localById.get(node.id);
        return local ? { ...node, selected: local.selected, position: local.position } : node;
      });
    });
    setEdges(initialEdges);
  }, [initialEdges, initialNodes, setEdges, setNodes]);

  useEffect(() => {
    setNodes((previous) => previous.map((node) => ({ ...node, selected: node.id === selectedNodeId })));
  }, [selectedNodeId, setNodes]);

  const onNodesChange = useCallback((changes: NodeChange<WorkflowFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    if (!readOnly) {
      const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
      if (removed.size > 0) {
        if (selectedNodeId && removed.has(selectedNodeId)) onSelectNode(null);
        onChange({
          ...document,
          nodes: document.nodes.filter((node) => !removed.has(node.id)),
          edges: document.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
        });
      }
    }
  }, [document, onChange, onSelectNode, readOnly, selectedNodeId, setNodes]);

  const onNodeDragStop = useCallback<OnNodeDrag<WorkflowFlowNode>>((_event, node) => {
    if (readOnly) return;
    const position: WorkflowPosition = { x: node.position.x, y: node.position.y };
    onChange({
      ...document,
      nodes: document.nodes.map((item) => item.id === node.id ? { ...item, position } : item),
    });
  }, [document, onChange, readOnly]);

  const onEdgesChange = useCallback((changes: EdgeChange<WorkflowFlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
    if (readOnly) return;
    const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
    if (removed.size > 0) onChange({ ...document, edges: document.edges.filter((edge) => !removed.has(edge.id)) });
  }, [document, onChange, readOnly, setEdges]);

  const onConnect = useCallback((connection: Connection) => {
    if (readOnly) return;
    const check = canConnectWorkflow(connection, document.edges);
    if (!check.ok) {
      onConnectRejected?.(check.reason);
      return;
    }
    const edge = connectionToWorkflowEdge(connection, document.edges.map((item) => item.id));
    if (!edge) return;
    setEdges((current) => [...current, {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: connection.sourceHandle || undefined,
      label: edge.label || undefined,
      data: { route: edge.route },
      type: "smoothstep",
      style: { stroke: "var(--border-strong)", strokeWidth: 1.5 },
    }]);
    onChange(addWorkflowEdge(document, edge));
  }, [document, onChange, onConnectRejected, readOnly, setEdges]);

  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    if (readOnly) return;
    const rawKind = event.dataTransfer.getData("application/x-agenticx-workflow-node") || event.dataTransfer.getData("text/plain");
    if (!isWorkflowNodeKind(rawKind)) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    onChange(addWorkflowNode(document, rawKind as WorkflowNodeKind, position));
  }, [document, onChange, readOnly, screenToFlowPosition]);

  return (
    <div
      ref={canvasRef}
      className={`relative h-full min-h-0 w-full overflow-hidden bg-surface-base ${isDragOver ? "ring-2 ring-inset ring-[var(--ui-btn-primary-bg)]" : ""}`}
      onDrop={onDrop}
      onDragOver={(event) => {
        if (!readOnly) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setIsDragOver(true);
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      data-testid="workflow-canvas"
    >
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onConnect={readOnly ? undefined : onConnect}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        fitView
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        colorMode={colorMode}
        defaultEdgeOptions={{ type: "smoothstep" }}
        style={{ background: "var(--surface-base)" }}
      >
        <Background color="var(--border-muted)" gap={24} size={1} />
        <Controls showInteractive={false} className="!border-border !bg-surface-popover !shadow-lg" />
        <MiniMap
          pannable
          zoomable
          nodeColor="var(--workflow-minimap-node)"
          nodeStrokeColor="var(--workflow-minimap-node-border)"
          nodeStrokeWidth={1.5}
          maskColor="var(--workflow-minimap-mask)"
          maskStrokeColor="var(--workflow-minimap-viewport)"
          maskStrokeWidth={1.5}
          className="!border-border !bg-surface-card"
        />
      </ReactFlow>
      {isDragOver ? (
        <div className="pointer-events-none absolute inset-5 flex items-center justify-center rounded-xl border border-dashed border-[var(--ui-btn-primary-bg)] bg-[var(--ui-accent-surface)] text-sm text-[var(--ui-accent-text)]">
          放到这里添加节点
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
