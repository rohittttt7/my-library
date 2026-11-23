BEGIN;

CREATE TABLE IF NOT EXISTS public.library_items (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  number integer NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  mime text,
  extension text,
  type text NOT NULL,
  text text,
  youtube_id text,
  url text,
  file_path text,
  original_filename text
);

ALTER TABLE public.library_items
  ADD COLUMN IF NOT EXISTS parent_id text REFERENCES public.library_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'published';
ALTER TABLE public.library_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS ruby_portal_parent_index ON public.library_items (parent_id, number, id);

CREATE TABLE IF NOT EXISTS public.ruby_portal_progress (
  item_id text PRIMARY KEY REFERENCES public.library_items(id) ON DELETE CASCADE,
  completed boolean NOT NULL DEFAULT false,
  updated bigint NOT NULL
);
ALTER TABLE public.ruby_portal_progress ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.library_items, public.ruby_portal_progress TO service_role;

-- A new project uses the previous library's default bucket name. The old
-- bucket is preserved so an older deployment can continue using it.
INSERT INTO storage.buckets (id, name, public) VALUES ('library-files', 'library-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ruby_portal_category(value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE regexp_replace(lower(coalesce(value, '')), '[^a-z]+', '', 'g')
    WHEN 'english' THEN 'english' WHEN 'englishtutorial' THEN 'english' WHEN 'englishtutorials' THEN 'english'
    WHEN 'categoryyoutubeenglish' THEN 'english'
    WHEN 'hindi' THEN 'hindi' WHEN 'hinditutorial' THEN 'hindi' WHEN 'hinditutorials' THEN 'hindi'
    WHEN 'categoryyoutubehindi' THEN 'hindi'
    WHEN 'workflow' THEN 'workflows' WHEN 'workflows' THEN 'workflows'
    WHEN 'categoriesworkflow' THEN 'workflows'
    WHEN 'categoriesdetailcontent' THEN 'description'
    ELSE 'description'
  END;
$$;

CREATE OR REPLACE FUNCTION public.ruby_portal_record(item public.library_items, include_object boolean)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', item.id, 'category', public.ruby_portal_category(item.category), 'parent', item.parent_id,
    'title', item.name, 'description', coalesce(nullif(item.description, ''), CASE WHEN item.type = 'text' THEN item.url ELSE item.text END, ''),
    'position', item.number, 'status', item.publication_status,
    'kind', CASE WHEN item.type = 'text' THEN 'note' ELSE item.type END,
    'body', coalesce(CASE item.type WHEN 'youtube' THEN item.youtube_id WHEN 'loop' THEN item.url ELSE item.text END, ''),
    'mime', item.mime, 'filename', item.original_filename
  ) || CASE WHEN include_object THEN jsonb_build_object('object', item.file_path) ELSE '{}'::jsonb END;
$$;

CREATE OR REPLACE FUNCTION public.ruby_portal_library(p_category text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'items', coalesce((SELECT jsonb_agg(public.ruby_portal_record(i, false) ORDER BY i.number, i.id)
      FROM public.library_items i WHERE public.ruby_portal_category(i.category) = p_category), '[]'::jsonb),
    'progress', coalesce((SELECT jsonb_agg(jsonb_build_object('item_id', p.item_id, 'completed', p.completed, 'updated', p.updated))
      FROM public.ruby_portal_progress p JOIN public.library_items i ON p.item_id = i.id
      WHERE public.ruby_portal_category(i.category) = p_category), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.ruby_portal_item(p_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT public.ruby_portal_record(i, true) FROM public.library_items i WHERE i.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.ruby_portal_save(p_id text, p_create boolean, fields jsonb, attachment jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  existing public.library_items%ROWTYPE;
  folder public.library_items%ROWTYPE;
  new_category text := fields->>'category';
  new_parent text := fields->>'parent';
  new_kind text := fields->>'kind';
  new_type text := CASE WHEN new_kind = 'note' THEN 'text' ELSE new_kind END;
  new_status text := fields->>'status';
  new_file text;
  new_mime text;
  new_name text;
  old_object text;
  next_number integer;
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
BEGIN
  PERFORM pg_advisory_xact_lock(61021734);
  SELECT * INTO existing FROM public.library_items WHERE id = p_id;
  IF p_create AND FOUND THEN RETURN jsonb_build_object('status', 409, 'error', 'This item already exists.'); END IF;
  IF NOT p_create AND NOT FOUND THEN RETURN jsonb_build_object('status', 404, 'error', 'Item not found.'); END IF;
  IF new_parent IS NOT NULL THEN
    SELECT * INTO folder FROM public.library_items WHERE id = new_parent;
    IF NOT FOUND OR folder.type <> 'folder' OR public.ruby_portal_category(folder.category) <> new_category THEN
      RETURN jsonb_build_object('status', 400, 'error', 'Choose a folder in this category.');
    END IF;
    IF EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, 1 AS depth FROM public.library_items WHERE id = new_parent
        UNION ALL SELECT i.id, i.parent_id, a.depth + 1 FROM public.library_items i JOIN ancestors a ON a.parent_id = i.id WHERE a.depth < 20
      ) SELECT 1 FROM ancestors WHERE id = p_id OR depth = 20
    ) THEN RETURN jsonb_build_object('status', 400, 'error', 'Choose a folder outside this item’s own tree and within 20 levels.'); END IF;
  END IF;
  IF NOT p_create AND (new_kind <> 'folder' OR public.ruby_portal_category(existing.category) <> new_category)
    AND EXISTS (SELECT 1 FROM public.library_items WHERE parent_id = p_id) THEN
    RETURN jsonb_build_object('status', 400, 'error', 'Move the contents out of this folder before changing its category or type.');
  END IF;
  IF new_kind = 'file' THEN
    new_file := coalesce(attachment->>'object', existing.file_path);
    new_mime := coalesce(attachment->>'mime', existing.mime);
    new_name := coalesce(attachment->>'filename', existing.original_filename);
    IF new_file IS NULL AND new_status = 'published' THEN
      RETURN jsonb_build_object('status', 400, 'error', 'Choose a file before publishing.');
    END IF;
  END IF;
  IF NOT p_create AND public.ruby_portal_category(existing.category) = new_category AND existing.parent_id IS NOT DISTINCT FROM new_parent THEN
    next_number := existing.number;
    new_category := existing.category;
  ELSE
    SELECT coalesce(max(number), 0) + 1 INTO next_number FROM public.library_items
      WHERE public.ruby_portal_category(category) = new_category AND parent_id IS NOT DISTINCT FROM new_parent;
  END IF;
  INSERT INTO public.library_items (id, name, category, number, created_at, updated_at, mime, extension, type,
      text, youtube_id, url, file_path, original_filename, parent_id, description, publication_status)
    VALUES (p_id, fields->>'title', new_category, next_number, coalesce(existing.created_at, now_ms), now_ms,
      CASE new_kind WHEN 'youtube' THEN 'text/youtube' WHEN 'note' THEN 'text/plain' ELSE new_mime END,
      CASE new_kind WHEN 'youtube' THEN 'YOUTUBE' WHEN 'note' THEN 'TXT' ELSE upper(substring(new_name FROM '\.([^.]*)$')) END, new_type,
      CASE WHEN new_kind = 'note' THEN fields->>'body' END,
      CASE WHEN new_kind = 'youtube' THEN fields->>'body' END,
      CASE new_kind WHEN 'loop' THEN fields->>'body' WHEN 'youtube' THEN 'https://www.youtube.com/watch?v=' || (fields->>'body') END,
      new_file, new_name, new_parent, fields->>'description', new_status)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name, category=excluded.category, number=excluded.number,
      updated_at=excluded.updated_at, mime=excluded.mime, extension=excluded.extension, type=excluded.type,
      text=excluded.text, youtube_id=excluded.youtube_id, url=excluded.url, file_path=excluded.file_path,
      original_filename=excluded.original_filename, parent_id=excluded.parent_id, description=excluded.description,
      publication_status=excluded.publication_status;
  IF existing.file_path IS DISTINCT FROM new_file AND NOT EXISTS (SELECT 1 FROM public.library_items WHERE file_path = existing.file_path) THEN
    old_object := existing.file_path;
  END IF;
  RETURN jsonb_build_object('id', p_id, 'remove_object', old_object);
END;
$$;

CREATE OR REPLACE FUNCTION public.ruby_portal_delete(p_id text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE old_object text;
BEGIN
  PERFORM pg_advisory_xact_lock(61021734);
  IF EXISTS (SELECT 1 FROM public.library_items WHERE parent_id = p_id) THEN
    RETURN jsonb_build_object('status', 409, 'error', 'Move or remove the contents of this folder first.');
  END IF;
  DELETE FROM public.library_items WHERE id = p_id RETURNING file_path INTO old_object;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 404, 'error', 'Item not found.'); END IF;
  IF EXISTS (SELECT 1 FROM public.library_items WHERE file_path = old_object) THEN old_object := NULL; END IF;
  RETURN jsonb_build_object('remove_object', old_object);
END;
$$;

CREATE OR REPLACE FUNCTION public.ruby_portal_move(p_id text, p_direction text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE selected_item public.library_items%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(61021734);
  SELECT * INTO selected_item FROM public.library_items WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 404, 'error', 'Item not found.'); END IF;
  WITH siblings AS (
    SELECT id, row_number() OVER (ORDER BY number, id) AS rank FROM public.library_items
    WHERE public.ruby_portal_category(category) = public.ruby_portal_category(selected_item.category)
      AND parent_id IS NOT DISTINCT FROM selected_item.parent_id
  ), swap AS (
    SELECT current_row.rank AS original_rank, neighbor.id AS neighbor_id, neighbor.rank AS neighbor_rank
    FROM siblings current_row JOIN siblings neighbor ON neighbor.rank = current_row.rank + CASE WHEN p_direction = 'up' THEN -1 ELSE 1 END
    WHERE current_row.id = p_id
  )
  UPDATE public.library_items AS item SET number = CASE
    WHEN item.id = p_id THEN swap.neighbor_rank WHEN item.id = swap.neighbor_id THEN swap.original_rank ELSE siblings.rank END
  FROM siblings CROSS JOIN swap WHERE siblings.id = item.id;
  RETURN '{}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.ruby_portal_progress_set(p_id text, p_completed boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(61021734);
  INSERT INTO public.ruby_portal_progress (item_id, completed, updated)
    SELECT id, coalesce(p_completed, false), floor(extract(epoch FROM clock_timestamp()) * 1000)
    FROM public.library_items WHERE id = p_id AND type <> 'folder'
    ON CONFLICT (item_id) DO UPDATE SET completed = coalesce(p_completed, ruby_portal_progress.completed), updated = excluded.updated;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 404, 'error', 'Learning item not found.'); END IF;
  RETURN '{}'::jsonb;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ruby_portal_category(text), public.ruby_portal_record(public.library_items, boolean),
  public.ruby_portal_library(text), public.ruby_portal_item(text), public.ruby_portal_save(text, boolean, jsonb, jsonb),
  public.ruby_portal_delete(text), public.ruby_portal_move(text, text), public.ruby_portal_progress_set(text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ruby_portal_category(text), public.ruby_portal_record(public.library_items, boolean),
  public.ruby_portal_library(text), public.ruby_portal_item(text), public.ruby_portal_save(text, boolean, jsonb, jsonb),
  public.ruby_portal_delete(text), public.ruby_portal_move(text, text), public.ruby_portal_progress_set(text, boolean)
  TO service_role;

COMMIT;
