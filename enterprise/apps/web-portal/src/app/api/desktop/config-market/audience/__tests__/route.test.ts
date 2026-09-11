import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveDesktopIdentity = vi.fn();
const listConfigMarketAudienceDirectory = vi.fn();

vi.mock("../../../../../../lib/desktop-auth", () => ({
  resolveDesktopIdentity: (...args: unknown[]) => resolveDesktopIdentity(...args),
}));
vi.mock("../../../../../../lib/config-market/audience", () => ({
  listConfigMarketAudienceDirectory: (...args: unknown[]) =>
    listConfigMarketAudienceDirectory(...args),
}));

describe("GET /api/desktop/config-market/audience", () => {
  beforeEach(() => {
    resolveDesktopIdentity.mockReset().mockResolvedValue({
      userId: "user-a",
      tenantId: "tenant-a",
      deptId: "dept-a",
      scopes: ["desktop:managed"],
    });
    listConfigMarketAudienceDirectory.mockReset().mockResolvedValue({
      departments: [{ id: "dept-a", name: "研发", path: "/研发" }],
      users: [
        {
          id: "user-a",
          displayName: "Alice",
          email: "alice@example.invalid",
          deptId: "dept-a",
        },
      ],
    });
  });

  it("returns only the minimal live tenant directory with bounded search", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://portal.example.invalid/api/desktop/config-market/audience?q=ali&limit=25&offset=50",
      ),
    );
    expect(response.status).toBe(200);
    expect(listConfigMarketAudienceDirectory).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      q: "ali",
      limit: 25,
      offset: 50,
    });
    const json = await response.json();
    expect(json.data).toEqual({
      departments: [{ id: "dept-a", name: "研发", path: "/研发" }],
      users: [
        {
          id: "user-a",
          displayName: "Alice",
          email: "alice@example.invalid",
          deptId: "dept-a",
        },
      ],
    });
    expect(JSON.stringify(json)).not.toContain("phone");
    expect(JSON.stringify(json)).not.toContain("scopes");
  });

  it("requires a live managed PAT and rejects unbounded parameters", async () => {
    const { GET } = await import("../route");
    resolveDesktopIdentity.mockResolvedValueOnce(null);
    expect(
      (await GET(new Request("https://portal.example.invalid/api/desktop/config-market/audience")))
        .status,
    ).toBe(401);

    resolveDesktopIdentity.mockResolvedValueOnce({ tenantId: "tenant-a", scopes: [] });
    expect(
      (await GET(new Request("https://portal.example.invalid/api/desktop/config-market/audience")))
        .status,
    ).toBe(403);

    expect(
      (
        await GET(
          new Request(
            "https://portal.example.invalid/api/desktop/config-market/audience?limit=101",
          ),
        )
      ).status,
    ).toBe(400);
    expect(listConfigMarketAudienceDirectory).not.toHaveBeenCalled();
  });
});
