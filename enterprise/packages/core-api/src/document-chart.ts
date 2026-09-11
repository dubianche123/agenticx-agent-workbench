/**
 * Dependency-free chart primitives shared by document renderers.
 *
 * Keep this module deterministic and browser/Node neutral. It accepts only a
 * bounded, validated chart object and emits either Mermaid xychart text,
 * escaped inline SVG, or a Markdown table fallback.
 */

export type ChartSpec = {
  type: "bar" | "line" | "pie" | "scatter";
  title: string;
  x: string[];
  series: Array<{ name: string; data: number[] }>;
};

const CHART_TYPES = new Set<ChartSpec["type"]>(["bar", "line", "pie", "scatter"]);
const MAX_X = 24;
const MAX_SERIES = 4;
const MAX_LABEL_CHARS = 80;
const MAX_TITLE_CHARS = 120;

function escapeText(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeLabel(raw: unknown, maxChars = MAX_LABEL_CHARS): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = String(raw)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\|/g, "／")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
  return value || null;
}

/** Parse and strictly validate a model-generated chart payload. */
export function parseChartSpec(raw: string): ChartSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const typeRaw = typeof row.type === "string" ? row.type.trim().toLowerCase() : "";
  if (!CHART_TYPES.has(typeRaw as ChartSpec["type"])) return null;
  const type = typeRaw as ChartSpec["type"];
  if (!Array.isArray(row.x) || row.x.length === 0 || row.x.length > MAX_X) return null;
  const x = row.x.map((value) => normalizeLabel(value));
  if (x.some((value) => value === null)) return null;

  const seriesRaw = Array.isArray(row.series) ? row.series : [];
  const series: Array<{ name: string; data: number[] }> = [];
  for (const item of seriesRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (!Array.isArray(candidate.data) || candidate.data.length !== x.length) continue;
    if (candidate.data.some((value) => typeof value !== "number" || !Number.isFinite(value))) continue;
    const name = normalizeLabel(candidate.name) ?? `系列${series.length + 1}`;
    series.push({ name, data: candidate.data as number[] });
    if (series.length >= MAX_SERIES) break;
  }
  if (series.length === 0) return null;
  if ((type === "pie" || type === "scatter") && series.length !== 1) return null;
  const title = normalizeLabel(row.title, MAX_TITLE_CHARS) ?? "";
  return { type, title, x: x as string[], series };
}

function mermaidLabel(value: string): string {
  return value.replace(/\\/g, "／").replace(/"/g, "'");
}

/** Bar and line specs reuse Mermaid's xychart renderer when available. */
export function chartSpecToXyChart(spec: ChartSpec): string | null {
  if (spec.type !== "bar" && spec.type !== "line") return null;
  const allValues = spec.series.flatMap((item) => item.data);
  const maxValue = allValues.reduce((acc, value) => Math.max(acc, value), 0);
  const minValue = allValues.reduce((acc, value) => Math.min(acc, value), 0);
  const yMax = Math.max(1, Math.ceil(maxValue * 1.1));
  const yMin = Math.min(0, Math.floor(minValue * 1.1));
  const lines = ["xychart-beta"];
  if (spec.title) lines.push(`    title "${mermaidLabel(spec.title)}"`);
  lines.push(`    x-axis [${spec.x.map((label) => `"${mermaidLabel(label)}"`).join(", ")}]`);
  lines.push(`    y-axis ${yMin} --> ${yMax}`);
  for (const item of spec.series) lines.push(`    ${spec.type} [${item.data.join(", ")}]`);
  return lines.join("\n");
}

const SVG_PALETTE = ["#6366f1", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6"];

function formatAxisValue(value: number): string {
  if (Object.is(value, -0) || Number.isInteger(value)) return String(Math.round(value));
  return value.toFixed(Math.abs(value) >= 10 ? 1 : 2);
}

function chartLegend(spec: ChartSpec): string {
  return spec.series
    .map((item, index) => {
      const color = SVG_PALETTE[index % SVG_PALETTE.length]!;
      return `<div class="chart-legend-item"><span class="chart-dot" style="background:${color}"></span>${escapeText(item.name)}</div>`;
    })
    .join("");
}

/** All validated chart types render as dependency-free inline SVG. */
export function chartSpecToSvg(spec: ChartSpec): string | null {
  if (spec.type === "bar" || spec.type === "line") {
    const allValues = spec.series.flatMap((item) => item.data);
    const maxValue = Math.max(0, ...allValues);
    const minValue = Math.min(0, ...allValues);
    const range = Math.max(1, maxValue - minValue);
    const width = Math.max(360, Math.min(960, 180 + spec.x.length * 32));
    const height = 280;
    const padding = { top: 34, right: 20, bottom: 58, left: 52 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const yFor = (value: number) =>
      padding.top + ((maxValue - value) / range) * plotHeight;
    const xFor = (index: number) =>
      padding.left + ((index + 0.5) / spec.x.length) * plotWidth;
    const ticks = Array.from({ length: 5 }, (_, index) =>
      maxValue - ((maxValue - minValue) * index) / 4,
    );
    const grid = ticks
      .map((value) => {
        const y = yFor(value).toFixed(1);
        return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#e2e8f0"/><text x="${padding.left - 8}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="11">${escapeText(formatAxisValue(value))}</text>`;
      })
      .join("");
    const labels = spec.x
      .map((label, index) => {
        const x = xFor(index).toFixed(1);
        const visible = label.length > 16 ? `${label.slice(0, 15)}…` : label;
        return `<text x="${x}" y="${height - padding.bottom + 22}" text-anchor="middle" fill="#64748b" font-size="11"><title>${escapeText(label)}</title>${escapeText(visible)}</text>`;
      })
      .join("");
    const baseline = yFor(0).toFixed(1);
    let marks = "";
    if (spec.type === "bar") {
      const groupWidth = plotWidth / spec.x.length;
      const barWidth = Math.max(
        4,
        Math.min(28, (groupWidth * 0.72) / spec.series.length),
      );
      const groupBarsWidth = barWidth * spec.series.length;
      marks = spec.x
        .map((_label, xIndex) =>
          spec.series
            .map((item, seriesIndex) => {
              const value = item.data[xIndex] ?? 0;
              const x = xFor(xIndex) - groupBarsWidth / 2 + seriesIndex * barWidth;
              const y = yFor(Math.max(0, value));
              const bottom = yFor(Math.min(0, value));
              const color = SVG_PALETTE[seriesIndex % SVG_PALETTE.length]!;
              return `<rect x="${x.toFixed(1)}" y="${Math.min(y, bottom).toFixed(1)}" width="${Math.max(1, barWidth - 1).toFixed(1)}" height="${Math.max(1, Math.abs(bottom - y)).toFixed(1)}" fill="${color}"><title>${escapeText(item.name)} · ${escapeText(spec.x[xIndex] ?? "")}: ${value}</title></rect>`;
            })
            .join(""),
        )
        .join("");
    } else {
      marks = spec.series
        .map((item, seriesIndex) => {
          const color = SVG_PALETTE[seriesIndex % SVG_PALETTE.length]!;
          const points = item.data
            .map((value, index) => `${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}`)
            .join(" ");
          const circles = item.data
            .map((value, index) => `<circle cx="${xFor(index).toFixed(1)}" cy="${yFor(value).toFixed(1)}" r="3.5" fill="${color}"><title>${escapeText(item.name)} · ${escapeText(spec.x[index] ?? "")}: ${value}</title></circle>`)
            .join("");
          return `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" points="${points}"/>${circles}`;
        })
        .join("");
    }
    const title = spec.title ? `<div class="chart-title">${escapeText(spec.title)}</div>` : "";
    return `<figure class="chart-figure">${title}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeText(spec.title || (spec.type === "bar" ? "柱状图" : "折线图"))}" width="${width}" height="${height}">${grid}<line x1="${padding.left}" y1="${baseline}" x2="${width - padding.right}" y2="${baseline}" stroke="#94a3b8"/>${marks}${labels}</svg><figcaption class="chart-legend">${chartLegend(spec)}</figcaption></figure>`;
  }

  if (spec.type === "pie") {
    const item = spec.series[0]!;
    const total = item.data.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 0) return null;
    const cx = 110;
    const cy = 90;
    const radius = 60;
    let angle = -Math.PI / 2;
    const parts: string[] = [];
    item.data.forEach((value, index) => {
      const fraction = Math.max(0, value) / total;
      const start = angle;
      angle += fraction * Math.PI * 2;
      const end = angle;
      const largeArc = fraction > 0.5 ? 1 : 0;
      const x0 = cx + radius * Math.cos(start);
      const y0 = cy + radius * Math.sin(start);
      const x1 = cx + radius * Math.cos(end);
      const y1 = cy + radius * Math.sin(end);
      const color = SVG_PALETTE[index % SVG_PALETTE.length]!;
      parts.push(`<path d="M ${cx} ${cy} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${radius} ${radius} 0 ${largeArc} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${color}"/>`);
    });
    parts.push(`<circle cx="${cx}" cy="${cy}" r="34" fill="#ffffff"/>`);
    const legend = spec.x
      .map((label, index) => {
        const color = SVG_PALETTE[index % SVG_PALETTE.length]!;
        const percentage = ((Math.max(0, item.data[index]!) / total) * 100).toFixed(1);
        return `<div class="chart-legend-item"><span class="chart-dot" style="background:${color}"></span>${escapeText(label)} · ${percentage}%</div>`;
      })
      .join("");
    const title = spec.title ? `<div class="chart-title">${escapeText(spec.title)}</div>` : "";
    return `<figure class="chart-figure">${title}<svg viewBox="0 0 220 180" role="img" aria-label="${escapeText(spec.title || "饼图")}" width="220" height="180">${parts.join("")}</svg><figcaption class="chart-legend">${legend}</figcaption></figure>`;
  }

  if (spec.type === "scatter") {
    const item = spec.series[0]!;
    const maxY = Math.max(1, ...item.data);
    const minY = Math.min(0, ...item.data);
    const span = Math.max(1e-6, maxY - minY);
    const width = 320;
    const height = 180;
    const padding = 28;
    const points = item.data
      .map((value, index) => {
        const px = padding + (index / Math.max(1, item.data.length - 1)) * (width - padding * 2);
        const py = height - padding - ((value - minY) / span) * (height - padding * 2);
        return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="${SVG_PALETTE[0]}"><title>${escapeText(spec.x[index] ?? "")}: ${value}</title></circle>`;
      })
      .join("");
    const title = spec.title ? `<div class="chart-title">${escapeText(spec.title)}</div>` : "";
    return `<figure class="chart-figure">${title}<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeText(spec.title || "散点图")}" width="${width}" height="${height}"><line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#cbd5e1"/><line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#cbd5e1"/>${points}</svg><figcaption class="chart-legend">${escapeText(item.name)}（${escapeText(spec.x[0] ?? "")} … ${escapeText(spec.x[spec.x.length - 1] ?? "")}）</figcaption></figure>`;
  }
  return null;
}

/** Final fallback: preserve all validated data in a Markdown table. */
export function chartSpecToGfmTable(spec: ChartSpec): string {
  const header = `| 指标 | ${spec.x.join(" | ")} |`;
  const separator = `| --- | ${spec.x.map(() => "---").join(" | ")} |`;
  const rows = spec.series.map((item) => `| ${item.name} | ${item.data.join(" | ")} |`);
  return [header, separator, ...rows].join("\n");
}
