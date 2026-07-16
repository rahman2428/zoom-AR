import { promises as fs } from "node:fs";
import path from "node:path";

const maxAssetBytes = 25 * 1024 * 1024;
const assetsRoot = path.join(process.cwd(), ".open-next", "assets");

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function run() {
  try {
    await fs.access(assetsRoot);
  } catch {
    console.log("[cf-prune] Skipped: .open-next/assets not found.");
    return;
  }

  const files = await collectFiles(assetsRoot);
  const oversized = [];

  for (const filePath of files) {
    const stats = await fs.stat(filePath);
    if (stats.size > maxAssetBytes) {
      oversized.push({ filePath, size: stats.size });
    }
  }

  if (oversized.length === 0) {
    console.log("[cf-prune] No oversized assets found.");
    return;
  }

  for (const entry of oversized) {
    await fs.unlink(entry.filePath);
    console.log(
      `[cf-prune] Removed ${path.relative(process.cwd(), entry.filePath)} (${formatMiB(entry.size)})`
    );
  }

  console.log(
    `[cf-prune] Removed ${oversized.length} oversized asset(s) over ${formatMiB(maxAssetBytes)}.`
  );
}

run().catch((error) => {
  console.error("[cf-prune] Failed:", error);
  process.exitCode = 1;
});
