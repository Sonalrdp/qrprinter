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
  - PAYMENTS (Razorpay): put RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET in .env.
    With no keys the site stays in SIMULATED mode (testing only, nothing is verified).
    * Plan purchases: paid through Razorpay Checkout; the activation key is created only after the payment is verified.
    * Customer print payments: split by Razorpay Route straight to the shop's UPI ID. Shops enter their UPI ID,
      the name on that UPI account and their mobile number in the agent (Page settings).
    * Razorpay dashboard: add a webhook to https://YOUR-DOMAIN/api/razorpay/webhook for payment.captured.
    * Ask Razorpay support to enable Route and VPA Settlements. UPI linked accounts work with LIVE keys only;
      with TEST keys, checkout works but the money is not split to shops.
    * PLATFORM_FEE_PERCENT in .env is your cut of each print payment (default 0).
  - Edit plan prices at the top of server/server.js (PRICES).
  - Supported uploads: PDF and images. Word files must be saved as PDF first.
  - Printing uses the pdf-to-printer package (Windows).
