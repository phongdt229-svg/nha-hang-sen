-- v0.7: Delivery Task theo RD-02/RD-11 (thay delivery_trips), robot mBot v1 (MAKEBLOCK), robot_locations.

-- Robot demo qua MQTT trước đây nay là mBot v1 của Makeblock
ALTER TYPE "RobotVendor" RENAME VALUE 'MQTT' TO 'MAKEBLOCK';

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'ASSIGNING', 'ASSIGNED', 'ROBOT_ACCEPTED', 'GOING_TO_PICKUP', 'ARRIVED_PICKUP', 'LOADING', 'GOING_TO_TABLE', 'ARRIVED_TABLE', 'WAITING_CUSTOMER', 'DELIVERED', 'RETURNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'MANUAL_TAKEOVER');

-- CreateEnum
CREATE TYPE "RobotLocationKind" AS ENUM ('KITCHEN_PASS', 'TABLE', 'HOME', 'CHARGER');

-- AlterTable robots
ALTER TABLE "robots" ADD COLUMN "telemetry_simulated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "last_error_at" TIMESTAMP(3),
ALTER COLUMN "location" SET DEFAULT 'ROBOT_HOME';
UPDATE "robots" SET "location" = CASE "location" WHEN 'BEP' THEN 'KITCHEN_PASS_01' WHEN 'SAC' THEN 'CHARGER_01' ELSE 'ROBOT_HOME' END
  WHERE "location" IN ('CHO', 'BEP', 'SAC', 'DI_CHUYEN', '?');

-- delivery_trips → delivery_tasks (giữ dữ liệu)
ALTER TABLE "delivery_trips" RENAME TO "delivery_tasks";
ALTER TABLE "delivery_tasks" RENAME CONSTRAINT "delivery_trips_pkey" TO "delivery_tasks_pkey";
ALTER TABLE "delivery_tasks" RENAME CONSTRAINT "delivery_trips_robot_id_fkey" TO "delivery_tasks_robot_id_fkey";
ALTER SEQUENCE "delivery_trips_seq_no_seq" RENAME TO "delivery_tasks_seq_no_seq";
ALTER INDEX "delivery_trips_code_key" RENAME TO "delivery_tasks_code_key";
ALTER INDEX "delivery_trips_session_id_idx" RENAME TO "delivery_tasks_session_id_idx";
DROP INDEX "delivery_trips_stage_idx";

ALTER TABLE "delivery_tasks" ADD COLUMN "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING';
UPDATE "delivery_tasks" SET "status" = (CASE "stage"
  WHEN 'CREATED' THEN 'PENDING'
  WHEN 'ASSIGNED' THEN 'ASSIGNED'
  WHEN 'AT_PICKUP' THEN 'ARRIVED_PICKUP'
  WHEN 'MOVING' THEN 'GOING_TO_TABLE'
  WHEN 'ARRIVED' THEN 'WAITING_CUSTOMER'
  WHEN 'DELIVERED' THEN 'DELIVERED'
  WHEN 'RETURNING' THEN 'RETURNING'
  WHEN 'DONE' THEN 'COMPLETED'
  WHEN 'FAILED' THEN 'FAILED'
  ELSE 'CANCELLED' END)::"DeliveryStatus";
ALTER TABLE "delivery_tasks" DROP COLUMN "stage";
DROP TYPE "TripStage";

ALTER TABLE "delivery_tasks" RENAME COLUMN "fail_reason" TO "failure_reason";
ALTER TABLE "delivery_tasks" RENAME COLUMN "picked_up_at" TO "loaded_at";
ALTER TABLE "delivery_tasks" RENAME COLUMN "ended_at" TO "completed_at";
ALTER TABLE "delivery_tasks" ADD COLUMN "problem" TEXT,
ADD COLUMN "failed_from" "DeliveryStatus",
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pickup_location" TEXT NOT NULL DEFAULT 'KITCHEN_PASS_01',
ADD COLUMN "delivery_location" TEXT NOT NULL DEFAULT '',
ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "assign_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "next_retry_at" TIMESTAMP(3),
ADD COLUMN "confirmed_by" TEXT,
ADD COLUMN "customer_notified_at" TIMESTAMP(3),
ADD COLUMN "started_at" TIMESTAMP(3),
ADD COLUMN "failed_at" TIMESTAMP(3);
UPDATE "delivery_tasks" SET "delivery_location" = 'TABLE_' || "table_code";
ALTER TABLE "delivery_tasks" ALTER COLUMN "pickup_location" DROP DEFAULT, ALTER COLUMN "delivery_location" DROP DEFAULT;
CREATE INDEX "delivery_tasks_status_idx" ON "delivery_tasks"("status");

-- trip_items → delivery_task_items
ALTER TABLE "trip_items" RENAME TO "delivery_task_items";
ALTER TABLE "delivery_task_items" RENAME COLUMN "trip_id" TO "task_id";
ALTER TABLE "delivery_task_items" RENAME CONSTRAINT "trip_items_pkey" TO "delivery_task_items_pkey";
ALTER TABLE "delivery_task_items" RENAME CONSTRAINT "trip_items_trip_id_fkey" TO "delivery_task_items_task_id_fkey";
ALTER INDEX "trip_items_order_item_id_idx" RENAME TO "delivery_task_items_order_item_id_idx";

-- CreateTable
CREATE TABLE "delivery_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "robot_id" TEXT,
    "location" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "delivery_events_task_id_created_at_idx" ON "delivery_events"("task_id", "created_at");
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "delivery_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "robot_locations" (
    "code" TEXT NOT NULL,
    "kind" "RobotLocationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "table_id" TEXT,
    "vendor_mapping" JSONB NOT NULL DEFAULT '{}',
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "robot_locations_pkey" PRIMARY KEY ("code")
);
CREATE UNIQUE INDEX "robot_locations_table_id_key" ON "robot_locations"("table_id");
