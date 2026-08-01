import "fake-indexeddb/auto";
import { installTestCryptoDatabase } from "./crypto-db-test-fixture.mjs";
import {
  persistCryptoState,
  restoreCryptoState,
} from "./idb-state.mjs";

const [stateDir, crashPoint] = process.argv.slice(2);
if (!stateDir || !crashPoint) {
  throw new Error("snapshot crash child requires stateDir and crashPoint");
}

function request(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

await restoreCryptoState(stateDir);
await installTestCryptoDatabase();
const database = await request(
  globalThis.indexedDB.open("matrix-js-sdk::matrix-sdk-crypto", 12),
);
const transaction = database.transaction("core", "readwrite");
transaction.objectStore("core").put(crashPoint, "snapshot-crash-point");
await new Promise((resolve, reject) => {
  transaction.addEventListener("complete", resolve, { once: true });
  transaction.addEventListener("error", () => reject(transaction.error), { once: true });
});
database.close();

await persistCryptoState(stateDir, {
  onPublicationStep(step) {
    if (step === crashPoint) process.kill(process.pid, "SIGKILL");
  },
});
throw new Error(`snapshot crash point ${crashPoint} was not reached`);
