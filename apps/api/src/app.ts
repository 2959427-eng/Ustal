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

  // CORS в основном имеет смысл для браузерных клиентов (Origin-заголовок) —
  // мобильное приложение (fetch из React Native) и админка (прямой доступ к
  // БД, не через это API) под него не подпадают. В production по умолчанию
  // не открываем API для произвольных браузерных источников; в dev/test
  // оставляем permissive для локальной разработки и Swagger "Try it out".
  await app.register(cors, { origin: env.NODE_ENV === "production" ? false : true });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });

  // Базовые security-заголовки без отдельной зависимости (@fastify/helmet
  // сюда не добавлен — не хотим добавлять новый пакет вслепую без прогона
  // npm install на машине пользователя). Минимальный набор, который ничего
  // не ломает: не влияет на существующие ответы, только добавляет заголовки.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  // Swagger UI отдаёт полную схему API (все роуты, поля) без какой-либо
  // авторизации — приемлемо для разработки, но не должно торчать в интернет
  // в production (сейчас admin/api уже за публичным доменом — см.
  // AI_HANDOFF.md/аудит безопасности). Ничего не ломает: сама схема нигде
  // в коде не используется программно, только UI на /docs.
  if (env.NODE_ENV !== "production") {
    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: { title: "USTAL API", version: "0.1.0" },
      },
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

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
    // На 5xx (в том числе непойманные исключения вроде "Failed to create ...")
    // не отдаём клиенту error.message — это может утечь внутренние детали
    // (текст ошибки Postgres, путь к файлу и т.п.). Полный текст всё ещё
    // уходит в app.log.error(error) выше. Для всех остальных статусов (4xx —
    // валидация, not_found, rate_limited и т.д.) поведение не изменилось.
    const isServerError = statusCode >= 500;
    return reply.code(statusCode).send({
      error: {
        code: isServerError ? "internal_error" : "error",
        message: isServerError ? "Внутренняя ошибка сервера" : error.message,
      },
    });
  });

  return app;
}
