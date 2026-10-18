/**
 * Показ заказа волнами до лимита откликов (решение владельца 2026-10-15).
 *
 * Ограничивается число откликов, а не показов: показать 150 людям и получить 2 отклика — плохо.
 * Волна 1 — обычный подбор (как раньше). Если за окно ожидания откликов меньше лимита, следующая волна
 * расширяет подбор на следующих по релевантности людей города; уже получившие заказ его не теряют.
 * Волны останавливаются: лимит откликов набран, заказчик закрыл приём, подходящие люди закончились,
 * заказ перестал быть опубликованным, наступило время заказа или достигнут предел числа волн.
 */
export const MAX_ACTIVE_RESPONSES = 150;
/** Предел числа волн: волна N подбирает до N × 150 кандидатов из каждого потока отбора. */
export const MAX_DELIVERY_WAVES = 10;
const HOUR = 60 * 60 * 1000;

/** Окно ожидания откликов перед следующей волной: срочный заказ (в ближайшие сутки) — 1 час, иначе 6 часов. */
export function deliveryWaveWindowMs(desiredAt: Date | null | undefined, now: Date = new Date()): number {
  if (desiredAt && desiredAt.getTime() - now.getTime() <= 24 * HOUR) return HOUR;
  return 6 * HOUR;
}

export interface WaveState {
  status: string;
  deliveryWave: number;
  /** Номер волны, подбор которой уже опубликован. */
  deliveredWave: number;
  deliveryWaveAt: Date | null;
  publishedAt: Date | null;
  deliveryExhaustedAt: Date | null;
  responsesClosedAt: Date | null;
  desiredAt: Date | null;
}
/** Пора ли следующая волна (без учёта числа откликов — его проверяет вызывающий). */
export function nextWaveDue(o: WaveState, activeResponses: number, now: Date = new Date()): boolean {
  if (o.status !== "published" || o.responsesClosedAt || o.deliveryExhaustedAt) return false;
  if (activeResponses >= MAX_ACTIVE_RESPONSES || o.deliveryWave >= MAX_DELIVERY_WAVES) return false;
  if (o.deliveredWave < o.deliveryWave) return false;
  if (o.desiredAt && o.desiredAt.getTime() <= now.getTime()) return false;
  const since = o.deliveryWaveAt ?? o.publishedAt;
  if (!since) return false;
  return now.getTime() - since.getTime() >= deliveryWaveWindowMs(o.desiredAt, now);
}
/** Принимает ли заказ новые отклики по лимиту/решению заказчика (статус проверяется отдельно). */
export const responsesOpen = (o: { responsesClosedAt: Date | null }, activeResponses: number) =>
  !o.responsesClosedAt && activeResponses < MAX_ACTIVE_RESPONSES;
