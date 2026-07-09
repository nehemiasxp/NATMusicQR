-- Permitir borrar canciones de la biblioteca desde /admin
-- Supabase → SQL Editor → Run

DROP POLICY IF EXISTS "videos_delete_all" ON public.videos;
CREATE POLICY "videos_delete_all" ON public.videos
  FOR DELETE USING (true);

-- Si al borrar un video falla por FK en queue_items:
-- las filas de cola con ese video_id se intentan borrar antes desde la API.
-- Opcional: CASCADE en la FK (solo si tu esquema lo permite)
-- ALTER TABLE public.queue_items
--   DROP CONSTRAINT IF EXISTS queue_items_video_id_fkey,
--   ADD CONSTRAINT queue_items_video_id_fkey
--     FOREIGN KEY (video_id) REFERENCES public.videos(id) ON DELETE CASCADE;
