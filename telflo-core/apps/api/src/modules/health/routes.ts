import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";

export function registerHealthRoutes(server: FastifyInstance, db: Kysely<Database>): void {
  // Probes hit this route every few seconds, so it logs nothing, and a failing
  // one logs nothing either: the kubelet's probe events are the record.
  // `silent` covers Fastify's request lines and the error handler's alike;
  // every other route logs as before.
  server.get("/health", { logLevel: "silent" }, async (_request, reply) => {
    // Answering without touching the database would report a healthy process
    // in front of an unreachable one, which is the failure worth catching.
    await sql`select 1`.execute(db);
    return reply.send({ status: "ok" });
  });
}
