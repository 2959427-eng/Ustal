CREATE TABLE "media_cleanup_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_cleanup_storage_unique" ON "media_cleanup_requests" USING btree ("storage_provider","storage_key");--> statement-breakpoint
CREATE INDEX "media_cleanup_due_idx" ON "media_cleanup_requests" USING btree ("storage_provider","next_attempt_at");
--> statement-breakpoint
-- A notification is derived data: skip a late insert without failing the other user's committed action.
CREATE TRIGGER "notifications_user_id_skip_deleted" BEFORE INSERT ON "notifications"
FOR EACH ROW EXECUTE FUNCTION ustal_guard_deleted_user('user_id', 'skip');
