import { installTestCryptoDatabase } from "./crypto-db-test-fixture.mjs";
import { startCryptoRuntime } from "./runtime.mjs";

const [stateDir, identityJson] = process.argv.slice(2);
if (!stateDir || !identityJson) {
  throw new Error("runtime crash child requires stateDir and identity");
}
const identity = JSON.parse(identityJson);

function request(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function writeProbe() {
  await installTestCryptoDatabase();
  const open = globalThis.indexedDB.open(
    "matrix-js-sdk::matrix-sdk-crypto",
    12,
  );
  await request(open);
  const database = open.result;
  const transaction = database.transaction("core", "readwrite");
  transaction.objectStore("core").put("hard-crash", "crash-probe");
  await new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
  database.close();
}

await startCryptoRuntime({
  accountKey: "hard-crash",
  stateDir,
  identity,
  client: {
    initRustCrypto: writeProbe,
    stopClient: async () => {},
  },
});
process.send?.({ type: "ready" });
