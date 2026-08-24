import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { loadEnv } from "@ustal/config";
import authenticatePlugin from "./plugins/authenticate.js";
import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import citiesRoutes from "./routes/cities.js";
import profileRoutes from "./routes/profile.js";
import mediaRoutes from "./routes/media.js";
import ordersRoutes from "./routes/orders.js";
import feedRoutes from "./routes/feed.js";
import responsesRoutes from "./routes/responses.js";
import contactsRoutes from "./routes/contacts.js";
import assignmentsRoutes from "./routes/assignments.js";
import reviewsRoutes from "./routes/reviews.js";
import reportsRoutes from "./routes/reports.js";
import blocksRoutes from "./routes/blocks.js";
import myRoutes from "./routes/my.js";
import notificationsRoutes from "./routes/notifications.js";
import devicesRoutes from "./routes/devices.js";

export async function buildApp() {
  const env = loadEnv();
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "USTAL API", version: "0.1.0" },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(authenticatePlugin);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(citiesRoutes);
  await app.register(profileRoutes);
  await app.register(mediaRoutes);
  await app.register(ordersRoutes);
  await app.register(feedRoutes);
  await app.register(responsesRoutes);
  await app.register(contactsRoutes);
  await app.register(assignmentsRoutes);
  await app.register(reviewsRoutes);
  await app.register(reportsRoutes);
  await app.register(blocksRoutes);
  await app.register(myRoutes);
  await app.register(notificationsRoutes);
  await app.register(devicesRoutes);
  // Админка НЕ проходит через этот Fastify-инстанс: apps/admin (Next.js)
  // обращается к БД напрямую через @ustal/database (server components/
  // actions), со своей сессионной авторизацией admin_users — так было
  // заложено уже в Фазе 1 (apps/admin/package.json зависит от
  // @ustal/database, а не от api-клиента) и подтверждено в Фазе 8. Разделы
  // /admin/* в docs/api.md описывают операции, а не обязательный REST-слой.

  app.setErrorHandler((error, _request, reply) => {
    if (error.name === "ZodError") {
      return reply.code(400).send({ error: { code: "validation_error", message: error.message } });
    }
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    return reply
      .code(statusCode)
      .send({ error: { code: statusCode === 500 ? "internal_error" : "error", message: error.message } });
  });

  return app;
}
