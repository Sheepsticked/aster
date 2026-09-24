-- Aster — calls records outgoing calls too; every call recorded before was incoming.
ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'out'));
