// Renderer code imports this stable facade.  The implementation lives beside
// the Electron entrypoint so `tsc -p electron/tsconfig.json` keeps emitting
// `dist-electron/main.js`; importing a source file above `electron/` changes
// TypeScript's inferred rootDir and silently strands a newer main process at
// `dist-electron/electron/main.js` while Electron starts the stale root file.
export * from "../electron/enterprise-capability-sync-state";
