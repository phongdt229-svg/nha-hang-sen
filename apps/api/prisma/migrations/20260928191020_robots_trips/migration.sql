-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('ROBOT', 'STAFF');

-- CreateEnum
CREATE TYPE "RobotVendor" AS ENUM ('SIMULATED', 'MQTT', 'ORIONSTAR', 'MANUAL');

-- CreateEnum
CREATE TYPE "RobotState" AS ENUM ('IDLE', 'BUSY', 'CHARGING', 'ERROR', 'OFFLINE', 'DISABLED');

-- CreateEnum
CREATE TYPE "TripStage" AS ENUM ('CREATED', 'ASSIGNED', 'AT_PICKUP', 'MOVING', 'ARRIVED', 'DELIVERED', 'RETURNING', 'DONE', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "delivery_mode" "DeliveryMode" NOT NULL DEFAULT 'ROBOT',
ADD COLUMN     "ready_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "robots" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" "RobotVendor" NOT NULL,
    "model" TEXT,
    "serial" TEXT,
    "external_id" TEXT NOT NULL,
    "state" "RobotState" NOT NULL DEFAULT 'IDLE',
    "battery" INTEGER NOT NULL DEFAULT 100,
    "location" TEXT NOT NULL DEFAULT 'CHO',
    "zone" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "robots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_trips" (
    "id" TEXT NOT NULL,
    "seq_no" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "robot_id" TEXT,
    "session_id" TEXT NOT NULL,
    "table_id" TEXT NOT NULL,
    "table_code" TEXT NOT NULL,
    "stage" "TripStage" NOT NULL DEFAULT 'CREATED',
    "fail_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "arrived_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "delivery_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_items" (
    "trip_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,

    CONSTRAINT "trip_items_pkey" PRIMARY KEY ("trip_id","order_item_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "robots_code_key" ON "robots"("code");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_trips_code_key" ON "delivery_trips"("code");

-- CreateIndex
CREATE INDEX "delivery_trips_stage_idx" ON "delivery_trips"("stage");

-- CreateIndex
CREATE INDEX "delivery_trips_session_id_idx" ON "delivery_trips"("session_id");

-- CreateIndex
CREATE INDEX "trip_items_order_item_id_idx" ON "trip_items"("order_item_id");

-- AddForeignKey
ALTER TABLE "delivery_trips" ADD CONSTRAINT "delivery_trips_robot_id_fkey" FOREIGN KEY ("robot_id") REFERENCES "robots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_items" ADD CONSTRAINT "trip_items_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "delivery_trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
