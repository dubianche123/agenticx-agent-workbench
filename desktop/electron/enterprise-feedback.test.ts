import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalDesktopExternalMessageId,
  desktopRendererMessageId,
  desktopFeedbackListScopeMatches,
  normalizeDesktopFeedbackScopeId,
  rendererMessageIdForCanonicalExternalId,
  resolveDesktopAssistantMessage,
} from "./enterprise-feedback";
import {
  desktopFeedbackAccountStampsEqual,
  desktopFeedbackScopeHandshakeMatches,
  normalizeDesktopFeedbackAccountStamp,
  shouldApplyDesktopFeedbackAccountStamp,
} from "./feedback-scope";

const sessionId = "session-1";

describe("desktop feedback external identity", () => {
  it("resolves only a completed assistant row and canonicalizes its renderer id", () => {
    const messages = [
      { id: "u-1", role: "user", content: "question" },
      { id: "a-1", role: "assistant", status: "complete", content: "answer\nwith two lines", model: "openai/gpt" },
      { id: "t-1", role: "tool", content: "tool output" },
    ];
    const target = resolveDesktopAssistantMessage(
      sessionId,
      desktopRendererMessageId(sessionId, 1, "a-1"),
      messages,
    );
    expect(target).toMatchObject({
      sessionId,
      externalMessageId: "session-1-i1-a-1",
      answerExcerpt: "answer\nwith two lines",
      model: "openai/gpt",
      provider: "openai",
    });
    expect(resolveDesktopAssistantMessage(sessionId, "session-1-i0-u-1", messages)).toBeNull();
    expect(resolveDesktopAssistantMessage(sessionId, "session-1-i2-t-1", messages)).toBeNull();
    expect(resolveDesktopAssistantMessage("other-session", "session-1-i1-a-1", messages)).toBeNull();
    expect(resolveDesktopAssistantMessage(sessionId, "session-1-i1-a-1", [
      { id: "a-1", role: "assistant", content: "partial", metadata: { turn_terminal: false } },
    ])).toBeNull();
  });

  it("accepts a persisted raw id but always returns the same canonical id", () => {
    const messages = [{ id: "a-1", role: "assistant", content: "answer" }];
    expect(resolveDesktopAssistantMessage(sessionId, "a-1", messages)?.externalMessageId).toBe(
      "session-1-i0-a-1",
    );
  });

  it("resolves the durable address used by a live uid row after merge", () => {
    // The renderer keeps `uid-a` as its React key, while its metadata carries
    // this persisted address. The main process resolves only against disk.
    const feedbackId = "session-1-i1-stored-a";
    expect(resolveDesktopAssistantMessage(
      sessionId,
      feedbackId,
      [
        { id: "stored-u", role: "user", content: "question" },
        { id: "stored-a", role: "assistant", content: "answer" },
      ],
    )?.externalMessageId).toBe("session-1-i1-stored-a");
  });

  it("uses a bounded digest when the visible local id is too long", () => {
    const storedId = "a".repeat(500);
    const visibleId = desktopRendererMessageId(sessionId, 0, storedId);
    const canonical = canonicalDesktopExternalMessageId(sessionId, 0, storedId);
    expect(visibleId.length).toBeGreaterThan(128);
    expect(canonical).toMatch(/^desktop-message-[0-9a-f]{64}$/);
    expect(rendererMessageIdForCanonicalExternalId(
      sessionId,
      canonical,
      [{ id: storedId, role: "assistant", content: "answer" }],
    )).toBe(visibleId);
    expect(resolveDesktopAssistantMessage(sessionId, visibleId, [
      { id: storedId, role: "assistant", content: "answer" },
    ])?.externalMessageId).toBe(canonical);
  });

  it("does not accept unsafe external message ids", () => {
    const messages = [{ id: "a-1", role: "assistant", content: "answer" }];
    expect(resolveDesktopAssistantMessage(sessionId, "../a-1", messages)).toBeNull();
    expect(resolveDesktopAssistantMessage(sessionId, "a/1", messages)).toBeNull();
  });

  it("accepts only bounded opaque account scopes", () => {
    expect(normalizeDesktopFeedbackScopeId('["https://portal","tenant-a","user-a"]')).toBe(
      '["https://portal","tenant-a","user-a"]',
    );
    expect(normalizeDesktopFeedbackScopeId("")).toBeNull();
    expect(normalizeDesktopFeedbackScopeId("scope\u0000old")).toBeNull();
    expect(normalizeDesktopFeedbackScopeId("x".repeat(513))).toBeNull();
  });

  it("requires the complete trusted scope and generation stamp", () => {
    const scopeA = '["https://portal","tenant-a","user-a"]';
    const scopeB = '["https://portal","tenant-b","user-b"]';
    expect(normalizeDesktopFeedbackAccountStamp(scopeA, 4)).toEqual({
      scopeId: scopeA,
      authGeneration: 4,
    });
    expect(normalizeDesktopFeedbackAccountStamp(scopeA, "4")).toBeNull();
    expect(desktopFeedbackScopeHandshakeMatches(
      scopeA,
      scopeA,
      4,
      4,
    )).toBe(true);
    expect(desktopFeedbackScopeHandshakeMatches(
      scopeA,
      scopeB,
      4,
      4,
    )).toBe(false);
    // Equal email addresses do not collapse tenant/user scopes.
    expect(desktopFeedbackScopeHandshakeMatches(
      scopeA,
      scopeB,
      4,
      5,
    )).toBe(false);
    expect(desktopFeedbackScopeHandshakeMatches(scopeA, scopeA, 4, 5)).toBe(false);
    expect(desktopFeedbackScopeHandshakeMatches(scopeA, scopeA, undefined, 4)).toBe(false);
    expect(desktopFeedbackAccountStampsEqual(scopeB, 5, scopeB, 5)).toBe(true);
    expect(shouldApplyDesktopFeedbackAccountStamp(scopeA, 4, scopeA, 4)).toBe(true);
    expect(shouldApplyDesktopFeedbackAccountStamp(scopeA, 4, scopeB, 5)).toBe(true);
    expect(shouldApplyDesktopFeedbackAccountStamp(scopeB, 5, scopeA, 4)).toBe(false);
  });

  it("binds both enterprise mutations to a main-process verified scope", () => {
    const source = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
    expect(source).toContain('"enterprise-feedback-scope"');
    expect(source).toContain("desktopFeedbackScopeError(auth, parsed.expectedScopeId)");
    expect(source).toContain('desktopFeedbackPortalRequest(auth, "PUT"');
    expect(source).toContain('desktopFeedbackPortalRequest(auth, "DELETE"');
    expect(source).toContain("scopeId: enterpriseStableIdentityKey(");
    expect(source).toContain("const currentAuth = currentEnterprisePortalAuth();");
    expect(source).toContain("desktopFeedbackListScopeError(");
    expect(source).toContain("parseDesktopFeedbackScopeRequest");
    expect(source).toContain("desktopFeedbackScopeHandshakeMatches");
    expect(source).toContain('"user-account-changing"');
    expect(source).toContain("auth_generation: enterpriseAuthGeneration");
    expect(source).toContain("currentEnterpriseFeedbackAccountStamp");
    expect(source).not.toContain("expectedPortalOrigin");
    expect(source).not.toContain("expectedEmail");

    const finish = source.indexOf("async function finishEnterpriseLoginUnlocked");
    const finishTransition = source.indexOf("if (identityTransition.cleanupRequired)", finish);
    const finishInvalidation = source.indexOf("notifyEnterpriseAuthChanging();", finishTransition);
    const finishPreparation = source.indexOf("const prepared = await prepareEnterpriseIdentityChange", finishInvalidation);
    expect(finish).toBeGreaterThanOrEqual(0);
    expect(finishTransition).toBeGreaterThan(finish);
    expect(finishInvalidation).toBeGreaterThan(finishTransition);
    expect(finishPreparation).toBeGreaterThan(finishInvalidation);

    const logout = source.indexOf("async function logoutEnterpriseAccount");
    const logoutAdvance = source.indexOf("advanceEnterpriseAuthGeneration();", logout);
    const logoutInvalidation = source.indexOf("notifyEnterpriseAuthChanging();", logoutAdvance);
    const logoutLock = source.indexOf("return withEnterpriseMutationLock", logoutInvalidation);
    expect(logoutAdvance).toBeGreaterThan(logout);
    expect(logoutInvalidation).toBeGreaterThan(logoutAdvance);
    expect(logoutLock).toBeGreaterThan(logoutInvalidation);
  });

  it("rejects a deferred scope handshake when config commits B before the old pane is notified", async () => {
    let releaseScope!: () => void;
    const deferredScope = new Promise<void>((resolve) => {
      releaseScope = resolve;
    });
    const renderedScope = '["https://portal-a","tenant-a","user-a"]';
    const guardedScope = deferredScope.then(() => desktopFeedbackScopeHandshakeMatches(
      renderedScope,
      '["https://portal-b","tenant-b","user-b"]',
      11,
      12,
    ));

    // Model saveAgxConfig(B) completing before the asynchronous
    // user-account-changed event reaches the renderer.
    releaseScope();
    await expect(guardedScope).resolves.toBe(false);
  });

  it("rejects a deferred list response after the trusted account switches", async () => {
    const scopeA = '["https://portal","tenant-a","user-a"]';
    const scopeB = '["https://portal","tenant-b","user-b"]';
    let currentScope = scopeA;
    let releaseGet!: (value: { items: string[] }) => void;
    const deferredGet = new Promise<{ items: string[] }>((resolve) => {
      releaseGet = resolve;
    });
    const capturedScope = scopeA;
    const guardedList = async () => {
      const response = await deferredGet;
      return desktopFeedbackListScopeMatches(capturedScope, currentScope, capturedScope)
        ? response
        : null;
    };

    // Model the capability-sync window: the GET was started for A, then the
    // trusted host config changes to B before the Portal response arrives.
    currentScope = scopeB;
    releaseGet({ items: ["A-only-vote"] });
    await expect(guardedList()).resolves.toBeNull();
    expect(desktopFeedbackListScopeMatches(scopeB, scopeB, scopeB)).toBe(true);
  });
});
