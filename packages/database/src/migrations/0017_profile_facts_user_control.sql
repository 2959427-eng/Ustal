ALTER TABLE "profile_facts" DROP CONSTRAINT "profile_facts_status_check";--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "user_decision" varchar(10);--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "user_value" jsonb;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "visibility" varchar(10) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_source_inputs" ADD COLUMN "facts_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_user_decision_check" CHECK ("profile_facts"."user_decision" is null or "profile_facts"."user_decision" in ('confirmed','corrected','revoked'));--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_revoked_check" CHECK (("profile_facts"."status" = 'revoked') = (coalesce("profile_facts"."user_decision", '') = 'revoked'));--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_user_value_check" CHECK (("profile_facts"."user_value" is null) = (coalesce("profile_facts"."user_decision", '') <> 'corrected'));--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_visibility_check" CHECK ("profile_facts"."visibility" in ('private','shareable'));--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_status_check" CHECK ("profile_facts"."status" in ('active','superseded','replaced','revoked'));