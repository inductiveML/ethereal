import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");
const smokeTimeoutMs = 12_000;
const shutdownGraceMs = 3_000;

if (!NodeFS.existsSync(mainJs)) {
  console.error(`Desktop smoke test failed: missing ${mainJs}. Run the desktop build first.`);
  process.exit(1);
}

console.log("\nLaunching Electron smoke test...");

const electronCommand = resolveElectronLaunchCommand([mainJs]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

const readinessPatterns = [/backend ready/i, /main window created/i, /did-finish-load/i];
const fatalPatterns = [
  /Cannot find module/i,
  /MODULE_NOT_FOUND/i,
  /Refused to execute/i,
  /Uncaught Error/i,
  /Uncaught TypeError/i,
  /Uncaught ReferenceError/i,
];

let output = "";
let readinessObserved = false;
let survivedTimeout = false;
let terminationRequested = false;
let finished = false;
let forceKillTimeout;

function requestShutdown() {
  if (terminationRequested || finished) return;
  terminationRequested = true;
  child.kill("SIGTERM");
  forceKillTimeout = setTimeout(() => {
    if (!finished) child.kill("SIGKILL");
  }, shutdownGraceMs);
}

function appendOutput(chunk) {
  output += chunk.toString();
  if (!readinessObserved && readinessPatterns.some((pattern) => pattern.test(output))) {
    readinessObserved = true;
    requestShutdown();
  }
}

child.stdout.on("data", appendOutput);
child.stderr.on("data", appendOutput);

const timeout = setTimeout(() => {
  survivedTimeout = true;
  requestShutdown();
}, smokeTimeoutMs);

child.on("error", (error) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (forceKillTimeout) clearTimeout(forceKillTimeout);
  console.error("\nDesktop smoke test failed to launch:", error);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (forceKillTimeout) clearTimeout(forceKillTimeout);

  const failures = fatalPatterns.filter((pattern) => pattern.test(output));
  if (code !== null && code !== 0) {
    failures.push(new RegExp(`Electron exited with code ${code}`));
  }
  if (!readinessObserved && !survivedTimeout) {
    failures.push(/Electron exited before readiness or the smoke timeout/);
  }
  if (signal && !terminationRequested) {
    failures.push(new RegExp(`Electron exited unexpectedly from signal ${signal}`));
  }

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) console.error(` - ${failure.source}`);
    console.error(`\nExit: code=${String(code)}, signal=${String(signal)}`);
    console.error("\nFull output:\n" + output);
    process.exitCode = 1;
    return;
  }

  const proof = readinessObserved
    ? "desktop readiness log observed"
    : "process survived 12 seconds";
  console.log(`Desktop smoke test passed (${proof}).`);
});
