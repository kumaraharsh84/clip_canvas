// ─── test/verify-ipc.js ──────────────────────────────────────────────────────
// The three places that must agree about IPC, checked against each other:
//
//   src/main/ipc.js      the table of channels the main process answers
//   src/main/preload.js  the allow-list the windows are held to
//   main.js / renderer   the events sent, and the events listened for
//
// A sandboxed preload cannot require ipc.js, so its list is a second copy by
// necessity. This is what keeps the copy honest: a channel answered but not
// allowed is dead code, and a channel allowed but not answered is a call that
// never returns.
//
// Usage:  node test/verify-ipc.js
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const { ipcHandlers, registerIpc } = require(path.join(__dirname, "..", "src", "main", "ipc.js"));

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const diff = (a, b) => a.filter((x) => !b.includes(x));

/** The string literals of `const NAME = [ ... ];` in a source file. */
function listIn(source, name) {
  const m = source.match(new RegExp("const " + name + " = \\[([\\s\\S]*?)\\];"));
  if (!m) throw new Error("no " + name + " list found");
  return m[1].replace(/\/\/.*$/gm, "").match(/"[^"]+"/g).map((s) => s.slice(1, -1));
}
const all = (source, re) => [...source.matchAll(re)].map((m) => m[1]);

(async () => {
  const preload = read("src", "main", "preload.js");
  const main = read("src", "main", "main.js");
  const windows = read("src", "renderer", "renderer.js") + read("src", "renderer", "settings.js");

  // A host that answers anything: only the table's keys matter here.
  const host = new Proxy({}, { get: (_t, k) => (k === "db" ? host : (...a) => a[0]) });
  const table = ipcHandlers(host);
  const answered = Object.keys(table);
  const allowed = listIn(preload, "CHANNELS");
  const events = listIn(preload, "EVENTS");

  console.log("\n-- channels --");
  ok("every channel the windows may call is answered", diff(allowed, answered).length === 0,
     diff(allowed, answered).join(", ") || `${allowed.length} channels`);
  ok("every channel answered is one the windows may call", diff(answered, allowed).length === 0,
     diff(answered, allowed).join(", "));
  const wrapped = all(preload, /safeInvoke\("([^"]+)"/g);
  ok("every wrapper in the preload uses an allowed channel", diff(wrapped, allowed).length === 0,
     diff(wrapped, allowed).join(", ") || `${wrapped.length} wrappers`);
  ok("no channel is listed twice", new Set(allowed).size === allowed.length);

  console.log("\n-- events --");
  const sent = [...new Set(all(main, /broadcast\("([^"]+)"/g))];
  const heard = [...new Set(all(windows, /api\.on\("([^"]+)"/g))];
  ok("every event main.js sends is let through", diff(sent, events).length === 0, diff(sent, events).join(", ") || sent.join(", "));
  ok("every event let through is sent", diff(events, sent).length === 0, diff(events, sent).join(", "));
  ok("the windows listen only for events that exist", diff(heard, events).length === 0, diff(heard, events).join(", "));

  console.log("\n-- the envelope --");
  const registered = {};
  const errors = [];
  registerIpc({ handle: (channel, fn) => { registered[channel] = fn; } },
              { "t:ok": (a, b) => a + b, "t:throws": () => { throw new Error("no"); }, "t:later": async () => "done" },
              (channel, err) => errors.push(channel + ": " + err.message));
  const good = await registered["t:ok"]({}, 2, 3);
  ok("a result is wrapped, and the event argument dropped", good.success === true && good.data === 5, JSON.stringify(good));
  const later = await registered["t:later"]({});
  ok("a promise is awaited", later.success === true && later.data === "done");
  const bad = await registered["t:throws"]({});
  ok("a throw becomes an answer, and is reported", bad.success === false && bad.error === "no" && errors[0] === "t:throws: no",
     JSON.stringify(bad));

  console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
