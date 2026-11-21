import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

for (const phase of ["installing on registration", "waiting on update notification"] as const) {
  test(`activates an update that was already ${phase}`, async () => {
    const messages: string[] = [];
    const worker = Object.assign(new EventTarget(), {
      state: "installing",
      postMessage: ({ type }: { type: string }) => messages.push(type),
    });
    const registration = Object.assign(new EventTarget(), {
      installing: phase === "installing on registration" ? worker : null,
      waiting: null as typeof worker | null,
    });
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: { scriptURL: "/__test__/legacy-worker.js" },
      register: async () => registration,
    });
    let reloads = 0;
    const source = readFileSync(new URL("../../public/sw-register.js", import.meta.url), "utf8");
    vm.runInNewContext(source, {
      navigator: { serviceWorker },
      window: { isSecureContext: true, location: { reload: () => { reloads++; } } },
      location: { hostname: "127.0.0.1" },
    });
    await new Promise<void>(resolve => setImmediate(resolve));

    worker.state = "installed";
    registration.waiting = worker;
    if (registration.installing) worker.dispatchEvent(new Event("statechange"));
    registration.dispatchEvent(new Event("updatefound"));
    registration.dispatchEvent(new Event("updatefound"));
    assert.deepEqual(messages, ["SKIP_WAITING"]);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(reloads, 1);
  });
}
