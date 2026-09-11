/**
 * Serialize durable feedback mutations by scoped message key.
 *
 * The map is deliberately supplied by the caller so a ChatPane can retain
 * settled/in-flight chains while a session is temporarily hidden.  A key
 * includes the authenticated scope and session id; switching back to a
 * session therefore joins its existing chain, while an account/backend
 * transition gets a new key.
 */
export function enqueueFeedbackWrite(
  chains: Record<string, Promise<void>>,
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const prior = chains[key] ?? Promise.resolve();
  let current: Promise<void>;
  current = prior
    .catch(() => undefined)
    .then(run)
    .finally(() => {
      if (chains[key] === current) delete chains[key];
    });
  chains[key] = current;
  return current;
}

export function feedbackWriteKey(
  scopeEpoch: number,
  sessionId: string,
  messageId: string,
): string {
  return [String(scopeEpoch), String(sessionId), String(messageId)].join("\u0001");
}

export function feedbackWritePrefix(scopeEpoch: number, sessionId: string): string {
  return [String(scopeEpoch), String(sessionId)].join("\u0001") + "\u0001";
}
