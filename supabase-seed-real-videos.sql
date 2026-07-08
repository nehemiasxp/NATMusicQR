-- NATMusicQR: catálogo real + políticas de videos
-- Ejecutar en Supabase → SQL Editor (como postgres)

-- 1) Políticas de escritura en videos (INSERT/UPDATE)
DO $$ BEGIN
  CREATE POLICY "videos_insert_all" ON public.videos
    FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "videos_update_all" ON public.videos
    FOR UPDATE USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) Desactivar catálogo viejo de prueba
UPDATE public.videos
SET is_active = false
WHERE venue_id = '8f855914-aa4d-4450-887a-5e6e4c1a05d2';

-- 3) Marcar cola vieja como played
UPDATE public.queue_items
SET status = 'played'
WHERE venue_id = '8f855914-aa4d-4450-887a-5e6e4c1a05d2'
  AND status IN ('queued', 'playing');

-- 4) Insertar las 4 canciones reales
INSERT INTO public.videos (
  venue_id,
  youtube_id,
  title,
  artist,
  category,
  is_active,
  thumbnail_url
) VALUES
(
  '8f855914-aa4d-4450-887a-5e6e4c1a05d2',
  'qCiUu8pshxM',
  'VENGO SOLTERITO | Los Apus | Electro Carnavales',
  'Ceron Producciones',
  'Electro',
  true,
  'https://img.youtube.com/vi/qCiUu8pshxM/hqdefault.jpg'
),
(
  '8f855914-aa4d-4450-887a-5e6e4c1a05d2',
  'NyABPr7y0KQ',
  'SAQRA CARNAVAL - Florcita Villano (Electro TikTok)',
  'MixMaestro',
  'Electro',
  true,
  'https://img.youtube.com/vi/NyABPr7y0KQ/hqdefault.jpg'
),
(
  '8f855914-aa4d-4450-887a-5e6e4c1a05d2',
  '8-XWZ6x4-LQ',
  'Electro Carnaval (Sacclaya)',
  'Mix',
  'Electro',
  true,
  'https://img.youtube.com/vi/8-XWZ6x4-LQ/hqdefault.jpg'
),
(
  '8f855914-aa4d-4450-887a-5e6e4c1a05d2',
  '5CJQCucoI3w',
  'PASAME LA BOTELLA - Rosita Corazon (Electro)',
  'MixMaestro',
  'Electro',
  true,
  'https://img.youtube.com/vi/5CJQCucoI3w/hqdefault.jpg'
);

-- 5) Meter las 4 a la cola (orden del listado)
INSERT INTO public.queue_items (venue_id, video_id, status, added_by_table)
SELECT
  v.venue_id,
  v.id,
  'queued',
  'Seed real'
FROM public.videos v
WHERE v.venue_id = '8f855914-aa4d-4450-887a-5e6e4c1a05d2'
  AND v.is_active = true
  AND v.youtube_id IN ('qCiUu8pshxM', 'NyABPr7y0KQ', '8-XWZ6x4-LQ', '5CJQCucoI3w')
ORDER BY
  CASE v.youtube_id
    WHEN 'qCiUu8pshxM' THEN 1
    WHEN 'NyABPr7y0KQ' THEN 2
    WHEN '8-XWZ6x4-LQ' THEN 3
    WHEN '5CJQCucoI3w' THEN 4
  END;

-- 6) Verificación
SELECT youtube_id, title, is_active FROM public.videos
WHERE venue_id = '8f855914-aa4d-4450-887a-5e6e4c1a05d2'
ORDER BY is_active DESC, title;

SELECT qi.status, v.title, v.youtube_id
FROM public.queue_items qi
JOIN public.videos v ON v.id = qi.video_id
WHERE qi.venue_id = '8f855914-aa4d-4450-887a-5e6e4c1a05d2'
  AND qi.status IN ('queued', 'playing')
ORDER BY qi.added_at;
