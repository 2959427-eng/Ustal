ALTER TABLE "order_assignments" ADD COLUMN "executor_report" varchar(20);
--> statement-breakpoint
ALTER TABLE "order_assignments" ADD COLUMN "executor_report_at" timestamp with time zone;
