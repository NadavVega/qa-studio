import { createDb, schema } from "./index";

process.loadEnvFile?.("../../.env");
const db = createDb(process.env.DATABASE_URL!);

// Idempotent: wipes every project, team and org, then creates an empty Demo Org with Team A.
await db.delete(schema.projects);
await db.delete(schema.teams);
await db.delete(schema.orgs);

const [org] = await db.insert(schema.orgs).values({ name: "Demo Org" }).returning();
const [team] = await db.insert(schema.teams).values({ orgId: org!.id, name: "Team A" }).returning();
console.log(`seeded ${org!.name} / ${team!.name}; add projects in the UI`);

await db.$client.end();
