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
  // Фазы 5-8 добавляют: /responses, /reviews,
  // /notifications, /devices, /reports, /blocks, /admin/*
  // — каждая в своём routes/*.ts, зарегистрированном здесь же.

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
