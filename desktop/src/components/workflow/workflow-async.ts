/**
 * Request generations used by the editor's asynchronous boundaries.
 *
 * Keeping this small state machine outside the component makes the important
 * races executable in tests without relying on source text or timing luck.
 */

export type WorkflowDocumentRequest = {
  workflowId: string;
  generation: number;
};

export type WorkflowCreateRequest = {
  generation: number;
  token: number;
  draftGeneration: number;
};

export type WorkflowSaveRequest = {
  workflowId: string;
  generation: number;
  token: number;
  draftGeneration: number;
  draftKey: string;
};

export type WorkflowRunRequest = {
  workflowId: string;
  sessionId: string;
  generation: number;
  sessionGeneration: number;
  contextToken: number;
  token: number;
};

/**
 * Gives asynchronous session bootstrap a mount-scoped lease. React StrictMode
 * may run an effect cleanup and setup pair without creating a new component
 * instance, so the lease uses a generation instead of a boolean mounted flag.
 */
export class WorkflowBootstrapGuard {
  private generation = 0;
  private mounted = false;

  mount(): number {
    this.generation += 1;
    this.mounted = true;
    return this.generation;
  }

  unmount(capturedGeneration: number): void {
    if (!this.mounted || this.generation !== capturedGeneration) return;
    this.mounted = false;
    this.generation += 1;
  }

  currentGeneration(): number {
    return this.mounted ? this.generation : 0;
  }

  isCurrent(capturedGeneration: number): boolean {
    return this.mounted && this.generation === capturedGeneration;
  }
}

export class WorkflowRequestCoordinator {
  private workflowId: string | null = null;
  private sessionId = "";
  private workflowGeneration = 0;
  private documentGeneration = 0;
  private sessionGeneration = 0;
  private runContextToken = 0;
  private draftGeneration = 0;
  private createToken = 0;
  private saveToken = 0;
  private runToken = 0;

  setSession(sessionId: string): boolean {
    if (this.sessionId === sessionId) return false;
    this.sessionId = sessionId;
    this.sessionGeneration += 1;
    this.runContextToken += 1;
    this.runToken += 1;
    return true;
  }

  /**
   * Adopt the session created by an explicit cold-pane run click. The store
   * update that follows will make the session effect call setSession(); by
   * recording the id first, that effect recognizes this as the same run
   * context instead of cancelling the request it is about to start.
   */
  adoptBootstrapSession(sessionId: string, contextToken: number): boolean {
    const normalized = String(sessionId || "").trim();
    if (!normalized || this.runContextToken !== contextToken) return false;
    if (this.sessionId === normalized) return true;
    this.sessionId = normalized;
    this.sessionGeneration += 1;
    return true;
  }

  selectWorkflow(workflowId: string): void {
    if (this.workflowId === workflowId) return;
    this.workflowId = workflowId;
    this.workflowGeneration += 1;
    this.documentGeneration += 1;
    this.runContextToken += 1;
    this.createToken += 1;
    this.saveToken += 1;
    this.runToken += 1;
  }

  beginDocument(workflowId: string): WorkflowDocumentRequest {
    this.selectWorkflow(workflowId);
    const generation = ++this.documentGeneration;
    return { workflowId, generation };
  }

  isDocumentCurrent(request: WorkflowDocumentRequest): boolean {
    return this.workflowId === request.workflowId
      && this.documentGeneration === request.generation;
  }

  markDraftEdited(): number {
    this.draftGeneration += 1;
    return this.draftGeneration;
  }

  beginCreate(): WorkflowCreateRequest {
    this.saveToken += 1;
    this.runContextToken += 1;
    this.runToken += 1;
    return {
      generation: ++this.documentGeneration,
      token: ++this.createToken,
      draftGeneration: this.draftGeneration,
    };
  }

  isCreateCurrent(request: WorkflowCreateRequest): boolean {
    return this.documentGeneration === request.generation && this.createToken === request.token;
  }

  shouldApplyCreate(request: WorkflowCreateRequest): boolean {
    return this.isCreateCurrent(request) && this.draftGeneration === request.draftGeneration;
  }

  beginSave(workflowId: string, draftKey: string): WorkflowSaveRequest {
    this.selectWorkflow(workflowId);
    return {
      workflowId,
      generation: this.documentGeneration,
      token: ++this.saveToken,
      draftGeneration: this.draftGeneration,
      draftKey,
    };
  }

  isSaveCurrent(request: WorkflowSaveRequest): boolean {
    return this.workflowId === request.workflowId
      && this.documentGeneration === request.generation
      && this.saveToken === request.token;
  }

  shouldApplySave(request: WorkflowSaveRequest): boolean {
    return this.isSaveCurrent(request) && this.draftGeneration === request.draftGeneration;
  }

  beginRun(workflowId: string, sessionId: string): WorkflowRunRequest {
    this.selectWorkflow(workflowId);
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId;
      this.sessionGeneration += 1;
      this.runContextToken += 1;
    }
    return {
      workflowId,
      sessionId,
      generation: this.workflowGeneration,
      sessionGeneration: this.sessionGeneration,
      contextToken: this.runContextToken,
      token: ++this.runToken,
    };
  }

  isRunCurrent(request: WorkflowRunRequest): boolean {
    return this.workflowId === request.workflowId
      && this.sessionId === request.sessionId
      && this.workflowGeneration === request.generation
      && this.sessionGeneration === request.sessionGeneration
      && this.runContextToken === request.contextToken
      && this.runToken === request.token;
  }

  currentRunContextToken(): number {
    return this.runContextToken;
  }

  beginRunContext(): number {
    this.runContextToken += 1;
    this.runToken += 1;
    return this.runContextToken;
  }

  isRunContextCurrent(token: number): boolean {
    return this.runContextToken === token;
  }

  invalidateSave(): void {
    this.saveToken += 1;
  }

  invalidateRun(): void {
    this.runToken += 1;
  }
}
