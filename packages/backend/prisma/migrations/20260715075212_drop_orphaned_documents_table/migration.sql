-- Schema drift fix: the Document model (raw Yjs state snapshot) was removed
-- from schema.prisma in "rewrite sync backend", superseded by DocUpdate
-- (encrypted incremental updates). The "documents" table itself was never
-- dropped. Any state in it is stale/unused by current code.

-- DropForeignKey
ALTER TABLE "documents" DROP CONSTRAINT "documents_docId_fkey";

-- DropTable
DROP TABLE "documents";
