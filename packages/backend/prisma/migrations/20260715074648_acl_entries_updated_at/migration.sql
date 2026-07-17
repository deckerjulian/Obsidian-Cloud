-- Schema drift fix: AclEntry.updatedAt was added to schema.prisma (commit
-- "rewrite sync backend") without a matching migration, so acl_entries never
-- got the column. Existing rows get CURRENT_TIMESTAMP as their initial value.
ALTER TABLE "acl_entries" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
