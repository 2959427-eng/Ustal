CREATE TABLE "profile_fact_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_input_id" uuid NOT NULL,
	"pipeline_version" varchar(50) NOT NULL,
	"prompt_version" varchar(30) NOT NULL,
	"model" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"facts_count" integer,
	"rejected_count" integer,
	"error" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "profile_fact_extractions_status_check" CHECK ("profile_fact_extractions"."status" in ('pending','succeeded','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "profile_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_input_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"fact_type" varchar(40) NOT NULL,
	"slot_key" varchar(200) NOT NULL,
	"value" jsonb NOT NULL,
	"evidence" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"assertion" varchar(10) NOT NULL,
	"status" varchar(20) NOT NULL,
	"superseded_by_fact_id" uuid,
	"replaces_fact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_facts_status_check" CHECK ("profile_facts"."status" in ('active','superseded','replaced')),
	CONSTRAINT "profile_facts_assertion_check" CHECK ("profile_facts"."assertion" in ('explicit','inferred')),
	CONSTRAINT "profile_facts_confidence_check" CHECK ("profile_facts"."confidence" >= 0 and "profile_facts"."confidence" <= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "profile_fact_extractions_id_user_unique" ON "profile_fact_extractions" USING btree ("id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "profile_source_inputs_id_user_unique" ON "profile_source_inputs" USING btree ("id","user_id");
--> statement-breakpoint
ALTER TABLE "profile_fact_extractions" ADD CONSTRAINT "profile_fact_extractions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "profile_fact_extractions" ADD CONSTRAINT "profile_fact_extractions_source_owner_fk" FOREIGN KEY ("source_input_id","user_id") REFERENCES "public"."profile_source_inputs"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_superseded_by_fact_id_profile_facts_id_fk" FOREIGN KEY ("superseded_by_fact_id") REFERENCES "public"."profile_facts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_replaces_fact_id_profile_facts_id_fk" FOREIGN KEY ("replaces_fact_id") REFERENCES "public"."profile_facts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_source_owner_fk" FOREIGN KEY ("source_input_id","user_id") REFERENCES "public"."profile_source_inputs"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_extraction_owner_fk" FOREIGN KEY ("extraction_id","user_id") REFERENCES "public"."profile_fact_extractions"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "profile_fact_extractions_version_unique" ON "profile_fact_extractions" USING btree ("source_input_id","pipeline_version","prompt_version","model");
--> statement-breakpoint
CREATE INDEX "profile_fact_extractions_user_status_idx" ON "profile_fact_extractions" USING btree ("user_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "profile_facts_active_slot_unique" ON "profile_facts" USING btree ("user_id","slot_key") WHERE "profile_facts"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "profile_facts_user_slot_idx" ON "profile_facts" USING btree ("user_id","slot_key");
--> statement-breakpoint
CREATE INDEX "profile_facts_source_idx" ON "profile_facts" USING btree ("source_input_id");
--> statement-breakpoint
CREATE INDEX "profile_facts_extraction_idx" ON "profile_facts" USING btree ("extraction_id");
