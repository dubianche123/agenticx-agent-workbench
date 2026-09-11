import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopFeedbackAccountStampsEqual,
  shouldApplyDesktopFeedbackAccountStamp,
} from "../../shared/feedback-scope";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
  "utf8",
);
const appSource = fs.readFileSync(path.resolve(process.cwd(), "src/App.tsx"), "utf8");

describe("ChatPane feedback wiring", () => {
  it("writes metadata-only disk merges back before enabling feedback", () => {
    expect(source).toContain("const feedbackMetadataChanged = merged.some");
    expect(source).toContain("FEEDBACK_MESSAGE_ID_METADATA_KEY");
    expect(source).toContain("const feedbackReady =");
    expect(source).toContain("feedbackEnabled && feedbackReady");
    expect(source).not.toContain("feedbackMessageId || _messageId");
  });

  it("retains a session chain and fences account/backend transitions", () => {
    expect(source).toContain("enqueueFeedbackWrite(feedbackWriteChainsRef.current");
    expect(source).toContain("feedbackScopeEpochRef.current === scopeEpoch");
    expect(source).toContain("onUserAccountChanged");
    expect(source).not.toContain("feedbackWriteChainsRef.current = {};");
  });

  it("captures and forwards the immutable auth scope for every mirror", () => {
    expect(source).toContain("feedbackApi.scope({");
    expect(source).toContain("parseChatFeedbackScope(scopePayload)");
    expect(source).toContain("parseChatFeedbackAuthGeneration(scopePayload)");
    expect(source).toContain("feedbackApi.list(sessionId, scopeId)");
    expect(source).toContain('assertChatFeedbackOperationOk(payload, "加载反馈失败")');
    const listFailureGuard = source.indexOf('assertChatFeedbackOperationOk(payload, "加载反馈失败")');
    const scopeCommit = source.indexOf("feedbackScopeIdRef.current = scopeId", listFailureGuard);
    expect(listFailureGuard).toBeGreaterThanOrEqual(0);
    expect(scopeCommit).toBeGreaterThan(listFailureGuard);
    expect(source).toContain("const expectedScopeId = feedbackScopeIdRef.current");
    expect(source).toContain("expectedScopeId,");
    expect(source).toContain("storeBase: feedbackBackendBase");
    expect(source).toContain("apiToken: feedbackBackendToken");
    expect(source).toContain("feedbackScopeId");
    expect(source).toContain("feedbackRenderedScopeId");
    expect(source).toContain("feedbackRenderedAuthGeneration");
    expect(source).toContain("expectedAuthGeneration");
    expect(source).toContain("expectedScopeId");
    expect(source).toContain("feedbackPendingAccountStampRef");
    expect(source).toContain("desktopFeedbackAccountStampsEqual");
    expect(source).not.toContain("expectedPortalOrigin");
    expect(source).not.toContain("expectedEmail");
    expect(source).toContain("onUserAccountChanging");
    expect(source).toContain("feedbackAccountChangingRef");
  });

  it("holds an account event until the full trusted store stamp arrives", () => {
    const scopeA = '["https://portal","tenant-a","same@example.com"]';
    const scopeB = '["https://portal","tenant-b","same@example.com"]';
    let storeStamp = { scopeId: scopeA, authGeneration: 7 };
    const eventStamp = { scopeId: scopeB, authGeneration: 8 };
    const applyLoadedStamp = (loaded: { scopeId: string; authGeneration: number }) => {
      if (
        !desktopFeedbackAccountStampsEqual(
          loaded.scopeId,
          loaded.authGeneration,
          eventStamp.scopeId,
          eventStamp.authGeneration,
        ) ||
        !shouldApplyDesktopFeedbackAccountStamp(
          storeStamp.scopeId,
          storeStamp.authGeneration,
          loaded.scopeId,
          loaded.authGeneration,
        )
      ) {
        return false;
      }
      storeStamp = loaded;
      return true;
    };
    // The changed event can arrive while the account store still renders A;
    // a deferred A load must not satisfy B's expectation.
    expect(
      desktopFeedbackAccountStampsEqual(scopeA, 7, scopeB, 8),
    ).toBe(false);
    expect(applyLoadedStamp({ scopeId: scopeA, authGeneration: 7 })).toBe(false);
    expect(storeStamp).toEqual({ scopeId: scopeA, authGeneration: 7 });
    expect(applyLoadedStamp(eventStamp)).toBe(true);
    expect(storeStamp).toEqual(eventStamp);
    expect(
      shouldApplyDesktopFeedbackAccountStamp(scopeA, 7, scopeA, 7),
    ).toBe(true);
    expect(
      shouldApplyDesktopFeedbackAccountStamp(scopeA, 7, scopeB, 8),
    ).toBe(true);
    expect(appSource).toContain("pendingAccountEvent");
    expect(appSource).toContain("expectedStamp");
    expect(appSource).toContain("shouldApplyDesktopFeedbackAccountStamp");
    expect(appSource).toContain("feedbackScopeId: nextScopeId");
    expect(appSource).toContain("feedbackAuthGeneration: nextAuthGeneration");
    // Account changed only queues the full read; it does not copy B's
    // identity into a store that still carries A's capability policy.
    expect(appSource).toContain("void hydrateUserAccount(pendingAccountEvent.stamp)");
  });
});
