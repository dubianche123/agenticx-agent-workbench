"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  toast,
} from "@agenticx/ui";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useLocale } from "next-intl";
import { adminFetch } from "../lib/admin-client-auth";
import { formatTokenCount } from "./QuotaRing";
import { BudgetScopeEditor } from "./metering/BudgetScopeEditor";
import {
  UserFormFields,
  type UserFormDeptOption,
  type UserFormValues,
} from "./UserFormDialog";
import { RoleBindingEditor } from "./iam/RoleBindingEditor";

type UserModelSummary = { model: string; tokens: number; currentlyAllowed: boolean };

export type UserDetailOverview = {
  id: string;
  displayName: string;
  email: string;
  deptId: string | null;
  departmentName?: string;
  departmentPath?: string;
  status: "active" | "disabled" | "locked";
  phone: string | null;
  employeeNo: string | null;
  jobTitle: string | null;
  usedTokens: number;
  monthlyTokens: number;
  unlimited: boolean;
  inherited: boolean;
  quotaSource: "group" | "personal" | "default";
  quotaSourceLabel?: string;
  groupNames: string[];
  models: UserModelSummary[];
};

export type UserDetailTarget = Pick<UserDetailOverview, "id" | "displayName" | "email"> &
  Partial<Omit<UserDetailOverview, "id" | "displayName" | "email">>;

type ModelOption = { id: string; providerLabel: string; label: string };
type ModelAccess = {
  parentAllowedIds: string[];
  individualModelIds?: string[];
  groupModelIds?: string[];
  excludedGroupModelIds?: string[];
  groupModelSources?: Array<{ id: string; name: string; modelIds: string[] }>;
  effectiveModelIds?: string[];
};
type ApiEnvelope<T> = { code: string; message: string; data?: T };
type EditableUser = {
  id: string;
  email: string;
  displayName: string;
  status: "active" | "disabled" | "locked";
  deptId: string | null;
  phone: string | null;
  employeeNo: string | null;
  jobTitle: string | null;
  roleCodes: string[];
};

type UserDetailEditorProps = {
  target: UserDetailTarget | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void | Promise<void>;
};

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function quotaSourceLabel(user: UserDetailOverview, locale = "zh"): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (user.quotaSource === "group") {
    return user.quotaSourceLabel ? `${copy("继承自", "Inherited from")} ${user.quotaSourceLabel}` : copy("继承自用户组", "Inherited from user group");
  }
  if (user.quotaSource === "personal") return copy("个人设置", "Personal settings");
  return copy("默认设置", "Default settings");
}

export function UserDetailEditor({ target, onOpenChange, onChanged }: UserDetailEditorProps) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [overview, setOverview] = useState<UserDetailOverview | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelAccess, setModelAccess] = useState<ModelAccess | null>(null);
  const [manualModelIds, setManualModelIds] = useState<string[]>([]);
  const [initialManualModelIds, setInitialManualModelIds] = useState<string[]>([]);
  const [excludedGroupModelIds, setExcludedGroupModelIds] = useState<string[]>([]);
  const [initialExcludedGroupModelIds, setInitialExcludedGroupModelIds] = useState<string[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetPasswordPending, setResetPasswordPending] = useState(false);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [userFormInitial, setUserFormInitial] = useState<UserFormValues | null>(null);
  const [userFormDeptOptions, setUserFormDeptOptions] = useState<UserFormDeptOption[]>([]);
  const [principalId, setPrincipalId] = useState<string | null>(null);
  const [principalLoadError, setPrincipalLoadError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await adminFetch("/api/auth/session", { cache: "no-store" });
        const json = (await response.json()) as { data?: { userId?: string } };
        if (active) setCurrentUserId(json.data?.userId ?? null);
      } catch {
        // 删除接口仍会在服务端阻止删除当前登录用户。
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!target) {
      setOverview(null);
      setUserFormInitial(null);
      setPrincipalId(null);
      setPrincipalLoadError(null);
      return;
    }

    let active = true;
    const userId = target.id;
    setOverview(null);
    setUserFormInitial(null);
    setUserFormDeptOptions([]);
    setPrincipalId(null);
    setPrincipalLoadError(null);
    setModelOptions([]);
    setModelAccess(null);
    setManualModelIds([]);
    setInitialManualModelIds([]);
    setExcludedGroupModelIds([]);
    setInitialExcludedGroupModelIds([]);
    setResetPasswordPending(false);
    setNewPassword(null);
    setLoadingDetails(true);
    setLoadingModels(true);

    void (async () => {
      try {
        const [overviewResponse, modelResponse, userResponse, departmentResponse, principalResponse, providerResponse] =
          await Promise.all([
            adminFetch("/api/admin/users/quota-overview", { cache: "no-store" }),
            adminFetch(`/api/admin/users/${encodeURIComponent(userId)}/models`, { cache: "no-store" }),
            adminFetch(`/api/admin/users/${encodeURIComponent(userId)}`, { cache: "no-store" }),
            adminFetch("/api/admin/departments?shape=flat", { cache: "no-store" }),
            adminFetch(`/api/admin/principals?kind=user&userId=${encodeURIComponent(userId)}&limit=1`, { cache: "no-store" }),
            adminFetch("/api/admin/providers", { cache: "no-store" }),
          ]);
        const [overviewJson, modelJson, userJson, departmentJson, principalJson, providerJson] = await Promise.all([
          overviewResponse.json() as Promise<ApiEnvelope<{ items: UserDetailOverview[] }>>,
          modelResponse.json() as Promise<ApiEnvelope<ModelAccess>>,
          userResponse.json() as Promise<ApiEnvelope<{ user: EditableUser }>>,
          departmentResponse.json() as Promise<ApiEnvelope<{ items: Array<{ id: string; name: string; path: string }> }>>,
          principalResponse.json() as Promise<ApiEnvelope<{ items?: Array<{ id: string; kind: "user" | "agent"; userId?: string | null }> }>>,
          providerResponse.json() as Promise<{
            data?: {
              providers: Array<{
                id: string;
                displayName: string;
                enabled: boolean;
                models: Array<{ name: string; label: string; enabled: boolean }>;
              }>;
            };
          }>,
        ]);
        if (!active) return;

        const selectedOverview = overviewJson.data?.items.find((item) => item.id === userId);
        if (!overviewResponse.ok || overviewJson.code !== "00000" || !selectedOverview) {
          throw new Error(overviewJson.message || copy("加载用户额度信息失败", "Failed to load user quota"));
        }
        if (!userResponse.ok || userJson.code !== "00000" || !userJson.data?.user) {
          throw new Error(userJson.message || copy("加载用户信息失败", "Failed to load user profile"));
        }
        if (!departmentResponse.ok || departmentJson.code !== "00000") {
          throw new Error(departmentJson.message || copy("加载部门失败", "Failed to load departments"));
        }
        setOverview(selectedOverview);
        const editableUser = userJson.data.user;
        setUserFormInitial({
          email: editableUser.email,
          displayName: editableUser.displayName,
          status: editableUser.status,
          deptId: editableUser.deptId ?? "",
          phone: editableUser.phone ?? "",
          employeeNo: editableUser.employeeNo ?? "",
          jobTitle: editableUser.jobTitle ?? "",
          roleCodes: editableUser.roleCodes.length ? editableUser.roleCodes : ["member"],
          initialPassword: "",
        });
        setUserFormDeptOptions(
          (departmentJson.data?.items ?? []).map((department) => ({
            id: department.id,
            label: `${department.name}（${department.path}）`,
          })),
        );
        if (principalResponse.ok && principalJson.code === "00000") {
          setPrincipalId(principalJson.data?.items?.find((principal) => principal.kind === "user")?.id ?? null);
        } else {
          setPrincipalLoadError(principalJson.message || copy("加载角色授权失败", "Failed to load role bindings"));
        }

        const options = (providerJson.data?.providers ?? []).flatMap((provider) =>
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
        setModelOptions(
          options.sort(
            (left, right) =>
              left.providerLabel.localeCompare(right.providerLabel) || left.label.localeCompare(right.label),
          ),
        );

        if (!modelResponse.ok || modelJson.code !== "00000" || !modelJson.data) {
          toast.error(modelJson.message || copy("加载可用模型失败", "Failed to load available models"));
          return;
        }
        const groupModelIds = new Set(modelJson.data.groupModelIds ?? []);
        const individualModelIds = (modelJson.data.individualModelIds ?? []).filter(
          (modelId) => !groupModelIds.has(modelId),
        );
        setModelAccess(modelJson.data);
        setManualModelIds(individualModelIds);
        setInitialManualModelIds(individualModelIds);
        const excludedIds = modelJson.data.excludedGroupModelIds ?? [];
        setExcludedGroupModelIds(excludedIds);
        setInitialExcludedGroupModelIds(excludedIds);
      } catch (error) {
        if (active) toast.error(error instanceof Error ? error.message : copy("加载用户详细信息失败", "Failed to load user details"));
      } finally {
        if (active) {
          setLoadingDetails(false);
          setLoadingModels(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [target]);

  const groupModelIdSet = useMemo(() => new Set(modelAccess?.groupModelIds ?? []), [modelAccess]);
  const excludedGroupModelIdSet = useMemo(() => new Set(excludedGroupModelIds), [excludedGroupModelIds]);
  const parentAllowedModelIdSet = useMemo(() => new Set(modelAccess?.parentAllowedIds ?? []), [modelAccess]);
  const visibleModelIds = useMemo(() => {
    if (!modelAccess) return new Set<string>();
    if (groupModelIdSet.size > 0) {
      return new Set([
        ...(modelAccess.groupModelIds ?? []).filter((modelId) => !excludedGroupModelIdSet.has(modelId)),
        ...manualModelIds,
      ]);
    }
    if (manualModelIds.length > 0) return new Set(manualModelIds);
    return new Set(modelAccess.parentAllowedIds);
  }, [excludedGroupModelIdSet, groupModelIdSet, manualModelIds, modelAccess]);

  const toggleModel = (modelId: string) => {
    if (!modelAccess || !parentAllowedModelIdSet.has(modelId)) return;
    if (groupModelIdSet.has(modelId)) {
      setExcludedGroupModelIds((current) =>
        current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId],
      );
      return;
    }
    setManualModelIds((current) => {
      const next = new Set(current);
      if (next.size === 0 && groupModelIdSet.size === 0) {
        for (const id of modelAccess.effectiveModelIds ?? modelAccess.parentAllowedIds) next.add(id);
      }
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return [...next];
    });
  };

  const closeAndRefresh = async () => {
    onOpenChange(false);
    await onChanged?.();
  };

  const save = async () => {
    if (!overview || !userFormInitial || saving || loadingDetails) return;
    if (!userFormInitial.email.trim() || !userFormInitial.displayName.trim()) {
      toast.error(copy("请填写邮箱和姓名", "Enter an email and name"));
      return;
    }
    const modelsChanged =
      !sameIds(manualModelIds, initialManualModelIds) ||
      !sameIds(excludedGroupModelIds, initialExcludedGroupModelIds);
    setSaving(true);
    try {
      const requests: Promise<Response>[] = [
        adminFetch(`/api/admin/users/${encodeURIComponent(overview.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: userFormInitial.email.trim(),
            displayName: userFormInitial.displayName.trim(),
            status: userFormInitial.status,
            deptId: userFormInitial.deptId || null,
            phone: userFormInitial.phone.trim() || null,
            employeeNo: userFormInitial.employeeNo.trim() || null,
            jobTitle: userFormInitial.jobTitle.trim() || null,
          }),
        }),
      ];
      if (modelsChanged) {
        requests.push(
          adminFetch(`/api/admin/users/${encodeURIComponent(overview.id)}/models`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelIds: manualModelIds, excludedGroupModelIds }),
          }),
        );
      }
      const responses = await Promise.all(requests);
      for (const response of responses) {
        const json = (await response.json()) as ApiEnvelope<unknown>;
        if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("保存失败", "Save failed"));
      }
      toast.success(copy("用户详细信息已保存", "User details saved"));
      await closeAndRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("保存失败", "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async () => {
    if (!overview || saving) return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/users/${encodeURIComponent(overview.id)}/reset-password`, {
        method: "POST",
      });
      const json = (await response.json()) as ApiEnvelope<{ initialPassword?: string }>;
      if (!response.ok || !json.data?.initialPassword) throw new Error(json.message || copy("重置密码失败", "Failed to reset password"));
      setNewPassword(json.data.initialPassword);
      setResetPasswordPending(false);
      toast.success(copy("已生成新的登录密码", "A new login password was generated"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("重置密码失败", "Failed to reset password"));
    } finally {
      setSaving(false);
    }
  };

  const deleteUser = async () => {
    if (!overview || saving) return;
    if (overview.id === currentUserId) {
      toast.error(copy("不能删除当前登录用户", "You cannot delete the current user"));
      return;
    }
    if (!window.confirm(`${copy("确认删除用户", "Delete user")} ${overview.email}? ${copy("该操作不可撤销。", "This cannot be undone.")}`)) return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/users/${encodeURIComponent(overview.id)}`, { method: "DELETE" });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("删除用户失败", "Failed to delete user"));
      toast.success(`${copy("用户已删除", "User deleted")}: ${overview.email}`);
      await closeAndRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("删除用户失败", "Failed to delete user"));
    } finally {
      setSaving(false);
    }
  };

  const copyPassword = async () => {
    if (!newPassword) return;
    try {
      await navigator.clipboard.writeText(newPassword);
      toast.success(copy("新密码已复制", "New password copied"));
    } catch {
      toast.error(copy("复制失败，请手动复制密码", "Copy failed; copy the password manually"));
    }
  };

  const displayName = overview?.displayName ?? target?.displayName ?? copy("用户", "User");
  const email = overview?.email ?? target?.email ?? "";

  return (
    <Sheet open={Boolean(target)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-3xl">
        {target ? (
          <>
            <SheetHeader className="shrink-0 border-b border-border pb-5 pr-8">
              <SheetTitle>{copy("详细编辑", "Edit details")}</SheetTitle>
              <SheetDescription>{copy("统一维护用户资料、角色、个人额度、可用模型、登录密码和账号状态。", "Manage profile, roles, personal quota, available models, login password, and account status in one place.")}</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-6 pr-1">
              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <p className="font-medium">{displayName}</p>
                {overview ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {copy("本月已用", "Used this month")} {formatTokenCount(overview.usedTokens)} Token · {quotaSourceLabel(overview, locale)}
                  </p>
                ) : (
                  <Skeleton className="mt-2 h-4 w-52" />
                )}
                <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <p className="break-all sm:col-span-2"><span className="text-muted-foreground">{copy("邮箱：", "Email: ")}</span>{email}</p>
                  {overview ? (
                    <>
                      <p><span className="text-muted-foreground">{copy("部门：", "Department: ")}</span>{overview.departmentPath || overview.departmentName || copy("未归属组织", "Unassigned")}</p>
                      {overview.jobTitle ? <p><span className="text-muted-foreground">{copy("岗位：", "Job title: ")}</span>{overview.jobTitle}</p> : null}
                      <p><span className="text-muted-foreground">{copy("状态：", "Status: ")}</span>{overview.status === "active" ? copy("正常", "Active") : overview.status === "locked" ? copy("已锁定", "Locked") : copy("已停用", "Disabled")}</p>
                    </>
                  ) : null}
                </div>
              </div>

              <section className="space-y-3">
                <div>
                  <h2 className="text-sm font-medium">{copy("基本资料", "Profile")}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{copy("维护姓名、邮箱、组织、职位和账号状态。角色授权请在下方单独管理。", "Manage name, email, organization, job title, and account status. Manage role bindings separately below.")}</p>
                </div>
                {loadingDetails ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[1, 2, 3, 4, 5, 6].map((key) => <Skeleton key={key} className="h-10" />)}
                  </div>
                ) : userFormInitial ? (
                  <UserFormFields
                    values={userFormInitial}
                    onChange={setUserFormInitial}
                    deptOptions={userFormDeptOptions}
                    roleOptions={[]}
                    showRoles={false}
                    idPrefix={`user-detail-${target.id}`}
                  />
                ) : (
                  <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    {copy("用户资料加载失败，请关闭后重试。", "User profile failed to load. Close and try again.")}
                  </p>
                )}
              </section>

              <section className="space-y-3">
                <div>
                  <h2 className="text-sm font-medium">{copy("角色授权", "Role bindings")}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{copy("角色、数据范围和有效期决定该用户的实际企业权限。", "Roles, data ranges, and validity determine this user's effective enterprise access.")}</p>
                </div>
                {principalLoadError ? (
                  <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{principalLoadError}</p>
                ) : principalId ? (
                  <RoleBindingEditor principalId={principalId} principalKind="user" onChanged={onChanged} />
                ) : (
                  <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                    {copy("该用户尚未建立可管理的主体授权记录。", "This user does not have a manageable principal authorization record yet.")}
                  </p>
                )}
              </section>

              <section className="space-y-3">
                <div>
                  <h2 className="text-sm font-medium">{copy("可用模型", "Available models")}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{copy("可用模型高亮；灰色模型受组织上限限制。用户可关闭来自用户组的模型，也可额外开通组织允许的模型。", "Available models are highlighted. Gray models are restricted by organization limits. Members can disable group models or enable additional organization-approved models.")}</p>
                </div>
                {loadingModels ? (
                  <div className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-2">
                    {[1, 2, 3, 4].map((key) => <Skeleton key={key} className="h-16" />)}
                  </div>
                ) : (
                  <>
                    {modelAccess?.groupModelSources?.length ? (
                      <div className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                        {modelAccess.groupModelSources.map((group) => (
                          <span key={group.id}>{group.name} · {group.modelIds.length} {copy("个模型", "models")}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="grid max-h-80 gap-2 overflow-y-auto rounded-xl border border-border p-3 sm:grid-cols-2">
                      {modelOptions.length ? modelOptions.map((model) => {
                        const allowedByOrganization = parentAllowedModelIdSet.has(model.id);
                        const inheritedFromGroup = groupModelIdSet.has(model.id);
                        const excludedFromGroup = inheritedFromGroup && excludedGroupModelIdSet.has(model.id);
                        const individualExtra = manualModelIds.includes(model.id);
                        const available = allowedByOrganization && visibleModelIds.has(model.id);
                        return (
                          <label
                            key={model.id}
                            className={`flex items-start gap-2 rounded-lg border p-2 text-sm ${!allowedByOrganization || !modelAccess ? "cursor-not-allowed border-transparent bg-muted/50 opacity-45" : available ? "cursor-pointer border-primary/30 bg-primary/5" : "cursor-pointer border-transparent bg-muted/30 hover:bg-muted"}`}
                          >
                            <Checkbox
                              checked={available}
                              disabled={!allowedByOrganization || !modelAccess}
                              onCheckedChange={() => toggleModel(model.id)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate font-medium">{model.label}</span>
                                {!allowedByOrganization ? <Badge variant="outline">{copy("组织不可用", "Unavailable to organization")}</Badge> : excludedFromGroup ? <Badge variant="outline">{copy("个人关闭", "Disabled personally")}</Badge> : inheritedFromGroup ? <Badge variant="secondary">{copy("用户组", "Group")}</Badge> : individualExtra ? <Badge variant="outline">{copy("个人特例", "Personal override")}</Badge> : available ? <Badge variant="secondary">{copy("可用", "Available")}</Badge> : <Badge variant="outline">{copy("未开通", "Not enabled")}</Badge>}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">{model.providerLabel} · {model.id}</span>
                            </span>
                          </label>
                        );
                      }) : <p className="col-span-full p-2 text-sm text-muted-foreground">{copy("暂无可配置的已启用模型", "No enabled models can be configured")}</p>}
                    </div>
                  </>
                )}
              </section>

              <section className="space-y-3 border-t border-border pt-5">
                <BudgetScopeEditor scope="users" id={target.id} onSaved={onChanged} />
              </section>

              <section className="space-y-3 border-t border-border pt-5">
                <div>
                  <h2 className="text-sm font-medium">{copy("登录密码", "Login password")}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{copy("重置后会生成新的随机登录密码，并解除该用户的登录锁定状态。", "Resetting generates a random login password and unlocks the account.")}</p>
                </div>
                {newPassword ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
                    <code className="min-w-0 flex-1 break-all text-sm font-medium">{newPassword}</code>
                    <Button size="sm" variant="outline" onClick={() => void copyPassword()}><Copy />{copy("复制", "Copy")}</Button>
                  </div>
                ) : resetPasswordPending ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                    <span className="flex-1">{copy("确认要为", "Generate a new random password for")} {displayName}?</span>
                    <Button size="sm" variant="outline" onClick={() => setResetPasswordPending(false)} disabled={saving}>{copy("取消", "Cancel")}</Button>
                    <Button size="sm" onClick={() => void resetPassword()} disabled={saving}>{saving ? copy("重置中…", "Resetting…") : copy("确认重置", "Confirm reset")}</Button>
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => setResetPasswordPending(true)} disabled={saving || !overview}><KeyRound />{copy("重置登录密码", "Reset login password")}</Button>
                )}
              </section>
            </div>

            <div className="shrink-0 flex flex-wrap justify-between gap-2 border-t border-border bg-background pt-4">
              <Button
                variant="destructive"
                onClick={() => void deleteUser()}
                disabled={saving || !overview || overview.id === currentUserId}
                title={overview?.id === currentUserId ? copy("不能删除当前登录用户", "You cannot delete the current user") : copy("删除用户", "Delete user")}
              >
                <Trash2 />{copy("删除用户", "Delete user")}
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>{copy("取消", "Cancel")}</Button>
                <Button onClick={() => void save()} disabled={saving || loadingModels || loadingDetails || !overview || !userFormInitial}>
                  {saving ? copy("保存中…", "Saving…") : copy("保存详细信息", "Save details")}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
