// Renderer code imports this browser-safe facade. Keeping the canonical
// implementation beside the Electron entrypoint prevents a source import
// above `electron/` from changing TypeScript's inferred rootDir and emitting
// the real main process under `dist-electron/electron/main.js`.
export * from "../electron/enterprise-capability-market";
