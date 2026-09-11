export type GatewaySection = "models" | "traffic" | "cache" | "credentials";
export type CredentialSection = "tokens" | "grants";

const GATEWAY_SECTIONS = new Set<GatewaySection>([
  "models",
  "traffic",
  "cache",
  "credentials",
]);

export function resolveGatewaySection(value: string | null | undefined): GatewaySection {
  return value && GATEWAY_SECTIONS.has(value as GatewaySection)
    ? (value as GatewaySection)
    : "models";
}

export function gatewayHref(
  section: GatewaySection,
  credential: CredentialSection = "tokens",
): string {
  const params = new URLSearchParams();
  if (section !== "models") params.set("section", section);
  if (section === "credentials" && credential === "grants") {
    params.set("credential", "grants");
  }
  const query = params.toString();
  return query ? `/admin/gateway?${query}` : "/admin/gateway";
}
