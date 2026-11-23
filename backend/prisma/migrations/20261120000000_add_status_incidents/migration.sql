-- CreateTable: Status page incident history (#1738)
CREATE TABLE "status_incidents" (
    "id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_incidents_component_startedAt_idx" ON "status_incidents"("component", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "status_incidents_startedAt_idx" ON "status_incidents"("startedAt" DESC);
