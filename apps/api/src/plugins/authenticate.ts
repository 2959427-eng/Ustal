import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@ustal/database";
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
    let userId: string;
    try {
      userId = verifyAccessToken(header.slice("Bearer ".length)).sub;
    } catch {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid or expired token" } });
    }
    // Access-токен (JWT) сам не отзывается, поэтому статус аккаунта сверяем с БД на каждом запросе:
    // заблокированный админом пользователь теряет доступ сразу, а не через ACCESS_TOKEN_TTL_MINUTES.
    const user = await getDb().query.users.findFirst({ where: eq(schema.users.id, userId), columns: { status: true } });
    // Удалённый аккаунт (DELETE /me) — сессии больше нет, это не блокировка админом: 401, а не 403 account_blocked.
    if (!user || user.status === "deleted") {
      return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid or expired token" } });
    }
    if (user.status !== "active") {
      return reply.code(403).send({ error: { code: "account_blocked", message: "Аккаунт заблокирован" } });
    }
    request.userId = userId;
  });
}

export default fp(authenticatePlugin);
