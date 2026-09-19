import { URL } from "node:url";
// Test-process preload. Provider adapters use explicit mocks; integration tests may
// talk only to their loopback test servers. Redirects cannot escape to the internet.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("External fetch blocked in isolated tests; use a provider mock.");
  }
  return realFetch(input, { ...options, redirect: "error" });
};
