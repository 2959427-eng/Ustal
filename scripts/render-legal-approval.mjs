// Owner-review artifacts only. This file never creates an approved publication.
import { mkdir, writeFile } from "node:fs/promises";
import { sections, titles, renderLegalPage, legalCss } from "../apps/api/src/legal/pages.ts";

const dir = new URL("../docs/launch/legal-approval-20261026/", import.meta.url);
await mkdir(dir, { recursive: true });
const review = {
  approved: false,
  version: "review-2026-10-26",
  effectiveDate: "2026-10-26",
  supportEmail: "support@ustal.site",
  publicOrigin: "https://ustal.site",
  agePolicy: "Сервис предназначен для пользователей от 18 лет. Подтверждение возраста пользователем не является проверкой документов.",
  territories: "Первый публичный запуск — для пользователей в России.",
  processors: "Для работы сервиса используются инфраструктура Timeweb, OpenAI через relay USTAL и сервис доставки push-уведомлений Expo. НЕОБХОДИМО ПОДТВЕРДИТЬ: договорное юридическое лицо OpenAI и фактические условия аккаунта; опубликованные стандартные условия не доказывают наши настройки.",
  processingLocations: "НЕОБХОДИМО ПОДТВЕРДИТЬ: страны размещения конкретных PostgreSQL, S3, резервных копий, relay и обработки запросов OpenAI. Локализация всех данных в России не заявляется.",
  retention: "Автоматического удаления неактивных аккаунтов и массового удаления истории заказов и отзывов по возрасту нет. Удаление персональных сведений не должно повреждать чужие заказы и репутацию. НЕОБХОДИМО УТВЕРДИТЬ: сроки либо критерии хранения персональных остатков истории, AI-кэшей, журналов, жалоб и записей согласий и порядок рассмотрения запросов на их удаление.",
  backupRetention: "Резервные копии могут содержать данные на момент их создания; немедленное удаление всех копий не обещается. НЕОБХОДИМО УТВЕРДИТЬ: подтверждённый период ротации и процедуру недопущения восстановления уже удалённых персональных сведений.",
  legalBasis: "НЕОБХОДИМО ПОДТВЕРДИТЬ: применимые основания обработки, включая передачу AI при выключенном серверном контроле согласия. Принятие этой политики или регистрация сами по себе не являются отдельным разрешением на передачу AI. Незавершённые требования РКН не считаются выполненными.",
  activeWorkSupport: "обратитесь в support@ustal.site, указав проблему и идентификатор аккаунта или заказа, если он известен",
};
await writeFile(new URL("review-input.json", dir), JSON.stringify(review, null, 2) + "\n");
await writeFile(new URL("legal.css", dir), legalCss);
for (const [page, title] of Object.entries(titles)) {
  const note = "НА УТВЕРЖДЕНИЕ ВЛАДЕЛЬЦЕМ. Не опубликовано. Пометки НЕОБХОДИМО требуют конкретного ответа до публикации. Дата вступления в силу согласуется с фактической публикацией.";
  const text = `# USTAL — ${title}\n\n${note}\n\nОператор: Ким Дмитрий Эдуардович. Поддержка: support@ustal.site.\n\n`
    + sections(page, review).map(([heading, body]) => `## ${heading}\n\n${body}\n`).join("\n");
  await writeFile(new URL(`${page}.md`, dir), text);
  const html = renderLegalPage(page, review).replace("<main>", `<main><p role="note"><strong>${note}</strong></p>`);
  await writeFile(new URL(`${page}.html`, dir), html);
}
console.log("Prepared five owner-review pages from the existing renderer; approved=false, no deployment bundle.");
