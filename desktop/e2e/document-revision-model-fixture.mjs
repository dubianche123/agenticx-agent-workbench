#!/usr/bin/env node
/**
 * Loopback OpenAI-compatible model fixture for the document revision E2E.
 *
 * The fixture only controls model responses.  The Electron renderer still
 * sends ordinary chat requests, AgentRuntime still executes each tool, and
 * the resulting files are produced by the real document tools.  Responses
 * are selected from the latest user marker and the number of tool results in
 * that turn, which keeps the workflow deterministic without injecting a
 * manifest or a runtime result into the application.
 */

import crypto from "node:crypto";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MODEL = "document-revision-e2e-model";

function bounded(value, limit = 500) {
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

function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return "";
}

function toolResultsSinceLatestUser(messages) {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return messages.slice(lastUserIndex + 1).filter((message) =>
    message?.role === "tool"
    // Lazy tool discovery is an observation asking the model to retry the
    // same call; it is not a completed document/script operation.
    && !messageText(message).includes("schema was not loaded and has been auto-loaded")
  ).length;
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
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function responseEnvelope(callNumber, model) {
  return {
    id: `document-revision-e2e-${callNumber}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

function shellBase64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function docxWriteCommand(filePath, bodyText) {
  // Keep the command a real, authorized local script.  Base64 is used only
  // to make the model argument safe for the shell; Python's zipfile module
  // writes the actual minimal OOXML package to the session workspace.
  const path64 = shellBase64(filePath);
  const body64 = shellBase64(bodyText);
  const script = [
    "import base64, zipfile",
    `p=base64.b64decode('${path64}').decode('utf-8')`,
    `body=base64.b64decode('${body64}').decode('utf-8')`,
    "content_types='<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>'",
    "rels='<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>'",
    "document='<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>'+body+'</w:t></w:r></w:p><w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/></w:sectPr></w:body></w:document>'",
    "with zipfile.ZipFile(p, 'w', zipfile.ZIP_DEFLATED) as z:",
    " z.writestr('[Content_Types].xml', content_types)",
    " z.writestr('_rels/.rels', rels)",
    " z.writestr('word/document.xml', document)",
  ].join("\n");
  return `python3 -c \"import base64;exec(base64.b64decode('${shellBase64(script)}'))\"`;
}

function markerPlan(marker, toolCount, paths) {
  const p = paths;
  if (marker.includes("E2E_DOC_MD_CREATE")) {
    return toolCount === 0
      ? {
          name: "document_generate",
          arguments: {
            format: "md",
            title: "E2E Markdown revision v1",
            markdown: "# Document revision E2E\n\nMarkdown revision one.",
            output_path: p.mdV1,
          },
          reply: "已生成 Markdown 初始版本。",
        }
      : null;
  }
  if (marker.includes("E2E_DOC_MD_REVISE")) {
    return toolCount === 0
      ? {
          name: "document_generate",
          arguments: {
            format: "md",
            title: "E2E Markdown revision v2",
            markdown: "# Document revision E2E\n\nMarkdown revision two replaces revision one.",
            output_path: p.mdV2,
            replaces_path: p.mdV1,
          },
          reply: "已发布 Markdown 修订版本。",
        }
      : null;
  }
  if (marker.includes("E2E_DOC_HTML_CREATE")) {
    return toolCount === 0
      ? {
          name: "document_generate",
          arguments: {
            format: "html",
            title: "E2E HTML revision v1",
            markdown: "# HTML revision E2E\n\nHTML revision one.",
            output_path: p.htmlV1,
          },
          reply: "已生成 HTML 初始版本。",
        }
      : null;
  }
  if (marker.includes("E2E_DOC_HTML_REVISE")) {
    return toolCount === 0
      ? {
          name: "document_generate",
          arguments: {
            format: "html",
            title: "E2E HTML revision v2",
            markdown: "# HTML revision E2E\n\nHTML revision two replaces revision one.",
            output_path: p.htmlV2,
            replaces_path: p.htmlV1,
          },
          reply: "已发布 HTML 修订版本。",
        }
      : null;
  }
  if (marker.includes("E2E_DOC_DOCX_CREATE")) {
    if (toolCount === 0) {
      return {
        name: "bash_exec",
        arguments: { command: docxWriteCommand(p.docxV1, "DOCX revision one"), cwd: "." },
        reply: "已创建 DOCX 文件，准备登记发布。",
      };
    }
    if (toolCount === 1) {
      return {
        name: "document_publish",
        arguments: { path: p.docxV1, title: "E2E DOCX revision v1" },
        reply: "已发布 DOCX 初始版本。",
      };
    }
    return null;
  }
  if (marker.includes("E2E_DOC_DOCX_REVISE")) {
    if (toolCount === 0) {
      return {
        name: "bash_exec",
        arguments: { command: docxWriteCommand(p.docxV2, "DOCX revision two"), cwd: "." },
        reply: "已创建 DOCX 修订文件，准备登记发布。",
      };
    }
    if (toolCount === 1) {
      return {
        name: "document_publish",
        arguments: {
          path: p.docxV2,
          title: "E2E DOCX revision v2",
          replaces_path: p.docxV1,
        },
        reply: "已发布 DOCX 修订版本。",
      };
    }
    return null;
  }
  if (marker.includes("E2E_DOC_CONFLICT")) {
    return toolCount === 0
      ? {
          name: "document_generate",
          arguments: {
            format: "md",
            title: "E2E conflict revision",
            markdown: "# Document conflict E2E\n\nAgent revision before manual edit.",
            output_path: p.conflict,
            replaces_path: p.mdV1,
          },
          reply: "已生成待验证的冲突修订。",
        }
      : null;
  }
  return null;
}

export async function createDocumentRevisionModelFixture({
  host = "127.0.0.1",
  port = 0,
  statePath = "",
  model = DEFAULT_MODEL,
  paths = {},
} = {}) {
  if (host !== "127.0.0.1") throw new Error("document revision fixture must bind to 127.0.0.1");
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
        data: [{ id: model, object: "model", owned_by: "document-revision-e2e" }],
      });
      return;
    }
    if (req.method !== "POST" || requestUrl.pathname !== "/v1/chat/completions") {
      sendJson(res, 404, { error: { message: "document revision fixture route not found", type: "not_found" } });
      return;
    }
    try {
      const payload = await readJson(req);
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const userText = latestUserText(messages);
      const toolCount = toolResultsSinceLatestUser(messages);
      const joined = messages.map(messageText).join("\n");
      const plan = markerPlan(userText, toolCount, paths);
      const call = {
        at: new Date().toISOString(),
        model: bounded(payload?.model || model, 120),
        message_count: messages.length,
        prompt_chars: joined.length,
        prompt_sha256: crypto.createHash("sha256").update(joined, "utf8").digest("hex"),
        marker: bounded(userText, 160),
        tool_result_count: toolCount,
        selected_tool: plan?.name || "",
        requested_stream: payload?.stream === true,
      };
      calls.push(call);
      await persist();
      const requestedModel = bounded(payload?.model || model, 120);
      const envelope = responseEnvelope(calls.length, requestedModel);
      if (payload?.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
        if (plan) {
          emit({
            role: "assistant",
            content: null,
            tool_calls: [{
              index: 0,
              id: `document-revision-call-${calls.length}`,
              type: "function",
              function: { name: plan.name, arguments: JSON.stringify(plan.arguments) },
            }],
          });
          emit({}, "tool_calls");
        } else {
          const reply = markerPlan(userText, toolCount, paths)?.reply
            || (userText ? "已完成本轮文档操作。" : "就绪。");
          emit({ role: "assistant", content: "" });
          for (let offset = 0; offset < reply.length; offset += 80) {
            emit({ content: reply.slice(offset, offset + 80) });
          }
          emit({}, "stop");
        }
        res.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [],
          usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
        })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      if (plan) {
        sendJson(res, 200, {
          id: envelope.id,
          object: "chat.completion",
          created: envelope.created,
          model: requestedModel,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `document-revision-call-${calls.length}`,
                type: "function",
                function: { name: plan.name, arguments: JSON.stringify(plan.arguments) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
        });
        return;
      }
      const reply = userText ? "已完成本轮文档操作。" : "就绪。";
      sendJson(res, 200, {
        id: envelope.id,
        object: "chat.completion",
        created: envelope.created,
        model: requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
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
    throw new Error("document revision fixture did not expose a loopback address");
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
  const fixture = await createDocumentRevisionModelFixture({
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
