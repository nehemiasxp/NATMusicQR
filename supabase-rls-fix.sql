-- NATMusicQR: políticas RLS para prototipo
-- Ejecutar en Supabase → SQL Editor

-- Lectura (por si no existen)
DO $$ BEGIN
  CREATE POLICY "venues_select_all" ON public.venues
    FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "videos_select_all" ON public.videos
    FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "queue_items_select_all" ON public.queue_items
    FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Escritura necesaria para jukebox
DO $$ BEGIN
  CREATE POLICY "queue_items_insert_all" ON public.queue_items
    FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "queue_items_update_all" ON public.queue_items
    FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "videos_update_all" ON public.videos
    FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "videos_insert_all" ON public.videos
    FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Corregir youtube_ids de prueba inválidos
UPDATE public.videos
SET youtube_id = 'dQw4w9WgXcQ',
    thumbnail_url = 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
WHERE youtube_id = 'dQw4w9wgccc';

UPDATE public.videos
SET youtube_id = 'kJQP7kiw5Fk',
    thumbnail_url = 'https://img.youtube.com/vi/kJQP7kiw5Fk/hqdefault.jpg'
WHERE youtube_id = '3JZ_D3ELwOQ';

-- Realtime (opcional; también se activa en Dashboard → Database → Replication)
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.queue_items;
