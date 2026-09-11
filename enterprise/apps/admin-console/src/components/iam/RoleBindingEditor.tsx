"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from "@agenticx/ui";
import { CalendarClock, Link2, Plus, Trash2 } from "lucide-react";
import { useLocale } from "next-intl";
import { adminFetch } from "../../lib/admin-client-auth";

export type PrincipalKind = "user" | "agent";
export type PrincipalRoleOption = {
  id: string;
  code: string;
  name?: string;
  immutable?: boolean;
  scopes?: string[];
};
export type PrincipalScopeOption = {
  value: "self" | "department" | "department_subtree" | "tenant";
  label: string;
  labelEn?: string;
  description?: string;
  descriptionEn?: string;
};
export type PrincipalRoleBinding = {
  id: string;
  principalId?: string;
  roleId?: string;
  roleCode: string;
  roleName?: string | null;
  scopes?: string[];
  dataScope: "self" | "department" | "department_subtree" | "tenant";
  scopeOrgId?: string | null;
  scopeDeptId?: string | null;
  scopeName?: string | null;
  expiresAt?: string | null;
  resolution?: "resolved" | "unresolved" | null;
  resolutionReason?: string | null;
  createdByUserId?: string | null;
  source?: "legacy" | "explicit" | null;
  status?: "active" | "revoked" | null;
};

type ApiEnvelope<T> = { code: string; message: string; data?: T };
type BindingPayload = {
  bindings?: PrincipalRoleBinding[];
  grantableRoles?: PrincipalRoleOption[];
  grantableScopes?: PrincipalScopeOption[];
  permissions?: { canAssign?: boolean };
};
type RoleBindingEditorProps = {
  principalId: string | null;
  principalKind?: PrincipalKind;
  readOnly?: boolean;
  allowSelfScope?: boolean;
  onChanged?: () => void | Promise<void>;
  className?: string;
};

function scopeLabel(binding: PrincipalRoleBinding, locale: string, allowSelfScope: boolean): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (binding.dataScope === "self") {
    return allowSelfScope ? copy("本人", "Self") : copy("服务 Agent 不适用本人范围", "Self range is unavailable for service agents");
  }
  if (binding.dataScope === "department") return `${copy("部门", "Department")} · ${binding.scopeName || copy("未解析部门", "Unknown department")}`;
  if (binding.dataScope === "department_subtree") return `${copy("部门及下属", "Department subtree")} · ${binding.scopeName || copy("未解析部门", "Unknown department")}`;
  return copy("企业", "Enterprise");
}

function dateLabel(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function bindingStatus(binding: PrincipalRoleBinding, locale: string): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (binding.status === "revoked") return copy("已撤销", "Revoked");
  if (binding.expiresAt && new Date(binding.expiresAt).getTime() <= Date.now()) return copy("已过期", "Expired");
  if (binding.resolution === "unresolved") return copy("待解析", "Unresolved");
  return copy("生效中", "Active");
}

function bindingSource(binding: PrincipalRoleBinding, locale: string): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (binding.resolution === "unresolved") return copy("待确认授权范围", "Range confirmation required");
  if (binding.source === "legacy") return copy("历史角色同步", "Migrated role assignment");
  return copy("直接角色授权", "Direct role binding");
}

export function RoleBindingEditor({
  principalId,
  principalKind = "user",
  readOnly = false,
  allowSelfScope = true,
  onChanged,
  className,
}: RoleBindingEditorProps) {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [bindings, setBindings] = useState<PrincipalRoleBinding[]>([]);
  const [roles, setRoles] = useState<PrincipalRoleOption[]>([]);
  const [scopeOptions, setScopeOptions] = useState<PrincipalScopeOption[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: string; name: string; path?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canAssign, setCanAssign] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [roleId, setRoleId] = useState("");
  const [scopeType, setScopeType] = useState<PrincipalScopeOption["value"] | "">("");
  const [scopeId, setScopeId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const load = async () => {
    if (!principalId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await adminFetch(`/api/admin/principals/${encodeURIComponent(principalId)}/role-bindings`, { cache: "no-store" });
      const json = (await response.json()) as ApiEnvelope<BindingPayload>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("加载授权失败", "Failed to load role bindings"));
      const data = json.data ?? {};
      setBindings(data.bindings ?? []);
      setRoles(data.grantableRoles ?? []);
      // This list is authoritative. An empty list means no range may be
      // selected; a client fallback would turn a denied grant into a UI claim.
      setScopeOptions(data.grantableScopes ?? []);
      setCanAssign(data.permissions?.canAssign ?? false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : copy("加载授权失败", "Failed to load role bindings"));
      setCanAssign(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setRoleId("");
    setScopeType("");
    setScopeId("");
    setExpiresAt("");
    if (!principalId) {
      setBindings([]);
      setRoles([]);
      setScopeOptions([]);
      setCanAssign(false);
      return;
    }
    void load();
  }, [principalId]);

  useEffect(() => {
    if (!addOpen || (scopeType !== "department" && scopeType !== "department_subtree") || departments.length > 0) return;
    let alive = true;
    void (async () => {
      try {
        const response = await adminFetch("/api/admin/departments?shape=flat", { cache: "no-store" });
        const json = (await response.json()) as ApiEnvelope<{ items?: Array<{ id: string; name: string; path?: string }> }>;
        if (alive && response.ok && json.code === "00000") setDepartments(json.data?.items ?? []);
      } catch {
        if (alive) setDepartments([]);
      }
    })();
    return () => { alive = false; };
  }, [addOpen, departments.length, scopeType]);

  const availableScopes = useMemo(
    () => scopeOptions.filter((option) => allowSelfScope || option.value !== "self"),
    [allowSelfScope, scopeOptions],
  );

  const resetForm = () => {
    // Keep the role empty until the operator explicitly selects one.
    setRoleId("");
    setScopeType(availableScopes[0]?.value ?? "");
    setScopeId("");
    setExpiresAt("");
  };

  const addBinding = async () => {
    if (!principalId || !roleId || !scopeType || saving) return;
    if ((scopeType === "department" || scopeType === "department_subtree") && !scopeId) {
      toast.error(copy("请选择部门范围", "Select a department range"));
      return;
    }
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/principals/${encodeURIComponent(principalId)}/role-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roleId,
          dataScope: scopeType,
          scopeDeptId: scopeType === "department" || scopeType === "department_subtree" ? scopeId : null,
          expiresAt: expiresAt || null,
        }),
      });
      const json = (await response.json()) as ApiEnvelope<{ binding?: PrincipalRoleBinding }>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("添加授权失败", "Failed to add role binding"));
      toast.success(copy("角色授权已添加", "Role binding added"));
      setAddOpen(false);
      resetForm();
      await load();
      await onChanged?.();
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : copy("添加授权失败", "Failed to add role binding"));
    } finally {
      setSaving(false);
    }
  };

  const removeBinding = async (binding: PrincipalRoleBinding) => {
    if (!principalId || !binding.id || saving || binding.status === "revoked") return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/principals/${encodeURIComponent(principalId)}/role-bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("移除授权失败", "Failed to remove role binding"));
      toast.success(copy("角色授权已移除", "Role binding removed"));
      await load();
      await onChanged?.();
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : copy("移除授权失败", "Failed to remove role binding"));
    } finally {
      setSaving(false);
    }
  };

  if (!principalId) return null;
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4" />{copy("角色授权", "Role bindings")}</CardTitle>
          <CardDescription>{copy("角色、作用范围和有效期决定该主体实际可用的企业能力。", "Roles, ranges, and validity determine this principal's effective enterprise access.")} · {principalKind === "agent" ? "Agent" : copy("用户", "User")}</CardDescription>
        </div>
        {!readOnly && canAssign ? <Button type="button" size="sm" onClick={() => { resetForm(); setAddOpen(true); }} disabled={loading || !roles.length || !availableScopes.length}><Plus className="h-4 w-4" />{copy("添加授权", "Add binding")}</Button> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
        {loading ? <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div> : bindings.length ? <div className="space-y-2">{bindings.map((binding) => <div key={binding.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{binding.roleName || binding.roleCode || copy("未命名角色", "Unnamed role")}</span>{binding.roleCode ? <Badge variant="outline" className="font-mono text-[10px]">{binding.roleCode}</Badge> : null}{binding.status !== "active" || binding.resolution === "unresolved" || (binding.expiresAt && new Date(binding.expiresAt).getTime() <= Date.now()) ? <Badge variant="warning">{bindingStatus(binding, locale)}</Badge> : null}</div><p className="mt-1 text-sm text-muted-foreground">{scopeLabel(binding, locale, allowSelfScope)}</p><p className="mt-1 text-xs text-muted-foreground">{copy("权限来源：", "Source: ")}{bindingSource(binding, locale)}{binding.expiresAt ? ` · ${copy("有效至", "Until")} ${dateLabel(binding.expiresAt, locale)}` : ` · ${copy("永久", "Permanent")}`}</p></div>{!readOnly && canAssign && binding.status !== "revoked" ? <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void removeBinding(binding)} disabled={saving}><Trash2 className="h-4 w-4" />{copy("移除", "Remove")}</Button> : null}</div>)}</div> : <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">{copy("暂无角色授权", "No role bindings")}</p>}
        {addOpen ? <div className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4"><div className="flex items-center gap-2 text-sm font-medium"><CalendarClock className="h-4 w-4" />{copy("添加角色授权", "Add role binding")}</div><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="principal-binding-role">{copy("权限角色", "Role")}</Label><Select value={roleId} onValueChange={setRoleId}><SelectTrigger id="principal-binding-role"><SelectValue placeholder={copy("选择角色", "Select a role")} /></SelectTrigger><SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.name || role.code} · {role.code}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor="principal-binding-range">{copy("作用范围", "Range")}</Label><Select value={scopeType} onValueChange={(value) => { setScopeType(value as PrincipalScopeOption["value"]); setScopeId(""); }}><SelectTrigger id="principal-binding-range"><SelectValue placeholder={copy("选择范围", "Select a range")} /></SelectTrigger><SelectContent>{availableScopes.map((scope) => <SelectItem key={scope.value} value={scope.value}>{locale === "en" ? scope.labelEn || scope.label : scope.label}</SelectItem>)}</SelectContent></Select></div>{scopeType === "department" || scopeType === "department_subtree" ? <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="principal-binding-department">{copy("部门", "Department")}</Label><Select value={scopeId} onValueChange={setScopeId}><SelectTrigger id="principal-binding-department"><SelectValue placeholder={copy("选择部门", "Select a department")} /></SelectTrigger><SelectContent>{departments.map((department) => <SelectItem key={department.id} value={department.id}>{department.name}{department.path ? `（${department.path}）` : ""}</SelectItem>)}</SelectContent></Select></div> : null}<div className="space-y-1.5"><Label htmlFor="principal-binding-expires">{copy("有效至", "Expires")}</Label><Input id="principal-binding-expires" aria-label={copy("授权有效期", "Binding expiry")} type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></div></div><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>{copy("取消", "Cancel")}</Button><Button type="button" onClick={() => void addBinding()} disabled={saving || !roleId || !scopeType}>{saving ? copy("保存中…", "Saving…") : copy("保存授权", "Save binding")}</Button></div></div> : null}
      </CardContent>
    </Card>
  );
}
