ALTER TABLE "matching_facts" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "matching_facts" ADD COLUMN "attributes" jsonb DEFAULT '[]'::jsonb NOT NULL;