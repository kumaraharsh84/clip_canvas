const { clipboard } = require('electron');
const { app } = require('electron');

app.whenReady().then(() => {
  const formats = clipboard.availableFormats();
  console.log("Formats:", formats);
  const text = clipboard.readText();
  console.log("Text length:", text.length);
  
  // Try getClipboardFiles logic
  if (formats.includes("FileNameW")) {
     console.log("Has FileNameW");
  }
  if (formats.includes("text/uri-list")) {
     console.log("Has text/uri-list");
     console.log(clipboard.read("text/uri-list"));
  }
  
  app.exit();
});
