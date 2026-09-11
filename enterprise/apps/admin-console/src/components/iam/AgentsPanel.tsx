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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Bot, CirclePower, Pencil, Plus, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { useLocale } from "next-intl";
import { adminFetch } from "../../lib/admin-client-auth";
import { RoleBindingEditor } from "./RoleBindingEditor";

type Agent = {
  id: string;
  kind: "agent";
  userId?: string | null;
  displayName?: string | null;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
  agentProfile?: {
    principalId: string;
    mode: "delegated" | "service";
    ownerUserId: string | null;
    definitionRef: string | null;
    definitionVersion: number;
  } | null;
};
type Owner = { id: string; displayName?: string; email?: string };
type ApiEnvelope<T> = { code: string; message: string; data?: T };
type AgentListPayload = {
  items?: Agent[];
  grantableRoles?: unknown[];
  permissions?: { canAssign?: boolean; canCreate?: boolean; canEdit?: boolean };
};
type AgentFormState = { mode: "new" | "edit"; agent?: Agent } | null;

export function AgentsPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState({ canAssign: false, canCreate: false, canEdit: false });
  const [editor, setEditor] = useState<AgentFormState>(null);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"delegated" | "service">("service");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [definitionRef, setDefinitionRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentResponse, userResponse] = await Promise.all([
        adminFetch("/api/admin/principals?kind=agent&limit=500", { cache: "no-store" }),
        adminFetch("/api/admin/users?limit=500", { cache: "no-store" }),
      ]);
      const agentJson = (await agentResponse.json()) as ApiEnvelope<AgentListPayload>;
      const userJson = (await userResponse.json()) as ApiEnvelope<{ items?: Owner[] }>;
      if (!agentResponse.ok || agentJson.code !== "00000") throw new Error(agentJson.message || copy("加载企业 Agent 失败", "Failed to load enterprise agents"));
      const data = agentJson.data ?? {};
      setAgents(data.items ?? []);
      setPermissions({
        canAssign: data.permissions?.canAssign ?? false,
        canCreate: data.permissions?.canCreate ?? false,
        canEdit: data.permissions?.canEdit ?? false,
      });
      if (userResponse.ok && userJson.code === "00000") setOwners(userJson.data?.items ?? []);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : copy("加载企业 Agent 失败", "Failed to load enterprise agents");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => { void load(); }, [load]);

  const visibleAgents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return agents;
    return agents.filter((agent) => [agent.displayName ?? "", agent.agentProfile?.definitionRef ?? "", agent.agentProfile?.ownerUserId ?? ""].join(" ").toLocaleLowerCase().includes(query));
  }, [agents, search]);

  const ownerLabel = (id: string | null | undefined) => {
    if (!id) return copy("未指定负责人", "No owner");
    const owner = owners.find((item) => item.id === id);
    return owner ? `${owner.displayName || owner.email || id}${owner.email && owner.displayName ? ` · ${owner.email}` : ""}` : id;
  };

  const openNew = () => {
    setName("");
    setMode("service");
    setOwnerUserId("");
    setDefinitionRef("");
    setEditor({ mode: "new" });
  };

  const openEdit = (agent: Agent) => {
    setName(agent.displayName ?? "");
    setMode(agent.agentProfile?.mode ?? "service");
    setOwnerUserId(agent.agentProfile?.ownerUserId ?? "");
    setDefinitionRef(agent.agentProfile?.definitionRef ?? "");
    setEditor({ mode: "edit", agent });
  };

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const isNew = editor?.mode === "new";
      const response = await adminFetch(
        isNew ? "/api/admin/principals" : `/api/admin/principals/${encodeURIComponent(editor?.agent?.id ?? "")}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isNew
            ? { kind: "agent", displayName: name.trim(), mode, ownerUserId: ownerUserId || null, definitionRef: definitionRef.trim() || null }
            : { displayName: name.trim(), mode, ownerUserId: ownerUserId || null, definitionRef: definitionRef.trim() || null }),
        },
      );
      const json = (await response.json()) as ApiEnvelope<{ principal?: Agent }>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("保存企业 Agent 失败", "Failed to save enterprise agent"));
      toast.success(isNew ? copy("企业 Agent 已创建", "Enterprise agent created") : copy("企业 Agent 已更新", "Enterprise agent updated"));
      setEditor(null);
      await load();
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : copy("保存企业 Agent 失败", "Failed to save enterprise agent"));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (agent: Agent) => {
    if (saving || !permissions.canEdit) return;
    setSaving(true);
    try {
      const response = await adminFetch(`/api/admin/principals/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: agent.status === "active" ? "disabled" : "active" }),
      });
      const json = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok || json.code !== "00000") throw new Error(json.message || copy("更新 Agent 状态失败", "Failed to update agent status"));
      toast.success(agent.status === "active" ? copy("Agent 已停用", "Agent disabled") : copy("Agent 已启用", "Agent enabled"));
      await load();
      if (selected?.id === agent.id) setSelected((current) => current ? { ...current, status: agent.status === "active" ? "disabled" : "active" } : current);
    } catch (statusError) {
      toast.error(statusError instanceof Error ? statusError.message : copy("更新 Agent 状态失败", "Failed to update agent status"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{copy("企业 Agent", "Enterprise agents")}</h2><p className="mt-1 text-sm text-muted-foreground">{copy("独立管理 Agent 的负责人、运行模式、状态和角色授权。负责人只用于追责，不会继承其个人权限。", "Manage each agent's owner, mode, status, and role bindings. Ownership supports accountability and does not inherit personal access.")}</p></div>
        <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="h-4 w-4" />{copy("刷新", "Refresh")}</Button>{permissions.canCreate ? <Button type="button" size="sm" onClick={openNew}><Plus className="h-4 w-4" />{copy("新建 Agent", "New agent")}</Button> : null}</div>
      </div>
      <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy("搜索 Agent 名称或定义", "Search agent name or definition")} />
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
      {loading ? <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-44" /><Skeleton className="h-44" /></div> : visibleAgents.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{visibleAgents.map((agent) => <Card key={agent.id} className="flex flex-col"><CardHeader className="pb-3"><div className="flex items-start justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><div className="rounded-lg bg-primary/10 p-2 text-primary"><Bot className="h-5 w-5" /></div><div className="min-w-0"><CardTitle className="truncate text-base">{agent.displayName || copy("未命名 Agent", "Unnamed agent")}</CardTitle><CardDescription className="mt-1">{agent.agentProfile?.definitionRef || copy("未关联定义", "No definition")}</CardDescription></div></div><Badge variant={agent.status === "active" ? "success" : "warning"}>{agent.status === "active" ? copy("启用", "Active") : copy("停用", "Disabled")}</Badge></div></CardHeader><CardContent className="flex flex-1 flex-col gap-3 text-sm"><div className="space-y-1 text-muted-foreground"><p><span className="text-foreground">{copy("模式：", "Mode: ")}</span>{agent.agentProfile?.mode === "delegated" ? copy("委托运行", "Delegated") : copy("服务运行", "Service")}</p><p className="flex items-center gap-1"><UserRound className="h-3.5 w-3.5" /><span className="truncate">{ownerLabel(agent.agentProfile?.ownerUserId)}</span></p></div><div className="mt-auto flex flex-wrap justify-end gap-1 border-t border-border pt-3"><Button type="button" size="sm" variant="ghost" onClick={() => setSelected(agent)}><ShieldCheck className="h-4 w-4" />{copy("角色授权", "Role bindings")}</Button>{permissions.canEdit ? <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(agent)}><Pencil className="h-4 w-4" />{copy("编辑", "Edit")}</Button> : null}{permissions.canEdit ? <Button type="button" size="sm" variant="ghost" onClick={() => void toggleStatus(agent)} disabled={saving}><CirclePower className="h-4 w-4" />{agent.status === "active" ? copy("停用", "Disable") : copy("启用", "Enable")}</Button> : null}</div></CardContent></Card>)}</div> : <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{copy("暂无企业 Agent", "No enterprise agents")}</p>}

      <Dialog open={Boolean(editor)} onOpenChange={(open) => !open && setEditor(null)}><DialogContent><DialogHeader><DialogTitle>{editor?.mode === "new" ? copy("新建企业 Agent", "New enterprise agent") : copy("编辑企业 Agent", "Edit enterprise agent")}</DialogTitle><DialogDescription>{copy("负责人用于管理和追责；Agent 的实际权限来自独立角色授权。", "Ownership supports management and accountability; an agent's access comes from its own role bindings.")}</DialogDescription></DialogHeader><div className="space-y-4"><div className="space-y-1.5"><Label htmlFor="agent-display-name">{copy("名称", "Name")}</Label><Input id="agent-display-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={copy("例如：企业巡检 Agent", "For example: Enterprise audit agent")} /></div><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="agent-mode">{copy("运行模式", "Mode")}</Label><Select value={mode} onValueChange={(value) => setMode(value as "delegated" | "service")}><SelectTrigger id="agent-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="service">{copy("服务运行", "Service")}</SelectItem><SelectItem value="delegated">{copy("委托运行", "Delegated")}</SelectItem></SelectContent></Select></div><div className="space-y-1.5"><Label htmlFor="agent-owner">{copy("负责人", "Owner")}</Label><Select value={ownerUserId || "__none__"} onValueChange={(value) => setOwnerUserId(value === "__none__" ? "" : value)}><SelectTrigger id="agent-owner"><SelectValue placeholder={copy("选择负责人", "Select owner")} /></SelectTrigger><SelectContent><SelectItem value="__none__">{copy("未指定", "No owner")}</SelectItem>{owners.map((owner) => <SelectItem key={owner.id} value={owner.id}>{owner.displayName || owner.email || owner.id}</SelectItem>)}</SelectContent></Select></div></div><div className="space-y-1.5"><Label htmlFor="agent-definition-ref">{copy("定义标识", "Definition reference")}</Label><Input id="agent-definition-ref" value={definitionRef} onChange={(event) => setDefinitionRef(event.target.value)} placeholder={copy("可选", "Optional")} /></div></div><DialogFooter><Button type="button" variant="outline" onClick={() => setEditor(null)} disabled={saving}>{copy("取消", "Cancel")}</Button><Button type="button" onClick={() => void save()} disabled={saving || !name.trim()}>{saving ? copy("保存中…", "Saving…") : copy("保存", "Save")}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{selected?.displayName || copy("企业 Agent", "Enterprise agent")}</DialogTitle><DialogDescription>{selected?.agentProfile?.mode === "delegated" ? copy("委托运行", "Delegated") : copy("服务运行", "Service")} · {ownerLabel(selected?.agentProfile?.ownerUserId)}</DialogDescription></DialogHeader>{selected ? <RoleBindingEditor principalId={selected.id} principalKind="agent" allowSelfScope={selected.agentProfile?.mode !== "service"} readOnly={!permissions.canAssign} onChanged={load} /> : null}</DialogContent></Dialog>
    </div>
  );
}
