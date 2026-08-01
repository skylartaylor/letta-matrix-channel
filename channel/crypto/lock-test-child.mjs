import { acquireCryptoStateLock } from "./idb-state.mjs";

const [stateDir, mode] = process.argv.slice(2);

function send(message, exitCode) {
  if (typeof process.send !== "function") {
    process.exit(exitCode);
  }
  process.send(message, () => {
    if (exitCode !== undefined) process.exit(exitCode);
  });
}

try {
  const release = await acquireCryptoStateLock(stateDir);
  if (mode === "crash") {
    send({ type: "acquired", pid: process.pid }, 0);
  } else {
    send({ type: "acquired", pid: process.pid });
    await new Promise((resolve) => {
      process.once("message", (message) => {
        if (message === "release") resolve();
      });
    });
    await release();
    send({ type: "released", pid: process.pid }, 0);
  }
} catch (error) {
  send(
    {
      type: "error",
      pid: process.pid,
      message: error instanceof Error ? error.message : String(error),
    },
    2,
  );
}
