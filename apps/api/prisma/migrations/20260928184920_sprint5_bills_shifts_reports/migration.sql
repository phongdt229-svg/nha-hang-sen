-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'PENDING_APPROVAL', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BillStatus" ADD VALUE 'SPLIT';
ALTER TYPE "BillStatus" ADD VALUE 'VOID';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'HEAD_CHEF';
ALTER TYPE "Role" ADD VALUE 'STOREKEEPER';
ALTER TYPE "Role" ADD VALUE 'ACCOUNTANT';

-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "label" TEXT,
ADD COLUMN     "parent_id" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "origin_session_id" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "shift_id" TEXT;

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "shift_id" TEXT,
    "business_day" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "cashier_id" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "opening_cash" INTEGER NOT NULL,
    "counted_cash" INTEGER,
    "expected_cash" INTEGER,
    "difference" INTEGER,
    "totals" JSONB,
    "note" TEXT,
    "approved_by" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_days" (
    "day" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "closed_by" TEXT NOT NULL,
    "summary" JSONB NOT NULL,

    CONSTRAINT "business_days_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "daily_sales_summary" (
    "day" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "revenue" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL,
    "cogs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "daily_sales_summary_pkey" PRIMARY KEY ("day","menu_item_id")
);

-- CreateTable
CREATE TABLE "hourly_sales_summary" (
    "day" TEXT NOT NULL,
    "hour" INTEGER NOT NULL,
    "bills" INTEGER NOT NULL,
    "guests" INTEGER NOT NULL,
    "revenue" INTEGER NOT NULL,

    CONSTRAINT "hourly_sales_summary_pkey" PRIMARY KEY ("day","hour")
);

-- CreateIndex
CREATE INDEX "refunds_business_day_idx" ON "refunds"("business_day");

-- CreateIndex
CREATE INDEX "shifts_cashier_id_status_idx" ON "shifts"("cashier_id", "status");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
