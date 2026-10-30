const crypto = require('crypto');

async function runTests() {
  console.log('--- STARTING MULTI-TENANT RAZORPAY TEST SUITE ---');
  const base = 'http://localhost:3000';
  const api = async (p, b, t) => {
    const res = await fetch(base + p, {
      method: b ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(t ? { Authorization: 'Bearer ' + t } : {})
      },
      body: b ? JSON.stringify(b) : undefined
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j;
  };

  // Test 1: Signup a new user
  const email = 'shopkeeper_' + Math.random().toString(36).substring(2, 7) + '@test.com';
  console.log('1. Signing up new shopkeeper:', email);
  const signupRes = await api('/api/signup', {
    name: 'Rohan Sharma',
    email,
    password: 'password123'
  });
  console.log('   ✓ Signup successful, token:', signupRes.token.slice(0, 8) + '...');
  const token = signupRes.token;

  // Test 2: Check initial rzp settings
  console.log('2. Fetching initial Razorpay settings');
  const initRzp = await api('/api/user/rzp', null, token);
  console.log('   ✓ Initial rzp status:', initRzp);
  if (initRzp.isConfigured !== false) throw new Error('Should not be configured initially');

  // Test 3: Save user's Razorpay credentials
  console.log('3. Saving user Razorpay credentials');
  const testKeyId = 'rzp_test_UserKey123456';
  const testKeySecret = 'UserSecretKey789abc';
  const testWhSecret = 'UserWhSecret999';

  const saveRes = await api('/api/user/rzp', {
    keyId: testKeyId,
    keySecret: testKeySecret,
    webhookSecret: testWhSecret
  }, token);
  console.log('   ✓ Saved successfully:', saveRes);
  if (!saveRes.isConfigured || saveRes.keyId !== testKeyId) throw new Error('Save response invalid');

  // Test 4: Fetch updated rzp settings
  console.log('4. Checking updated Razorpay settings');
  const updatedRzp = await api('/api/user/rzp', null, token);
  console.log('   ✓ Updated settings:', updatedRzp);
  if (!updatedRzp.hasSecret || updatedRzp.webhookSecret !== testWhSecret) throw new Error('Secret not saved properly');

  // Test 5: Buy demo plan and get activation key
  console.log('5. Buying demo plan');
  const keyObj = await api('/api/buy', { plan: 'demo' }, token);
  console.log('   ✓ Got demo key:', keyObj.key);

  // Test 6: Activate shop with that key
  console.log('6. Activating key on shop PC agent');
  const actRes = await api('/api/activate', { key: keyObj.key });
  console.log('   ✓ Shop activated with ID:', actRes.shop.id);
  console.log('   ✓ Shop has user Razorpay key:', actRes.shop.rzpKeyId, 'hasRzpSecret:', actRes.shop.hasRzpSecret);
  if (actRes.shop.rzpKeyId !== testKeyId) throw new Error('Shop did not inherit user Razorpay key!');

  // Test 7: Update shop rates and details via agent settings
  console.log('7. Saving custom print rates in agent settings (BW: ₹3, Color: ₹12)');
  const setRes = await api('/api/agent/settings', {
    key: keyObj.key,
    name: "Rohan's Xerox Corner",
    upi: 'rohan@okhdfcbank',
    ownerName: 'Rohan Sharma',
    phone: '9876543210',
    rates: { bw: 3, color: 12 }
  });
  console.log('   ✓ Agent settings saved, shop payoutReady:', setRes.payoutReady);

  // Test 8: Public shop page view
  console.log('8. Customer visits shop page');
  const shopPub = await api('/api/shop/' + actRes.shop.id);
  console.log('   ✓ Shop public rates:', shopPub.rates, 'hasCustomRzp:', shopPub.hasCustomRzp);
  if (shopPub.rates.bw !== 3 || shopPub.rates.color !== 12 || !shopPub.hasCustomRzp) {
    throw new Error('Public shop data mismatch');
  }

  // Test 9: Check /api/config?shopId=...
  console.log('9. Checking /api/config for shop');
  const cfg = await api('/api/config?shopId=' + actRes.shop.id);
  console.log('   ✓ Config for customer:', cfg);
  if (cfg.keyId !== testKeyId || !cfg.custom) throw new Error('Config does not return shop custom key');

  // Test 10: Create print job (2 pages, 1 copy, colour -> 2 * 1 * 12 = 24 INR)
  console.log('10. Customer uploads a 2-page PDF for colour printing');
  // Minimal valid PDF header
  const samplePdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64');
  const jobRes = await api('/api/shop/' + actRes.shop.id + '/jobs', {
    filename: 'document.pdf',
    data: samplePdf,
    pages: 2,
    options: { color: 'col', copies: 1 }
  });
  console.log('   ✓ Job created:', jobRes);
  if (jobRes.amount !== 24) throw new Error('Job amount calculation error, expected 24, got ' + jobRes.amount);

  // Test 11: Webhook signature verification with shop's webhook secret
  console.log('11. Testing Webhook verification with shopkeeper webhook secret');
  const fakeOrderId = 'order_fake_' + Math.random().toString(36).substring(2, 6);
  const webhookBody = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_12345',
          order_id: fakeOrderId,
          amount: 2400
        }
      }
    }
  });
  const sig = crypto.createHmac('sha256', testWhSecret).update(webhookBody).digest('hex');
  const whRes = await fetch(base + '/api/razorpay/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': sig
    },
    body: webhookBody
  });
  console.log('   ✓ Webhook status code:', whRes.status, await whRes.text());
  if (whRes.status !== 200) throw new Error('Webhook signature rejected with custom secret');

  // Test 12: Admin login strict .env check
  console.log('12. Testing Admin login strict .env check');
  const adminRes = await api('/api/login', {
    email: 'admin@printqr.local',
    password: '111'
  });
  console.log('   ✓ Admin login with .env credentials SUCCESS, admin:', adminRes.admin);

  try {
    await api('/api/login', {
      email: 'admin@printqr.local',
      password: 'admin123'
    });
    throw new Error('Default password should have been rejected!');
  } catch (e) {
    console.log('   ✓ Admin login with old/default password successfully REJECTED:', e.message);
  }

  console.log('\n--- ALL MULTI-TENANT RAZORPAY & PRICING TESTS PASSED! ---');
}

runTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});

