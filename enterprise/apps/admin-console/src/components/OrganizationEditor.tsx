"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Skeleton,
  toast,
} from "@agenticx/ui";
import { ChevronDown, ChevronRight, FolderTree, MoreHorizontal, MoveRight, Pencil, Plus, RefreshCw, Save, Trash2, UserPlus, Users } from "lucide-react";
import { adminFetch } from "../lib/admin-client-auth";
import { useLocale } from "next-intl";
import { CreateUserDialog, type CreateUserDepartmentOption } from "./CreateUserDialog";
import { UserDetailEditor, type UserDetailTarget } from "./UserDetailEditor";
import { VisibleModelsEditor } from "./visible-models-editor";

type OrganizationNode = {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  memberCount?: number;
  children?: OrganizationNode[];
};

type ApiEnvelope<T> = { code: string; message: string; data?: T };

type OrganizationMember = {
  id: string;
  displayName: string;
  email: string;
  deptId: string | null;
  status: "active" | "disabled" | "locked";
};

async function loadOrganizationMembers(): Promise<OrganizationMember[]> {
  const items: OrganizationMember[] = [];
  let offset = 0;
  while (true) {
    const response = await adminFetch(`/api/admin/users?limit=200&offset=${offset}`, { cache: "no-store" });
    const json = (await response.json()) as ApiEnvelope<{ items: OrganizationMember[]; total: number }>;
    if (!response.ok || !json.data) throw new Error(json.message || "Failed to load organization members");
    items.push(...json.data.items);
    offset += json.data.items.length;
    if (offset >= json.data.total || json.data.items.length === 0) return items;
  }
}

function collectNodes(nodes: OrganizationNode[]): OrganizationNode[] {
  return nodes.flatMap((node) => [node, ...collectNodes(node.children ?? [])]);
}

function collectDescendantIds(node: OrganizationNode): Set<string> {
  return new Set(collectNodes(node.children ?? []).map((child) => child.id));
}

function findNode(nodes: OrganizationNode[], id: string | null): OrganizationNode | null {
  if (!id) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return null;
}

function TreeBranch({
  node,
  depth,
  selectedId,
  expandedIds,
  membersByDept,
  draggingMemberId,
  dropTargetDeptId,
  onSelect,
  onToggle,
  onDropTargetChange,
  onMemberDrop,
  onMemberDragStart,
  onMemberDragEnd,
  onMoveMember,
  onDeleteMember,
  onEditMember,
}: {
  node: OrganizationNode;
  depth: number;
  selectedId: string | null;
  expandedIds: Set<string>;
  membersByDept: Map<string | null, OrganizationMember[]>;
  draggingMemberId: string | null;
  dropTargetDeptId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onDropTargetChange: (deptId: string | null) => void;
  onMemberDrop: (memberId: string, deptId: string) => void;
  onMemberDragStart: (member: OrganizationMember) => void;
  onMemberDragEnd: () => void;
  onMoveMember: (member: OrganizationMember) => void;
  onDeleteMember: (member: OrganizationMember) => void;
  onEditMember: (member: OrganizationMember) => void;
}) {
  const children = node.children ?? [];
  const members = membersByDept.get(node.id) ?? [];
  const hasChildren = children.length > 0 || members.length > 0;
  const expanded = expandedIds.has(node.id);
  const selected = selectedId === node.id;
  return (
    <div>
      <div
        className={[
          "flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-sm transition-colors",
          selected || dropTargetDeptId === node.id
            ? "bg-primary/10 font-semibold text-primary"
            : "hover:bg-muted",
        ].join(" ")}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onDragOver={(event) => {
          if (!draggingMemberId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          onDropTargetChange(node.id);
        }}
        onDrop={(event) => {
          if (!draggingMemberId) return;
          event.preventDefault();
          onMemberDrop(draggingMemberId, node.id);
        }}
      >
        <button
          type="button"
          className={[
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm",
            hasChildren ? "text-muted-foreground hover:text-foreground" : "cursor-default text-transparent",
          ].join(" ")}
          aria-label={hasChildren ? (expanded ? `收起 ${node.name}` : `展开 ${node.name}`) : undefined}
          disabled={!hasChildren}
          onClick={(event) => {
            event.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          {hasChildren ? (expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : null}
        </button>
        <button
          type="button"
          className={[
            "flex min-w-0 flex-1 items-center gap-1.5 text-left",
            "focus-visible:outline-none",
          ].join(" ")}
          onClick={() => onSelect(node.id)}
        >
          <FolderTree className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {(node.memberCount ?? 0) > 0 ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{node.memberCount}</span> : null}
        </button>
      </div>
      {expanded ? (
        <div>
          {children.map((child) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expandedIds={expandedIds}
              membersByDept={membersByDept}
              draggingMemberId={draggingMemberId}
              dropTargetDeptId={dropTargetDeptId}
              onSelect={onSelect}
              onToggle={onToggle}
              onDropTargetChange={onDropTargetChange}
              onMemberDrop={onMemberDrop}
              onMemberDragStart={onMemberDragStart}
              onMemberDragEnd={onMemberDragEnd}
              onMoveMember={onMoveMember}
              onDeleteMember={onDeleteMember}
              onEditMember={onEditMember}
            />
          ))}
          {members.map((member) => (
            <OrganizationMemberRow
              key={member.id}
              member={member}
              depth={depth}
              onDragStart={onMemberDragStart}
              onDragEnd={onMemberDragEnd}
              onMove={onMoveMember}
              onDelete={onDeleteMember}
              onEdit={onEditMember}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OrganizationMemberRow({
  member,
  depth = 0,
  onDragStart,
  onDragEnd,
  onMove,
  onDelete,
  onEdit,
}: {
  member: OrganizationMember;
  depth?: number;
  onDragStart: (member: OrganizationMember) => void;
  onDragEnd: () => void;
  onMove: (member: OrganizationMember) => void;
  onDelete: (member: OrganizationMember) => void;
  onEdit: (member: OrganizationMember) => void;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  return (
    <div
      draggable
      className="group flex min-w-0 items-center gap-1 rounded-md pr-1 text-sm transition-colors hover:bg-muted"
      style={{ paddingLeft: `${32 + depth * 16}px` }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", member.id);
        onDragStart(member);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        onClick={() => onEdit(member)}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{member.displayName.slice(0, 1)}</span>
        <span className="min-w-0 flex-1"><span className="block truncate">{member.displayName}</span><span className="block truncate text-[10px] text-muted-foreground">{member.email}</span></span>
        {member.status !== "active" ? <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">{member.status === "locked" ? copy("锁定", "Locked") : copy("停用", "Disabled")}</span> : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1 px-2 text-xs"
            aria-label={`${member.displayName} 的管理`}
            onClick={(event) => event.stopPropagation()}
          >
            {copy("管理", "Manage")}
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuLabel>{copy("用户操作", "User actions")}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onEdit(member)}>
            <Pencil className="mr-2 h-4 w-4" />{copy("详细编辑", "Edit details")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onMove(member)}>
            <MoveRight className="mr-2 h-4 w-4" />{copy("移动到组织", "Move to organization")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-danger focus:text-danger"
            onClick={() => onDelete(member)}
          >
            <Trash2 className="mr-2 h-4 w-4" />{copy("删除用户", "Delete user")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function errorMessage(message: string): string {
  if (message === "dept_has_children") return "Move or delete subdepartments before deleting this organization";
  if (message === "dept_has_members") return "Move members before deleting this organization";
  return message || "Operation failed";
}

export function OrganizationEditor() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [tree, setTree] = useState<OrganizationNode[]>([]);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [draftName, setDraftName] = useState("");
  const [draftParentId, setDraftParentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [movingMember, setMovingMember] = useState<OrganizationMember | null>(null);
  const [moveTargetDeptId, setMoveTargetDeptId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [draggingMemberId, setDraggingMemberId] = useState<string | null>(null);
  const [dropTargetDeptId, setDropTargetDeptId] = useState<string | null>(null);
  const [editingMember, setEditingMember] = useState<UserDetailTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [response, loadedMembers] = await Promise.all([
        adminFetch("/api/admin/departments?shape=tree", { cache: "no-store" }),
        loadOrganizationMembers(),
      ]);
      const json = (await response.json()) as ApiEnvelope<{ items: OrganizationNode[] }>;
      if (!response.ok || !json.data?.items) throw new Error(json.message || copy("加载组织结构失败", "Failed to load organization structure"));
      setTree(json.data.items);
      setMembers(loadedMembers);
      setExpandedIds(new Set(collectNodes(json.data.items).map((node) => node.id)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("加载组织结构失败", "Failed to load organization structure"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => findNode(tree, selectedId), [tree, selectedId]);
  const flatNodes = useMemo(() => collectNodes(tree), [tree]);
  const departmentOptions = useMemo<CreateUserDepartmentOption[]>(
    () => flatNodes.map((node) => ({ id: node.id, label: node.path })),
    [flatNodes],
  );
  const blockedParentIds = useMemo(() => selected ? new Set([selected.id, ...collectDescendantIds(selected)]) : new Set<string>(), [selected]);
  const membersByDept = useMemo(() => {
    const departmentIds = new Set(flatNodes.map((node) => node.id));
    const result = new Map<string | null, OrganizationMember[]>();
    for (const member of members) {
      const deptId = member.deptId && departmentIds.has(member.deptId) ? member.deptId : null;
      const current = result.get(deptId) ?? [];
      current.push(member);
      result.set(deptId, current);
    }
    for (const list of result.values()) list.sort((left, right) => left.displayName.localeCompare(right.displayName));
    return result;
  }, [flatNodes, members]);
  const unassignedMembers = membersByDept.get(null) ?? [];
  const moveTarget = useMemo(
    () => (moveTargetDeptId ? flatNodes.find((node) => node.id === moveTargetDeptId) ?? null : null),
    [flatNodes, moveTargetDeptId],
  );

  useEffect(() => {
    if (!selected) {
      setDraftName("");
      setDraftParentId(null);
      return;
    }
    setDraftName(selected.name);
    setDraftParentId(selected.parentId);
    setDeleteConfirm(false);
  }, [selected]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openMemberMove = (member: OrganizationMember, targetDeptId = member.deptId) => {
    setMovingMember(member);
    setMoveTargetDeptId(targetDeptId);
  };

  const openMemberEditor = (member: OrganizationMember) => {
    setEditingMember(member);
  };

  const handleMemberDrop = (memberId: string, targetDeptId: string) => {
    setDraggingMemberId(null);
    setDropTargetDeptId(null);
    const member = members.find((item) => item.id === memberId);
    if (!member || member.deptId === targetDeptId) return;
    openMemberMove(member, targetDeptId);
  };

  const moveMember = async () => {
    if (!movingMember || moving) return;
    setMoving(true);
    try {
      const response = await adminFetch(`/api/admin/users/${movingMember.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deptId: moveTargetDeptId }),
      });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("移动用户失败", "Failed to move user"));
      toast.success(copy(`已将 ${movingMember.displayName} 移动至 ${moveTarget?.path ?? "未归属组织"}`, `Moved ${movingMember.displayName} to ${moveTarget?.path ?? "no organization"}`));
      setMovingMember(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("移动用户失败", "Failed to move user"));
    } finally {
      setMoving(false);
    }
  };

  const deleteMember = async (member: OrganizationMember) => {
    if (!window.confirm(copy(`确认删除用户 ${member.email}？该操作不可撤销。`, `Delete user ${member.email}? This action cannot be undone.`))) return;
    try {
      const response = await adminFetch(`/api/admin/users/${member.id}`, { method: "DELETE" });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("删除用户失败", "Failed to delete user"));
      toast.success(copy(`用户已删除：${member.email}`, `Deleted user: ${member.email}`));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("删除用户失败", "Failed to delete user"));
    }
  };

  const create = async () => {
    if (!createName.trim() || saving) return;
    setSaving(true);
    try {
      const response = await adminFetch("/api/admin/departments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: createName.trim(), parentId: createParentId }),
      });
      const json = (await response.json()) as ApiEnvelope<{ department?: OrganizationNode }>;
      if (!response.ok || json.code !== "00000") throw new Error(errorMessage(json.message));
      toast.success(copy("组织已创建", "Organization created"));
      setCreateOpen(false);
      setCreateName("");
      const createdId = json.data?.department?.id ?? null;
      await load();
      if (createdId) setSelectedId(createdId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("创建组织失败", "Failed to create organization"));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!selected || !draftName.trim() || saving) return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/departments/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: draftName.trim(), parentId: draftParentId }),
      });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(errorMessage(json.message));
      toast.success(copy("组织结构已保存", "Organization saved"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("保存组织失败", "Failed to save organization"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || !deleteConfirm || saving) return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/departments/${selected.id}`, { method: "DELETE" });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(errorMessage(json.message));
      toast.success(copy("组织已删除", "Organization deleted"));
      setSelectedId(selected.parentId);
      setDeleteConfirm(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("删除组织失败", "Failed to delete organization"));
    } finally {
      setSaving(false);
    }
  };

  const organizationTree = loading ? (
    <div className="space-y-3 p-3">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-4/5" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  ) : tree.length || unassignedMembers.length ? (
    <div className="space-y-2">
      {tree.map((node) => (
        <TreeBranch
          key={node.id}
          node={node}
          depth={0}
          selectedId={selectedId}
          expandedIds={expandedIds}
          membersByDept={membersByDept}
          draggingMemberId={draggingMemberId}
          dropTargetDeptId={dropTargetDeptId}
          onSelect={setSelectedId}
          onToggle={toggleExpanded}
          onDropTargetChange={setDropTargetDeptId}
          onMemberDrop={handleMemberDrop}
          onMemberDragStart={(member) => {
            setDraggingMemberId(member.id);
            setDropTargetDeptId(null);
          }}
          onMemberDragEnd={() => {
            setDraggingMemberId(null);
            setDropTargetDeptId(null);
          }}
          onMoveMember={openMemberMove}
          onDeleteMember={deleteMember}
          onEditMember={openMemberEditor}
        />
      ))}
      {unassignedMembers.length ? (
        <div className={tree.length ? "border-t border-border pt-2" : "pt-1"}>
            <p className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground">
            <Users className="h-3.5 w-3.5" />{copy("未归属组织的用户", "Users without an organization")}
          </p>
          {unassignedMembers.map((member) => (
            <OrganizationMemberRow
              key={member.id}
              member={member}
              onDragStart={(item) => {
                setDraggingMemberId(item.id);
                setDropTargetDeptId(null);
              }}
              onDragEnd={() => {
                setDraggingMemberId(null);
                setDropTargetDeptId(null);
              }}
              onMove={openMemberMove}
              onDelete={deleteMember}
              onEdit={openMemberEditor}
            />
          ))}
        </div>
      ) : null}
    </div>
  ) : (
    <div className="p-6 text-center text-sm text-muted-foreground">{copy("还没有组织，请先创建顶层组织。", "No organizations yet. Create a top-level organization first.")}</div>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><FolderTree className="h-5 w-5 text-primary" />{copy("组织结构", "Organization structure")}</CardTitle>
          <CardDescription className="mt-1">{copy("在这里管理组织和组织下的成员；批量开通会继续在本页下方完成。", "Manage organizations and their members here; bulk onboarding remains available below.")}</CardDescription>
        </div>
        <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "animate-spin" : ""} />{copy("刷新", "Refresh")}</Button><Button size="sm" onClick={() => { setCreateParentId(selectedId); setCreateOpen(true); }}><Plus />{copy("新增组织", "New organization")}</Button></div>
      </CardHeader>
      <CardContent className="grid min-h-[390px] gap-4 border-t border-border pt-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,1.1fr)]">
        <div className="rounded-xl border border-border p-2">
          {organizationTree}
        </div>
        <div className="rounded-xl border border-border bg-muted/10 p-5">
          {selected ? (
            <div className="space-y-5">
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-primary/10 p-2 text-primary"><Pencil className="h-4 w-4" /></span>
                <div><p className="font-medium">{copy("编辑组织", "Edit organization")}</p><p className="text-xs text-muted-foreground">{copy(`成员 ${selected.memberCount ?? 0} 人`, `${selected.memberCount ?? 0} members`)}</p></div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-name">{copy("名称", "Name")}</Label>
                <Input id="organization-name" value={draftName} onChange={(event) => setDraftName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="organization-parent">{copy("上级组织", "Parent organization")}</Label>
                <select id="organization-parent" className="w-full rounded-md border border-border bg-background px-3 py-2 pr-8 text-sm" value={draftParentId ?? ""} onChange={(event) => setDraftParentId(event.target.value || null)}>
                  <option value="">{copy("顶层组织", "Top-level organization")}</option>
                  {flatNodes.filter((node) => !blockedParentIds.has(node.id)).map((node) => <option key={node.id} value={node.id}>{node.path}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">{copy("不能移动到自身或子组织之下。", "An organization cannot be moved under itself or one of its children.")}</p>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => { setCreateParentId(selected.id); setCreateOpen(true); }}><Plus />{copy("新增下级", "Add child")}</Button>
                  <Button variant="outline" onClick={() => setCreateUserOpen(true)}><UserPlus />{copy("新建用户", "New user")}</Button>
                </div>
                <Button onClick={() => void save()} disabled={saving || !draftName.trim()}><Save />{copy("保存组织", "Save organization")}</Button>
              </div>
              <section className="border-t border-border pt-5">
                <h3 className="text-sm font-medium">{copy("模型边界", "Model boundary")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{copy("为当前组织设置可用模型的上限；下级组织和成员只能在此范围内继续收窄。未配置时继承上级范围，修改会即时保存。", "Set the available model boundary for this organization. Child organizations and members can only narrow it further; when unset, the parent boundary is inherited and changes save immediately.")}</p>
                <div className="mt-3">
                  <VisibleModelsEditor
                    key={selected.id}
                    target={{ kind: "dept", id: selected.id }}
                    variant="inline"
                  />
                </div>
              </section>
              <div className="border-t border-border pt-5">
                <p className="text-sm font-medium text-destructive">{copy("删除当前组织", "Delete this organization")}</p>
                <p className="mt-1 text-xs text-muted-foreground">{copy("只有没有成员和下级组织时才可删除。", "Only organizations with no members or child organizations can be deleted.")}</p>
                {deleteConfirm ? (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="destructive" onClick={() => void remove()} disabled={saving}>{copy("再次确认删除", "Confirm delete")}</Button>
                    <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(false)}>{copy("取消", "Cancel")}</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="mt-3 text-destructive hover:text-destructive" onClick={() => setDeleteConfirm(true)}><Trash2 />{copy("删除组织", "Delete organization")}</Button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-56 flex-col items-center justify-center text-center">
              <FolderTree className="h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium">{copy("选择一个组织进行编辑", "Select an organization to edit")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{copy("也可以直接新建顶层组织。", "You can also create a top-level organization directly.")}</p>
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{copy("新增组织", "New organization")}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2"><div className="space-y-2"><Label htmlFor="new-organization-name">{copy("名称", "Name")}</Label><Input id="new-organization-name" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={copy("例如：产品部", "e.g. Product")}/></div><div className="space-y-2"><Label htmlFor="new-organization-parent">{copy("上级组织", "Parent organization")}</Label><select id="new-organization-parent" className="w-full rounded-md border border-border bg-background px-3 py-2 pr-8 text-sm" value={createParentId ?? ""} onChange={(event) => setCreateParentId(event.target.value || null)}><option value="">{copy("顶层组织", "Top-level organization")}</option>{flatNodes.map((node) => <option key={node.id} value={node.id}>{node.path}</option>)}</select></div></div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>{copy("取消", "Cancel")}</Button><Button onClick={() => void create()} disabled={saving || !createName.trim()}>{saving ? copy("创建中…", "Creating…") : copy("创建组织", "Create organization")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateUserDialog
        open={createUserOpen}
        onOpenChange={setCreateUserOpen}
        defaultDeptId={selected?.id}
        departmentOptions={departmentOptions}
        onCreated={load}
      />

      <UserDetailEditor
        target={editingMember}
        onOpenChange={(open) => {
          if (!open) setEditingMember(null);
        }}
        onChanged={load}
      />

      <Dialog
        open={Boolean(movingMember)}
        onOpenChange={(open) => {
          if (!open && !moving) setMovingMember(null);
        }}
      >
        <DialogContent>
          <DialogHeader><DialogTitle>{copy("移动用户", "Move user")}</DialogTitle></DialogHeader>
          {movingMember ? (
            <div className="space-y-4 py-2">
              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <p className="font-medium">{movingMember.displayName}</p>
                <p className="mt-1 text-sm text-muted-foreground">{movingMember.email}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="move-member-department">{copy("目标组织", "Target organization")}</Label>
                <select
                  id="move-member-department"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 pr-8 text-sm"
                  value={moveTargetDeptId ?? ""}
                  onChange={(event) => setMoveTargetDeptId(event.target.value || null)}
                >
                  <option value="">{copy("未归属组织", "No organization")}</option>
                  {flatNodes.map((node) => <option key={node.id} value={node.id}>{node.path}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">{copy("用户的个人设置会保留，模型的组织范围会按新组织重新计算。", "The user's personal settings are preserved; the organization model boundary is recalculated for the new organization.")}</p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovingMember(null)} disabled={moving}>{copy("取消", "Cancel")}</Button>
            <Button onClick={() => void moveMember()} disabled={moving || movingMember?.deptId === moveTargetDeptId}>
              {moving ? copy("移动中…", "Moving…") : copy("确认移动", "Move user")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
