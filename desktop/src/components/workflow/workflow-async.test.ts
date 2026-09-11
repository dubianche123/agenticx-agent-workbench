import { describe, expect, it } from "vitest";
import { WorkflowBootstrapGuard, WorkflowRequestCoordinator } from "./workflow-async";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("workflow asynchronous request guards", () => {
  it("drops a late bootstrap after unmount, then allows a fresh retry", async () => {
    const guard = new WorkflowBootstrapGuard();
    const firstGeneration = guard.mount();
    const delayedSession = deferred<string>();
    let adoptedSession = "";
    const lateResult = delayedSession.promise.then((sessionId) => {
      if (guard.isCurrent(firstGeneration)) adoptedSession = sessionId;
    });

    guard.unmount(firstGeneration);
    delayedSession.resolve("session-late");
    await lateResult;
    expect(adoptedSession).toBe("");

    const retryGeneration = guard.mount();
    const retrySession = deferred<string>();
    const retryResult = retrySession.promise.then((sessionId) => {
      if (guard.isCurrent(retryGeneration)) adoptedSession = sessionId;
    });
    retrySession.resolve("session-retry");
    await retryResult;

    expect(adoptedSession).toBe("session-retry");
  });

  it("keeps a StrictMode remount alive when an old cleanup runs late", () => {
    const guard = new WorkflowBootstrapGuard();
    const firstGeneration = guard.mount();
    guard.unmount(firstGeneration);
    const remountedGeneration = guard.mount();

    // A stale cleanup must not invalidate the remounted effect.
    guard.unmount(firstGeneration);

    expect(guard.isCurrent(remountedGeneration)).toBe(true);
  });

  it("drops a delayed A document after selecting B", async () => {
    const coordinator = new WorkflowRequestCoordinator();
    coordinator.selectWorkflow("workflow-a");
    const aRequest = coordinator.beginDocument("workflow-a");
    const aResponse = deferred<string>();
    let visibleDocument = "";
    const applyA = aResponse.promise.then((value) => {
      if (coordinator.isDocumentCurrent(aRequest)) visibleDocument = value;
    });

    coordinator.selectWorkflow("workflow-b");
    const bRequest = coordinator.beginDocument("workflow-b");
    const bResponse = deferred<string>();
    const applyB = bResponse.promise.then((value) => {
      if (coordinator.isDocumentCurrent(bRequest)) visibleDocument = value;
    });
    bResponse.resolve("B");
    await applyB;
    aResponse.resolve("A");
    await applyA;

    expect(visibleDocument).toBe("B");
  });

  it("does not attach a delayed A run after the workflow or session changes", async () => {
    const coordinator = new WorkflowRequestCoordinator();
    coordinator.setSession("session-a");
    const aRequest = coordinator.beginRun("workflow-a", "session-a");
    const aResponse = deferred<string>();
    let visibleRun = "";
    const applyA = aResponse.promise.then((value) => {
      if (coordinator.isRunCurrent(aRequest)) visibleRun = value;
    });

    coordinator.selectWorkflow("workflow-b");
    coordinator.setSession("session-b");
    const bRequest = coordinator.beginRun("workflow-b", "session-b");
    const bResponse = deferred<string>();
    const applyB = bResponse.promise.then((value) => {
      if (coordinator.isRunCurrent(bRequest)) visibleRun = value;
    });
    bResponse.resolve("B run");
    await applyB;
    aResponse.resolve("A run");
    await applyA;

    expect(visibleRun).toBe("B run");
  });

  it("adopts a session created by the current run without invalidating its context", () => {
    const coordinator = new WorkflowRequestCoordinator();
    coordinator.selectWorkflow("workflow-a");
    const contextToken = coordinator.beginRunContext();

    expect(coordinator.adoptBootstrapSession("session-created", contextToken)).toBe(true);
    expect(coordinator.currentRunContextToken()).toBe(contextToken);
    expect(coordinator.setSession("session-created")).toBe(false);

    const runRequest = coordinator.beginRun("workflow-a", "session-created");
    expect(runRequest.contextToken).toBe(contextToken);
    expect(coordinator.isRunCurrent(runRequest)).toBe(true);
  });

  it("rejects a bootstrap session after another context has taken over", () => {
    const coordinator = new WorkflowRequestCoordinator();
    const contextToken = coordinator.beginRunContext();
    coordinator.beginRunContext();

    expect(coordinator.adoptBootstrapSession("late-session", contextToken)).toBe(false);
    expect(coordinator.setSession("late-session")).toBe(true);
  });

  it("keeps a run 1 panel closed and run 2 pending after a delayed approval callback", async () => {
    const coordinator = new WorkflowRequestCoordinator();
    coordinator.selectWorkflow("workflow-a");
    coordinator.setSession("session-a");
    const run1Request = coordinator.beginRun("workflow-a", "session-a");
    const run1ContextToken = run1Request.contextToken;
    let activeRunId = "run-1";
    let showRunPanel = true;
    let run2Pending = false;
    let refreshCount = 0;
    let abortRun2Count = 0;
    const approvalResponse = deferred<"run-1 approval completed">();
    const delayedApprovalRefresh = approvalResponse.promise.then(() => {
      // This models the old panel's onRefresh callback. It must return before
      // starting a refresh or touching run 2's controller.
      if (
        coordinator.isRunContextCurrent(run1ContextToken)
        && coordinator.isRunCurrent(run1Request)
        && activeRunId === "run-1"
      ) {
        refreshCount += 1;
        abortRun2Count += 1;
      }
    });

    const run2ContextToken = coordinator.beginRunContext();
    // This is the synchronous state reset performed when run 2 starts.
    showRunPanel = false;
    activeRunId = "";
    const run2Request = coordinator.beginRun("workflow-a", "session-a");
    run2Pending = true;
    approvalResponse.resolve("run-1 approval completed");
    await delayedApprovalRefresh;

    expect(showRunPanel).toBe(false);
    expect(run2Pending).toBe(true);
    expect(refreshCount).toBe(0);
    expect(abortRun2Count).toBe(0);
    expect(activeRunId).toBe("");
    expect(run2ContextToken).not.toBe(run1ContextToken);
    expect(coordinator.isRunCurrent(run1Request)).toBe(false);
    expect(coordinator.isRunCurrent(run2Request)).toBe(true);
  });

  it("keeps a local edit when the captured save resolves later", async () => {
    const coordinator = new WorkflowRequestCoordinator();
    coordinator.selectWorkflow("workflow-a");
    coordinator.beginDocument("workflow-a");
    const saveRequest = coordinator.beginSave("workflow-a", "draft-v1");
    const serverResponse = deferred<string>();
    let visibleDraft = "draft-v1";
    const saveTask = serverResponse.promise.then((value) => {
      if (!coordinator.isSaveCurrent(saveRequest)) return;
      if (coordinator.shouldApplySave(saveRequest)) visibleDraft = value;
    });

    visibleDraft = "draft-v2";
    coordinator.markDraftEdited();
    serverResponse.resolve("server-v2");
    await saveTask;

    expect(visibleDraft).toBe("draft-v2");
    expect(coordinator.isSaveCurrent(saveRequest)).toBe(true);
    expect(coordinator.shouldApplySave(saveRequest)).toBe(false);
  });

  it("invalidates a first save when a second workflow becomes active", () => {
    const coordinator = new WorkflowRequestCoordinator();
    coordinator.selectWorkflow("workflow-a");
    coordinator.beginDocument("workflow-a");
    const first = coordinator.beginSave("workflow-a", "draft-a");
    coordinator.selectWorkflow("workflow-b");
    coordinator.beginDocument("workflow-b");
    const second = coordinator.beginSave("workflow-b", "draft-b");
    expect(coordinator.isSaveCurrent(first)).toBe(false);
    expect(coordinator.isSaveCurrent(second)).toBe(true);
  });

  it("invalidates an in-flight create and its old runtime when a new workflow is selected", async () => {
    const coordinator = new WorkflowRequestCoordinator();
    coordinator.selectWorkflow("workflow-a");
    coordinator.beginDocument("workflow-a");
    const runRequest = coordinator.beginRun("workflow-a", "session-a");
    const createRequest = coordinator.beginCreate();
    let visibleDocument = "workflow-a draft";
    const createResponse = deferred<string>();
    const createTask = createResponse.promise.then((value) => {
      if (coordinator.shouldApplyCreate(createRequest)) visibleDocument = value;
    });

    // The editor clears its visible document synchronously when create starts.
    visibleDocument = "";
    coordinator.markDraftEdited();
    coordinator.selectWorkflow("workflow-b");
    createResponse.resolve("new workflow");
    await createTask;

    expect(visibleDocument).toBe("");
    expect(coordinator.shouldApplyCreate(createRequest)).toBe(false);
    expect(coordinator.isRunCurrent(runRequest)).toBe(false);
  });
});
