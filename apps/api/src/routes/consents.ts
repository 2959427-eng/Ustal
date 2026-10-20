import { loadEnv } from "@ustal/config";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConsentError, decideConsent, readConsents } from "../lib/consents.js";

const decisionSchema = z.object({
  policyId: z.string().uuid(), policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["grant", "revoke"]), expectedRevision: z.number().int().min(0).max(2147483646),
}).strict();

// Registered only with explicit enforced consent configuration; login/lifecycle remain available.
export default async function consentRoutes(app: FastifyInstance) {
  app.get("/me/consents", { preHandler: app.authenticate }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return { ...await readConsents(request.userId), outboundEnforcement: loadEnv().USTAL_AI_CONSENT_MODE === "enforced" }; }
    catch (error) {
      if (error instanceof ConsentError) return reply.code(error.status).send({ error: { code: error.code } });
      throw error;
    }
  });
  app.post("/me/consents", { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = decisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_consent_decision" } });
    try { return await decideConsent(request.userId, parsed.data); }
    catch (error) {
      if (error instanceof ConsentError) return reply.code(error.status).send({ error: { code: error.code } });
      throw error;
    }
  });
}
