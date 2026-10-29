-- 007_organiser_enums.sql — enum values for organiser events. Kept separate from 008 because a
-- value added by ALTER TYPE cannot be used in the same transaction (each migration is one tx).
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'pending_approval';
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'declined';
ALTER TYPE event_category ADD VALUE IF NOT EXISTS 'networking';
ALTER TYPE event_category ADD VALUE IF NOT EXISTS 'workshop';
