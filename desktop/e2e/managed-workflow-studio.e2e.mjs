#!/usr/bin/env node
/**
 * Managed Workflow acceptance against the real Electron renderer.
 *
 * The script attaches to the Electron started by `npm run dev` through its
 * opted-in CDP port. It creates the built-in template through the UI, uses a
 * loopback OpenAI-compatible provider through the normal ProviderResolver /
 * AgentRuntime path, approves through the UI, and verifies the authenticated
 * document renderer's MD/HTML files. It never mocks a Workflow route or
 * reports a node result directly.
 *
 * Recommended isolated invocation (fresh profile starts with no model):
 *
 *   AGX_DEV_DEBUG_PORT=9337 \
 *   AGX_E2E_ARTIFACT_DIR=/private/tmp/managed-workflow-e2e \
 *   node e2e/managed-workflow-studio.e2e.mjs
 *
 * Set AGX_E2E_MANAGED_RECOVERY=0 when the isolated profile already has a
 * selected model. The default recovery path intentionally observes the real
 * agent_model_unavailable block, configures the loopback provider, binds that
 * provider to the original session through the existing model-selection IPC,
 * and retries the original node.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";
import { createManagedWorkflowModelFixture } from "./managed-workflow-model-fixture.mjs";

const WAIT_MS = 60_000;
const POLL_MS = 250;
const POLL_GRACE_AFTER_CLOSE_MS = 2_600;
const runTag = `managed-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const artifactDir = path.resolve(
  String(process.env.AGX_E2E_ARTIFACT_DIR || "").trim() ||
    path.join(os.tmpdir(), `agenticx-${runTag}`),
);
const screenshotDir = path.join(artifactDir, "screenshots");
const cdpEndpoint = String(process.env.AGX_E2E_CDP_URL || "").trim() || (() => {
  const raw = String(process.env.AGX_DEV_DEBUG_PORT || "").trim();
  if (!/^\d+$/.test(raw)) throw new Error("AGX_DEV_DEBUG_PORT or AGX_E2E_CDP_URL is required");
  return `http://127.0.0.1:${Number(raw)}`;
})();
const recoveryRequested = process.env.AGX_E2E_MANAGED_RECOVERY !== "0";
const providerId = `managed-e2e-loopback-${process.pid}`;

const result = {
  status: "started",
  started_at: new Date().toISOString(),
  finished_at: null,
  artifact_dir: artifactDir,
  cdp_endpoint: cdpEndpoint,
  profile_mode: recoveryRequested ? "missing-model-recovery" : "preconfigured-model",
  provider_id: providerId,
  fixture: null,
  steps: [],
  screenshots: {},
  observations: {},
  request_sampling: { workflow_run_gets: [] },
  coverage_limits: {
    rejection: "optional AGX_E2E_MANAGED_REJECT=1 runs the real Agent task and rejects its Approval gate before document execution",
    cancellation: "optional AGX_E2E_MANAGED_CANCEL=1 case; disabled by default to preserve one-call report evidence",
    missing_connector: "the template intentionally has no Connector node; unavailable connector copy is covered by panel code and connector catalog acceptance",
    executor_resource_leak: "not asserted here; managed session lifecycle evidence is tracked separately",
  },
  failure: null,
};

let browser = null;
let page = null;
let fixture = null;
let apiBase = "";
let apiToken = "";
let originalConfig = null;
let requestPhase = "before-run";

function now() {
  return new Date().toISOString();
}

function text(value, limit = 1_000) {
  const raw = String(value ?? "");
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function errorText(error) {
  return text(error instanceof Error ? error.message : error);
}

function log(name, details = {}) {
  const row = { at: now(), name, ...details };
  result.steps.push(row);
  process.stdout.write(`[managed-workflow-e2e] ${name}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}\n`);
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
  const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : payload.detail;
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
    try { payload = JSON.parse(raw); } catch { payload = { text: raw.slice(0, 500) }; }
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
          // Splash/devtools pages may disappear during startup.
        }
      }
    }
    return null;
  }, { timeout: WAIT_MS, label: "Electron renderer preload bridge" });
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

function unwrapRun(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const run = root.run && typeof root.run === "object" ? root.run : root;
  return { ...run, execution: root.execution ?? run.execution, approvals: root.approvals ?? run.approvals };
}

function unwrapApprovals(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const run = unwrapRun(root);
  return Array.isArray(root.approvals) ? root.approvals : Array.isArray(run.approvals) ? run.approvals : [];
}

function runNodes(run) {
  return Object.values(run?.nodes && typeof run.nodes === "object" ? run.nodes : {});
}

function nodeById(run, id) {
  return run?.nodes && typeof run.nodes === "object" ? run.nodes[id] : null;
}

function nodeCode(node) {
  return String(node?.meta?.workflow_error_code || node?.meta?.error_code || "").trim();
}

function nodeKind(node) {
  return String(node?.meta?.workflow_node_kind || node?.kind || "").trim();
}

function artifactPath(ref) {
  if (typeof ref === "string") return ref.trim();
  if (!ref || typeof ref !== "object") return "";
  return String(ref.path_or_uri || ref.path || "").trim();
}

function runArtifacts(run) {
  const candidates = [
    ...(Array.isArray(run?.artifacts) ? run.artifacts : []),
    ...runNodes(run).flatMap((node) => Array.isArray(node.meta?.workflow_artifacts) ? node.meta.workflow_artifacts : []),
  ];
  return [...new Map(candidates.map((ref) => [artifactPath(ref), ref]).filter(([filePath]) => filePath)).values()];
}

async function getRun(runId, sessionId) {
  const response = await apiRequest(`/api/workflow-runs/${encodeURIComponent(runId)}?session_id=${encodeURIComponent(sessionId)}`);
  return { payload: response.payload, run: unwrapRun(response.payload), approvals: unwrapApprovals(response.payload) };
}

async function waitForRun(runId, sessionId, predicate, label) {
  return waitFor(async () => {
    const current = await getRun(runId, sessionId);
    return predicate(current) ? current : false;
  }, { label });
}

async function visibleButton(name) {
  const buttons = page.getByRole("button", { name, exact: true });
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    if (await button.isVisible()) return button;
  }
  return null;
}

async function openWorkflow() {
  if (await page.getByTestId("workflow-studio").count() === 0) {
    const button = await visibleButton("工作流");
    assert.ok(button, "工作流 navigation is unavailable");
    await button.click();
  }
  await page.getByTestId("workflow-studio").waitFor({ state: "visible", timeout: WAIT_MS });
  await waitFor(async () => (
    await page.getByTestId("workflow-canvas").count() > 0 ||
    await page.getByRole("button", { name: "创建工作流", exact: true }).count() > 0
  ), { label: "Workflow Studio document surface" });
}

async function fillTemplateField(dialog, label, value) {
  const labels = dialog.locator("label");
  for (let index = 0; index < await labels.count(); index += 1) {
    const item = labels.nth(index);
    if (!String(await item.textContent() || "").trim().startsWith(label)) continue;
    const control = item.locator("input, textarea, select").first();
    await control.fill(value);
    return;
  }
  throw new Error(`template field ${label} is unavailable`);
}

async function createTemplateThroughUi() {
  let button = await visibleButton(/^从模板创建(?:工作流)?$/);
  if (!button) {
    const listButton = await visibleButton("列表");
    assert.ok(listButton, "Workflow list drawer is unavailable while template creation is hidden");
    await listButton.click();
    button = await waitFor(() => visibleButton(/^从模板创建(?:工作流)?$/), { label: "从模板创建 inside the Workflow list drawer" });
  }
  assert.ok(button, "从模板创建 is unavailable");
  await button.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: WAIT_MS });
  const title = `Managed Workflow acceptance ${runTag}`;
  await fillTemplateField(dialog, "工作流名称", title);
  await fillTemplateField(dialog, "虚构数据集名称", `2026 Q3 managed fictional dataset ${runTag}`);
  await fillTemplateField(dialog, "报告文件名", `managed-${runTag}`);
  await dialog.getByRole("button", { name: "创建模板草稿", exact: true }).click();
  await page.locator('[role="status"]').filter({ hasText: "已从模板创建独立草稿" }).waitFor({ state: "visible", timeout: WAIT_MS });
  const closeList = await visibleButton("关闭工作流列表");
  if (closeList) await closeList.click();
  log("create_template_from_ui", { title });
  return { title };
}

async function findManifest(title) {
  const response = await apiRequest("/api/workflows");
  const rows = Array.isArray(response.payload?.workflows) ? response.payload.workflows : [];
  const manifest = rows.find((item) => String(item?.title || "") === title);
  assert.ok(manifest, `template manifest ${title} was not returned by the API`);
  return manifest;
}

async function saveAndPublish(title) {
  const save = page.getByRole("button", { name: "保存", exact: true });
  if (await save.isEnabled()) {
    await save.click();
    await page.locator('[role="status"]').filter({ hasText: "已保存版本" }).waitFor({ state: "visible", timeout: WAIT_MS });
  } else {
    const draft = await findManifest(title);
    assert.ok(draft.head_revision > 0, "template draft must already be persisted");
    log("template_draft_already_saved", { revision: draft.head_revision });
  }
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await page.locator('[role="status"]').filter({ hasText: "已发布版本" }).waitFor({ state: "visible", timeout: WAIT_MS });
  const manifest = await findManifest(title);
  assert.ok(Number(manifest.active_published_revision) > 0, "template publish did not set an active revision");
  log("save_and_publish_template", { workflow_id: manifest.workflow_id, revision: manifest.active_published_revision });
  return manifest;
}

async function configureLoopbackProvider() {
  await apiRequest(`/api/config/providers/${encodeURIComponent(providerId)}`, {
    method: "PUT",
    body: {
      apiKey: "managed-e2e-fixture",
      baseUrl: fixture.baseUrl,
      model: fixture.model,
      models: [fixture.model],
      enabled: true,
      interface: "openai",
      displayName: "Managed E2E loopback fixture",
    },
  });
  await apiRequest("/api/config/default-provider", { method: "PUT", body: { name: providerId } });
  await apiRequest("/api/config/active-model", { method: "PUT", body: { provider: providerId, model: fixture.model } });
  log("configure_loopback_provider", { provider: providerId, model: fixture.model, base_url: fixture.baseUrl });
}

async function clearGlobalModelSelection() {
  await apiRequest("/api/config/default-provider", { method: "PUT", body: { name: "" } });
  await apiRequest("/api/config/active-model", { method: "PUT", body: { provider: "", model: "" } });
  log("clear_model_selection_for_recovery");
}

async function bindSessionToLoopback(sessionId) {
  const outcome = await page.evaluate(async ({ sessionId: sid, provider, model }) => {
    if (typeof window.agenticxDesktop?.setSessionModel !== "function") {
      return { ok: false, error: "setSessionModel preload method is unavailable" };
    }
    return window.agenticxDesktop.setSessionModel({ sessionId: sid, provider, model });
  }, { sessionId, provider: providerId, model: fixture.model });
  assert.ok(outcome?.ok, `existing model selection path could not bind the workflow session: ${outcome?.error || "unknown error"}`);
  log("bind_original_run_session_model", { session_id: sessionId, provider: providerId, model: fixture.model });
}

async function createRunThroughUi(workflowId, revision) {
  const button = page.getByRole("button", { name: "创建运行", exact: true });
  await button.waitFor({ state: "visible", timeout: WAIT_MS });
  assert.equal(await button.isEnabled(), true, "published template run button must be enabled");
  const responsePromise = page.waitForResponse((response) => {
    try {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/workflows/${encodeURIComponent(workflowId)}/runs`;
    } catch {
      return false;
    }
  }, { timeout: WAIT_MS });
  requestPhase = "run-open";
  const [response] = await Promise.all([responsePromise, button.click()]);
  assert.ok(response.status() >= 200 && response.status() < 300, `UI run request failed with HTTP ${response.status()}`);
  const payload = await response.json();
  const run = unwrapRun(payload);
  const runId = String(run.run_id || "").trim();
  const sessionId = String(run.session_id || payload.session_id || "").trim();
  assert.ok(runId, "run response did not contain a run ID");
  assert.ok(sessionId, "run response did not contain a session ID");
  const panel = page.getByTestId("workflow-run-panel");
  await panel.waitFor({ state: "visible", timeout: WAIT_MS });
  log("create_run_from_ui", { run_id: runId, session_id: sessionId, initial_execution: payload.execution?.state || "" });
  return { runId, sessionId, panel, initial: { payload, run } };
}

async function assertNoFilesBeforeApproval(sessionId, run) {
  const refs = runArtifacts(run);
  assert.equal(refs.length, 0, "run must not expose artifacts before approval");
  const sessionArtifacts = await apiRequest(`/api/artifacts?session_id=${encodeURIComponent(sessionId)}`);
  const map = sessionArtifacts.payload?.artifacts && typeof sessionArtifacts.payload.artifacts === "object"
    ? sessionArtifacts.payload.artifacts
    : {};
  assert.equal(Object.keys(map).length, 0, "session artifact store must be empty before approval");
  result.observations.files_before_approval = { run_artifact_count: refs.length, session_artifact_count: Object.keys(map).length };
}

async function runManagedExecution(workflow, runContext) {
  const { runId, sessionId, panel } = runContext;
  let current = await waitForRun(
    runId,
    sessionId,
    ({ run, approvals }) => (
      runNodes(run).some((node) => nodeCode(node) === "agent_model_unavailable")
      || runNodes(run).some((node) => nodeKind(node) === "agent_task" && !node.meta?.workflow_config?.artifact_contract && node.status === "done")
      || approvals.some((approval) => String(approval.status || "").toLowerCase() === "pending")
    ),
    "durable model feedback or analysis completion",
  );

  if (runNodes(current.run).some((node) => nodeCode(node) === "agent_model_unavailable")) {
    assert.equal(current.run.execution?.state, "blocked", "missing model must be a blocked execution state");
    await panel.getByTestId("workflow-model-guidance").waitFor({ state: "visible", timeout: WAIT_MS });
    await screenshot("managed-model-blocked");
    result.observations.model_block = {
      execution_state: current.run.execution?.state,
      node_ids: runNodes(current.run).filter((node) => nodeCode(node) === "agent_model_unavailable").map((node) => node.id),
    };
    await assertNoFilesBeforeApproval(sessionId, current.run);
    await configureLoopbackProvider();
    await bindSessionToLoopback(sessionId);
    const blockedNode = runNodes(current.run).find((node) => nodeCode(node) === "agent_model_unavailable");
    assert.ok(blockedNode?.id, "model-unavailable response did not identify a retryable node");
    const retryButton = panel.getByTestId(`workflow-retry-node-${blockedNode.id}`);
    await retryButton.waitFor({ state: "visible", timeout: WAIT_MS });
    await retryButton.click();
    log("retry_original_blocked_analysis_node");
  } else {
    // Preconfigured mode still uses the same real executor path. If a stale
    // pane session has no model, recover it rather than silently changing runs.
    current = await getRun(runId, sessionId);
    if (runNodes(current.run).some((node) => nodeCode(node) === "agent_model_unavailable")) {
      await configureLoopbackProvider();
      await bindSessionToLoopback(sessionId);
      const blockedNode = runNodes(current.run).find((node) => nodeCode(node) === "agent_model_unavailable");
      const retryButton = panel.getByTestId(`workflow-retry-node-${blockedNode.id}`);
      await retryButton.waitFor({ state: "visible", timeout: WAIT_MS });
      await retryButton.click();
    }
  }

  current = await waitForRun(
    runId,
    sessionId,
    ({ run, approvals }) => {
      const analysis = runNodes(run).find((node) => nodeKind(node) === "agent_task" && !node.meta?.workflow_config?.artifact_contract);
      return analysis?.status === "done" && approvals.some((approval) => String(approval.status || "").toLowerCase() === "pending");
    },
    "analysis completion and durable approval gate",
  );
  const analysisNode = runNodes(current.run).find((node) => nodeKind(node) === "agent_task" && !node.meta?.workflow_config?.artifact_contract);
  const approval = current.approvals.find((item) => String(item.status || "").toLowerCase() === "pending");
  assert.ok(analysisNode && approval, "analysis output or approval gate was not returned");
  const approvedDraft = String(analysisNode.meta?.workflow_output_summary || "");
  assert.match(approvedDraft, /fictional_demo|虚构/, "analysis output must preserve fictional-data provenance");
  assert.match(approvedDraft, /383000/, "analysis output must contain the controlled department total");
  await assertNoFilesBeforeApproval(sessionId, current.run);
  await screenshot("managed-approval-pending");

  const approveButton = panel.getByRole("button", { name: "批准", exact: true });
  await approveButton.waitFor({ state: "visible", timeout: WAIT_MS });
  await approveButton.click();
  current = await waitForRun(
    runId,
    sessionId,
    ({ approvals }) => approvals.some((item) => String(item.approval_id) === String(approval.approval_id) && String(item.status || "").toLowerCase() === "approved"),
    "approval decision to persist",
  );
  await screenshot("managed-approval-approved");
  const resumeButton = panel.getByRole("button", { name: "继续运行", exact: true });
  await resumeButton.waitFor({ state: "visible", timeout: WAIT_MS });
  await resumeButton.click();
  current = await waitForRun(
    runId,
    sessionId,
    ({ run }) => run.execution?.state === "completed" && runNodes(run).some((node) => nodeKind(node) === "end" && node.status === "done"),
    "managed execution completion after approval",
  );
  await panel.getByTestId("workflow-execution-state").filter({ hasText: "已完成" }).waitFor({ state: "visible", timeout: WAIT_MS });
  await screenshot("managed-completed");

  const fixtureState = fixture.getState();
  assert.equal(fixtureState.call_count, 1, "approved report must use exactly one model call");
  assert.equal(fixtureState.calls[0]?.contains_fictional_dataset, true, "the AgentRuntime prompt must contain the fictional dataset");
  const artifacts = runArtifacts(current.run)
    .map((ref) => ({ ref, path: artifactPath(ref) }))
    .filter((item) => item.path);
  const md = artifacts.find((item) => item.path.toLowerCase().endsWith(".md"));
  const html = artifacts.find((item) => item.path.toLowerCase().endsWith(".html"));
  assert.ok(md && html, "completed run must expose both MD and HTML artifact paths");
  const mdText = await fs.readFile(md.path, "utf8");
  const htmlText = await fs.readFile(html.path, "utf8");
  assert.equal(mdText, approvedDraft, "MD must be byte-for-byte equal to the approved draft");
  assert.match(htmlText, /<h1\b/i, "HTML must contain a rendered heading");
  assert.match(htmlText, /<table\b/i, "HTML must contain a rendered table");
  assert.doesNotMatch(htmlText, /<pre\b/i, "HTML must not wrap the Markdown as a raw preformatted block");
  result.observations.completed_run = {
    run_id: runId,
    session_id: sessionId,
    execution_state: current.run.execution?.state,
    version: current.run.execution?.version,
    approval_id: approval.approval_id,
    approved_draft_chars: approvedDraft.length,
    artifact_paths: [md.path, html.path],
    html_rendered_structure: { heading: true, table: true, raw_pre: false },
    model_calls: fixtureState.call_count,
    fictional_input_confirmed: fixtureState.calls[0].contains_fictional_dataset,
  };
  log("verify_approved_md_html_artifacts", result.observations.completed_run);
  return { ...current, runId, sessionId, panel, analysisNode, approvedDraft, artifacts: { md, html } };
}

async function assertPanelStopsPolling(runContext) {
  const { panel } = runContext;
  const before = result.request_sampling.workflow_run_gets.length;
  await panel.getByRole("button", { name: "关闭运行预览", exact: true }).click();
  await page.getByRole("button", { name: "打开运行预览", exact: true }).waitFor({ state: "visible", timeout: WAIT_MS });
  const closeAt = Date.now();
  await sleep(POLL_GRACE_AFTER_CLOSE_MS);
  const afterRows = result.request_sampling.workflow_run_gets.slice(before).filter((row) => row.at_ms >= closeAt);
  assert.equal(afterRows.length, 0, "closing the panel must stop UI run reads while the backend remains independent");
  const reopen = page.getByRole("button", { name: "打开运行预览", exact: true });
  await reopen.click();
  const reopened = page.getByTestId("workflow-run-panel");
  await reopened.waitFor({ state: "visible", timeout: WAIT_MS });
  await reopened.getByTestId("workflow-execution-state").filter({ hasText: "已完成" }).waitFor({ state: "visible", timeout: WAIT_MS });
  await screenshot("managed-reopened-completed");
  result.observations.poll_cleanup = {
    reads_before_close: before,
    reads_after_close: afterRows.length,
    wait_ms: POLL_GRACE_AFTER_CLOSE_MS,
  };
  log("close_reopen_poll_cleanup", result.observations.poll_cleanup);
}

async function optionalCancelCase(workflowId, revision, sessionId) {
  if (process.env.AGX_E2E_MANAGED_CANCEL !== "1") return;
  const createButton = page.getByRole("button", { name: "创建运行", exact: true });
  await createButton.waitFor({ state: "visible", timeout: WAIT_MS });
  const createResponsePromise = page.waitForResponse((response) => {
    try {
      return response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/workflows/${encodeURIComponent(workflowId)}/runs`;
    } catch {
      return false;
    }
  });
  const [createResponse] = await Promise.all([createResponsePromise, createButton.click()]);
  const run = unwrapRun(await createResponse.json());
  const runId = String(run.run_id || "");
  assert.ok(runId, "optional cancellation run did not return an ID");
  const panel = page.getByTestId("workflow-run-panel");
  await panel.waitFor({ state: "visible", timeout: WAIT_MS });
  const cancelButton = panel.getByRole("button", { name: "取消运行", exact: true });
  await cancelButton.waitFor({ state: "visible", timeout: WAIT_MS });
  let cancellationAccepted = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/workflow-runs/${runId}/cancel`);
    const [response] = await Promise.all([responsePromise, cancelButton.click()]);
    if (response.ok()) {
      cancellationAccepted = true;
      break;
    }
    assert.equal(response.status(), 409, "only a concurrent-version conflict may require another cancellation click");
    await panel.getByText("状态已更新，请根据当前状态继续操作。", { exact: true }).waitFor({ state: "visible", timeout: WAIT_MS });
    await sleep(100);
  }
  assert.equal(cancellationAccepted, true, "cancellation must be accepted after the UI refreshes concurrent versions");
  const cancelled = await waitForRun(runId, sessionId, ({ run: latest }) => latest.execution?.state === "cancelled", "cancelled managed run");
  result.observations.cancellation = { run_id: runId, execution_state: cancelled.run.execution?.state };
  log("optional_cancel_case", result.observations.cancellation);
}

async function optionalRejectCase(workflowId, revision, completed) {
  if (process.env.AGX_E2E_MANAGED_REJECT !== "1") return;
  const originalFiles = await Promise.all(Object.values(completed.artifacts).map(async (artifact) => ({
    path: artifact.path,
    bytes: await fs.readFile(artifact.path),
    mtime: (await fs.stat(artifact.path)).mtimeMs,
  })));
  const { runId, sessionId, panel } = await createRunThroughUi(workflowId, revision);
  const pending = await waitForRun(runId, sessionId,
    ({ approvals }) => approvals.some((approval) => approval.status === "pending"),
    "real analysis awaiting rejection");
  assert.equal(runArtifacts(pending.run).length, 0, "the new run must have no files before rejection");
  await panel.getByRole("button", { name: "拒绝", exact: true }).click();
  const rejected = await waitForRun(runId, sessionId,
    ({ run, approvals }) => run.execution?.state === "failed"
      && approvals.some((approval) => approval.status === "rejected"),
    "rejected Approval gate stopping its run");
  await sleep(350);
  assert.equal(runArtifacts(rejected.run).length, 0, "rejected run must not publish artifacts");
  for (const file of originalFiles) {
    assert.deepEqual(await fs.readFile(file.path), file.bytes, "rejected run must not replace an earlier report");
    assert.equal((await fs.stat(file.path)).mtimeMs, file.mtime, "rejected run must not rewrite the same report bytes");
  }
  result.observations.rejection = { run_id: runId, execution_state: rejected.run.execution?.state, artifact_count: 0 };
  await screenshot("managed-approval-rejected");
  log("optional_reject_case", result.observations.rejection);
}

async function restoreConfiguration() {
  if (!originalConfig) return;
  await apiRequest(`/api/config/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" }).catch(() => {});
  await apiRequest("/api/config/default-provider", { method: "PUT", body: { name: String(originalConfig.defaultProvider || "") } }).catch(() => {});
  await apiRequest("/api/config/active-model", {
    method: "PUT",
    body: {
      provider: String(originalConfig.activeProvider || ""),
      model: String(originalConfig.activeModel || ""),
    },
  }).catch(() => {});
}

async function run() {
  await fs.mkdir(screenshotDir, { recursive: true });
  fixture = await createManagedWorkflowModelFixture({ statePath: path.join(artifactDir, "model-fixture.json") });
  result.fixture = { base_url: fixture.baseUrl, model: fixture.model, state_path: fixture.statePath };
  browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 15_000 });
  page = await findRenderer();
  page.setDefaultTimeout(WAIT_MS);
  page.on("request", (request) => {
    let parsed;
    try { parsed = new URL(request.url()); } catch { return; }
    if (request.method() === "GET" && /^\/api\/workflow-runs\/[^/]+$/.test(parsed.pathname)) {
      result.request_sampling.workflow_run_gets.push({ at_ms: Date.now(), at: now(), phase: requestPhase, pathname: parsed.pathname });
    }
  });
  await refreshBridge();
  originalConfig = (await apiRequest("/api/config/providers")).payload;
  if (recoveryRequested) {
    await clearGlobalModelSelection();
    await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS }).catch(() => {});
    await refreshBridge();
  } else {
    await configureLoopbackProvider();
    await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS }).catch(() => {});
    await refreshBridge();
  }
  await openWorkflow();
  const template = await createTemplateThroughUi();
  const manifest = await saveAndPublish(template.title);
  const workflowResponse = await apiRequest(`/api/workflows/${encodeURIComponent(manifest.workflow_id)}`);
  const snapshot = workflowResponse.payload?.snapshot || workflowResponse.payload?.workflow;
  assert.ok(snapshot && Array.isArray(snapshot.nodes), "published template snapshot is unavailable");
  const analysisDefinition = snapshot.nodes.find((node) => node.kind === "agent_task" && !node.config?.artifact_contract);
  assert.ok(analysisDefinition?.id, "template analysis Agent node is unavailable");
  const runContext = await createRunThroughUi(manifest.workflow_id, manifest.active_published_revision);
  const completed = await runManagedExecution({ manifest, snapshot, analysisDefinition }, runContext);
  await assertPanelStopsPolling(completed);
  await optionalRejectCase(manifest.workflow_id, manifest.active_published_revision, completed);
  await optionalCancelCase(manifest.workflow_id, manifest.active_published_revision, completed.sessionId);
  result.observations.template = {
    workflow_id: manifest.workflow_id,
    published_revision: manifest.active_published_revision,
    analysis_node_id: analysisDefinition.id,
    independent_draft: true,
  };
  result.status = "passed";
}

async function finish() {
  result.finished_at = now();
  if (fixture) result.fixture_final = fixture.getState();
  await writeJson(path.join(artifactDir, "managed-workflow-e2e-results.json"), result);
}

try {
  await run();
} catch (error) {
  result.status = "failed";
  result.failure = { message: errorText(error) };
  if (page && !page.isClosed()) {
    try { result.failure.ui = text(await page.locator("body").innerText({ timeout: 2_000 }), 3_000); } catch { /* renderer may have closed */ }
    await screenshot("failure");
  }
} finally {
  await restoreConfiguration().catch(() => {});
  await finish().catch((error) => process.stderr.write(`[managed-workflow-e2e] result_write_failed ${errorText(error)}\n`));
  if (fixture) await fixture.close().catch(() => {});
  if (browser) await browser.close({ reason: "managed workflow e2e finished" }).catch(() => {});
  process.exitCode = result.status === "passed" ? 0 : 1;
}
