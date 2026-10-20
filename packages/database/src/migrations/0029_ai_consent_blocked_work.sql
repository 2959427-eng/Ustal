-- Dormant sidecar only. No queue writes, policy grants or copied source data.
CREATE TABLE "ai_consent_blocked_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_key" text NOT NULL,
	"kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"source_version_hash" text NOT NULL,
	"subject_user_ids" uuid[] NOT NULL,
	"purpose" text NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_hash" text NOT NULL,
	"recipient_binding" text NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"wake_seq" integer DEFAULT 0 NOT NULL,
	"next_probe_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_consent_blocked_kind" CHECK ("ai_consent_blocked_work"."kind" IN ('profile_transcribe','profile_extract','profile_facts','profile_rebuild','embedding_refresh','order_transcribe','order_extract','matching_run')),
	CONSTRAINT "ai_consent_blocked_state" CHECK ("ai_consent_blocked_work"."state" IN ('waiting','ready','leased','enqueued','obsolete')),
	CONSTRAINT "ai_consent_blocked_reason" CHECK ("ai_consent_blocked_work"."reason" IN ('consent_required','policy_unavailable')),
	CONSTRAINT "ai_consent_blocked_hashes" CHECK ("ai_consent_blocked_work"."logical_key" ~ '^[a-f0-9]{64}$' AND "ai_consent_blocked_work"."source_version_hash" ~ '^[a-f0-9]{64}$' AND "ai_consent_blocked_work"."policy_hash" ~ '^[a-f0-9]{64}$' AND "ai_consent_blocked_work"."recipient_binding" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ai_consent_blocked_bounds" CHECK ("ai_consent_blocked_work"."attempts">=0 AND "ai_consent_blocked_work"."wake_seq">=0 AND cardinality("ai_consent_blocked_work"."subject_user_ids") BETWEEN 1 AND 100 AND "ai_consent_blocked_work"."purpose" ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'),
	CONSTRAINT "ai_consent_blocked_lease" CHECK (("ai_consent_blocked_work"."state"='leased' AND "ai_consent_blocked_work"."lease_token" IS NOT NULL AND "ai_consent_blocked_work"."lease_until" IS NOT NULL) OR ("ai_consent_blocked_work"."state"<>'leased' AND "ai_consent_blocked_work"."lease_token" IS NULL AND "ai_consent_blocked_work"."lease_until" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_consent_blocked_logical_unique" ON "ai_consent_blocked_work" USING btree ("logical_key");--> statement-breakpoint
CREATE INDEX "ai_consent_blocked_due" ON "ai_consent_blocked_work" USING btree ("next_probe_at","created_at","id") WHERE "ai_consent_blocked_work"."state"='ready';--> statement-breakpoint
CREATE INDEX "ai_consent_blocked_expired" ON "ai_consent_blocked_work" USING btree ("lease_until","created_at","id") WHERE "ai_consent_blocked_work"."state"='leased';--> statement-breakpoint
CREATE INDEX "ai_consent_blocked_subjects" ON "ai_consent_blocked_work" USING gin ("subject_user_ids");--> statement-breakpoint
CREATE INDEX "ai_consent_blocked_source" ON "ai_consent_blocked_work" USING btree ("kind","source_id");
--> statement-breakpoint
CREATE FUNCTION ustal_consent_blocked_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; st text; canonical uuid[];
BEGIN
  -- Identity is immutable: source/subject changes create a new logical intent instead.
  IF TG_OP='UPDATE' THEN
    IF (NEW.logical_key,NEW.kind,NEW.source_id,NEW.execution_id,NEW.source_version_hash,NEW.subject_user_ids,NEW.purpose,NEW.policy_id,NEW.policy_hash,NEW.recipient_binding,NEW.created_at)
      IS DISTINCT FROM (OLD.logical_key,OLD.kind,OLD.source_id,OLD.execution_id,OLD.source_version_hash,OLD.subject_user_ids,OLD.purpose,OLD.policy_id,OLD.policy_hash,OLD.recipient_binding,OLD.created_at) THEN
      RAISE EXCEPTION 'blocked work identity is immutable' USING ERRCODE='UX014';
    END IF;
    RETURN NEW; -- Ordinary lease/ack/wake MUST NOT acquire user locks.
  END IF;
  SELECT array_agg(id ORDER BY id) INTO canonical FROM (SELECT DISTINCT unnest(NEW.subject_user_ids) id) s;
  IF canonical IS NULL OR cardinality(canonical) NOT BETWEEN 1 AND 100 OR array_position(canonical,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid blocked work subjects' USING ERRCODE='UX014';
  END IF;
  NEW.subject_user_ids := canonical;
  -- Consistent sorted user-before-sidecar order. No user locks over HTTP or ordinary state updates.
  FOREACH subject IN ARRAY canonical LOOP
    SELECT status INTO st FROM users WHERE id=subject FOR UPDATE;
    IF st IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'account is not active' USING ERRCODE='UX001'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_consent_blocked_subject_guard BEFORE INSERT OR UPDATE ON ai_consent_blocked_work
FOR EACH ROW EXECUTE FUNCTION ustal_consent_blocked_subject_guard();
--> statement-breakpoint
CREATE FUNCTION ustal_consent_blocked_deleted_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    DELETE FROM ai_consent_blocked_work WHERE subject_user_ids @> ARRAY[NEW.id];
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_consent_blocked_deleted_cleanup AFTER UPDATE OF status ON users
FOR EACH ROW EXECUTE FUNCTION ustal_consent_blocked_deleted_cleanup();
