import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  enterpriseCapabilitySyncFailureReason,
  enterpriseCapabilitySyncStatusLabel,
  enterpriseSkillCoordinate,
  enterpriseSkillDirectoryName,
  filterEnterpriseCapabilities,
  hasManagedSkillDelivery,
  type EnterpriseCapabilityLike,
} from "../../../../shared/enterprise-capability-market";
import {
  normalizeEnterpriseCapabilitySyncStatuses,
  type EnterpriseCapabilitySyncStatus,
} from "../../../../shared/enterprise-capability-sync";
import type { SkillHubMarketItem } from "../../../utils/skillhub-market";
import {
  SkillMarketCard,
  type SkillHubInstallState,
} from "../skills/SkillHubMarketplace";
import {
  PortableMarketPublishDialog,
  type PortableMarketPublishTarget,
} from "../../portable/PortableMarketPublishDialog";
import {
  loadPortableMarketPages,
  sortPortableMarketItems,
  type PortableMarketItemSort,
} from "../../portable/DigitalExpertPlazaView";

export function enterpriseCapabilitySkillItem(
  capability: EnterpriseCapabilityLike,
): SkillHubMarketItem {
  const coordinate = enterpriseSkillCoordinate(capability.name);
  return {
    slug: coordinate.slug,
    name: capability.displayName || capability.name,
    description: "由企业管理员通过能力包批准，可在本机按需安装。",
    version: capability.version || "latest",
    author: coordinate.namespace || "企业能力包",
    source: "",
    source_type: "skillhub",
    namespace: coordinate.namespace || undefined,
    canonical_name: coordinate.canonicalName,
    origin_source: "skillhub_api",
    origin_hint: "企业批准 · 可自行安装",
    provenance_source: "skillhub",
  };
}

type InstalledSkillLike = {
  base_dir?: string;
  variants?: Array<{ base_dir?: string }>;
};

type LocalSkillLike = {
  name: string;
  description?: string;
  source?: string;
  skill_id?: string;
  content_hash?: string;
  base_dir?: string;
  variants?: Array<{
    name?: string;
    skill_id?: string;
    content_hash?: string;
    base_dir?: string;
    description?: string;
  }>;
};

type InstalledPortableMarketSkill = {
  itemId: string;
  version: string;
  digest: string;
  name: string;
};

/** An installed market item is current only when both release coordinates match. */
export function isPortableMarketSkillReleaseInstalled(
  installed: InstalledPortableMarketSkill | undefined,
  item: PortableMarketItem,
): boolean {
  return Boolean(
    installed
    && installed.itemId === item.id
    && installed.version === item.version
    && installed.digest.trim().toLowerCase() === item.digest.trim().toLowerCase(),
  );
}

function normalizedPath(value: unknown): string {
  return String(value ?? "").replace(/\\/gu, "/").replace(/\/+$/gu, "").toLowerCase();
}

/** Managed delivery lives outside the registry tree and uses the full capability name. */
export function isEnterpriseManagedSkillInstalled(
  skills: readonly InstalledSkillLike[],
  capability: EnterpriseCapabilityLike,
): boolean {
  const suffixes = [
    `/.agenticx-ontology/skills/enterprise/${enterpriseSkillDirectoryName(capability)}`,
    // Keep recognizing generic CLI installs when AGX_HOME is shared by choice.
    `/.agenticx/skills/enterprise/${enterpriseSkillDirectoryName(capability)}`,
  ];
  return skills.some((skill) =>
    [skill.base_dir, ...(skill.variants ?? []).map((variant) => variant.base_dir)].some(
      (baseDir) => suffixes.some((suffix) => normalizedPath(baseDir).endsWith(suffix)),
    ),
  );
}

type Props = {
  capabilities: readonly EnterpriseCapabilityLike[];
  syncStatuses?: readonly EnterpriseCapabilitySyncStatus[];
  refreshing?: boolean;
  refreshMessage?: string;
  onRefresh: () => Promise<void>;
  onRetrySync?: (capability: EnterpriseCapabilityLike) => void | Promise<void>;
  getInstallState: (capability: EnterpriseCapabilityLike) => SkillHubInstallState;
  getInstallMessage?: (capability: EnterpriseCapabilityLike) => string;
  getSkillEnabled?: (capability: EnterpriseCapabilityLike) => boolean;
  onInstall: (capability: EnterpriseCapabilityLike) => void;
  onTrySkill?: (capability: EnterpriseCapabilityLike) => void;
  onToggleSkill?: (capability: EnterpriseCapabilityLike, enabled: boolean) => void;
  onEditSkill?: (capability: EnterpriseCapabilityLike) => void;
  onUninstallSkill?: (capability: EnterpriseCapabilityLike) => void;
  /** Local indexed Skills that may be published as a single SKILL.md release. */
  localSkills?: readonly LocalSkillLike[];
};

export function EnterpriseSkillMarketplace({
  capabilities,
  syncStatuses,
  refreshing = false,
  refreshMessage = "",
  onRefresh,
  onRetrySync,
  getInstallState,
  getInstallMessage,
  getSkillEnabled = () => true,
  onInstall,
  onTrySkill,
  onToggleSkill,
  onEditSkill,
  onUninstallSkill,
  localSkills = [],
}: Props) {
  const [query, setQuery] = useState("");
  const [marketItems, setMarketItems] = useState<PortableMarketItem[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [marketInstallId, setMarketInstallId] = useState<string | null>(null);
  const [marketInstalledSkills, setMarketInstalledSkills] = useState<InstalledPortableMarketSkill[]>([]);
  const [marketDetailId, setMarketDetailId] = useState<string | null>(null);
  const [marketSort, setMarketSort] = useState<PortableMarketItemSort>("latest");
  const [marketNotice, setMarketNotice] = useState("");
  const [publishSkill, setPublishSkill] = useState<PortableMarketPublishTarget | null>(null);
  const syncStatusByCapability = useMemo(() => {
    const rows = normalizeEnterpriseCapabilitySyncStatuses(syncStatuses).filter(
      (status) => status.kind === "skill",
    );
    return new Map(rows.map((status) => [status.capabilityId, status] as const));
  }, [syncStatuses]);
  const skills = useMemo(
    () => filterEnterpriseCapabilities(capabilities, "skill", query),
    [capabilities, query],
  );
  const publishableLocalSkills = useMemo(() => {
    const excluded = [
      "/.agenticx-ontology/skills/enterprise/",
      "/.agenticx-ontology/skills/market/",
      "/.agenticx-ontology/skills/enterprise-market/",
      // Generic CLI roots remain excluded when explicitly shared with this app.
      "/.agenticx/skills/enterprise/",
      "/.agenticx/skills/market/",
      "/.agenticx/skills/enterprise-market/",
    ];
    const isExcluded = (baseDir?: string) => {
      const normalized = normalizedPath(baseDir);
      return excluded.some((root) => normalized.includes(root));
    };
    const result: Array<LocalSkillLike & { variantKey?: string }> = [];
    for (const skill of localSkills) {
      if (skill.base_dir && !isExcluded(skill.base_dir)) {
        result.push(skill);
      }
      for (const variant of skill.variants ?? []) {
        if (!variant.base_dir || isExcluded(variant.base_dir)) continue;
        result.push({
          ...skill,
          ...variant,
          name: variant.name || skill.name,
          description: variant.description || skill.description,
          variantKey: variant.skill_id || variant.content_hash || variant.base_dir,
        });
      }
    }
    return result;
  }, [localSkills]);

  const loadMarket = useCallback(async () => {
    setMarketLoading(true);
    setMarketError("");
    try {
      const result = await loadPortableMarketPages(
        "skill",
        (request) => window.agenticxDesktop.listPortablePackageMarket({
          ...request,
          kind: "skill",
          query: query.trim() || undefined,
        }),
        "公司 Skill 市场",
      );
      if (result.error && result.items.length === 0) {
        setMarketItems([]);
        setMarketError(result.error || "公司 Skill 市场加载失败");
      } else {
        setMarketItems(result.items.filter((item) => item.kind === "skill"));
        if (result.error) setMarketError(result.error);
      }
    } catch (error) {
      setMarketItems([]);
      setMarketError(error instanceof Error ? error.message : "公司 Skill 市场加载失败");
    } finally {
      setMarketLoading(false);
    }
  }, [query]);

  const loadInstalledMarketSkills = useCallback(async () => {
    try {
      const bridge = window.agenticxDesktop.listPortableMarketInstalledSkills;
      if (typeof bridge !== "function") return;
      const result = await bridge();
      if (result.ok && Array.isArray(result.installed)) {
        const normalized = result.installed.filter((entry): entry is InstalledPortableMarketSkill => (
          Boolean(entry)
          && typeof entry.itemId === "string"
          && typeof entry.version === "string"
          && typeof entry.digest === "string"
          && typeof entry.name === "string"
        ));
        setMarketInstalledSkills(normalized);
      }
    } catch {
      // Installation state is an affordance only; a malformed local marker
      // must not make the company market itself unavailable.
    }
  }, []);

  useEffect(() => {
    void loadMarket();
  }, [loadMarket]);

  useEffect(() => {
    void loadInstalledMarketSkills();
  }, [loadInstalledMarketSkills]);

  const filteredMarketItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = !needle
      ? marketItems
      : marketItems.filter((item) => (
      `${item.title} ${item.description} ${item.ownerDisplayName}`.toLocaleLowerCase().includes(needle)
      ));
    return sortPortableMarketItems(filtered, marketSort);
  }, [marketItems, marketSort, query]);

  const installMarketSkill = async (item: PortableMarketItem) => {
    if (marketInstallId) return;
    setMarketInstallId(item.id);
    try {
      const result = await window.agenticxDesktop.installPortableMarketSkill({ id: item.id });
      if (!result.ok) {
        setMarketError(result.error || "Skill 安装失败");
      } else {
        setMarketInstalledSkills((current) => [
          ...current.filter((installed) => installed.itemId !== item.id),
          {
            itemId: item.id,
            version: result.version || item.version,
            digest: result.digest || item.digest,
            name: result.name || item.title,
          },
        ]);
        setMarketError("");
        const wasInstalled = marketInstalledSkills.some((installed) => installed.itemId === item.id);
        setMarketNotice(`${wasInstalled ? "已更新" : "已安装"} Skill「${item.title}」v${item.version}。`);
        await onRefresh();
      }
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "Skill 安装失败");
    } finally {
      setMarketInstallId(null);
    }
  };

  const handleRefresh = async () => {
    await onRefresh();
    await loadMarket();
    await loadInstalledMarketSkills();
  };

  return (
    <>
    <section
      className="rounded-xl border border-border bg-surface-panel p-3.5"
      aria-label="公司 Skill 市场与企业能力包"
      aria-busy={refreshing}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-text-strong">公司 Skill 市场</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
            可见 Skill 可按需安装；能力包中的“强制下发”是独立通道，不会因为市场安装或下架互相覆盖。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {publishableLocalSkills.length > 0 ? (
            <select
              className="h-7 max-w-[170px] rounded-lg border border-border bg-surface-card px-2 text-[10px] text-text-subtle outline-none"
              value=""
              aria-label="发布本地 Skill"
              onChange={(event) => {
                const skill = publishableLocalSkills.find((candidate) => (
                  (candidate.variantKey || candidate.skill_id || candidate.name) === event.target.value
                ));
                if (skill) {
                  setPublishSkill({
                    kind: "skill",
                    id: skill.name,
                    name: skill.name,
                    skillId: skill.skill_id,
                    contentHash: skill.content_hash,
                  });
                }
              }}
            >
              <option value="">发布本地 Skill</option>
              {publishableLocalSkills.map((skill, index) => {
                const key = skill.variantKey || skill.skill_id || `${skill.name}:${skill.base_dir || index}`;
                return <option key={key} value={key}>{skill.name}{skill.source ? ` · ${skill.source}` : ""}</option>;
              })}
            </select>
          ) : null}
          <label className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[10px] text-text-faint">
            <span>排序</span>
            <select
              className="bg-transparent text-[10px] text-text-subtle outline-none"
              value={marketSort}
              aria-label="公司 Skill 市场排序方式"
              onChange={(event) => setMarketSort(event.target.value as PortableMarketItemSort)}
            >
              <option value="latest">最新发布</option>
              <option value="downloads">下载最多</option>
              <option value="name">名称</option>
            </select>
          </label>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[10px] text-text-subtle transition hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            disabled={refreshing || marketLoading}
            aria-label="刷新公司 Skill 市场"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw className={`h-3 w-3 ${refreshing || marketLoading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </div>
      </div>

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint" />
        <input
          className="h-9 w-full rounded-lg border border-border bg-surface-base pl-8 pr-3 text-xs text-text-primary outline-none transition placeholder:text-text-faint focus:border-[var(--settings-accent-border-strong)]"
          placeholder="搜索公司 Skill 市场与已分配技能"
          aria-label="搜索公司 Skill 市场与企业技能"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {refreshMessage ? (
        <div className="mt-2 text-[11px] leading-4 text-text-muted" aria-live="polite">
          {refreshMessage}
        </div>
      ) : null}

      {marketNotice ? (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-[11px] text-emerald-300" role="status" aria-live="polite">
          <span>{marketNotice}</span>
          <button type="button" className="shrink-0 text-emerald-300 hover:text-emerald-200" aria-label="关闭市场提示" onClick={() => setMarketNotice("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      ) : null}

      <div className="mt-3 rounded-xl border border-border bg-surface-card p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="text-xs font-semibold text-text-strong">市场 Skill</h4>
            <p className="mt-0.5 text-[10px] text-text-faint">员工只看到发布者选择的范围；安装不会加入能力包。</p>
          </div>
          <span className="text-[10px] tabular-nums text-text-faint">{filteredMarketItems.length} 项</span>
        </div>
        {marketError ? (
          <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-[11px] text-rose-300" role="alert">
            <span>{marketError}</span>
            <button type="button" className="shrink-0 text-rose-300 hover:text-rose-200" aria-label="关闭市场错误" onClick={() => setMarketError("")}><X className="h-3.5 w-3.5" /></button>
          </div>
        ) : null}
        {marketLoading && marketItems.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载公司市场…</div>
        ) : filteredMarketItems.length > 0 ? (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {filteredMarketItems.map((item) => {
              const installed = marketInstalledSkills.find((candidate) => candidate.itemId === item.id);
              const releaseInstalled = isPortableMarketSkillReleaseInstalled(installed, item);
              const expanded = marketDetailId === item.id;
              return (
                <article key={item.id} className="flex min-h-[132px] min-w-0 flex-col rounded-lg border border-border bg-surface-panel p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h5 className="truncate text-xs font-semibold text-text-strong">{item.title}</h5>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-text-faint">
                        <span className="truncate">v{item.version} · {item.ownerDisplayName || "企业成员"}</span>
                        <span title="同一账号同一版本只计一次，跨版本累计；不含能力包自动下发。" className="inline-flex items-center gap-1 tabular-nums">
                          <Download className="h-3 w-3 shrink-0" aria-hidden />
                          下载 {item.downloadCount} 次
                        </span>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9px] text-text-faint">按需安装</span>
                  </div>
                  <p className="mt-2 line-clamp-2 flex-1 text-[11px] leading-4 text-text-muted">{item.description || "暂无描述"}</p>
                  <div className="mt-2 flex items-center justify-between gap-1.5 border-t border-border pt-2">
                    <button type="button" className="text-[10px] text-text-faint hover:text-text-primary" aria-expanded={expanded} onClick={() => setMarketDetailId(expanded ? null : item.id)}>{expanded ? "收起详情" : "查看详情"}</button>
                    <button type="button" className="inline-flex items-center gap-1 rounded-md border border-[var(--settings-accent-border-strong)] px-2 py-1 text-[10px] text-[var(--settings-accent-fg)] transition hover:bg-[var(--settings-accent-subtle-bg)] disabled:opacity-50" disabled={releaseInstalled || marketInstallId === item.id} onClick={() => void installMarketSkill(item)}>
                      {marketInstallId === item.id ? <Loader2 className="h-3 w-3 animate-spin" /> : releaseInstalled ? <CheckCircle2 className="h-3 w-3" /> : <Download className="h-3 w-3" />}
                      {releaseInstalled ? "已安装" : installed ? "更新" : "安装"}
                    </button>
                  </div>
                  {expanded ? (
                    <div className="mt-2 space-y-1 rounded-md bg-surface-card px-2 py-1.5 text-[10px] leading-4 text-text-faint">
                      <div>发布者：{item.ownerDisplayName || "企业成员"}</div>
                      <div>可见范围：{item.visibility === "company" ? "全公司" : item.visibility === "departments" ? `指定部门（${item.visibleDepartmentCount}）` : item.visibility === "users" ? `指定同事（${item.visibleUserCount}）` : item.visibility === "personal" ? "仅发布者" : "管理员"}</div>
                      <div>版本说明：{item.releaseNotes || "无"}</div>
                      <div className="break-all font-mono">发布标识：{item.sourceArtifactId}</div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="py-5 text-center text-xs text-text-faint">{query.trim() ? "没有匹配的市场 Skill。" : "当前没有你可见的公司 Skill。"}</div>
        )}
      </div>

      {skills.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {skills.map((capability) => {
            const syncStatus = syncStatusByCapability.get(capability.id);
            // A failed receipt can be the only reliable signal that an intended
            // managed delivery had invalid/missing metadata. Keep that card in
            // the managed lane so the user sees the safe failure reason rather
            // than an install affordance for a package that cannot be applied.
            const managed = hasManagedSkillDelivery(capability)
              || Boolean(syncStatus && syncStatus.status !== "applied");
            const installState = getInstallState(capability);
            const label = capability.displayName || capability.name;
            if (!managed) {
              const item = enterpriseCapabilitySkillItem(capability);
              return (
                <SkillMarketCard
                  key={capability.id}
                  item={item}
                  installState={installState}
                  installMessage={getInstallMessage?.(capability)}
                  skillEnabled={getSkillEnabled(capability)}
                  onInstall={() => onInstall(capability)}
                  onTrySkill={() => onTrySkill?.(capability)}
                  onToggleSkill={(enabled) => onToggleSkill?.(capability, enabled)}
                  onEditSkill={() => onEditSkill?.(capability)}
                  onUninstallSkill={() => onUninstallSkill?.(capability)}
                />
              );
            }

            // The local skill index is only a compatibility/install hint. A
            // managed package is considered applied only after its receipt
            // explicitly reports `applied`; an absent receipt is unknown.
            const synced = syncStatus?.status === "applied";
            const syncing = syncStatus?.status === "downloading"
              || syncStatus?.status === "verifying";
            const failed = syncStatus?.status === "failed";
            const statusLabel = syncStatus
              ? enterpriseCapabilitySyncStatusLabel(syncStatus.status)
              : enterpriseCapabilitySyncStatusLabel(undefined);
            return (
              <article
                key={capability.id}
                className="flex min-h-[148px] min-w-0 flex-col rounded-xl border border-[var(--settings-accent-border-muted)] bg-surface-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h4 className="truncate text-[13px] font-semibold text-text-strong">{label}</h4>
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[var(--settings-accent-fg)]" />
                    </div>
                    <div className="mt-1 truncate text-[10px] text-text-faint">
                      {capability.name}{capability.version ? ` · ${capability.version}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-[var(--settings-accent-border-muted)] bg-[var(--settings-accent-subtle-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--settings-accent-fg)]">
                    强制下发
                  </span>
                </div>
                <p className="mt-3 flex-1 text-[11px] leading-[17px] text-text-muted">
                  该技能由企业托管下发，客户端会根据本机同步回执展示状态，无需手动安装。
                </p>
                <div className="mt-2 border-t border-border pt-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] ${
                        failed
                          ? "text-rose-400"
                          : synced
                            ? "text-emerald-400"
                            : "text-text-subtle"
                      }`}
                      role="status"
                      aria-live="polite"
                    >
                    {failed ? (
                      <AlertCircle className="h-3.5 w-3.5" />
                    ) : syncing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : synced ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5" />
                    )}
                      {statusLabel}
                    </span>
                    {failed ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 px-2 py-0.5 text-[10px] text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
                        disabled={refreshing}
                        onClick={() => {
                          void (onRetrySync
                            ? onRetrySync(capability)
                            : onRefresh());
                        }}
                      >
                        <RefreshCw className="h-3 w-3" />
                        重试
                      </button>
                    ) : null}
                  </div>
                  {failed ? (
                    <p className="mt-1 text-[10px] leading-4 text-rose-300" role="note">
                      {enterpriseCapabilitySyncFailureReason(syncStatus)}
                    </p>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
          {query.trim() ? "没有匹配的已分配技能。" : "管理员尚未通过能力包分配技能。"}
        </div>
      )}
    </section>
    <PortableMarketPublishDialog
      target={publishSkill}
      onClose={() => setPublishSkill(null)}
      onPublished={async (_target, result) => {
        setPublishSkill(null);
        if (result.notice) setMarketNotice(result.notice);
        if (result.warning) setMarketError(result.warning);
        await loadMarket();
      }}
    />
    </>
  );
}
