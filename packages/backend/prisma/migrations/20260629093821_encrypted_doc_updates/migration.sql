-- CreateTable
CREATE TABLE "doc_updates" (
    "id" BIGSERIAL NOT NULL,
    "docId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doc_updates_docId_id_idx" ON "doc_updates"("docId", "id");

-- AddForeignKey
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_docId_fkey" FOREIGN KEY ("docId") REFERENCES "nodes"("docId") ON DELETE CASCADE ON UPDATE CASCADE;
