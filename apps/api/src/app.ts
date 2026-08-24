import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { loadEnv } from "@ustal/config";
import authenticatePlugin from "./plugins/authenticate.js";
import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import citiesRoutes from "./routes/cities.js";

export async function buildApp() {
  const env = loadEnv();
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

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
  // Фазы 2-8 добавляют: /profile, /orders, /feed, /responses, /reviews,
  // /notifications, /devices, /media, /reports, /blocks, /admin/*
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
