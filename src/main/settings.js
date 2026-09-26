// ─── src/main/settings.js ────────────────────────────────────────────────────
// A few app settings in one JSON file next to the database.
//
// Small enough that a library (electron-store, and its schema validator) was
// not worth its dependency tree. Writes go to a temp file that is then renamed
// over the old one, so a crash mid-write leaves the previous settings intact
// rather than half a file.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const log = require("./log");

class Settings {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (_) {
      // Missing or unreadable: start from the defaults. The next set() writes it.
    }
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    this.data[key] = value;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error("could not save settings:", err.message);
    }
    return value;
  }
}

module.exports = { Settings };
