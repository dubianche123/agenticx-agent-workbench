import { describe, expect, it } from "vitest";

import {
  filterCapabilityShelfChoices,
  orderedCapabilityIdsFromPayload,
  reconcileCapabilityShelfOrder,
  reorderCapabilityShelfOrder,
} from "./capability-shelf-order";

describe("capability shelf order", () => {
  it("requires explicit shelf membership for market experts and groups", () => {
    const catalog = [
      { id: "feature:web_search" },
      { id: "skill:01JQMZ8K3N4P5Q6R7S8T9VWX01" },
      { id: "expert:01JQMZ8K3N4P5Q6R7S8T9VWX02" },
      { id: "group:01JQMZ8K3N4P5Q6R7S8T9VWX03" },
    ];

    expect(filterCapabilityShelfChoices(catalog, [])).toEqual(catalog.slice(0, 2));
    expect(filterCapabilityShelfChoices(catalog, [catalog[2]!.id])).toEqual([
      catalog[0],
      catalog[1],
      catalog[2],
    ]);
  });

  it("keeps server order, appends new catalog ids, and removes stale ids", () => {
    expect(
      reconcileCapabilityShelfOrder(
        ["feature:search", "mcp:one", "skill:new", "skill:duplicate"],
        ["skill:missing", "mcp:one", "mcp:one", "  feature:search  "],
      ),
    ).toEqual(["mcp:one", "feature:search", "skill:new", "skill:duplicate"]);
  });

  it("moves only visible ids while preserving hidden slots", () => {
    expect(
      reorderCapabilityShelfOrder(
        ["hidden:a", "visible:one", "hidden:b", "visible:two", "visible:three", "hidden:c"],
        ["visible:one", "visible:two", "visible:three"],
        "visible:three",
        "visible:one",
      ),
    ).toEqual(["hidden:a", "visible:three", "hidden:b", "visible:one", "visible:two", "hidden:c"]);
  });

  it("does not move unknown or no-op ids", () => {
    const order = ["one", "hidden", "two"];
    expect(reorderCapabilityShelfOrder(order, ["one", "two"], "one", "one")).toEqual(order);
    expect(reorderCapabilityShelfOrder(order, ["one", "two"], "missing", "two")).toEqual(order);
  });

  it("parses only the documented GET payload shape", () => {
    expect(
      orderedCapabilityIdsFromPayload({
        data: { orderedCapabilityIds: [" one ", 3, "", "two"] },
      }),
    ).toEqual(["one", "two"]);
    expect(orderedCapabilityIdsFromPayload({ data: {} })).toBeNull();
    expect(orderedCapabilityIdsFromPayload(null)).toBeNull();
  });
});
