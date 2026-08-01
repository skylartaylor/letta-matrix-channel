export const TEST_CRYPTO_DATABASE_NAME = "matrix-js-sdk::matrix-sdk-crypto";

const STORES = [
  "backup_keys",
  "core",
  "devices",
  "direct_withheld_info",
  "gossip_requests",
  "identities",
  "inbound_group_sessions3",
  "olm_hashes",
  "outbound_group_sessions",
  "room_settings",
  "secrets_inbox",
  "session",
  "tracked_users",
];

export async function installTestCryptoDatabase() {
  const request = globalThis.indexedDB.open(TEST_CRYPTO_DATABASE_NAME, 12);
  await new Promise((resolve, reject) => {
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const name of STORES) database.createObjectStore(name);
      const gossip = request.transaction.objectStore("gossip_requests");
      gossip.createIndex("by_info", "info", { unique: true });
      gossip.createIndex("unsent", "unsent");
      const inbound = request.transaction.objectStore("inbound_group_sessions3");
      inbound.createIndex("backed_up_to", "backed_up_to");
      inbound.createIndex("backup", "needs_backup");
      inbound.createIndex(
        "inbound_group_session_sender_key_sender_data_type_idx",
        ["sender_key", "sender_data_type", "session_id"],
      );
    }, { once: true });
    request.addEventListener("success", resolve, { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Could not install test Matrix crypto database")),
      { once: true },
    );
  });
  const database = request.result;
  const transaction = database.transaction("core", "readwrite");
  transaction.objectStore("core").put({ testOnly: true }, "account");
  await new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("Could not seed test Matrix crypto database")),
      { once: true },
    );
  });
  database.close();
}
