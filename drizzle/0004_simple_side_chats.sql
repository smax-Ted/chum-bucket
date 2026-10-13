ALTER TABLE "side_transfers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "side_transfers" CASCADE;--> statement-breakpoint
ALTER TABLE "side_chats" DROP CONSTRAINT "side_chats_open_key_unique";--> statement-breakpoint
ALTER TABLE "side_chats" DROP CONSTRAINT "side_chats_epoch_check";--> statement-breakpoint
ALTER TABLE "side_chats" DROP CONSTRAINT "side_chats_state_check";--> statement-breakpoint
DROP INDEX "side_chats_lease_idx";--> statement-breakpoint
DELETE FROM "side_chats" WHERE "state" = 'closed' OR "seed" IS NULL;--> statement-breakpoint
ALTER TABLE "side_chats" ALTER COLUMN "seed" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "side_chats" DROP COLUMN "page_scope";--> statement-breakpoint
ALTER TABLE "side_chats" DROP COLUMN "open_key";--> statement-breakpoint
ALTER TABLE "side_chats" DROP COLUMN "epoch";--> statement-breakpoint
ALTER TABLE "side_chats" DROP COLUMN "lease_until";--> statement-breakpoint
ALTER TABLE "side_chats" DROP COLUMN "draft";--> statement-breakpoint
ALTER TABLE "side_chats" ADD CONSTRAINT "side_chats_state_check" CHECK ("side_chats"."state" in ('open', 'closing'));