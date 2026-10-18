CREATE TABLE "profile_input_recovery" (
	"source_input_id" uuid NOT NULL,
	"stage" varchar(20) NOT NULL,
	"user_id" uuid NOT NULL,
	"state" varchar(20) DEFAULT 'processing' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"first_failed_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"lease_owner" varchar(100),
	"manual_resets" integer DEFAULT 0 NOT NULL,
	"manual_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_input_recovery_source_input_id_stage_pk" PRIMARY KEY("source_input_id","stage"),
	CONSTRAINT "profile_input_recovery_stage_check" CHECK ("profile_input_recovery"."stage" in ('transcribe', 'extraction')),
	CONSTRAINT "profile_input_recovery_state_check" CHECK ("profile_input_recovery"."state" in ('processing', 'retrying', 'exhausted', 'succeeded'))
);
--> statement-breakpoint
ALTER TABLE "profile_input_recovery" ADD CONSTRAINT "profile_input_recovery_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_recovery" ADD CONSTRAINT "profile_input_recovery_source_input_fk" FOREIGN KEY ("source_input_id") REFERENCES "public"."profile_source_inputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_input_recovery_state_idx" ON "profile_input_recovery" USING btree ("state");