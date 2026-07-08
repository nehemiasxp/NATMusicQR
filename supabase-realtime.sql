-- Habilitar Realtime en queue_items (opcional; el player ya hace polling cada 3s)
-- Supabase → SQL Editor → Run

ALTER PUBLICATION supabase_realtime ADD TABLE public.queue_items;
