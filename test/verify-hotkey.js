// ─── test/verify-hotkey.js ───────────────────────────────────────────────────
// Checks for src/main/hotkey.js: the defaults, which shortcuts may be chosen,
// which one is used when some are taken, and the canonical form they are
// saved in.
//
// Usage:  node test/verify-hotkey.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const { DEFAULT_HOTKEY, DEFAULT_HOTKEYS, normalize, check, choose, display } =
  require(path.join(__dirname, "..", "src", "main", "hotkey.js"));

let failures = 0;
const ok = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? "   " + detail : ""}`);
};

console.log("\n-- the defaults --");
{
  const bad = DEFAULT_HOTKEYS.filter((d) => { const r = check(d); return !r.ok || r.warning || r.hotkey !== d; });
  ok("every default is allowed, canonical, and has no warning", bad.length === 0, bad.join(", ") || DEFAULT_HOTKEYS.join(", "));
  ok("the first default is Win + Alt + V", display(DEFAULT_HOTKEY) === "Win + Alt + V", display(DEFAULT_HOTKEY));
  ok("none is the old Ctrl+Shift+V", !DEFAULT_HOTKEYS.includes("Ctrl+Shift+V"));
}

console.log("\n-- one canonical form --");
{
  const cases = [
    ["ctrl+alt+k", "Ctrl+Alt+K"],
    ["Alt+Ctrl+K", "Ctrl+Alt+K"],
    ["CommandOrControl+Shift+V", "Ctrl+Shift+V"],
    ["Win+Shift+f5", "Super+Shift+F5"],
    ["Alt+Win+V", "Super+Alt+V"],
    ["Ctrl+Shift+Alt+V", "Ctrl+Alt+Shift+V"],
    ["Ctrl + Alt + space", "Ctrl+Alt+Space"],
    ["Ctrl+Alt+PageDown", "Ctrl+Alt+PageDown"],
    ["Ctrl+Alt+=", "Ctrl+Alt+="],
    ["Ctrl++", "Ctrl+Plus"],
  ];
  const bad = cases.filter(([i, o]) => normalize(i) !== o).map(([i, o]) => `${i} -> ${normalize(i)} (want ${o})`);
  ok("spellings normalise to one form", bad.length === 0, bad.join("; ") || `${cases.length} spellings`);

  const junk = ["", "Ctrl+Alt", "Ctrl+K+J", "Ctrl+Hyper+K", "Ctrl+Alt+F25", "Ctrl+", "Ctrl+Alt+ü"];
  const accepted = junk.filter((j) => normalize(j) !== null);
  ok("malformed shortcuts are rejected", accepted.length === 0, accepted.join(", ") || `${junk.length} rejected`);
}

console.log("\n-- what may be chosen --");
{
  const r1 = check("Shift+A");
  ok("a shortcut without Ctrl, Alt or Win is refused", !r1.ok && /Ctrl, Alt or the Windows key/.test(r1.error), r1.error);
  const r2 = check("F9");
  ok("a bare function key is refused", !r2.ok);
  const reserved = ["Ctrl+C", "ctrl+v", "Alt+Tab", "Alt+F4", "Win+L", "Win+V", "Win+Shift+S"].filter((k) => check(k).ok);
  ok("Windows' basic shortcuts are refused", reserved.length === 0, reserved.join(", ") || "7 refused");
  const r3 = check("Ctrl+Shift+V");
  ok("Ctrl+Shift+V is allowed, with a warning", r3.ok && /Many apps use Ctrl \+ Shift \+ V/.test(r3.warning || ""), r3.warning);
  const r4 = check("Alt+K");
  ok("Alt + a letter is allowed, with a warning", r4.ok && /opens menus/.test(r4.warning || ""), r4.warning);
  const quiet = ["Ctrl+Alt+K", "Ctrl+Alt+Space", "Ctrl+Shift+F12", "Win+Alt+C"].filter((k) => { const r = check(k); return !r.ok || r.warning; });
  ok("uncommon combinations are allowed without a warning", quiet.length === 0, quiet.join(", ") || "4 allowed");
}

console.log("\n-- which one is used when some are taken --");
{
  // A desktop where some shortcuts belong to other programs.
  const desk = (...taken) => (acc) => !taken.includes(acc);

  const a = choose(null, desk());
  ok("nothing saved, nothing taken: the first default, no note", a.hotkey === DEFAULT_HOTKEY && a.note === null, JSON.stringify(a));

  const b = choose(null, desk(DEFAULT_HOTKEY));
  ok("the first default taken: the next one, and a note saying why",
     b.hotkey === DEFAULT_HOTKEYS[1] && /Win \+ Alt \+ V is used by another app, so ClipCanvas is using Ctrl \+ Alt \+ V/.test(b.note), b.note);

  const c = choose("Ctrl+Alt+K", desk());
  ok("a saved shortcut that is free is used, no note", c.hotkey === "Ctrl+Alt+K" && c.note === null, JSON.stringify(c));

  const d = choose("Ctrl+Alt+K", desk("Ctrl+Alt+K"));
  ok("a saved shortcut that is taken: a default for now, and a note",
     d.hotkey === DEFAULT_HOTKEY && /Ctrl \+ Alt \+ K is used by another app, so ClipCanvas is using Win \+ Alt \+ V/.test(d.note), d.note);

  const e = choose(null, desk(...DEFAULT_HOTKEYS));
  ok("every default taken: none, and a note naming them all",
     e.hotkey === null && DEFAULT_HOTKEYS.every((k) => e.note.includes(display(k))) && /pick a shortcut/.test(e.note), e.note);

  const tries = [];
  choose(DEFAULT_HOTKEY, (acc) => { tries.push(acc); return false; });
  ok("a saved shortcut that is also a default is not tried twice",
     tries.filter((t) => t === DEFAULT_HOTKEY).length === 1, tries.join(", "));
}

console.log("\n-- how they are shown --");
ok("modifiers are spaced, Super is Win", display("Super+Ctrl+Shift+K") === "Win + Ctrl + Shift + K", display("Super+Ctrl+Shift+K"));

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
