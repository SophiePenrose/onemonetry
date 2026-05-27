const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const backendEntry = path.join(__dirname, "mock-backend", "server.js");

if (!fs.existsSync(backendEntry)) {
  console.error("Cannot find backend entry at mock-backend/server.js");
  process.exit(1);
}

import(pathToFileURL(backendEntry).href).catch((err) => {
  console.error("Failed to start backend from repo root:", err);
  process.exit(1);
});