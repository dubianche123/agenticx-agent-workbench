import { describe, expect, it } from "vitest";
import { SupportAssistantLifecycle, type SupportRequestToken } from "./lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function commitIfCurrent(
  lifecycle: SupportAssistantLifecycle,
  token: SupportRequestToken,
  reply: Promise<string>,
  writes: string[],
): Promise<void> {
  const value = await reply;
  if (lifecycle.isCurrent(token)) writes.push(value);
}

describe("support assistant lifecycle fencing", () => {
  it("drops a deferred A reply after bootstrap switches to account B", async () => {
    const lifecycle = new SupportAssistantLifecycle();
    const bootstrapA = lifecycle.beginBootstrap();
    const principalA = lifecycle.adoptScope(bootstrapA.token, "scope-a");
    expect(principalA).not.toBeNull();
    lifecycle.finish(principalA!);

    const replyA = deferred<string>();
    const requestA = lifecycle.beginRequest();
    const writes: string[] = [];
    const pendingA = commitIfCurrent(lifecycle, requestA.token, replyA.promise, writes);

    const bootstrapB = lifecycle.beginBootstrap();
    const replyB = deferred<string>();
    const pendingB = (async () => {
      const value = await replyB.promise;
      const principalB = lifecycle.adoptScope(bootstrapB.token, "scope-b");
      if (principalB && lifecycle.isCurrent(principalB)) writes.push(value);
    })();

    replyA.resolve("账号 A 的晚响应");
    await pendingA;
    expect(writes).toEqual([]);

    replyB.resolve("账号 B 的当前响应");
    await pendingB;
    expect(writes).toEqual(["账号 B 的当前响应"]);
  });

  it("drops a deferred execute reply after close and reopen", async () => {
    const lifecycle = new SupportAssistantLifecycle();
    const bootstrap = lifecycle.beginBootstrap();
    const principal = lifecycle.adoptScope(bootstrap.token, "scope-a");
    expect(principal).not.toBeNull();
    lifecycle.finish(principal!);

    const reply = deferred<string>();
    const execute = lifecycle.beginRequest();
    const writes: string[] = [];
    const pending = commitIfCurrent(lifecycle, execute.token, reply.promise, writes);

    lifecycle.setOpen(false);
    lifecycle.setOpen(true);
    const reopened = lifecycle.beginBootstrap();
    const reopenedPrincipal = lifecycle.adoptScope(reopened.token, "scope-b");
    expect(reopenedPrincipal).not.toBeNull();

    reply.resolve("账号 A 的执行结果");
    await pending;
    expect(writes).toEqual([]);
    expect(lifecycle.isCurrent(execute.token)).toBe(false);
    expect(lifecycle.isCurrent(reopenedPrincipal!)).toBe(true);
  });

  it("drops a deferred reply after the panel is unmounted", async () => {
    const lifecycle = new SupportAssistantLifecycle();
    const bootstrap = lifecycle.beginBootstrap();
    const principal = lifecycle.adoptScope(bootstrap.token, "scope-a");
    expect(principal).not.toBeNull();

    const reply = deferred<string>();
    const request = lifecycle.beginRequest();
    const writes: string[] = [];
    const pending = commitIfCurrent(lifecycle, request.token, reply.promise, writes);

    lifecycle.setMounted(false);
    reply.resolve("卸载后的晚响应");
    await pending;

    expect(writes).toEqual([]);
    expect(lifecycle.isCurrent(request.token)).toBe(false);
  });
});
