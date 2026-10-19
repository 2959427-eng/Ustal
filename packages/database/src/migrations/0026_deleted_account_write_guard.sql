-- 2026-10-19 (Codex audit удаления аккаунта): удалённый аккаунт не получает новых записей ни при каком
-- порядке событий. Триггер читает users.status под FOR KEY SHARE — ту же блокировку, что FK берёт и так (новой
-- конкуренции нет), поэтому идущее удаление (SELECT … FOR UPDATE) и запись строго упорядочены:
--   * удаление успело первым → запись видит status='deleted': пользовательские записи отклоняются (SQLSTATE
--     UX001 → API 401), производные строки matching/очередей тихо пропускаются (RETURN NULL), чтобы не ронять
--     прогон matching или действие другого пользователя;
--   * запись успела первой → удаление ждёт её commit и закрывает/удаляет её.
-- Только CREATE FUNCTION / CREATE TRIGGER: данные не меняются, откат — DROP TRIGGER/FUNCTION.
CREATE OR REPLACE FUNCTION ustal_guard_deleted_user() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  uid uuid;
  st text;
BEGIN
  EXECUTE format('SELECT ($1).%I::uuid', TG_ARGV[0]) USING NEW INTO uid;
  IF uid IS NULL THEN RETURN NEW; END IF;
  SELECT status INTO st FROM users WHERE id = uid FOR KEY SHARE;
  IF st IS DISTINCT FROM 'deleted' THEN RETURN NEW; END IF;
  IF TG_ARGV[1] = 'skip' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'account is deleted' USING ERRCODE = 'UX001';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "responses_executor_id_not_deleted" BEFORE INSERT ON "responses" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('executor_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "orders_author_id_not_deleted" BEFORE INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('author_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "order_assignments_executor_id_not_deleted" BEFORE INSERT ON "order_assignments" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('executor_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "contact_unlocks_customer_id_not_deleted" BEFORE INSERT ON "contact_unlocks" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('customer_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "contact_unlocks_executor_id_not_deleted" BEFORE INSERT ON "contact_unlocks" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('executor_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "profile_source_inputs_user_id_not_deleted" BEFORE INSERT ON "profile_source_inputs" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "capability_profiles_user_id_not_deleted" BEFORE INSERT ON "capability_profiles" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "profile_fact_extractions_user_id_not_deleted" BEFORE INSERT ON "profile_fact_extractions" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "profile_facts_user_id_not_deleted" BEFORE INSERT ON "profile_facts" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "profile_item_decisions_user_id_not_deleted" BEFORE INSERT ON "profile_item_decisions" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "media_owner_id_not_deleted" BEFORE INSERT ON "media" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('owner_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "device_installations_user_id_not_deleted" BEFORE INSERT ON "device_installations" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "user_sessions_user_id_not_deleted" BEFORE INSERT ON "user_sessions" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "idempotency_keys_user_id_not_deleted" BEFORE INSERT ON "idempotency_keys" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "reviews_from_user_id_not_deleted" BEFORE INSERT ON "reviews" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('from_user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "order_ratings_from_user_id_not_deleted" BEFORE INSERT ON "order_ratings" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('from_user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "reports_reporter_id_not_deleted" BEFORE INSERT ON "reports" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('reporter_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "blocks_blocker_id_not_deleted" BEFORE INSERT ON "blocks" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('blocker_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "user_profiles_user_id_not_deleted" BEFORE UPDATE ON "user_profiles" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'raise');
--> statement-breakpoint
CREATE TRIGGER "matching_candidates_user_id_skip_deleted" BEFORE INSERT ON "matching_candidates" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'skip');
--> statement-breakpoint
CREATE TRIGGER "matching_traces_user_id_skip_deleted" BEFORE INSERT ON "matching_traces" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'skip');
--> statement-breakpoint
CREATE TRIGGER "rematch_requests_user_id_skip_deleted" BEFORE INSERT ON "rematch_requests" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'skip');
--> statement-breakpoint
CREATE TRIGGER "learned_preferences_user_id_skip_deleted" BEFORE INSERT ON "learned_preferences" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'skip');
--> statement-breakpoint
CREATE TRIGGER "profile_embedding_refresh_requests_user_id_skip_deleted" BEFORE INSERT ON "profile_embedding_refresh_requests" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'skip');
--> statement-breakpoint
CREATE TRIGGER "profile_input_recovery_user_id_skip_deleted" BEFORE INSERT ON "profile_input_recovery" FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'skip');
