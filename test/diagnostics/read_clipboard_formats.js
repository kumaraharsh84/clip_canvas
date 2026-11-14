// Prints what is on the clipboard right now: every type Electron lists, and
// how many bytes each holds. Windows' own formats show up as
//   electron application/osclipboard;format="<name>"
// Reads only; prints sizes, never the content.
//
//   npx electron test/diagnostics/read_clipboard_formats.js
const { app, clipboard } = require("electron");

app.whenReady().then(async () => {
  try {
    const items = await clipboard.read();
    console.log(`${items.length} item(s) on the clipboard`);
    for (const item of items) {
      for (const type of item.types) {
        try {
          const blob = await item.getType(type);
          console.log(`  ${type}   ${blob.size} bytes`);
        } catch (err) {
          console.log(`  ${type}   not readable: ${err.message}`);
        }
      }
    }
    console.log("text length:", (await clipboard.readText()).length);
  } catch (err) {
    console.error("could not read the clipboard:", err.message);
  }
  app.exit(0);
});
