-- Multiple vaults: a vault is a top-level folder flagged isVault. Existing
-- rows stay non-vault ("legacy" root content), so nothing moves.
ALTER TABLE "nodes" ADD COLUMN "isVault" BOOLEAN NOT NULL DEFAULT false;
