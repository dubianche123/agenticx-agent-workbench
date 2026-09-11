import { Bot, Download, FileText, LockKeyhole, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { EnterpriseBrandMark, ENTERPRISE_PRODUCT_NAME } from "../../../components/EnterpriseBrandMark";
import { isValidConfigShareToken } from "../../../lib/config-share-types";
import { defaultConfigShareStore } from "../../../lib/config-shares/store";
import { getSessionFromCookies } from "../../../lib/session";

type Params = Promise<{ token: string }>;

export default async function ConfigSharePage({ params }: { params: Params }) {
  const { token } = await params;
  if (!isValidConfigShareToken(token)) notFound();

  const returnTo = `/config-share/${encodeURIComponent(token)}`;
  const session = await getSessionFromCookies();
  if (!session) redirect(`/auth?returnTo=${encodeURIComponent(returnTo)}`);
  if (session.mustChangePassword) redirect("/auth/change-password");

  let snapshot;
  try {
    snapshot = await defaultConfigShareStore.get(token, session.tenantId);
  } catch {
    notFound();
  }
  if (!snapshot) notFound();

  const [t, locale] = await Promise.all([getTranslations("configShare"), getLocale()]);
  const KindIcon = snapshot.kind === "expert" ? Bot : snapshot.kind === "group" ? Users : FileText;
  const kindLabel = snapshot.kind === "expert"
    ? t("expertKind")
    : snapshot.kind === "group"
      ? t("groupKind")
      : t("skillKind");

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
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{snapshot.title}</h1>
            {snapshot.manifest.description ? (
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                {snapshot.manifest.description}
              </p>
            ) : null}
          </div>

          <div className="space-y-6 p-6 sm:p-8">
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("sharedBy")}</dt>
                <dd className="mt-1 font-medium">{snapshot.ownerDisplayName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("sharedAt")}</dt>
                <dd className="mt-1 font-medium">
                  {new Date(snapshot.createdAt).toLocaleString(locale)}
                </dd>
              </div>
            </dl>

            <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
              <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <p>{t("tenantOnlyHint")}</p>
            </div>

            <div>
              <a
                href={`/api/config-shares/${encodeURIComponent(token)}/download`}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 sm:w-auto"
              >
                <Download className="h-4 w-4" />
                {t("download")}
              </a>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                {t("downloadHint")}
              </p>
            </div>
          </div>
        </article>
      </div>
    </main>
  );
}
