-- Columna para identificar cada celular (miembro de mesa)
-- Supabase → SQL Editor → Run

ALTER TABLE public.queue_items
  ADD COLUMN IF NOT EXISTS added_by_device text;

CREATE INDEX IF NOT EXISTS queue_items_device_added_at_idx
  ON public.queue_items (venue_id, added_by_device, added_at desc);

CREATE INDEX IF NOT EXISTS queue_items_table_added_at_idx
  ON public.queue_items (venue_id, added_by_table, added_at desc);
