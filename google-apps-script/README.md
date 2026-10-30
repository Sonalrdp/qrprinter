# Google Apps Script Setup Guide for PrintQR

This Google Apps Script connects your PrintQR server to a Google Spreadsheet for:
1. **Dual Storage** of users (`Users` sheet), activation keys (`Keys` sheet), audit logs (`Logs` sheet), and print jobs (`PrintJobs` sheet).
2. **Server Auto-Recovery**: If the server memory/disk resets, it automatically detects and restores user credentials and Razorpay keys directly from Google Sheets.
3. **Automated OTP Delivery**: Sends real email OTPs via Google's `MailApp` with 0 external API cost.
4. **Weekly Sunday Night Reports**: Automatically emails the week's print jobs in Excel/CSV format every Sunday at 11:00 PM IST and clears the sheet for the new week.

---

### Step 1: Create a Google Spreadsheet
1. Go to [Google Sheets](https://sheets.new) and create a new blank spreadsheet.
2. Name it **`PrintQR Database`**.

### Step 2: Open Apps Script
1. In the Google Sheet top menu, click **Extensions** &rarr; **Apps Script**.
2. Delete any default code in `Code.gs`.
3. Open `google-apps-script/Code.gs` from this project, copy all the code, and paste it into the editor.
4. (Optional) In line 15 of `Code.gs`, update `ADMIN_EMAIL_NOTIFICATION` with your email where you want to receive weekly print job Excel reports.
5. Click the **Save** icon (disk icon or `Ctrl+S`).

### Step 3: Run Setup Directly from Google Sheets Menu
1. Save the code (`Ctrl+S`) in the Apps Script editor and switch back to your **Google Sheet** tab.
2. **Refresh the page** (F5).
3. In the top toolbar next to *Help*, you will see a new custom menu: **`⚡ PrintQR Tools`**!
4. Click **`⚡ PrintQR Tools`** &rarr; **`🛠️ 1. Setup All Sheets & Headers`**:
   - First time running: Google will prompt for permission &rarr; click **Continue** &rarr; select your Google account &rarr; click **Advanced** &rarr; **Go to Untitled project (unsafe)** &rarr; click **Allow**.
   - It will automatically create and format all 4 sheets (`Users`, `Keys`, `Logs`, `PrintJobs`) with bold headers.
5. Click **`⚡ PrintQR Tools`** &rarr; **`⏰ 2. Install Sunday 11 PM Email Trigger`**:
   - This sets up the automatic Sunday night 11:00 PM IST email trigger!
6. (Optional) You can also use:
   - **`📧 3. Trigger PrintJobs Email Now (Test)`** to test generating and receiving the print jobs Excel report right away.
   - **`🧪 4. Send Test OTP Email`** to test sending a branded OTP email to any address.

### Step 4: Deploy as a Web App
1. Click the blue **Deploy** button (top right) &rarr; **New deployment**.
2. Click the gear icon next to "Select type" &rarr; select **Web app**.
3. Fill in the fields:
   - **Description**: `PrintQR Backend API`
   - **Execute as**: **Me** (`your-email@gmail.com`)
   - **Who has access**: **Anyone**
4. Click **Deploy**.
5. Copy the **Web app URL** (it looks like `https://script.google.com/macros/s/AKfycb.../exec`).

### Step 5: Add Web App URL to your `.env`
Open your `.env` file and add:
```env
GOOGLE_SCRIPT_URL=https://script.google.com/macros/s/AKfycb.../exec
```

Your PrintQR server is now completely connected to Google Sheets!

