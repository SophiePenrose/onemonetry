import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const guard = new URL("../__tests__/fixtures/local-only-fetch.mjs", import.meta.url).href;
const files = readdirSync(new URL("../__tests__/", import.meta.url)).filter(name => name.endsWith(".test.js")).map(name => `__tests__/${name}`);
// NODE_OPTIONS is inherited by the integration tests' child servers too.
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${guard}`.trim() },
});
child.on("exit", code => { process.exitCode = code ?? 1; });
child.on("error", () => { process.exitCode = 1; });
