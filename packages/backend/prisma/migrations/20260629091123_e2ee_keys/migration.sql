-- CreateTable
CREATE TABLE "user_keys" (
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "kdfSalt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_keys_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "document_keys" (
    "docId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_keys_pkey" PRIMARY KEY ("docId","userId")
);

-- CreateIndex
CREATE INDEX "document_keys_userId_idx" ON "document_keys"("userId");

-- AddForeignKey
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_keys" ADD CONSTRAINT "document_keys_docId_fkey" FOREIGN KEY ("docId") REFERENCES "nodes"("docId") ON DELETE CASCADE ON UPDATE CASCADE;
