-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN');

-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('TABLET', 'KDS');

-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('AVAILABLE', 'DINING', 'PAYMENT', 'CLEANING', 'RESERVED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('OPEN', 'PAYMENT', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('TABLET', 'POS', 'AI');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('CONFIRMED', 'SENT', 'KDS_ACK', 'FALLBACK', 'PREPARING', 'READY', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('SENT', 'ACKED', 'FALLBACK');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('OPEN', 'LOCKED', 'PAID', 'CLOSED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'QR', 'CARD', 'EWALLET');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "kind" "DeviceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "table_id" TEXT,
    "station" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pairing_codes" (
    "code" TEXT NOT NULL,
    "kind" "DeviceKind" NOT NULL,
    "table_id" TEXT,
    "station" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "pairing_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tables" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "zone" TEXT NOT NULL,
    "status" "TableStatus" NOT NULL DEFAULT 'AVAILABLE',
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dining_sessions" (
    "id" TEXT NOT NULL,
    "seq_no" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "guests" INTEGER NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "dining_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_assignments" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "from_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "to_at" TIMESTAMP(3),

    CONSTRAINT "table_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image_url" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "station" TEXT NOT NULL,
    "tax_group" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "tax_group" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "note" TEXT,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "session_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "source" "OrderSource" NOT NULL,
    "total" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "note" TEXT,
    "unit_price" INTEGER NOT NULL,
    "tax_group" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "status" "OrderItemStatus" NOT NULL DEFAULT 'CONFIRMED',
    "cancel_reason" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kitchen_tickets" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'SENT',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "session_id" TEXT NOT NULL,
    "status" "BillStatus" NOT NULL DEFAULT 'OPEN',
    "discount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "business_day" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_lines" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL,
    "tax_group" TEXT NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "base" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "received" INTEGER,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider_txn_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "cashier_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_log" (
    "seq" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "rooms" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "tables_code_key" ON "tables"("code");

-- CreateIndex
CREATE UNIQUE INDEX "dining_sessions_code_key" ON "dining_sessions"("code");

-- CreateIndex
CREATE INDEX "table_assignments_table_id_to_at_idx" ON "table_assignments"("table_id", "to_at");

-- CreateIndex
CREATE INDEX "table_assignments_session_id_to_at_idx" ON "table_assignments"("session_id", "to_at");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_code_key" ON "menu_items"("code");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "orders_session_id_idx" ON "orders"("session_id");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "kitchen_tickets_station_status_idx" ON "kitchen_tickets"("station", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kitchen_tickets_order_id_station_key" ON "kitchen_tickets"("order_id", "station");

-- CreateIndex
CREATE INDEX "bills_session_id_idx" ON "bills"("session_id");

-- CreateIndex
CREATE INDEX "bills_business_day_idx" ON "bills"("business_day");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_txn_id_key" ON "payments"("provider_txn_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_bill_id_idx" ON "payments"("bill_id");

-- CreateIndex
CREATE INDEX "event_log_published_at_seq_idx" ON "event_log"("published_at", "seq");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_assignments" ADD CONSTRAINT "table_assignments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dining_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_assignments" ADD CONSTRAINT "table_assignments_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dining_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dining_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
