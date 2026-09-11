import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAdminScope = vi.fn();
const listConfigMarketItemsPage = vi.fn();

vi.mock("../../../../../lib/admin-auth", () => ({
  requireAdminScope: (...args: unknown[]) => requireAdminScope(...args),
}));
vi.mock("../../../../../lib/config-market-store", () => ({
  MAX_ADMIN_CONFIG_MARKET_PAGE_SIZE: 100,
  listConfigMarketItemsPage: (...args: unknown[]) => listConfigMarketItemsPage(...args),
}));

describe("GET /api/admin/config-market", () => {
  beforeEach(() => {
    requireAdminScope.mockReset().mockResolvedValue({
      ok: true,
      session: { tenantId: "tenant-admin", userId: "admin-a" },
    });
    listConfigMarketItemsPage.mockReset().mockResolvedValue({ items: [], nextCursor: "next" });
  });

  it("uses the authenticated admin tenant rather than environment tenant", async () => {
    const { GET } = await import("../route");
    const response = await GET(new Request("https://admin.example.invalid/api/admin/config-market?limit=20"));
    expect(response.status).toBe(200);
    expect(requireAdminScope).toHaveBeenCalledWith(["provider:read"]);
    expect(listConfigMarketItemsPage).toHaveBeenCalledWith("tenant-admin", {
      limit: 20,
      cursor: null,
    });
    await expect(response.json()).resolves.toMatchObject({ data: { next_cursor: "next" } });
  });
});
