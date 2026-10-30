// Test suite for PrintQR Razorpay & Route Marketplace Integration
const assert = require('assert');
const crypto = require('crypto');
const rzp = require('./server/razorpay');

async function runTests() {
  console.log('--- 1. Testing Validation Helpers ---');
  // UPI validation
  assert.strictEqual(rzp.validateUpiId('sharma@okhdfcbank'), true, 'Valid UPI');
  assert.strictEqual(rzp.validateUpiId('9876543210@paytm'), true, 'Valid phone UPI');
  assert.strictEqual(rzp.validateUpiId('john.doe@upi'), true, 'Valid dot UPI');
  assert.strictEqual(rzp.validateUpiId('invalidupi'), false, 'Invalid UPI without @');
  assert.strictEqual(rzp.validateUpiId('@bank'), false, 'Invalid UPI missing user');
  console.log('✓ UPI ID validation passed.');

  // PAN validation
  assert.strictEqual(rzp.validatePan('ABCDE1234F'), true, 'Valid PAN');
  assert.strictEqual(rzp.validatePan('abcde1234f'), true, 'Lowercase PAN accepted after trim');
  assert.strictEqual(rzp.validatePan('12345ABCDE'), false, 'Invalid format PAN');
  console.log('✓ PAN validation passed.');

  // Phone validation
  assert.strictEqual(rzp.validatePhone('9876543210'), true, 'Valid phone');
  assert.strictEqual(rzp.validatePhone('+919876543210'), true, 'Valid phone with +91');
  assert.strictEqual(rzp.validatePhone('1234567890'), false, 'Invalid phone starting with 1');
  console.log('✓ Phone validation passed.');

  console.log('\n--- 2. Testing Payment Signature Verification ---');
  process.env.RAZORPAY_KEY_SECRET = 'test_secret_12345';
  const orderId = 'order_test_98765';
  const paymentId = 'pay_test_54321';
  const validSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(orderId + '|' + paymentId)
    .digest('hex');

  assert.strictEqual(rzp.verifyPaymentSignature({ orderId, paymentId, signature: validSig }), true, 'Valid HMAC signature');
  assert.strictEqual(rzp.verifyPaymentSignature({ orderId, paymentId, signature: 'wrong_sig' }), false, 'Invalid HMAC signature');
  console.log('✓ Payment signature HMAC SHA256 verified.');

  console.log('\n--- 3. Testing Webhook Signature Verification ---');
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_99999';
  const rawBody = JSON.stringify({ event: 'payment.captured', id: 'evt_123' });
  const validWebhookSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  assert.strictEqual(rzp.verifyWebhookSignature(rawBody, validWebhookSig), true, 'Valid webhook signature');
  assert.strictEqual(rzp.verifyWebhookSignature(rawBody, 'tampered_signature'), false, 'Tampered webhook rejected');
  console.log('✓ Webhook HMAC SHA256 signature verified.');

  console.log('\n--- 4. Testing Seller Onboarding (Linked Account & VPA) ---');
  const account = await rzp.createLinkedAccount({
    name: 'Sharma Xerox',
    email: 'sharma@example.com',
    phone: '9876543210',
    pan: 'ABCDE1234F',
    upiId: 'sharma@okhdfcbank'
  });
  assert(account.id, 'Linked account ID returned');
  assert(account.vpa === 'sharma@okhdfcbank', 'VPA recorded');
  console.log('✓ Seller Linked Account created:', account.id, 'VPA:', account.vpa);

  const updatedVpa = await rzp.updateLinkedAccountVpa({
    accountId: account.id,
    upiId: 'sharma.new@paytm',
    beneficiaryName: 'Sharma Xerox'
  });
  assert.strictEqual(updatedVpa.vpa, 'sharma.new@paytm');
  console.log('✓ Seller UPI VPA updated successfully:', updatedVpa.vpa);

  console.log('\n--- 5. Testing Order Creation with Route Split (Transfers) ---');
  const order = await rzp.createOrder({
    amountPaise: 2400, // ₹24.00
    currency: 'INR',
    receipt: 'rcpt_test_1',
    notes: { jobId: 'job_123' },
    transfers: [
      {
        account: account.id,
        amount: 2160, // 90% (10% platform fee)
        currency: 'INR'
      }
    ]
  });
  assert(order.id, 'Order ID generated');
  assert.strictEqual(order.amount, 2400);
  console.log('✓ Razorpay Order created with Route transfer:', order.id);

  console.log('\n--- 6. Testing Transfer Reversal (Refund) ---');
  const rev = await rzp.reverseTransfer({ transferId: 'trf_sim_test1', amountPaise: 2160 });
  assert(rev.status === 'processed', 'Transfer reversal processed');
  console.log('✓ Route Transfer reversal processed:', rev.id);

  console.log('\n=============================================');
  console.log('ALL PAYMENT & MARKETPLACE UNIT TESTS PASSED!');
  console.log('=============================================');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

