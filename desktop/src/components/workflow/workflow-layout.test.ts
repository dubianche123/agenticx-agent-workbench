import { describe, expect, it } from "vitest";
import {
  WORKFLOW_CANVAS_MIN_WIDTH,
  WORKFLOW_DUAL_COLUMN_MIN_WIDTH,
  WORKFLOW_INSPECTOR_WIDTH,
  WORKFLOW_LIST_WIDTH,
  shouldUseWorkflowDrawers,
} from "./workflow-layout";

describe("workflow studio layout", () => {
  it("collapses the sidebars when the canvas would be narrower than 320px", () => {
    expect(WORKFLOW_DUAL_COLUMN_MIN_WIDTH).toBe(
      WORKFLOW_LIST_WIDTH + WORKFLOW_INSPECTOR_WIDTH + WORKFLOW_CANVAS_MIN_WIDTH + 16,
    );
    expect(shouldUseWorkflowDrawers(638)).toBe(true);
    expect(shouldUseWorkflowDrawers(WORKFLOW_DUAL_COLUMN_MIN_WIDTH - 1)).toBe(true);
  });

  it("keeps both sidebars on a wide enough container", () => {
    expect(shouldUseWorkflowDrawers(WORKFLOW_DUAL_COLUMN_MIN_WIDTH)).toBe(false);
    expect(shouldUseWorkflowDrawers(1200)).toBe(false);
  });

  it("starts compact before the observer has measured the host", () => {
    expect(shouldUseWorkflowDrawers(0)).toBe(true);
  });
});
