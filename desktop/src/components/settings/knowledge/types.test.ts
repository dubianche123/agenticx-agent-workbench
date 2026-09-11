import { describe, expect, it } from "vitest";
import { defaultKBConfig, normalizeKbConfig } from "./types";

describe("knowledge brain default config", () => {
  it("does not guess a home directory before the server returns a path", () => {
    const config = defaultKBConfig();
    expect(config.vector_store.path).toBe("");
    expect(config.vector_store.path).not.toContain(".agenticx-ontology");
  });

  it("uses the server-resolved custom brain path for a reset draft", () => {
    const config = defaultKBConfig("/tmp/custom-ontology/brains/default_docs/chroma");
    expect(config.vector_store.path).toBe("/tmp/custom-ontology/brains/default_docs/chroma");
    expect(config.vector_store.path).not.toContain("~/.agenticx-ontology");
  });

  it("keeps a server path when filling optional defaults", () => {
    const path = "C:\\Users\\user\\AppData\\Local\\Ontology\\brains\\default_docs\\chroma";
    const config = defaultKBConfig(path);
    config.retrieval = { ...config.retrieval };
    expect(normalizeKbConfig(config).vector_store.path).toBe(path);
  });
});
