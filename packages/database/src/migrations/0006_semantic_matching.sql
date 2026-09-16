CREATE TABLE "matching_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"order_id" uuid,
	"processing_version" varchar(100) NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"source_text" text NOT NULL,
	"embedding_model" varchar(100) NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"phrase" text NOT NULL,
	"evidence" text NOT NULL,
	"node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"mandatory" boolean NOT NULL,
	"start_hour" integer,
	"end_hour" integer,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "matching_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"matching_run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" varchar(30) NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rematch_requests" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cursor" uuid
);
--> statement-breakpoint
ALTER TABLE "capability_profiles" ADD COLUMN "source_input_id" uuid;--> statement-breakpoint
ALTER TABLE "matching_documents" ADD CONSTRAINT "matching_documents_profile_id_capability_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."capability_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_documents" ADD CONSTRAINT "matching_documents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_facts" ADD CONSTRAINT "matching_facts_document_id_matching_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."matching_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_traces" ADD CONSTRAINT "matching_traces_matching_run_id_matching_runs_id_fk" FOREIGN KEY ("matching_run_id") REFERENCES "public"."matching_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_traces" ADD CONSTRAINT "matching_traces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rematch_requests" ADD CONSTRAINT "rematch_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "matching_docs_profile_version" ON "matching_documents" USING btree ("profile_id","processing_version","source_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_docs_order_version" ON "matching_documents" USING btree ("order_id","processing_version","source_hash");--> statement-breakpoint
CREATE INDEX "matching_facts_document_idx" ON "matching_facts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "matching_traces_run_idx" ON "matching_traces" USING btree ("matching_run_id");--> statement-breakpoint
ALTER TABLE "capability_profiles" ADD CONSTRAINT "capability_profiles_source_input_id_profile_source_inputs_id_fk" FOREIGN KEY ("source_input_id") REFERENCES "public"."profile_source_inputs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE matching_documents ADD CONSTRAINT matching_document_one_owner CHECK ((profile_id IS NOT NULL)::int + (order_id IS NOT NULL)::int = 1);
--> statement-breakpoint
CREATE INDEX user_profiles_city_matching_idx ON user_profiles(city_id,user_id);
--> statement-breakpoint
CREATE INDEX capability_profiles_applied_matching_idx ON capability_profiles(user_id,profile_version DESC) WHERE status='applied';
--> statement-breakpoint
CREATE UNIQUE INDEX capability_profiles_source_once_idx ON capability_profiles(source_input_id) WHERE source_input_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX orders_open_city_matching_idx ON orders(city_id,id) WHERE status='published';
--> statement-breakpoint
CREATE INDEX user_capabilities_node_profile_idx ON user_capabilities(ontology_node_id,capability_profile_id);
--> statement-breakpoint
CREATE INDEX matching_documents_profile_current_idx ON matching_documents(profile_id,created_at DESC);
--> statement-breakpoint
CREATE INDEX matching_documents_order_current_idx ON matching_documents(order_id,created_at DESC);
--> statement-breakpoint
CREATE INDEX matching_runs_completed_idx ON matching_runs(order_id,started_at DESC) WHERE completed_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX profile_embeddings_cosine_hnsw_idx ON profile_embeddings USING hnsw(embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX matching_facts_cosine_hnsw_idx ON matching_facts USING hnsw(embedding vector_cosine_ops);
