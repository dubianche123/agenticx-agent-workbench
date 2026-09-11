import type { ConfigShareManifest, ConfigSharePermissionMode } from "./config-share-types";

export function v2ExpertManifest(
  name = "投研专家",
  options: {
    artifactId?: string;
    version?: string;
    description?: string;
    systemPrompt?: string;
    defaultPermissionMode?: ConfigSharePermissionMode;
  } = {},
): ConfigShareManifest {
  const description = options.description ?? "分析公告";
  return {
    schema_version: 2,
    artifact_id: options.artifactId ?? "expert:test-fixture-001",
    release_version: options.version ?? "1.0.0",
    kind: "expert",
    title: name,
    description,
    recommended_permission_mode: "ask",
    dependencies: { skills: [], mcps: [] },
    resources: [],
    workspace_slots: [],
    payload: {
      name,
      role: "",
      description,
      tags: [],
      system_prompt: options.systemPrompt ?? "",
      color: "blue",
      default_permission_mode: options.defaultPermissionMode ?? "ask",
    },
  };
}
