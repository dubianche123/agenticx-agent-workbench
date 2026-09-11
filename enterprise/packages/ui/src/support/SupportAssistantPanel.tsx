"use client";

import * as React from "react";
import { ArrowUp, Check, CircleHelp, ExternalLink, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import {
  SUPPORT_MAX_BODY_BYTES,
  SUPPORT_MAX_MESSAGES,
  SUPPORT_MAX_MESSAGE_CHARS,
  SUPPORT_MAX_MODEL_CHARS,
  sanitizeSupportMessage,
  type SupportBootstrap,
  type SupportAssistantPlacement,
  type SupportChatResponse,
  type SupportLink,
  type SupportMessage,
  type SupportPageContext,
  type SupportProposal,
  type SupportSurface,
  supportMessagesForStorage,
} from "./contracts";
import { findSupportGuide } from "./guides";
import { SupportAssistantLifecycle, type SupportRequestToken } from "./lifecycle";
import { cn } from "../lib/cn";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { SupportAssistantMarkdown } from "./SupportAssistantMarkdown";

type PanelMessage = SupportMessage & { proposal?: SupportProposal };
type SendMessageOptions = {
  /** Retry an existing user turn without appending that user message again. */
  reuseExistingUser?: boolean;
  /** History through the failed user turn, excluding any later stale response. */
  requestMessages?: readonly PanelMessage[];
};

type SupportStateSetter<T> = React.Dispatch<React.SetStateAction<T>>;

export type SupportAssistantPanelProps = {
  open: boolean;
  onClose: () => void;
  surface: SupportSurface;
  page: SupportPageContext;
  className?: string;
  placement?: SupportAssistantPlacement;
};

type ApiEnvelope<T> = {
  data?: T;
  message?: string;
  error?: { message?: string };
};

const EMPTY_BOOTSTRAP: SupportBootstrap = {
  storageKey: "",
  title: "智能助手",
  suggestions: [],
  models: [],
};

const SUPPORT_MESSAGES_STORAGE_VERSION = 1;
const SUPPORT_BOOTSTRAP_TIMEOUT_MS = 10_000;
const SUPPORT_CHAT_TIMEOUT_MS = 35_000;

function isSupportMessage(value: unknown): value is SupportMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.role === "user" || item.role === "assistant") &&
    typeof item.content === "string" &&
    item.content.trim().length > 0 &&
    item.content.length <= SUPPORT_MAX_MESSAGE_CHARS
  );
}

function sanitizePanelMessage(message: PanelMessage): PanelMessage | null {
  const normalized = sanitizeSupportMessage(message);
  if (!normalized.content) return null;
  return { ...message, ...normalized };
}

export function readStoredMessages(storageKey: string): PanelMessage[] {
  if (!storageKey || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages)
        ? (parsed as { messages: unknown[] }).messages
        : [];
    return items
      .filter(isSupportMessage)
      .slice(-SUPPORT_MAX_MESSAGES)
      .map(sanitizePanelMessage)
      .filter((message): message is PanelMessage => Boolean(message));
  } catch {
    return [];
  }
}

function writeStoredMessages(storageKey: string, messages: readonly PanelMessage[]): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    const payload = {
      version: SUPPORT_MESSAGES_STORAGE_VERSION,
      messages: supportMessagesForStorage(messages),
    };
    window.localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // A full or disabled local store must not block the support assistant.
  }
}

function removeStoredMessages(storageKey: string): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // best effort
  }
}

function safeLinks(links: readonly SupportLink[] | undefined): SupportLink[] {
  if (!Array.isArray(links)) return [];
  return links
    .filter((link) => (
      link &&
      typeof link.label === "string" &&
      link.label.trim().length > 0 &&
      typeof link.href === "string" &&
      link.href.startsWith("/")
    ))
    .slice(0, 6)
    .map((link) => ({ label: link.label.trim(), href: link.href }));
}

export function responseMessage(payload: ApiEnvelope<SupportChatResponse>): string {
  const message = payload.data?.message ?? payload.message ?? payload.error?.message;
  if (typeof message !== "string" || !message.trim()) return "支持助手暂时没有返回内容。";
  const normalized = sanitizeSupportMessage({ role: "assistant", content: message }).content;
  return normalized || "支持助手暂时没有返回内容。";
}

function errorMessage(payload: ApiEnvelope<unknown> | null, status: number): string {
  const message = payload?.error?.message ?? payload?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (status === 401 || status === 403) return "登录状态已变化，请刷新页面后重试。";
  return "支持助手暂时不可用，请稍后重试。";
}

async function readJson<T>(response: Response): Promise<ApiEnvelope<T> | null> {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const parentSignal = init.signal;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function buildSupportChatBody(
  messages: readonly PanelMessage[],
  page: SupportPageContext,
  selectedModel: string,
): string {
  const bodyMessages = messages
    .map(sanitizePanelMessage)
    .filter((message): message is PanelMessage => Boolean(message))
    .map(({ role, content }) => ({ role, content }));
  let firstMessage = 0;
  let body = "";
  do {
    body = JSON.stringify({
      messages: bodyMessages.slice(firstMessage),
      page,
      ...(selectedModel ? { model: selectedModel.slice(0, SUPPORT_MAX_MODEL_CHARS) } : {}),
    });
    if (new TextEncoder().encode(body).byteLength <= SUPPORT_MAX_BODY_BYTES) return body;
    firstMessage += 1;
  } while (firstMessage < bodyMessages.length - 1);
  return body;
}

function proposalIsActive(proposal: SupportProposal): boolean {
  const expires = Date.parse(proposal.expiresAt);
  return Number.isFinite(expires) && expires > Date.now();
}

/**
 * Queue bootstrap state through React's state updater API while keeping the
 * principal-generation fence. React may flush these updates after the caller
 * starts the chat request that follows bootstrap, so `isCurrent` (which also
 * requires the latest request id) would incorrectly discard valid bootstrap
 * state. Account changes, close, and unmount still advance the generation or
 * clear the scope and are rejected here.
 */
export function commitSupportBootstrapState(
  lifecycle: SupportAssistantLifecycle,
  token: SupportRequestToken,
  nextBootstrap: SupportBootstrap,
  storedMessages: PanelMessage[],
  setBootstrap: SupportStateSetter<SupportBootstrap | null>,
  setMessages: SupportStateSetter<PanelMessage[]>,
  setHydrated: SupportStateSetter<boolean>,
  messagesRef: React.MutableRefObject<PanelMessage[]>,
  hydratedScopeRef: React.MutableRefObject<string>,
): boolean {
  if (!lifecycle.isStateCurrent(token)) return false;
  setBootstrap((current) => lifecycle.isStateCurrent(token) ? nextBootstrap : current);
  // Keep refs ahead of the queued state so a send in this same batch includes
  // the hydrated history in its request body.
  messagesRef.current = storedMessages;
  setMessages((current) => lifecycle.isStateCurrent(token) ? storedMessages : current);
  hydratedScopeRef.current = nextBootstrap.storageKey;
  setHydrated((current) => lifecycle.isStateCurrent(token) ? true : current);
  return true;
}

/** Apply a proposal result without allowing it to cross principal boundaries. */
export function commitSupportProposalState(
  lifecycle: SupportAssistantLifecycle,
  token: SupportRequestToken,
  proposalId: string,
  message: PanelMessage,
  setExecutedProposalIds: SupportStateSetter<Set<string>>,
  setMessages: SupportStateSetter<PanelMessage[]>,
  messagesRef: React.MutableRefObject<PanelMessage[]>,
  persistence?: { storageKey: string; hydratedScope: string },
): void {
  const visibleMessage = sanitizePanelMessage(message);
  setExecutedProposalIds((current) => {
    if (!lifecycle.isStateCurrent(token)) return current;
    return new Set(current).add(proposalId);
  });
  setMessages((current) => {
    if (!lifecycle.isStateCurrent(token) || !visibleMessage) return current;
    const next = [...current, visibleMessage].slice(-SUPPORT_MAX_MESSAGES);
    messagesRef.current = next;
    if (persistence) {
      persistSupportMessagesIfCurrent(
        lifecycle,
        persistence.storageKey,
        true,
        persistence.hydratedScope,
        next,
      );
    }
    return next;
  });
}

/** Persist only messages belonging to the currently adopted principal. */
export function persistSupportMessagesIfCurrent(
  lifecycle: SupportAssistantLifecycle,
  storageKey: string,
  hydrated: boolean,
  hydratedScope: string,
  messages: readonly PanelMessage[],
): boolean {
  if (
    !hydrated ||
    !storageKey ||
    hydratedScope !== storageKey ||
    !lifecycle.isScopeCurrent(storageKey)
  ) return false;
  writeStoredMessages(storageKey, messages);
  return true;
}

/** Keep a manually selected model only while the same bootstrap still grants it. */
export function preserveSupportModelSelection(
  previousScope: string,
  nextScope: string,
  selectedModel: string,
  models: readonly { id: string }[],
): string {
  if (!selectedModel || previousScope !== nextScope) return "";
  return models.some((model) => model.id === selectedModel) ? selectedModel : "";
}

/** Reuse the failed user turn and omit any response that followed it. */
export function supportRetryInput(
  messages: readonly PanelMessage[],
): { content: string; requestMessages: PanelMessage[] } | null {
  const lastUserIndex = [...messages]
    .map((message) => message.role)
    .lastIndexOf("user");
  if (lastUserIndex < 0) return null;
  const lastUser = messages[lastUserIndex];
  return lastUser
    ? { content: lastUser.content, requestMessages: messages.slice(0, lastUserIndex + 1) }
    : null;
}

export function SupportAssistantPanel({
  open,
  onClose,
  surface,
  page,
  className,
  placement = "floating",
}: SupportAssistantPanelProps) {
  const [bootstrap, setBootstrap] = React.useState<SupportBootstrap | null>(null);
  const [messages, setMessages] = React.useState<PanelMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [selectedModel, setSelectedModel] = React.useState("");
  const [loadingBootstrap, setLoadingBootstrap] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [proposalBusy, setProposalBusy] = React.useState<string | null>(null);
  const [executedProposalIds, setExecutedProposalIds] = React.useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = React.useState(false);
  const lifecycleRef = React.useRef<SupportAssistantLifecycle | null>(null);
  if (!lifecycleRef.current) lifecycleRef.current = new SupportAssistantLifecycle();
  const lifecycle = lifecycleRef.current;
  lifecycle.setOpen(open);
  const hydratedScopeRef = React.useRef("");
  const messagesRef = React.useRef<PanelMessage[]>([]);
  const selectedModelRef = React.useRef("");
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const guideMatch = React.useMemo(() => findSupportGuide(page), [page]);
  const availableModels = bootstrap?.models ?? [];
  const suggestions = React.useMemo(
    () => [...new Set([...(bootstrap?.suggestions ?? []), ...(guideMatch.tab?.suggestions ?? []), ...guideMatch.guide.suggestions])].slice(0, 6),
    [bootstrap?.suggestions, guideMatch],
  );
  const links = React.useMemo(
    () => safeLinks([...(guideMatch.tab?.links ?? []), ...(guideMatch.guide.links)]),
    [guideMatch],
  );

  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  React.useEffect(() => {
    lifecycle.setMounted(true);
    return () => lifecycle.setMounted(false);
  }, [lifecycle]);

  const refreshBootstrap = React.useCallback(async (): Promise<SupportRequestToken | null> => {
    const previousScope = lifecycle.currentScope;
    if (lifecycle.isScopeCurrent(previousScope) && hydratedScopeRef.current === previousScope) {
      // Preserve the latest optimistic message if a focus/account refresh
      // races the effect that normally persists React state.
      writeStoredMessages(previousScope, messagesRef.current);
    }
    const request = lifecycle.beginBootstrap();
    const { token, signal } = request;
    let completionToken = token;
    setLoadingBootstrap(true);
    setError(null);
    try {
      const response = await fetchWithTimeout("/api/support", {
        cache: "no-store",
        signal,
      }, SUPPORT_BOOTSTRAP_TIMEOUT_MS);
      if (!lifecycle.isCurrent(token)) return null;
      const payload = await readJson<SupportBootstrap>(response);
      if (!lifecycle.isCurrent(token)) return null;
      if (!response.ok || !payload?.data || typeof payload.data.storageKey !== "string" || !payload.data.storageKey.trim()) {
        setError(errorMessage(payload, response.status));
        return null;
      }
      const nextBootstrap: SupportBootstrap = {
        storageKey: payload.data.storageKey,
        title: typeof payload.data.title === "string" && payload.data.title.trim() ? payload.data.title.trim() : EMPTY_BOOTSTRAP.title,
        suggestions: Array.isArray(payload.data.suggestions)
          ? payload.data.suggestions.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 8)
          : [],
        models: Array.isArray(payload.data.models)
          ? payload.data.models.filter((model) => model && typeof model.id === "string" && typeof model.label === "string").slice(0, 100)
          : [],
      };
      const adoptedToken = lifecycle.adoptScope(token, nextBootstrap.storageKey);
      if (!adoptedToken || !lifecycle.isCurrent(adoptedToken)) return null;
      completionToken = adoptedToken;
      const storedMessages = readStoredMessages(nextBootstrap.storageKey);
      if (!commitSupportBootstrapState(
        lifecycle,
        adoptedToken,
        nextBootstrap,
        storedMessages,
        setBootstrap,
        setMessages,
        setHydrated,
        messagesRef,
        hydratedScopeRef,
      )) return null;
      const nextSelectedModel = preserveSupportModelSelection(
        previousScope,
        nextBootstrap.storageKey,
        selectedModelRef.current,
        nextBootstrap.models ?? [],
      );
      selectedModelRef.current = nextSelectedModel;
      setSelectedModel(nextSelectedModel);
      return adoptedToken;
    } catch {
      if (!lifecycle.isCurrent(token)) return null;
      setError("无法读取支持助手身份，请检查网络后重试。");
      return null;
    } finally {
      if (lifecycle.isCurrent(completionToken)) {
        lifecycle.finish(completionToken);
        setLoadingBootstrap(false);
      }
    }
  }, [lifecycle]);

  React.useEffect(() => {
    if (!open) {
      // `setOpen(false)` invalidates the lifecycle synchronously during the
      // render that observes the closed prop. Keep the last adopted scope in
      // hydratedScopeRef so a close arriving before the persistence effect
      // flushes can still save the already-owned history.
      if (hydratedScopeRef.current && messagesRef.current.length > 0) {
        writeStoredMessages(hydratedScopeRef.current, messagesRef.current);
      }
      setBootstrap(null);
      setMessages([]);
      messagesRef.current = [];
      setHydrated(false);
      hydratedScopeRef.current = "";
      setDraft("");
      selectedModelRef.current = "";
      setSelectedModel("");
      setError(null);
      setSending(false);
      setProposalBusy(null);
      return;
    }
    void refreshBootstrap();
    return () => {
      lifecycle.invalidate();
    };
  }, [lifecycle, open, refreshBootstrap]);

  React.useEffect(() => {
    if (!open || !bootstrap?.storageKey) return;
    persistSupportMessagesIfCurrent(
      lifecycle,
      bootstrap.storageKey,
      hydrated,
      hydratedScopeRef.current,
      messages,
    );
  }, [bootstrap?.storageKey, hydrated, lifecycle, messages, open]);

  const closePanel = React.useCallback(() => {
    const storageKey = lifecycle.currentScope;
    if (
      storageKey &&
      hydratedScopeRef.current === storageKey &&
      lifecycle.isScopeCurrent(storageKey) &&
      messagesRef.current.length > 0
    ) {
      writeStoredMessages(storageKey, messagesRef.current);
    }
    onClose();
  }, [lifecycle, onClose]);

  React.useEffect(() => {
    if (!open) return;
    composerRef.current?.focus();
  }, [open]);

  React.useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open, sending]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePanel, open]);

  const clearHistory = React.useCallback(() => {
    if (!open || lifecycle.currentScope !== bootstrap?.storageKey || hydratedScopeRef.current !== bootstrap?.storageKey) return;
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    if (bootstrap?.storageKey) removeStoredMessages(bootstrap.storageKey);
  }, [bootstrap?.storageKey, lifecycle, open]);

  const sendMessage = React.useCallback(async (value?: string, options?: SendMessageOptions) => {
    const content = (value ?? draft).trim();
    const storageKeyAtStart = lifecycle.currentScope;
    if (!content || sending || !storageKeyAtStart) return;
    if (content.length > SUPPORT_MAX_MESSAGE_CHARS) {
      setError(`问题不能超过 ${SUPPORT_MAX_MESSAGE_CHARS} 个字符。`);
      return;
    }
    // Revalidate the authenticated principal immediately before sending. The
    // scope header is only a consistency fence; the server recomputes it.
    const principalReady = await refreshBootstrap();
    if (!principalReady || !lifecycle.isCurrent(principalReady)) return;
    if (principalReady.scope !== storageKeyAtStart) {
      setError("登录身份已变化，已清理旧支持记录，请重新提交问题。");
      return;
    }
    const userMessage: PanelMessage = { role: "user", content };
    const nextMessages = options?.reuseExistingUser
      ? messagesRef.current
      : [...messagesRef.current, userMessage].slice(-SUPPORT_MAX_MESSAGES);
    if (!options?.reuseExistingUser) {
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      // Persist the user turn synchronously. The normal React effect remains
      // useful for later responses, but it may not flush before a close.
      persistSupportMessagesIfCurrent(
        lifecycle,
        storageKeyAtStart,
        true,
        hydratedScopeRef.current,
        nextMessages,
      );
    }
    setDraft("");
    setSending(true);
    setError(null);
    const request = lifecycle.beginRequest();
    const { token, signal } = request;
    try {
      const body = buildSupportChatBody(
        options?.requestMessages ?? nextMessages,
        page,
        selectedModelRef.current,
      );
      if (new TextEncoder().encode(body).byteLength > SUPPORT_MAX_BODY_BYTES) {
        throw new Error("问题内容过长，请先清理支持助手历史记录。");
      }
      const response = await fetchWithTimeout("/api/support/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agenticx-support-scope": storageKeyAtStart,
        },
        body,
        signal,
      }, SUPPORT_CHAT_TIMEOUT_MS);
      if (!lifecycle.isCurrent(token)) return;
      const payload = await readJson<SupportChatResponse>(response);
      if (!lifecycle.isCurrent(token)) return;
      if (!response.ok || !payload?.data) {
        if (response.status === 409) {
          const refreshed = await refreshBootstrap();
          if (!refreshed || !lifecycle.isCurrent(refreshed)) return;
        }
        if (!lifecycle.isCurrent(token) && response.status !== 409) return;
        setError(errorMessage(payload, response.status));
        return;
      }
      const assistantMessage: PanelMessage = {
        role: "assistant",
        content: responseMessage(payload),
        ...(payload.data.proposal ? { proposal: payload.data.proposal } : {}),
      };
      if (!lifecycle.isCurrent(token)) return;
      setMessages((current) => {
        if (!lifecycle.isCurrent(token)) return current;
        const next = [...current, assistantMessage].slice(-SUPPORT_MAX_MESSAGES);
        messagesRef.current = next;
        persistSupportMessagesIfCurrent(
          lifecycle,
          storageKeyAtStart,
          true,
          hydratedScopeRef.current,
          next,
        );
        return next;
      });
    } catch (cause) {
      if (!lifecycle.isCurrent(token)) return;
      setError(cause instanceof Error ? cause.message : "支持助手暂时不可用，请稍后重试。");
    } finally {
      if (lifecycle.isCurrent(token)) {
        lifecycle.finish(token);
        setSending(false);
      }
    }
  }, [draft, lifecycle, page, refreshBootstrap, sending]);

  const retryLast = React.useCallback(() => {
    const currentMessages = messagesRef.current;
    const retry = supportRetryInput(currentMessages);
    if (retry) void sendMessage(retry.content, { reuseExistingUser: true, requestMessages: retry.requestMessages });
  }, [sendMessage]);

  const executeProposal = React.useCallback(async (proposalId: string) => {
    const scopeAtStart = lifecycle.currentScope;
    if (surface !== "admin" || proposalBusy || executedProposalIds.has(proposalId) || !open || !scopeAtStart) return;
    const request = lifecycle.beginRequest();
    const { token, signal } = request;
    setProposalBusy(proposalId);
    setError(null);
    try {
      const response = await fetchWithTimeout("/api/support/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agenticx-support-scope": scopeAtStart,
        },
        body: JSON.stringify({ proposalId }),
        signal,
      }, SUPPORT_CHAT_TIMEOUT_MS);
      if (!lifecycle.isCurrent(token)) return;
      const payload = await readJson<{ message: string }>(response);
      if (!lifecycle.isCurrent(token)) return;
      if (!response.ok || !payload?.data?.message) {
        setError(errorMessage(payload, response.status));
        return;
      }
      if (!lifecycle.isCurrent(token)) return;
      commitSupportProposalState(
        lifecycle,
        token,
        proposalId,
        { role: "assistant", content: responseMessage({ data: payload.data }) },
        setExecutedProposalIds,
        setMessages,
        messagesRef,
        { storageKey: scopeAtStart, hydratedScope: hydratedScopeRef.current },
      );
    } catch {
      if (!lifecycle.isCurrent(token)) return;
      setError("变更确认失败，请重新获取一份预览后再试。");
    } finally {
      if (lifecycle.isCurrent(token)) {
        lifecycle.finish(token);
        setProposalBusy(null);
      }
    }
  }, [executedProposalIds, lifecycle, open, proposalBusy, surface]);

  if (!open) return null;

  const title = bootstrap?.title ?? EMPTY_BOOTSTRAP.title;
  const canSend = Boolean(bootstrap?.storageKey && draft.trim() && !sending);
  const showStarter = Boolean(
    hydrated &&
    !loadingBootstrap &&
    messages.length === 0,
  );

  return (
    <section
      aria-label={title}
      className={cn(
        placement === "inline"
          ? "absolute right-0 top-10 z-[60] flex w-[min(400px,calc(100vw-2rem))] max-h-[min(560px,calc(100dvh-6rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl shadow-black/20"
          : "fixed bottom-20 right-4 z-[60] flex w-[min(400px,calc(100vw-2rem))] max-h-[min(560px,calc(100dvh-6rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-2xl shadow-black/20",
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-elevated/80 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
          <CircleHelp className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <p className="truncate text-xs text-muted-foreground">{surface === "admin" ? "页面指引与配置助手" : "当前页面使用指引"}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={closePanel} aria-label="关闭支持助手">
          <X />
        </Button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {loadingBootstrap ? (
          <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取当前账号的支持范围…
          </div>
        ) : null}

        {!loadingBootstrap && !bootstrap ? (
          <div className="space-y-2 rounded-xl border border-danger/30 bg-danger-soft/40 px-3 py-3 text-sm">
            <p>{error ?? "支持助手需要有效的登录状态。"}</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              <RotateCcw /> 刷新页面
            </Button>
          </div>
        ) : null}

        {bootstrap && availableModels.length === 0 ? (
          <div className="rounded-xl border border-warning/30 bg-warning-soft/50 px-3 py-2 text-xs text-warning-foreground">
            当前没有可用的模型。你仍可以查看本页静态指引；需要自然语言回答时，请联系管理员配置并授权模型。
          </div>
        ) : null}

        {showStarter ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-muted/45 px-3 py-3 text-sm leading-6">
              <p className="font-medium">我可以帮你了解「{guideMatch.tab?.label ?? guideMatch.guide.title}」</p>
              <p className="mt-1 text-xs text-muted-foreground">{guideMatch.tab?.summary ?? guideMatch.guide.summary}</p>
            </div>
            <div className="space-y-1.5">
              <p className="px-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">可以这样问</p>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs leading-5 transition-colors hover:bg-muted"
                  onClick={() => setDraft(suggestion)}
                >
                  <ArrowUp className="mt-0.5 h-3.5 w-3.5 rotate-45 shrink-0 text-primary" />
                  <span>{suggestion}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message, index) => (
          <div key={`${message.role}-${index}-${message.content.slice(0, 12)}`} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn(
              "max-w-[88%] space-y-2 rounded-2xl px-3 py-2 text-sm leading-6",
              message.role === "user" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted/60 text-foreground",
            )}>
              {message.role === "assistant" ? (
                <SupportAssistantMarkdown content={message.content} />
              ) : (
                <p className="whitespace-pre-wrap break-words">{message.content}</p>
              )}
              {message.proposal && surface === "admin" ? (
                <div className="rounded-xl border border-border bg-background/70 p-2.5 text-xs text-foreground">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{message.proposal.title}</p>
                      <p className="mt-0.5 text-muted-foreground">预览有效期至 {new Date(message.proposal.expiresAt).toLocaleTimeString()}</p>
                    </div>
                    <span className={cn(
                      "rounded-full px-2 py-0.5 text-[10px]",
                      executedProposalIds.has(message.proposal.id)
                        ? "bg-success-soft text-success-foreground"
                        : proposalIsActive(message.proposal)
                          ? "bg-warning-soft text-warning-foreground"
                          : "bg-muted text-muted-foreground",
                    )}>
                      {executedProposalIds.has(message.proposal.id)
                        ? "已确认"
                        : proposalIsActive(message.proposal) ? "待确认" : "已过期"}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {message.proposal.changes.map((change) => (
                      <div key={`${change.label}-${change.before}-${change.after}`} className="rounded-lg border border-border/70 px-2 py-1.5">
                        <p className="font-medium">{change.label}</p>
                        <p className="mt-0.5 text-muted-foreground">{change.before} <span aria-hidden>→</span> {change.after}</p>
                      </div>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    className="mt-2 w-full"
                    disabled={!proposalIsActive(message.proposal) || Boolean(proposalBusy) || executedProposalIds.has(message.proposal.id)}
                    onClick={() => void executeProposal(message.proposal!.id)}
                  >
                    {proposalBusy === message.proposal.id ? <Loader2 className="animate-spin" /> : executedProposalIds.has(message.proposal.id) ? <Check /> : null}
                    {executedProposalIds.has(message.proposal.id) ? "已确认" : "确认并执行"}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {sending ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在根据当前页面整理答案…
          </div>
        ) : null}

        {error ? (
          <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft/40 px-3 py-2 text-xs text-danger" role="alert">
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="ghost" size="xs" onClick={retryLast} disabled={sending} aria-label="重试上一条问题">
              <RotateCcw /> 重试
            </Button>
          </div>
        ) : null}

        {(links.length > 0 || (messages.length > 0 && bootstrap)) ? (
          <div className="space-y-1.5 border-t border-border/70 pt-3">
            {links.length > 0 ? (
              <p className="px-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">相关入口</p>
            ) : null}
            {links.map((link) => (
              <a
                key={`${link.href}-${link.label}`}
                href={link.href}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-primary transition-colors hover:bg-primary-soft"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{link.label}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border bg-surface-subtle px-3 py-3">
        <div className="mb-2 flex items-center gap-2">
          {availableModels.length > 0 ? (
            <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-muted-foreground">
              <span className="shrink-0">回答模型</span>
              <select
                value={selectedModel}
                onChange={(event) => {
                  selectedModelRef.current = event.target.value;
                  setSelectedModel(event.target.value);
                }}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                aria-label="支持助手回答模型"
                disabled={sending}
              >
                <option value="">使用已授权默认模型</option>
                {availableModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </label>
          ) : <span className="flex-1" />}
          <Button variant="ghost" size="xs" onClick={clearHistory} disabled={messages.length === 0 || sending}>
            <Trash2 /> 清空
          </Button>
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="描述你遇到的问题…"
            aria-label="支持助手问题"
            rows={2}
            maxLength={SUPPORT_MAX_MESSAGE_CHARS}
            disabled={!bootstrap || sending}
            className="min-h-[64px] resize-none bg-background pr-2 text-sm"
          />
          <Button size="icon" onClick={() => void sendMessage()} disabled={!canSend} aria-label="发送问题">
            {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
        <p className="mt-1.5 px-1 text-[10px] text-muted-foreground">Enter 换行 · ⌘/Ctrl+Enter 发送</p>
      </div>
    </section>
  );
}

export default SupportAssistantPanel;
