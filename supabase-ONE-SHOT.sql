-- ============================================================
-- NATMusicQR — UN SOLO SCRIPT (cópialo TODO y dale Run)
-- Supabase Dashboard → SQL Editor → New query → Run
-- ============================================================

-- 1) Quitar RLS de videos un momento (el SQL Editor corre como dueño)
ALTER TABLE public.videos DISABLE ROW LEVEL SECURITY;

-- 2) Reemplazar catálogo de prueba por TUS 4 canciones
UPDATE public.videos SET
  youtube_id = 'qCiUu8pshxM',
  title = 'VENGO SOLTERITO | Los Apus | Electro Carnavales',
  artist = 'Ceron Producciones',
  category = 'Electro',
  is_active = true,
  thumbnail_url = 'https://img.youtube.com/vi/qCiUu8pshxM/hqdefault.jpg'
WHERE id = '3b643440-76ab-44a8-9079-110f50704a96';

UPDATE public.videos SET
  youtube_id = 'NyABPr7y0KQ',
  title = 'SAQRA CARNAVAL - Florcita Villano (Electro TikTok)',
  artist = 'MixMaestro',
  category = 'Electro',
  is_active = true,
  thumbnail_url = 'https://img.youtube.com/vi/NyABPr7y0KQ/hqdefault.jpg'
WHERE id = 'ad2aef3e-e758-4817-88f9-d50c329e618f';

UPDATE public.videos SET
  youtube_id = '8-XWZ6x4-LQ',
  title = 'Electro Carnaval (Sacclaya)',
  artist = 'Mix',
  category = 'Electro',
  is_active = true,
  thumbnail_url = 'https://img.youtube.com/vi/8-XWZ6x4-LQ/hqdefault.jpg'
WHERE id = '80b4b735-de8b-42cd-9d63-541ae35c4f1a';

UPDATE public.videos SET
  youtube_id = '5CJQCucoI3w',
  title = 'PASAME LA BOTELLA - Rosita Corazon (Electro)',
  artist = 'MixMaestro',
  category = 'Electro',
  is_active = true,
  thumbnail_url = 'https://img.youtube.com/vi/5CJQCucoI3w/hqdefault.jpg'
WHERE id = '86eb8e74-309e-498c-b80f-9578382331b8';

-- Duplicados apagados
UPDATE public.videos SET is_active = false
WHERE id IN (
  '340f8504-382b-4abb-9341-501e74598505',
  'c7b05d99-78a1-4dff-b8c4-b79fed702fd7'
);

-- 3) Limpiar cola y encolar los 4 reales
UPDATE public.queue_items
SET status = 'played'
WHERE venue_id = '8f855914-aa4d-4450-887a-5e6e4c1a05d2'
  AND status IN ('queued', 'playing');

INSERT INTO public.queue_items (venue_id, video_id, status, added_by_table)
VALUES
  ('8f855914-aa4d-4450-887a-5e6e4c1a05d2', '3b643440-76ab-44a8-9079-110f50704a96', 'queued', 'Seed real'),
  ('8f855914-aa4d-4450-887a-5e6e4c1a05d2', 'ad2aef3e-e758-4817-88f9-d50c329e618f', 'queued', 'Seed real'),
  ('8f855914-aa4d-4450-887a-5e6e4c1a05d2', '80b4b735-de8b-42cd-9d63-541ae35c4f1a', 'queued', 'Seed real'),
  ('8f855914-aa4d-4450-887a-5e6e4c1a05d2', '86eb8e74-309e-498c-b80f-9578382331b8', 'queued', 'Seed real');

-- 4) Reactivar RLS + políticas abiertas de prototipo
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "videos_select_all" ON public.videos;
CREATE POLICY "videos_select_all" ON public.videos FOR SELECT USING (true);

DROP POLICY IF EXISTS "videos_insert_all" ON public.videos;
CREATE POLICY "videos_insert_all" ON public.videos FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "videos_update_all" ON public.videos;
CREATE POLICY "videos_update_all" ON public.videos FOR UPDATE USING (true) WITH CHECK (true);

-- Necesario para guardar canciones pedidas desde búsqueda YouTube
DROP POLICY IF EXISTS "videos_insert_all" ON public.videos;
CREATE POLICY "videos_insert_all" ON public.videos FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "queue_items_select_all" ON public.queue_items;
CREATE POLICY "queue_items_select_all" ON public.queue_items FOR SELECT USING (true);

DROP POLICY IF EXISTS "queue_items_insert_all" ON public.queue_items;
CREATE POLICY "queue_items_insert_all" ON public.queue_items FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "queue_items_update_all" ON public.queue_items;
CREATE POLICY "queue_items_update_all" ON public.queue_items FOR UPDATE USING (true) WITH CHECK (true);

-- 5) RESULTADO ESPERADO (si ves qCiUu8pshxM, etc. → OK)
SELECT title, youtube_id, is_active FROM public.videos WHERE is_active ORDER BY title;

SELECT v.title, v.youtube_id, qi.status
FROM public.queue_items qi
JOIN public.videos v ON v.id = qi.video_id
WHERE qi.status IN ('queued','playing')
ORDER BY qi.added_at;
