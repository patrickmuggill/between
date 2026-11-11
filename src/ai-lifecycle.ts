export type AIPhase = "idle" | "detecting" | "generating";
export type AIRequest = Readonly<{
  phase: Exclude<AIPhase, "idle">;
  controller: AbortController;
}>;

/** One owner for AI work. Cancellation revokes ownership before aborting I/O.
 * Late responses and finally blocks must check owns(), not just the snapshot:
 * a newer request can target exactly the same draft and revision.
 */
export class AILifecycle {
  private request: AIRequest | null = null;

  get phase(): AIPhase { return this.request?.phase ?? "idle"; }

  begin(phase: AIRequest["phase"]): AIRequest | null {
    // Repeated run actions cannot replace a generation already in progress.
    if (this.phase === "generating") return null;
    this.cancel();
    const request = { phase, controller: new AbortController() };
    this.request = request;
    return request;
  }

  owns(request: AIRequest): boolean {
    return this.request === request && !request.controller.signal.aborted;
  }

  finish(request: AIRequest): boolean {
    if (!this.owns(request)) return false;
    this.request = null;
    return true;
  }

  cancel(phase?: AIRequest["phase"]): boolean {
    if (!this.request || (phase && this.request.phase !== phase)) return false;
    const request = this.request;
    this.request = null;
    request.controller.abort();
    return true;
  }
}
