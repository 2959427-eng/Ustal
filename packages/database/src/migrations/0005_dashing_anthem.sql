ALTER TABLE "capability_profiles" ADD COLUMN "status" varchar(20) DEFAULT 'applied' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "transcript" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "source_status" varchar(20) DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_source_inputs" ADD COLUMN "status" varchar(20) DEFAULT 'confirmed' NOT NULL;