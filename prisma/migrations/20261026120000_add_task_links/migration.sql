-- CreateTable
CREATE TABLE "task_links" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "added_by_id" TEXT,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "task_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_links_organization_id_idx" ON "task_links"("organization_id");

-- CreateIndex
CREATE INDEX "task_links_task_id_deleted_at_idx" ON "task_links"("task_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

