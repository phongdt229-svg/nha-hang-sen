-- CreateEnum
CREATE TYPE "BuyerKind" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "EInvoiceStatus" AS ENUM ('PENDING', 'SENT', 'ISSUED', 'FAILED', 'ADJUSTED', 'REPLACED');

-- CreateEnum
CREATE TYPE "EInvoiceKind" AS ENUM ('ORIGINAL', 'ADJUSTMENT', 'REPLACEMENT');

-- AlterEnum
ALTER TYPE "DeviceKind" ADD VALUE 'PRINTER';

-- CreateTable
CREATE TABLE "webhook_logs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "body" JSONB NOT NULL,
    "signature_ok" BOOLEAN NOT NULL,
    "result" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_bank_txns" (
    "id" TEXT NOT NULL,
    "txn_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_bank_txns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_buyers" (
    "bill_id" TEXT NOT NULL,
    "kind" "BuyerKind" NOT NULL,
    "tax_code" TEXT,
    "name" TEXT,
    "address" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "id_number" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bill_buyers_pkey" PRIMARY KEY ("bill_id")
);

-- CreateTable
CREATE TABLE "einvoices" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "kind" "EInvoiceKind" NOT NULL DEFAULT 'ORIGINAL',
    "provider" TEXT NOT NULL,
    "template_code" TEXT,
    "series" TEXT,
    "number" TEXT,
    "lookup_code" TEXT,
    "lookup_url" TEXT,
    "tax_authority_code" TEXT,
    "issued_at" TIMESTAMP(3),
    "business_day" TEXT,
    "total_base" INTEGER NOT NULL,
    "total_tax" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "taxes" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "pdf_url" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "einvoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "einvoice_links" (
    "id" TEXT NOT NULL,
    "original_id" TEXT NOT NULL,
    "linked_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "einvoice_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_logs_provider_created_at_idx" ON "webhook_logs"("provider", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "mock_bank_txns_txn_id_key" ON "mock_bank_txns"("txn_id");

-- CreateIndex
CREATE UNIQUE INDEX "einvoices_idempotency_key_key" ON "einvoices"("idempotency_key");

-- CreateIndex
CREATE INDEX "einvoices_bill_id_idx" ON "einvoices"("bill_id");

-- CreateIndex
CREATE INDEX "einvoices_status_created_at_idx" ON "einvoices"("status", "created_at");

-- CreateIndex
CREATE INDEX "einvoices_business_day_idx" ON "einvoices"("business_day");
