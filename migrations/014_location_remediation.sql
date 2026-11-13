-- 014_location_remediation.sql — P3 Location Remediation (M2)
-- Adds location coordinate provenance to distinguish approximate city/locality centroids
-- from exact venue coordinates, ensuring city centroids are never presented as exact venue locations.
-- Adds guarded trigger to automatically resolve official LGD city links on event publication.
-- Guarded, re-runnable, safe on fresh DB and upgrades.

DO $$ BEGIN
  CREATE TYPE location_provenance AS ENUM ('none', 'city', 'locality', 'venue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE events ADD COLUMN IF NOT EXISTS coords_provenance location_provenance NOT NULL DEFAULT 'none';

-- Backfill coordinate provenance for events already assigned city coordinates
UPDATE events
   SET coords_provenance = 'city'
 WHERE coords_provenance = 'none'
   AND lat IS NOT NULL
   AND lng IS NOT NULL;

-- Automatic location resolution trigger: resolves city_id, canonical name and coordinates
-- from location_cities for newly created or updated events when city matches the directory.
-- Never guesses an unsupported city (leaves city_id null and coords_provenance 'none').
CREATE OR REPLACE FUNCTION trg_events_resolve_location()
RETURNS TRIGGER AS $$
DECLARE
  matched_city RECORD;
BEGIN
  IF NEW.city IS NOT NULL AND (NEW.city_id IS NULL OR NEW.lat IS NULL) THEN
    SELECT id, name, lat, lng INTO matched_city
      FROM location_cities
     WHERE lower(slug) = lower(NEW.city)
        OR lower(name) = lower(NEW.city)
        OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = lower(NEW.city))
     LIMIT 1;

    IF matched_city.id IS NOT NULL THEN
      NEW.city_id := matched_city.id;
      NEW.city := matched_city.name;
      IF NEW.lat IS NULL OR NEW.lng IS NULL THEN
        NEW.lat := matched_city.lat;
        NEW.lng := matched_city.lng;
        IF NEW.coords_provenance = 'none' THEN
          NEW.coords_provenance := 'city';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_resolve_location ON events;
CREATE TRIGGER trg_events_resolve_location
  BEFORE INSERT OR UPDATE OF city, lat, lng ON events
  FOR EACH ROW EXECUTE FUNCTION trg_events_resolve_location();
