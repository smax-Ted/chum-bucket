import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import chat from "./chat";
import thread from "./thread";

const app = new Hono();
app.get("/", (c) => c.text("Hello Node.js!"));

app.route("/api/chat", chat);
app.route("/api/thread", thread);

serve(app);
