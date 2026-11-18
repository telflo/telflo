// The kind smoke's TCP probe (scripts/smoke-kind.sh; D33-1 spec decision
// 35, Preflight ruling 19; D36-2 Preflight ruling 4): run in a throwaway pod
// of the API's image, mounted from a ConfigMap, as
//
//   node /probe/tcp-probe.js <host>:<port>...
//
// It waits 5 s first (kindnet doesn't police a new pod's first moments, so
// an earlier probe could pass a policy's drop), then opens one TCP
// connection to each target at once and prints one line a target,
// `<host>:<port> open` or `<host>:<port> closed <why>` (a timeout, which is
// how a NetworkPolicy's drop looks, or the error's code: a name that doesn't
// resolve, a refusal), then exits 0. It sends nothing on a connection it
// opens.
"use strict";
const net = require("node:net");

const START_DELAY_MS = 5000;
const TIMEOUT_MS = 4000;
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.log("no targets");
  process.exit(2);
}
let left = targets.length;
const probe = (target) => {
  const colon = target.lastIndexOf(":");
  const host = target.slice(0, colon);
  const port = Number(target.slice(colon + 1));
  let settled = false;
  const socket = net.connect({ host, port });
  const done = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    console.log(`${target} ${result}`);
    left -= 1;
    if (left === 0) process.exit(0);
  };
  const timer = setTimeout(() => done("closed timeout"), TIMEOUT_MS);
  socket.on("connect", () => done("open"));
  socket.on("error", (error) => done(`closed ${error.code || "error"}`));
};
setTimeout(() => targets.forEach(probe), START_DELAY_MS);
