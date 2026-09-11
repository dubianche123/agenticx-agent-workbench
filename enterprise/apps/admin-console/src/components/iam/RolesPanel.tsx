"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
  toast,
} from "@agenticx/ui";
import { Copy, Eye, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { useLocale } from "next-intl";
import { adminFetch } from "../../lib/admin-client-auth";
import type { PrincipalRoleOption } from "./RoleBindingEditor";

type Role = PrincipalRoleOption & {
  memberCount?: number;
  agentCount?: number;
  createdAt?: string;
  updatedAt?: string;
};
type ScopeOption = { value: string; label: string; labelEn?: string; description?: string; descriptionEn?: string; group?: string; groupEn?: string };
type ApiEnvelope<T> = { code: string; message: string; data?: T };
type RoleListPayload = {
  items?: Role[];
  grantableRoles?: Role[];
  grantableScopes?: Array<string | { value?: string; code?: string; label?: string; labelEn?: string; description?: string; descriptionEn?: string; group?: string; groupEn?: string }>;
  permissions?: { canCreate?: boolean; canEdit?: boolean; canAssign?: boolean };
};
type RoleEditorState = { mode: "new" | "edit"; role?: Role } | null;
type RoleDetails = {
  role: Role;
  users?: Array<{ id: string; email: string; displayName: string }>;
  agents?: Array<{ id?: string; principalId?: string; displayName?: string; name?: string; mode?: string; status?: string }>;
  bindings?: Array<{ principal?: { id: string; displayName?: string | null; kind: string } | null; binding: { id: string; roleCode: string; roleName?: string; dataScope: string; scopeName?: string | null; expiresAt?: string | null; status?: string; resolution?: string; source?: string } }>;
};

function normalizeScopes(raw: RoleListPayload["grantableScopes"]): ScopeOption[] {
  const options = (raw ?? []).map((item) => {
    if (typeof item === "string") return { value: item, label: item };
    const value = item.value || item.code || "";
    return {
      value,
      label: item.label || value,
      labelEn: item.labelEn,
      description: item.description,
      descriptionEn: item.descriptionEn,
      group: item.group,
      groupEn: item.groupEn,
    };
  }).filter((item) => item.value);
  return options;
}

function roleScopeSummary(role: Role, scopes: ScopeOption[], locale: string): string {
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  if (!role.scopes?.length) return copy("未配置权限", "No permissions");
  const labels = role.scopes.slice(0, 4).map((scope) => {
    const option = scopes.find((item) => item.value === scope);
    return locale === "en" ? option?.labelEn || option?.label || scope : option?.label || scope;
  });
  return role.scopes.length > labels.length ? `${labels.join(locale === "en" ? ", " : "、")} +${role.scopes.length - labels.length}` : labels.join(locale === "en" ? ", " : "、");
}

export function RolesPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [roles, setRoles] = useState<Role[]>([]);
  const [scopeOptions, setScopeOptions] = useState<ScopeOption[]>([]);
  const [permissions, setPermissions] = useState({ canCreate: false, canEdit: false, canAssign: false });
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<RoleEditorState>(null);
  const [details, setDetails] = useState<RoleDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [roleCode, setRoleCode] = useState("");
  const [roleName, setRoleName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/roles", { cache: "no-store" });
      const json = (await response.json()) as ApiEnvelope<RoleListPayload>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("加载权限角色失败", "Failed to load roles"));
      const data = json.data ?? {};
      setRoles(data.items ?? []);
      // The server is authoritative for the selectable capability list. An
      // empty list means this account cannot grant a capability and must stay
      // empty; labels never create an option.
      setScopeOptions(normalizeScopes(data.grantableScopes));
      setPermissions({
        canCreate: data.permissions?.canCreate ?? false,
        canEdit: data.permissions?.canEdit ?? false,
        canAssign: data.permissions?.canAssign ?? false,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("加载权限角色失败", "Failed to load roles"));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => { void load(); }, [load]);

  const visibleRoles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return roles;
    return roles.filter((role) => [role.name, role.code, ...(role.scopes ?? [])].join(" ").toLocaleLowerCase().includes(query));
  }, [roles, search]);

  const openNew = () => {
    setRoleCode("");
    setRoleName("");
    setSelectedScopes([]);
    setEditor({ mode: "new" });
  };

  const openEdit = (role: Role) => {
    setRoleCode(role.code);
    setRoleName(role.name ?? role.code);
    setSelectedScopes(role.scopes ?? []);
    setEditor({ mode: "edit", role });
  };

  const openDetails = async (role: Role) => {
    setDetailsLoading(true);
    setDetails(null);
    try {
      const response = await adminFetch(`/api/admin/roles/${encodeURIComponent(role.id)}/users`, { cache: "no-store" });
      const json = (await response.json()) as ApiEnvelope<RoleDetails>;
      if (!response.ok || json.code !== "00000" || !json.data?.role) throw new Error(json.message || copy("加载角色详情失败", "Failed to load role details"));
      setDetails(json.data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("加载角色详情失败", "Failed to load role details"));
    } finally {
      setDetailsLoading(false);
    }
  };

  const saveRole = async () => {
    const name = roleName.trim();
    if (!name || saving) return;
    if (editor?.mode === "new" && !roleCode.trim()) {
      toast.error(copy("请输入角色代码", "Enter a role code"));
      return;
    }
    setSaving(true);
    try {
      const isNew = editor?.mode === "new";
      const response = await adminFetch(
        isNew ? "/api/admin/roles" : `/api/admin/roles/${encodeURIComponent(editor?.role?.id ?? "")}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isNew ? { code: roleCode.trim(), name, scopes: selectedScopes } : { name, scopes: selectedScopes }),
        },
      );
      const json = (await response.json()) as ApiEnvelope<{ role?: Role }>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("保存角色失败", "Failed to save role"));
      toast.success(isNew ? copy("权限角色已创建", "Role created") : copy("权限角色已更新", "Role updated"));
      setEditor(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("保存角色失败", "Failed to save role"));
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async (role: Role) => {
    const nextCode = `${role.code}_copy`;
    setSaving(true);
    try {
      const response = await adminFetch("/api/admin/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "duplicate", sourceId: role.id, newCode: nextCode, newName: `${role.name}（副本）` }),
      });
      const json = (await response.json()) as ApiEnvelope<{ role?: Role }>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("复制角色失败", "Failed to duplicate role"));
      toast.success(copy("角色副本已创建", "Role duplicated"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("复制角色失败", "Failed to duplicate role"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (role: Role) => {
    if (role.immutable || saving) return;
    if (!window.confirm(`${copy("确认删除角色", "Delete role")} ${role.name}?`)) return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/roles/${encodeURIComponent(role.id)}`, { method: "DELETE" });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("删除角色失败", "Failed to delete role"));
      toast.success(copy("权限角色已删除", "Role deleted"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : copy("删除角色失败", "Failed to delete role"));
    } finally {
      setSaving(false);
    }
  };

  const groupedScopes = useMemo(() => {
    const groups = new Map<string, ScopeOption[]>();
    for (const option of scopeOptions) {
      const group = locale === "en"
        ? option.groupEn || option.group || option.value.split(":")[0] || copy("其他", "Other")
        : option.group || option.value.split(":")[0] || copy("其他", "Other");
      groups.set(group, [...(groups.get(group) ?? []), option]);
    }
    return [...groups.entries()];
  }, [copy, locale, scopeOptions]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{copy("权限角色", "Permission roles")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy("按业务职责组合权限，并明确角色能作用到哪些数据范围。", "Group permissions by responsibility and define the data range each role can use.")}</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="h-4 w-4" />{copy("刷新", "Refresh")}</Button>
          {permissions.canCreate ? <Button type="button" size="sm" onClick={openNew}><Plus className="h-4 w-4" />{copy("新建角色", "New role")}</Button> : null}
        </div>
      </div>

      <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy("搜索角色名称、代码或权限", "Search role name, code, or permission")} />

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
      ) : visibleRoles.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleRoles.map((role) => (
            <Card key={role.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{role.name}</CardTitle>
                    <CardDescription className="mt-1 font-mono text-xs">{role.code}</CardDescription>
                  </div>
                  {role.immutable ? <Badge variant="secondary"><ShieldCheck className="mr-1 h-3 w-3" />{copy("系统角色", "System")}</Badge> : null}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 text-sm">
                <p className="min-h-10 text-muted-foreground">{roleScopeSummary(role, scopeOptions, locale)}</p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><UsersRound className="h-3.5 w-3.5" />{role.memberCount ?? 0} {copy("成员", "members")}</span>
                  <span>{role.agentCount ?? 0} {copy("Agent", "agents")}</span>
                </div>
                <div className="mt-auto flex flex-wrap justify-end gap-1 border-t border-border pt-3">
                  <Button type="button" size="sm" variant="ghost" onClick={() => void openDetails(role)}><Eye className="h-4 w-4" />{copy("查看绑定", "Bindings")}</Button>
                  {permissions.canCreate ? <Button type="button" size="sm" variant="ghost" onClick={() => void duplicate(role)} disabled={saving}><Copy className="h-4 w-4" />{copy("复制", "Duplicate")}</Button> : null}
                  {permissions.canEdit && !role.immutable ? <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(role)}><Pencil className="h-4 w-4" />{copy("编辑", "Edit")}</Button> : null}
                  {permissions.canEdit && !role.immutable ? <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void remove(role)} disabled={saving}><Trash2 className="h-4 w-4" />{copy("删除", "Delete")}</Button> : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{copy("暂无权限角色", "No permission roles")}</p>}

      <Dialog open={Boolean(editor)} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editor?.mode === "new" ? copy("新建权限角色", "New permission role") : copy("编辑权限角色", "Edit permission role")}</DialogTitle>
            <DialogDescription>{copy("仅选择当前账号被允许授予的权限；服务端会再次检查角色与范围。", "Only permissions available to this account are selectable; the server checks role and range again.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="role-code">{copy("角色代码", "Role code")}</Label><Input id="role-code" value={roleCode} disabled={editor?.mode !== "new"} onChange={(event) => setRoleCode(event.target.value)} placeholder="department_operator" /></div>
              <div className="space-y-1.5"><Label htmlFor="role-name">{copy("角色名称", "Role name")}</Label><Input id="role-name" value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder={copy("例如：部门运营", "For example: Department operator")} /></div>
            </div>
            <div className="space-y-2">
              <Label>{copy("业务权限", "Business permissions")}</Label>
              <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-border p-3">
                {groupedScopes.map(([group, options]) => (
                  <div key={group}>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">{group}</p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {options.map((option) => {
                        const checked = selectedScopes.includes(option.value);
                        return <label key={option.value} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${checked ? "border-primary/40 bg-primary/5" : "border-transparent hover:bg-muted"}`}><Checkbox checked={checked} onCheckedChange={(value) => setSelectedScopes((current) => value === true ? [...new Set([...current, option.value])] : current.filter((item) => item !== option.value))} /><span><span className="block">{locale === "en" ? option.labelEn || option.label : option.label}</span><span className="font-mono text-[10px] text-muted-foreground">{option.value}</span>{(locale === "en" ? option.descriptionEn || option.description : option.description) ? <span className="mt-0.5 block text-xs text-muted-foreground">{locale === "en" ? option.descriptionEn || option.description : option.description}</span> : null}</span></label>;
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setEditor(null)} disabled={saving}>{copy("取消", "Cancel")}</Button><Button type="button" onClick={() => void saveRole()} disabled={saving || !roleName.trim()}>{saving ? copy("保存中…", "Saving…") : copy("保存角色", "Save role")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(details) || detailsLoading} onOpenChange={(open) => !open && setDetails(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{details?.role.name ?? copy("角色详情", "Role details")}</DialogTitle><DialogDescription>{details?.role.code ?? ""}</DialogDescription></DialogHeader>
          {detailsLoading ? <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : details ? <div className="space-y-4 text-sm"><div><p className="mb-2 font-medium">{copy("权限", "Permissions")}</p><div className="flex flex-wrap gap-1.5">{(details.role.scopes ?? []).map((scope) => { const option = scopeOptions.find((item) => item.value === scope); return <Badge key={scope} variant="outline">{locale === "en" ? option?.labelEn || option?.label || scope : option?.label || scope}</Badge>; })}</div></div><div><p className="mb-2 font-medium">{copy("绑定成员", "Bound members")} · {details.users?.length ?? 0}</p>{details.users?.length ? <div className="max-h-36 space-y-1 overflow-y-auto">{details.users.map((user) => <p key={user.id} className="rounded-md bg-muted/30 px-2 py-1">{user.displayName} <span className="text-muted-foreground">{user.email}</span></p>)}</div> : <p className="text-muted-foreground">{copy("暂无成员", "No members")}</p>}</div><div><p className="mb-2 font-medium">{copy("绑定企业 Agent", "Bound enterprise agents")} · {details.agents?.length ?? 0}</p>{details.agents?.length ? <div className="max-h-36 space-y-1 overflow-y-auto">{details.agents.map((agent, index) => <p key={agent.id || agent.principalId || index} className="rounded-md bg-muted/30 px-2 py-1">{agent.displayName || agent.name || copy("未命名 Agent", "Unnamed agent")} <span className="text-muted-foreground">{agent.mode || "service"}</span></p>)}</div> : <p className="text-muted-foreground">{copy("暂无企业 Agent", "No enterprise agents")}</p>}</div><div><p className="mb-2 font-medium">{copy("授权明细", "Binding details")}</p>{details.bindings?.length ? <div className="max-h-48 space-y-1 overflow-y-auto">{details.bindings.map(({ principal, binding }) => { const status = binding.status === "revoked" ? copy("已撤销", "Revoked") : binding.expiresAt && new Date(binding.expiresAt).getTime() <= Date.now() ? copy("已过期", "Expired") : binding.resolution === "unresolved" ? copy("待解析", "Unresolved") : copy("生效中", "Active"); const source = binding.source === "legacy" ? copy("历史角色同步", "Migrated role assignment") : copy("直接角色授权", "Direct role binding"); const range = binding.dataScope === "department" || binding.dataScope === "department_subtree" ? `${binding.dataScope === "department" ? copy("部门", "Department") : copy("部门及下属", "Department subtree")} · ${binding.scopeName || copy("未知部门", "Unknown department")}` : binding.dataScope === "self" ? copy("本人", "Self") : copy("企业", "Enterprise"); return <p key={binding.id} className="rounded-md bg-muted/30 px-2 py-1">{principal?.displayName || principal?.id || copy("未知主体", "Unknown principal")} · {range} · {status} · {source}{binding.expiresAt ? ` · ${new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(binding.expiresAt))}` : ` · ${copy("永久", "Permanent")}`}</p>; })}</div> : <p className="text-muted-foreground">{copy("暂无授权记录", "No binding history")}</p>}</div></div> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
