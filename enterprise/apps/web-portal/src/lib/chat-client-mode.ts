/**
 * A local mock is deliberately a two-key opt-in. The historical mode flag is
 * still accepted for existing fixtures, but it cannot make a deployed
 * staging/test build silently bypass the Portal BFF and Gateway policy.
 */
export function shouldUseMockChatClient(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_CHAT_CLIENT_MODE === "mock" &&
    process.env.NEXT_PUBLIC_ENABLE_MOCK_CHAT === "true"
  );
}
