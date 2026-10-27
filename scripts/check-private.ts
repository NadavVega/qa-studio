import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Fails when anything from the private demo profile is tracked by git: a file under the demo folder,
// any string value of its models.json (model ids), or any term of its denylist.txt (one per line,
// case-insensitive, "#" comments) in a tracked file. Without the demo folder only the first check runs.
// Runs in pnpm lint; prints file names only, never the matched value.
const dir = process.env.DEMO_DATA_DIR || "demo-local";
const git = (...args: string[]) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch (e) {
    if ((e as { status?: number }).status === 1) return ""; // git grep: no match
    throw e;
  }
};
const problems: string[] = [];

const tracked = git("ls-files", "--", dir);
if (tracked) problems.push(`tracked files under ${dir}/ (git rm --cached them):\n${tracked}`);

const models = path.join(dir, "models.json");
if (existsSync(models)) {
  const values = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v !== "auto") values.add(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(readFileSync(models, "utf8")));
  for (const v of values) {
    const hits = git("grep", "-l", "-F", "-e", v, "--");
    if (hits) problems.push(`a value from ${models} appears in tracked files:\n${hits}`);
  }
}

const denylist = path.join(dir, "denylist.txt");
if (existsSync(denylist)) {
  const terms = readFileSync(denylist, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const hits = new Set(terms.flatMap((t) => git("grep", "-l", "-i", "-F", "-e", t, "--").split("\n").filter(Boolean)));
  if (hits.size) problems.push(`denylisted terms from ${denylist} appear in tracked files:\n${[...hits].sort().join("\n")}`);
}

if (problems.length) {
  console.error(`check:private failed\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("check:private ok");
