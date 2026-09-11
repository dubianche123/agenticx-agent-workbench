import { redirect } from "next/navigation";
import { governanceHref, type LegacySearchParams } from "../../lib/governance-navigation";

/** 已并入「安全与审计」。旧地址保留兜底，书签和外链不断。 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<LegacySearchParams> }) {
  redirect(governanceHref("audit", await searchParams));
}
