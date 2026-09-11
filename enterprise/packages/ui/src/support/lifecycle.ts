export type SupportRequestToken = {
  generation: number;
  scope: string;
  requestId: number;
};

export type SupportRequest = {
  token: SupportRequestToken;
  signal: AbortSignal;
};

/**
 * Client-side lifecycle fence for support requests.
 *
 * AbortController is only an optimization: browser mocks, service workers,
 * and already-resolved fetches can still deliver a response after abort. A
 * response must therefore match the account scope, principal generation, and
 * latest request id before it can update state or storage.
 */
export class SupportAssistantLifecycle {
  private mounted = true;
  private open = true;
  private generation = 0;
  private requestId = 0;
  private scope = "";
  private active: { requestId: number; controller: AbortController } | null = null;

  public get currentScope(): string {
    return this.scope;
  }

  public setMounted(mounted: boolean): void {
    if (this.mounted === mounted) return;
    this.mounted = mounted;
    if (!mounted) this.invalidate();
  }

  public setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    if (!open) this.invalidate();
  }

  /** Invalidate every response from the previous open/principal lifecycle. */
  public invalidate(): void {
    this.active?.controller.abort();
    this.active = null;
    this.generation += 1;
    this.requestId += 1;
    this.scope = "";
  }

  /** Start a bootstrap/rebootstrap epoch and invalidate prior requests. */
  public beginBootstrap(): SupportRequest {
    this.active?.controller.abort();
    this.active = null;
    this.generation += 1;
    return this.beginRequest();
  }

  /** Start a request within the current principal generation. */
  public beginRequest(): SupportRequest {
    this.active?.controller.abort();
    const controller = new AbortController();
    const requestId = ++this.requestId;
    this.active = { requestId, controller };
    return {
      token: { generation: this.generation, scope: this.scope, requestId },
      signal: controller.signal,
    };
  }

  /** Adopt the server-derived scope only if this bootstrap is still current. */
  public adoptScope(token: SupportRequestToken, scope: string): SupportRequestToken | null {
    if (!scope || !this.isCurrent(token)) return null;
    if (this.scope !== scope) this.generation += 1;
    this.scope = scope;
    return { generation: this.generation, scope, requestId: token.requestId };
  }

  public isCurrent(token: SupportRequestToken): boolean {
    return (
      this.mounted &&
      this.open &&
      token.generation === this.generation &&
      token.requestId === this.requestId &&
      token.scope === this.scope
    );
  }

  /**
   * Check whether a state update still belongs to the mounted principal
   * generation. State updates can be queued by React and committed after a
   * newer request starts, so they must not use the latest-request fence used
   * for response bodies. A new bootstrap, account change, close, or unmount
   * still invalidates the token through the generation/scope checks above.
   */
  public isStateCurrent(token: SupportRequestToken): boolean {
    return (
      this.mounted &&
      this.open &&
      Boolean(token.scope) &&
      token.generation === this.generation &&
      token.scope === this.scope
    );
  }

  public isScopeCurrent(scope: string): boolean {
    return this.mounted && this.open && Boolean(scope) && this.scope === scope;
  }

  public finish(token: SupportRequestToken): void {
    if (!this.isCurrent(token)) return;
    if (this.active?.requestId === token.requestId) this.active = null;
  }
}
