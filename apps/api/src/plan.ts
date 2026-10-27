import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PlanResult, SelectResult } from "@qa/core";
import { planStage, selectStage, StageError, type createDb } from "@qa/db";

type Db = ReturnType<typeof createDb>;

const RunParams = z.object({ id: z.uuid(), runId: z.uuid() });

export function planRoutes(app: FastifyInstance, db: Db) {
  // Plan stage: AI proposes Missions from the project's (non-rejected) Requirements.
  app.post("/projects/:id/runs/:runId/plan", async (req, reply) => {
    const params = RunParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    try {
      const { missions, call } = await planStage(db, params.data.id, params.data.runId);
      return reply.code(201).send(PlanResult.parse({ missions, llmCallKey: call.key }));
    } catch (err) {
      if (err instanceof StageError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // Select stage: deterministic ranking of the run's Missions.
  app.post("/projects/:id/runs/:runId/select", async (req, reply) => {
    const params = RunParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    try {
      return reply.code(201).send(SelectResult.parse({ selections: await selectStage(db, params.data.id, params.data.runId) }));
    } catch (err) {
      if (err instanceof StageError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
