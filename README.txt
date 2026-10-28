PrintQR - full project
======================
PART 1: Run the website + server (your PC or a hosting server)
  1. Double-click run.bat  (installs Node.js if missing, starts server)
  2. Open http://localhost:3000  -> sign up -> pick a plan -> copy key -> download the agent.

ADMIN DASHBOARD
  - Log in on the website with the admin account, you land on #/admin.
  - First start creates it: admin@printqr.local / admin123  -> CHANGE IT:
      set ADMIN_EMAIL and ADMIN_PASSWORD (e.g. in run.bat: set ADMIN_EMAIL=you@mail.com),
      delete server\data.json, start again.
  - Tabs: Overview, Keys (issue free key, +30 days, revoke), Users, Shops, Print jobs, Prices.

PART 2: Shop PC (agent)
  1. Unzip PrintQR-Agent.zip  (also in the "agent" folder here)
  2. Double-click install-and-run.bat
  3. Enter the server address + activation key, choose printers, set page settings, save.
  4. Click the QR icon (top right) -> Print A4 page -> stick it on the counter.

IMPORTANT BEFORE REAL USE
  - Customers on their phones must reach your server. Use a public host (or same Wi-Fi with your PC's
    LAN IP, e.g. http://192.168.1.5:3000 as the server address in the agent) so the QR works.
  - Payments are NOT verified. Plan purchase and customer "I have paid" are simulated.
    Add a gateway (Razorpay/Cashfree) in server/server.js where marked "PAYMENT NOTE".
  - Edit plan prices at the top of server/server.js (PRICES).
  - Supported uploads: PDF and images. Word files must be saved as PDF first.
  - Printing uses the pdf-to-printer package (Windows).
