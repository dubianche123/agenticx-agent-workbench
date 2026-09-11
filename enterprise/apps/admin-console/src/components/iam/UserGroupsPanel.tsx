"use client";

import { OrganizationEditor } from "../../components/OrganizationEditor";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Textarea,
  toast,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@agenticx/ui";
import { ChevronDown, ChevronRight, CirclePlus, FolderTree, Pencil, RefreshCw, Trash2, UsersRound } from "lucide-react";
import { adminFetch } from "../../lib/admin-client-auth";
import {
  defaultGroupPackIds,
  groupAssignmentKey,
  groupPackBindingChanges,
} from "../../lib/capability-pack-form";
import {
  CAPABILITY_PACK_CONFLICT_MESSAGE,
  versionedCapabilityPackPatch,
} from "../../lib/capability-pack-concurrency";
import { UserDetailEditor, type UserDetailTarget } from "../../components/UserDetailEditor";
import { DEFAULT_PACK_SLUG } from "../../lib/default-capability-pack";
import { memberIdsInDepartmentSubtree } from "../../lib/department-tree";
import { withMemberRuleBatch } from "../../lib/user-group-member-rules";
import {
  SpendingLimitFields,
  ruleFromSpendingLimitDraft,
  spendingLimitDraft,
  type SpendingLimitDraft,
  type SpendingLimitRule,
} from "../metering/SpendingLimitEditor";

type OverviewMember = { id: string; displayName: string; email: string; deptId: string | null; usedTokens: number };
type GroupMemberOverview = OverviewMember & {
  monthlyTokens: number;
  unlimited: boolean;
  hasIndividualQuotaOverride: boolean;
  individualExtraModelIds: string[];
  hasIndividualOverride: boolean;
};
type OrganizationNode = { id: string; name: string; parentId: string | null; path: string; memberCount: number };
type GroupQuotaOverview = {
  id: string;
  name: string;
  description?: string;
  memberIds: string[];
  modelIds: string[];
  memberCount: number;
  members: GroupMemberOverview[];
};
type ModelOption = { id: string; providerLabel: string; label: string };
type ApiEnvelope<T> = { code: string; message: string; data?: T };
type EditorForm = { name: string; description: string; memberIds: string[]; modelIds: string[] };
/** 包的绑定不在用户组表里，存在包的 assignmentKeys 上；表单只是把它一起呈现出来。 */
type PackRow = {
  id: string;
  displayName: string;
  slug: string;
  status: string;
  assignmentKeys: string[];
  updatedAt: string;
};
type BudgetConfig = {
  updatedAt: string;
  users?: Record<string, SpendingLimitRule>;
};

const EMPTY_FORM: EditorForm = { name: "", description: "", memberIds: [], modelIds: [] };

function normalizedRuleKey(rule: SpendingLimitRule | undefined): string {
  if (!rule || Number(rule.limit) <= 0) return "inherit";
  return JSON.stringify(ruleFromSpendingLimitDraft(spendingLimitDraft(rule)));
}

function memberLimitSummary(
  memberIds: readonly string[],
  userRules: Record<string, SpendingLimitRule> | undefined,
): { draft: SpendingLimitDraft; mixed: boolean } {
  if (memberIds.length === 0) return { draft: spendingLimitDraft(null), mixed: false };
  const first = userRules?.[memberIds[0]!];
  const firstKey = normalizedRuleKey(first);
  return {
    draft: spendingLimitDraft(first),
    mixed: memberIds.some((id) => normalizedRuleKey(userRules?.[id]) !== firstKey),
  };
}

function MemberLimitBadge({ rule }: { rule?: SpendingLimitRule }) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (!rule || rule.limit <= 0) return <Badge variant="outline">{copy("继承上级", "Inherited")}</Badge>;
  const period = rule.period === "day" ? copy("日", "day") : rule.period === "week" ? copy("周", "week") : copy("月", "month");
  const value = rule.unit === "tokens"
    ? `${Math.floor(rule.limit).toLocaleString()} Token`
    : `$${rule.limit.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return <Badge variant="outline">{value} / {period}</Badge>;
}

function organizationChildren(nodes: OrganizationNode[]) {
  const children = new Map<string | null, OrganizationNode[]>();
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

function MemberLine({
  member,
  checked,
  selectable,
  onToggle,
}: {
  member: OverviewMember;
  checked?: boolean;
  selectable?: boolean;
  onToggle?: (id: string) => void;
}) {
  if (!selectable) {
    return (
      <div className="flex min-w-0 flex-col rounded-md px-2 py-1.5 text-sm">
        <span className="truncate">{member.displayName}</span>
        <span className="truncate text-xs text-muted-foreground">{member.email}</span>
      </div>
    );
  }
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
      <Checkbox checked={checked} onCheckedChange={() => onToggle?.(member.id)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{member.displayName}</span>
        <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
      </span>
    </label>
  );
}

function OrganizationBranch({
  node,
  children,
  membersByDept,
  memberIdsByDepartment,
  selectedIds,
  selectable,
  onToggle,
  onToggleDepartment,
  depth = 0,
}: {
  node: OrganizationNode;
  children: Map<string | null, OrganizationNode[]>;
  membersByDept: Map<string | null, OverviewMember[]>;
  memberIdsByDepartment: Map<string, string[]>;
  selectedIds: Set<string>;
  selectable?: boolean;
  onToggle?: (id: string) => void;
  onToggleDepartment?: (memberIds: string[]) => void;
  depth?: number;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const childNodes = children.get(node.id) ?? [];
  const members = membersByDept.get(node.id) ?? [];
  const subtreeMemberIds = memberIdsByDepartment.get(node.id) ?? [];
  const selectedCount = subtreeMemberIds.filter((id) => selectedIds.has(id)).length;
  const departmentChecked =
    subtreeMemberIds.length > 0 && selectedCount === subtreeMemberIds.length
      ? true
      : selectedCount > 0
        ? "indeterminate"
        : false;
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = childNodes.length > 0 || members.length > 0;
  return (
    <div>
      <div
        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <button
          type="button"
          className="rounded p-0.5"
          aria-label={open ? copy("收起部门", "Collapse department") : copy("展开部门", "Expand department")}
          onClick={() => hasChildren && setOpen((value) => !value)}
        >
          {hasChildren
            ? open
              ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
              : <ChevronRight className="h-4 w-4 text-muted-foreground" />
            : <span className="block w-4" />}
        </button>
        {selectable ? (
          <Checkbox
            checked={departmentChecked}
            disabled={subtreeMemberIds.length === 0}
            aria-label={copy(`选择 ${node.name} 整个部门（含子部门）`, `Select the entire ${node.name} department, including subdepartments`)}
            onCheckedChange={() => onToggleDepartment?.(subtreeMemberIds)}
          />
        ) : null}
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium"
          onClick={() => hasChildren && setOpen((value) => !value)}
        >
          {node.name}
        </button>
        <span className="text-xs text-muted-foreground">{node.memberCount}</span>
      </div>
      {open ? (
        <div>
          {members.map((member) => (
            <div key={member.id} style={{ paddingLeft: `${24 + depth * 16}px` }}>
              <MemberLine member={member} selectable={selectable} checked={selectedIds.has(member.id)} onToggle={onToggle} />
            </div>
          ))}
          {childNodes.map((child) => (
            <OrganizationBranch
              key={child.id}
              node={child}
              children={children}
              membersByDept={membersByDept}
              memberIdsByDepartment={memberIdsByDepartment}
              selectedIds={selectedIds}
              selectable={selectable}
              onToggle={onToggle}
              onToggleDepartment={onToggleDepartment}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OrganizationTree({
  nodes,
  users,
  selectedIds = new Set<string>(),
  selectable = false,
  onToggle,
  onToggleDepartment,
}: {
  nodes: OrganizationNode[];
  users: OverviewMember[];
  selectedIds?: Set<string>;
  selectable?: boolean;
  onToggle?: (id: string) => void;
  onToggleDepartment?: (memberIds: string[]) => void;
}) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const children = useMemo(() => organizationChildren(nodes), [nodes]);
  const membersByDept = useMemo(() => {
    const result = new Map<string | null, OverviewMember[]>();
    const departmentIds = new Set(nodes.map((node) => node.id));
    for (const user of users) {
      const departmentId = user.deptId && departmentIds.has(user.deptId) ? user.deptId : null;
      const current = result.get(departmentId) ?? [];
      current.push(user);
      result.set(departmentId, current);
    }
    for (const current of result.values()) current.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return result;
  }, [nodes, users]);
  const memberIdsByDepartment = useMemo(
    () => new Map(nodes.map((node) => [node.id, memberIdsInDepartmentSubtree(nodes, users, node.id)])),
    [nodes, users],
  );
  const roots = children.get(null) ?? [];
  const unassigned = membersByDept.get(null) ?? [];
  return (
    <div className="space-y-1">
      {roots.map((node) => (
        <OrganizationBranch
          key={node.id}
          node={node}
          children={children}
          membersByDept={membersByDept}
          memberIdsByDepartment={memberIdsByDepartment}
          selectedIds={selectedIds}
          selectable={selectable}
          onToggle={onToggle}
          onToggleDepartment={onToggleDepartment}
        />
      ))}
      {unassigned.length > 0 ? (
        <div className="pt-1">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{copy("未归属组织", "Unassigned")}</p>
          {unassigned.map((member) => (
            <MemberLine key={member.id} member={member} selectable={selectable} checked={selectedIds.has(member.id)} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
      {roots.length === 0 && unassigned.length === 0 ? <p className="px-2 py-4 text-sm text-muted-foreground">{copy("暂无用户", "No users")}</p> : null}
    </div>
  );
}

export function UserGroupsPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [groups, setGroups] = useState<GroupQuotaOverview[]>([]);
  const [organization, setOrganization] = useState<OrganizationNode[]>([]);
  const [users, setUsers] = useState<OverviewMember[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [orgOpen, setOrgOpen] = useState(false);
  const [editing, setEditing] = useState<GroupQuotaOverview | null | "new">(null);
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingMember, setEditingMember] = useState<UserDetailTarget | null>(null);
  const [packs, setPacks] = useState<PackRow[]>([]);
  const [packIds, setPackIds] = useState<string[]>([]);
  const [budget, setBudget] = useState<BudgetConfig | null>(null);
  const [memberLimitDraft, setMemberLimitDraft] = useState<SpendingLimitDraft>(() => spendingLimitDraft(null));
  const [memberLimitMixed, setMemberLimitMixed] = useState(false);
  const [applyMemberLimit, setApplyMemberLimit] = useState(false);
  const [createDefaultsSeeded, setCreateDefaultsSeeded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [groupsResponse, budgetResponse] = await Promise.all([
        adminFetch("/api/admin/user-groups/overview", { cache: "no-store" }),
        adminFetch("/api/metering/budget", { cache: "no-store" }),
      ]);
      const groupsJson = (await groupsResponse.json()) as ApiEnvelope<{
        groups: GroupQuotaOverview[];
        organization: OrganizationNode[];
        users: OverviewMember[];
      }>;
      const budgetJson = (await budgetResponse.json()) as ApiEnvelope<{ budget?: BudgetConfig }>;
      if (!groupsResponse.ok || groupsJson.code !== "00000") throw new Error(groupsJson.message || copy("加载用户组失败", "Failed to load user groups"));
      if (!budgetResponse.ok || budgetJson.code !== "00000" || !budgetJson.data?.budget) {
        throw new Error(budgetJson.message || copy("加载成员上限失败", "Failed to load member limits"));
      }
      setGroups(groupsJson.data?.groups ?? []);
      setOrganization(groupsJson.data?.organization ?? []);
      setUsers(groupsJson.data?.users ?? []);
      setBudget(budgetJson.data.budget);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("加载用户组失败", "Failed to load user groups"));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPacks = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/capability-packs", { cache: "no-store" });
      const json = (await response.json()) as { data?: { packs?: PackRow[] } };
      setPacks((json.data?.packs ?? []).filter((pack) => pack.status === "active"));
    } catch {
      // 拉不到就只是这一节为空，用户组本身照常能建。
    }
  }, []);

  const loadModelOptions = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/providers", { cache: "no-store" });
      const json = (await response.json()) as {
        data?: {
          providers: Array<{
            id: string;
            displayName: string;
            enabled: boolean;
            models: Array<{ name: string; label: string; enabled: boolean }>;
          }>;
        };
      };
      const options = (json.data?.providers ?? []).flatMap((provider) =>
        provider.enabled
          ? provider.models
              .filter((model) => model.enabled)
              .map((model) => ({
                id: `${provider.id}/${model.name}`,
                providerLabel: provider.displayName,
                label: model.label || model.name,
              }))
          : [],
      );
      setModelOptions(options.sort((a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.label.localeCompare(b.label)));
    } catch {
      setModelOptions([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadModelOptions();
    void loadPacks();
  }, [load, loadModelOptions, loadPacks]);

  const openCreate = () => {
    setEditing("new");
    setConfirmDelete(false);
    setForm({ ...EMPTY_FORM });
    const baselineIds = defaultGroupPackIds(packs, DEFAULT_PACK_SLUG);
    setPackIds(baselineIds);
    setCreateDefaultsSeeded(baselineIds.length > 0);
    setMemberLimitDraft(spendingLimitDraft(null));
    setMemberLimitMixed(false);
    setApplyMemberLimit(false);
  };

  const openEdit = (group: GroupQuotaOverview) => {
    setEditing(group);
    setConfirmDelete(false);
    setForm({
      name: group.name,
      description: group.description ?? "",
      memberIds: group.memberIds,
      modelIds: group.modelIds,
    });
    // 绑定关系是从包那边反查出来的，组自己不存这份数据。
    setPackIds(
      packs.filter((pack) => pack.assignmentKeys.includes(groupAssignmentKey(group.id))).map((p) => p.id),
    );
    const summary = memberLimitSummary(group.memberIds, budget?.users);
    setMemberLimitDraft(summary.draft);
    setMemberLimitMixed(summary.mixed);
    setApplyMemberLimit(false);
    setCreateDefaultsSeeded(true);
  };

  useEffect(() => {
    if (editing !== "new" || createDefaultsSeeded) return;
    const baselineIds = defaultGroupPackIds(packs, DEFAULT_PACK_SLUG);
    if (baselineIds.length === 0) return;
    setPackIds(baselineIds);
    setCreateDefaultsSeeded(true);
  }, [createDefaultsSeeded, editing, packs]);

  useEffect(() => {
    if (!editing || applyMemberLimit) return;
    const summary = memberLimitSummary(form.memberIds, budget?.users);
    setMemberLimitDraft(summary.draft);
    setMemberLimitMixed(summary.mixed);
  }, [applyMemberLimit, budget?.users, editing, form.memberIds]);



  const toggleMember = (id: string) => {
    setForm((current) => ({
      ...current,
      memberIds: current.memberIds.includes(id)
        ? current.memberIds.filter((memberId) => memberId !== id)
        : [...current.memberIds, id],
    }));
  };

  const toggleDepartmentMembers = (memberIds: string[]) => {
    setForm((current) => {
      const selected = new Set(current.memberIds);
      const allSelected = memberIds.length > 0 && memberIds.every((id) => selected.has(id));
      if (allSelected) memberIds.forEach((id) => selected.delete(id));
      else memberIds.forEach((id) => selected.add(id));
      return { ...current, memberIds: [...selected] };
    });
  };

  const toggleModel = (id: string) => {
    setForm((current) => ({
      ...current,
      modelIds: current.modelIds.includes(id)
        ? current.modelIds.filter((modelId) => modelId !== id)
        : [...current.modelIds, id],
    }));
  };

  const save = async () => {
    if (!editing || saving) return;
    if (!form.name.trim()) return toast.error("请输入用户组名称");
    if (applyMemberLimit && form.memberIds.length === 0) return toast.error("请先选择需要批量设置上限的成员");
    if (applyMemberLimit && memberLimitDraft.enabled && memberLimitDraft.limit <= 0) {
      return toast.error("成员个人上限必须大于 0");
    }
    setSaving(true);
    try {
      const isNew = editing === "new";
      const response = await adminFetch(isNew ? "/api/admin/user-groups" : `/api/admin/user-groups/${editing.id}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = (await response.json()) as ApiEnvelope<{
        removedMissingMembers?: number;
        group?: { id?: string; memberIds?: string[] };
      }>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || "保存失败");
      // 新建时组 id 到这一刻才存在，绑定只能等它出来再做。
      const groupId = isNew ? json.data?.group?.id : editing.id;
      if (groupId) await applyPackBindings(groupId);
      if (applyMemberLimit) {
        await applyLimitToMembers(json.data?.group?.memberIds ?? form.memberIds);
      }
      const removedMissingMembers = json.data?.removedMissingMembers ?? 0;
      toast.success(
        removedMissingMembers > 0
          ? `已自动移除 ${removedMissingMembers} 位已删除成员，用户组设置已保存`
          : isNew
            ? "用户组已创建并应用到成员"
            : "用户组设置已应用到成员",
      );
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  /** 用户组只是批量操作入口：一次改 members[] 对应的个人规则，不创造共享组额度。 */
  const applyLimitToMembers = async (memberIds: string[]) => {
    const latestResponse = await adminFetch("/api/metering/budget", { cache: "no-store" });
    const latestJson = (await latestResponse.json()) as ApiEnvelope<{ budget?: BudgetConfig }>;
    if (!latestResponse.ok || latestJson.code !== "00000" || !latestJson.data?.budget) {
      throw new Error(latestJson.message || "读取成员当前上限失败");
    }
    const latest = latestJson.data.budget;
    const users = withMemberRuleBatch(
      latest.users ?? {},
      memberIds,
      memberLimitDraft.enabled ? ruleFromSpendingLimitDraft(memberLimitDraft) : null,
    );
    const response = await adminFetch("/api/metering/budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt: latest.updatedAt, users }),
    });
    const json = (await response.json()) as ApiEnvelope<{ budget?: BudgetConfig }>;
    if (!response.ok || json.code !== "00000" || !json.data?.budget) {
      throw new Error(
        response.status === 409
          ? "成员上限刚被其他管理员修改，请重试"
          : json.message || "批量设置成员上限失败",
      );
    }
    setBudget(json.data.budget);
  };

  /**
   * 把「勾了哪些包」写回到包那一侧。
   *
   * 只动真的变了的那几个包，且每个包都在它当下的分配集合上增删这一个 key——整集覆盖会
   * 把包的部门分配、个人特批一起抹掉，那波及的是一批和这个组无关的人。
   */
  const applyPackBindings = async (groupId: string) => {
    const changes = groupPackBindingChanges(packs, groupAssignmentKey(groupId), packIds);
    const failed: string[] = [];
    const conflicted: string[] = [];
    for (const change of changes) {
      const pack = packs.find((item) => item.id === change.id);
      if (!pack) {
        failed.push(change.id);
        continue;
      }
      const res = await adminFetch(`/api/admin/capability-packs/${encodeURIComponent(change.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          versionedCapabilityPackPatch(pack.updatedAt, {
            assignmentKeys: change.assignmentKeys,
          }),
        ),
      });
      if (!res.ok) {
        (res.status === 409 ? conflicted : failed).push(pack.displayName || pack.slug);
      }
    }
    // 组本身已经保存成功了，这里失败不能把整次保存说成失败；但也不能不说。
    if (conflicted.length > 0) {
      toast.error(`${CAPABILITY_PACK_CONFLICT_MESSAGE}：${conflicted.join("、")}`);
    }
    if (failed.length > 0) toast.error(`${copy("能力包未更新", "Capability packs not updated")}: ${failed.join(", ")}`);
    if (changes.length > 0) await loadPacks();
  };

  const remove = async () => {
    if (!editing || editing === "new" || !confirmDelete || saving) return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/user-groups/${editing.id}`, { method: "DELETE" });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || "删除失败");
      toast.success("用户组已删除；成员和个人特例会保留");
      setEditing(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setSaving(false);
    }
  };

  const selectedIds = useMemo(() => new Set(form.memberIds), [form.memberIds]);
  const selectedModelIds = useMemo(() => new Set(form.modelIds), [form.modelIds]);
  const modelLabels = useMemo(() => new Map(modelOptions.map((model) => [model.id, model])), [modelOptions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-3xl text-sm text-muted-foreground">
          {copy("批量为一组成员分配能力、模型和个人使用上限。", "Assign capabilities, models, and personal limits to a group of members.")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOrgOpen(true)}>
            <FolderTree />{copy("编辑组织结构", "Edit organization")}
          </Button>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />{copy("刷新", "Refresh")}
          </Button>
          <Button onClick={openCreate}><CirclePlus />{copy("新建用户组", "New user group")}</Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {loading && groups.length === 0
          ? [1, 2, 3].map((key) => (
              <Card key={key} className="min-h-72">
                <CardHeader><Skeleton className="h-6 w-36" /><Skeleton className="h-4 w-48" /></CardHeader>
                <CardContent className="space-y-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></CardContent>
              </Card>
            ))
          : null}
        {!loading && groups.length === 0 ? (
          <Card className="border-dashed md:col-span-2 2xl:col-span-3">
            <CardContent className="flex min-h-64 flex-col items-center justify-center text-center">
              <span className="rounded-full bg-primary/10 p-3 text-primary"><UsersRound className="h-6 w-6" /></span>
              <h2 className="mt-4 font-semibold">{copy("先创建一个用户组", "Create a user group first")}</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">{copy("例如按组织、项目或岗位把用户放在一起，批量设置每人的额度和基础模型。", "Group members by organization, project, or role to set limits and base models in bulk.")}</p>
              <Button className="mt-4" onClick={openCreate}>{copy("新建用户组", "New user group")}</Button>
            </CardContent>
          </Card>
        ) : null}
        {groups.map((group) => (
          <Card
            key={group.id}
            className="group cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/20"
            onClick={() => openEdit(group)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="truncate">{group.name}</CardTitle>
                  <CardDescription className="mt-1 line-clamp-2 min-h-10">{group.description || copy("批量管理成员、能力包、模型与个人上限", "Manage members, capability packs, models, and personal limits in bulk")}</CardDescription>
                </div>
                <Badge variant="secondary" className="shrink-0">{copy("成员", "Members")} {group.memberCount}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{copy("成员", "Members")}</p>
                  <span className="inline-flex items-center gap-1 text-xs text-primary"><Pencil className="h-3 w-3" />{copy("编辑用户组", "Edit group")}</span>
                </div>
                <div className="grid max-h-72 gap-2 overflow-y-auto rounded-xl border border-border p-2 sm:grid-cols-2">
                  {group.members.length ? group.members.map((member) => (
                    <button
                      type="button"
                      key={member.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditingMember(member);
                      }}
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-left text-sm transition-colors hover:border-primary/50 hover:bg-muted"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{member.displayName.slice(0, 1)}</span>
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{member.displayName}</span><span className="block truncate text-xs text-muted-foreground">{member.email}</span></span>
                      {member.hasIndividualOverride || budget?.users?.[member.id] ? <Badge variant="outline" className="shrink-0 border-amber-500/50 px-1 py-0 text-[10px] text-amber-700 dark:text-amber-300">{copy("个人特例", "Personal override")}</Badge> : null}
                      <MemberLimitBadge rule={budget?.users?.[member.id]} />
                    </button>
                  )) : <span className="p-2 text-sm text-muted-foreground">{copy("尚未选择成员", "No members selected")}</span>}
                </div>
              </section>
              <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
                <section className="min-w-0 flex-1 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">{copy("基础可用模型", "Base models")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.modelIds.length ? group.modelIds.map((modelId) => {
                      const model = modelLabels.get(modelId);
                      return <Badge key={modelId} variant="outline" className="max-w-full truncate font-normal">{model?.label ?? modelId}</Badge>;
                    }) : <span className="text-sm text-muted-foreground">{copy("未指定基础模型", "No base models selected")}</span>}
                  </div>
                </section>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Sheet open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-2xl">
          {editing ? (
            <>
              <SheetHeader className="shrink-0 border-b border-border pb-5 pr-8">
                <SheetTitle>{editing === "new" ? copy("新建用户组", "New user group") : `${copy("编辑", "Edit")} ${editing.name}`}</SheetTitle>
                <SheetDescription className="mt-1">{copy("能力包与模型按组继承；个人上限只有在勾选“批量覆盖”时才会写入当前成员。", "Capability packs and models are inherited by group; personal limits are written only when bulk override is enabled.")}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-6 pr-1">
                <div className="space-y-2">
                  <Label htmlFor="group-name">{copy("用户组名称", "Group name")}</Label>
                  <Input id="group-name" value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} placeholder={copy("例如：项目成员", "For example: Project members")} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="group-description">{copy("说明（可选）", "Description (optional)")}</Label>
                  <Textarea id="group-description" value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} placeholder={copy("说明这组用户采用同一套设置的原因", "Explain why these members share the same settings")} className="min-h-20" />
                </div>
                <section className="space-y-3 rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-medium">{copy("成员个人上限 · 批量操作", "Member personal limits · bulk action")}</h2>
                      <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
                        {copy("这里不会创建“用户组共享额度”。保存时会把同一条 Token 或美元规则写到当前每位成员；以后个人修改或另一个用户组的批量操作可以再次覆盖。", "This does not create a shared group quota. Saving writes the same Token or USD rule to each member; personal edits or another group can override it later.")}
                      </p>
                    </div>
                    <Badge variant={memberLimitMixed ? "warning" : "secondary"}>
                      {memberLimitMixed ? copy("成员当前为混合设置", "Members have mixed settings") : copy("成员当前设置一致", "Members share the same setting")}
                    </Badge>
                  </div>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-muted/30 p-3 text-sm">
                    <Checkbox
                      checked={applyMemberLimit}
                      onCheckedChange={(checked) => {
                        const next = checked === true;
                        setApplyMemberLimit(next);
                        // 混合值不能拿第一位成员的规则冒充整组值；管理员勾选后必须明确选
                        // 择“设上限”或“恢复继承”，避免无意覆盖其他成员。
                        if (next && memberLimitMixed) setMemberLimitDraft(spendingLimitDraft(null));
                      }}
                    />
                    <span>
                      <span className="block font-medium">{copy("保存用户组时，统一覆盖当前成员的个人上限", "Override each member's personal limit when saving")}</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {copy("不勾选则只修改用户组成员、模型和能力包，成员现有上限保持不变。", "When off, only members, models, and packs change; existing limits stay unchanged.")}
                      </span>
                    </span>
                  </label>
                  {applyMemberLimit ? (
                    <SpendingLimitFields
                      draft={memberLimitDraft}
                      onChange={(next) => {
                        setMemberLimitDraft(next);
                        setMemberLimitMixed(false);
                      }}
                      enableLabel={copy("为这些成员设置个人上限", "Set a personal limit for these members")}
                      inheritDescription={copy("关闭后保存，会批量删除这些成员的个人规则，让每个人恢复继承部门或默认设置。", "When saved off, remove each member's personal rule and restore department or default inheritance.")}
                      limitLabel={copy("每人上限", "Per-member limit")}
                      idPrefix="user-group-member-limit"
                    />
                  ) : null}
                </section>
                <section className="space-y-3">
                  <div>
                    <h2 className="text-sm font-medium">{copy("基础可用模型", "Base models")}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{copy("组内成员会拿到这些模型；所在部门的上限仍然优先，超出上限的进不来。属于多个组的人取并集。", "Members receive these models. Department limits still take precedence, and members of multiple groups receive the union.")}</p>
                  </div>
                  <div className="grid max-h-64 gap-2 overflow-y-auto rounded-xl border border-border p-3 sm:grid-cols-2">
                    {modelOptions.length ? modelOptions.map((model) => (
                      <label key={model.id} className="flex cursor-pointer items-start gap-2 rounded-lg p-2 text-sm hover:bg-muted">
                        <Checkbox checked={selectedModelIds.has(model.id)} onCheckedChange={() => toggleModel(model.id)} />
                        <span className="min-w-0"><span className="block truncate font-medium">{model.label}</span><span className="block truncate text-xs text-muted-foreground">{model.providerLabel} · {model.id}</span></span>
                      </label>
                    )) : <p className="col-span-full p-2 text-sm text-muted-foreground">{copy("暂无可下发的已启用模型", "No enabled models available for delivery")}</p>}
                  </div>
                </section>
                <section className="space-y-3">
                  <div>
                    <h2 className="text-sm font-medium">{copy("能力包", "Capability packs")}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {copy("组里的人会拿到这些包里的 Skill、MCP 和平台功能。绑定存在包那一侧，所以在能力包页面也看得到这个组；属于多个组的人取并集。", "Members receive the Skills, MCP tools, and platform features in these packs. Bindings live on the pack and members of multiple groups receive the union.")}
                    </p>
                  </div>
                  <div className="grid max-h-48 gap-2 overflow-y-auto rounded-xl border border-border p-3 sm:grid-cols-2">
                    {packs.length ? (
                      packs.map((pack) => (
                        <label
                          key={pack.id}
                          className="flex cursor-pointer items-start gap-2 rounded-lg p-2 text-sm hover:bg-muted"
                        >
                          <Checkbox
                            checked={packIds.includes(pack.id)}
                            onCheckedChange={() =>
                              setPackIds((current) =>
                                current.includes(pack.id)
                                  ? current.filter((id) => id !== pack.id)
                                  : [...current, pack.id],
                              )
                            }
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {pack.displayName || pack.slug}
                              {pack.slug === DEFAULT_PACK_SLUG ? (
                                <Badge variant="secondary" className="ml-2 align-middle text-[10px]">{copy("新建时默认", "Default for new groups")}</Badge>
                              ) : null}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {pack.slug}
                            </span>
                          </span>
                        </label>
                      ))
                    ) : (
                      <p className="col-span-full p-2 text-sm text-muted-foreground">
                        {copy("还没有启用的能力包。到「工具与能力 · 能力包」里建一个。", "No active capability packs. Create one under Tools & Capabilities · Packs.")}
                      </p>
                    )}
                  </div>
                </section>
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-medium">{copy("从组织结构选择用户", "Select members from the organization")}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">{copy("已选择", "Selected")} {form.memberIds.length} {copy("位用户；组织归属不会改变。", "members; organization assignments stay unchanged.")}</p>
                    </div>
                    <Badge variant="secondary">{form.memberIds.length} {copy("人", "members")}</Badge>
                  </div>
                  <div className="max-h-[360px] overflow-y-auto rounded-xl border border-border p-2">
                    <OrganizationTree
                      nodes={organization}
                      users={users}
                      selectable
                      selectedIds={selectedIds}
                      onToggle={toggleMember}
                      onToggleDepartment={toggleDepartmentMembers}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{copy("同一用户可属于多个用户组，可见模型取并集；额度按人单独设置，不再随用户组下发。", "A member can belong to multiple groups; visible models are combined, while limits are set per member rather than delivered by the group.")}</p>
                </section>
                {editing !== "new" ? (
                  <section className="space-y-3 border-t border-border pt-5">
                    <div>
                      <h2 className="text-sm font-medium text-destructive">{copy("删除用户组", "Delete user group")}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">{copy("不会删除用户、组织结构或该用户已有的个人设置。", "Users, organization structure, and existing personal settings are preserved.")}</p>
                    </div>
                    {confirmDelete ? (
                      <div className="flex items-center gap-2">
                        <Button variant="destructive" size="sm" onClick={() => void remove()} disabled={saving}>{copy("再次确认删除", "Confirm delete")}</Button>
                        <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>{copy("取消", "Cancel")}</Button>
                      </div>
                    ) : (
                      <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                        <Trash2 />{copy("删除用户组", "Delete user group")}
                      </Button>
                    )}
                  </section>
                ) : null}
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t border-border pt-4">
                <Button variant="outline" onClick={() => setEditing(null)}>{copy("关闭", "Close")}</Button>
                <Button onClick={() => void save()} disabled={saving}>{saving ? copy("保存中…", "Saving…") : copy("保存并应用", "Save & apply")}</Button>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <UserDetailEditor
        target={editingMember}
        onOpenChange={(open) => {
          if (!open) setEditingMember(null);
        }}
        onChanged={load}
      />
    {/* 组织结构直接在这儿编，不再跳去 /iam/bulk-import 那个老页面。
        跳走的代价是回来之后这一页的数据是旧的，而且那页还带着一整套批量导入。 */}
      <Dialog open={orgOpen} onOpenChange={(open) => { setOrgOpen(open); if (!open) void load(); }}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{copy("组织结构", "Organization structure")}</DialogTitle>
            <DialogDescription>{copy("增删部门、调整层级。改完关窗，本页会重新加载。", "Add, remove, or reorder departments. Close the dialog to reload this page.")}</DialogDescription>
          </DialogHeader>
          <OrganizationEditor />
        </DialogContent>
      </Dialog>

    </div>
  );
}
