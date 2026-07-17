-- CreateEnum
CREATE TYPE "Capability" AS ENUM ('read', 'create', 'edit', 'delete', 'share');

-- AlterTable
ALTER TABLE "acl_entries" ADD COLUMN     "capabilities" "Capability"[] DEFAULT ARRAY[]::"Capability"[];
