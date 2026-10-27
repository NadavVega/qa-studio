import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ProviderError } from "@qa/intelligence";

// Error bodies are { error: message } like the routes' own replies. Client errors and AI-call failures
// (e.g. a provider's 402) carry their message so the UI banner shows the cause; any other 5xx stays
// generic, since its message can expose internals (SQL, file paths). The full error is always logged.
export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const status = err.statusCode ?? 500;
  if (status < 500) return reply.code(status).send({ error: err.message });
  req.log.error(err);
  return reply.code(status).send({ error: err instanceof ProviderError ? err.message : "Internal Server Error" });
}
