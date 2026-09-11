/**
 * Compatibility facade for the deep-research renderer.
 *
 * The implementation is shared with Desktop through the neutral core-api
 * package; keeping this import path avoids changing existing Portal callers
 * and preserves one chart implementation for both products.
 */
export {
  chartSpecToGfmTable,
  chartSpecToSvg,
  chartSpecToXyChart,
  parseChartSpec,
} from "@agenticx/core-api";
export type { ChartSpec } from "@agenticx/core-api";
