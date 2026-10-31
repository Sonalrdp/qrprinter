/**
 * PrintQR - Google Apps Script Backend (Code.gs)
 * Dual-Storage, Real-time OTP Mailer, Audit Logger & Weekly Sunday PrintJobs Mailer.
 * 
 * Sheets Created Automatically:
 * 1. Users      - User accounts, phone, credentials & Razorpay keys
 * 2. Keys       - Activation keys & plan purchases (48 hr, 3m, 6m, 12m)
 * 3. Logs       - Real-time audit logs (OTP sent, user added, purchases)
 * 4. PrintJobs  - Customer print jobs & weekly Sunday email cleanup
 * 
 * Timestamps are strictly in Indian Standard Time (IST): dd/mm/yyyy-hh:mm:ss
 */

const TIMEZONE = 'Asia/Kolkata';
const ADMIN_EMAIL_NOTIFICATION = 'as854780@gmail.com'; // Change to your preferred admin email

// Format timestamp strictly as: dd/mm/yyyy-hh:mm:ss (IST)
function getISTTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const istDate = new Date(d.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const day = pad(istDate.getDate());
  const month = pad(istDate.getMonth() + 1);
  const year = istDate.getFullYear();
  const hours = pad(istDate.getHours());
  const minutes = pad(istDate.getMinutes());
  const seconds = pad(istDate.getSeconds());
  return `${day}/${month}/${year}-${hours}:${minutes}:${seconds}`;
}

// Get or initialize sheets with headers
function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#EFEFEF');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function initAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const uSheet = getOrCreateSheet(ss, 'Users', [
    'Timestamp', 'User ID', 'Name', 'Email', 'Phone', 'Password Hash', 'Salt',
    'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
    'Demo Used', 'Status', 'OTP'
  ]);
  if (uSheet.getLastColumn() < 13) {
    uSheet.getRange(1, 13).setValue('OTP').setFontWeight('bold').setBackground('#EFEFEF');
  }
  getOrCreateSheet(ss, 'Keys', [
    'Timestamp', 'Key', 'User Email', 'User ID', 'Plan', 'Price (INR)',
    'Status', 'Activated At', 'Expires At'
  ]);
  getOrCreateSheet(ss, 'Logs', [
    'Timestamp', 'Action', 'User Email', 'Details'
  ]);
  getOrCreateSheet(ss, 'PrintJobs', [
    'Timestamp', 'Job ID', 'Shop ID', 'Shop Name', 'Customer File',
    'Pages', 'Copies', 'Color/BW', 'Amount (INR)', 'Status'
  ]);
}

// Write an audit log row to Sheet 3 (Logs)
function logAction(ss, action, userEmail, details) {
  try {
    const sheet = getOrCreateSheet(ss, 'Logs');
    sheet.appendRow([getISTTimestamp(), action, userEmail || '', details || '']);
  } catch (e) {
    console.error('Log error:', e);
  }
}

// Handle GET requests (health check / query)
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  initAllSheets();
  const p = (e && e.parameter) || {};
  if (p.action === 'get_user') {
    const user = findUserInSheet(ss, p.email, p.phone);
    return ContentService.createTextOutput(JSON.stringify({ ok: 1, user }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    app: 'PrintQR Google Apps Script Integration',
    timestamp: getISTTimestamp()
  })).setMimeType(ContentService.MimeType.JSON);
}

// Handle POST requests from PrintQR Server
function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  initAllSheets();
  
  let data = {};
  try {
    data = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    data = (e && e.parameter) || {};
  }
  
  const action = data.action;
  let response = { ok: 0, error: 'Unknown action' };
  
  try {
    switch (action) {
      // 1. Send OTP to email for Signup or Forgot Password
      case 'send_otp': {
        const email = (data.email || '').trim().toLowerCase();
        const phone = (data.phone || '').trim();
        const name = (data.name || 'Valued User').trim();
        const purpose = data.purpose || 'Verification'; // 'Signup' or 'Forgot Password'
        if (!email) throw new Error('Email is required to send OTP.');

        // Use passed OTP from server if present, otherwise generate 6-digit OTP
        const otp = String(data.otp || Math.floor(100000 + Math.random() * 900000));
        
        // Cache OTP with 1 minute (60 seconds) expiry in Apps Script Cache
        const cache = CacheService.getScriptCache();
        cache.put('otp_' + email, otp, 60); // 1 minute
        if (phone) cache.put('otp_' + phone, otp, 60); // 1 minute

        // Store user and OTP in Users sheet immediately BEFORE OTP verification
        const hash = data.hash || '';
        const salt = data.salt || '';
        const usersSheet = getOrCreateSheet(ss, 'Users');
        clearExpiredOtps(usersSheet); // clean up any old expired OTPs

        const existingRow = findUserRow(usersSheet, email, phone);
        if (existingRow > 0) {
          usersSheet.getRange(existingRow, 1).setValue(getISTTimestamp());
          if (name && name !== 'Valued User') usersSheet.getRange(existingRow, 3).setValue(name);
          if (email) usersSheet.getRange(existingRow, 4).setValue(email);
          if (phone) usersSheet.getRange(existingRow, 5).setValue(phone);
          if (hash) usersSheet.getRange(existingRow, 6).setValue(hash);
          if (salt) usersSheet.getRange(existingRow, 7).setValue(salt);
          usersSheet.getRange(existingRow, 12).setValue('Pending OTP');
          usersSheet.getRange(existingRow, 13).setValue(otp); // Store OTP in sheet
        } else {
          const newUserId = 'usr_' + Utilities.getUuid().slice(0, 8);
          usersSheet.appendRow([
            getISTTimestamp(),
            newUserId,
            name,
            email,
            phone,
            hash,
            salt,
            '', // rzpKeyId
            '', // rzpKeySecret
            '', // rzpWebhookSecret
            'No',
            'Pending OTP',
            otp // Store OTP in sheet
          ]);
        }

        // Send Email with formatted HTML template
        const subject = `PrintQR - Your OTP for ${purpose}: ${otp}`;
        const htmlBody = `
          <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px;background:#ffffff">
            <h2 style="color:#D4175A;margin-top:0">PrintQR Security Verification</h2>
            <p style="color:#333;font-size:15px">Hello <b>${name}</b>,</p>
            <p style="color:#555;font-size:14px">Your One-Time Password (OTP) for <b>${purpose}</b> is:</p>
            <div style="background:#F6DCE6;border-radius:8px;padding:16px;text-align:center;margin:20px 0">
              <span style="font-size:32px;font-weight:800;letter-spacing:6px;color:#D4175A">${otp}</span>
            </div>
            <p style="color:#c6104e;font-size:13px;font-weight:600">⏱️ This code is valid for 1 minute only. After 1 minute it will automatically expire and be removed.</p>
            <p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">PrintQR Automated Security System &bull; IST: ${getISTTimestamp()}</p>
          </div>
        `;
        
        try {
          MailApp.sendEmail({
            to: email,
            subject: subject,
            htmlBody: htmlBody
          });
        } catch (mailErr) {
          try {
            GmailApp.sendEmail(email, subject, `Your OTP for ${purpose} is: ${otp}`, { htmlBody: htmlBody });
          } catch (gmailErr) {
            console.error('MailApp and GmailApp failed:', mailErr, gmailErr);
            throw new Error('Email sending failed: ' + mailErr.message);
          }
        }

        // Audit log in Sheet 3 (Logs)
        logAction(ss, 'OTP sent on mail', email, `Purpose: ${purpose}, OTP: ${otp}, Phone: ${phone || 'N/A'}`);
        response = { ok: 1, message: 'OTP sent to your email successfully.' };
        break;
      }

      // 2. Verify OTP and immediately remove it from cache/sheet
      case 'verify_otp': {
        const identifier = (data.email || data.phone || '').trim().toLowerCase();
        const enteredOtp = String(data.otp || '').trim();
        const cache = CacheService.getScriptCache();
        const storedOtp = cache.get('otp_' + identifier);

        const usersSheet = getOrCreateSheet(ss, 'Users');
        const row = findUserRow(usersSheet, data.email, data.phone);
        let sheetOtp = '';
        if (row > 0) {
          sheetOtp = String(usersSheet.getRange(row, 13).getValue() || '').trim();
        }

        const valid = (storedOtp && storedOtp === enteredOtp) || (sheetOtp && sheetOtp === enteredOtp);
        if (!valid) {
          throw new Error('Invalid or expired OTP. Please try again.');
        }

        // Clean up OTP immediately after successful verification
        cache.remove('otp_' + identifier);
        if (row > 0) {
          usersSheet.getRange(row, 13).setValue(''); // Remove OTP from user sheet!
        }
        logAction(ss, 'OTP verified', identifier, 'OTP matched and cleared from sheet');
        response = { ok: 1, verified: true };
        break;
      }

      // 3. User Signup & Data Storage (Users sheet)
      case 'signup_user': {
        const u = data.user || {};
        const email = (u.email || '').trim().toLowerCase();
        const phone = (u.phone || '').trim();
        const usersSheet = getOrCreateSheet(ss, 'Users');

        // Check if user already exists
        const existingRow = findUserRow(usersSheet, email, phone);
        if (existingRow > 0) {
          // Update user to Active and save credentials
          usersSheet.getRange(existingRow, 1).setValue(getISTTimestamp());
          if (u.id) usersSheet.getRange(existingRow, 2).setValue(u.id);
          if (u.name) usersSheet.getRange(existingRow, 3).setValue(u.name);
          if (email) usersSheet.getRange(existingRow, 4).setValue(email);
          if (phone) usersSheet.getRange(existingRow, 5).setValue(phone);
          if (u.hash) usersSheet.getRange(existingRow, 6).setValue(u.hash);
          if (u.salt) usersSheet.getRange(existingRow, 7).setValue(u.salt);
          if (u.rzpKeyId) usersSheet.getRange(existingRow, 8).setValue(u.rzpKeyId);
          if (u.rzpKeySecret) usersSheet.getRange(existingRow, 9).setValue(u.rzpKeySecret);
          if (u.rzpWebhookSecret) usersSheet.getRange(existingRow, 10).setValue(u.rzpWebhookSecret);
          usersSheet.getRange(existingRow, 12).setValue('Active');
          usersSheet.getRange(existingRow, 13).setValue(''); // Remove OTP from sheet
        } else {
          // Add new active user row
          usersSheet.appendRow([
            getISTTimestamp(),
            u.id || '',
            u.name || '',
            email,
            phone,
            u.hash || '',
            u.salt || '',
            u.rzpKeyId || '',
            u.rzpKeySecret || '',
            u.rzpWebhookSecret || '',
            u.demoUsed ? 'Yes' : 'No',
            'Active',
            ''
          ]);
        }

        logAction(ss, 'User added', email, `Name: ${u.name}, Phone: ${phone}, ID: ${u.id}`);
        response = { ok: 1, message: 'User stored in Google Sheet' };
        break;
      }

      // 4. Update Razorpay keys for user
      case 'update_rzp': {
        const email = (data.email || '').trim().toLowerCase();
        const usersSheet = getOrCreateSheet(ss, 'Users');
        const row = findUserRow(usersSheet, email);
        if (row > 0) {
          usersSheet.getRange(row, 8).setValue(data.rzpKeyId || '');
          if (data.rzpKeySecret) usersSheet.getRange(row, 9).setValue(data.rzpKeySecret);
          if (data.rzpWebhookSecret !== undefined) usersSheet.getRange(row, 10).setValue(data.rzpWebhookSecret);
          logAction(ss, 'Updated Razorpay Keys', email, `Key ID: ${data.rzpKeyId || 'N/A'}`);
          response = { ok: 1, message: 'Razorpay keys updated in Google Sheet' };
        } else {
          throw new Error('User not found in Google Sheet');
        }
        break;
      }

      // 5. Reset Password
      case 'reset_password': {
        const identifier = (data.email || data.phone || '').trim().toLowerCase();
        const usersSheet = getOrCreateSheet(ss, 'Users');
        const row = findUserRow(usersSheet, identifier, identifier);
        if (row > 0) {
          usersSheet.getRange(row, 6).setValue(data.hash || '');
          usersSheet.getRange(row, 7).setValue(data.salt || '');
          const email = usersSheet.getRange(row, 4).getValue();
          logAction(ss, 'Password reset', email, 'Password updated via OTP');
          response = { ok: 1, message: 'Password reset in Google Sheet' };
        } else {
          throw new Error('User not found in Google Sheet');
        }
        break;
      }

      // 6. Record Purchased / Demo Key (Keys sheet)
      case 'add_key': {
        const k = data.key || {};
        const keysSheet = getOrCreateSheet(ss, 'Keys');
        keysSheet.appendRow([
          getISTTimestamp(),
          k.key || '',
          k.userEmail || '',
          k.userId || '',
          k.planName || k.plan || '',
          k.price || 0,
          k.status || 'waiting',
          k.activatedAt ? formatIST(new Date(k.activatedAt)) : '',
          k.expiresAt ? formatIST(new Date(k.expiresAt)) : ''
        ]);

        logAction(ss, `Bought paid service (${k.planName || k.plan})`, k.userEmail, `Key: ${k.key}, Price: ₹${k.price}`);
        response = { ok: 1, message: 'Key recorded in Google Sheet' };
        break;
      }

      // 7. Record Customer Print Job (PrintJobs sheet)
      case 'add_print_job': {
        const j = data.job || {};
        const jobsSheet = getOrCreateSheet(ss, 'PrintJobs');
        jobsSheet.appendRow([
          getISTTimestamp(),
          j.id || '',
          j.shopId || '',
          j.shopName || '',
          j.filename || '',
          j.pages || 1,
          j.copies || 1,
          j.color || 'bw',
          j.amount || 0,
          j.status || 'created'
        ]);
        response = { ok: 1, message: 'Print job recorded' };
        break;
      }

      // 8. Update Print Job Status
      case 'update_print_job': {
        const jobId = data.id;
        const status = data.status;
        const jobsSheet = getOrCreateSheet(ss, 'PrintJobs');
        const rows = jobsSheet.getDataRange().getValues();
        for (let i = 1; i < rows.length; i++) {
          if (rows[i][1] === jobId) {
            jobsSheet.getRange(i + 1, 10).setValue(status);
            break;
          }
        }
        response = { ok: 1, message: 'Print job status updated' };
        break;
      }

      // 9. Query user for server fallback
      case 'get_user': {
        const user = findUserInSheet(ss, data.email, data.phone);
        response = { ok: 1, user };
        break;
      }

      default:
        response = { ok: 0, error: 'Invalid action: ' + action };
    }
  } catch (err) {
    response = { ok: 0, error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// Automatically clear OTP from Users sheet if expired (> 60 seconds)
function clearExpiredOtps(sheet) {
  try {
    const data = sheet.getDataRange().getValues();
    const now = new Date().getTime();
    for (let i = 1; i < data.length; i++) {
      const otpVal = data[i][12]; // Col 13: OTP
      if (otpVal) {
        const tsStr = String(data[i][0] || ''); // Timestamp: dd/mm/yyyy-hh:mm:ss
        const m = tsStr.match(/^(\d{2})\/(\d{2})\/(\d{4})-(\d{2}):(\d{2}):(\d{2})$/);
        if (m) {
          const rowTime = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`).getTime();
          if (now - rowTime > 60000) {
            sheet.getRange(i + 1, 13).setValue(''); // Remove expired OTP from sheet
          }
        }
      }
    }
  } catch (e) {
    console.error('Error clearing expired OTPs:', e);
  }
}

// Search for user row in Users sheet
function findUserRow(sheet, email, phone) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const rowEmail = String(rows[i][3] || '').trim().toLowerCase();
    const rowPhone = String(rows[i][4] || '').trim();
    if (email && rowEmail === email.toLowerCase()) return i + 1;
    if (phone && rowPhone === phone) return i + 1;
  }
  return -1;
}

// Find user object
function findUserInSheet(ss, email, phone) {
  const sheet = getOrCreateSheet(ss, 'Users');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const rowEmail = String(rows[i][3] || '').trim().toLowerCase();
    const rowPhone = String(rows[i][4] || '').trim();
    if ((email && rowEmail === email.toLowerCase()) || (phone && rowPhone === phone)) {
      return {
        id: rows[i][1],
        name: rows[i][2],
        email: rows[i][3],
        phone: rows[i][4],
        hash: rows[i][5],
        salt: rows[i][6],
        rzpKeyId: rows[i][7],
        rzpKeySecret: rows[i][8],
        rzpWebhookSecret: rows[i][9],
        demoUsed: rows[i][10] === 'Yes',
        status: rows[i][11]
      };
    }
  }
  return null;
}

function formatIST(dateObj) {
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(dateObj.toLocaleString('en-US', { timeZone: TIMEZONE }));
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}-${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// -------------------------------------------------------------
// WEEKLY SUNDAY NIGHT CRON TRIGGER (IST)
// Sends email of PrintJobs in Excel / CSV format & archives/clears them
// -------------------------------------------------------------
function weeklySundayPrintJobsReport() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const jobsSheet = getOrCreateSheet(ss, 'PrintJobs');
  const data = jobsSheet.getDataRange().getValues();
  
  if (data.length <= 1) {
    logAction(ss, 'Weekly Sunday Report Skipped', ADMIN_EMAIL_NOTIFICATION, 'No print jobs to report');
    return;
  }

  const headers = data[0];
  const rows = data.slice(1);

  // Generate CSV formatted content for Excel compatibility
  let csvContent = headers.map(h => `"${h}"`).join(',') + '\r\n';
  let totalRevenue = 0;
  let totalPages = 0;

  rows.forEach(r => {
    csvContent += r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\r\n';
    totalRevenue += Number(r[8]) || 0;
    totalPages += (Number(r[5]) || 0) * (Number(r[6]) || 1);
  });

  const timestamp = getISTTimestamp().replace(/[\/:]/g, '-');
  const fileName = `PrintQR_Weekly_Jobs_${timestamp}.csv`;
  const blob = Utilities.newBlob(csvContent, 'text/csv', fileName);

  const subject = `PrintQR - Weekly Print Jobs Report (${getISTTimestamp()})`;
  const htmlBody = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px;background:#ffffff">
      <h2 style="color:#D4175A;margin-top:0">Weekly PrintQR Jobs Report</h2>
      <p style="color:#333;font-size:15px">Attached is the comprehensive print jobs record for the past week ending <b>Sunday Night</b>.</p>
      
      <div style="background:#F1F2EE;border-radius:10px;padding:16px;margin:18px 0;display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div><small style="color:#6A6F7D">Total Jobs</small><br><b style="font-size:20px;color:#181B26">${rows.length}</b></div>
        <div><small style="color:#6A6F7D">Total Pages</small><br><b style="font-size:20px;color:#181B26">${totalPages}</b></div>
        <div><small style="color:#6A6F7D">Total Revenue</small><br><b style="font-size:20px;color:#D4175A">₹${totalRevenue.toFixed(2)}</b></div>
      </div>
      
      <p style="color:#666;font-size:13px">As scheduled, these records have been archived to your email attachment and cleared from the live sheet for next week's clean start.</p>
      <p style="color:#888;font-size:12px;margin-top:20px;border-top:1px solid #eee;padding-top:12px">Report Generated: ${getISTTimestamp()} IST</p>
    </div>
  `;

  // Send the email with Excel/CSV attachment
  MailApp.sendEmail({
    to: ADMIN_EMAIL_NOTIFICATION,
    subject: subject,
    htmlBody: htmlBody,
    attachments: [blob]
  });

  // Clear rows from sheet (preserve row 1 header)
  if (jobsSheet.getLastRow() > 1) {
    jobsSheet.deleteRows(2, jobsSheet.getLastRow() - 1);
  }

  logAction(ss, 'Weekly Sunday PrintJobs Report sent and jobs archived', ADMIN_EMAIL_NOTIFICATION, `Jobs: ${rows.length}, Revenue: ₹${totalRevenue}`);
}

// Function to install the Sunday 11:00 PM IST Time-driven trigger automatically
function installWeeklySundayTrigger() {
  // Clear any existing weekly triggers to prevent duplicates
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'weeklySundayPrintJobsReport') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Create recurring trigger every Sunday at 11:00 PM IST
  ScriptApp.newTrigger('weeklySundayPrintJobsReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(23)
    .inTimezone(TIMEZONE)
    .create();

  console.log('Sunday 11:00 PM IST trigger created successfully!');
}

// -------------------------------------------------------------
// CUSTOM SPREADSHEET MENU (Appears automatically in Google Sheets toolbar)
// -------------------------------------------------------------

/**
 * Runs automatically when the Google Sheet is opened
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('⚡ PrintQR Tools')
    .addItem('🛠️ 1. Setup All Sheets & Headers', 'menuSetupSheets')
    .addItem('⏰ 2. Install Sunday 11 PM Email Trigger', 'menuInstallTrigger')
    .addSeparator()
    .addItem('📧 3. Trigger PrintJobs Email Now (Test)', 'menuTriggerEmailNow')
    .addItem('🧪 4. Send Test OTP Email', 'menuSendTestOtp')
    .addToUi();
}

/**
 * Menu Option 1: Setup all 4 sheets (Users, Keys, Logs, PrintJobs) with headers
 */
function menuSetupSheets() {
  const ui = SpreadsheetApp.getUi();
  try {
    initAllSheets();
    ui.alert(
      'Setup Complete',
      '✓ All 4 sheets (Users, Keys, Logs, PrintJobs) are initialized with formatted headers and frozen rows.',
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('Error', 'Failed to setup sheets: ' + e.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Option 2: Install Sunday 11:00 PM IST automated email trigger
 */
function menuInstallTrigger() {
  const ui = SpreadsheetApp.getUi();
  try {
    installWeeklySundayTrigger();
    ui.alert(
      'Trigger Installed Successfully',
      '✓ Automated Sunday Trigger is active!\n\nEvery Sunday at 11:00 PM IST:\n• All PrintJobs will be exported as an Excel/CSV file.\n• Sent via email to: ' + ADMIN_EMAIL_NOTIFICATION + '\n• The sheet will be automatically cleared for the new week.',
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('Error', 'Failed to install trigger: ' + e.message, ui.ButtonSet.OK);
  }
}

/**
 * Menu Option 3: Manually trigger the PrintJobs email report right now
 */
function menuTriggerEmailNow() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert(
    'Confirm Send',
    'Do you want to generate and send the PrintJobs Excel/CSV report right now to ' + ADMIN_EMAIL_NOTIFICATION + '?\n\nNote: This will also archive and clear the sent jobs.',
    ui.ButtonSet.YES_NO
  );
  if (res === ui.Button.YES) {
    try {
      weeklySundayPrintJobsReport();
      ui.alert('Email Sent', '✓ PrintJobs report has been emailed to ' + ADMIN_EMAIL_NOTIFICATION + '.', ui.ButtonSet.OK);
    } catch (e) {
      ui.alert('Error', 'Failed to send report: ' + e.message, ui.ButtonSet.OK);
    }
  }
}

/**
 * Menu Option 4: Send a test OTP email to any email address
 */
function menuSendTestOtp() {
  const ui = SpreadsheetApp.getUi();
  const prompt = ui.prompt('Test OTP Email', 'Enter the email address to receive a test OTP:', ui.ButtonSet.OK_CANCEL);
  if (prompt.getSelectedButton() === ui.Button.OK) {
    const email = prompt.getResponseText().trim();
    if (!email) {
      ui.alert('Invalid Email', 'Please enter a valid email address.', ui.ButtonSet.OK);
      return;
    }
    try {
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const htmlBody = `
        <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px;background:#ffffff">
          <h2 style="color:#D4175A;margin-top:0">PrintQR Test Verification</h2>
          <p style="color:#333;font-size:15px">Hello!</p>
          <p style="color:#555;font-size:14px">Your One-Time Password (OTP) for testing is:</p>
          <div style="background:#F6DCE6;border-radius:8px;padding:16px;text-align:center;margin:20px 0">
            <span style="font-size:32px;font-weight:800;letter-spacing:6px;color:#D4175A">${otp}</span>
          </div>
          <p style="color:#666;font-size:13px">This test email confirms your Google Apps Script is sending OTPs correctly.</p>
          <p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">PrintQR System &bull; IST: ${getISTTimestamp()}</p>
        </div>
      `;
      MailApp.sendEmail({
        to: email,
        subject: `PrintQR - Test OTP Email (${otp})`,
        htmlBody: htmlBody
      });
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      logAction(ss, 'Test OTP sent on mail', email, 'Sent via custom menu');
      ui.alert('Success', '✓ Test OTP email sent successfully to ' + email + '!', ui.ButtonSet.OK);
    } catch (e) {
      ui.alert('Error', 'Failed to send test email: ' + e.message, ui.ButtonSet.OK);
    }
  }
}

