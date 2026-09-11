import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { calculateSplashBounds, type SplashWorkArea } from "../electron/splash";

function expectBoundsInsideWorkArea(bounds: ReturnType<typeof calculateSplashBounds>, workArea: SplashWorkArea): void {
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
  expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
}

const splashHtml = fs.readFileSync(path.join(process.cwd(), "electron", "splash.html"), "utf8");

describe("calculateSplashBounds", () => {
  it("keeps the normal splash centered with breathing room around the work area", () => {
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    const bounds = calculateSplashBounds(workArea);

    expectBoundsInsideWorkArea(bounds, workArea);
    expect(bounds.width).toBeGreaterThanOrEqual(700);
    expect(bounds.width).toBeLessThanOrEqual(860);
    expect(bounds.height).toBeGreaterThanOrEqual(300);
    expect(bounds.x).toBeGreaterThan(0);
    expect(bounds.y).toBeGreaterThan(0);
  });

  it("fits a scaled compact display instead of enforcing a cropped minimum", () => {
    const workArea = { x: 0, y: 0, width: 640, height: 360 };
    const bounds = calculateSplashBounds(workArea);

    expectBoundsInsideWorkArea(bounds, workArea);
    expect(bounds.width).toBeLessThanOrEqual(workArea.width - 16);
    expect(bounds.height).toBeLessThanOrEqual(workArea.height - 16);
    expect(bounds.width).toBe(560);
  });

  it("never places a splash outside an ultra compact or offset work area", () => {
    const workArea = { x: -120, y: 40, width: 360, height: 260 };
    const bounds = calculateSplashBounds(workArea);

    expectBoundsInsideWorkArea(bounds, workArea);
    expect(bounds.width).toBe(332);
    expect(bounds.height).toBe(240);
    expect(bounds.x).toBe(-106);
    expect(bounds.y).toBe(50);
  });

  it.each([
    [
      { x: 0, y: 0, width: 320, height: 180 },
      { x: 12, y: 8, width: 296, height: 164 },
    ],
    [
      { x: -240, y: 24, width: 360, height: 180 },
      { x: -226, y: 32, width: 332, height: 164 },
    ],
  ])("fits exact 180px-high work areas without moving outside their coordinates", (workArea, expected) => {
    const bounds = calculateSplashBounds(workArea);

    expect(bounds).toEqual(expected);
    expectBoundsInsideWorkArea(bounds, workArea);
  });

  it("keeps the HTML composition shrinkable at the same breakpoints as the bounds calculator", () => {
    const h1Css = splashHtml.match(/\n      h1 \{([\s\S]*?)\n      \}/)?.[1] ?? "";

    expect(splashHtml).toContain("inset: clamp(10px, 2.5vw, 18px);");
    expect(splashHtml).toContain("@media (max-width: 760px)");
    expect(splashHtml).toContain("@media (max-width: 460px)");
    expect(splashHtml).toContain("@media (max-height: 300px)");
    expect(splashHtml).toContain("@media (max-height: 200px)");
    expect(splashHtml).toContain("inset: 6px;");
    expect(splashHtml).toContain("min-height: 20px;");
    expect(h1Css).toContain("overflow-wrap: anywhere;");
    expect(h1Css).not.toContain("white-space: nowrap;");
  });
});
