-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM (
  'PART_CREATED',
  'PART_UPDATED',
  'BOM_LINK_CREATED',
  'BOM_LINK_UPDATED',
  'BOM_LINK_REMOVED'
);

-- CreateTable
CREATE TABLE "parts" (
  "id" TEXT NOT NULL,
  "part_number" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_links" (
  "parent_id" TEXT NOT NULL,
  "child_id" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bom_links_pkey" PRIMARY KEY ("parent_id", "child_id"),
  CONSTRAINT "bom_links_quantity_check" CHECK ("quantity" > 0)
);

-- CreateTable
CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "part_id" TEXT NOT NULL,
  "action" "AuditAction" NOT NULL,
  "message" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "parts_part_number_key" ON "parts"("part_number");

-- CreateIndex
CREATE INDEX "idx_parts_part_number" ON "parts"("part_number");

-- CreateIndex
CREATE INDEX "idx_bom_links_parent" ON "bom_links"("parent_id");

-- CreateIndex
CREATE INDEX "idx_bom_links_child" ON "bom_links"("child_id");

-- CreateIndex
CREATE INDEX "idx_audit_logs_part_timestamp" ON "audit_logs"("part_id", "timestamp" DESC);

-- AddForeignKey
ALTER TABLE "bom_links"
ADD CONSTRAINT "bom_links_parent_id_fkey"
FOREIGN KEY ("parent_id") REFERENCES "parts"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_links"
ADD CONSTRAINT "bom_links_child_id_fkey"
FOREIGN KEY ("child_id") REFERENCES "parts"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs"
ADD CONSTRAINT "audit_logs_part_id_fkey"
FOREIGN KEY ("part_id") REFERENCES "parts"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
