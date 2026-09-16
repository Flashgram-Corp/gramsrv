-- Support tickets: assignment to the exact admin who answered, the stored
-- answer text (so the full user<->admin conversation stays visible to the whole
-- team), and a 1-5 star rating the user leaves after the ticket is closed.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS answered_by BIGINT NOT NULL DEFAULT 0;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS answer TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS support_ratings (
  ticket_id INTEGER PRIMARY KEY REFERENCES support_messages(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);