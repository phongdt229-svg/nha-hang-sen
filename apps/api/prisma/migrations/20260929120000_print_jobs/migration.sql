-- CreateEnum
CREATE TYPE "PrinterState" AS ENUM ('UNKNOWN', 'ONLINE', 'OFFLINE', 'PAPER_OUT', 'ERROR');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'PRINTING', 'DONE', 'CANCELLED');

-- CreateTable
CREATE TABLE "printers" (
    "target" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" "PrinterState" NOT NULL DEFAULT 'UNKNOWN',
    "last_error" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "agent_id" TEXT,

    CONSTRAINT "printers_pkey" PRIMARY KEY ("target")
);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "leased_until" TIMESTAMP(3),
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printed_at" TIMESTAMP(3),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "print_jobs_idempotency_key_key" ON "print_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "print_jobs_target_status_created_at_idx" ON "print_jobs"("target", "status", "created_at");
