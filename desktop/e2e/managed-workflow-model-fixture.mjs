#!/usr/bin/env node
/**
 * Loopback-only OpenAI-compatible model fixture for managed Workflow E2E.
 *
 * This fixture is deliberately outside the Workflow API: the acceptance run
 * configures it as an ordinary OpenAI-compatible provider, so the real
 * ProviderResolver, AgentRuntime and WorkflowExecutor make the model call.
 * It records bounded request facts only and returns one deterministic report.
 */

import crypto from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL = "managed-e2e-model";
const DEFAULT_RESPONSE = `# 虚构部门用量分析报告

> 数据来源：fictional_demo（仅用于演示，不代表真实租户计费数据）。

## 部门汇总

| 部门 | 请求数 | 总 Token |
| --- | ---: | ---: |
| 演示研发部 | 76 | 383000 |
| 演示运营部 | 21 | 111000 |

## 观察与建议

演示研发部的示例请求量和 Token 总量较高。建议在下一个虚构期间继续按模型和部门复核资源使用，并由负责人在写入报告前确认数据来源。`;

function bounded(value, limit = 400) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    return typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > MAX_REQUEST_BYTES) {
        req.destroy();
        reject(new Error("fixture request exceeds 2 MiB"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(new Error(`fixture request is not JSON: ${error.message}`));
      }
    });
    req.once("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

export async function createManagedWorkflowModelFixture({
  host = "127.0.0.1",
  port = 0,
  statePath = "",
  model = DEFAULT_MODEL,
  responseText = DEFAULT_RESPONSE,
} = {}) {
  if (host !== "127.0.0.1") throw new Error("managed model fixture must bind to 127.0.0.1");
  const calls = [];
  let server;
  let closed = false;

  const persist = async () => {
    if (!statePath) return;
    await fs.writeFile(statePath, `${JSON.stringify({ call_count: calls.length, calls }, null, 2)}\n`, "utf8");
  };

  server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${host}`);
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, { ok: true, call_count: calls.length });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [{ id: model, object: "model", owned_by: "managed-e2e-fixture" }],
      });
      return;
    }
    if (req.method !== "POST" || requestUrl.pathname !== "/v1/chat/completions") {
      sendJson(res, 404, { error: { message: "managed fixture route not found", type: "not_found" } });
      return;
    }
    try {
      const payload = await readJson(req);
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const joined = messages.map(messageText).join("\n");
      const digest = crypto.createHash("sha256").update(joined, "utf8").digest("hex");
      const call = {
        at: new Date().toISOString(),
        model: bounded(payload?.model, 120),
        message_count: messages.length,
        prompt_chars: joined.length,
        prompt_sha256: digest,
        contains_fictional_dataset: /fictional_demo|虚构|演示研发部|dataset_label/i.test(joined),
        requested_stream: payload?.stream === true,
      };
      calls.push(call);
      await persist();
      const requestedModel = bounded(payload?.model || model, 120);
      if (payload?.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const envelope = {
          id: `managed-e2e-${calls.length}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
        };
        const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
        emit({ role: "assistant", content: "" });
        for (let offset = 0; offset < responseText.length; offset += 80) {
          emit({ content: responseText.slice(offset, offset + 80) });
        }
        emit({}, "stop");
        res.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [],
          usage: { prompt_tokens: 128, completion_tokens: 160, total_tokens: 288 },
        })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      sendJson(res, 200, {
        id: `managed-e2e-${calls.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{
          index: 0,
          message: { role: "assistant", content: responseText },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 128, completion_tokens: 160, total_tokens: 288 },
      });
    } catch (error) {
      sendJson(res, 400, { error: { message: bounded(error?.message || error), type: "invalid_request_error" } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("managed fixture did not expose a loopback address");
  }
  await persist();
  return {
    host,
    port: address.port,
    model,
    baseUrl: `http://${host}:${address.port}/v1`,
    statePath,
    getState: () => ({ call_count: calls.length, calls: calls.map((call) => ({ ...call })) }),
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function cliOption(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const statePath = cliOption("--state");
  const fixture = await createManagedWorkflowModelFixture({
    port: Number(cliOption("--port", "0")) || 0,
    statePath,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, base_url: fixture.baseUrl, model: fixture.model, state_path: statePath })}\n`);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
