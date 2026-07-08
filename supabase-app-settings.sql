-- Config editable desde /admin
-- Supabase → SQL Editor → Run

CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_settings_select_all" ON public.app_settings;
CREATE POLICY "app_settings_select_all" ON public.app_settings
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "app_settings_insert_all" ON public.app_settings;
CREATE POLICY "app_settings_insert_all" ON public.app_settings
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "app_settings_update_all" ON public.app_settings;
CREATE POLICY "app_settings_update_all" ON public.app_settings
  FOR UPDATE USING (true) WITH CHECK (true);

-- Semilla con defaults (1 canción / celular / 30 min)
INSERT INTO public.app_settings (key, value)
VALUES (
  'jukebox',
  '{
    "maxDurationSeconds": 300,
    "perTable": { "enabled": true, "maxSongs": 1, "windowMinutes": 20 },
    "perDevice": { "enabled": true, "maxSongs": 1, "windowMinutes": 30 },
    "perIp": { "enabled": false, "maxSongs": 3, "windowMinutes": 30 },
    "blockDuplicateInQueue": true,
    "ui": { "showQueueOnJoin": true, "pollIntervalMs": 3000 }
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
