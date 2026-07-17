-- At most one system folder per type ("plugins", ...). Postgres unique
-- indexes treat NULLs as distinct, so ordinary nodes are unaffected. The
-- application checks before creating, but only this index makes it race-proof.
CREATE UNIQUE INDEX "nodes_systemType_key" ON "nodes"("systemType");
