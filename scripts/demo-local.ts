import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

// pnpm demo / pnpm demo:seed: run a script from the private demo folder, or do nothing when it is absent.
const SCRIPTS: Record<string, string> = { demo: "scripts/demo.ts", seed: "apps/sim/src/seed.ts" };
const dir = path.resolve(process.env.DEMO_DATA_DIR || "demo-local");
const file = path.join(dir, SCRIPTS[process.argv[2]!] ?? "");
if (!existsSync(file) || !SCRIPTS[process.argv[2]!]) {
  console.log("demo-local not found");
  process.exit(0);
}
await import(pathToFileURL(file).href);
