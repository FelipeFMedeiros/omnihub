CREATE TABLE "legacy_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"replaced_empty_workspace_id" uuid NOT NULL,
	"verification_reference" varchar(200) NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_claims_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "legacy_claim_verification_nonempty" CHECK (length(btrim("legacy_claims"."verification_reference")) >= 8)
);
--> statement-breakpoint
ALTER TABLE "legacy_claims" ADD CONSTRAINT "legacy_claims_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_claims" ADD CONSTRAINT "legacy_claims_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE erp_dispatches DROP CONSTRAINT dispatch_payload_key;
--> statement-breakpoint
ALTER TABLE erp_dispatches ADD CONSTRAINT dispatch_payload_key CHECK (payload ? 'codigo_pedido' AND jsonb_typeof(payload->'codigo_pedido') = 'string' AND payload->>'codigo_pedido' = external_idempotency_key);
