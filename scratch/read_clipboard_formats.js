const { app, clipboard } = require("electron");

app.whenReady().then(() => {
  console.log("=== CLIPBOARD FORMATS ===");
  const formats = clipboard.availableFormats();
  console.log("Available formats:", formats);
  
  for (const format of formats) {
    try {
      console.log(`Format: ${format}`);
      const text = clipboard.read(format);
      console.log(`  As string: "${text.slice(0, 100)}"`);
    } catch (e) {
      console.log(`  Failed to read: ${e.message}`);
    }
  }
  
  // Try to read standard format for file paths on Windows (FileNameW is standard Unicode buffer)
  if (formats.includes("FileNameW")) {
    const buf = clipboard.readBuffer("FileNameW");
    console.log("FileNameW buffer length:", buf.length);
    // FileNameW is null-terminated UTF-16LE string(s)
    const str = buf.toString("utf16le").replace(/\0+$/, "");
    console.log("FileNameW value:", str);
  }
  
  if (formats.includes("text/uri-list")) {
    console.log("text/uri-list value:", clipboard.read("text/uri-list"));
  }

  app.exit(0);
});
