/** Keep enterprise-managed credentials out of Electron's renderer process. */
export function redactManagedProviderSecrets<
  T extends { managed?: boolean; api_key?: string },
>(providers: Record<string, T>): Record<string, T> {
  const safe: Record<string, T> = {};
  for (const [name, provider] of Object.entries(providers)) {
    if (name === "enterprise" || provider.managed === true) {
      const copy = { ...provider };
      delete copy.api_key;
      safe[name] = copy as T;
    } else {
      safe[name] = provider;
    }
  }
  return safe;
}
