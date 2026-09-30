ALTER TABLE "threads" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "threads" ADD COLUMN "active_run_id" text;
ALTER TABLE "threads" ADD CONSTRAINT "threads_revision_nonnegative" CHECK ("revision" >= 0);
CREATE TABLE "chat_runs" (
  "id" text PRIMARY KEY,
  "thread_id" uuid NOT NULL REFERENCES "threads"("id"),
  "request" jsonb NOT NULL,
  "accepted" jsonb NOT NULL,
  "projection" jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL CONSTRAINT "chat_runs_state_check" CHECK ("state" IN ('pending', 'succeeded', 'failed')),
  "next_sequence" integer DEFAULT 0 NOT NULL CONSTRAINT "chat_runs_sequence_nonnegative" CHECK ("next_sequence" >= 0),
  "log_bytes" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "chat_runs_pending_idx" ON "chat_runs"("state");
CREATE TABLE "chat_model_slots" (
  "run_id" text NOT NULL REFERENCES "chat_runs"("id"),
  "turn" integer NOT NULL CONSTRAINT "chat_model_slots_turn_check" CHECK ("turn" >= 0 AND "turn" < 5),
  "epoch" integer DEFAULT 0 NOT NULL,
  "committed" boolean DEFAULT false NOT NULL,
  "receipt" jsonb,
  CONSTRAINT "chat_model_slots_run_id_turn_pk" PRIMARY KEY ("run_id", "turn")
);
CREATE TABLE "chat_events" (
  "run_id" text NOT NULL REFERENCES "chat_runs"("id"),
  "sequence" integer NOT NULL CONSTRAINT "chat_events_sequence_nonnegative" CHECK ("sequence" >= 0),
  "event_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  CONSTRAINT "chat_events_run_id_sequence_pk" PRIMARY KEY ("run_id", "sequence"),
  CONSTRAINT "chat_events_key_unique" UNIQUE ("run_id", "event_key")
);
