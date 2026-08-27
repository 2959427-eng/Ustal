import { readFile } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadEnv } from "@ustal/config";
import {
  capabilityExtractionResultSchema,
  moderationDecisionSchema,
  orderExtractionResultSchema,
} from "@ustal/validation";
import type {
  AiCallMeta,
  AiCallResult,
  AiProviderBundle,
  EmbeddingProvider,
  ModerationDecision,
  ModerationProvider,
  SpeechToTextProvider,
  StructuredExtractionProvider,
} from "../types.js";

/**
 * OpenAI-реализация — выбрана как провайдер по умолчанию, см. .env.example.
 *  - STT:        whisper-1
 *  - extraction: gpt-4o-mini (Structured Outputs — response_format: json_schema,
 *    strict: true — модель физически не может вернуть JSON, не соответствующий
 *    схеме; дополнительный `zodSchema.parse()` — вторая линия защиты и общий
 *    контракт с mock-провайдером и остальным кодом)
 *  - embeddings: text-embedding-3-small (1536 измерений — см. packages/database schema)
 *  - moderation: правила (moderateWithRules) + gpt-4o-mini только для
 *    пограничных случаев (раздел 12 ТЗ: "не полноценный LLM-вызов на каждый заказ")
 *
 * Реализовано в Фазе 8 (найдено при подключении боевого ключа — до этого была
 * заготовка Фазы 2, все методы бросали "not implemented"; см.
 * docs/architecture.md §5). Клиент создаётся лениво и один раз — процесс
 * worker'а долгоживущий, пересоздавать клиент на каждый вызов незачем.
 */

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (client) return client;
  const env = loadEnv();
  if (!env.OPENAI_API_KEY) {
    throw new Error(
      "AI_PROVIDER=openai, но OPENAI_API_KEY не задан. Задайте его в .env (см. .env.example) " +
        "или переключитесь на AI_PROVIDER=mock для разработки.",
    );
  }
  client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
  });
  return client;
}

export const RATE_CARD_MINOR_PER_1K_TOKENS = {
  "gpt-4o-mini": { input: 15, output: 60 }, // копейки / 1000 токенов, ориентировочно
  "text-embedding-3-small": { input: 2, output: 0 },
  "whisper-1": { input: 0, output: 0 }, // тарифицируется по времени аудио, не по токенам
};

/** Читает audio-вход как Buffer: обычный путь на диске (local-провайдер) или presigned https URL (s3-провайдер, packages/storage). */
async function readAudioBuffer(input: { filePath: string; mimeType: string }): Promise<Buffer> {
  if (input.filePath.startsWith("http://") || input.filePath.startsWith("https://")) {
    const response = await fetch(input.filePath);
    if (!response.ok) {
      throw new Error(`Не удалось скачать аудио для STT: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(input.filePath);
}

export const openAiStt: SpeechToTextProvider = {
  async transcribe(audio, _meta: AiCallMeta): Promise<AiCallResult<{ transcript: string }>> {
    const started = Date.now();
    const buffer = await readAudioBuffer(audio);
    const ext = audio.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "webm";
    const file = await toFile(buffer, `audio.${ext}`, { type: audio.mimeType });

    const response = await getClient().audio.transcriptions.create({
      file,
      model: "whisper-1",
    });

    return {
      data: { transcript: response.text },
      provider: "openai",
      model: "whisper-1",
      // whisper-1 тарифицируется по времени аудио, а не по токенам — API не
      // возвращает usage для этой модели; 0 — тот же осознанный placeholder,
      // что и раньше (RATE_CARD_MINOR_PER_1K_TOKENS.whisper-1 = 0), а не баг.
      tokensInput: 0,
      tokensOutput: 0,
      latencyMs: Date.now() - started,
    };
  },
};

/**
 * Общая обвязка структурированного JSON-вызова: response_format json_schema
 * (БЕЗ strict: true) + Zod-валидация ответа как настоящий контракт-гейт.
 *
 * Почему не strict: true — OpenAI Structured Outputs в strict-режиме требует
 * `additionalProperties: false` на КАЖДОМ object-узле схемы, включая
 * вложенные, и не поддерживает произвольные словари (z.record(), см.
 * `capabilityExtractionResultSchema.resources[].attributes` в
 * packages/validation/src/profile.ts) — такое поле физически не выразить
 * под strict-ограничением без смены модели данных (`user_resources.attributes`
 * jsonb рассчитан именно на произвольные ключи). Без реального ключа в этой
 * песочнице проверить точное поведение strict-режима на такой схеме нельзя —
 * решение сознательно консервативное: non-strict json_schema (модель следует
 * схеме с высокой, но не гарантированной точностью) + Zod `.parse()` как
 * единственная фактическая граница валидации, тот же принцип, что и
 * остальной пайплайн ("LLM никогда не пишет в БД напрямую" без прохождения
 * этой проверки). Если `.parse()` бросает — job падает и уходит на retry
 * pg-boss, как и любая другая ошибка extraction/moderation в этом коде.
 */
async function structuredCompletion<T>(input: {
  systemPrompt: string;
  userText: string;
  schemaName: string;
  zodSchema: { parse(value: unknown): T };
  jsonSchema: Record<string, unknown>;
}): Promise<{ data: T; model: string; tokensInput: number; tokensOutput: number }> {
  const model = "gpt-4o-mini";
  const response = await getClient().chat.completions.create({
    model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userText },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: input.schemaName, schema: input.jsonSchema },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`OpenAI (${input.schemaName}): пустой ответ модели`);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (err) {
    throw new Error(`OpenAI (${input.schemaName}): ответ не является валидным JSON: ${(err as Error).message}`);
  }

  const data = input.zodSchema.parse(parsedJson);

  return {
    data,
    model,
    tokensInput: response.usage?.prompt_tokens ?? 0,
    tokensOutput: response.usage?.completion_tokens ?? 0,
  };
}

const SYSTEM_PROMPT_CAPABILITY_EXTRACTION = `Ты извлекаешь структурированный профиль возможностей человека
из свободного текста на русском языке (текст или транскрипция голосового сообщения).
Определи способности (capabilities) и ресурсы (resources), которые человек явно
упомянул или которые логически следуют из текста. Не придумывай способности,
которых нет в тексте и не следуют из него напрямую. evidenceType="explicit" —
только для прямо названного; "inferred" — для логически выведенного. confidence —
твоя уверенность от 0 до 1. Верни JSON строго по предоставленной схеме.`;

const SYSTEM_PROMPT_ORDER_EXTRACTION = `Ты извлекаешь структурированное описание заказа на услугу или поручение
из свободного текста на русском языке (текст или транскрипция голосового сообщения).
normalizedTitle — короткий заголовок, normalizedDescription — полное описание своими
словами. requiredCapabilities/requiredResources — то, что обязательно нужно
исполнителю для этой задачи; desired* — желательно, но не критично. regulated=true
только для работ, требующих официальной лицензии/допуска (электрика, газ, медицина
и т.п.) — если сомневаешься, ставь false и requiresQualification=true вместо этого.
complexity оценивай по объёму и сложности задачи. Верни JSON строго по
предоставленной схеме.`;

export const openAiExtraction: StructuredExtractionProvider = {
  async extractCapabilityProfile(input, meta: AiCallMeta) {
    const started = Date.now();
    const userText = input.previousProfileSummary
      ? `Текущий профиль:\n${input.previousProfileSummary}\n\nНовый ввод пользователя:\n${input.text}`
      : input.text;
    const result = await structuredCompletion({
      systemPrompt: SYSTEM_PROMPT_CAPABILITY_EXTRACTION,
      userText,
      schemaName: "capability_extraction",
      zodSchema: capabilityExtractionResultSchema,
      jsonSchema: zodToJsonSchema(capabilityExtractionResultSchema, "capability_extraction").definitions![
        "capability_extraction"
      ] as Record<string, unknown>,
    });
    void meta;
    return {
      data: result.data,
      provider: "openai",
      model: result.model,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      latencyMs: Date.now() - started,
    };
  },
  async extractOrder(input, meta: AiCallMeta) {
    const started = Date.now();
    const result = await structuredCompletion({
      systemPrompt: SYSTEM_PROMPT_ORDER_EXTRACTION,
      userText: input.text,
      schemaName: "order_extraction",
      zodSchema: orderExtractionResultSchema,
      jsonSchema: zodToJsonSchema(orderExtractionResultSchema, "order_extraction").definitions![
        "order_extraction"
      ] as Record<string, unknown>,
    });
    void meta;
    return {
      data: result.data,
      provider: "openai",
      model: result.model,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      latencyMs: Date.now() - started,
    };
  },
};

export const openAiEmbedding: EmbeddingProvider = {
  async embed(texts, _meta: AiCallMeta) {
    const started = Date.now();
    const model = "text-embedding-3-small";
    const response = await getClient().embeddings.create({ model, input: texts });
    const vectors = response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    return {
      data: { vectors },
      provider: "openai",
      model,
      tokensInput: response.usage?.prompt_tokens ?? 0,
      tokensOutput: 0,
      latencyMs: Date.now() - started,
    };
  },
};

/**
 * Раздел 12 ТЗ: детерминированные случаи — ключевые слова явных категорий
 * риска (оружие, наркотики, несовершеннолетние и т.п.) — отсекаются правилами
 * без обращения к LLM. AI-вызов используется только для пограничных случаев.
 */
const HARD_BLOCK_KEYWORDS = ["оружие", "наркотик", "несовершеннолет"];

export function moderateWithRules(text: string): { decision: "reject" | "manual_review" | null; reason?: string } {
  const lower = text.toLowerCase();
  for (const kw of HARD_BLOCK_KEYWORDS) {
    if (lower.includes(kw)) return { decision: "reject", reason: `rule: keyword "${kw}"` };
  }
  return { decision: null }; // не решено правилами — эскалируется на AI-модерацию
}

const SYSTEM_PROMPT_MODERATION = `Ты модерируешь текст заказа на услугу для платформы поручений в России.
Оцени, можно ли его публиковать. decision:
- "allow" — обычный законный заказ, публиковать без ограничений;
- "allow_with_warning" — законно, но есть нюанс, о котором стоит предупредить автора (например физически тяжёлая работа);
- "manual_review" — сомнительно, требует проверки человеком (не однозначно запрещено, но и не очевидно допустимо);
- "reject" — явное нарушение (незаконная деятельность, мошенничество, эксплуатация и т.п.).
reason — короткое объяснение решения на русском. Если regulated=true во входе,
никогда не выбирай "allow" или "allow_with_warning" — только "manual_review" или "reject",
т.к. на этой платформе пока нет проверки квалификации/лицензий. Верни JSON строго по схеме.`;

export const openAiModeration: ModerationProvider = {
  async moderate(input, _meta: AiCallMeta) {
    const started = Date.now();
    const ruleResult = moderateWithRules(input.text);
    if (ruleResult.decision) {
      return {
        data: { decision: ruleResult.decision, reason: ruleResult.reason ?? "" },
        provider: "rules",
        model: "keyword-rules-v1",
        tokensInput: 0,
        tokensOutput: 0,
        latencyMs: Date.now() - started,
      };
    }

    const userText = `Текст заказа: ${input.text}\nregulated (требует лицензии/допуска): ${input.regulated}\nriskLevel (0-низкий, выше-опаснее): ${input.riskLevel}`;
    const result = await structuredCompletion({
      systemPrompt: SYSTEM_PROMPT_MODERATION,
      userText,
      schemaName: "moderation_decision",
      zodSchema: moderationDecisionSchema,
      jsonSchema: zodToJsonSchema(moderationDecisionSchema, "moderation_decision").definitions![
        "moderation_decision"
      ] as Record<string, unknown>,
    });

    // Инвариант раздела 7 (architecture.md §5 п.7): регулируемая работа без
    // верификации никогда не проходит автоматически — защита на случай, если
    // модель ошибочно вернёт allow/allow_with_warning вопреки системному промпту.
    let decision: ModerationDecision = result.data.decision;
    let reason = result.data.reason;
    if (input.regulated && (decision === "allow" || decision === "allow_with_warning")) {
      decision = "manual_review";
      reason = `${reason} (скорректировано: regulated=true не может проходить автоматически)`;
    }

    return {
      data: { decision, reason },
      provider: "openai",
      model: result.model,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      latencyMs: Date.now() - started,
    };
  },
};

export const openAiProviders: AiProviderBundle = {
  stt: openAiStt,
  extraction: openAiExtraction,
  embedding: openAiEmbedding,
  moderation: openAiModeration,
};
