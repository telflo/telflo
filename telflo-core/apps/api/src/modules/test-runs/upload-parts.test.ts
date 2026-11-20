import { randomUUID } from "node:crypto";
import { buffer } from "node:stream/consumers";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../errors.js";
import { discardUnreadUpload, readUploadParts } from "./upload-parts.js";

/*
 * readUploadParts' too-large refusal: a route may pass its own 413; left out,
 * it stays a test file's `test_file_too_large`, so the test files' and
 * templates' routes answer as before. A bare Fastify with the multipart parser
 * and two routes, one of each, reading `name` then `file`.
 */

const MAX = 32;

function body(file: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----telflo-${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nA name\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\n` +
        "Content-Type: application/octet-stream\r\n\r\n",
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("readUploadParts' too-large refusal", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify();
    await server.register(multipart);
    for (const [path, options] of [
      ["/default", undefined],
      ["/logo", { tooLarge: () => new AppError("organization_logo_too_large", "The logo must be 2 MB or smaller.", 413) }],
    ] as const) {
      server.post(path, async (request, reply) => {
        try {
          const parts = await readUploadParts(request, MAX, ["name", "file"], options);
          const bytes = await buffer(parts.file.file);
          await parts.finish();
          return { name: parts.fields.name, sizeBytes: bytes.length };
        } catch (error) {
          discardUnreadUpload(request);
          if (error instanceof AppError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
          throw error;
        }
      });
    }
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("left out: a file one byte over is 413 test_file_too_large, as the test files' and templates' routes answer", async () => {
    const reply = await server.inject({ method: "POST", url: "/default", ...body(Buffer.alloc(MAX + 1, 1)) });
    expect(reply.statusCode).toBe(413);
    expect(reply.json()).toEqual({ code: "test_file_too_large", message: `The file is larger than ${MAX} bytes.` });
  });

  it("passed: a file one byte over is the route's own 413", async () => {
    const reply = await server.inject({ method: "POST", url: "/logo", ...body(Buffer.alloc(MAX + 1, 1)) });
    expect(reply.statusCode).toBe(413);
    expect(reply.json()).toEqual({ code: "organization_logo_too_large", message: "The logo must be 2 MB or smaller." });
  });

  it.each(["/default", "/logo"])("%s: a file of exactly maxBytes is read whole", async (url) => {
    const reply = await server.inject({ method: "POST", url, ...body(Buffer.alloc(MAX, 1)) });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ name: "A name", sizeBytes: MAX });
  });

  it.each(["/default", "/logo"])("%s: a body that isn't multipart is still 400 invalid_request", async (url) => {
    const reply = await server.inject({ method: "POST", url, payload: { name: "A name" } });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toEqual({ code: "invalid_request", message: "The request was not valid." });
  });
});
