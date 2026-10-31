-- The central plugin folder is gone: plugins are synced per vault (the
-- vault's `.obsidian` folder). Remove it with everything inside (cascades to
-- children, blobs, document keys, grants).
DELETE FROM "nodes" WHERE "systemType" = 'plugins';

-- System folders are now unique per parent (one `.obsidian` per vault).
DROP INDEX IF EXISTS "nodes_systemType_key";
CREATE UNIQUE INDEX "nodes_parentId_systemType_key" ON "nodes"("parentId", "systemType");

-- Plugin admins may change vaults' Obsidian config, like admins.
ALTER TABLE "users" ADD COLUMN "isPluginAdmin" BOOLEAN NOT NULL DEFAULT false;
