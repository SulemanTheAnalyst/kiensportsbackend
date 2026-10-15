-- Add InboundEmail: stores Resend inbound webhook deliveries
-- (metadata + truncated body; no attachment payloads).
CREATE TABLE "InboundEmail" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "cc" TEXT,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "attachments" JSONB,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEmail_pkey" PRIMARY KEY ("id")
);

-- Idempotency: duplicate webhook deliveries must map to the same row.
CREATE UNIQUE INDEX "InboundEmail_emailId_key" ON "InboundEmail"("emailId");
CREATE INDEX "InboundEmail_createdAt_idx" ON "InboundEmail"("createdAt");
