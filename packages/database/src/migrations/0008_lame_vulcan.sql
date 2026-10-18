ALTER TABLE "matching_facts" ADD COLUMN "constraint_type" varchar(30) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "matching_facts" ADD COLUMN "constraint_scope" varchar(30) DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "matching_facts" ADD COLUMN "resource_role" varchar(30) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "matching_facts" ADD COLUMN "resource_capacity" jsonb DEFAULT '{}'::jsonb NOT NULL;