export type GovernanceTabId = "audit" | "logs" | "traces" | "feedback" | "policy" | "compliance";

export type LegacySearchParams = Record<string, string | string[] | undefined>;

/** Preserve old bookmarks and their filters while routing into the unified page. */
export function governanceHref(tab: GovernanceTabId, source: LegacySearchParams = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    if (key === "tab" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  if (tab !== "audit") params.set("tab", tab);
  const query = params.toString();
  return query ? `/admin/governance?${query}` : "/admin/governance";
}
