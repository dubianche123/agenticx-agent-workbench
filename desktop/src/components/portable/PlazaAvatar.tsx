import type { Avatar } from "../../store";

import accessibilityPortrait from "../../../../agenticx/avatar/assets/portraits/expert-accessibility-researcher.png";
import compliancePortrait from "../../../../agenticx/avatar/assets/portraits/expert-compliance-specialist.png";
import creativePortrait from "../../../../agenticx/avatar/assets/portraits/expert-creative-designer.png";
import customerResearchPortrait from "../../../../agenticx/avatar/assets/portraits/expert-customer-researcher.png";
import customerSuccessPortrait from "../../../../agenticx/avatar/assets/portraits/expert-customer-success.png";
import cybersecurityPortrait from "../../../../agenticx/avatar/assets/portraits/expert-cybersecurity-lead.png";
import dataAnalystPortrait from "../../../../agenticx/avatar/assets/portraits/expert-data-analyst.png";
import dataVisualizationPortrait from "../../../../agenticx/avatar/assets/portraits/expert-data-visualization.png";
import fieldEngineerPortrait from "../../../../agenticx/avatar/assets/portraits/expert-field-engineer.png";
import financePortrait from "../../../../agenticx/avatar/assets/portraits/expert-finance-specialist.png";
import governancePortrait from "../../../../agenticx/avatar/assets/portraits/expert-governance-adviser.png";
import operationsPortrait from "../../../../agenticx/avatar/assets/portraits/expert-operations-coordinator.png";
import organizationalCoachPortrait from "../../../../agenticx/avatar/assets/portraits/expert-organizational-coach.png";
import platformEngineerPortrait from "../../../../agenticx/avatar/assets/portraits/expert-platform-engineer.png";
import productStrategistPortrait from "../../../../agenticx/avatar/assets/portraits/expert-product-strategist.png";
import qualityReviewerPortrait from "../../../../agenticx/avatar/assets/portraits/expert-quality-reviewer.png";
import reportEditorPortrait from "../../../../agenticx/avatar/assets/portraits/expert-report-editor.png";
import securityEngineerPortrait from "../../../../agenticx/avatar/assets/portraits/expert-security-engineer.png";
import softwareEngineerPortrait from "../../../../agenticx/avatar/assets/portraits/expert-software-engineer.png";
import systemsArchitectPortrait from "../../../../agenticx/avatar/assets/portraits/expert-systems-architect.png";

export type PlazaAvatarKind = "expert" | "group";

/** Curated, offline portraits shared with the runtime's avatar registry. */
const CURATED_EXPERT_PORTRAITS = [
  accessibilityPortrait,
  compliancePortrait,
  creativePortrait,
  customerResearchPortrait,
  customerSuccessPortrait,
  cybersecurityPortrait,
  dataAnalystPortrait,
  dataVisualizationPortrait,
  fieldEngineerPortrait,
  financePortrait,
  governancePortrait,
  operationsPortrait,
  organizationalCoachPortrait,
  platformEngineerPortrait,
  productStrategistPortrait,
  qualityReviewerPortrait,
  reportEditorPortrait,
  securityEngineerPortrait,
  softwareEngineerPortrait,
  systemsArchitectPortrait,
] as const;

const PORTRAIT_BACKGROUNDS = [
  ["#e7f0ff", "#b9d2ff"],
  ["#e8f5ed", "#b9e3ca"],
  ["#fff1e8", "#ffd0b3"],
  ["#f3ecff", "#d8c4ff"],
  ["#fff6d9", "#ffe18a"],
] as const;

function stableIndex(value: string, modulo: number): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return hash % modulo;
}

/**
 * Keep missing/legacy portrait data visual.  This is an image URL (not a
 * text-initial fallback), so official template members and remote market
 * entries keep the same visual language before they are installed locally.
 */
export function buildPlazaAvatarFallbackUrl(
  name: string,
  kind: PlazaAvatarKind = "expert",
  sourceArtifactId = "",
): string {
  if (kind === "expert") {
    // A release identity keeps its portrait across renames; older/unreleased
    // entries remain stable from their title alone.
    const identity = sourceArtifactId.trim() || name.trim();
    return CURATED_EXPERT_PORTRAITS[
      stableIndex(identity, CURATED_EXPERT_PORTRAITS.length)
    ];
  }
  const [background, accent] = PORTRAIT_BACKGROUNDS[
    stableIndex(`${kind}:${name.trim()}`, PORTRAIT_BACKGROUNDS.length)
  ];
  const svg = kind === "group"
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img"><rect width="96" height="96" rx="24" fill="${background}"/><circle cx="34" cy="38" r="16" fill="${accent}"/><circle cx="62" cy="38" r="16" fill="${accent}" opacity=".82"/><path d="M12 83c2-17 11-26 22-26s20 9 22 26" fill="#314158" opacity=".9"/><path d="M40 83c2-17 11-26 22-26s20 9 22 26" fill="#53657f" opacity=".9"/><circle cx="34" cy="38" r="6" fill="#314158" opacity=".85"/><circle cx="62" cy="38" r="6" fill="#53657f" opacity=".85"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img"><rect width="96" height="96" rx="48" fill="${background}"/><circle cx="48" cy="39" r="20" fill="#f8fafc"/><path d="M23 96c2-20 12-31 25-31s23 11 25 31" fill="#314158" opacity=".92"/><path d="M28 39c1-18 9-28 20-28s19 10 20 28c-6-6-13-9-20-9s-14 3-20 9Z" fill="#53657f"/><circle cx="41" cy="40" r="2.5" fill="#314158"/><circle cx="55" cy="40" r="2.5" fill="#314158"/><path d="M42 51c4 3 8 3 12 0" fill="none" stroke="#314158" stroke-width="2.5" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function PlazaAvatar({
  avatar,
  name,
  kind,
  sourceArtifactId,
}: {
  avatar?: Pick<Avatar, "avatarUrl" | "portableArtifactId">;
  name: string;
  kind: PlazaAvatarKind;
  sourceArtifactId?: string;
}) {
  const fallbackUrl = buildPlazaAvatarFallbackUrl(
    name,
    kind,
    sourceArtifactId?.trim() || avatar?.portableArtifactId,
  );
  const sourceUrl = String(avatar?.avatarUrl ?? "").trim() || fallbackUrl;
  return (
    <img
      src={sourceUrl}
      alt={`${name}头像`}
      className="h-12 w-12 shrink-0 rounded-2xl object-cover ring-1 ring-border/70"
      loading="lazy"
      decoding="async"
      onError={(event) => {
        if (event.currentTarget.src !== fallbackUrl) event.currentTarget.src = fallbackUrl;
      }}
    />
  );
}
