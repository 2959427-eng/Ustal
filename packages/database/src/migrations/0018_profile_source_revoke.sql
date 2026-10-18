ALTER TABLE "profile_source_inputs" RENAME COLUMN "facts_revoked_at" TO "revoked_at";--> statement-breakpoint
-- A draft invalidated by a source revoke/rebuild must not block re-extracting its (non-revoked) message.
DROP INDEX IF EXISTS "capability_profiles_source_once_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "capability_profiles_source_once_idx" ON "capability_profiles" ("source_input_id") WHERE "source_input_id" IS NOT NULL AND "status" <> 'invalidated';
