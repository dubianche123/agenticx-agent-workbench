import { describe, expect, it } from "vitest";

import { parseSkillFrontMatter } from "../skill-front-matter";

describe("parseSkillFrontMatter", () => {
  it("accepts quoted, commented, and block-scalar descriptions", () => {
    expect(parseSkillFrontMatter([
      "---",
      "name: public-research # loader identity",
      "description: |",
      "  Search public sources.",
      "  Return cited findings.",
      "---",
      "# Instructions",
    ].join("\n"))).toEqual({
      name: "public-research",
      description: "Search public sources.\nReturn cited findings.",
    });
  });

  it("rejects malformed, duplicate, or non-string identity fields", () => {
    expect(parseSkillFrontMatter("# no header")).toBeNull();
    expect(parseSkillFrontMatter("---\nname: one\nname: two\ndescription: ok\n---\n")).toBeNull();
    expect(parseSkillFrontMatter("---\nname: [one]\ndescription: ok\n---\n")).toBeNull();
    expect(parseSkillFrontMatter("---\nname: one\ndescription:\n---\n")).toBeNull();
  });
});
