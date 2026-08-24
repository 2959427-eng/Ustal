import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { verifyAccessToken } from "../lib/auth-tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function authenticatePlugin(app: FastifyInstance) {
  app.decorateRequest("userId", "");
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Missing bearer token" } });
    }
    try {
      const payload = verifyAccessToken(header.slice("Bearer ".length));
      request.userId = payload.sub;
    } catch {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid or expired token" } });
    }
  });
}

export default fp(authenticatePlugin);
