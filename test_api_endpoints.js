// End-to-end integration test for HTTP API endpoints
const http = require('http');
const assert = require('assert');
const crypto = require('crypto');

async function req(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opt = {
      hostname: u.hostname,
      port: u.port || 3000,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
    }
    const r = http.request(opt, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function testServer() {
  console.log('--- Testing API Endpoints on http://localhost:3000 ---');

  // 1. Config
  const cfg = await req('http://localhost:3000/api/config/payment');
  assert.strictEqual(cfg.status, 200);
  assert(cfg.body.keyId, 'Has keyId');
  console.log('✓ /api/config/payment passed:', cfg.body);

  // 2. Auth: create a test seller user
  const email = 'seller_' + Date.now() + '@test.local';
  const signup = await req('http://localhost:3000/api/signup', { method: 'POST' }, {
    name: 'Sharma Xerox',
    email,
    password: 'password123'
  });
  assert.strictEqual(signup.status, 200);
  const token = signup.body.token;
  console.log('✓ /api/signup passed. User token acquired.');

  // 3. Seller Onboarding (Razorpay Route)
  // Try invalid UPI first
  const invalidOnboard = await req('http://localhost:3000/api/seller/onboard', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token }
  }, {
    name: 'Sharma Xerox',
    email,
    phone: '9876543210',
    pan: 'ABCDE1234F',
    upi_id: 'invalid-upi'
  });
  assert.strictEqual(invalidOnboard.status, 400);
  console.log('✓ Invalid UPI rejected properly.');

  // Valid Onboard
  const onboard = await req('http://localhost:3000/api/seller/onboard', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token }
  }, {
    name: 'Sharma Xerox',
    email,
    phone: '9876543210',
    pan: 'ABCDE1234F',
    upi_id: 'sharma@okhdfcbank'
  });
  assert.strictEqual(onboard.status, 200);
  assert(onboard.body.seller.linked_account_id, 'Has linked account ID');
  assert.strictEqual(onboard.body.seller.upi_id, 'sharma@okhdfcbank');
  console.log('✓ Seller onboarded via Route Linked Account:', onboard.body.seller.linked_account_id);

  // 4. Update UPI
  const updateUpi = await req('http://localhost:3000/api/seller/update-upi', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token }
  }, {
    upi_id: 'sharma.updated@paytm'
  });
  assert.strictEqual(updateUpi.status, 200);
  assert.strictEqual(updateUpi.body.seller.upi_id, 'sharma.updated@paytm');
  console.log('✓ Seller UPI updated to:', updateUpi.body.seller.upi_id);

  // 5. Customer creates print job at shop
  // Get existing shop
  const shopId = 'c0bf64ad'; // From data.json
  const dummyPdf = '%PDF-1.4 sample content';
  const jobRes = await req('http://localhost:3000/api/shop/' + shopId + '/jobs', { method: 'POST' }, {
    filename: 'test_doc.pdf',
    data: Buffer.from(dummyPdf).toString('base64'),
    pages: 2,
    options: { color: 'bw', copies: 1, duplex: false }
  });
  assert.strictEqual(jobRes.status, 200);
  const jobId = jobRes.body.id;
  console.log('✓ Customer print job created:', jobId, 'amount: ₹' + jobRes.body.amount);

  // 6. Create Razorpay Order (Pricing strictly from DB)
  const orderRes = await req('http://localhost:3000/api/payment/create-order', { method: 'POST' }, {
    type: 'job',
    jobId
  });
  assert.strictEqual(orderRes.status, 200);
  assert(orderRes.body.orderId, 'Razorpay order created');
  assert.strictEqual(orderRes.body.amount, jobRes.body.amount);
  console.log('✓ Order created:', orderRes.body.orderId, 'Amount (paise):', orderRes.body.amountPaise);

  // 7. Verify Payment (Signature verification)
  const verifyRes = await req('http://localhost:3000/api/payment/verify', { method: 'POST' }, {
    razorpay_order_id: orderRes.body.orderId,
    razorpay_payment_id: 'pay_test_' + Date.now(),
    razorpay_signature: 'sim_signature',
    type: 'job',
    itemId: jobId
  });
  assert.strictEqual(verifyRes.status, 200);
  assert.strictEqual(verifyRes.body.status, 'paid');
  console.log('✓ Payment verified! Order marked as paid.');

  // 8. Test Webhook idempotency and settlement.vpa_completed
  const webhookPayload = JSON.stringify({
    id: 'evt_test_' + Date.now(),
    event: 'settlement.vpa_completed',
    payload: {
      settlement: {
        entity: {
          account: onboard.body.seller.linked_account_id,
          amount: 360,
          status: 'completed'
        }
      }
    }
  });

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'YOUR_WEBHOOK_SECRET';
  const webhookSig = crypto.createHmac('sha256', webhookSecret).update(webhookPayload).digest('hex');

  const webhookRes = await req('http://localhost:3000/api/webhook/razorpay', {
    method: 'POST',
    headers: {
      'x-razorpay-signature': webhookSig
    }
  }, JSON.parse(webhookPayload));
  assert.strictEqual(webhookRes.status, 200);
  console.log('✓ Webhook settlement.vpa_completed processed successfully.');

  // Check duplicate webhook
  const dupWebhook = await req('http://localhost:3000/api/webhook/razorpay', {
    method: 'POST',
    headers: {
      'x-razorpay-signature': webhookSig
    }
  }, JSON.parse(webhookPayload));
  assert.strictEqual(dupWebhook.status, 200);
  assert.strictEqual(dupWebhook.body.duplicate, true);
  console.log('✓ Webhook idempotency verified (duplicate ignored).');

  // 9. Seller Dashboard
  const dashRes = await req('http://localhost:3000/api/seller/dashboard', {
    headers: { Authorization: 'Bearer ' + token }
  });
  assert.strictEqual(dashRes.status, 200);
  console.log('✓ Seller Dashboard stats:', dashRes.body.stats);

  console.log('\n=============================================');
  console.log('ALL HTTP INTEGRATION TESTS PASSED!');
  console.log('=============================================');
}

testServer().catch(err => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
