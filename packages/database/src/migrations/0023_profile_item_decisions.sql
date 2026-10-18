CREATE TABLE "profile_item_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action" varchar(10) NOT NULL,
	"family" varchar(20) NOT NULL,
	"identity" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"profile_version" integer NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_item_decisions" ADD CONSTRAINT "profile_item_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_item_decisions_user_idx" ON "profile_item_decisions" USING btree ("user_id","decided_at");