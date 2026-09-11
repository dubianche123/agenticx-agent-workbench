import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./CapabilityMarketPanel.tsx", import.meta.url),
  "utf8",
);

describe("CapabilityMarketPanel section order", () => {
  it("keeps the enterprise expert and group shelf below the MCP, Skill, and feature catalog", () => {
    const catalogItems = source.indexOf("visible.map((choice)");
    const enterpriseShelf = source.indexOf("<EnterpriseConfigMarketPanel");
    const dialogs = source.indexOf("<MarketImportDialog");

    expect(catalogItems).toBeGreaterThan(-1);
    expect(enterpriseShelf).toBeGreaterThan(catalogItems);
    expect(dialogs).toBeGreaterThan(enterpriseShelf);
  });

  it("uses a dedicated accessible drag handle and the shelf order API", () => {
    expect(source).toContain("DndContext");
    expect(source).toContain("KeyboardSensor");
    expect(source).toContain("sortableKeyboardCoordinates");
    expect(source).toContain("rectSortingStrategy");
    expect(source).toContain('"/api/admin/capability-shelf-order"');
    expect(source).toContain('method: "PUT"');
    expect(source).toContain('JSON.stringify({ capabilityIds: nextOrder })');
    expect(source).toContain("reconcileCapabilityShelfOrder");
    expect(source).toContain("visible.map((choice) => choice.id)");
    expect(source).toContain("setShelfOrder(previousOrder)");
    expect(source).toContain("shelfOrderSavingRef.current");
    expect(source).toContain("if (controller.signal.aborted) return");
    expect(source).toContain('aria-roledescription={copy("可排序", "sortable")}');
    expect(source).toContain('aria-label={`${copy("拖动排序", "Drag to reorder")}: ${choice.displayName}`}');
    expect(source).toContain("暂时无法继续拖动");
  });

  it("keeps market review, shelf membership, and capability-pack selection as separate actions", () => {
    expect(source).toContain("filterCapabilityShelfChoices(choices, shelfOrder)");
    expect(source).toContain('method: "POST"');
    expect(source).toContain("body: JSON.stringify({ capabilityId })");
    expect(source).toContain("onAddToShelf={(detail) => void addConfigToShelf(detail)}");
    expect(source).toContain('void openPortableDetail(choice, "inspect")');
    expect(source).toContain('await openPortableDetail(choice, "select")');
    expect(source).toContain("普通查看不会触发下发");
    expect(source).toContain("选择下发");
    expect(source).not.toContain("onPrepareForPack");
  });

  it("fails closed when either the catalog or persisted shelf membership is incomplete", () => {
    expect(source).toContain("ready: catalogReady");
    expect(source).toContain("shelfOrderError === null");
    expect(source).toContain("if (!shelfReady || shelfOrderSavingRef.current)");
    expect(source).toContain("sortingDisabled={!shelfReady || shelfOrderSaving}");
    expect(source).toContain("为避免覆盖已有专家或群聊");
    expect(source).not.toContain("setShelfOrder([])");
  });

  it("keeps shelf cards equal-height and exposes full descriptions and pack summaries", () => {
    expect(source).toContain('className="min-w-0 h-full"');
    expect(source).toContain('className={`flex h-full flex-col transition-colors ${');
    expect(source).toContain('className="grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3"');
    expect(source).toContain("className=\"block h-[3.75rem]");
    expect(source).toContain("line-clamp-3");
    expect(source).toContain("PopoverTrigger asChild");
    expect(source).toContain("PopoverContent");
    expect(source).toContain('aria-label={`${copy("查看完整信息", "View full information")}: ${choice.displayName}`}');
    expect(source).toContain('aria-label={`${copy("完整信息", "Full information")}: ${choice.displayName}`}');
    expect(source).toContain("查看完整说明与能力包归属");
    expect(source).toContain("max-h-[min(70vh,32rem)]");
    expect(source).toContain("const primaryHolder = holders[0]");
    expect(source).toContain("const hiddenHolderNames = holderNames.slice(1)");
    expect(source).not.toContain("visibleHolders");
    expect(source).toContain('aria-label={holdersLabel}');
    expect(source).toContain("+{hiddenHolderNames.length}");
    expect(source).toContain("完整说明");
    expect(source).toContain("能力包归属");
    expect(source).toContain('holderNames.join(", ")');
    expect(source).toContain("whitespace-pre-wrap break-words text-sm leading-6");
  });
});
