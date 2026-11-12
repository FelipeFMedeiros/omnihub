-- Os nove IDs do seed são fictícios, não anúncios autorizados.
-- Preserva catálogo/saldos e desativa apenas esses vínculos históricos exatos.
UPDATE spoke_mappings
SET sync_enabled = 'N'
WHERE external_item_id ~ '^sandbox-(mercado_livre|shopee|amazon)-[1-3]$';
