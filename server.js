const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const backendEntry = path.join(__dirname, "mock-backend", "server.js");

if (!fs.existsSync(backendEntry)) {
  console.error("Cannot find backend entry at mock-backend/server.js");
  process.exit(1);
}

// mock-backend/server.js only calls app.listen() when it detects it is the
// process entry point (process.argv[1] resolves to its own file URL). When the
// backend is started via this root wrapper, argv[1] points at this file, so the
// guard would otherwise import the module without ever listening. Re-point
// argv[1] at the backend entry before importing so the backend actually boots.
process.argv[1] = backendEntry;

import(pathToFileURL(backendEntry).href).catch((err) => {
  console.error("Failed to start backend from repo root:", err);
  process.exit(1);
});
