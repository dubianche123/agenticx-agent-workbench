#!/usr/bin/env node
/**
 * Real Electron Workflow Studio acceptance test.
 *
 * This script attaches to the renderer created by `npm run dev`; it does not
 * launch Electron itself and it never stubs the Workflow API. The renderer
 * receives its API base and Studio token through the real preload bridge. The
 * harness never pre-creates or binds session A: when the pane is cold,
 * clicking 创建运行 exercises the product's lazy session path. Session B is
 * created through the real `/api/sessions` route afterward for ownership
 * isolation checks.
 *
 * Start one isolated desktop in another shell:
 *
 *   cd desktop
 *   AGX_HOME="$(mktemp -d /tmp/agenticx-workflow-home.XXXXXX)" \
 *   AGX_DEV_PORT=5713 AGX_DEV_DEBUG_PORT=9229 npm run dev
 *
 * Then, from `desktop/`, attach this script:
 *
 *   AGX_DEV_DEBUG_PORT=9229 \
 *   AGX_E2E_ARTIFACT_DIR=/tmp/agenticx-workflow-e2e \
 *   node e2e/workflow-studio.e2e.mjs
 *
 * The definition-only pass can be isolated with `AGX_E2E_SKIP_RUN=1`; the
 * default path keeps the run, approval, resume, rejection, and ownership
 * assertions enabled. Use a fresh isolated AGX_HOME when a cold-pane
 * precondition is required; the result records session freshness as unknown
 * when the profile may already contain a session.
 * The normal lifecycle range is 10–20 iterations. For a targeted memory
 * stress pass, opt in to 60 with `AGX_E2E_STRESS_LIFECYCLE=1
 * AGX_E2E_LIFECYCLE_ITERATIONS=60`.
 *
 * `AGX_E2E_CDP_URL` may be used instead of `AGX_DEV_DEBUG_PORT`.  A profile
 * created for this run must be isolated with AGX_HOME: Electron's userData is
 * `${AGX_HOME}/desktop-user-data` (see electron/desktop-paths.ts).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);

const TEST_TIMEOUT_MS = 45_000;
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const DEFAULT_LIFECYCLE_ITERATIONS = 12;
const EXPECTED_CONNECTORS = [
  "feishu",
  "wecom",
  "github",
  "tapd",
  "tencent-meeting",
  "qqmail",
];

const startedAt = new Date().toISOString();
const runTag = `wf-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const artifactDir = path.resolve(
  String(process.env.AGX_E2E_ARTIFACT_DIR || "").trim() ||
    path.join(os.tmpdir(), `agenticx-workflow-e2e-${runTag}`),
);
const screenshotDir = path.join(artifactDir, "screenshots");
const metricDir = path.join(artifactDir, "metrics");
const logDir = path.join(artifactDir, "logs");
const cdpEndpoint = String(process.env.AGX_E2E_CDP_URL || "").trim() || (() => {
  const raw = String(process.env.AGX_DEV_DEBUG_PORT || "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error("AGX_DEV_DEBUG_PORT or AGX_E2E_CDP_URL is required");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AGX_DEV_DEBUG_PORT must be between 1 and 65535");
  }
  return `http://127.0.0.1:${port}`;
})();

const lifecycleIterations = (() => {
  const raw = Number(process.env.AGX_E2E_LIFECYCLE_ITERATIONS || DEFAULT_LIFECYCLE_ITERATIONS);
  if (!Number.isFinite(raw)) return DEFAULT_LIFECYCLE_ITERATIONS;
  const max = process.env.AGX_E2E_STRESS_LIFECYCLE === "1" ? 60 : 20;
  return Math.max(10, Math.min(max, Math.floor(raw)));
})();
const skipRunAssertions = process.env.AGX_E2E_SKIP_RUN === "1";
const profileDir = String(process.env.AGX_E2E_PROFILE_DIR || "").trim();
const stressLifecycle = process.env.AGX_E2E_STRESS_LIFECYCLE === "1";

const result = {
  status: "started",
  started_at: startedAt,
  finished_at: null,
  artifact_dir: artifactDir,
  cdp_endpoint: cdpEndpoint,
  lifecycle_iterations: lifecycleIterations,
  options: {
    skip_run_assertions: skipRunAssertions,
    ui_run_session_bootstrap: "run click uses the product lazy createSession path when the pane has no active session; session freshness is not inferred",
    profile_dir: profileDir || "AGX_HOME/desktop-user-data (launcher controlled)",
    stress_lifecycle: stressLifecycle,
  },
  steps: [],
  observations: {},
  ownership_checks: [],
  request_sampling: {},
  browser_errors: [],
  lifecycle: [],
  failure: null,
};
const events = [];
const requestSamples = [];
let requestPhase = "before-first-workflow";
let page = null;
let browser = null;
let cdp = null;
let browserCdp = null;
let electronBrowserPid = null;
let apiBase = "";
let apiToken = "";

function now() {
  return new Date().toISOString();
}

function truncate(value, length = 800) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function redact(value) {
  return truncate(String(value ?? "")
    .replace(/(authorization|x-agx-desktop-token|api[_-]?token|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/[A-Fa-f0-9]{32,}/g, "[redacted-long-token]"));
}

function errorMessage(error) {
  return redact(error instanceof Error ? error.message : error);
}

function log(event, details = {}) {
  const row = { at: now(), event, ...details };
  events.push(row);
  const suffix = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  process.stdout.write(`[workflow-e2e] ${event}${suffix}\n`);
}

function recordStep(name, details = {}) {
  result.steps.push({ name, at: now(), ...details });
  log(name, details);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout = TEST_TIMEOUT_MS, interval = POLL_INTERVAL_MS, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const suffix = lastError ? `: ${errorMessage(lastError)}` : "";
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

async function ensureArtifactDirs() {
  await Promise.all([
    fs.mkdir(screenshotDir, { recursive: true }),
    fs.mkdir(metricDir, { recursive: true }),
    fs.mkdir(logDir, { recursive: true }),
  ]);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function screenshot(label) {
  if (!page || page.isClosed()) return null;
  const filePath = path.join(screenshotDir, `${label}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    log("screenshot", { label, file: filePath });
    return filePath;
  } catch (error) {
    log("screenshot_failed", { label, error: errorMessage(error) });
    return null;
  }
}

function escapeCssAttribute(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function nodeLocator(nodeId) {
  return page.locator(`[data-workflow-node-id="${escapeCssAttribute(nodeId)}"]`);
}

function classifyResource(url) {
  let parsed;
  try {
    parsed = new URL(url, page?.url() || "http://127.0.0.1/");
  } catch {
    return null;
  }
  const pathname = parsed.pathname;
  if (
    pathname.includes("/components/workflow/") ||
    /(?:^|\/)Workflow(?:Studio|Canvas|Node|Inspector|Palette|RunPanel)\.(?:tsx?|jsx?)$/i.test(pathname) ||
    /(?:^|\/)workflow-(?:api|async|types|utils)\.(?:tsx?|jsx?)$/i.test(pathname)
  ) return { kind: "workflow-module", pathname };
  if (
    /^\/api\/workflows(?:\/|$)/.test(pathname) ||
    /^\/api\/workflow-runs(?:\/|$)/.test(pathname) ||
    /^\/api\/workflow-approvals(?:\/|$)/.test(pathname)
  ) return { kind: "workflow-api", pathname };
  return null;
}

async function performanceResources() {
  if (!page || page.isClosed()) return [];
  return page.evaluate(() => performance.getEntriesByType("resource").map((entry) => {
    let url;
    try {
      url = new URL(entry.name, window.location.href);
    } catch {
      return { name: String(entry.name || ""), pathname: "", initiator_type: entry.initiatorType || "" };
    }
    return {
      name: String(entry.name || "").split("?")[0],
      pathname: url.pathname,
      initiator_type: entry.initiatorType || "",
    };
  }));
}

function installPageObservers() {
  page.on("request", (request) => {
    const classification = classifyResource(request.url());
    if (!classification) return;
    requestSamples.push({
      at: now(),
      phase: requestPhase,
      method: request.method(),
      resource_type: request.resourceType(),
      ...classification,
    });
  });
  page.on("pageerror", (error) => {
    const row = { at: now(), type: "pageerror", message: errorMessage(error) };
    result.browser_errors.push(row);
    log("pageerror", row);
  });
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    const row = { at: now(), type: `console:${message.type()}`, message: redact(message.text()) };
    result.browser_errors.push(row);
    log("browser_console", row);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    const classification = classifyResource(request.url());
    if (!classification && !failure) return;
    const row = {
      at: now(),
      type: "requestfailed",
      method: request.method(),
      url: String(request.url()).split("?")[0],
      error: redact(failure?.errorText || "unknown"),
      ...(classification || {}),
    };
    result.browser_errors.push(row);
    log("request_failed", row);
  });
}

async function findRenderer() {
  assert.ok(browser, "CDP browser connection is required");
  return waitFor(async () => {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        try {
          const hasBridge = await candidate.evaluate(() => Boolean(window.agenticxDesktop?.getApiBase));
          if (hasBridge) return candidate;
        } catch {
          // Splash and devtools pages can disappear while Electron starts.
        }
      }
    }
    return null;
  }, { timeout: STARTUP_TIMEOUT_MS, label: "the real Electron renderer preload bridge" });
}

async function refreshBridge() {
  const values = await page.evaluate(async () => ({
    apiBase: await window.agenticxDesktop.getApiBase(),
    apiToken: await window.agenticxDesktop.getApiAuthToken(),
  }));
  const nextBase = String(values.apiBase || "").trim();
  const nextToken = String(values.apiToken || "").trim();
  assert.ok(nextBase, "the preload bridge returned an empty Studio API base");
  assert.ok(nextToken, "the preload bridge returned an empty Studio token");
  apiBase = nextBase;
  apiToken = nextToken;
}

function apiErrorSummary(payload) {
  if (!payload || typeof payload !== "object") return "";
  const root = payload;
  const detail = root.detail && typeof root.detail === "object" ? root.detail : root.detail;
  const source = detail && typeof detail === "object" ? detail : root;
  return redact(source.message || source.code || (typeof detail === "string" ? detail : ""));
}

async function apiRequest(requestPath, {
  method = "GET",
  body,
  expectedStatus = 200,
} = {}) {
  const url = `${apiBase.replace(/\/+$/, "")}${requestPath}`;
  const headers = { "x-agx-desktop-token": apiToken };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = {};
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text: text.slice(0, 500) };
    }
  }
  if (response.status !== expectedStatus) {
    const summary = apiErrorSummary(payload);
    throw new Error(`${method} ${requestPath} expected HTTP ${expectedStatus}, got ${response.status}${summary ? ` (${summary})` : ""}`);
  }
  return { status: response.status, payload };
}

function unwrapRun(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  return root.run && typeof root.run === "object" ? root.run : root;
}

function unwrapApprovals(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const run = unwrapRun(root);
  return Array.isArray(root.approvals) ? root.approvals : Array.isArray(run.approvals) ? run.approvals : [];
}

function unwrapSnapshot(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  return root.snapshot && typeof root.snapshot === "object" ? root.snapshot : root.workflow && typeof root.workflow === "object" ? root.workflow : root;
}

async function waitForWorkflowView() {
  await page.getByTestId("workflow-studio").waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
}

async function waitForWorkflowDocument() {
  await waitFor(async () => {
    const metadata = page.getByTestId("workflow-metadata-inspector");
    const canvas = page.getByTestId("workflow-canvas");
    const emptyCreate = page.getByRole("button", { name: "创建工作流", exact: true });
    return (await metadata.count()) > 0 || (await canvas.count()) > 0 || await isVisible(emptyCreate);
  }, { label: "Workflow document or empty Workflow Studio editor" });
}

async function sampleViewport(label) {
  const sample = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="workflow-canvas"]');
    const studio = document.querySelector('[data-testid="workflow-studio"]');
    const rect = canvas?.getBoundingClientRect();
    const studioRect = studio?.getBoundingClientRect();
    return {
      inner_width: window.innerWidth,
      inner_height: window.innerHeight,
      device_pixel_ratio: window.devicePixelRatio,
      studio_width: studioRect?.width || 0,
      canvas_width: rect?.width || 0,
      canvas_height: rect?.height || 0,
    };
  });
  const row = { label, at: now(), ...sample };
  const samples = Array.isArray(result.observations.viewport_samples) ? result.observations.viewport_samples : [];
  samples.push(row);
  result.observations.viewport_samples = samples;
  if (sample.canvas_width > 0 && sample.canvas_width < 200) log("narrow_workflow_canvas_observed", row);
  return sample;
}

async function assertCanvasNodesFit(label) {
  let lastGeometry = null;
  let geometry;
  try {
    geometry = await waitFor(async () => {
      const current = await page.evaluate(() => {
        const canvasElement = document.querySelector('[data-testid="workflow-canvas"]');
        const canvas = canvasElement?.getBoundingClientRect();
        const nodes = [...document.querySelectorAll("[data-workflow-node-kind]")].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            kind: element.getAttribute("data-workflow-node-kind") || "",
          };
        });
        const canvasBox = canvas
          ? { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom }
          : null;
        return {
          canvas: canvasBox,
          node_count: nodes.length,
          node_kinds: nodes.map((node) => node.kind),
          nodes_fit_canvas: Boolean(canvasBox) && nodes.every((node) => (
            node.left >= canvasBox.left
            && node.top >= canvasBox.top
            && node.right <= canvasBox.right
            && node.bottom <= canvasBox.bottom
          )),
        };
      });
      lastGeometry = current;
      return current.node_count === 3 && current.nodes_fit_canvas ? current : false;
    }, { timeout: 3_000, interval: 100, label: `${label} canvas fitView to settle` });
  } catch (error) {
    const checks = Array.isArray(result.observations.canvas_fit_checks) ? result.observations.canvas_fit_checks : [];
    checks.push({ label, ...(lastGeometry || {}), wait_error: errorMessage(error) });
    result.observations.canvas_fit_checks = checks;
    throw error;
  }
  const checks = Array.isArray(result.observations.canvas_fit_checks) ? result.observations.canvas_fit_checks : [];
  checks.push({ label, ...geometry });
  result.observations.canvas_fit_checks = checks;
  return geometry;
}

function approvalFallbackRequestsSince(startIndex) {
  return requestSamples.slice(startIndex).filter((sample) => (
    sample.method === "GET"
    && /^\/api\/workflow-runs\/[^/]+\/approvals\/?$/.test(sample.pathname || "")
  ));
}

function assertNoApprovalFallbackGet(startIndex, label) {
  const fallbackRequests = approvalFallbackRequestsSince(startIndex);
  assert.equal(fallbackRequests.length, 0, `${label} must use authoritative approvals from the run envelope without a fallback approvals GET`);
  const checks = Array.isArray(result.observations.approval_authority_checks)
    ? result.observations.approval_authority_checks
    : [];
  checks.push({ label, request_sample_start: startIndex, fallback_get_count: 0 });
  result.observations.approval_authority_checks = checks;
}

async function leaveWorkflowView() {
  const brand = page.locator("button.agx-brand-mark").first();
  await brand.click();
  await waitFor(async () => (await page.getByTestId("workflow-studio").count()) === 0, {
    timeout: TEST_TIMEOUT_MS,
    label: "Workflow Studio to unmount after leaving the page",
  });
}

async function openWorkflowView() {
  requestPhase = "after-first-workflow";
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await waitForWorkflowView();
  await waitForWorkflowDocument();
}

async function isVisible(locator) {
  return (await locator.count()) > 0 && await locator.first().isVisible();
}

async function closeWorkflowDrawer(closeLabel) {
  const closeButton = page.getByRole("button", { name: closeLabel, exact: true });
  if (await isVisible(closeButton)) await closeButton.click();
}

async function openPaletteDrawerIfNeeded() {
  const approvalButton = page.getByRole("button", { name: "添加审批门", exact: true });
  if (await isVisible(approvalButton)) return;
  const listToggle = page.getByRole("button", { name: "列表", exact: true });
  assert.ok(await isVisible(listToggle), "Workflow palette is hidden and the accessible 列表 drawer toggle is unavailable");
  await listToggle.click();
  await approvalButton.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
}

async function openInspectorDrawerIfNeeded(testId = "workflow-node-inspector") {
  const inspector = page.getByTestId(testId);
  if (await isVisible(inspector)) return inspector;
  // A newly created document has no selected node. In that state the
  // inspector intentionally renders its metadata form instead of the node
  // form, so callers may ask for workflow-metadata-inspector explicitly.
  if (testId === "workflow-node-inspector" && await isVisible(page.getByTestId("workflow-metadata-inspector"))) {
    return page.getByTestId("workflow-metadata-inspector");
  }
  const propertyToggle = page.getByRole("button", { name: "属性", exact: true });
  assert.ok(await isVisible(propertyToggle), "Workflow inspector is hidden and the accessible 属性 drawer toggle is unavailable");
  await propertyToggle.click();
  await inspector.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  return inspector;
}

async function startNewWorkflowFromUi() {
  const newButton = page.getByRole("button", { name: "新建工作流", exact: true });
  if (await isVisible(newButton)) {
    await newButton.click();
    return;
  }

  // In the compact layout the list is a drawer. An empty profile has no
  // document yet, so its centered action is the only available create button.
  const emptyCreateButton = page.getByRole("button", { name: "创建工作流", exact: true });
  if (await isVisible(emptyCreateButton)) {
    await emptyCreateButton.click();
    return;
  }

  const listToggle = page.getByRole("button", { name: "列表", exact: true });
  assert.ok(await isVisible(listToggle), "Workflow create action is unavailable: neither 新建工作流 nor 创建工作流 nor 列表 is visible");
  await listToggle.click();
  await newButton.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  await newButton.click();
}

async function controlForLabel(scope, labelText) {
  const labels = scope.locator("label");
  const count = await labels.count();
  for (let index = 0; index < count; index += 1) {
    const label = labels.nth(index);
    const text = String(await label.textContent() || "").trim();
    // Select/option text is part of label.textContent, so an exact text
    // comparison stops matching the connector and action fields. Labels are
    // rendered in a stable order and their visible caption is the prefix.
    if (!text.startsWith(labelText)) continue;
    return label.locator("input, textarea, select").first();
  }
  throw new Error(`Could not find control labelled ${labelText}`);
}

async function fillLabel(scope, labelText, value) {
  const control = await controlForLabel(scope, labelText);
  await control.fill(value);
  return control;
}

async function readCanvasNodes() {
  return page.locator("[data-workflow-node-kind]").evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute("data-workflow-node-id") || "",
    kind: element.getAttribute("data-workflow-node-kind") || "",
  })));
}

async function connectNodes(sourceId, targetId) {
  const source = nodeLocator(sourceId).locator(".react-flow__handle-right").first();
  const target = nodeLocator(targetId).locator(".react-flow__handle-left").first();
  await source.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  await target.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox, `source handle for ${sourceId} has no bounding box`);
  assert.ok(targetBox, `target handle for ${targetId} has no bounding box`);
  const from = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await waitFor(async () => (await page.locator(".react-flow__edge").count()) >= 1, {
    label: `edge ${sourceId} -> ${targetId}`,
  });
}

async function deleteInitialEdge() {
  const edge = page.locator(".react-flow__edge").first();
  await edge.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  const pathLocator = edge.locator(".react-flow__edge-path").first();
  const box = await pathLocator.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await pathLocator.click({ force: true });
  }
  await page.keyboard.press("Delete");
  await waitFor(async () => (await page.locator(".react-flow__edge").count()) === 0, {
    timeout: 5_000,
    label: "the initial Trigger -> End edge to be deleted",
  }).catch(async () => {
    await page.keyboard.press("Backspace");
    await waitFor(async () => (await page.locator(".react-flow__edge").count()) === 0, {
      timeout: 5_000,
      label: "the initial Trigger -> End edge to be deleted with Backspace",
    });
  });
}

async function waitForNotice(text) {
  await waitFor(async () => (await page.locator('[role="status"]').allTextContents()).some((value) => value.includes(text)), {
    label: `Workflow notice ${text}`,
  });
}

async function findManifestByTitle(title) {
  const response = await apiRequest("/api/workflows");
  const root = response.payload && typeof response.payload === "object" ? response.payload : {};
  const manifests = Array.isArray(root.workflows) ? root.workflows : Array.isArray(root.manifests) ? root.manifests : [];
  const manifest = manifests.find((item) => String(item?.title || "") === title);
  assert.ok(manifest, `Workflow manifest ${title} was not returned by the real API`);
  return manifest;
}

async function assertGraph(workflowId, expectedIds) {
  const response = await apiRequest(`/api/workflows/${encodeURIComponent(workflowId)}`);
  const snapshot = unwrapSnapshot(response.payload);
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  const kinds = nodes.map((node) => String(node.kind || "")).sort();
  assert.deepEqual(kinds, ["approval_gate", "end", "trigger"], "saved graph must contain exactly Trigger, Approval, End");
  const expectedEdges = [
    [expectedIds.trigger, expectedIds.approval],
    [expectedIds.approval, expectedIds.end],
  ].sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")));
  const actualEdges = edges.map((edge) => [String(edge.source || ""), String(edge.target || "")]).sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")));
  assert.deepEqual(actualEdges, expectedEdges, "saved graph edges must be Trigger -> Approval -> End");
  return { manifest: response.payload?.manifest || null, snapshot };
}

function runIdFromPanel(panelText) {
  const lines = String(panelText || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const headerLine = lines.find((line) => /^(?:v\d+\s*·|执行版本\s+v\d+\s*·)/.test(line));
  if (!headerLine) return "";
  const parts = headerLine.split("·").map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) || "";
}

async function runPanelId(panel) {
  return waitFor(async () => {
    const header = panel.locator("header p").first();
    if ((await header.count()) === 0) return "";
    return runIdFromPanel(await header.innerText());
  }, { label: "run ID in Workflow run panel" });
}

async function panelContains(panel, text) {
  return (await panel.innerText()).includes(text);
}

async function waitPanelContains(panel, text, timeout = TEST_TIMEOUT_MS) {
  await waitFor(() => panelContains(panel, text), { timeout, label: `run panel text ${text}` });
}

async function collectGarbageAndHeap() {
  let gcRequested = false;
  let gcError = null;
  let heap = null;
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    gcRequested = true;
  } catch (error) {
    gcError = errorMessage(error);
  }
  try {
    heap = await cdp.send("Runtime.getHeapUsage");
  } catch (error) {
    heap = { error: errorMessage(error) };
  }
  return { gc_requested: gcRequested, gc_error: gcError, heap };
}

async function eventListenerCount(expression) {
  let objectId = null;
  try {
    const evaluated = await cdp.send("Runtime.evaluate", { expression, returnByValue: false });
    objectId = evaluated?.result?.objectId || null;
    if (!objectId) return { count: null, error: "Runtime.evaluate returned no objectId" };
    const listeners = await cdp.send("DOMDebugger.getEventListeners", { objectId });
    const listenerObjectIds = [...new Set((listeners?.listeners || [])
      .flatMap((listener) => [listener?.handler?.objectId, listener?.originalHandler?.objectId])
      .filter(Boolean))];
    // DOMDebugger returns RemoteObjects for handler/originalHandler. Release
    // every one before releasing the inspected target, otherwise the probe
    // itself can retain listener closures and distort the next heap sample.
    await Promise.all(listenerObjectIds.map((listenerObjectId) => cdp.send("Runtime.releaseObject", { objectId: listenerObjectId }).catch(() => {})));
    return {
      count: Array.isArray(listeners?.listeners) ? listeners.listeners.length : null,
      released_remote_objects: listenerObjectIds.length,
    };
  } catch (error) {
    return { count: null, error: errorMessage(error) };
  } finally {
    if (objectId) await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

async function resolveElectronBrowserPid() {
  if (electronBrowserPid != null) return electronBrowserPid;
  try {
    assert.ok(browserCdp, "browser CDP session is required for process identity");
    const response = await browserCdp.send("SystemInfo.getProcessInfo");
    const browserProcess = (response.processInfo || []).find((processInfo) => processInfo.type === "browser");
    const pid = Number(browserProcess?.id);
    assert.ok(Number.isInteger(pid) && pid > 0, "SystemInfo.getProcessInfo did not return the Electron browser PID");
    electronBrowserPid = pid;
    return pid;
  } catch (error) {
    throw new Error(`unable to resolve Electron browser PID through CDP SystemInfo: ${errorMessage(error)}`);
  }
}

async function sampleProcessTree() {
  try {
    const rootPid = await resolveElectronBrowserPid();
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { maxBuffer: 2_000_000 });
    const rows = String(stdout).split("\n").map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), rss_kb: Number(match[3]), comm: redact(match[4]) };
    }).filter(Boolean);
    // SystemInfo identifies the browser process for this CDP connection. Use
    // that PID directly instead of guessing among unrelated Electron apps.
    const root = rows.find((row) => row.pid === rootPid) || null;
    if (!root) return { available: true, root_pid: null, process_count: 0, rss_kb: 0, processes: [] };
    const childrenByParent = new Map();
    for (const row of rows) {
      const children = childrenByParent.get(row.ppid) || [];
      children.push(row);
      childrenByParent.set(row.ppid, children);
    }
    const tree = [];
    const visit = (row, depth) => {
      if (tree.some((item) => item.pid === row.pid)) return;
      tree.push({ pid: row.pid, ppid: row.ppid, rss_kb: row.rss_kb, comm: row.comm, depth });
      for (const child of childrenByParent.get(row.pid) || []) visit(child, depth + 1);
    };
    visit(root, 0);
    return {
      available: true,
      root_pid: root.pid,
      root_pid_source: "CDP SystemInfo.getProcessInfo(type=browser)",
      process_count: tree.length,
      rss_kb: tree.reduce((sum, row) => sum + (Number(row.rss_kb) || 0), 0),
      processes: tree,
    };
  } catch (error) {
    return { available: false, error: errorMessage(error) };
  }
}

async function lifecycleSample(iteration, phase) {
  const gc = await collectGarbageAndHeap();
  const dom = await page.evaluate(() => ({
    element_count: document.getElementsByTagName("*").length,
    workflow_studio_count: document.querySelectorAll('[data-testid="workflow-studio"]').length,
    workflow_canvas_count: document.querySelectorAll('[data-testid="workflow-canvas"]').length,
    workflow_node_count: document.querySelectorAll("[data-workflow-node-id]").length,
    react_flow_edge_count: document.querySelectorAll(".react-flow__edge").length,
  }));
  const listeners = {
    window: await eventListenerCount("window"),
    document: await eventListenerCount("document"),
  };
  const processTree = await sampleProcessTree();
  return {
    iteration,
    phase,
    at: now(),
    ...gc,
    dom,
    listeners,
    process_tree: processTree,
  };
}

async function createRealSession(name) {
  const response = await apiRequest("/api/sessions", {
    method: "POST",
    body: {
      name,
      session_mode: "daily_office",
      permission_mode: "ask",
    },
  });
  const id = String(response.payload?.session_id || "").trim();
  assert.ok(id, `real /api/sessions did not return an id for ${name}`);
  return { id, name };
}

async function createAndEditWorkflow() {
  await startNewWorkflowFromUi();
  await page.getByTestId("workflow-canvas").waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  await closeWorkflowDrawer("关闭工作流列表");
  await openInspectorDrawerIfNeeded("workflow-metadata-inspector");
  await page.getByTestId("workflow-metadata-inspector").waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });

  const title = `Workflow UI approval ${runTag}`;
  const metadata = page.getByTestId("workflow-metadata-inspector");
  await fillLabel(metadata, "名称", title);
  await fillLabel(metadata, "说明", "真实 Electron UI 验收：保存、发布和审批恢复。");
  await fillLabel(metadata, "工作目标", "通过 Trigger、Approval 和 End 验证真实运行生命周期。");
  await fillLabel(metadata, "完成标准", "发布版本\n批准后闭环\n拒绝后失败");

  let nodes = await readCanvasNodes();
  assert.equal(nodes.filter((node) => node.kind === "trigger").length, 1, "new Workflow must have one trigger");
  assert.equal(nodes.filter((node) => node.kind === "end").length, 1, "new Workflow must have one end");
  await closeWorkflowDrawer("关闭工作流属性");
  await deleteInitialEdge();

  await openPaletteDrawerIfNeeded();
  await page.getByRole("button", { name: "添加审批门", exact: true }).click();
  await waitFor(async () => (await page.locator('[data-workflow-node-kind="approval_gate"]').count()) === 1, {
    label: "approval node to be added through the palette",
  });
  nodes = await readCanvasNodes();
  const trigger = nodes.find((node) => node.kind === "trigger");
  const end = nodes.find((node) => node.kind === "end");
  const approval = nodes.find((node) => node.kind === "approval_gate");
  assert.ok(trigger?.id && end?.id && approval?.id, "new Workflow node IDs must be rendered in the canvas");

  await closeWorkflowDrawer("关闭工作流列表");
  await nodeLocator(approval.id).click();
  const inspector = await openInspectorDrawerIfNeeded();
  await fillLabel(inspector, "节点名称", "需要确认");
  await fillLabel(inspector, "目标", "等待业务负责人确认后继续");
  await fillLabel(inspector, "审批摘要", "确认 Workflow E2E 继续");
  await fillLabel(inspector, "目标动作", "完成本地审批链路");

  await closeWorkflowDrawer("关闭工作流属性");
  await connectNodes(trigger.id, approval.id);
  await connectNodes(approval.id, end.id);
  await waitFor(async () => (await page.locator(".react-flow__edge").count()) === 2, {
    label: "two edges for Trigger -> Approval -> End",
  });
  await screenshot("workflow-created");
  recordStep("create_three_node_workflow_in_ui", { title });
  return { title, ids: { trigger: trigger.id, approval: approval.id, end: end.id } };
}

async function saveAndPublishWorkflow(workflow) {
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await waitForNotice("已保存版本");
  const savedManifest = await findManifestByTitle(workflow.title);
  assert.ok(Number(savedManifest.head_revision) >= 2, "UI save must append a real workflow revision");
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await waitForNotice("已发布版本");
  const publishedManifest = await findManifestByTitle(workflow.title);
  assert.ok(Number(publishedManifest.active_published_revision) > 0, "UI publish must set an active published revision");
  const graph = await assertGraph(publishedManifest.workflow_id, workflow.ids);
  workflow.workflowId = String(publishedManifest.workflow_id);
  workflow.revision = Number(publishedManifest.active_published_revision);
  recordStep("save_and_publish_workflow", { revision: workflow.revision });
  return graph;
}

async function runViewportSweep() {
  const original = await page.evaluate(() => ({
    inner_width: window.innerWidth,
    inner_height: window.innerHeight,
    device_pixel_ratio: window.devicePixelRatio,
  }));
  let wide = null;
  let compact = null;
  let drawerChecks = null;
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.waitForTimeout(350);
    wide = await sampleViewport("wide_viewport");
    assert.ok(wide.inner_width >= 1500 && wide.inner_height >= 900, "wide viewport must be at least 1500x900");
    assert.ok(wide.canvas_width >= 320, "wide viewport must expose a usable canvas bounding box");
    const wideList = page.getByRole("complementary", { name: "工作流列表与节点工具箱", exact: true });
    const wideInspector = page.getByRole("complementary", { name: "工作流属性检查器", exact: true });
    assert.ok(await isVisible(wideList), "wide viewport must keep the Workflow list/toolbox visible");
    assert.ok(await isVisible(wideInspector), "wide viewport must keep the Workflow inspector visible");
    const wideGeometry = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="workflow-canvas"]')?.getBoundingClientRect();
      const canvasBox = canvas ? { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom } : null;
      const nodes = [...document.querySelectorAll("[data-workflow-node-kind]")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      return {
        node_count: nodes.length,
        nodes_fit_canvas: Boolean(canvasBox) && nodes.every((node) => node.left >= canvasBox.left && node.top >= canvasBox.top && node.right <= canvasBox.right && node.bottom <= canvasBox.bottom),
      };
    });
    assert.equal(wideGeometry.node_count, 3, "wide viewport must render the three workflow nodes");
    assert.equal(wideGeometry.nodes_fit_canvas, true, "wide viewport nodes must fit inside the canvas bounding box");
    wide = { ...wide, ...wideGeometry, fixed_sidebars_visible: true };
    await screenshot("workflow-wide-viewport");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.waitForTimeout(350);
    compact = await sampleViewport("compact_viewport");
    assert.ok(compact.inner_width === 900 && compact.inner_height === 700, "compact viewport must be 900x700");
    assert.ok(compact.canvas_width >= 320, "compact viewport must preserve the minimum canvas width");

    const listToggle = page.getByRole("button", { name: "列表", exact: true });
    await waitFor(() => isVisible(listToggle), { label: "列表 drawer toggle after returning to compact viewport" });
    await listToggle.click();
    const paletteButton = page.getByRole("button", { name: "添加审批门", exact: true });
    await paletteButton.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
    await screenshot("workflow-compact-list-drawer");
    await closeWorkflowDrawer("关闭工作流列表");

    const propertyToggle = page.getByRole("button", { name: "属性", exact: true });
    assert.ok(await isVisible(propertyToggle), "属性 drawer toggle must remain reachable in compact viewport");
    await propertyToggle.click();
    await page.locator("#workflow-inspector-drawer").waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
    await screenshot("workflow-compact-property-drawer");
    await closeWorkflowDrawer("关闭工作流属性");
    drawerChecks = { list_toggle: true, palette_action: true, property_toggle: true };
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch((error) => log("viewport_restore_failed", { error: errorMessage(error) }));
    await page.waitForTimeout(250);
  }
  const restored = await page.evaluate(() => ({
    inner_width: window.innerWidth,
    inner_height: window.innerHeight,
    device_pixel_ratio: window.devicePixelRatio,
  }));
  result.observations.viewport_sweep = { original, wide, compact, restored, drawer_checks: drawerChecks };
  recordStep("validate_wide_and_compact_viewports", {
    wide_canvas_width: wide?.canvas_width,
    compact_canvas_width: compact?.canvas_width,
    drawer_checks: drawerChecks,
  });
}

async function createRunFromUi(workflow) {
  const button = page.getByRole("button", { name: "创建运行", exact: true });
  const enabled = await button.isEnabled();
  result.observations.run_button = {
    enabled,
    active_session_before_click: "not_inspected",
    session_creation_freshness: "not_inferred",
    session_binding: "not_bound_via_sidebar_by_harness",
    chat_precondition: "not_inspected",
    session_bootstrap: "product UI run-click path (real preload/API); product lazily creates a session if the pane requires it",
  };
  if (!enabled) {
    await screenshot("run-button-disabled");
    throw new Error("创建运行 is disabled after publishing; the product should allow this click and lazily create an ordinary session when the pane has no active session");
  }
  const runCreateResponse = page.waitForResponse((response) => {
    let parsed;
    try {
      parsed = new URL(response.url());
    } catch {
      return false;
    }
    return response.request().method() === "POST"
      && parsed.pathname === `/api/workflows/${encodeURIComponent(workflow.workflowId)}/runs`;
  }, { timeout: TEST_TIMEOUT_MS });
  const panelRequestSampleStart = requestSamples.length;
  await button.click();
  const createdResponse = await runCreateResponse;
  assert.ok(createdResponse.status() >= 200 && createdResponse.status() < 300, `UI run POST must succeed, got HTTP ${createdResponse.status()}`);
  const createdPayload = await createdResponse.json();
  const createdRun = unwrapRun(createdPayload);
  const sessionId = String(createdRun.session_id || createdPayload?.session_id || "").trim();
  assert.ok(sessionId, "the real UI run POST response must contain the lazily created session_id");
  const session = { id: sessionId, name: `workflow-e2e-ui-run-A-${runTag}` };
  result.observations.run_button.active_session_after_click = session.id;
  result.observations.run_session_bootstrap = {
    source: "real UI POST /api/workflows/{workflow_id}/runs response",
    response_status: createdResponse.status(),
    session_id: session.id,
  };
  const panel = page.getByTestId("workflow-run-panel");
  await panel.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  const runId = await runPanelId(panel);
  assert.ok(runId, "UI run panel must show a real run ID");
  assert.equal(String(createdRun.run_id || ""), runId, "run panel ID must match the real UI run POST response");
  await waitPanelContains(panel, "pending");
  await assertCanvasNodesFit("run panel open");
  assertNoApprovalFallbackGet(panelRequestSampleStart, "initial run panel");
  const runResponse = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(session.id)}`);
  const run = unwrapRun(runResponse.payload);
  const approvals = unwrapApprovals(runResponse.payload);
  assert.equal(String(run.workflow_id || ""), workflow.workflowId, "run must belong to the published Workflow");
  assert.equal(String(run.session_id || ""), session.id, "run must belong to session A");
  assert.ok(approvals.length > 0, "Trigger -> Approval -> End run must create a real approval request");
  const approval = approvals[0];
  assert.equal(String(approval.status || "").toLowerCase(), "pending", "approval must initially be pending");
  result.observations.first_run = { run_id: runId, initial_status: run.status, approval_id: approval.approval_id };
  await screenshot("workflow-pending");
  recordStep("create_run_from_ui", {
    run_status: run.status,
    session_id_source: "real UI POST /api/workflows/{workflow_id}/runs response",
    session_freshness: "not_inferred",
  });
  return { panel, runId, run, approval, session };
}

async function assertSessionIsolation(runId, sessionB) {
  const runResult = await apiRequest(
    `/api/workflow-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(sessionB.id)}`,
    { expectedStatus: 403 },
  );
  const approvalResult = await apiRequest(
    `/api/workflow-runs/${encodeURIComponent(runId)}/approvals?session_id=${encodeURIComponent(sessionB.id)}`,
    { expectedStatus: 403 },
  );
  result.ownership_checks.push({ endpoint: "run", session: "B", status: runResult.status, passed: true });
  result.ownership_checks.push({ endpoint: "approvals", session: "B", status: approvalResult.status, passed: true });
  recordStep("assert_session_isolation", { session_b_forbidden: true });
}

async function approveAndResume(runContext, session) {
  const { panel, approval, runId } = runContext;
  const approvalId = String(approval.approval_id || "").trim();
  assert.ok(approvalId, "the pending approval must have an ID for the close-panel race");
  const decisionPath = `/api/workflow-approvals/${encodeURIComponent(approvalId)}/decision`;
  const race = {
    decision_path: decisionPath,
    decision_post_held: false,
    panel_closed_before_release: false,
    route_continued: false,
    route_continue_error: null,
    response_status: null,
    approval_persisted_after_close: false,
    panel_reopened_and_refreshed: false,
  };
  result.observations.approval_close_panel_race = race;
  let releaseHeldRoute = null;
  let resolveHeldRoute = null;
  let heldRoute = null;
  const heldRouteSeen = new Promise((resolve) => { resolveHeldRoute = resolve; });
  const releasePromise = new Promise((resolve) => { releaseHeldRoute = resolve; });
  const routeMatcher = (url) => {
    try {
      return new URL(url).pathname === decisionPath;
    } catch {
      return false;
    }
  };
  const routeHandler = async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || heldRoute) {
      await route.continue();
      return;
    }
    heldRoute = route;
    race.decision_post_held = true;
    resolveHeldRoute();
    await releasePromise;
    race.route_continued = true;
    try {
      // Continue the real browser request. No response is fulfilled or mocked.
      await route.continue();
    } catch (error) {
      race.route_continue_error = errorMessage(error);
    }
  };
  const approvalDecisionRequestStart = requestSamples.length;
  await page.route(routeMatcher, routeHandler);
  try {
    await panel.getByRole("button", { name: "批准", exact: true }).click();
    await heldRouteSeen;
    const decisionResponsePromise = page.waitForResponse((response) => {
      let parsed;
      try {
        parsed = new URL(response.url());
      } catch {
        return false;
      }
      return response.request().method() === "POST" && parsed.pathname === decisionPath;
    }, { timeout: TEST_TIMEOUT_MS }).catch((error) => ({ error: errorMessage(error) }));

    // This is the production panel close control, whose accessible name is
    // `关闭运行预览` in WorkflowRunPanel.tsx. Close it before releasing the
    // held request to exercise the abort-race contract.
    await panel.getByRole("button", { name: "关闭运行预览", exact: true }).click();
    await waitFor(async () => (await page.getByTestId("workflow-run-panel").count()) === 0, {
      label: "run panel to close before releasing the approval request",
    });
    race.panel_closed_before_release = true;
    releaseHeldRoute();
    const decisionResponse = await decisionResponsePromise;
    if (decisionResponse?.error) throw new Error(`real approval decision POST did not return after panel close: ${decisionResponse.error}`);
    race.response_status = decisionResponse.status();
    assert.ok(race.response_status >= 200 && race.response_status < 300, `real approval decision POST must succeed after panel close, got HTTP ${race.response_status}`);

    let approvedResponse = null;
    await waitFor(async () => {
      approvedResponse = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(session.id)}`);
      const approvedApprovals = unwrapApprovals(approvedResponse.payload);
      return String(approvedApprovals[0]?.status || "").toLowerCase() === "approved";
    }, { label: "approval decision to persist after closing the run panel" });
    const approvedApprovals = unwrapApprovals(approvedResponse.payload);
    assert.equal(String(approvedApprovals[0]?.status || "").toLowerCase(), "approved", "approval decision must persist after the run panel closes");
    race.approval_persisted_after_close = true;
    assertNoApprovalFallbackGet(approvalDecisionRequestStart, "approval close-panel race");

    const reopenButton = page.getByRole("button", { name: "打开运行预览", exact: true });
    await reopenButton.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
    await reopenButton.click();
    const reopenedPanel = page.getByTestId("workflow-run-panel");
    await reopenedPanel.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
    const refreshRequestStart = requestSamples.length;
    await reopenedPanel.getByRole("button", { name: "刷新运行", exact: true }).click();
    await waitPanelContains(reopenedPanel, "approved");
    await assertCanvasNodesFit("reopened approved run panel");
    assertNoApprovalFallbackGet(refreshRequestStart, "reopened run panel refresh");
    race.panel_reopened_and_refreshed = true;

    const resumeRequestStart = requestSamples.length;
    await reopenedPanel.getByRole("button", { name: "继续运行", exact: true }).click();
    await waitPanelContains(reopenedPanel, "已完成", 30_000);
    await assertCanvasNodesFit("resumed run panel");
    assertNoApprovalFallbackGet(resumeRequestStart, "approval resume refresh");
  } finally {
    // If an assertion interrupts the race, always release the real route and
    // remove the one-shot handler so later runs cannot inherit the hold.
    releaseHeldRoute();
    await page.unroute(routeMatcher, routeHandler).catch(() => {});
  }
  const closedResponse = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(session.id)}`);
  const closedRun = unwrapRun(closedResponse.payload);
  assert.equal(String(closedRun.status || "").toLowerCase(), "closed", "approved run must close after explicit resume");
  await screenshot("workflow-closed");
  recordStep("approve_close_panel_resume_run", {
    status: closedRun.status,
    decision_post_held: race.decision_post_held,
    panel_closed_before_release: race.panel_closed_before_release,
    approval_persisted_after_close: race.approval_persisted_after_close,
    panel_reopened_and_refreshed: race.panel_reopened_and_refreshed,
  });
  return closedRun;
}

async function rejectSecondRun(workflow, session, firstRunId) {
  const button = page.getByRole("button", { name: "创建运行", exact: true });
  assert.equal(await button.isEnabled(), true, "create run must remain enabled after the first run closes");
  const createSecondRunRequestStart = requestSamples.length;
  await button.click();
  const panel = page.getByTestId("workflow-run-panel");
  await panel.waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  await assertCanvasNodesFit("second run panel open");
  assertNoApprovalFallbackGet(createSecondRunRequestStart, "second run panel");
  const runId = await runPanelId(panel);
  assert.ok(runId && runId !== firstRunId, "second UI run must have a distinct real run ID");
  const initialResponse = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(session.id)}`);
  const approvals = unwrapApprovals(initialResponse.payload);
  assert.equal(String(approvals[0]?.status || "").toLowerCase(), "pending", "second approval must initially be pending");
  const rejectionRequestStart = requestSamples.length;
  await panel.getByRole("button", { name: "拒绝", exact: true }).click();
  await waitPanelContains(panel, "执行失败");
  await assertCanvasNodesFit("rejected run panel");
  assertNoApprovalFallbackGet(rejectionRequestStart, "approval rejection refresh");
  const failedResponse = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(session.id)}`);
  const failedRun = unwrapRun(failedResponse.payload);
  assert.equal(String(failedRun.status || "").toLowerCase(), "failed", "rejected approval must fail the run");
  const failedApprovals = unwrapApprovals(failedResponse.payload);
  assert.equal(String(failedApprovals[0]?.status || "").toLowerCase(), "rejected", "rejection must be persisted by the real API");
  await screenshot("workflow-rejected");
  recordStep("reject_second_run", { status: failedRun.status });
  return { runId, run: failedRun };
}

async function assertConnectorOptions() {
  await openPaletteDrawerIfNeeded();
  await page.getByRole("button", { name: "添加连接器动作", exact: true }).click();
  await waitFor(async () => (await page.locator('[data-workflow-node-kind="connector_action"]').count()) === 1, {
    label: "connector action node to be added through the palette",
  });
  const connectorNode = page.locator('[data-workflow-node-kind="connector_action"]').last();
  await closeWorkflowDrawer("关闭工作流列表");
  await connectorNode.click();
  const inspector = await openInspectorDrawerIfNeeded();
  const select = await controlForLabel(inspector, "连接器");
  const options = await select.locator("option").evaluateAll((elements) => elements.map((element) => ({ value: element.value, label: element.textContent?.trim() || "" })));
  const values = options.map((option) => option.value).filter(Boolean);
  assert.deepEqual([...values].sort(), [...EXPECTED_CONNECTORS].sort(), "connector selector must expose the six server catalog connectors");
  for (const connectorId of EXPECTED_CONNECTORS) {
    await select.selectOption(connectorId);
    await waitFor(async () => (await select.inputValue()) === connectorId, { label: `connector ${connectorId} to be selected` });
  }
  const action = await controlForLabel(inspector, "动作");
  assert.equal(await action.isEnabled(), true, "catalog action selector must enable after choosing a connector");
  assert.ok((await action.locator("option").count()) > 1, "each catalog connector must expose at least one action");
  result.observations.connector_options = options;
  await screenshot("connector-options");
  recordStep("assert_six_connector_options", { connector_ids: EXPECTED_CONNECTORS });
}

async function reenterAndVerify(workflow) {
  await leaveWorkflowView();
  await openWorkflowView();
  await page.getByTestId("workflow-canvas").waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
  await sampleViewport("workflow_reentered");
  const reenteredManifest = await findManifestByTitle(workflow.title);
  assert.equal(Number(reenteredManifest.head_revision), workflow.revision, "leaving and re-entering must preserve the published head");
  assert.equal(Number(reenteredManifest.active_published_revision), workflow.revision, "leaving and re-entering must preserve the published revision");
  const detail = await assertGraph(workflow.workflowId, workflow.ids);
  const reenteredNodes = await readCanvasNodes();
  assert.equal(reenteredNodes.filter((node) => node.kind === "connector_action").length, 0, "unsaved connector probe must not mutate the published graph");
  await screenshot("workflow-reentered");
  recordStep("leave_and_reenter_workflow", { preserved_revision: workflow.revision, graph_edges: detail.snapshot.edges.length });
}

async function runLifecycleMeasurements() {
  result.lifecycle.push(await lifecycleSample(0, "open"));
  for (let iteration = 1; iteration <= lifecycleIterations; iteration += 1) {
    await leaveWorkflowView();
    result.lifecycle.push(await lifecycleSample(iteration, "closed"));
    await openWorkflowView();
    await page.getByTestId("workflow-canvas").waitFor({ state: "visible", timeout: TEST_TIMEOUT_MS });
    if (iteration === 1 || iteration === lifecycleIterations) await sampleViewport(`lifecycle_${iteration}`);
    result.lifecycle.push(await lifecycleSample(iteration, "open"));
  }
  const openSamples = result.lifecycle.filter((sample) => sample.phase === "open");
  const closedSamples = result.lifecycle.filter((sample) => sample.phase === "closed");
  const heapValues = openSamples.map((sample) => Number(sample.heap?.usedSize)).filter(Number.isFinite);
  const domValues = openSamples.map((sample) => Number(sample.dom?.element_count)).filter(Number.isFinite);
  const rssValues = openSamples.map((sample) => Number(sample.process_tree?.rss_kb)).filter(Number.isFinite);
  result.observations.lifecycle_measurement = {
    iterations: lifecycleIterations,
    open_samples: openSamples.length,
    closed_samples: closedSamples.length,
    forced_gc: result.lifecycle.every((sample) => sample.gc_requested === true),
    heap_used_size_bytes: heapValues,
    dom_element_count: domValues,
    electron_tree_rss_kb: rssValues,
    profile_dir: profileDir || "AGX_HOME/desktop-user-data (launcher controlled)",
    closed_dom_element_count: closedSamples.map((sample) => Number(sample.dom?.element_count)).filter(Number.isFinite),
    closed_listener_counts: closedSamples.map((sample) => sample.listeners),
    listener_scopes: ["window", "document"],
    interpretation: "Samples are post-navigation and post-CDP HeapProfiler.collectGarbage observations; they are not by themselves a leak verdict.",
  };
  await writeJson(path.join(metricDir, "workflow-lifecycle.json"), result.lifecycle);
  recordStep("measure_workflow_open_close_lifecycle", { iterations: lifecycleIterations });
}

async function run() {
  await ensureArtifactDirs();
  log("start", { artifact_dir: artifactDir, lifecycle_iterations: lifecycleIterations });
  browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 15_000 });
  browserCdp = await browser.newBrowserCDPSession();
  page = await findRenderer();
  cdp = await page.context().newCDPSession(page);
  page.setDefaultTimeout(TEST_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(TEST_TIMEOUT_MS);
  installPageObservers();
  await page.waitForLoadState("domcontentloaded", { timeout: TEST_TIMEOUT_MS }).catch(() => {});
  await refreshBridge();
  const initialResources = await performanceResources();
  result.request_sampling.initial_resource_entries = initialResources;
  const initialWorkflowModules = initialResources.map(classifyResource).filter((item) => item?.kind === "workflow-module");
  const initialWorkflowApi = initialResources.map(classifyResource).filter((item) => item?.kind === "workflow-api");
  assert.equal(initialWorkflowModules.length, 0, "Workflow modules must not load before the Workflow page is opened");
  assert.equal(initialWorkflowApi.length, 0, "Workflow API requests must not happen before the Workflow page is opened");
  result.request_sampling.before_first_workflow = { module_resources: [], api_resources: [] };
  await screenshot("startup-before-workflow");
  recordStep("sample_before_workflow_open", { module_resources: 0, workflow_api_requests: 0 });

  await openWorkflowView();
  await sampleViewport("first_workflow_open");
  const observedAfterOpen = requestSamples.filter((sample) => sample.phase === "after-first-workflow");
  const performanceAfterOpen = (await performanceResources()).map(classifyResource).filter(Boolean);
  result.request_sampling.after_first_workflow = {
    observed_requests: observedAfterOpen,
    module_resources_after_open: observedAfterOpen.filter((sample) => sample.kind === "workflow-module"),
    api_resources_after_open: observedAfterOpen.filter((sample) => sample.kind === "workflow-api"),
    performance_resources_after_open: performanceAfterOpen,
  };
  const workflow = await createAndEditWorkflow();
  await saveAndPublishWorkflow(workflow);
  await runViewportSweep();
  if (skipRunAssertions) {
    result.observations.run_skipped = "AGX_E2E_SKIP_RUN=1";
    await assertConnectorOptions();
    await reenterAndVerify(workflow);
    await runLifecycleMeasurements();
    result.request_sampling.event_records = requestSamples;
    result.status = "passed";
    return;
  }
  const firstRun = await createRunFromUi(workflow);
  const sessionA = firstRun.session;
  const sessionB = await createRealSession(`workflow-e2e-B-${runTag}`);
  assert.notEqual(sessionA.id, sessionB.id, "cold UI session A and API-created session B must have distinct IDs");
  result.observations.sessions = {
    a: { name: sessionA.name, source: "real UI run POST response; session freshness not inferred" },
    b: { name: sessionB.name, source: "real API /api/sessions" },
    distinct: true,
  };
  await assertSessionIsolation(firstRun.runId, sessionB);
  await approveAndResume(firstRun, sessionA);
  await rejectSecondRun(workflow, sessionA, firstRun.runId);
  await assertConnectorOptions();
  await reenterAndVerify(workflow);
  await runLifecycleMeasurements();
  result.request_sampling.event_records = requestSamples;
  result.status = "passed";
}

async function uiFailureSummary() {
  if (!page || page.isClosed()) return null;
  try {
    return redact((await page.locator("body").innerText({ timeout: 2_000 })).slice(0, 3_000));
  } catch (error) {
    return `body unavailable: ${errorMessage(error)}`;
  }
}

async function finish() {
  result.finished_at = now();
  result.request_sampling.event_records = requestSamples;
  await writeJson(path.join(artifactDir, "workflow-e2e-results.json"), result);
  await writeJson(path.join(metricDir, "module-requests.json"), {
    initial_resource_entries: result.request_sampling.initial_resource_entries || [],
    before_first_workflow: result.request_sampling.before_first_workflow || {},
    after_first_workflow: result.request_sampling.after_first_workflow || {},
    event_records: requestSamples,
  });
  await writeJson(path.join(artifactDir, "browser-errors.json"), result.browser_errors);
  await fs.writeFile(path.join(logDir, "workflow-e2e.log"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

try {
  await run();
} catch (error) {
  result.status = "failed";
  result.failure = { message: errorMessage(error), ui: await uiFailureSummary() };
  log("failure", result.failure);
  await screenshot("failure");
} finally {
  try {
    await finish();
  } catch (error) {
    process.stderr.write(`[workflow-e2e] artifact_write_failed ${errorMessage(error)}\n`);
    result.status = "failed";
  }
  // Playwright's CDP close tears down its WebSocket transport; it does not
  // launch a second browser or change the isolated profile. The parent dev
  // process remains the owner of Electron's lifecycle.
  if (browser) await browser.close({ reason: "workflow-e2e finished" }).catch((error) => log("cdp_close_failed", { error: errorMessage(error) }));
  process.exitCode = result.status === "passed" ? 0 : 1;
}
