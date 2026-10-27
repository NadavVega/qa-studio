import { createServer } from "node:http";
import { PgBoss } from "pg-boss";
import { GithubEventJob, GithubRunJob, InvestigateJob, PORTS, QUEUE_OPTIONS, QUEUES, RegressionJob, ValidateJob } from "@qa/core";
import { createDb } from "@qa/db";
import { investigateRun } from "./investigate";
import { runRegressionTest, validateFinding } from "./validate";
import { pollDue, recordEvent, runGithubEvent } from "./github";

const db = createDb(process.env.DATABASE_URL!);
const boss = new PgBoss(process.env.DATABASE_URL!);
boss.on("error", (err) => console.error("pg-boss", err));
await boss.start();
for (const q of Object.values(QUEUES)) await boss.createQueue(q, QUEUE_OPTIONS[q]);
await boss.work(QUEUES.investigate, async ([job]) => {
  const data = InvestigateJob.parse(job!.data);
  const ids = await investigateRun(db, data);
  console.log(`run ${data.runId}: investigated mission ${data.missionId}, evidence ${ids.join(", ")}`);
});
await boss.work(QUEUES.validate, async ([job]) => {
  const data = ValidateJob.parse(job!.data);
  const attempt = await validateFinding(db, data);
  console.log(`finding ${data.findingId}: validation attempt ${attempt.id}, reproduced ${attempt.reproduced}`);
});
await boss.work(QUEUES.regression, async ([job]) => {
  const data = RegressionJob.parse(job!.data);
  const result = await runRegressionTest(db, data);
  console.log(`regression test ${data.regressionTestId}: result ${result.id}, passed ${result.passed}`);
});
// GitHub: webhook deliveries (from the API) and polls both go through recordEvent.
await boss.work(QUEUES.githubEvent, async ([job]) => {
  await recordEvent(db, boss, GithubEventJob.parse(job!.data));
});
// Several events at once; the queue's singletonKey still allows one run per environment.
await boss.work(QUEUES.githubRun, { localConcurrency: 4 }, async ([job]) => {
  const data = GithubRunJob.parse(job!.data);
  await runGithubEvent(db, data);
  console.log(`github event ${data.eventId}: done`);
});
setInterval(() => void pollDue(db, boss).catch((err) => console.error("github poll", err)), 10_000);

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "worker" }));
    return;
  }
  res.writeHead(404).end();
}).listen(PORTS.worker, () => console.log(`worker health on :${PORTS.worker}`));
