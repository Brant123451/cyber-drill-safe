/**
 * Unified server startup
 * Runs both API server (user management) and Gateway (traffic forwarding) together
 */

import { startApiServer } from "./api-server.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Start API server (Express on :18800)
startApiServer();

// Start Gateway server (lab-server.js on :18790)
const gatewayProcess = spawn("node", [path.join(__dirname, "lab-server.js")], {
  stdio: "inherit",
  env: { ...process.env },
});

gatewayProcess.on("exit", (code) => {
  console.log(`[start] gateway exited with code ${code}`);
});

process.on("SIGINT", () => {
  gatewayProcess.kill("SIGTERM");
  process.exit(0);
});

process.on("SIGTERM", () => {
  gatewayProcess.kill("SIGTERM");
  process.exit(0);
});

console.log("[start] API + Gateway servers started");
