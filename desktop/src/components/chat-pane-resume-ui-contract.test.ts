import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildInterruptedAssistantMetadata,
  buildGroupInterruptedHistoryMessages,
  collectGroupInterruptedPartials,
  groupTeamControlStateForSession,
  claimSessionStreamOwner,
  isForegroundRunGenerationCurrent,
  isPaneDisplayingSession,
  ownsForegroundRequestController,
  ownsStopRunLease,
  ownsSessionStreamOwner,
  rekeyForegroundRequestController,
  rekeySessionStreamOwner,
  shouldApplyGroupGraphEvent,
  type StopRunLease,
} from "./ChatPane";
import { isPublicGroupMessage } from "../utils/group-message-state";

describe("composer resume action", () => {
  it("restores Team control state per session and keeps empty sessions idle", () => {
    const states = {
      "session-paused": "paused" as const,
      "session-running": "running" as const,
    };

    expect(groupTeamControlStateForSession(states, "session-paused")).toBe("paused");
    expect(groupTeamControlStateForSession(states, "session-running")).toBe("running");
    expect(groupTeamControlStateForSession(states, "session-new")).toBe("idle");
    expect(groupTeamControlStateForSession(states, "")).toBe("idle");
  });

  it("rejects stale graph runs while allowing an explicit run-created transition", () => {
    expect(shouldApplyGroupGraphEvent("run-current", "run-old")).toBe(false);
    expect(shouldApplyGroupGraphEvent("run-current", "run-old", {
      allowRunSwitch: true,
      eventType: "graph.node_updated",
    })).toBe(false);
    expect(shouldApplyGroupGraphEvent("run-current", "run-next", {
      allowRunSwitch: true,
      eventType: "graph.run_created",
      authoritative: true,
    })).toBe(true);
    expect(shouldApplyGroupGraphEvent("run-current", "run-old", {
      allowRunSwitch: true,
      eventType: "graph.run_created",
    })).toBe(false);
    expect(shouldApplyGroupGraphEvent("run-current", "run-old", {
      allowRunSwitch: true,
      eventType: "graph.run_created",
      authoritative: false,
    })).toBe(false);
    expect(shouldApplyGroupGraphEvent("", "run-first")).toBe(true);
    expect(shouldApplyGroupGraphEvent("run-current", "")).toBe(false);
  });

  it("uses the hidden continuation path for an empty interrupted composer", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );

    expect(source).toContain('title = resuming ? "恢复中" : "继续执行"');
    expect(source).toContain('sessionExecutionState === "interrupted"');
    expect(source).toContain("onResume={() => void resumeCurrentTask()}");
    expect(source).toContain('continuation: { reason, source: "desktop_manual" }');
    expect(source).toContain('sendChatRef.current("", {');
    expect(source).toContain("const liveReattachEnabledRef = useRef(true);");
  });

  it("keeps private group replies out of Feed and sends canonical quote ids", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );

    expect(source).toContain("if (isGroupPane) return !isExplicitlyPrivateGroupMessage(item);");
    expect(source).toContain("if (!isAdmittedPublicReply) {");
    expect(source).toContain("body.quote_message_ids = quotePayloadAtSend.quoteMessageIds;");
  });

  it("claims only visible group partials and builds non-feed interruption rows", () => {
    const partials = collectGroupInterruptedPartials(
      {
        "member-a": "<think>internal reasoning</think>已完成一半",
        "member-b": "__SKIP__",
        "member-c": "⏳",
      },
      [{ id: "member-a", name: "执行员", avatarUrl: "avatar-a" }],
    );

    expect(partials).toEqual([
      {
        agentId: "member-a",
        content: "已完成一半",
        avatarName: "执行员",
        avatarUrl: "avatar-a",
      },
    ]);

    const rows = buildGroupInterruptedHistoryMessages(partials, "barge-in");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      content: "已完成一半",
      agent_id: "member-a",
      metadata: {
        kind: "group_interrupted_partial",
        partial: true,
        interrupted: true,
        turn_terminal: false,
        terminal_reason: "interrupted",
        interruption_trigger: "barge-in",
      },
    });
    expect(rows[0]).not.toHaveProperty("group_message_id");
    expect(rows[0]).not.toHaveProperty("is_public");
    expect(
      isPublicGroupMessage({
        role: rows[0].role,
        groupMessageId: undefined,
        metadata: rows[0].metadata,
      }),
    ).toBe(false);
    expect(rows[1]).toMatchObject({
      role: "tool",
      agent_id: "__meta__",
      metadata: {
        kind: "turn_interrupted",
        cause: "user_interrupt",
        group_interrupted: true,
        partial_count: 1,
      },
    });
  });

  it("marks ordinary stop and barge-in transcript rows as incomplete", () => {
    expect(buildInterruptedAssistantMetadata()).toMatchObject({
      source: "interrupted-partial",
      partial: true,
      interrupted: true,
      turn_terminal: false,
      terminal_reason: "interrupted",
    });
    expect(buildInterruptedAssistantMetadata("barge-in")).toMatchObject({
      source: "barge-in",
      partial: true,
      interrupted: true,
      turn_terminal: false,
      terminal_reason: "interrupted",
    });

    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    expect(source).toContain("metadata: buildInterruptedAssistantMetadata()");
    expect(source).toContain(
      'const interruptedNoteMetadata = buildInterruptedAssistantMetadata("barge-in");',
    );
    expect(source).toContain("metadata: interruptedNoteMetadata");
  });

  it("authenticates group actions and persists group interruption context", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const actionStart = source.indexOf("const sendGroupTeamAction");
    const sendStart = source.indexOf("const sendChat", actionStart);
    const actionSource = source.slice(actionStart, sendStart);

    expect(actionSource).toContain('"x-agx-desktop-token": apiToken');
    expect(actionSource).toContain("if (!response.ok || result.ok === false)");
    expect(actionSource).toContain("setStallHintToast(`群聊操作失败：${reason.slice(0, 180)}`);");
    expect(source).toContain("const groupInterruptedPersistence = isGroupPane");
    expect(source).toContain("preserveGroupInterruptedPartials(");
    const helperStart = source.indexOf("const preserveGroupInterruptedPartials");
    const stopStart = source.indexOf("const stopCurrentRun");
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(stopStart).toBeGreaterThan(helperStart);
    // A forced resume may only preserve a partial after the request still owns
    // the displayed pane. Keep this source contract tied to that fence instead
    // of the pre-fence condition that allowed a stale session to write UI.
    expect(source).toContain("isForceSessionStillDisplayed() &&");
    expect(source).toMatch(
      /isForceSessionStillDisplayed\(\)\s*&&\s*!isGroupPane\s*&&\s*!preservedVisiblePartial/,
    );
    expect(source).toContain('"x-agx-desktop-token": apiToken');
  });

  it("keeps project-team pause/resume controls synchronized with workforce events", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );

    expect(source).toContain('"idle" | "running" | "paused" | "stopped"');
    expect(source).toContain("Record<string, GroupTeamControlState>");
    expect(source).toContain("groupTeamControlStateForSession(");
    expect(source).toContain('Boolean((pane.sessionId || "").trim())');
    expect(source).toContain('event === "workforce_started" || event === "workforce_resumed"');
    expect(source).toContain('event === "workforce_paused"');
    expect(source).toContain('event === "workforce_stopped"');
    expect(source).toContain("applyGroupTeamControlEvent(payload.type, payload.data);");
    expect(source).toContain('groupTeamPaused ? "resume" : "pause"');
    expect(source).toContain('title={paused ? "继续团队任务" : "暂停团队任务"}');
    expect(source).toContain('title="停止团队任务"');
    expect(source).toContain('sendGroupTeamAction("stop")');
    expect(source).toContain('String(apiBase || "").replace(/\\/+$/, "")');
    expect(source).not.toContain('__AGX_URL__');
    expect(source).toContain('setStallHintToast("团队任务已暂停");');
    expect(source).toContain('setStallHintToast("团队任务已继续");');
    expect(source).toContain("recordSseActivity(requestSessionId);");
    expect(source).toContain('setStallHintToast("任务已加入本轮协作");');
    expect(source).toContain("graphEvent as GraphSsePayload");
    expect(source).toContain("candidate.id === requestPaneId");
    expect(source).toContain("return isPaneDisplayingSession(currentPane, pane.id, requestSessionId);");
    expect(source).toContain("const actionGeneration = ++groupTeamActionGenerationRef.current;");
    expect(source).toContain("actionGeneration === groupTeamActionGenerationRef.current");
    expect(source).toContain("shouldApplyGroupGraphEvent(");
    expect(source).toContain('eventType: "graph.run_created",\n            authoritative: true');
    expect(source).toContain("acceptsGroupGraphEvent(requestSessionId, graphPayload");
    expect(source).toContain("if (!sessionStillActive) continue;");
    expect(source).toContain("if (!isCurrentActionSession()) return false;");
    expect(source).toContain("if (groupTeamActionGenerationRef.current === actionGeneration)");
    expect(source).toContain("groupTeamActionPendingRef.current = false;");
    expect(source).toContain("setGroupTeamActionPending(false);");
  });

  it("drops stale same-session foreground SSE frames before sequence or UI writes", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const foregroundStart = source.indexOf("const abortController = new AbortController();");
    const frameStart = source.indexOf("for (const frame of frames)", foregroundStart);
    const frameGuard = source.indexOf(
      "if (!isCurrentForegroundRequest()) continue;",
      frameStart,
    );
    const parseFrame = source.indexOf(
      "const { eventId, payload: parsedPayload } = parseSseFrame(frame);",
      frameStart,
    );
    const seqWrite = source.indexOf(
      "reattachLastSeqRef.current[requestSessionId] = sequence.nextSeq;",
      parseFrame,
    );
    const activityWrite = source.indexOf("recordSseActivity(requestSessionId);", parseFrame);

    expect(foregroundStart).toBeGreaterThanOrEqual(0);
    expect(source).toContain("const ownsForegroundRequest = () =>");
    expect(source).toContain("let foregroundRequestSessionId = requestSessionId;");
    expect(source).toContain("ownsForegroundRequestController(");
    expect(source).toContain("foregroundRequestSessionId,\n        abortController,");
    expect(source).toContain("registry[sid] === controller");
    expect(source).not.toContain("Object.values(sessionAbortControllersRef.current)");
    expect(source).toContain("const rekeyForegroundRequest = (nextSessionId: string)");
    expect(source).toContain("delete registry[current];");
    expect(source).toContain("registry[next] = controller;");
    expect(source).toContain("if (!rekeyForegroundRequest(migratedSessionId)) return;");
    expect(source).toContain("const streamState = sessionStreamStateRef.current[current];");
    expect(source).toContain("sessionStreamStateRef.current[next] = streamState;");
    expect(source).toContain("delete sessionStreamStateRef.current[current];");
    expect(source).toContain("const lastSeq = reattachLastSeqRef.current[current];");
    expect(source).toContain("reattachLastSeqRef.current[next] = lastSeq;");
    expect(source).toContain("streamCommitRegistryRef.current.beginSession(next);");
    expect(source).toContain("streamCommitRegistryRef.current.clearSession(current);");
    expect(source).toContain("setRunGuardSessionId(next);");
    expect(frameStart).toBeGreaterThan(foregroundStart);
    expect(frameGuard).toBeGreaterThan(frameStart);
    expect(frameGuard).toBeLessThan(parseFrame);
    expect(frameGuard).toBeLessThan(seqWrite);
    expect(frameGuard).toBeLessThan(activityWrite);
  });

  it("gates reattach frames and cleanup by the exact generation/controller lease", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const reattachStart = source.indexOf("const reattachLiveStream");
    const reattachEnd = source.indexOf("useEffect(() => {", reattachStart);
    const reattachSource = source.slice(reattachStart, reattachEnd);
    const frameStart = reattachSource.indexOf("for (const frame of frames)");
    const frameGuard = reattachSource.indexOf("if (!ownsReattachStream()) continue;", frameStart);
    const seqWrite = reattachSource.indexOf("reattachLastSeqRef.current[sid] = lastSeq;", frameStart);
    const doneStateWrite = reattachSource.indexOf(
      'setGroupTeamControlStateForSession(sid, "stopped");',
      frameStart,
    );
    const finallyStart = reattachSource.indexOf("} finally {");
    const finallyGuard = reattachSource.indexOf("if (!ownsReattachStream()) return;", finallyStart);
    const streamStateWrite = reattachSource.indexOf("st.active = false;", finallyStart);
    const seqDelete = reattachSource.indexOf("delete reattachLastSeqRef.current[sid];", finallyStart);

    expect(reattachSource).toContain("const reattachGeneration = claimSessionStreamOwner(");
    expect(reattachSource).toContain("ownsSessionStreamOwner(");
    expect(reattachSource).toContain("const isCurrentOwned = () => ownsReattachStream() && isCurrent();");
    expect(frameGuard).toBeGreaterThanOrEqual(0);
    expect(frameGuard).toBeLessThan(seqWrite);
    expect(frameGuard).toBeLessThan(doneStateWrite);
    expect(finallyGuard).toBeGreaterThanOrEqual(0);
    expect(finallyGuard).toBeLessThan(streamStateWrite);
    expect(finallyGuard).toBeLessThan(seqDelete);
    expect(reattachSource).toContain("if (reattachControllersRef.current[sid] === ctrl)");
  });

  it("fences buffered A progress, tokens, done, and finally after the pane switches to B", () => {
    const paneA = { id: "pane-1", sessionId: "session-a" };
    const paneB = { id: "pane-1", sessionId: "session-b" };
    const applied: string[] = [];
    const applyDisplayedFrame = (
      pane: typeof paneA,
      frameSessionId: string,
      kind: string,
    ) => {
      if (!isPaneDisplayingSession(pane, "pane-1", frameSessionId)) return;
      applied.push(kind);
    };

    for (const kind of ["group_progress", "group_token", "done", "finally"]) {
      applyDisplayedFrame(paneB, "session-a", kind);
    }
    expect(applied).toEqual([]);

    applyDisplayedFrame(paneB, "session-b", "current-token");
    expect(applied).toEqual(["current-token"]);
  });

  it("fences delayed retry/edit/resume writes after an A to B navigation", async () => {
    let displayed = { id: "pane-1", sessionId: "session-a" };
    const writes: string[] = [];
    const writeForSession = async (sessionId: string, label: string, wait: Promise<void>) => {
      await wait;
      if (isPaneDisplayingSession(displayed, "pane-1", sessionId)) {
        writes.push(label);
      }
    };

    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Promise.all([
      writeForSession("session-a", "retry-slice", delayed),
      writeForSession("session-a", "edit-reload", delayed),
      writeForSession("session-a", "resume-state", delayed),
    ]);

    displayed = { id: "pane-1", sessionId: "session-b" };
    release();
    await pending;
    expect(writes).toEqual([]);

    displayed = { id: "pane-1", sessionId: "session-b" };
    await writeForSession("session-b", "current-B", Promise.resolve());
    expect(writes).toEqual(["current-B"]);
  });

  it("requires retry/edit/resume continuations to re-check the captured pane lease", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const editStart = source.indexOf("const editUserMessage = useCallback");
    const retryStart = source.indexOf("const retryUserMessage = useCallback");
    const resumeStart = source.indexOf("const resumeCurrentTask = useCallback");
    const editSource = source.slice(editStart, retryStart);
    const retrySource = source.slice(retryStart, resumeStart);
    const resumeEnd = source.indexOf("const resumeWithModel = useCallback", resumeStart);
    const resumeSource = source.slice(resumeStart, resumeEnd);

    expect(editSource).toContain("const requestPaneId = pane.id;");
    expect(editSource).toContain("const isDisplayed = () =>");
    expect(editSource).toContain("const ok = await truncateSessionAtUserMessage(");
    expect(editSource).toContain("if (!isDisplayed()) return;");
    expect(editSource).toContain("reloadSessionFromDisk(sid, { isCurrentOwner: isDisplayed });");
    expect(editSource).toContain("setPaneMessages(requestPaneId, msgs.slice(0, idx));");
    expect(editSource).toContain("await sendChatRef.current(newContent");

    expect(retrySource).toContain("const requestPaneId = pane.id;");
    expect(retrySource).toContain("await interruptForResume(sid);");
    expect(retrySource).toContain("await new Promise((resolve) => window.setTimeout(resolve, 60));");
    expect(retrySource).toContain("reloadSessionFromDisk(sid, { isCurrentOwner: isDisplayed });");
    expect(retrySource).toContain("setPaneMessages(requestPaneId, msgs.slice(0, idx + 1));");
    expect(retrySource).toContain("if (isDisplayed()) {");

    expect(resumeSource).toContain("const requestPaneId = pane.id;");
    expect(resumeSource).toContain("const r = await window.agenticxDesktop.listSessions");
    expect(resumeSource).toContain("const resumeGeneration = beginResumeInFlight(sid);");
    expect(resumeSource).toContain("const ownsResumeAction = () =>");
    expect(resumeSource).toContain("clearResumeInFlight(sid, resumeGeneration);");
    expect(resumeSource).toContain("await interruptForResume(sid);");
    expect(resumeSource).toContain("isCurrentOwner: isDisplayed");
    expect(resumeSource).toContain("lockedSessionId: sid");
  });

  it("only drains a reattach queue after its exact owner reaches terminal", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const reattachStart = source.indexOf("const reattachLiveStream");
    const reattachEnd = source.indexOf("useEffect(() => {", reattachStart);
    const reattachSource = source.slice(reattachStart, reattachEnd);
    const terminal = reattachSource.indexOf("if (reachedTerminal) {");
    const dequeue = reattachSource.indexOf("dequeuePaneMessageForSession", terminal);
    const ownerDelete = reattachSource.indexOf("delete sessionStreamOwnersRef.current[sid];", terminal);
    const queueDrain = reattachSource.indexOf("queueDrain: true", ownerDelete);

    expect(terminal).toBeGreaterThanOrEqual(0);
    expect(dequeue).toBeGreaterThan(terminal);
    expect(dequeue).toBeLessThan(ownerDelete);
    expect(reattachSource).toContain("if (isPaneDisplayingSession(currentPane, pane.id, sid))");
    expect(queueDrain).toBeGreaterThan(ownerDelete);

    const manualQueueStart = source.indexOf("const sendQueuedMessageNow = useCallback");
    const manualQueueEnd = source.indexOf("const applySkillPatchPreview", manualQueueStart);
    const manualQueue = source.slice(manualQueueStart, manualQueueEnd);
    expect(manualQueue).toContain("const queued = (useAppStore.getState().pendingMessages[paneId] ?? []).find(");
    expect(manualQueue).toContain("queuedSessionId &&");
    expect(manualQueue).toContain("const item = takePendingMessage(paneId, msgId);");
    expect(manualQueue).toContain("enqueuePaneMessage(paneId, item);");
    expect(manualQueue).toContain("queueDrain: true");
  });

  it("stamps missing graph session/group ownership before applying admitted events", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const reattachStart = source.indexOf("const reattachLiveStream");
    const reattachEnd = source.indexOf("useEffect(() => {", reattachStart);
    const reattachSource = source.slice(reattachStart, reattachEnd);
    const foregroundStart = source.indexOf("const abortController = new AbortController();");
    const foregroundEnd = source.indexOf("sendChatRef.current = sendChat;", foregroundStart);
    const foregroundSource = source.slice(foregroundStart, foregroundEnd);

    expect(reattachSource).toContain("session_id:");
    expect(reattachSource).toContain("|| sid");
    expect(reattachSource).toContain("group_id:");
    expect(reattachSource).toContain("|| groupChatId || \"\"");
    expect(foregroundSource).toContain("session_id:");
    expect(foregroundSource).toContain("|| requestSessionId");
    expect(foregroundSource).toContain("group_id:");
    expect(foregroundSource).toContain("|| groupChatId || \"\"");
  });

  it("fences delayed delete success and recovery reloads after an A to B switch", async () => {
    let displayed = { id: "pane-1", sessionId: "session-a" };
    const writes: string[] = [];
    const applyDeleteResult = async (kind: "success" | "recovery", wait: Promise<void>) => {
      await wait;
      if (!isPaneDisplayingSession(displayed, "pane-1", "session-a")) return;
      writes.push(kind);
    };
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Promise.all([
      applyDeleteResult("success", delayed),
      applyDeleteResult("recovery", delayed),
    ]);
    displayed = { id: "pane-1", sessionId: "session-b" };
    release();
    await pending;
    expect(writes).toEqual([]);

    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const deleteStart = source.indexOf("const deleteSelectedMessages = useCallback");
    const reloadStart = source.indexOf("const reloadSessionFromDisk = useCallback", deleteStart);
    const deleteSource = source.slice(deleteStart, reloadStart);
    expect(deleteSource).toContain("const requestPaneId = pane.id;");
    expect(deleteSource).toContain("const requestSessionId = String(pane.sessionId || \"\").trim();");
    expect(deleteSource).toContain("const selectedSnapshot = selectedMessages.slice();");
    expect(deleteSource).toContain("if (!isDisplayed()) return;");
    expect(deleteSource).toContain("session_id: requestSessionId");
    expect(deleteSource).toContain("messages: selectedSnapshot.map");
    expect(deleteSource).toContain("loadSessionMessages(requestSessionId)");
    expect(deleteSource).toContain("const currentPane = useAppStore.getState().panes.find");
    expect(deleteSource).toContain("setPaneMessages(requestPaneId,");
  });

  it("resets pane-level group overlays and resume projection in layout on session switch", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const marker = source.indexOf("const displayedGroupSessionRef = useRef(\"\");");
    const effectStart = source.indexOf("useLayoutEffect(() => {", marker);
    const effectEnd = source.indexOf("const applyGroupWorkflowDetailPayload", effectStart);
    const effectSource = source.slice(effectStart, effectEnd);
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(effectSource).toContain("const previousSessionId = displayedGroupSessionRef.current;");
    expect(effectSource).toContain("clearAllGroupMemberStatus();");
    expect(effectSource).toContain("streamRafGenerationRef.current += 1;");
    expect(effectSource).toContain("setStreamedAssistantText(\"\");");
    expect(effectSource).not.toContain("delete resumeInFlightRef.current[previousSessionId];");
    expect(effectSource).toContain("leave A's per-session");
    expect(effectSource).toContain("setResumeInFlight(false);");

    const paneA = { id: "pane-1", sessionId: "session-a" };
    const paneB = { id: "pane-1", sessionId: "session-b" };
    const staleFrameAllowed = isPaneDisplayingSession(paneB, paneB.id, paneA.sessionId);
    expect(staleFrameAllowed).toBe(false);
  });

  it("keeps concurrent resume watchdogs isolated by session and generation", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const declarationStart = source.indexOf("const resumeInFlightRef");
    const declarationEnd = source.indexOf("/** Mirrors stallState", declarationStart);
    const declarations = source.slice(declarationStart, declarationEnd);
    expect(declarations).toContain(
      "const resumeInFlightTimersRef = useRef<Record<string, number>>({});",
    );
    expect(declarations).not.toContain("resumeInFlightTimerRef");
    expect(declarations).not.toContain("resumeInFlightTimerSessionRef");

    const clearStart = source.indexOf("const clearResumeInFlight");
    const beginStart = source.indexOf("const beginResumeInFlight", clearStart);
    const syncStart = source.indexOf("const syncStreamingUiForCurrentSession", beginStart);
    const timerSource = source.slice(clearStart, syncStart);
    expect(timerSource).toContain("const timer = resumeInFlightTimersRef.current[key];");
    expect(timerSource).toContain("delete resumeInFlightTimersRef.current[key];");
    expect(timerSource).toContain("const previousTimer = resumeInFlightTimersRef.current[key];");
    expect(timerSource).toContain("resumeInFlightTimersRef.current[key] = window.setTimeout");
    expect(timerSource).not.toContain("resumeInFlightTimerSessionRef");

    vi.useFakeTimers();
    try {
      const timers: Record<string, ReturnType<typeof setTimeout>> = {};
      const resumeRefs: Record<string, boolean> = {};
      const beginWatchdog = (sessionId: string) => {
        resumeRefs[sessionId] = true;
        timers[sessionId] = setTimeout(() => {
          resumeRefs[sessionId] = false;
          delete timers[sessionId];
        }, 8000);
      };

      beginWatchdog("session-a");
      vi.advanceTimersByTime(4000);
      beginWatchdog("session-b");

      // Starting B must leave A's watchdog armed; only A should settle at t=8s.
      vi.advanceTimersByTime(3999);
      expect(resumeRefs).toEqual({ "session-a": true, "session-b": true });
      vi.advanceTimersByTime(1);
      expect(resumeRefs).toEqual({ "session-a": false, "session-b": true });
      expect(Object.keys(timers)).toEqual(["session-b"]);

      // B has its own deadline, independent of A's timeout and cleanup.
      vi.advanceTimersByTime(4000);
      expect(resumeRefs).toEqual({ "session-a": false, "session-b": false });
      expect(timers).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the exact session/group owner to every graph event write", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const applyEvents = [...source.matchAll(/useGraphRunStore\.getState\(\)\.applyEvent\(/g)].map(
      (match) => match.index ?? -1,
    );
    expect(applyEvents.length).toBeGreaterThanOrEqual(3);
    for (const start of applyEvents) {
      const tail = source.slice(start, start + 420);
      expect(tail).toContain("trustedOwner:");
      expect(tail).toContain("sessionId:");
      expect(tail).toContain("groupId:");
    }

    const backgroundStart = source.indexOf("const syncBackgroundRun = async () =>");
    const cleanupStart = source.indexOf("return () => {", backgroundStart);
    const cleanupEnd = source.indexOf("};", cleanupStart);
    const cleanup = source.slice(cleanupStart, cleanupEnd);
    expect(cleanup).toContain("invalidateReattachStreamForSession(sid);");
  });

  it("requires the exact stop generation/session/pane lease after an interrupt await", () => {
    const leaseA: StopRunLease = {
      generation: 1,
      paneId: "pane-1",
      sessionId: "session-a",
    };
    const leaseB: StopRunLease = {
      generation: 2,
      paneId: "pane-1",
      sessionId: "session-b",
    };
    expect(ownsStopRunLease(leaseA, leaseA, { id: "pane-1", sessionId: "session-a" })).toBe(true);
    expect(ownsStopRunLease(leaseA, leaseA, { id: "pane-1", sessionId: "session-b" })).toBe(false);
    expect(ownsStopRunLease(leaseB, leaseA, { id: "pane-1", sessionId: "session-b" })).toBe(false);
    expect(
      ownsStopRunLease(
        { ...leaseA },
        leaseA,
        { id: "pane-1", sessionId: "session-a" },
      ),
    ).toBe(false);
    expect(ownsStopRunLease(leaseB, leaseB, { id: "pane-1", sessionId: "session-b" })).toBe(true);
  });

  it("rejects a late stop result after a newer foreground run claims the session", () => {
    expect(isForegroundRunGenerationCurrent(undefined, 0)).toBe(true);
    expect(isForegroundRunGenerationCurrent(7, 7)).toBe(true);
    expect(isForegroundRunGenerationCurrent(8, 7)).toBe(false);
    expect(isForegroundRunGenerationCurrent(7, 0)).toBe(false);
  });

  it("does not consume B confirmation cards for a queued A message after navigation", () => {
    const paneB = { id: "pane-1", sessionId: "session-b" };
    expect(isPaneDisplayingSession(paneB, paneB.id, "session-a")).toBe(false);
    expect(isPaneDisplayingSession(paneB, paneB.id, "session-b")).toBe(true);

    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const sendStart = source.indexOf("const sendChat = async (");
    const confirmation = source.indexOf("matchActionConfirmationReply(text)", sendStart);
    const targetNormalization = source.indexOf(
      'const lockedSessionId = String(options?.lockedSessionId ?? "").trim();',
      sendStart,
    );
    const automaticGate = source.indexOf(
      "!isAutomaticSessionSend && text && !hasReadyAttachments",
      sendStart,
    );
    const queueRequeue = source.indexOf(
      "if (options?.queueDrain && lockedSessionId && !isLockedSessionDisplayed())",
      sendStart,
    );
    expect(targetNormalization).toBeGreaterThan(sendStart);
    expect(targetNormalization).toBeLessThan(confirmation);
    expect(automaticGate).toBeGreaterThan(targetNormalization);
    expect(automaticGate).toBeLessThan(confirmation);
    expect(queueRequeue).toBeGreaterThan(sendStart);
    expect(queueRequeue).toBeLessThan(confirmation);
    expect(source).toContain("sessionId: lockedSessionId");
  });

  it("aborts reattach when foreground ownership is claimed and restores Team state on interrupt failure", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const foregroundStart = source.indexOf("const abortController = new AbortController();");
    const foregroundOwner = source.indexOf("const foregroundStreamGeneration = claimSessionStreamOwner(", foregroundStart);
    const reattachAbort = source.indexOf(
      "invalidateReattachStreamForSession(requestSessionId);",
      foregroundOwner,
    );
    const forceStart = source.indexOf("shouldInterruptOnResend({");
    const forceInvalidate = source.indexOf(
      "invalidateReattachStreamForSession(requestSessionId);",
      forceStart,
    );
    const forceInterrupt = source.indexOf(
      "await window.agenticxDesktop.interruptSession?.(requestSessionId);",
      forceStart,
    );
    const stopStart = source.indexOf("const stopCurrentRun");
    const failureBranch = source.indexOf("中断失败", stopStart);
    const restoreState = source.indexOf("setGroupTeamControlStateForSession(sid, previousTeamControlState);", failureBranch);

    expect(foregroundOwner).toBeGreaterThan(foregroundStart);
    expect(reattachAbort).toBeGreaterThan(foregroundOwner);
    expect(forceInvalidate).toBeGreaterThan(forceStart);
    expect(forceInvalidate).toBeLessThan(forceInterrupt);
    expect(source).toContain("const previousTeamControlState = isGroupPane");
    expect(restoreState).toBeGreaterThan(failureBranch);
    expect(source).toContain("setRunGuardSessionId(previousRunGuardSessionId);");
    expect(source).toContain("const ownsForegroundFinalMerge = () =>");
    expect(source).toContain("isCurrentOwner: ownsForegroundFinalMerge");

    const helperStart = source.indexOf("const invalidateReattachStreamForSession = useCallback");
    const helperAbort = source.indexOf("previousReattachController.abort();", helperStart);
    const helperDelete = source.indexOf("delete sessionStreamOwnersRef.current[key];", helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperDelete).toBeGreaterThan(helperStart);
    expect(helperDelete).toBeLessThan(helperAbort);

    const stopInvalidate = source.indexOf(
      "invalidateReattachStreamForSession(sid);",
      stopStart,
    );
    const stopAbort = source.indexOf("targetAbortController.abort();", stopInvalidate);
    expect(stopInvalidate).toBeGreaterThan(stopStart);
    expect(stopInvalidate).toBeLessThan(stopAbort);

    const resumeStart = source.indexOf("const interruptForResume = useCallback");
    const resumeInvalidate = source.indexOf("invalidateReattachStreamForSession(sid);", resumeStart);
    const resumeAbort = source.indexOf("prevAbort.abort();", resumeStart);
    expect(resumeInvalidate).toBeGreaterThan(resumeStart);
    expect(resumeInvalidate).toBeLessThan(resumeAbort);
  });

  it("guards foreground final cleanup and post-await stop outcomes by displayed ownership", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/ChatPane.tsx"),
      "utf8",
    );
    const foregroundStart = source.indexOf("const abortController = new AbortController();");
    const finalizerStart = source.indexOf("} finally {", foregroundStart);
    const finalizerEnd = source.indexOf("sendChatRef.current = sendChat;", finalizerStart);
    const finalizer = source.slice(finalizerStart, finalizerEnd);
    const stopStart = source.indexOf("const stopCurrentRun");
    const stopEnd = source.indexOf("const interruptForResume", stopStart);
    const stopSource = source.slice(stopStart, stopEnd);

    expect(source).toContain("export function isPaneDisplayingSession(");
    expect(source).toContain("const isDisplayedForegroundSession = () =>");
    expect(source).toContain("if (!sessionStillActive) continue;");
    expect(source).toContain("if (targetSendSid && stopInFlightRef.current[targetSendSid])");
    expect(source).toContain("if (stopInFlightRef.current[requestSessionId])");
    expect(source).toContain("delete stopRunLeasesRef.current[requestSessionId];");
    expect(finalizer).toContain("ownsForegroundRequest() && isTargetSessionStillActive()");
    expect(finalizer).toContain("if (isTargetSessionStillActive()) {");
    expect(finalizer).toContain("if (isTargetSessionStillActive()) cancelStreamRenderFrame();");
    expect(stopSource).toContain("const stopLease: StopRunLease = {");
    expect(stopSource).toContain("const stopForegroundGeneration");
    expect(stopSource).toContain("isForegroundRunGenerationCurrent(");
    expect(stopSource).toContain("delete sessionAbortControllersRef.current[sid];");
    expect(stopSource).toContain("delete sessionStreamOwnersRef.current[sid];");
    expect(stopSource).toContain("stopTailMergePending = true;");
    expect(stopSource).toContain("isCurrentOwner: ownsCurrentStopLease");
    expect(stopSource).toContain("stopRunLeasesRef.current[sid] = stopLease;");
    expect(stopSource).toContain("if (!ownsCurrentStopLease()) return;");
    expect(stopSource).toContain("const ownsStopAtFinally = ownsCurrentStopLease();");
    expect(stopSource).toContain("stopRunLeasesRef.current[sid] === stopLease");
  });

  it("rekeys 404 migrations exactly and rejects a replaced old owner", () => {
    const oldController = new AbortController();
    const registry: Record<string, AbortController> = {
      "session-old": oldController,
    };

    expect(
      rekeyForegroundRequestController(
        registry,
        "session-old",
        "session-new",
        oldController,
      ),
    ).toBe(true);
    expect(registry["session-old"]).toBeUndefined();
    expect(registry["session-new"]).toBe(oldController);
    expect(
      ownsForegroundRequestController(registry, "session-new", oldController),
    ).toBe(true);

    const replacementController = new AbortController();
    registry["session-new"] = replacementController;
    expect(
      ownsForegroundRequestController(registry, "session-new", oldController),
    ).toBe(false);
    expect(
      rekeyForegroundRequestController(
        registry,
        "session-new",
        "session-after-replacement",
        oldController,
      ),
    ).toBe(false);
    expect(registry["session-new"]).toBe(replacementController);
    expect(registry["session-after-replacement"]).toBeUndefined();
  });

  it("invalidates an old reattach lease before a same-session foreground send", () => {
    const owners = {} as Record<string, import("./ChatPane").SessionStreamOwner>;
    const generations: Record<string, number> = {};
    const oldController = new AbortController();
    const newController = new AbortController();
    const oldGeneration = claimSessionStreamOwner(
      owners,
      generations,
      "session-1",
      "reattach",
      oldController,
    );
    expect(
      ownsSessionStreamOwner(owners, "session-1", "reattach", oldGeneration, oldController),
    ).toBe(true);

    const newGeneration = claimSessionStreamOwner(
      owners,
      generations,
      "session-1",
      "foreground",
      newController,
    );
    expect(newGeneration).toBeGreaterThan(oldGeneration);
    expect(
      ownsSessionStreamOwner(owners, "session-1", "reattach", oldGeneration, oldController),
    ).toBe(false);
    expect(
      ownsSessionStreamOwner(owners, "session-1", "foreground", newGeneration, newController),
    ).toBe(true);
  });

  it("rekeys the stream lease together with a 404 foreground session migration", () => {
    const owners = {} as Record<string, import("./ChatPane").SessionStreamOwner>;
    const generations: Record<string, number> = {};
    const controller = new AbortController();
    const generation = claimSessionStreamOwner(
      owners,
      generations,
      "session-old",
      "foreground",
      controller,
    );
    expect(
      rekeySessionStreamOwner(
        owners,
        "session-old",
        "session-new",
        "foreground",
        controller,
      ),
    ).toBe(true);
    expect(
      ownsSessionStreamOwner(owners, "session-old", "foreground", generation, controller),
    ).toBe(false);
    expect(
      ownsSessionStreamOwner(owners, "session-new", "foreground", generation, controller),
    ).toBe(true);
  });
});
