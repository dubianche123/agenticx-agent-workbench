"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@agenticx/ui";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Coins,
  FolderPlus,
  Gauge,
  MoreHorizontal,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import { adminFetch } from "../lib/admin-client-auth";
import {
  childrenByParent,
  deleteBlockedReason,
  departmentSubtreeIds,
  movableParentOptions,
  type DepartmentNode,
} from "../lib/department-tree";
import { MEMBER_DRAG_MIME, parseDragPayload } from "../lib/member-move";
import { useLocale } from "next-intl";

export type OrganizationNode = DepartmentNode;

/** 全部 / 未归属 这两档不是部门，用哨兵值表示，避免和真实部门 id 混。 */
export const ALL_DEPARTMENTS = "__all__";
export const NO_DEPARTMENT = "__none__";
/** 移动对话框里「挂到顶级」那一项。Select 不接受空字符串做值。 */
const ROOT_PARENT = "__root__";

export type DepartmentFilter = typeof ALL_DEPARTMENTS | typeof NO_DEPARTMENT | string;

export { departmentSubtreeIds };

/**
 * 部门行的落点。拖进来的必须是成员拖动才接——不然把一段文字拖到树上，整棵树都会亮。
 *
 * dragover 阶段拿不到 getData（浏览器只在 drop 时放行数据），所以靠 types 里有没有
 * 我们那个私有 MIME 来判断。
 */
function useMemberDropZone(
  onDropMembers: ((deptId: string | null, userIds: string[]) => void) | undefined,
  deptId: string | null,
) {
  const [over, setOver] = useState(false);
  if (!onDropMembers) return { over: false, handlers: {} as Record<string, never> };
  return {
    over,
    handlers: {
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes(MEMBER_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        setOver(false);
        const ids = parseDragPayload(event.dataTransfer.getData(MEMBER_DRAG_MIME));
        if (ids.length === 0) return;
        event.preventDefault();
        onDropMembers(deptId, ids);
      },
    },
  };
}

type PendingDialog =
  | { kind: "create"; parent: OrganizationNode | null }
  | { kind: "rename"; node: OrganizationNode }
  | { kind: "move"; node: OrganizationNode }
  | { kind: "delete"; node: OrganizationNode };

function Branch({
  node,
  children,
  selected,
  onSelect,
  onConfigureModels,
  onAction,
  onDropMembers,
  depth,
}: {
  node: OrganizationNode;
  children: Map<string | null, OrganizationNode[]>;
  selected: DepartmentFilter;
  onSelect: (value: DepartmentFilter) => void;
  onConfigureModels: (node: OrganizationNode) => void;
  onAction: (dialog: PendingDialog) => void;
  onDropMembers?: (deptId: string | null, userIds: string[]) => void;
  depth: number;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const childNodes = children.get(node.id) ?? [];
  const [open, setOpen] = useState(depth < 1);
  const isSelected = selected === node.id;
  const drop = useMemberDropZone(onDropMembers, node.id);

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md pr-1 text-sm ${
          drop.over
            ? "bg-primary/15 outline outline-2 outline-primary"
            : isSelected
              ? "bg-muted font-medium"
              : "hover:bg-muted/60"
        }`}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        {...drop.handlers}
      >
        {childNodes.length > 0 ? (
          <button
            type="button"
            aria-label={open ? copy("收起", "Collapse") : copy("展开", "Expand")}
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          className="min-w-0 flex-1 truncate py-1.5 text-left"
          onClick={() => onSelect(node.id)}
          title={node.path}
        >
          {node.name}
        </button>
        <span className="shrink-0 text-xs text-muted-foreground">{node.memberCount}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          title={copy("配置该部门的模型上限与额度", "Configure department model limits and quota")}
          onClick={() => onConfigureModels(node)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              title={`${copy("管理", "Manage")} “${node.name}”`}
              aria-label={`${copy("管理", "Manage")} “${node.name}”`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAction({ kind: "create", parent: node })}>
              <FolderPlus className="h-3.5 w-3.5" />
              {copy("新建子部门", "New subdepartment")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ kind: "rename", node })}>
              <Pencil className="h-3.5 w-3.5" />
              {copy("重命名", "Rename")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ kind: "move", node })}>
              <ChevronRight className="h-3.5 w-3.5" />
              {copy("移动到…", "Move to…")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onAction({ kind: "delete", node })}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {copy("删除", "Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open
        ? childNodes.map((child) => (
            <Branch
              key={child.id}
              node={child}
              children={children}
              selected={selected}
              onSelect={onSelect}
              onConfigureModels={onConfigureModels}
              onAction={onAction}
              onDropMembers={onDropMembers}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  );
}

/**
 * 成员列表左栏的组织树：既是筛选器，也是唯一的部门管理入口。
 *
 * 部门管理原本是一个独立菜单。菜单收掉之后这里只剩筛选，等于建子部门、改名、调结构
 * 全都没了地方——树看得见改不动。所以增删改挂回每个节点上：点部门筛人是高频操作，
 * 顺手就能改这个部门的名字、位置、模型上限。
 *
 * 写操作直接打接口而不是层层往上抛：调用方（成员页）只需要在结构变了之后重新拉一次
 * 数据，不必知道部门是怎么建的。
 */
export function DepartmentFilterTree({
  nodes,
  selected,
  onSelect,
  onConfigureModels,
  onConfigureDefaultMemberQuota,
  onConfigureOrganization,
  onChanged,
  onDropMembers,
  membersDragging = false,
  totalCount,
  unassignedCount,
}: {
  nodes: readonly OrganizationNode[];
  selected: DepartmentFilter;
  onSelect: (value: DepartmentFilter) => void;
  onConfigureModels: (node: OrganizationNode) => void;
  /** 普通成员默认上限。放在组织级更多菜单里，避免工具栏长期占位。 */
  onConfigureDefaultMemberQuota: () => void;
  /** 整个组织的共享上限，不属于任何一个部门节点。 */
  onConfigureOrganization: () => void;
  /** 结构改完之后重新拉数据。 */
  onChanged: () => void;
  /** 有人被拖到某个部门上。不传就没有拖放，其余功能照常。 */
  onDropMembers?: (deptId: string | null, userIds: string[]) => void;
  /** 正在拖成员。拖动期间才显示空的「未归属组织」——那是「移出部门」的落点。 */
  membersDragging?: boolean;
  totalCount: number;
  unassignedCount: number;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const children = useMemo(() => childrenByParent(nodes), [nodes]);
  const roots = children.get(null) ?? [];
  // 「未归属组织」也收拖放——把人移出部门，否则只能进不能出。
  const unassignedDrop = useMemberDropZone(onDropMembers, null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftParent, setDraftParent] = useState<string>(ROOT_PARENT);
  const [busy, setBusy] = useState(false);

  const openDialog = useCallback((next: PendingDialog) => {
    setDialog(next);
    setDraftName(next.kind === "rename" ? next.node.name : "");
    setDraftParent(next.kind === "move" ? next.node.parentId ?? ROOT_PARENT : ROOT_PARENT);
  }, []);

  const send = useCallback(
    async (path: string, method: string, body?: unknown) => {
      setBusy(true);
      try {
        const res = await adminFetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const json = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        if (!res.ok || (json.code && json.code !== "00000")) {
          // 后端把「还有子部门/还有人」回成错误码，直接抛给用户看是天书。
          throw new Error(deleteBlockedReason(json.message ?? "") ?? json.message ?? copy("操作失败", "Operation failed"));
        }
        setDialog(null);
        onChanged();
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : copy("操作失败", "Operation failed"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const confirm = useCallback(async () => {
    if (!dialog) return;
    const name = draftName.trim();
    if (dialog.kind === "create") {
      if (!name) return;
      const ok = await send("/api/admin/departments", "POST", {
        name,
        parentId: dialog.parent?.id ?? null,
      });
      if (ok) toast.success(`${copy("已建部门", "Department created")} “${name}”`);
      return;
    }
    if (dialog.kind === "rename") {
      if (!name || name === dialog.node.name) return;
      const ok = await send(
        `/api/admin/departments/${encodeURIComponent(dialog.node.id)}`,
        "PATCH",
        { name },
      );
      if (ok) toast.success(copy("已改名", "Renamed"));
      return;
    }
    if (dialog.kind === "move") {
      const parentId = draftParent === ROOT_PARENT ? null : draftParent;
      if (parentId === (dialog.node.parentId ?? null)) return;
      const ok = await send(
        `/api/admin/departments/${encodeURIComponent(dialog.node.id)}`,
        "PATCH",
        { parentId },
      );
      if (ok) toast.success(copy("已移动", "Moved"));
      return;
    }
    const ok = await send(
      `/api/admin/departments/${encodeURIComponent(dialog.node.id)}`,
      "DELETE",
    );
    if (ok) toast.success(`${copy("已删除", "Deleted")} “${dialog.node.name}”`);
  }, [dialog, draftName, draftParent, send]);

  // 只有一个顶级部门、又没有未归属的人时，「全部成员」和那个部门点下去结果一模一样。
  // 两行显示同一个数字、筛出同一批人，是纯噪音——这种时候只留部门那一行（它还带着
  // 模型上限和额度的入口），把「全部成员」隐掉。
  const allMembersIsRedundant = roots.length === 1 && unassignedCount === 0;

  return (
    <div className="space-y-0.5">
      <div className="mb-1 flex items-center justify-between gap-1 px-2">
        <span className="text-xs font-medium text-muted-foreground">{copy("组织", "Organization")}</span>
        <span className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            title={copy("新建顶级部门", "New top-level department")}
            aria-label={copy("新建顶级部门", "New top-level department")}
            onClick={() => openDialog({ kind: "create", parent: null })}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                title={copy("更多组织设置", "More organization settings")}
                aria-label={copy("更多组织设置", "More organization settings")}
                className="data-[state=open]:bg-muted"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>{copy("组织设置", "Organization settings")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onConfigureDefaultMemberQuota}>
                <Gauge className="h-3.5 w-3.5" />
                {copy("设置成员上限", "Set member limits")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onConfigureOrganization}>
                <Coins className="h-3.5 w-3.5" />
                {copy("管理 Token", "Manage Token")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {allMembersIsRedundant ? null : (
        <button
          type="button"
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${
            selected === ALL_DEPARTMENTS ? "bg-muted font-medium" : "hover:bg-muted/60"
          }`}
          onClick={() => onSelect(ALL_DEPARTMENTS)}
        >
          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{copy("全部成员", "All members")}</span>
          <span className="text-xs text-muted-foreground">{totalCount}</span>
        </button>
      )}
      {roots.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          {copy("还没有部门。建一个之后，模型范围和使用上限就能按部门设置。", "No departments yet. Create one to configure model scope and usage limits by department.")}
        </p>
      ) : null}
      {roots.map((node) => (
        <Branch
          key={node.id}
          node={node}
          children={children}
          selected={allMembersIsRedundant && selected === ALL_DEPARTMENTS ? node.id : selected}
          onSelect={onSelect}
          onConfigureModels={onConfigureModels}
          onAction={openDialog}
          onDropMembers={onDropMembers}
          depth={0}
        />
      ))}
      {unassignedCount > 0 || membersDragging ? (
        <button
          type="button"
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${
            unassignedDrop.over
              ? "bg-primary/15 outline outline-2 outline-primary"
              : selected === NO_DEPARTMENT
                ? "bg-muted font-medium"
                : "hover:bg-muted/60"
          }`}
          onClick={() => onSelect(NO_DEPARTMENT)}
          {...unassignedDrop.handlers}
        >
          <span className="w-3.5" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {unassignedCount === 0 && membersDragging ? copy("移出部门", "Remove from department") : copy("未归属组织", "Unassigned")}
          </span>
          <span className="text-xs text-muted-foreground">{unassignedCount}</span>
        </button>
      ) : null}

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? null : setDialog(null))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "create"
                ? dialog.parent
                  ? `${copy("在", "New subdepartment under")} “${dialog.parent.name}”`
                  : copy("新建顶级部门", "New top-level department")
                : dialog?.kind === "rename"
                  ? copy("重命名部门", "Rename department")
                  : dialog?.kind === "move"
                    ? `${copy("移动", "Move")} “${dialog.node.name}”`
                    : `${copy("删除", "Delete")} “${dialog?.node.name}”`}
            </DialogTitle>
            {dialog?.kind === "delete" ? (
              <DialogDescription>
                {copy("部门下还有子部门或成员时删不掉，会告诉你先处理哪一个。已经发给这个部门的模型上限和额度会一并失效。", "A department with subdepartments or members cannot be deleted. Move them first; its model limits and quota will also stop applying.")}
              </DialogDescription>
            ) : dialog?.kind === "move" ? (
              <DialogDescription>
                {copy("部门是模型上限的天花板，换了上级就跟着换一套。自己的子部门不在可选项里。", "A department sets the model ceiling. Moving it changes the inherited scope; its own subdepartments are excluded.")}
              </DialogDescription>
            ) : null}
          </DialogHeader>

          {dialog?.kind === "create" || dialog?.kind === "rename" ? (
            <div className="space-y-1.5">
              <Label className="text-xs">{copy("部门名称", "Department name")}</Label>
              <Input
                value={draftName}
                autoFocus
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void confirm();
                }}
                placeholder={copy("如：研发中心", "For example: Engineering")}
              />
            </div>
          ) : null}

          {dialog?.kind === "move" ? (
            <div className="space-y-1.5">
              <Label className="text-xs">{copy("移动到", "Move to")}</Label>
              <Select value={draftParent} onValueChange={setDraftParent}>
                <SelectTrigger>
                  <SelectValue placeholder={copy("选择上级部门", "Select a parent department")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT_PARENT}>{copy("（顶级，不挂在任何部门下）", "(Top level; no parent)")}</SelectItem>
                  {movableParentOptions(nodes, dialog.node.id).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.path || option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialog(null)} disabled={busy}>
              {copy("取消", "Cancel")}
            </Button>
            <Button
              size="sm"
              variant={dialog?.kind === "delete" ? "destructive" : "default"}
              disabled={
                busy ||
                ((dialog?.kind === "create" || dialog?.kind === "rename") && draftName.trim() === "")
              }
              onClick={() => void confirm()}
            >
              {dialog?.kind === "delete" ? copy("删除", "Delete") : copy("保存", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
