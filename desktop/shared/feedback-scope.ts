// Browser-safe facade for the feedback account handshake helpers. Keeping the
// implementation beside Electron lets the main tsc build continue emitting
// its entrypoint at dist-electron/main.js while Vite can import this module.
export * from "../electron/feedback-scope";
