// ─── test/verify-classify.js ──────────────────────────────────────────────
// Regression check for clip classification (src/renderer/canvas/classify.js).
//
// Every case below is synthetic, and stands for a kind of clip that is easy to
// misclassify. Each one reproduces the property that makes its kind hard:
//   - prose stored as "code" at capture time, shown as "Other code"
//   - chats that quote one command, filed as Shell
//   - reports whose ===== dividers made them look symbol-dense
//   - terminal sessions filed as Other code, JSON or SQL
//   - a Python module whose # ==== banners made it look like prose
//
// Usage:  node test/verify-classify.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const C = require(path.join(__dirname, "..", "src", "renderer", "canvas", "classify.js"));

const CASES = [
  // ── prose stored as code ─────────────────────────────────────────────────
  ["prose", "English prompt",
   "We are starting phase 1 of the dashboard integration.\n\nBefore changing anything, audit the current login flow.\n" +
   "Do not modify any files yet.\nDo not install packages.\n\nReport what you find and wait for approval."],
  ["prose", "Hinglish chat (no English stopwords to lean on)",
   "Theek hai, seedha jawab: jab request server pe pahunchegi tab token check hoga.\n" +
   "Agar token galat hai toh response 401 aayega, warna data wapas milega.\nAb isko ek baar test karke batao kya hua."],
  ["prose", "chat that quotes a command",
   "Haan bilkul, pehle ye check karo ki service chal rahi hai ya nahi.\n" +
   "Uske baad logs dekho, wahi se pata chalega problem kahan hai.\n\n    npm run build\n\n" +
   "Agar build pass ho jaaye toh mujhe output bhejo, phir aage ka plan batata hoon."],
  ["prose", "report with ===== dividers and a table",
   "AUDIT REPORT\n==================================================\n\nSummary of the review for the dashboard module.\n\n" +
   "==================================================\nFINDINGS\n==================================================\n\n" +
   "| Area | Status | Notes |\n|------|--------|-------|\n| Login | Pass | Works as expected |\n| Charts | Fail | Missing data |\n\n" +
   "The charts fail because the endpoint returns an empty list for new users.\n" +
   "==================================================\nRECOMMENDATION\n==================================================\n" +
   "Return an empty state message instead of an empty chart."],
  ["prose", "bulleted plan with short lines",
   "# Implementation Plan\n\n## Phase 1\n- Audit routes\n- List templates\n- Check static files\n\n## Phase 2\n" +
   "- Replace the dashboard view with the new design\n- Keep the old view as a fallback\n\n## Out of scope\n- Database changes"],
  ["prose", "heading ending in parentheses",
   "Phase 2 Preparation (No Code Changes)\n\nConfirm which templates are still in use (and by which views).\n" +
   "List every place the old sidebar is included (base, dashboard, settings).\nNote anything that depends on it."],
  ["prose", "task prompt dense with inline code",
   "Browser task: open the dashboard page and confirm the chart container (div#chart-root) renders after login.\n" +
   "Check that window.chartData is defined before the render call runs (look for chartData = [] in the page source).\n" +
   "Click the refresh button (button[data-action=refresh]) and confirm the request to /api/stats returns 200.\n" +
   "Report any console errors (TypeError, ReferenceError) together with the line that raised them."],

  // ── terminal sessions ────────────────────────────────────────────────────
  ["shell", "cmd prompt", "C:\\Users\\demo>ping 192.168.0.10\n\nPinging 192.168.0.10 with 32 bytes of data:\nReply from 192.168.0.10: bytes=32 time<1ms TTL=64"],
  ["shell", "cmd prompt, first character cut off", ":\\Users\\demo>ipconfig /all\n\nWindows IP Configuration\n   Host Name . . . . : demo-pc"],
  ["shell", "PowerShell prompt in a venv", "(.venv) PS D:\\work\\app> python manage.py migrate\nOperations to perform:\n  Apply all migrations: admin, auth\nRunning migrations:\n  No migrations to apply."],
  ["shell", "bash prompt", "demo@server:~/app$ curl -s http://127.0.0.1:8000/health\n{\"status\": \"ok\"}\ndemo@server:~/app$"],
  ["shell", "cmd banner", "Microsoft Windows [Version 10.0.26200.1000]\n(c) Microsoft Corporation. All rights reserved.\n\nC:\\Windows\\system32>"],
  ["shell", "systemctl status",
   "● app.service - Demo App Service\n     Loaded: loaded (/etc/systemd/system/app.service; enabled)\n     Active: active (running) since Mon 2026-09-01 10:00:00 UTC\n   Main PID: 1234 (python3)\n" +
   "Sep 01 10:00:01 server python3[1234]: INFO Started"],
  ["shell", "PowerShell table output",
   "Name        InterfaceDescription            ifIndex Status\n----        --------------------            ------- ------\nEthernet    Realtek PCIe GbE Family Controller      7 Up\nWi-Fi       Intel Wireless-AC 9560                 12 Disconnected"],
  ["shell", "PowerShell error block",
   "Access to the path 'C:\\ProgramData\\demo\\lib' is denied.\nAt line:1 char:1\n+ Remove-Item -Path 'C:\\ProgramData\\demo\\lib' -Recurse\n+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n" +
   "    + CategoryInfo          : PermissionDenied\n    + FullyQualifiedErrorId : RemoveFileSystemItemUnAuthorizedAccess"],
  ["shell", "bare command list", "cd ~/app/frontend\nnpm install\nnpm run build\nls -lh dist"],

  // ── real code must stay code ─────────────────────────────────────────────
  ["py", "Python module with # ==== banners",
   "import os\nimport sys\n\n# ============================================\n# Configuration\n# ============================================\n\n" +
   "DEBUG = os.environ.get(\"DEBUG\") == \"1\"\n\n# ============================================\n# Helpers\n# ============================================\n\n" +
   "def load(path):\n    with open(path) as f:\n        return f.read()\n\n\nclass Loader:\n    def __init__(self, root):\n        self.root = root"],
  ["py", "Python module opening with a docstring",
   "\"\"\"Configuration management for the demo service.\n\nReads settings from the environment and provides defaults.\n\"\"\"\n\nimport os\n\n\n" +
   "def get_setting(name, default=None):\n    value = os.environ.get(name)\n    return value if value is not None else default\n\n\nclass Settings:\n    def __init__(self):\n        self.debug = get_setting(\"DEBUG\", \"0\") == \"1\""],
  ["js", "JS function", "const total = (items) => {\n  let sum = 0;\n  for (const it of items) sum += it.value;\n  return sum;\n};\n\nmodule.exports = { total };"],
  ["code", "JS object fragment", "alertOverlay: {\n  position: 'fixed',\n  inset: 0,\n  background: 'rgba(0,0,0,0.6)',\n},"],
  ["sql", "SQL query (English keywords, few symbols)", "SELECT id, title, created_at\nFROM clips\nWHERE workspace_id = 1\n  AND deleted_at IS NULL\nORDER BY created_at DESC;"],
  ["sql", "SQL one-liner, lowercase", "select * from users where email = 'a@b.test';"],
  ["prose", "to-do list that starts like SQL (Select / Update / Delete)",
   "Select the file from the list.\nUpdate the name in the settings panel.\nDelete the old files after the backup finishes."],
  ["prose", "sentence that mentions a query",
   "To check the counts, run SELECT * FROM users against the backup and compare them with production.\n" +
   "If the numbers differ by more than a few rows, stop and tell me before changing anything."],
  // Nested YAML is not recognised as config (a pre-existing gap: counting
  // "key:" and "- item" lines as config would also claim markdown bullet
  // lists). What matters here is that the prose rule does not swallow it.
  ["code", "YAML config -- must not become prose", "services:\n  web:\n    image: nginx\n    restart: always\n  db:\n    image: postgres",
   "text" /* stored as text: zero code signals */],
  ["json", ".env config", "DEBUG=1\nSECRET_KEY=change-me\nDATABASE_URL=postgres://localhost/demo\nALLOWED_HOSTS=localhost"],
  ["html", "HTML", "<section class=\"card\">\n  <header><h2>Recent</h2></header>\n  <ul>\n    <li><a href=\"#a\">First</a></li>\n  </ul>\n</section>"],
  ["css", "CSS", ".card {\n  display: grid;\n  gap: 8px;\n  color: #c9d6e0;\n}\n\n.card:hover {\n  border-color: #6fa8dc;\n}"],
  ["json", "JSON", "{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\",\n  \"private\": true\n}"],
];

let failures = 0;
let id = 0;
for (const [expected, what, content] of CASES) {
  const got = C.categoryOf({ id: ++id, type: "code", content }).id;
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${("expect " + expected).padEnd(13)} ${("got " + got).padEnd(11)} ${what}`);
}

// The capture side must agree with the display side for prose and terminals.
const { classify } = (() => {
  try { return require(path.join(__dirname, "..", "src", "main", "classifyText.js")); }
  catch (_) { return {}; }
})();
if (classify) {
  console.log("\n-- capture-time type (what gets stored) --");
  for (const [expected, what, content, storedAs] of CASES) {
    const stored = classify(content);
    const want = storedAs || (expected === "prose" ? "text" : "code");
    const ok = stored === want;
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : " FAIL "} ${("stored " + stored).padEnd(12)} ${what}`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
