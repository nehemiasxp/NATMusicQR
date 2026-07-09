-- Comentarios + burbujas de like/dislike en TV (feed efímero)
-- Supabase → SQL Editor → Run

CREATE TABLE IF NOT EXISTS public.live_feed (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('comment', 'like', 'dislike')),
  body text,
  display_name text NOT NULL,
  table_label text,
  device_id text NOT NULL,
  queue_item_id uuid REFERENCES public.queue_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_feed_venue_created_idx
  ON public.live_feed (venue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS live_feed_device_created_idx
  ON public.live_feed (venue_id, device_id, created_at DESC);

ALTER TABLE public.live_feed ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_feed_select_all" ON public.live_feed;
CREATE POLICY "live_feed_select_all" ON public.live_feed
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "live_feed_insert_all" ON public.live_feed;
CREATE POLICY "live_feed_insert_all" ON public.live_feed
  FOR INSERT WITH CHECK (true);

-- Realtime opcional (el player también hace poll)
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.live_feed;

-- Limpieza opcional (más de 2 h): puedes programar un cron en Supabase
-- DELETE FROM public.live_feed WHERE created_at < now() - interval '2 hours';
