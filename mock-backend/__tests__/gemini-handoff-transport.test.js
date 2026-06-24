import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

const MODULE_PATH = path.resolve(process.cwd(), "gemini-handoff-transport.js");

function withTempEnv(next, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(next)) {
    previous.set(key, process.env[key]);
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

async function loadFreshTransportModule() {
  const moduleUrl = `${pathToFileURL(MODULE_PATH).href}?cacheBust=${Date.now()}_${Math.random()}`;
  return import(moduleUrl);
}

async function withHttpServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("gemini-handoff-transport", () => {
  it("returns skipped result when transport flag is disabled", async () => {
    await withTempEnv(
      {
        ENABLE_GEMINI_HANDOFF_TRANSPORT: "false",
        GEMINI_HANDOFF_TRANSPORT_URL: null,
      },
      async () => {
        const { dispatchGeminiHandoffRequest, getGeminiHandoffTransportRuntimeInfo } = await loadFreshTransportModule();

        const runtime = getGeminiHandoffTransportRuntimeInfo();
        assert.equal(runtime.enabled, false);
        assert.equal(runtime.configured, false);

        const result = await dispatchGeminiHandoffRequest({ request_id: "req_transport_disabled" });
        assert.equal(result.attempted, false);
        assert.equal(result.skipped, true);
        assert.equal(result.reason, "transport_disabled");
      }
    );
  });

  it("sends payload with auth header when transport is enabled", async () => {
    await withHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        assert.equal(req.method, "POST");
        assert.equal(req.headers.authorization, "Bearer test_token_123");
        const parsed = JSON.parse(body);
        assert.equal(parsed.request_id, "req_transport_enabled");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ request_id: parsed.request_id, accepted: true }));
      });
    }, async (url) => {
      await withTempEnv(
        {
          ENABLE_GEMINI_HANDOFF_TRANSPORT: "true",
          GEMINI_HANDOFF_TRANSPORT_URL: url,
          GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN: "test_token_123",
          GEMINI_HANDOFF_TRANSPORT_AUTH_HEADER: "Authorization",
        },
        async () => {
          const { dispatchGeminiHandoffRequest, getGeminiHandoffTransportRuntimeInfo } = await loadFreshTransportModule();

          const runtime = getGeminiHandoffTransportRuntimeInfo();
          assert.equal(runtime.enabled, true);
          assert.equal(runtime.configured, true);
          assert.equal(runtime.auth_configured, true);

          const result = await dispatchGeminiHandoffRequest({ request_id: "req_transport_enabled" });
          assert.equal(result.attempted, true);
          assert.equal(result.success, true);
          assert.equal(result.status_code, 200);
          assert.equal(result.response_payload.request_id, "req_transport_enabled");
        }
      );
    });
  });

  it("returns error metadata on non-2xx transport response", async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "temporarily_unavailable" }));
    }, async (url) => {
      await withTempEnv(
        {
          ENABLE_GEMINI_HANDOFF_TRANSPORT: "true",
          GEMINI_HANDOFF_TRANSPORT_URL: url,
          GEMINI_HANDOFF_TRANSPORT_AUTH_TOKEN: null,
        },
        async () => {
          const { dispatchGeminiHandoffRequest } = await loadFreshTransportModule();
          const result = await dispatchGeminiHandoffRequest({ request_id: "req_transport_503" });

          assert.equal(result.attempted, true);
          assert.equal(result.success, false);
          assert.equal(result.status_code, 503);
          assert.equal(result.error_code, "transport_http_error");
        }
      );
    });
  });
});
