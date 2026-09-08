-- AlterTable
ALTER TABLE "assumptions" ADD COLUMN "layerPolicy" TEXT NOT NULL DEFAULT 'LIFO';
ALTER TABLE "assumptions" ADD COLUMN "discount" BOOLEAN NOT NULL DEFAULT true;
