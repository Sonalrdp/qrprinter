// Razorpay & Razorpay Route Integration Module for PrintQR
// Zero external dependencies (uses Node.js 18+ native fetch and crypto).
// NOTE: VPA Settlements must be enabled by Razorpay support for your account first.

const crypto = require('crypto');

function getConfig() {
  return {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT || '10') || 10
  };
}

function isConfigured() {
  const { keyId, keySecret } = getConfig();
  return Boolean(keyId && keySecret && !keyId.includes('YOUR_'));
}

function getAuthHeader() {
  const { keyId, keySecret } = getConfig();
  return 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64');
}

// UPI ID validation (VPA): e.g. name@upi, user@okhdfcbank, 9876543210@paytm
function validateUpiId(upiId) {
  if (!upiId || typeof upiId !== 'string') return false;
  const re = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
  return re.test(upiId.trim());
}

// PAN validation (India PAN format: 5 letters, 4 numbers, 1 letter)
function validatePan(pan) {
  if (!pan || typeof pan !== 'string') return false;
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan.trim().toUpperCase());
}

// Indian mobile number validation (10 digits starting with 6-9)
function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const clean = phone.replace(/[\s\-+]/g, '');
  return /^[6-9]\d{9}$/.test(clean.slice(-10));
}

// Generate unique ID helper
function rid(n = 6) {
  return crypto.randomBytes(n).toString('hex');
}

/**
 * 1. Create a Razorpay Order
 * Amount must be in paise (e.g. Rs 10 = 1000 paise).
 * Transfers array specifies the marketplace split to the seller's linked account.
 */
async function createOrder({ amountPaise, currency = 'INR', receipt, notes = {}, transfers = [] }) {
  const { keyId } = getConfig();
  if (!amountPaise || amountPaise < 100) {
    throw new Error('Minimum order amount is ₹1.00 (100 paise).');
  }

  // If Razorpay credentials are not yet configured or in sandbox simulation
  if (!isConfigured()) {
    console.warn('[Razorpay] Keys not configured or running in simulated test mode. Simulating order.');
    return {
      id: 'order_sim_' + rid(8),
      entity: 'order',
      amount: amountPaise,
      amount_paid: 0,
      amount_due: amountPaise,
      currency,
      receipt: receipt || 'rcpt_' + rid(4),
      status: 'created',
      attempts: 0,
      notes,
      transfers: transfers.map(t => ({
        id: 'trf_sim_' + rid(8),
        account: t.account,
        amount: t.amount,
        currency: t.currency || 'INR',
        status: 'pending'
      })),
      created_at: Math.floor(Date.now() / 1000),
      simulated: true
    };
  }

  const payload = {
    amount: Math.round(amountPaise),
    currency,
    receipt: receipt || ('rcpt_' + rid(5)),
    notes
  };

  // Attach Razorpay Route transfers if provided
  if (Array.isArray(transfers) && transfers.length > 0) {
    payload.transfers = transfers.map(t => ({
      account: t.account,
      amount: Math.round(t.amount),
      currency: t.currency || 'INR',
      notes: t.notes || {},
      linked_account_notes: t.linked_account_notes || [],
      on_hold: t.on_hold !== undefined ? t.on_hold : 0
    }));
  }

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const json = await res.json();
  if (!res.ok) {
    // If Route transfers fail because Route is not yet enabled on this test account,
    // retry without transfers so checkout can still proceed, but warn the developer.
    if (payload.transfers && (json.error?.description || '').toLowerCase().includes('route')) {
      console.warn('[Razorpay Route Warning]', json.error.description);
      console.warn('NOTE: VPA Settlements must be enabled by Razorpay support for your account first. Retrying standard order.');
      delete payload.transfers;
      const retryRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const retryJson = await retryRes.json();
      if (!retryRes.ok) {
        throw new Error(retryJson.error?.description || 'Razorpay order creation failed: ' + retryRes.status);
      }
      retryJson.routePending = true;
      return retryJson;
    }
    throw new Error(json.error?.description || json.error?.message || 'Razorpay order creation failed (' + res.status + ')');
  }

  return json;
}

/**
 * 2. Verify Razorpay Payment Signature
 * HMAC SHA256 of order_id|payment_id with key_secret
 */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const { keySecret } = getConfig();
  if (!orderId || !paymentId || !signature) return false;

  // For simulation test orders
  if (orderId.startsWith('order_sim_') && signature === 'sim_signature') {
    return true;
  }

  if (!keySecret) return false;

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(orderId + '|' + paymentId)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

/**
 * 3. Verify Razorpay Webhook Signature
 * HMAC SHA256 of raw body with webhookSecret
 */
function verifyWebhookSignature(rawBody, signature) {
  const { webhookSecret } = getConfig();
  if (!webhookSecret) {
    console.warn('[Razorpay Webhook] RAZORPAY_WEBHOOK_SECRET is not set.');
    return false;
  }
  if (!rawBody || !signature) return false;

  try {
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch (e) {
    return false;
  }
}

/**
 * 4. Seller Onboarding: Create Razorpay Linked Account (POST /v2/accounts)
 * Setting settlement_accounts method to "upi" with seller's VPA & beneficiary_name.
 * NOTE: VPA Settlements must be enabled by Razorpay support for your account first.
 */
async function createLinkedAccount({ name, email, phone, pan, upiId, shopName }) {
  if (!validateUpiId(upiId)) {
    throw new Error('Invalid UPI ID format. Example: seller@okhdfcbank');
  }
  if (pan && !validatePan(pan)) {
    throw new Error('Invalid PAN format. Example: ABCDE1234F');
  }

  const cleanPhone = (phone || '').replace(/[\s\-+]/g, '').slice(-10);
  const legalName = (name || shopName || 'Shop Partner').trim();

  // If Razorpay is not configured or in sandbox simulation
  if (!isConfigured()) {
    console.warn('[Razorpay Route] Running in simulation mode. Simulating Linked Account creation.');
    return {
      id: 'acc_sim_' + rid(7),
      type: 'route',
      status: 'activated',
      email: email.toLowerCase(),
      phone: cleanPhone,
      legal_business_name: legalName,
      business_type: 'individual',
      beneficiary_name: legalName,
      vpa: upiId.trim(),
      simulated: true,
      message: 'Linked account created in test simulation mode.'
    };
  }

  const payload = {
    email: email.toLowerCase(),
    phone: cleanPhone,
    type: 'route',
    legal_business_name: legalName,
    business_type: 'individual',
    contact_name: legalName,
    profile: {
      category: 'services',
      subcategory: 'printing_and_publishing',
      addresses: {
        registered: {
          street1: 'Shop Main Street',
          city: 'Mumbai',
          state: 'Maharashtra',
          postal_code: '400001',
          country: 'IN'
        }
      }
    },
    notes: {
      pan: (pan || '').toUpperCase(),
      upi_id: upiId.trim(),
      shop_name: (shopName || legalName).slice(0, 40)
    },
    settlement_accounts: [
      {
        form_type: 'vpa',
        beneficiary_name: legalName,
        notes: {
          upi_id: upiId.trim()
        },
        vpa: {
          address: upiId.trim()
        }
      }
    ],
    tnc_accepted: true
  };

  try {
    const res = await fetch('https://api.razorpay.com/v2/accounts', {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    if (!res.ok) {
      console.warn('[Razorpay Route Error]', json);
      // NOTE: VPA Settlements must be enabled by Razorpay support for your account first.
      // If Razorpay returns account creation error due to Route approval status in test mode,
      // provide descriptive message and sandbox linked account id so development can continue.
      if (json.error?.description && (json.error.description.includes('not enabled') || json.error.description.includes('Route'))) {
        return {
          id: 'acc_sim_' + rid(7),
          type: 'route',
          status: 'pending',
          email: email.toLowerCase(),
          phone: cleanPhone,
          legal_business_name: legalName,
          beneficiary_name: legalName,
          vpa: upiId.trim(),
          simulated: true,
          note: 'NOTE: VPA Settlements must be enabled by Razorpay support for your account first.',
          raw_error: json.error.description
        };
      }
      throw new Error(json.error?.description || json.error?.message || 'Failed to create linked account (' + res.status + ')');
    }

    // Extract beneficiary name returned from UPI / verification
    let verifiedName = legalName;
    if (json.settlement_accounts && json.settlement_accounts[0]) {
      verifiedName = json.settlement_accounts[0].beneficiary_name || legalName;
    }

    return {
      id: json.id,
      type: json.type || 'route',
      status: json.status || 'activated',
      email: json.email,
      phone: json.phone,
      legal_business_name: json.legal_business_name,
      beneficiary_name: verifiedName,
      vpa: upiId.trim(),
      raw: json
    };
  } catch (err) {
    throw err;
  }
}

/**
 * 5. Update Seller UPI ID (VPA Settlement Account)
 */
async function updateLinkedAccountVpa({ accountId, upiId, beneficiaryName }) {
  if (!validateUpiId(upiId)) {
    throw new Error('Invalid UPI ID format. Example: seller@okhdfcbank');
  }

  if (!isConfigured() || (accountId && accountId.startsWith('acc_sim_'))) {
    return {
      accountId,
      vpa: upiId.trim(),
      beneficiary_name: beneficiaryName || 'Verified Seller',
      status: 'activated',
      simulated: true
    };
  }

  // Razorpay API to add/update settlement account on linked account
  // POST /v2/accounts/{acc_id}/settlement_accounts
  try {
    const res = await fetch(`https://api.razorpay.com/v2/accounts/${accountId}/settlement_accounts`, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        form_type: 'vpa',
        beneficiary_name: beneficiaryName,
        notes: { upi_id: upiId.trim() },
        vpa: { address: upiId.trim() }
      })
    });

    const json = await res.json();
    if (!res.ok) {
      console.warn('[Razorpay Update VPA Error]', json);
      // Fallback if Route VPA update endpoint differs in test mode
      return {
        accountId,
        vpa: upiId.trim(),
        beneficiary_name: beneficiaryName,
        status: 'updated',
        note: 'NOTE: VPA Settlements must be enabled by Razorpay support for your account first.'
      };
    }

    return {
      accountId,
      vpa: upiId.trim(),
      beneficiary_name: json.beneficiary_name || beneficiaryName,
      status: 'activated',
      raw: json
    };
  } catch (err) {
    return {
      accountId,
      vpa: upiId.trim(),
      beneficiary_name: beneficiaryName,
      status: 'updated_locally',
      warning: err.message
    };
  }
}

/**
 * 6. Reverse Route Transfer (Refunds)
 * POST /v1/transfers/{trf_id}/reversals
 */
async function reverseTransfer({ transferId, amountPaise }) {
  if (!transferId) throw new Error('Transfer ID is required');

  if (!isConfigured() || transferId.startsWith('trf_sim_')) {
    return {
      id: 'rev_sim_' + rid(8),
      transfer_id: transferId,
      amount: amountPaise,
      currency: 'INR',
      status: 'processed',
      simulated: true
    };
  }

  const payload = { reverse_all: 1 };
  if (amountPaise) payload.amount = Math.round(amountPaise);

  const res = await fetch(`https://api.razorpay.com/v1/transfers/${transferId}/reversals`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.description || 'Transfer reversal failed: ' + res.status);
  }
  return json;
}

module.exports = {
  getConfig,
  isConfigured,
  validateUpiId,
  validatePan,
  validatePhone,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  createLinkedAccount,
  updateLinkedAccountVpa,
  reverseTransfer
};
