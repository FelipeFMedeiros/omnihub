CREATE TABLE "connection_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"envelope" text,
	"status" varchar(20) DEFAULT 'STARTED' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_authorizations_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "authorization_status" CHECK ("connection_authorizations"."status" IN ('STARTED','EXCHANGING','PENDING','CONFIRMED','FAILED'))
);
--> statement-breakpoint
CREATE TABLE "connection_credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" varchar(100) NOT NULL,
	"envelope" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"phase" varchar(20) DEFAULT 'READY' NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_revision_phase" CHECK ("connection_credentials"."revision" > 0 AND "connection_credentials"."phase" IN ('READY','ROTATING'))
);
--> statement-breakpoint
CREATE TABLE "connection_imports" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_digest" varchar(64) NOT NULL,
	"verification_reference" varchar(200) NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_imports_source_digest_unique" UNIQUE("source_digest")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credential_state" varchar(25) DEFAULT 'NOT_CONNECTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "check_status" varchar(30);--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "check_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "connection_authorizations" ADD CONSTRAINT "connection_authorizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_authorizations" ADD CONSTRAINT "connection_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_authorizations" ADD CONSTRAINT "connection_authorizations_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_authorizations" ADD CONSTRAINT "authorization_connection_scope" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_credentials" ADD CONSTRAINT "connection_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_credentials" ADD CONSTRAINT "credentials_connection_scope" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_imports" ADD CONSTRAINT "connection_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_imports" ADD CONSTRAINT "import_connection_scope" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authorization_session_connection" ON "connection_authorizations" USING btree ("session_id","connection_id");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credentials_state" CHECK ("connections"."credential_state" IN ('NOT_CONNECTED','CONNECTED','REAUTH_REQUIRED','ERROR') AND "connections"."generation" >= 0);