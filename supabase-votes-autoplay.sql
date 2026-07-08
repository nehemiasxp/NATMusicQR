-- Votos 👍/👎 por canción en reproducción
-- Supabase → SQL Editor → Run

CREATE TABLE IF NOT EXISTS public.song_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  queue_item_id uuid NOT NULL REFERENCES public.queue_items(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  vote text NOT NULL CHECK (vote IN ('up', 'down')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue_item_id, device_id)
);

CREATE INDEX IF NOT EXISTS song_votes_queue_idx
  ON public.song_votes (queue_item_id);

CREATE INDEX IF NOT EXISTS song_votes_venue_idx
  ON public.song_votes (venue_id, created_at DESC);

ALTER TABLE public.song_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "song_votes_select_all" ON public.song_votes;
CREATE POLICY "song_votes_select_all" ON public.song_votes
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "song_votes_insert_all" ON public.song_votes;
CREATE POLICY "song_votes_insert_all" ON public.song_votes
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "song_votes_update_all" ON public.song_votes;
CREATE POLICY "song_votes_update_all" ON public.song_votes
  FOR UPDATE USING (true) WITH CHECK (true);

-- Realtime opcional
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.song_votes;
