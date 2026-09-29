import type { UIMessage } from "@tanstack/ai";
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const threadsTable = pgTable(
  "threads",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: varchar({ length: 255 }).notNull(),
    agent: varchar({ length: 255 }).notNull().default("default"),
    messages: jsonb().notNull().$type<UIMessage[]>().default([]),
    parent_thread_id: uuid().references((): AnyPgColumn => threadsTable.id),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("threads_updated_at_id_idx").on(t.updated_at, t.id),
    index("threads_parent_thread_id_idx").on(t.parent_thread_id),
  ],
);
