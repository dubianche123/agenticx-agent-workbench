"use client";

import { useState } from "react";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Textarea,
  toast,
} from "@agenticx/ui";
import { Package, Plus, RefreshCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { isBuiltinExpertCapabilityId } from "@agenticx/config";

import {
  capabilityLabel,
  danglingCapabilityIds,
  disabledMemberIds,
  fromAssignmentKeys,
  toAssignmentKeys,
  type AssignmentDraft,
} from "../../lib/capability-pack-form";
import { versionedCapabilityPackPatch } from "../../lib/capability-pack-concurrency";
import { AssignmentScopeEditor } from "../assignment/AssignmentScopeEditor";
import { CapabilityChoiceList } from "./CapabilityChoiceList";
import { toggleId, useCapabilityCatalog, type PackRecord } from "./use-capability-catalog";

const EMPTY_ASSIGNMENT: AssignmentDraft = {
  allMembers: false,
  deptIds: [],
  groupIds: [],
  userIds: [],
};

export function CapabilityPacksPanel() {
  const locale = useLocale();
  const copy = (zh: string, en: string) => (locale === "en" ? en : zh);
  const t = useTranslations("pages.admin.capabilityPacks");
  const tc = useTranslations("common");
  const catalog = useCapabilityCatalog(t("toast.loadFailed"), tc("states.error"));

  const [packSlug, setPackSlug] = useState("");
  const [packName, setPackName] = useState("");
  const [editing, setEditing] = useState<PackRecord | null>(null);
  const [draft, setDraft] = useState({ displayName: "", description: "" });
  const [members, setMembers] = useState<string[]>([]);
  const [portableReleasePolicies, setPortableReleasePolicies] = useState<
    Record<string, { mode: "pinned" | "track_stable"; pinnedReleaseId?: string | null }>
  >({});
  const [assignment, setAssignment] = useState<AssignmentDraft>(EMPTY_ASSIGNMENT);

  function openEditor(pack: PackRecord) {
    setEditing(pack);
    setDraft({ displayName: pack.displayName, description: pack.description });
    setMembers([...pack.capabilityIds]);
    setPortableReleasePolicies({ ...pack.portableReleasePolicies });
    setAssignment(fromAssignmentKeys(pack.assignmentKeys));
  }

  function removePortableMemberOrRedirect(id: string) {
    if (!members.includes(id)) {
      toast.info(copy("请到能力货架核对完整详情后加入专家、项目群聊或市场 Skill", "Review the full details on the capability shelf before adding an expert, project group, or market Skill"));
      return;
    }
    setMembers((current) => current.filter((memberId) => memberId !== id));
  }

  async function save() {
    if (!editing) return;
    const ok = await catalog.send(
      `/api/admin/capability-packs/${editing.id}`,
      "PATCH",
      versionedCapabilityPackPatch(editing.updatedAt, {
        displayName: draft.displayName,
        description: draft.description,
        capabilityIds: members,
        portableReleasePolicies: Object.fromEntries(
          members
            .filter(isMarketPortableId)
            .map((id) => [id, portableReleasePolicies[id] ?? { mode: "pinned" }]),
        ),
        assignmentKeys: toAssignmentKeys(assignment),
      }),
    );
    if (ok) {
      setEditing(null);
      toast.success(t("toast.saved"));
    }
  }

  const dangling = editing ? danglingCapabilityIds(members, catalog.choices) : [];
  const disabled = editing ? disabledMemberIds(members, catalog.choices) : [];
  const marketItemByCapabilityId = new Map(
    catalog.configMarketItems.map((item) => [item.capabilityId, item]),
  );
  const isMarketPortableId = (id: string) =>
    (id.startsWith("expert:") && !isBuiltinExpertCapabilityId(id)) ||
    id.startsWith("group:") ||
    (id.startsWith("skill:") && marketItemByCapabilityId.get(id)?.kind === "skill");
  const marketSkillChoices = catalog.grouped.skill.filter(
    (choice) => choice.shelfManaged === true && members.includes(choice.id),
  );
  const legacySkillChoices = catalog.grouped.skill.filter((choice) => choice.shelfManaged !== true);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="size-4" /> {t("packs.createTitle")}
          </CardTitle>
          <CardDescription>{t("packs.createDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="pack-slug">{t("packs.slug")}</Label>
              <Input
                id="pack-slug"
                value={packSlug}
                onChange={(e) => setPackSlug(e.target.value)}
                placeholder="market-research"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pack-name">{t("packs.displayName")}</Label>
              <Input
                id="pack-name"
                value={packName}
                onChange={(e) => setPackName(e.target.value)}
                placeholder={t("packs.displayNamePlaceholder")}
              />
            </div>
            <Button
              onClick={async () => {
                if (!packSlug.trim()) {
                  toast.error(t("packs.slugRequired"));
                  return;
                }
                const ok = await catalog.send("/api/admin/capability-packs", "POST", {
                  slug: packSlug.trim(),
                  displayName: packName.trim() || undefined,
                });
                if (ok) {
                  setPackSlug("");
                  setPackName("");
                }
              }}
            >
              <Plus className="mr-1 size-4" /> {tc("actions.create")}
            </Button>
            <Button variant="outline" onClick={() => void catalog.load()} disabled={catalog.loading}>
              <RefreshCcw className="mr-1 size-4" /> {tc("actions.refresh")}
            </Button>
          </div>

          {catalog.loading && <p className="text-sm text-muted-foreground">{tc("states.loading")}</p>}
          {!catalog.loading && catalog.packs.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("packs.empty")}</p>
          )}
          {catalog.packs.map((pack) => (
            <div
              key={pack.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
            >
              <div>
                <div className="font-medium">{pack.displayName || pack.slug}</div>
                <div className="text-xs text-muted-foreground">
                  {pack.slug} · {t("packs.memberCount", { count: pack.capabilityIds.length })} ·{" "}
                  {pack.assignmentKeys.includes("all")
                    ? t("assignment.allMembers")
                    : t("packs.assignedCount", { count: pack.assignmentKeys.length })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={pack.status === "active" ? "default" : "secondary"}>
                  {pack.status === "active" ? t("status.active") : t("status.disabled")}
                </Badge>
                <Button size="sm" variant="outline" onClick={() => openEditor(pack)}>
                  {t("actions.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void catalog.send(
                      `/api/admin/capability-packs/${pack.id}`,
                      "PATCH",
                      versionedCapabilityPackPatch(pack.updatedAt, {
                        status: pack.status === "active" ? "disabled" : "active",
                      }),
                    )
                  }
                >
                  {pack.status === "active" ? t("actions.disable") : t("actions.enable")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!confirm(t("packs.confirmDelete"))) return;
                    void catalog.send(`/api/admin/capability-packs/${pack.id}`, "DELETE");
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("packs.editTitle", { name: editing?.slug ?? "" })}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="edit-pack-name">{t("packs.displayName")}</Label>
                  <Input
                    id="edit-pack-name"
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="edit-pack-desc">{t("packs.description")}</Label>
                  <Textarea
                    id="edit-pack-desc"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">{t("member.title")}</div>
                <p className="text-xs text-muted-foreground">{t("member.hint")}</p>
                <p className="text-xs text-muted-foreground">
                  {copy("新增数字专家/项目群聊/市场 Skill 前须在", "Before adding a digital expert, project group, or market Skill, review it on the ")}
                  <Link href="/admin/capabilities" className="mx-1 underline underline-offset-2">
                    {copy("能力货架", "capability shelf")}
                  </Link>
                  {copy("查看完整行为指令；这里仍可移除已加入的条目。", " and review the complete instructions. You can still remove items here.")}
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {/* 平台功能也是包成员（feature:web_search / feature:deep_research）。
                      漏了这一栏的后果是：包里明明装着它们，界面上看不见、勾不掉，也点不到
                      它们各自的配置。 */}
                  <div className="space-y-2 rounded-lg border p-3 sm:col-span-2">
                    <div className="text-xs font-medium text-muted-foreground">{copy("平台功能", "Platform features")}</div>
                    <CapabilityChoiceList
                      items={catalog.grouped.feature}
                      selected={members}
                      onToggle={(id) => setMembers((prev) => toggleId(prev, id))}
                      emptyLabel={copy("没有可选的平台功能", "No platform features available")}
                      disabledLabel={t("member.disabled")}
                    />
                  </div>
                  <div className="space-y-2 rounded-lg border p-3 sm:col-span-2">
                    <div className="text-xs font-medium text-muted-foreground">{copy("企业助手入口与操作", "Enterprise assistant entry and actions")}</div>
                    <p className="text-xs text-muted-foreground">
                      {copy("入口只允许进入企业助手；每项 action 仍会单独检查 IAM 与目标范围。", "The entry only enables access to the enterprise assistant; every action still checks IAM and target scope.")}
                    </p>
                    <CapabilityChoiceList
                      items={[...catalog.grouped.expert.filter((choice) => isBuiltinExpertCapabilityId(choice.id)), ...catalog.grouped.action]}
                      selected={members}
                      onToggle={(id) => setMembers((prev) => toggleId(prev, id))}
                      emptyLabel={copy("没有可选的企业助手能力", "No enterprise assistant capabilities available")}
                      disabledLabel={t("member.disabled")}
                    />
                  </div>
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="text-xs font-medium text-muted-foreground">MCP</div>
                    <CapabilityChoiceList
                      items={catalog.grouped.mcp}
                      selected={members}
                      onToggle={(id) => setMembers((prev) => toggleId(prev, id))}
                      emptyLabel={t("member.noMcp")}
                      disabledLabel={t("member.disabled")}
                    />
                  </div>
                  <div className="space-y-2 rounded-lg border p-3 sm:col-span-2">
                    <div className="text-xs font-medium text-muted-foreground">{copy("专家 / 群聊 / 市场 Skill 版本策略", "Expert / group / market Skill version policy")}</div>
                    {members.filter(isMarketPortableId).length === 0 ? (
                      <p className="text-xs text-muted-foreground">{copy("能力包内暂无市场专家、群聊或 Skill", "No market experts, groups, or Skills in this pack")}</p>
                    ) : (
                      members
                        .filter(isMarketPortableId)
                        .map((id) => {
                          const policy = portableReleasePolicies[id] ?? { mode: "pinned" as const };
                          return (
                            <div key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                              <div>
                                <div className="text-sm font-medium">{capabilityLabel(id, catalog.choices)}</div>
                                <div className="text-xs text-muted-foreground">
                                  {policy.mode === "track_stable"
                                    ? copy("自动跟随发布者最新稳定版本", "Follow the publisher's latest stable version")
                                    : `${copy("固定管理员批准的版本", "Pin the admin-approved version")}${policy.pinnedReleaseId ? ` · ${policy.pinnedReleaseId}` : ""}`}
                                </div>
                              </div>
                              <select
                                className="h-9 rounded-md border bg-background px-2 text-sm"
                                value={policy.mode}
                                onChange={(event) => {
                                  const mode = event.target.value as "pinned" | "track_stable";
                                  setPortableReleasePolicies((current) => ({
                                    ...current,
                                    [id]: mode === "track_stable"
                                      ? { mode, pinnedReleaseId: null }
                                      : { mode },
                                  }));
                                }}
                                aria-label={`${capabilityLabel(id, catalog.choices)} ${copy("版本策略", "version policy")}`}
                              >
                                <option value="pinned">{copy("固定当前批准版本", "Pin current approved version")}</option>
                                <option value="track_stable">{copy("跟随最新稳定版", "Follow latest stable version")}</option>
                              </select>
                            </div>
                          );
                        })
                    )}
                  </div>
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="text-xs font-medium text-muted-foreground">Skill</div>
                    <CapabilityChoiceList
                      items={legacySkillChoices}
                      selected={members}
                      onToggle={(id) => setMembers((prev) => toggleId(prev, id))}
                      emptyLabel={copy("没有可直接加入的 legacy Skill", "No legacy Skills available")}
                      disabledLabel={t("member.disabled")}
                    />
                  </div>
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="text-xs font-medium text-muted-foreground">{copy("市场 Skill（已入货架）", "Market Skills (on shelf)")}</div>
                    <CapabilityChoiceList
                      items={marketSkillChoices}
                      selected={members}
                      onToggle={removePortableMemberOrRedirect}
                      emptyLabel={copy("能力包内暂无市场 Skill；请先在能力货架核对并加入", "No market Skills in this pack; review and add them from the capability shelf")}
                      disabledLabel={t("member.disabled")}
                    />
                  </div>
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="text-xs font-medium text-muted-foreground">{copy("数字专家", "Digital experts")}</div>
                    <CapabilityChoiceList
                      items={catalog.grouped.expert.filter((choice) => !isBuiltinExpertCapabilityId(choice.id))}
                      selected={members}
                      onToggle={removePortableMemberOrRedirect}
                      emptyLabel={copy("企业货架还没有已上架的数字专家", "No listed digital experts on the enterprise shelf")}
                      disabledLabel={t("member.disabled")}
                    />
                  </div>
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="text-xs font-medium text-muted-foreground">{copy("项目群聊", "Project groups")}</div>
                    <CapabilityChoiceList
                      items={catalog.grouped.group}
                      selected={members}
                      onToggle={removePortableMemberOrRedirect}
                      emptyLabel={copy("企业货架还没有已上架的项目群聊", "No listed project groups on the enterprise shelf")}
                      disabledLabel={t("member.disabled")}
                    />
                  </div>
                </div>
                {disabled.length > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    {t("member.disabledWarning", {
                      names: disabled.map((id) => capabilityLabel(id, catalog.choices)).join("、"),
                    })}
                  </p>
                )}
                {dangling.length > 0 && (
                  <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
                    <p className="text-xs text-destructive">
                      {t("member.danglingWarning", { ids: dangling.join("、") })}
                    </p>
                    {dangling.map((id) => (
                      <div key={id} className="flex items-center justify-between gap-2">
                        <code className="min-w-0 truncate text-xs">{id}</code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setMembers((current) => current.filter((memberId) => memberId !== id))
                          }
                        >
                          {copy("从能力包移除", "Remove from pack")}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="text-sm font-medium">{t("assignment.title")}</div>
                <AssignmentScopeEditor
                  value={assignment}
                  onChange={setAssignment}
                  depts={catalog.depts}
                  groups={catalog.groups}
                  users={catalog.users}
                />
              </div>
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {tc("actions.cancel")}
            </Button>
            <Button onClick={() => void save()}>{tc("actions.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
