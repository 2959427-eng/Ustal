ALTER TABLE "user_sessions" ADD COLUMN "family_id" uuid;
--> statement-breakpoint
UPDATE "user_sessions" SET "family_id" = "id" WHERE "family_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "user_sessions" ALTER COLUMN "family_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX "user_sessions_family_id_idx" ON "user_sessions" USING btree ("family_id");
