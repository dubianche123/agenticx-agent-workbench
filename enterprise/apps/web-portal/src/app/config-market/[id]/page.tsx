import { Bot, FileText, LockKeyhole, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { EnterpriseBrandMark, ENTERPRISE_PRODUCT_NAME } from "../../../components/EnterpriseBrandMark";
import { defaultConfigMarketStore } from "../../../lib/config-market/store";
import { isValidConfigMarketId } from "../../../lib/config-market/types";
import { resolveLiveConfigMarketViewer } from "../../../lib/config-market/visibility";
import { getSessionFromCookies } from "../../../lib/session";
import ConfigMarketDownloadButton from "./ConfigMarketDownloadButton";

type Params = Promise<{ id: string }>;

export default async function ConfigMarketPage({ params }: { params: Params }) {
  const { id: rawId } = await params;
  const id = rawId.toUpperCase();
  if (!isValidConfigMarketId(id)) notFound();

  const returnTo = `/config-market/${encodeURIComponent(id)}`;
  const session = await getSessionFromCookies();
  if (!session) redirect(`/auth?returnTo=${encodeURIComponent(returnTo)}`);
  if (session.mustChangePassword) redirect("/auth/change-password");
  const viewer = await resolveLiveConfigMarketViewer(session);
  if (!viewer) notFound();

  let item;
  try {
    item = await defaultConfigMarketStore.getVisible(id, viewer);
  } catch {
    notFound();
  }
  if (!item) notFound();

  const [t, locale] = await Promise.all([getTranslations("configShare"), getLocale()]);
  const KindIcon = item.kind === "expert" ? Bot : item.kind === "group" ? Users : FileText;
  const kindLabel = item.kind === "expert"
    ? t("expertKind")
    : item.kind === "group"
      ? t("groupKind")
      : t("skillKind");
  const rawDownloadCount = (item as unknown as { downloadCount?: unknown }).downloadCount;
  const downloadCount = Number.isSafeInteger(rawDownloadCount) && (rawDownloadCount as number) >= 0
    ? rawDownloadCount as number
    : 0;

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8 flex items-center gap-3 border-b border-border/70 pb-6">
          <EnterpriseBrandMark size={38} />
          <div>
            <p className="text-sm font-semibold text-primary">{ENTERPRISE_PRODUCT_NAME}</p>
            <p className="text-xs text-muted-foreground">{t("internalShare")}</p>
          </div>
        </header>

        <article className="overflow-hidden rounded-3xl border border-border/70 bg-card shadow-xl shadow-primary/5">
          <div className="border-b border-border/60 bg-muted/30 p-6 sm:p-8">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground">
              <KindIcon className="h-4 w-4 text-primary" />
              {kindLabel}
            </div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{item.title}</h1>
            {item.description ? (
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                {item.description}
              </p>
            ) : null}
          </div>

          <div className="space-y-6 p-6 sm:p-8">
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("sharedBy")}</dt>
                <dd className="mt-1 font-medium">{item.ownerDisplayName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("sharedAt")}</dt>
                <dd className="mt-1 font-medium">
                  {new Date(item.createdAt).toLocaleString(locale)}
                </dd>
              </div>
            </dl>

            <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
              <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <p>{t("tenantOnlyHint")}</p>
            </div>

            <ConfigMarketDownloadButton
              key={id}
              id={id}
              initialDownloadCount={downloadCount}
              downloadUrl={`/api/config-market/${encodeURIComponent(id)}/download`}
            />
          </div>
        </article>
      </div>
    </main>
  );
}
