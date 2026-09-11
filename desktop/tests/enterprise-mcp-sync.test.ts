import { describe, expect, it, vi } from "vitest";

import {
  ENTERPRISE_MCP_SYNC_ERROR_CODES,
  confirmEnterpriseMcpReadBack,
  readEnterpriseMcpDocument,
  writeEnterpriseMcpDocument,
  writeEnterpriseMcpDocumentAndConfirm,
  type EnterpriseMcpFetch,
} from "../electron/enterprise-mcp-sync";

const endpoint = "http://127.0.0.1:43123/api/mcp/raw";
const configPath = "~/.agenticx/mcp.json";

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mcpDocument(overrides: Record<string, unknown> = {}) {
  return {
    other: { command: "local-mcp" },
    mcpServers: {
      "enterprise-market": {
        headers: { Authorization: "Bearer token" },
        transport: "streamable_http",
        url: "https://gateway.example.invalid/mcp",
      },
      ...overrides,
    },
  };
}

describe("enterprise MCP transport contract", () => {
  it("treats only a GET 404 as an empty document", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>().mockResolvedValue(response(undefined, 404));

    await expect(readEnterpriseMcpDocument({
      endpoint,
      path: configPath,
      fetcher,
    })).resolves.toEqual({ ok: true, document: {}, empty: true });

    expect(fetcher).toHaveBeenCalledWith(
      `${endpoint}?path=%7E%2F.agenticx%2Fmcp.json`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([
    ["missing", {}],
    ["null", { text: null }],
    ["number", { text: 42 }],
  ])("rejects a 200 response with %s text", async (_label, payload) => {
    const fetcher = vi.fn<EnterpriseMcpFetch>().mockResolvedValue(response(payload));

    const result = await readEnterpriseMcpDocument({ endpoint, path: configPath, fetcher });

    expect(result).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_text,
    });
  });

  it("rejects malformed JSON text instead of silently using an empty document", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>().mockResolvedValue(response({ text: "not json" }));

    const result = await readEnterpriseMcpDocument({ endpoint, path: configPath, fetcher });

    expect(result).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_document,
    });
  });

  it("rejects a non-200 successful-looking status", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>().mockResolvedValue(
      response(undefined, 204),
    );

    const result = await readEnterpriseMcpDocument({ endpoint, path: configPath, fetcher });

    expect(result).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.read_http,
    });
  });

  it("requires an explicit boolean ok:true body after an HTTP-ok write", async () => {
    const document = mcpDocument();
    const accepted = vi.fn<EnterpriseMcpFetch>().mockResolvedValue(response({ ok: true }));
    const acceptedResult = await writeEnterpriseMcpDocument({
      endpoint,
      path: configPath,
      document,
      headers: { "x-agx-desktop-token": "desktop-token" },
      fetcher: accepted,
    });
    expect(acceptedResult).toEqual({ ok: true });

    const init = accepted.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      path: configPath,
      text: `${JSON.stringify(document, null, 2)}\n`,
    });

    for (const ack of [{ applied: true }, { ok: "true" }, undefined]) {
      const fetcher = vi.fn<EnterpriseMcpFetch>().mockResolvedValue(response(ack));
      const result = await writeEnterpriseMcpDocument({
        endpoint,
        path: configPath,
        document,
        fetcher,
      });
      expect(result).toEqual({
        ok: false,
        errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.write_ack,
      });
    }
  });

  it("returns stable write codes without exposing transport or response bodies", async () => {
    const secret = "Bearer super-secret-token";
    const transport = vi.fn<EnterpriseMcpFetch>().mockRejectedValue(new Error(secret));
    const transportResult = await writeEnterpriseMcpDocument({
      endpoint,
      path: configPath,
      document: mcpDocument(),
      fetcher: transport,
    });
    expect(transportResult).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.write_transport,
    });
    expect(JSON.stringify(transportResult)).not.toContain(secret);

    const http = vi.fn<EnterpriseMcpFetch>().mockResolvedValue(response({ detail: secret }, 500));
    const httpResult = await writeEnterpriseMcpDocument({
      endpoint,
      path: configPath,
      document: mcpDocument(),
      fetcher: http,
    });
    expect(httpResult).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.write_http,
    });
    expect(JSON.stringify(httpResult)).not.toContain(secret);
  });
});

describe("enterprise MCP write read-back confirmation", () => {
  const desiredManagedEntries = {
    "enterprise-market": {
      url: "https://gateway.example.invalid/mcp",
      transport: "streamable_http",
      headers: { Authorization: "Bearer token" },
    },
  };

  it("confirms exact managed values while ignoring unrelated local entries", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({
        text: JSON.stringify({
          mcpServers: {
            local: { command: "user-owned" },
            // Deliberately reorder object keys to prove the comparison is JSON-semantic.
            "enterprise-market": {
              headers: { Authorization: "Bearer token" },
              url: "https://gateway.example.invalid/mcp",
              transport: "streamable_http",
            },
          },
        }),
      }));

    const result = await writeEnterpriseMcpDocumentAndConfirm({
      endpoint,
      path: configPath,
      document: { mcpServers: desiredManagedEntries },
      desiredManagedEntries,
      requestedDeletions: ["enterprise-revoked"],
      fetcher,
    });

    expect(result).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("fails when a managed value differs even if PUT acknowledged applied", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({
        text: JSON.stringify({
          mcpServers: {
            "enterprise-market": {
              ...desiredManagedEntries["enterprise-market"],
              url: "https://gateway.example.invalid/wrong",
            },
          },
        }),
      }));

    const result = await writeEnterpriseMcpDocumentAndConfirm({
      endpoint,
      path: configPath,
      document: { mcpServers: desiredManagedEntries },
      desiredManagedEntries,
      fetcher,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_mismatch,
    });
  });

  it("fails when a requested deletion is still present after read-back", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({
        text: JSON.stringify({
          mcpServers: {
            "enterprise-market": desiredManagedEntries["enterprise-market"],
            "enterprise-revoked": { url: "https://stale.example.invalid" },
          },
        }),
      }));

    const result = await writeEnterpriseMcpDocumentAndConfirm({
      endpoint,
      path: configPath,
      document: { mcpServers: desiredManagedEntries },
      desiredManagedEntries,
      requestedDeletions: ["enterprise-revoked"],
      fetcher,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_mismatch,
    });
  });

  it("does not treat a read-back 404 as proof that the write happened", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response(undefined, 404));

    const result = await writeEnterpriseMcpDocumentAndConfirm({
      endpoint,
      path: configPath,
      document: { mcpServers: desiredManagedEntries },
      desiredManagedEntries,
      fetcher,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_missing,
    });
  });

  it("maps malformed read-back payloads to stable read-back codes", async () => {
    const fetcher = vi.fn<EnterpriseMcpFetch>()
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({}));

    const result = await writeEnterpriseMcpDocumentAndConfirm({
      endpoint,
      path: configPath,
      document: { mcpServers: desiredManagedEntries },
      desiredManagedEntries,
      fetcher,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: ENTERPRISE_MCP_SYNC_ERROR_CODES.readback_text,
    });
  });

  it("can verify an empty managed state after all requested deletions", () => {
    expect(confirmEnterpriseMcpReadBack(
      { mcpServers: { local: { command: "keep" } } },
      {
        desiredManagedEntries: {},
        requestedDeletions: ["enterprise-revoked", "enterprise-old"],
      },
    )).toEqual({
      ok: true,
      document: { mcpServers: { local: { command: "keep" } } },
    });
  });
});
