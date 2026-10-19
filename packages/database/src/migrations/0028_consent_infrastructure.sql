CREATE TABLE "consent_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_hash" text NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_decision_kind" CHECK ("consent_decisions"."decision" IN ('grant', 'revoke')),
	CONSTRAINT "consent_decision_actor" CHECK ("consent_decisions"."actor_user_id" = "consent_decisions"."user_id"),
	CONSTRAINT "consent_decision_seq_positive" CHECK ("consent_decisions"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "consent_disclosures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"version" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_disclosure_status" CHECK ("consent_disclosures"."status" IN ('draft', 'approved', 'retired')),
	CONSTRAINT "consent_disclosure_hash" CHECK ("consent_disclosures"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "consent_decisions" ADD CONSTRAINT "consent_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_decisions" ADD CONSTRAINT "consent_decisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_decisions" ADD CONSTRAINT "consent_decisions_policy_id_consent_disclosures_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."consent_disclosures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_decision_user_seq" ON "consent_decisions" USING btree ("user_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_disclosure_purpose_version" ON "consent_disclosures" USING btree ("purpose","version");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_disclosure_current_purpose" ON "consent_disclosures" USING btree ("purpose") WHERE "consent_disclosures"."is_current";
--> statement-breakpoint
-- Evidence survives account anonymization as pseudonymous legal evidence. No legacy grants/backfill.
-- Retention approval remains separate; this migration does not claim outbound enforcement.
CREATE FUNCTION ustal_consent_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent evidence is append only' USING ERRCODE='UX012';
END $$;
--> statement-breakpoint
CREATE TRIGGER consent_decisions_append_only BEFORE UPDATE OR DELETE ON consent_decisions
FOR EACH ROW EXECUTE FUNCTION ustal_consent_append_only();
--> statement-breakpoint
CREATE FUNCTION ustal_consent_disclosure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.purpose, NEW.version, NEW.content, NEW.content_hash, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.purpose, OLD.version, OLD.content, OLD.content_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'disclosure content is immutable; create a new version' USING ERRCODE='UX012';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER consent_disclosures_immutable BEFORE UPDATE ON consent_disclosures
FOR EACH ROW EXECUTE FUNCTION ustal_consent_disclosure_immutable();
--> statement-breakpoint
CREATE FUNCTION ustal_consent_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; expected integer; p consent_disclosures%ROWTYPE;
BEGIN
  SELECT status INTO st FROM users WHERE id=NEW.user_id FOR UPDATE;
  IF st IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'account is not active' USING ERRCODE='UX001'; END IF;
  SELECT coalesce(max(seq), 0)+1 INTO expected FROM consent_decisions WHERE user_id=NEW.user_id;
  IF NEW.seq <> expected THEN RAISE EXCEPTION 'consent revision conflict' USING ERRCODE='UX011'; END IF;
  SELECT * INTO p FROM consent_disclosures WHERE id=NEW.policy_id FOR SHARE;
  IF NOT FOUND OR p.content_hash <> NEW.policy_hash OR
     (NEW.decision='grant' AND (p.status <> 'approved' OR NOT p.is_current)) THEN
    RAISE EXCEPTION 'disclosure not grantable or hash mismatch' USING ERRCODE='UX010';
  END IF;
  -- Server-generated evidence: callers cannot supply another decision timestamp.
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER consent_decisions_guard BEFORE INSERT ON consent_decisions
FOR EACH ROW EXECUTE FUNCTION ustal_consent_decision_guard();
