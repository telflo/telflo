import { afterAll, beforeAll } from "vitest";
import { createOpampServerClient, type OpampServerClient } from "../opamp-server/client.js";
import { startFakeOpampServer, type FakeOpampServer } from "./fake-opamp-server.js";

// Every server needs an opamp-server, so every test file that builds one
// starts the OpenAPI-checked fake (fake-opamp-server.ts) and passes its
// client as buildServer's `opampServer`. One fake per file:
//
//   const opamp = useFakeOpampServer();
//   ...
//   buildServer({ settings, db, mailer, opampServer: opamp.client, ... });
//
// Call it at the top of the file, outside any describe: its beforeAll then
// runs before the file's own, and its afterAll after them, once the servers
// are closed. The afterAll closes the fake, which fails the file if the
// platform sent it a request (or it sent a reply) that broke the contract
// and no test read the violation. Tests that inspect the fake read
// `opamp.fake`.

export interface FakeOpampServerForFile {
  /** The file's fake; read it inside a hook or a test, once it has started. */
  readonly fake: FakeOpampServer;
  /** A client of the fake, for buildServer's `opampServer`. */
  readonly client: OpampServerClient;
}

export function useFakeOpampServer(): FakeOpampServerForFile {
  let started: { fake: FakeOpampServer; client: OpampServerClient } | undefined;

  beforeAll(async () => {
    const fake = await startFakeOpampServer();
    started = { fake, client: createOpampServerClient({ url: fake.url, secret: fake.secret }) };
  });

  afterAll(async () => {
    const closing = started;
    started = undefined;
    await closing?.fake.close();
  });

  function current(): { fake: FakeOpampServer; client: OpampServerClient } {
    if (started === undefined) {
      throw new Error("useFakeOpampServer's fake is read before its beforeAll ran, or after its afterAll");
    }
    return started;
  }

  return {
    get fake() {
      return current().fake;
    },
    get client() {
      return current().client;
    },
  };
}
