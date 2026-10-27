import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { JudgeResult } from "@qa/core";
import { judgeStage, StageError, type createDb } from "@qa/db";

type Db = ReturnType<typeof createDb>;

const RunParams = z.object({ id: z.uuid(), runId: z.uuid() });

export function judgeRoutes(app: FastifyInstance, db: Db) {
  // Judge stage: verdict on the run's latest investigation. Every verdict cites real Evidence ids.
  app.post("/projects/:id/runs/:runId/judge", async (req, reply) => {
    const params = RunParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: z.treeifyError(params.error) });
    try {
      const { judgement, finding, call } = await judgeStage(db, params.data.id, params.data.runId);
      return reply.code(201).send(JudgeResult.parse({ ...judgement, finding, llmCallKey: call?.key ?? null }));
    } catch (err) {
      if (err instanceof StageError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
