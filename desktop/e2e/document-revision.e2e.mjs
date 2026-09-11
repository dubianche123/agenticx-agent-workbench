#!/usr/bin/env node
/**
 * Bounded real Electron acceptance for ordinary-chat document revisions.
 *
 * The test attaches to an already-running Electron renderer through CDP. It
 * configures a loopback OpenAI-compatible provider through the authenticated
 * preload bridge, sends ordinary chat messages through the composer, and
 * lets the real AgentRuntime execute the document tools. The fixture never
 * supplies a manifest or a synthetic runtime result.
 *
 * Example (run from desktop/ with an isolated profile/workspace):
 *
 *   AGX_DEV_DEBUG_PORT=9337 \
 *   AGX_E2E_ARTIFACT_DIR=/private/tmp/document-revision-e2e \
 *   node e2e/document-revision.e2e.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";
import { createDocumentRevisionModelFixture } from "./document-revision-model-fixture.mjs";

const WAIT_MS = Number(process.env.AGX_E2E_DOCUMENT_WAIT_MS || 60_000);
const POLL_MS = Number(process.env.AGX_E2E_DOCUMENT_POLL_MS || 250);
const runTag = `document-revision-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const artifactDir = path.resolve(
  String(process.env.AGX_E2E_ARTIFACT_DIR || "").trim() || path.join(os.tmpdir(), `agenticx-${runTag}`),
);
const screenshotDir = path.join(artifactDir, "screenshots");
const cdpEndpoint = String(process.env.AGX_E2E_CDP_URL || "").trim() || (() => {
  const raw = String(process.env.AGX_DEV_DEBUG_PORT || "").trim();
  if (!/^\d+$/.test(raw)) throw new Error("AGX_DEV_DEBUG_PORT or AGX_E2E_CDP_URL is required");
  return `http://127.0.0.1:${Number(raw)}`;
})();
const providerId = `document-revision-e2e-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const paths = {
  mdV1: `${runTag}-md-v1.md`,
  mdV2: `${runTag}-md-v2.md`,
  htmlV1: `${runTag}-html-v1.html`,
  htmlV2: `${runTag}-html-v2.html`,
  docxV1: `${runTag}-docx-v1.docx`,
  docxV2: `${runTag}-docx-v2.docx`,
  conflict: `${runTag}-conflict.md`,
};

const result = {
  status: "started",
  started_at: new Date().toISOString(),
  finished_at: null,
  artifact_dir: artifactDir,
  cdp_endpoint: cdpEndpoint,
  provider_id: providerId,
  paths,
  fixture: null,
  session_id: null,
  steps: [],
  screenshots: {},
  observations: {},
  responses: [],
  coverage_limits: {
    profile: "caller owns the isolated Electron profile/workspace; this script does not create or remove it",
    model_transport: "loopback OpenAI-compatible SSE only; no fake manifest or runtime result injection",
    document_formats: "md/html via document_generate; docx via bash_exec minimal ZIP plus document_publish",
    undo: "MD and DOCX rename undo restore exact original bytes; conflict undo is attempted after a manual disk edit",
  },
  failure: null,
};

let browser = null;
let page = null;
let fixture = null;
let apiBase = "";
let apiToken = "";
let originalConfig = null;
let sessionId = "";

function now() {
  return new Date().toISOString();
}

function text(value, limit = 2_000) {
  const raw = String(value ?? "");
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function errorText(error) {
  return text(error instanceof Error ? error.message : error);
}

function log(name, details = {}) {
  const row = { at: now(), name, ...details };
  result.steps.push(row);
  process.stdout.write(`[document-revision-e2e] ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, { timeout = WAIT_MS, interval = POLL_MS, label = "condition" } = {}) {
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
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${errorText(lastError)}` : ""}`);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function screenshot(label) {
  if (!page || page.isClosed()) return null;
  const file = path.join(screenshotDir, `${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    result.screenshots[label] = file;
    return file;
  } catch (error) {
    result.screenshots[label] = { error: errorText(error) };
    return null;
  }
}

function apiPath(pathname) {
  return `${apiBase.replace(/\/+$/, "")}${pathname}`;
}

function errorSummary(payload) {
  if (!payload || typeof payload !== "object") return "";
  const detail = payload.detail;
  const source = detail && typeof detail === "object" ? detail : payload;
  return text(source.message || source.code || (typeof detail === "string" ? detail : ""), 500);
}

async function apiRequest(pathname, { method = "GET", body, expectedStatus = 200 } = {}) {
  const headers = { "x-agx-desktop-token": apiToken };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(apiPath(pathname), init);
  const raw = await response.text();
  let payload = {};
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch { payload = { text: raw.slice(0, 1_000) }; }
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${pathname} expected HTTP ${expectedStatus}, got ${response.status}${errorSummary(payload) ? ` (${errorSummary(payload)})` : ""}`);
  }
  return { status: response.status, payload };
}

async function findRenderer() {
  return waitFor(async () => {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        try {
          if (await candidate.evaluate(() => Boolean(window.agenticxDesktop?.getApiBase))) return candidate;
        } catch {
          // Splash/devtools pages can disappear while the app attaches.
        }
      }
    }
    return null;
  }, { label: "Electron renderer preload bridge" });
}

async function refreshBridge() {
  const values = await page.evaluate(async () => ({
    apiBase: await window.agenticxDesktop.getApiBase(),
    apiToken: await window.agenticxDesktop.getApiAuthToken(),
  }));
  apiBase = String(values.apiBase || "").trim();
  apiToken = String(values.apiToken || "").trim();
  assert.ok(apiBase, "preload returned an empty Studio API base");
  assert.ok(apiToken, "preload returned an empty Studio token");
}

async function visibleButton(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (await candidate.isVisible()) return candidate;
    } catch {
      // DOM changed between count() and isVisible().
    }
  }
  return null;
}

async function closeBlockingOverlay() {
  // Escape handles the personal-assistant/settings surface without guessing
  // at private component state. Then close only visible buttons whose public
  // label/title explicitly says they close a surface.
  await page.keyboard.press("Escape").catch(() => {});
  const close = await visibleButton(page.getByRole("button", { name: "关闭", exact: true }));
  if (close) await close.click().catch(() => {});
  const labelled = page.locator('button[aria-label*="关闭"], button[title*="关闭"]');
  const count = await labelled.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = labelled.nth(index);
    try {
      if (!(await candidate.isVisible())) continue;
      const label = `${await candidate.getAttribute("aria-label") || ""} ${await candidate.getAttribute("title") || ""}`;
      if (/关闭(预览|工作流列表|运行预览)|收起/u.test(label)) continue;
      await candidate.click().catch(() => {});
      break;
    } catch {
      // A transient overlay may disappear while it is being closed.
    }
  }
}

async function approveVisibleConfirmation() {
  const approve = page.getByRole("button", { name: /^(允许这一次|允许本任务|保存并允许)$/u });
  const candidate = await visibleButton(approve);
  if (!candidate) return false;
  const label = await candidate.innerText();
  await candidate.click();
  log("approve_local_confirmation", { label });
  return true;
}

async function ensureOrdinaryChat({ newTopic = false } = {}) {
  await closeBlockingOverlay();
  if (newTopic) {
    const showSidebar = await visibleButton(page.getByRole("button", { name: "展开侧栏", exact: true }));
    if (showSidebar) await showSidebar.click();
    const newTask = await visibleButton(page.getByRole("button", { name: "新建任务", exact: true }));
    assert.ok(newTask, "new isolated document test must be able to create its own task");
    await newTask.click();
    log("navigate_ordinary_chat", { route: "新建任务" });
  }
  const composer = page.locator('[contenteditable="true"].agx-pane-composer-input');
  await waitFor(async () => await visibleButton(composer), { label: "ordinary-chat composer" });
  return composer;
}

async function getComposer() {
  const composer = page.locator('[contenteditable="true"].agx-pane-composer-input');
  return waitFor(async () => visibleButton(composer), { label: "ordinary-chat composer" });
}

async function getTurns(sid = sessionId) {
  assert.ok(sid, "session id is required to read turn manifests");
  const response = await apiRequest(`/api/session/turns?session_id=${encodeURIComponent(sid)}`);
  return Array.isArray(response.payload?.turns) ? response.payload.turns : [];
}

async function bindSessionModel(sid) {
  const outcome = await page.evaluate(async ({ sessionId: sidArg, provider, model }) => {
    if (typeof window.agenticxDesktop?.setSessionModel !== "function") {
      return { ok: false, error: "setSessionModel preload method is unavailable" };
    }
    return window.agenticxDesktop.setSessionModel({ sessionId: sidArg, provider, model });
  }, { sessionId: sid, provider: providerId, model: fixture.model });
  assert.ok(outcome?.ok, `could not bind session model: ${outcome?.error || "unknown error"}`);
  log("bind_session_model", { session_id: sid, provider: providerId, model: fixture.model });
}

function turnArtifactRows(turn) {
  return Array.isArray(turn?.artifacts) ? turn.artifacts : [];
}

function artifactPathFor(turn, expectedRelativePath) {
  const expectedName = path.basename(expectedRelativePath);
  const row = turnArtifactRows(turn).find((item) => {
    const candidate = typeof item === "string" ? item : item?.path;
    return path.basename(String(candidate || "")) === expectedName;
  });
  return row ? (typeof row === "string" ? row : row.path) : "";
}

function artifactRowFor(turn, expectedRelativePath) {
  const expectedName = path.basename(expectedRelativePath);
  return turnArtifactRows(turn).find((item) => path.basename(String(typeof item === "string" ? item : item?.path || "")) === expectedName) || null;
}

async function waitForTurnAfter(beforeIds, marker) {
  return waitFor(async () => {
    await approveVisibleConfirmation();
    const turns = await getTurns();
    const fresh = turns.find((turn) => !beforeIds.has(String(turn?.turn_id || "")));
    if (!fresh) return null;
    const status = String(fresh.status || "").toLowerCase();
    if (status === "running" || status === "pending") return null;
    if (status !== "completed") {
      throw new Error(`turn ${marker} failed: ${text(fresh.reason || "unknown turn failure")}`);
    }
    return fresh;
  }, { label: `turn completion ${marker}` });
}

async function sendTurn(marker) {
  const composer = await getComposer();
  const before = sessionId ? await getTurns() : [];
  const beforeIds = new Set(before.map((turn) => String(turn?.turn_id || "")));
  await composer.fill(marker);
  const requestPromise = page.waitForRequest((request) => {
    if (request.method() !== "POST") return false;
    try {
      if (new URL(request.url()).pathname !== "/api/chat") return false;
      const payload = request.postDataJSON();
      return String(payload?.user_input || "") === marker && String(payload?.session_id || "").trim() !== "";
    } catch {
      return false;
    }
  }, { timeout: WAIT_MS });
  const [request] = await Promise.all([requestPromise, composer.press("Enter")]);
  const requestPayload = request.postDataJSON();
  const requestSessionId = String(requestPayload?.session_id || "").trim();
  assert.ok(requestSessionId, `${marker} /api/chat request did not contain session_id`);
  if (!sessionId) {
    sessionId = requestSessionId;
    result.session_id = sessionId;
    await bindSessionModel(sessionId).catch((error) => log("bind_after_first_send_deferred", { error: errorText(error) }));
  } else {
    assert.equal(requestSessionId, sessionId, `${marker} must reuse the reopened ordinary-chat session`);
  }
  const turn = await waitForTurnAfter(beforeIds, marker);
  log("ordinary_chat_turn_completed", {
    marker,
    turn_id: turn.turn_id,
    status: turn.status,
    artifact_count: turnArtifactRows(turn).length,
  });
  return turn;
}

async function assertFile(pathname, expectedText = null) {
  const bytes = await fs.readFile(pathname);
  assert.ok(bytes.length > 0, `file is empty: ${pathname}`);
  if (expectedText !== null) assert.equal(bytes.toString("utf8"), expectedText, `unexpected file bytes: ${pathname}`);
  return bytes;
}

async function assertMissing(pathname) {
  await assert.rejects(fs.access(pathname), undefined, `expected file to be absent: ${pathname}`);
}

async function sessionArtifactMap() {
  const response = await apiRequest(`/api/artifacts?session_id=${encodeURIComponent(sessionId)}`);
  return response.payload?.artifacts && typeof response.payload.artifacts === "object"
    ? response.payload.artifacts
    : {};
}

async function assertCurrentArtifactMap(currentPaths, hiddenPaths = []) {
  const map = await sessionArtifactMap();
  for (const pathname of currentPaths) assert.ok(Object.prototype.hasOwnProperty.call(map, pathname), `session artifact map lacks current path ${pathname}`);
  for (const pathname of hiddenPaths) assert.equal(Object.prototype.hasOwnProperty.call(map, pathname), false, `superseded path remains in session artifact map: ${pathname}`);
  for (const pathname of Object.keys(map)) {
    assert.equal(path.basename(pathname).startsWith(".") || pathname.includes(`${path.sep}checkpoint${path.sep}`), false, `private/checkpoint path leaked into artifact map: ${pathname}`);
  }
  return map;
}

async function waitForArtifactCard(absolutePath) {
  const cards = page.locator("[data-artifact-path]");
  await waitFor(async () => {
    const pathsOnPage = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-artifact-path") || ""));
    return pathsOnPage.includes(absolutePath);
  }, { label: `artifact card ${path.basename(absolutePath)}` });
  const index = await cards.evaluateAll((nodes, expected) => nodes.findIndex((node) => node.getAttribute("data-artifact-path") === expected), absolutePath);
  assert.ok(index >= 0, `artifact card disappeared: ${absolutePath}`);
  return cards.nth(index);
}

async function previewArtifact(absolutePath, expectedSnippet) {
  // Document creation may automatically open the workbench preview. On a
  // compact window its backdrop covers the reply card; close that normal
  // surface before testing the card's own preview entry.
  const hidePanel = await visibleButton(page.getByRole("button", { name: "隐藏工具面板", exact: true }));
  if (hidePanel) await hidePanel.click();
  const card = await waitForArtifactCard(absolutePath);
  await card.getByRole("button", { name: new RegExp(`^预览 ${escapeRegExp(path.basename(absolutePath))}$`, "u") }).click();
  if (/\.html?$/iu.test(absolutePath)) {
    // HTML opens in the product's sandboxed browser pane, not its file dialog.
    // Electron's opaque sandbox frame is not always exposed as a CDP child;
    // inspect the actual displayed srcdoc and retain a rendered screenshot.
    const htmlFrame = page.locator(`iframe[title=${JSON.stringify(path.basename(absolutePath))}]`);
    await htmlFrame.waitFor({ state: "visible", timeout: WAIT_MS });
    await waitFor(async () => String(await htmlFrame.getAttribute("srcdoc") || "").includes(expectedSnippet), { label: `HTML preview ${path.basename(absolutePath)}` });
    log("preview_file", { path: absolutePath, snippet: expectedSnippet, surface: "sandboxed HTML browser pane" });
    await screenshot(`preview-${path.basename(absolutePath)}`);
    const hideBrowser = await visibleButton(page.getByRole("button", { name: "隐藏工具面板", exact: true }));
    if (hideBrowser) await hideBrowser.click();
    return;
  }
  const dialog = page.getByRole("dialog", { name: `预览 ${path.basename(absolutePath)}`, exact: true });
  await dialog.waitFor({ state: "visible", timeout: WAIT_MS });
  const iframe = dialog.locator("iframe").first();
  if (await iframe.count()) {
    await iframe.contentFrame().getByText(expectedSnippet, { exact: false }).waitFor({ state: "visible", timeout: WAIT_MS });
  } else {
    await waitFor(async () => (await dialog.innerText()).includes(expectedSnippet), { label: `preview content ${path.basename(absolutePath)}` });
  }
  log("preview_file", { path: absolutePath, snippet: expectedSnippet });
  const screenshotName = path.basename(absolutePath).replace(/[^A-Za-z0-9_.-]+/g, "_");
  await screenshot(`preview-${screenshotName}`);
  const close = dialog.locator('button[title^="关闭预览"]');
  await close.click();
  await dialog.waitFor({ state: "hidden", timeout: WAIT_MS }).catch(() => {});
  const remainingPanel = await visibleButton(page.getByRole("button", { name: "隐藏工具面板", exact: true }));
  if (remainingPanel) await remainingPanel.click();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function captureTurnEvidence(turn, expectedRelativePath, label) {
  const absolutePath = artifactPathFor(turn, expectedRelativePath);
  assert.ok(absolutePath, `${label} turn did not publish ${expectedRelativePath}`);
  const metadata = artifactRowFor(turn, expectedRelativePath);
  const bytes = await assertFile(absolutePath);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (metadata?.sha256) assert.equal(metadata.sha256, digest, `${label} manifest hash must match disk bytes`);
  result.observations[label] = {
    turn_id: turn.turn_id,
    path: absolutePath,
    size: bytes.length,
    sha256: digest,
    manifest: metadata,
  };
  return { absolutePath, metadata, bytes, digest };
}

async function assertReplacement(turn, oldPath, newPath, label) {
  const newAbsolute = artifactPathFor(turn, newPath);
  assert.ok(newAbsolute, `${label} replacement did not publish ${newPath}`);
  const oldAbsolute = path.isAbsolute(oldPath) ? oldPath : path.resolve(path.dirname(newAbsolute), oldPath);
  const row = artifactRowFor(turn, newPath);
  assert.equal(String(row?.replaces_path || ""), oldAbsolute, `${label} must record exact replaces_path`);
  assert.equal(String(row?.superseded_path || ""), oldAbsolute, `${label} must record superseded_path`);
  assert.ok(String(row?.superseded_archive_path || ""), `${label} must expose a private archive path`);
  await assertMissing(oldAbsolute);
  await assertFile(String(row.superseded_archive_path));
  await assertCurrentArtifactMap([newAbsolute], [oldAbsolute]);
  return { newAbsolute, oldAbsolute, row };
}

async function openNewWidthScreenshot(label, width) {
  try {
    await page.setViewportSize({ width, height: 900 });
    await screenshot(label);
  } catch (error) {
    log("viewport_screenshot_skipped", { label, width, error: errorText(error) });
  }
}

async function undoLatestTurn(expectedCurrentPath, expectedRestoredPath, label) {
  const turns = await getTurns();
  const undoable = turns.find((turn) => turn?.can_undo === true);
  assert.ok(undoable?.turn_id, `${label} expected one latest undoable turn`);
  assert.equal(turns.filter((turn) => turn?.can_undo === true).length, 1, `${label} expected exactly one undoable turn`);
  const undoButton = page.getByRole("button", { name: "撤回本轮修改", exact: true });
  await undoButton.waitFor({ state: "visible", timeout: WAIT_MS });
  const responsePromise = page.waitForResponse((response) => {
    try {
      return response.request().method() === "POST" && new URL(response.url()).pathname === "/api/session/turns/undo";
    } catch {
      return false;
    }
  }, { timeout: WAIT_MS });
  const [response] = await Promise.all([responsePromise, undoButton.click()]);
  assert.ok(response.ok(), `${label} undo request failed with HTTP ${response.status()}`);
  await waitFor(async () => !(await visibleButton(undoButton)), { label: `${label} undo UI completion` });
  await assertFile(expectedRestoredPath);
  await assertMissing(expectedCurrentPath);
  const map = await sessionArtifactMap();
  assert.equal(Object.prototype.hasOwnProperty.call(map, expectedRestoredPath), true, `${label} restored path missing from artifact map`);
  assert.equal(Object.prototype.hasOwnProperty.call(map, expectedCurrentPath), false, `${label} removed path remains in artifact map`);
  const after = await getTurns();
  assert.equal(after.filter((turn) => turn?.can_undo === true).length, 0, `${label} older turns must not remain undoable`);
  log("undo_latest_turn", { label, turn_id: undoable.turn_id, restored: expectedRestoredPath, removed: expectedCurrentPath });
  await screenshot(`undo-${label}`);
}

async function configureLoopbackProvider() {
  await apiRequest(`/api/config/providers/${encodeURIComponent(providerId)}`, {
    method: "PUT",
    body: {
      apiKey: "document-revision-e2e-fixture",
      baseUrl: fixture.baseUrl,
      model: fixture.model,
      models: [fixture.model],
      enabled: true,
      interface: "openai",
      displayName: "Document revision E2E loopback fixture",
    },
  });
  await apiRequest("/api/config/default-provider", { method: "PUT", body: { name: providerId } });
  await apiRequest("/api/config/active-model", { method: "PUT", body: { provider: providerId, model: fixture.model } });
  log("configure_loopback_provider", { provider: providerId, model: fixture.model, base_url: fixture.baseUrl });
}

async function restoreConfiguration() {
  if (!originalConfig) return;
  const oldProvider = originalConfig.providers?.[providerId];
  await apiRequest(`/api/config/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" }).catch(() => {});
  if (oldProvider && typeof oldProvider === "object") {
    await apiRequest(`/api/config/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      body: {
        apiKey: oldProvider.api_key,
        baseUrl: oldProvider.base_url,
        model: oldProvider.model,
        models: oldProvider.models,
        enabled: oldProvider.enabled,
        interface: oldProvider.interface,
        displayName: oldProvider.display_name,
      },
    }).catch(() => {});
  }
  await apiRequest("/api/config/default-provider", {
    method: "PUT",
    body: { name: String(originalConfig.defaultProvider || "") },
  }).catch(() => {});
  await apiRequest("/api/config/active-model", {
    method: "PUT",
    body: {
      provider: String(originalConfig.activeProvider || ""),
      model: String(originalConfig.activeModel || ""),
    },
  }).catch(() => {});
  log("restore_provider_configuration", {
    default_provider: String(originalConfig.defaultProvider || ""),
    active_provider: String(originalConfig.activeProvider || ""),
    active_model: String(originalConfig.activeModel || ""),
  });
}

async function reopenSessionAndAssertUndoClosed() {
  await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS }).catch(() => {});
  await refreshBridge();
  await ensureOrdinaryChat();
  // A persisted layout normally keeps the selected pane. If the renderer
  // reopened a different pane, select this run's real history row through its
  // public title/aria label before the next chat request.
  const historyRow = await visibleButton(
    page.locator('button[title*="E2E_DOC_MD_CREATE"], button[aria-label*="E2E_DOC_MD_CREATE"]'),
  );
  if (historyRow) {
    await historyRow.click();
    await getComposer();
    log("select_reopened_session_from_history", { marker: "E2E_DOC_MD_CREATE" });
  }
  await waitFor(async () => {
    const rows = await getTurns();
    return rows.every((turn) => turn?.can_undo !== true);
  }, { label: "reopened session with no older undo action" });
  assert.equal(await visibleButton(page.getByRole("button", { name: "撤回本轮修改", exact: true })), null, "reopened session must not show an older undo action");
  log("reopen_session_without_older_undo", { session_id: sessionId });
  await screenshot("reopened-no-undo");
}

async function runDocumentRevision() {
  await fs.mkdir(screenshotDir, { recursive: true });
  fixture = await createDocumentRevisionModelFixture({
    statePath: path.join(artifactDir, "document-revision-model-fixture.json"),
    paths,
  });
  result.fixture = {
    base_url: fixture.baseUrl,
    model: fixture.model,
    state_path: fixture.statePath,
  };

  browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 15_000 });
  page = await findRenderer();
  page.setDefaultTimeout(WAIT_MS);
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on("response", (response) => {
    try {
      const parsed = new URL(response.url());
      if (/^\/api\/session\/turns\/undo$/.test(parsed.pathname)) {
        result.responses.push({ method: response.request().method(), pathname: parsed.pathname, status: response.status() });
      }
    } catch {
      // Ignore non-HTTP renderer responses.
    }
  });
  await refreshBridge();
  originalConfig = (await apiRequest("/api/config/providers")).payload;
  await configureLoopbackProvider();
  await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS }).catch(() => {});
  await refreshBridge();
  await ensureOrdinaryChat({ newTopic: true });

  const mdCreateTurn = await sendTurn("E2E_DOC_MD_CREATE");
  const mdV1 = await captureTurnEvidence(mdCreateTurn, paths.mdV1, "md_create");
  const firstReplyText = await page.locator("body").innerText();
  assert.doesNotMatch(firstReplyText, /步骤执行失败|schema was not loaded and has been auto-loaded/u, "successful schema discovery must not surface as a failure or an internal English notice");
  await previewArtifact(mdV1.absolutePath, "Markdown revision one.");
  await openNewWidthScreenshot("md-card-narrow", 760);

  const mdRevisionTurn = await sendTurn("E2E_DOC_MD_REVISE");
  const mdV2 = await captureTurnEvidence(mdRevisionTurn, paths.mdV2, "md_revision");
  await assertReplacement(mdRevisionTurn, mdV1.absolutePath, mdV2.absolutePath, "md_revision");
  await previewArtifact(mdV2.absolutePath, "Markdown revision two replaces revision one.");
  await screenshot("md-revision-card");
  await undoLatestTurn(mdV2.absolutePath, mdV1.absolutePath, "md-rename");
  assert.deepEqual(await fs.readFile(mdV1.absolutePath), mdV1.bytes, "MD undo must restore the original bytes exactly");
  await reopenSessionAndAssertUndoClosed();

  const htmlCreateTurn = await sendTurn("E2E_DOC_HTML_CREATE");
  const htmlV1 = await captureTurnEvidence(htmlCreateTurn, paths.htmlV1, "html_create");
  assert.equal(turnArtifactRows(htmlCreateTurn).some((row) => /[\\/]memory[\\/]\d{4}-\d{2}-\d{2}\.md$/u.test(String(row?.path || row))), false, "automatic memory logs must not be document deliverables");
  await previewArtifact(htmlV1.absolutePath, "HTML revision one.");

  const htmlRevisionTurn = await sendTurn("E2E_DOC_HTML_REVISE");
  const htmlV2 = await captureTurnEvidence(htmlRevisionTurn, paths.htmlV2, "html_revision");
  await assertReplacement(htmlRevisionTurn, htmlV1.absolutePath, htmlV2.absolutePath, "html_revision");
  await previewArtifact(htmlV2.absolutePath, "HTML revision two replaces revision one.");

  const docxCreateTurn = await sendTurn("E2E_DOC_DOCX_CREATE");
  const docxV1 = await captureTurnEvidence(docxCreateTurn, paths.docxV1, "docx_create");
  assert.equal(docxV1.bytes.subarray(0, 4).toString("binary"), "PK\x03\x04", "DOCX output must be a ZIP package");
  await previewArtifact(docxV1.absolutePath, "DOCX revision one");

  const docxRevisionTurn = await sendTurn("E2E_DOC_DOCX_REVISE");
  const docxV2 = await captureTurnEvidence(docxRevisionTurn, paths.docxV2, "docx_revision");
  assert.equal(docxV2.bytes.subarray(0, 4).toString("binary"), "PK\x03\x04", "revised DOCX output must be a ZIP package");
  await assertReplacement(docxRevisionTurn, docxV1.absolutePath, docxV2.absolutePath, "docx_revision");
  await previewArtifact(docxV2.absolutePath, "DOCX revision two");
  await undoLatestTurn(docxV2.absolutePath, docxV1.absolutePath, "docx-rename");
  assert.deepEqual(await fs.readFile(docxV1.absolutePath), docxV1.bytes, "DOCX undo must restore the original bytes exactly");
  await reopenSessionAndAssertUndoClosed();
  await screenshot("document-cards-wide");

  const conflictTurn = await sendTurn("E2E_DOC_CONFLICT");
  const conflict = await captureTurnEvidence(conflictTurn, paths.conflict, "manual_conflict");
  const conflictReplacement = await assertReplacement(conflictTurn, mdV1.absolutePath, conflict.absolutePath, "manual_conflict");
  await fs.writeFile(conflict.absolutePath, "# Manual edit after agent revision\n", "utf8");
  const conflictPanel = await visibleButton(page.getByRole("button", { name: "隐藏工具面板", exact: true }));
  if (conflictPanel) await conflictPanel.click();
  const conflictUndoButton = page.getByRole("button", { name: "撤回本轮修改", exact: true });
  await conflictUndoButton.waitFor({ state: "visible", timeout: WAIT_MS });
  const conflictResponsePromise = page.waitForResponse((response) => {
    try {
      return response.request().method() === "POST" && new URL(response.url()).pathname === "/api/session/turns/undo";
    } catch {
      return false;
    }
  }, { timeout: WAIT_MS });
  const [conflictResponse] = await Promise.all([conflictResponsePromise, conflictUndoButton.click()]);
  assert.equal(conflictResponse.status(), 409, "manual edit must cause undo to return HTTP 409");
  await page.getByRole("alert").filter({ hasText: /无法撤回|发生变化|冲突|conflict/i }).waitFor({ state: "visible", timeout: WAIT_MS });
  assert.equal(await fs.readFile(conflict.absolutePath, "utf8"), "# Manual edit after agent revision\n", "conflicting manual bytes must remain intact");
  await assertMissing(conflictReplacement.oldAbsolute);
  result.observations.manual_conflict = {
    turn_id: conflictTurn.turn_id,
    path: conflict.absolutePath,
    response_status: conflictResponse.status(),
    file_preserved: true,
  };
  await screenshot("manual-conflict");

  const fixtureState = fixture.getState();
  const selectedTools = fixtureState.calls.map((call) => call.selected_tool).filter(Boolean);
  assert.ok(selectedTools.includes("document_generate"), "fixture must drive document_generate through AgentRuntime");
  assert.ok(selectedTools.includes("document_publish"), "fixture must drive document_publish through AgentRuntime");
  assert.ok(selectedTools.includes("bash_exec"), "fixture must drive bash_exec through AgentRuntime for DOCX");
  assert.ok(fixtureState.call_count <= 24, `fixture call count exceeded bounded E2E limit: ${fixtureState.call_count}`);
  result.observations.fixture = {
    call_count: fixtureState.call_count,
    selected_tools: selectedTools,
    calls: fixtureState.calls,
  };
  result.status = "passed";
}

async function finish() {
  result.finished_at = now();
  if (fixture) result.fixture_final = fixture.getState();
  await writeJson(path.join(artifactDir, "document-revision-e2e-results.json"), result);
}

try {
  await runDocumentRevision();
} catch (error) {
  result.status = "failed";
  result.failure = { message: errorText(error) };
  if (page && !page.isClosed()) {
    try { result.failure.ui = text(await page.locator("body").innerText({ timeout: 2_000 }), 4_000); } catch { /* renderer may have closed */ }
    await screenshot("failure");
  }
} finally {
  await restoreConfiguration().catch(() => {});
  await finish().catch((error) => process.stderr.write(`[document-revision-e2e] result_write_failed ${errorText(error)}\n`));
  if (fixture) await fixture.close().catch(() => {});
  if (browser) await browser.close({ reason: "document revision e2e finished" }).catch(() => {});
  process.exitCode = result.status === "passed" ? 0 : 1;
}
