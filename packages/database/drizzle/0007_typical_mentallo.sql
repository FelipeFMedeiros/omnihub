ALTER TABLE "erp_destinations" ADD COLUMN "endpoint_origin" varchar(200);--> statement-breakpoint
ALTER TABLE "erp_destinations" ADD CONSTRAINT "erp_destinations_endpoint_origin_unique" UNIQUE("endpoint_origin");--> statement-breakpoint
ALTER TABLE "erp_destinations" ADD CONSTRAINT "erp_destinations_endpoint" CHECK (("erp_destinations"."state" <> 'ACTIVE' OR "erp_destinations"."endpoint_origin" IS NOT NULL) AND ("erp_destinations"."endpoint_origin" IS NULL OR "erp_destinations"."endpoint_origin" ~ '^http://127[.]0[.]0[.]1:[0-9]{1,5}$'));CREATE FUNCTION protect_erp_destination() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS (SELECT 1 FROM erp_dispatches WHERE erp_destination_id=OLD.id) AND (
   (NEW.id,NEW.workspace_id,NEW.config_key) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.config_key)
   OR (NEW.endpoint_origin IS DISTINCT FROM OLD.endpoint_origin AND OLD.endpoint_origin IS NOT NULL)
 ) THEN RAISE EXCEPTION 'used ERP destination identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER erp_destination_immutable BEFORE UPDATE ON erp_destinations FOR EACH ROW EXECUTE FUNCTION protect_erp_destination();
