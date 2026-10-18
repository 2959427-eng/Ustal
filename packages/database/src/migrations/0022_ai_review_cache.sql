CREATE TABLE "ai_review_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" varchar(64) NOT NULL,
	"review_type" varchar(50) NOT NULL,
	"model" varchar(100) NOT NULL,
	"prompt_version" varchar(60) NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_review_cache_key_unique" ON "ai_review_cache" USING btree ("cache_key");