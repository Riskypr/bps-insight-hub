-- Enable trigram extension (needed for GIN trigram indexes)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on original_name (supports fast ILIKE '%keyword%')
CREATE INDEX IF NOT EXISTS pdf_files_original_name_trgm_idx
  ON pdf_files USING GIN (original_name gin_trgm_ops);

-- GIN trigram index on title
CREATE INDEX IF NOT EXISTS pdf_files_title_trgm_idx
  ON pdf_files USING GIN (title gin_trgm_ops);

-- GIN trigram index on category
CREATE INDEX IF NOT EXISTS pdf_files_category_trgm_idx
  ON pdf_files USING GIN (category gin_trgm_ops);
