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

### Step 3: Initialize the Sheets & Setup Sunday Trigger
1. In the Apps Script toolbar, select the function **`initAllSheets`** from the function dropdown and click **Run**.
2. Click **Review permissions** &rarr; select your Google account &rarr; click **Advanced** &rarr; **Go to Untitled project (unsafe)** &rarr; click **Allow**.
3. Now select the function **`installWeeklySundayTrigger`** and click **Run**.
   - This sets up the automatic Sunday night email trigger!

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
