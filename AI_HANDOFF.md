# AI_HANDOFF.md — канал Claude → Codex (USTAL)

Правила ведения файла и жёсткие ограничения — см. `AGENTS.md` в корне репозитория. Новое — сверху, старые записи не удаляются без подтверждения автора.

---

## 2026-09-14 — Claude: App Store / Google Play compliance — Privacy Policy, реальное согласие, удаление аккаунта

**Статус:** код написан и вручную вычитан (импорты, имена полей схемы, типы), **но НЕ прогнан через typecheck/lint/test** — `device_bash` был недоступен весь сеанс ("Workspace unavailable. The isolated Linux environment on this device failed to start"), поэтому у меня не было возможности выполнить `npm run typecheck`/`lint`/тесты на машине пользователя. Работа сделана прямо в `ustal-foundation` (не в `ustal-claude`) — пользователь явно выбрал это через диалог, т.к. `ustal-claude` оказался на устаревшем коде (нет `account.tsx`, другой `HomeHeader.tsx` и т.д.), не синхронизированным с уже сделанной ранее работой.

Контекст/обоснование каждого пункта — `claude/store-compliance-audit.md` в Cowork Project пользователя (не в этом репозитории).

### Что нужно проверить (точные команды)

```bash
cd C:\Users\User\Desktop\ustal-foundation
npm run typecheck   # особенно apps/mobile, apps/api, packages/validation, packages/database
npm run lint
npm test            # apps/api — есть existing tests в src/index.test.ts, возможно стоит добавить тест на DELETE /me
```

Если в монорепо typecheck/lint per-workspace — прогнать отдельно для `apps/mobile`, `apps/api`, `packages/validation`.

### CHANGED FILES

Backend (`apps/api`):
- `apps/api/src/routes/me.ts` — новый `DELETE /me` (мягкое удаление: `status='deleted'`, обезличивание телефона/профиля, отзыв сессий и push-устройств, запись в `audit_logs`). Требует пароль повторно.
- `apps/api/src/routes/legal.ts` — новый, `GET /legal/delete-account` — публичная HTML-страница с инструкцией по удалению без входа в приложение (требование Google Play — веб-ссылка для Data Safety формы).
- `apps/api/src/app.ts` — зарегистрирован `legalRoutes`.

Валидация (`packages/validation`):
- `packages/validation/src/auth.ts` — добавлена `deleteAccountSchema` (`{ password: string }`).

Мобильное приложение (`apps/mobile`):
- `src/api/auth.ts` — `RegisterPayload` теперь требует реальные `acceptedRules`/`acceptedPdn` (раньше хардкодились `true` в вызывающем коде); добавлена `deleteAccount(password)`.
- `app/(auth)/register.tsx` — два чекбокса согласия (`ConsentCheckbox`), кнопка регистрации заблокирована, пока оба не отмечены, ссылки на `/legal/terms` и `/legal/privacy`.
- `src/components/ConsentCheckbox.tsx` — новый.
- `src/components/LegalTextScreen.tsx` — новый, общий экран для показа юридического текста.
- `app/legal/privacy.tsx`, `app/legal/terms.tsx` — новые роуты (Expo Router file-based, регистрации в `_layout.tsx` не требуют — подтверждено по аналогии с существующим `settings.tsx`).
- `src/legal/content.ts` — новый, тексты Terms/Privacy. **ВАЖНО: содержит плейсхолдеры `[ORGANIZATION_NAME]`, `[LEGAL_ADDRESS]` и предположительный `support@ustal.app`** — нужно подставить реальные юридические данные владельца продукта перед публикацией в сторах, в идеале показать юристу на соответствие 152-ФЗ.
- `app/(tabs)/account.tsx` — добавлены пункты «Политика конфиденциальности», «Правила использования», «Удалить аккаунт».
- `app/delete-account.tsx` — новый экран подтверждения удаления (пароль обязателен), визуально по образцу существующего подтверждения logout.

### Что НЕ менялось
API/бизнес-логика вне трёх пунктов аудита не трогалась (задача была явно про интерфейс+compliance). `apps/api/src/routes/auth.ts` не менялся — он уже корректно писал `acceptedRulesAt`/`acceptedPdnAt` при регистрации, проблема была только в том, что мобильный клиент раньше слал хардкод `true` без реального согласия пользователя.

### Открытые вопросы для владельца продукта (не блокируют typecheck, но блокируют публикацию)
1. Реальное название организации/ИП и юридический адрес → `src/legal/content.ts`.
2. Реальный support email (сейчас `support@ustal.app` — предположение, не подтверждено).
3. Юридическая вычитка текста Terms/Privacy на соответствие 152-ФЗ.

---
