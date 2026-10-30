import nodemailer from "nodemailer";
import type { Env } from "@ustal/config";

export interface SupportMessage {
  userId: string;
  name: string | null;
  phone: string | null;
  text: string;
  appVersion: string | null;
  sentAt: Date;
}
export type SupportSender = (message: SupportMessage) => Promise<void>;

/** Письмо — только текст; пользовательский ввод не попадает в заголовки (тема фиксированная). */
export function supportMailBody(m: SupportMessage): { subject: string; text: string } {
  return {
    subject: `USTAL: обращение в поддержку (${m.userId.slice(0, 8)})`,
    text: [
      `Пользователь: ${m.userId}`,
      `Имя: ${m.name ?? "—"}`,
      `Телефон: ${m.phone ?? "—"}`,
      `Версия приложения: ${m.appVersion ?? "—"}`,
      `Время: ${m.sentAt.toISOString()}`,
      "",
      m.text,
    ].join("\n"),
  };
}

/** null — SMTP не настроен: маршрут отвечает 503, обращение не «теряется» молча. */
export function createSupportSender(env: Pick<Env, "SUPPORT_EMAIL_TO" | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASSWORD" | "SMTP_FROM">): SupportSender | null {
  const { SUPPORT_EMAIL_TO: to, SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user, SMTP_PASSWORD: pass } = env;
  if (!to || !host || !user || !pass) return null;
  const from = env.SMTP_FROM ?? user;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
  return async (m) => {
    const { subject, text } = supportMailBody(m);
    await transport.sendMail({ from, to, subject, text });
  };
}
