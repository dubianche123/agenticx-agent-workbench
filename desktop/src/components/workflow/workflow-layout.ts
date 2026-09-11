/**
 * The editor keeps the canvas usable when the Workflow view is hosted inside
 * the default desktop viewport. Both fixed sidebars fit only when the host
 * can still provide a 320px canvas plus their 246px and 318px widths.
 */
export const WORKFLOW_LIST_WIDTH = 246;
export const WORKFLOW_INSPECTOR_WIDTH = 318;
export const WORKFLOW_CANVAS_MIN_WIDTH = 320;
export const WORKFLOW_DUAL_COLUMN_MIN_WIDTH =
  WORKFLOW_LIST_WIDTH + WORKFLOW_INSPECTOR_WIDTH + WORKFLOW_CANVAS_MIN_WIDTH + 16;

/**
 * Treat an unknown width as compact until the first ResizeObserver sample
 * arrives. This avoids a fixed-sidebar flash that would briefly crush the
 * canvas while the view is mounting.
 */
export function shouldUseWorkflowDrawers(containerWidth: number): boolean {
  return containerWidth <= 0 || containerWidth < WORKFLOW_DUAL_COLUMN_MIN_WIDTH;
}
