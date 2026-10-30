// PrintQR server: website, accounts, keys, shops, print jobs, Razorpay & Route payments. Zero dependencies (Node 18+).
// NOTE: VPA Settlements must be enabled by Razorpay support for your account first.

const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const rzp = require('./razorpay');

// Load environment variables from .env file if available
[path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')].some(f => {
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
      if (m && !m[1].startsWith('#')) {
        let v = (m[2] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    });
    return true;
  }
  return false;
});

const PORT = process.env.PORT || 3000;
// ---- EDIT YOUR PRICES (INR) ----
const DUR = { demo: 48 * 36e5, '3m': 90 * 864e5, '6m': 180 * 864e5, '12m': 365 * 864e5 };
const NAMES = { demo: '48-hour demo', '3m': '3 months', '6m': '6 months', '12m': '12 months' };
const DBF = path.join(__dirname, 'data.json'), UP = path.join(__dirname, 'uploads'), PUB = path.join(__dirname, 'public');
fs.mkdirSync(UP, { recursive: true });

let db = { users: [], sessions: {}, keys: [], shops: [], jobs: [], orders: [], sellers: [], webhookEvents: [], transfers: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DBF))); } catch (e) {}
db.users = db.users || [];
db.sessions = db.sessions || {};
db.keys = db.keys || [];
db.shops = db.shops || [];
db.jobs = db.jobs || [];
db.orders = db.orders || [];
db.sellers = db.sellers || [];
db.webhookEvents = db.webhookEvents || [];
db.transfers = db.transfers || [];

const save = () => fs.writeFileSync(DBF, JSON.stringify(db, null, 1));
const rid = n => crypto.randomBytes(n).toString('hex');
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');

// Plan prices (INR). Admin can change them from the admin dashboard.
db.settings = db.settings || {};
const PRICES = db.settings.prices = Object.assign({ '3m': 999, '6m': 1799, '12m': 2999 }, db.settings.prices || {});

// Admin account. Set ADMIN_EMAIL and ADMIN_PASSWORD before first start.
if (!db.users.find(x => x.isAdmin)) {
  const salt = rid(8), em = (process.env.ADMIN_EMAIL || 'admin@printqr.local').toLowerCase(), pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.users.push({ id: rid(6), name: 'Admin', email: em, salt, hash: hash(pw, salt), demoUsed: true, isAdmin: true });
  save();
  console.log('Admin account created: ' + em + (process.env.ADMIN_PASSWORD ? '' : '  password: admin123  (CHANGE THIS: set ADMIN_PASSWORD and delete data.json)'));
}

// Read raw body (crucial for accurate webhook HMAC signature verification)
const readRaw = req => new Promise((ok, no) => {
  let c = [], n = 0;
  req.on('data', d => {
    n += d.length;
    if (n > 40e6) { no(new Error('File too large')); req.destroy(); return; }
    c.push(d);
  });
  req.on('end', () => ok(Buffer.concat(c).toString('utf8')));
});

const body = req => new Promise((ok, no) => {
  let c = [], n = 0;
  req.on('data', d => {
    n += d.length;
    if (n > 40e6) { no(new Error('File too large')); req.destroy(); return; }
    c.push(d);
  });
  req.on('end', () => {
    try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch (e) { ok({}); }
  });
});

const live = k => k && k.expiresAt && Date.now() < k.expiresAt;
const shopActive = s => live(db.keys.find(k => k.key === s.keyId));
const pub = s => ({ id: s.id, name: s.name, mode: s.mode, defaults: s.defaults, rates: s.rates, upi: s.upi, active: shopActive(s) });
const full = s => ({ ...pub(s), slots: s.slots });

function count(range, total) {
  if (!range) return total;
  const set = new Set();
  range.split(',').forEach(p => {
    const m = p.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return;
    let a = +m[1], b = +(m[2] || m[1]);
    for (let i = a; i <= Math.min(b, total); i++) if (i > 0) set.add(i);
  });
  return set.size || total;
}

const ext = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Helper: Find seller for shop
function findSellerForShop(shopId) {
  if (!shopId) return null;
  let seller = db.sellers.find(s => s.shopId === shopId);
  if (!seller) {
    const shop = db.shops.find(s => s.id === shopId);
    if (shop) {
      const key = db.keys.find(k => k.key === shop.keyId);
      if (key) seller = db.sellers.find(s => s.userId === key.userId);
      if (!seller && shop.upi) {
        seller = db.sellers.find(s => s.upi_id === shop.upi);
      }
    }
  }
  if (!seller && db.sellers.length === 1) {
    seller = db.sellers[0];
  }
  return seller;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;
  const J = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  try {
    if (p.startsWith('/api/')) {
      const me = db.users.find(x => x.id === db.sessions[(req.headers.authorization || '').replace('Bearer ', '')]);
      const ak = db.keys.find(k => k.key === (u.searchParams.get('key') || '') && k.shopId && live(k));
      const ashop = ak && db.shops.find(s => s.id === ak.shopId);
      let r;

      // ----------------------------------------------------
      // 0. Public payment configuration (never exposes secret)
      // ----------------------------------------------------
      if (p === '/api/config/payment' && m === 'GET') {
        const cfg = rzp.getConfig();
        return J({
          keyId: cfg.keyId || 'rzp_test_simulated',
          platformFeePercent: cfg.platformFeePercent,
          isConfigured: rzp.isConfigured()
        });
      }

      // ----------------------------------------------------
      // WEBHOOK: Razorpay Webhooks (signature verification + idempotency)
      // ----------------------------------------------------
      if (p === '/api/webhook/razorpay' && m === 'POST') {
        const rawBody = await readRaw(req);
        const signature = req.headers['x-razorpay-signature'] || '';

        // If webhook secret is configured, verify HMAC SHA256 signature
        if (rzp.getConfig().webhookSecret) {
          const isValid = rzp.verifyWebhookSignature(rawBody, signature);
          if (!isValid) {
            console.warn('[Webhook] Invalid Razorpay webhook signature');
            return J({ error: 'Invalid webhook signature' }, 400);
          }
        }

        let event;
        try {
          event = JSON.parse(rawBody);
        } catch (e) {
          return J({ error: 'Invalid JSON payload' }, 400);
        }

        const eventId = event.id || (event.payload?.payment?.entity?.id ? (event.event + '_' + event.payload.payment.entity.id) : null);
        // Idempotency check: do not process the same event twice
        if (eventId && db.webhookEvents.some(e => e.eventId === eventId)) {
          return J({ ok: true, duplicate: true, message: 'Event already processed' });
        }
        if (eventId) {
          db.webhookEvents.push({ eventId, eventType: event.event, receivedAt: Date.now() });
          if (db.webhookEvents.length > 500) db.webhookEvents.shift();
        }

        console.log('[Razorpay Webhook Event]', event.event, eventId);

        // A. payment.captured or order.paid -> Mark order & job as paid
        if (event.event === 'payment.captured' || event.event === 'order.paid') {
          const payment = event.payload?.payment?.entity;
          const rzpOrderId = payment?.order_id || event.payload?.order?.entity?.id;
          const paymentId = payment?.id;

          const order = db.orders.find(o => o.razorpay_order_id === rzpOrderId || (payment?.notes?.jobId && o.itemId === payment.notes.jobId));
          if (order) {
            if (order.status !== 'paid') {
              order.status = 'paid';
              order.razorpay_payment_id = paymentId || order.razorpay_payment_id;
              order.updated_at = Date.now();

              if (order.type === 'job') {
                const job = db.jobs.find(j => j.id === order.itemId);
                if (job && job.status === 'created') job.status = 'paid';
              } else if (order.type === 'plan') {
                const user = db.users.find(u => u.id === order.userId);
                if (user && !db.keys.find(k => k.orderId === order.id)) {
                  const k = { key: 'PQR-' + [0, 1, 2].map(() => rid(2).toUpperCase()).join('-'), userId: user.id, plan: order.itemId, price: order.amount, orderId: order.id, createdAt: Date.now() };
                  db.keys.push(k);
                }
              }
              save();
            }
          }
        }

        // B. settlement.vpa_completed -> Mark seller transfer/payout as completed
        // NOTE: VPA Settlements must be enabled by Razorpay support for your account first.
        if (event.event === 'settlement.vpa_completed' || event.event === 'transfer.settled') {
          const entity = event.payload?.settlement?.entity || event.payload?.transfer?.entity;
          const accId = entity?.account || entity?.recipient_id;
          const trfId = entity?.id;

          db.orders.forEach(ord => {
            if (ord.transfers) {
              ord.transfers.forEach(t => {
                if ((accId && t.account === accId) || (trfId && t.id === trfId)) {
                  t.status = 'completed';
                  ord.payout_status = 'completed';
                }
              });
            }
          });

          if (accId) {
            const seller = db.sellers.find(s => s.linked_account_id === accId);
            if (seller) seller.payout_status = 'completed';
          }
          save();
        }

        // C. payout.vpa_failed -> Payout failed, notify seller to fix their UPI ID
        if (event.event === 'payout.vpa_failed' || event.event === 'transfer.failed') {
          const entity = event.payload?.payout?.entity || event.payload?.transfer?.entity;
          const accId = entity?.account || entity?.recipient_id;

          db.orders.forEach(ord => {
            if (ord.transfers && ord.transfers.some(t => t.account === accId)) {
              ord.payout_status = 'failed';
            }
          });

          if (accId) {
            const seller = db.sellers.find(s => s.linked_account_id === accId);
            if (seller) {
              seller.payout_status = 'failed';
              seller.payout_notification = 'Payout failed for UPI ID ' + (seller.upi_id || '') + '. Please verify and update your UPI ID in the dashboard.';
            }
          }
          save();
        }

        // D. refund.created / refund.processed -> Reverse Route transfer to seller
        if (event.event === 'refund.created' || event.event === 'refund.processed') {
          const refund = event.payload?.refund?.entity;
          const paymentId = refund?.payment_id;
          const order = db.orders.find(o => o.razorpay_payment_id === paymentId);
          if (order) {
            order.status = 'refunded';
            order.updated_at = Date.now();
            if (order.transfers) {
              for (const trf of order.transfers) {
                if (trf.id) {
                  await rzp.reverseTransfer({ transferId: trf.id, amountPaise: trf.amount_paise }).catch(err => {
                    console.error('[Refund Reversal Error]', err.message);
                  });
                }
              }
            }
            save();
          }
        }

        return J({ status: 'ok', event: event.event });
      }

      // For standard API requests, parse JSON body
      const b = m === 'POST' ? await body(req) : {};

      // ----------------------------------------------------
      // AUTH & ACCOUNTS
      // ----------------------------------------------------
      if (p === '/api/signup' && m === 'POST') {
        if (!b.name || !/^\S+@\S+\.\S+$/.test(b.email || '') || (b.password || '').length < 6) return J({ error: 'Enter your name, a valid email and a password of 6+ characters.' }, 400);
        const email = b.email.toLowerCase();
        if (db.users.find(x => x.email === email)) return J({ error: 'This email already has an account. Log in instead.' }, 400);
        const salt = rid(8), usr = { id: rid(6), name: b.name, email, salt, hash: hash(b.password, salt), demoUsed: false };
        db.users.push(usr);
        const t = rid(24);
        db.sessions[t] = usr.id;
        save();
        return J({ token: t });
      }

      if (p === '/api/login' && m === 'POST') {
        const usr = db.users.find(x => x.email === (b.email || '').toLowerCase());
        if (!usr || usr.hash !== hash(b.password || '', usr.salt)) return J({ error: 'Email or password is wrong.' }, 401);
        const t = rid(24);
        db.sessions[t] = usr.id;
        save();
        return J({ token: t, admin: !!usr.isAdmin });
      }

      if (p === '/api/me') {
        if (!me) return J({ error: 'Log in first' }, 401);
        return J({ name: me.name, email: me.email, demoUsed: me.demoUsed, prices: PRICES, names: NAMES });
      }

      if (p === '/api/buy' && m === 'POST') {
        if (!me) return J({ error: 'Log in first' }, 401);
        if (b.plan === 'demo') {
          if (me.demoUsed) return J({ error: 'You have already used your 48-hour demo.' }, 400);
          me.demoUsed = true;
          const k = { key: 'PQR-' + [0, 1, 2].map(() => rid(2).toUpperCase()).join('-'), userId: me.id, plan: 'demo', price: 0, createdAt: Date.now() };
          db.keys.push(k);
          save();
          return J(k);
        }
        if (!PRICES[b.plan]) return J({ error: 'Unknown plan' }, 400);
        // Paid plans are created through /api/payment/create-order and /api/payment/verify
        return J({ error: 'Use checkout to buy paid plans.' }, 400);
      }

      if (p === '/api/keys') {
        if (!me) return J({ error: 'Log in first' }, 401);
        return J(db.keys.filter(k => k.userId === me.id).map(k => ({ ...k, planName: NAMES[k.plan], status: !k.activatedAt ? 'waiting' : live(k) ? 'active' : 'expired' })).reverse());
      }

      if (p === '/api/activate' && m === 'POST') {
        const k = db.keys.find(x => x.key === (b.key || '').trim().toUpperCase());
        if (!k) return J({ error: 'This key was not found. Check it and try again.' }, 400);
        if (k.expiresAt && Date.now() >= k.expiresAt) return J({ error: 'This key has expired. Buy a new plan in your dashboard.' }, 400);
        const usr = db.users.find(x => x.id === k.userId);
        if (!k.activatedAt) {
          k.activatedAt = Date.now();
          k.expiresAt = k.activatedAt + DUR[k.plan] + (k.extraMs || 0);
          const s = { id: rid(4), keyId: k.key, name: usr.name + "'s shop", mode: 'default', upi: '', rates: { bw: 2, color: 10 }, defaults: { color: 'bw', copies: 1, duplex: false, range: '' }, slots: { bw: '', color: '', duplex: '', photo: '' } };
          db.shops.push(s);
          k.shopId = s.id;
        }
        save();
        return J({ shop: full(db.shops.find(s => s.id === k.shopId)), user: { name: usr.name, email: usr.email }, plan: NAMES[k.plan], expiresAt: k.expiresAt, key: k.key });
      }

      // ----------------------------------------------------
      // AGENT (Shop PC Worker)
      // ----------------------------------------------------
      if (p === '/api/agent/settings' && m === 'POST') {
        const shopKey = u.searchParams.get('key') || b.key;
        const validKey = db.keys.find(k => k.key === shopKey && k.shopId && live(k));
        const currentShop = validKey && db.shops.find(s => s.id === validKey.shopId);
        if (!currentShop) return J({ error: 'Key not valid' }, 401);
        ['name', 'mode', 'upi', 'rates', 'defaults', 'slots'].forEach(f => { if (b[f] !== undefined) currentShop[f] = b[f]; });
        // If shop UPI changed, sync to seller profile
        const seller = findSellerForShop(currentShop.id);
        if (seller && b.upi) seller.upi_id = b.upi;
        save();
        return J(full(currentShop));
      }

      if (p === '/api/agent/jobs') {
        const shopKey = u.searchParams.get('key') || b.key;
        const validKey = db.keys.find(k => k.key === shopKey && k.shopId && live(k));
        const currentShop = validKey && db.shops.find(s => s.id === validKey.shopId);
        if (!currentShop) return J({ error: 'Key not valid' }, 401);
        const out = db.jobs.filter(j => j.shopId === currentShop.id && j.status === 'paid');
        out.forEach(j => j.status = 'printing');
        if (out.length) save();
        return J(out);
      }

      if ((r = p.match(/^\/api\/agent\/file\/(\w+)$/))) {
        const shopKey = u.searchParams.get('key') || b.key;
        const validKey = db.keys.find(k => k.key === shopKey && k.shopId && live(k));
        const currentShop = validKey && db.shops.find(s => s.id === validKey.shopId);
        if (!currentShop) return J({ error: 'Key not valid' }, 401);
        const j = db.jobs.find(x => x.id === r[1] && x.shopId === currentShop.id);
        if (!j) return J({ error: 'No job' }, 404);
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end(fs.readFileSync(path.join(UP, j.id + '.pdf')));
      }

      if ((r = p.match(/^\/api\/agent\/jobs\/(\w+)$/)) && m === 'POST') {
        const shopKey = u.searchParams.get('key') || b.key;
        const validKey = db.keys.find(k => k.key === shopKey && k.shopId && live(k));
        const currentShop = validKey && db.shops.find(s => s.id === validKey.shopId);
        if (!currentShop) return J({ error: 'Key not valid' }, 401);
        const j = db.jobs.find(x => x.id === r[1] && x.shopId === currentShop.id);
        if (j) {
          j.status = b.status === 'printed' ? 'printed' : 'failed';
          save();
        }
        return J({ ok: 1 });
      }

      // ----------------------------------------------------
      // CUSTOMER & BUYER FLOW
      // ----------------------------------------------------
      if ((r = p.match(/^\/api\/shop\/(\w+)$/))) {
        const s = db.shops.find(x => x.id === r[1]);
        if (!s) return J({ error: 'Shop not found' }, 404);
        const seller = findSellerForShop(s.id);
        return J({
          ...pub(s),
          seller: seller ? { name: seller.name, status: seller.status, beneficiary_name: seller.beneficiary_name } : null
        });
      }

      if ((r = p.match(/^\/api\/shop\/(\w+)\/jobs$/)) && m === 'POST') {
        const s = db.shops.find(x => x.id === r[1]);
        if (!s || !shopActive(s)) return J({ error: 'This shop is offline right now.' }, 400);
        if (!s.upi && !findSellerForShop(s.id)) return J({ error: 'The shop has not set a UPI ID yet.' }, 400);

        const buf = Buffer.from(b.data || '', 'base64');
        if (buf.slice(0, 4).toString() !== '%PDF') return J({ error: 'Only PDF files can be printed.' }, 400);

        const o = s.mode === 'locked' ? { ...s.defaults } : {
          color: b.options?.color === 'col' ? 'col' : 'bw',
          copies: Math.min(99, Math.max(1, parseInt(b.options?.copies) || 1)),
          duplex: !!b.options?.duplex,
          range: /^[0-9,\-\s]*$/.test(b.options?.range || '') ? (b.options.range || '') : ''
        };
        const total = Math.max(1, parseInt(b.pages) || 1);
        const n = count(o.range, total);
        const rate = o.color === 'col' ? s.rates.color : s.rates.bw;
        // Calculate amount strictly from database shop rates
        const amount = Math.max(1, Math.round(n * o.copies * rate * 100) / 100);

        const j = {
          id: rid(5),
          shopId: s.id,
          filename: String(b.filename || 'file.pdf').slice(0, 80),
          options: o,
          pages: n,
          amount,
          status: 'created',
          createdAt: Date.now()
        };

        fs.writeFileSync(path.join(UP, j.id + '.pdf'), buf);
        db.jobs.push(j);
        save();

        return J({ id: j.id, amount: j.amount, pages: n, filename: j.filename, shopName: s.name });
      }

      if ((r = p.match(/^\/api\/jobs\/(\w+)$/))) {
        const j = db.jobs.find(x => x.id === r[1]);
        if (!j) return J({ error: 'No job' }, 404);
        const ord = db.orders.find(o => o.itemId === j.id);
        return J({
          id: j.id,
          status: j.status,
          amount: j.amount,
          filename: j.filename,
          orderStatus: ord ? ord.status : j.status,
          orderId: ord ? ord.razorpay_order_id : null
        });
      }

      // Legacy fallback endpoint
      if ((r = p.match(/^\/api\/jobs\/(\w+)\/pay$/)) && m === 'POST') {
        const j = db.jobs.find(x => x.id === r[1]);
        if (!j) return J({ error: 'No job' }, 404);
        if (j.status === 'created') {
          j.status = 'paid';
          save();
        }
        return J({ status: j.status });
      }

      // ----------------------------------------------------
      // RAZORPAY ORDERS & CHECKOUT FLOW (Orders API, Server-Side Pricing, Route Split)
      // ----------------------------------------------------
      if (p === '/api/payment/create-order' && m === 'POST') {
        let amount = 0, currency = 'INR', itemId = '', type = b.type || 'job', receipt = '', shopId = '', seller = null;
        let notes = { type };

        if (type === 'job') {
          const job = db.jobs.find(j => j.id === b.jobId);
          if (!job) return J({ error: 'Job not found' }, 404);
          itemId = job.id;
          shopId = job.shopId;
          // PRICE IS DERIVED FROM DATABASE, NEVER FROM BROWSER
          amount = job.amount;
          receipt = 'rcpt_' + job.id;
          notes.jobId = job.id;
          notes.shopId = job.shopId;
          notes.filename = job.filename;
          seller = findSellerForShop(shopId);
        } else if (type === 'plan') {
          if (!me) return J({ error: 'Log in first' }, 401);
          if (!PRICES[b.plan]) return J({ error: 'Unknown plan' }, 400);
          itemId = b.plan;
          // PRICE IS DERIVED FROM DATABASE SETTINGS
          amount = PRICES[b.plan];
          receipt = 'plan_' + me.id + '_' + b.plan;
          notes.userId = me.id;
          notes.plan = b.plan;
        } else {
          return J({ error: 'Invalid order type' }, 400);
        }

        const amountPaise = Math.round(amount * 100);
        const platformFeePercent = rzp.getConfig().platformFeePercent;
        const platformFeePaise = Math.round((amountPaise * platformFeePercent) / 100);
        const sellerSharePaise = amountPaise - platformFeePaise;

        // Splitting the payment using Razorpay Route:
        // Transfers array with seller's linked account id, amount in paise, and currency INR
        // NOTE: VPA Settlements must be enabled by Razorpay support for your account first.
        const transfers = [];
        if (type === 'job' && seller && seller.linked_account_id) {
          transfers.push({
            account: seller.linked_account_id,
            amount: sellerSharePaise,
            currency: 'INR',
            notes: { jobId: itemId, shopId },
            linked_account_notes: ['jobId', 'shopId'],
            on_hold: 0
          });
        }

        let rzpOrder;
        try {
          rzpOrder = await rzp.createOrder({
            amountPaise,
            currency,
            receipt,
            notes,
            transfers
          });
        } catch (err) {
          console.error('[Razorpay createOrder Error]', err);
          return J({ error: err.message || 'Payment order creation failed' }, 500);
        }

        // Store order in db.orders
        // Schema: id, razorpay_order_id, razorpay_payment_id, amount, status, created_at, ...
        let order = db.orders.find(o => o.itemId === itemId && o.status === 'created');
        if (!order) {
          order = { id: 'ord_' + rid(6), created_at: Date.now() };
          db.orders.push(order);
        }

        order.razorpay_order_id = rzpOrder.id;
        order.razorpay_payment_id = null;
        order.razorpay_signature = null;
        order.type = type;
        order.itemId = itemId;
        order.shopId = shopId;
        order.userId = me ? me.id : null;
        order.sellerId = seller ? seller.id : null;
        order.amount = amount;
        order.amount_paise = amountPaise;
        order.currency = currency;
        order.platform_fee_percent = platformFeePercent;
        order.platform_fee_amount = platformFeePaise / 100;
        order.seller_share_amount = sellerSharePaise / 100;
        order.transfers = transfers.map(t => ({
          account: t.account,
          amount_paise: t.amount,
          currency: t.currency,
          status: 'pending'
        }));
        order.status = 'created';
        order.payout_status = transfers.length ? 'pending' : 'not_applicable';
        order.updated_at = Date.now();
        save();

        const currentShop = shopId ? db.shops.find(s => s.id === shopId) : null;
        return J({
          orderId: rzpOrder.id,
          internalOrderId: order.id,
          amountPaise,
          amount,
          currency,
          keyId: rzp.getConfig().keyId,
          shopName: currentShop ? currentShop.name : 'PrintQR',
          description: type === 'job' ? ('Print: ' + notes.filename) : ('Software Plan: ' + NAMES[b.plan]),
          simulated: Boolean(rzpOrder.simulated)
        });
      }

      // ----------------------------------------------------
      // PAYMENT VERIFICATION (HMAC SHA256 Signature Verification)
      // ----------------------------------------------------
      if (p === '/api/payment/verify' && m === 'POST') {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = b;
        if (!razorpay_order_id || !razorpay_payment_id) {
          return J({ error: 'Missing order_id or payment_id' }, 400);
        }

        const order = db.orders.find(o => o.razorpay_order_id === razorpay_order_id);
        if (!order) return J({ error: 'Order not found' }, 404);

        // Anti-duplicate click / tab handling
        if (order.status === 'paid') {
          return J({ ok: true, status: 'paid', alreadyPaid: true, orderId: order.id, jobId: order.itemId });
        }

        // Verify HMAC SHA256 signature
        const isValid = rzp.verifyPaymentSignature({
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          signature: razorpay_signature
        });

        if (!isValid) {
          order.status = 'failed';
          order.updated_at = Date.now();
          save();
          return J({ error: 'Payment signature verification failed. Untrusted response.' }, 400);
        }

        // Payment confirmed!
        order.razorpay_payment_id = razorpay_payment_id;
        order.razorpay_signature = razorpay_signature;
        order.status = 'paid';
        order.updated_at = Date.now();

        if (order.type === 'job') {
          const job = db.jobs.find(j => j.id === order.itemId);
          if (job) job.status = 'paid';
        } else if (order.type === 'plan') {
          const user = db.users.find(u => u.id === order.userId);
          if (user) {
            const k = { key: 'PQR-' + [0, 1, 2].map(() => rid(2).toUpperCase()).join('-'), userId: user.id, plan: order.itemId, price: order.amount, orderId: order.id, createdAt: Date.now() };
            db.keys.push(k);
          }
        }

        save();
        return J({ ok: true, status: 'paid', orderId: order.id, jobId: order.itemId, razorpay_payment_id });
      }

      // Check order status (for tab-closed recovery or polling)
      if ((r = p.match(/^\/api\/orders\/(\w+)$/))) {
        const ord = db.orders.find(o => o.id === r[1] || o.razorpay_order_id === r[1] || o.itemId === r[1]);
        if (!ord) return J({ error: 'Order not found' }, 404);
        const job = ord.type === 'job' ? db.jobs.find(j => j.id === ord.itemId) : null;
        return J({
          id: ord.id,
          razorpay_order_id: ord.razorpay_order_id,
          status: ord.status,
          amount: ord.amount,
          payout_status: ord.payout_status,
          jobStatus: job ? job.status : null,
          created_at: ord.created_at
        });
      }

      // ----------------------------------------------------
      // SELLER ONBOARDING & DASHBOARD (Razorpay Route VPA)
      // ----------------------------------------------------
      // NOTE: VPA Settlements must be enabled by Razorpay support for your account first.
      if (p === '/api/seller/onboard' && m === 'POST') {
        if (!me) return J({ error: 'Log in first' }, 401);

        const { name, email, phone, pan, upi_id, shopId } = b;
        if (!name || !email || !phone || !upi_id) {
          return J({ error: 'Name, email, phone, and UPI ID are required.' }, 400);
        }

        if (!rzp.validateUpiId(upi_id)) {
          return J({ error: 'Invalid UPI ID format. Example: yourname@okhdfcbank or 9876543210@paytm' }, 400);
        }

        if (pan && !rzp.validatePan(pan)) {
          return J({ error: 'Invalid PAN format. Example: ABCDE1234F' }, 400);
        }

        if (!rzp.validatePhone(phone)) {
          return J({ error: 'Invalid 10-digit Indian phone number.' }, 400);
        }

        // Find or create shop for user
        let userShop = shopId ? db.shops.find(s => s.id === shopId) : null;
        if (!userShop) {
          const userKey = db.keys.find(k => k.userId === me.id && k.shopId);
          if (userKey) userShop = db.shops.find(s => s.id === userKey.shopId);
        }
        if (!userShop && db.shops.length > 0) {
          // If user owns or runs the single active shop
          userShop = db.shops[0];
        }

        let accountRes;
        try {
          accountRes = await rzp.createLinkedAccount({
            name,
            email,
            phone,
            pan,
            upiId: upi_id,
            shopName: userShop ? userShop.name : (name + "'s shop")
          });
        } catch (err) {
          return J({ error: err.message || 'Failed to create Razorpay linked account.' }, 400);
        }

        let seller = db.sellers.find(s => s.userId === me.id || (userShop && s.shopId === userShop.id));
        if (!seller) {
          seller = { id: 'sel_' + rid(4), userId: me.id, created_at: Date.now() };
          db.sellers.push(seller);
        }

        seller.name = name.trim();
        seller.email = email.trim().toLowerCase();
        seller.phone = phone.trim();
        seller.pan = (pan || '').toUpperCase().trim();
        seller.upi_id = upi_id.trim();
        seller.beneficiary_name = accountRes.beneficiary_name || name.trim();
        seller.linked_account_id = accountRes.id;
        seller.status = accountRes.status || 'activated';
        seller.shopId = userShop ? userShop.id : (seller.shopId || '');
        seller.updated_at = Date.now();
        seller.payout_notification = null;

        if (userShop) {
          userShop.upi = seller.upi_id;
        }

        save();

        return J({
          ok: true,
          seller: {
            id: seller.id,
            name: seller.name,
            email: seller.email,
            phone: seller.phone,
            pan: seller.pan,
            upi_id: seller.upi_id,
            beneficiary_name: seller.beneficiary_name,
            linked_account_id: seller.linked_account_id,
            status: seller.status,
            note: accountRes.note || 'NOTE: VPA Settlements must be enabled by Razorpay support for your account first.'
          }
        });
      }

      if (p === '/api/seller/update-upi' && m === 'POST') {
        if (!me) return J({ error: 'Log in first' }, 401);
        const { upi_id } = b;
        if (!rzp.validateUpiId(upi_id)) {
          return J({ error: 'Invalid UPI ID format. Example: yourname@okhdfcbank' }, 400);
        }

        const seller = db.sellers.find(s => s.userId === me.id);
        if (!seller) return J({ error: 'Seller account not found. Please onboard first.' }, 404);

        const updateRes = await rzp.updateLinkedAccountVpa({
          accountId: seller.linked_account_id,
          upiId: upi_id,
          beneficiaryName: seller.name
        });

        seller.upi_id = upi_id.trim();
        if (updateRes.beneficiary_name) seller.beneficiary_name = updateRes.beneficiary_name;
        seller.payout_notification = null; // Clear failure notice
        seller.updated_at = Date.now();

        const userShop = db.shops.find(s => s.id === seller.shopId);
        if (userShop) userShop.upi = seller.upi_id;

        save();
        return J({ ok: true, seller });
      }

      if (p === '/api/seller/dashboard' && m === 'GET') {
        if (!me) return J({ error: 'Log in first' }, 401);

        const seller = db.sellers.find(s => s.userId === me.id);
        const userKeys = db.keys.filter(k => k.userId === me.id);
        const shopIds = db.shops.filter(s => userKeys.some(k => k.shopId === s.id)).map(s => s.id);
        if (seller && seller.shopId && !shopIds.includes(seller.shopId)) shopIds.push(seller.shopId);

        // Fetch orders for this seller/shop
        const orders = db.orders.filter(o => (seller && o.sellerId === seller.id) || shopIds.includes(o.shopId));

        const paidOrders = orders.filter(o => o.status === 'paid');
        const grossVolume = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
        const platformFees = paidOrders.reduce((sum, o) => sum + (o.platform_fee_amount || 0), 0);
        const netEarnings = paidOrders.reduce((sum, o) => sum + (o.seller_share_amount || (o.amount - (o.platform_fee_amount || 0))), 0);

        const vpaCompleted = paidOrders.filter(o => o.payout_status === 'completed').length;
        const vpaPending = paidOrders.filter(o => o.payout_status === 'pending').length;
        const vpaFailed = paidOrders.filter(o => o.payout_status === 'failed').length;

        return J({
          seller: seller ? {
            id: seller.id,
            name: seller.name,
            email: seller.email,
            phone: seller.phone,
            pan: seller.pan,
            upi_id: seller.upi_id,
            beneficiary_name: seller.beneficiary_name,
            linked_account_id: seller.linked_account_id,
            status: seller.status,
            payout_notification: seller.payout_notification
          } : null,
          stats: {
            totalOrders: orders.length,
            paidOrdersCount: paidOrders.length,
            grossVolume,
            platformFees,
            netEarnings,
            payouts: {
              completed: vpaCompleted,
              pending: vpaPending,
              failed: vpaFailed
            }
          },
          orders: orders.slice(-50).reverse().map(o => {
            const j = db.jobs.find(x => x.id === o.itemId);
            return {
              id: o.id,
              razorpay_order_id: o.razorpay_order_id,
              razorpay_payment_id: o.razorpay_payment_id,
              filename: j ? j.filename : (o.type === 'job' ? 'Print Job' : o.itemId),
              amount: o.amount,
              seller_share_amount: o.seller_share_amount,
              platform_fee_amount: o.platform_fee_amount,
              status: o.status,
              payout_status: o.payout_status,
              created_at: o.created_at
            };
          })
        });
      }

      // Refund endpoint (reverses Route transfer and updates order)
      if (p === '/api/payment/refund' && m === 'POST') {
        if (!me) return J({ error: 'Log in first' }, 401);
        const { orderId } = b;
        const ord = db.orders.find(o => o.id === orderId || o.razorpay_order_id === orderId);
        if (!ord) return J({ error: 'Order not found' }, 404);
        if (ord.status !== 'paid') return J({ error: 'Only paid orders can be refunded' }, 400);

        // Reverse Route transfers
        if (ord.transfers) {
          for (const trf of ord.transfers) {
            if (trf.id) {
              await rzp.reverseTransfer({ transferId: trf.id, amountPaise: trf.amount_paise }).catch(console.error);
            }
          }
        }

        ord.status = 'refunded';
        ord.updated_at = Date.now();
        save();
        return J({ ok: true, status: 'refunded', order: ord });
      }

      // ----------------------------------------------------
      // ADMIN DASHBOARD
      // ----------------------------------------------------
      if (p.startsWith('/api/admin/')) {
        if (!me || !me.isAdmin) return J({ error: 'Admin only' }, 403);
        const st = k => !k.activatedAt ? 'waiting' : live(k) ? 'active' : 'expired';
        const email = i => (db.users.find(x => x.id === i) || {}).email || '';

        if (p === '/api/admin/data') {
          const printed = db.jobs.filter(j => j.status === 'printed');
          const paidOrders = db.orders.filter(o => o.status === 'paid');
          const marketplaceVolume = paidOrders.reduce((a, o) => a + (o.amount || 0), 0);
          const platformFeeTotal = paidOrders.reduce((a, o) => a + (o.platform_fee_amount || 0), 0);

          return J({
            prices: PRICES,
            stats: {
              users: db.users.filter(x => !x.isAdmin).length,
              keys: db.keys.length,
              activeKeys: db.keys.filter(k => st(k) === 'active').length,
              shops: db.shops.length,
              jobs: printed.length,
              sales: db.keys.reduce((a, k) => a + (k.price || 0), 0),
              volume: printed.reduce((a, j) => a + j.amount, 0),
              marketplaceVolume,
              platformFeeTotal,
              totalOrders: db.orders.length
            },
            users: db.users.map(x => ({ id: x.id, name: x.name, email: x.email, isAdmin: !!x.isAdmin, demoUsed: x.demoUsed, keys: db.keys.filter(k => k.userId === x.id).length })),
            keys: db.keys.map(k => ({ key: k.key, plan: k.plan, planName: NAMES[k.plan], email: email(k.userId), price: k.price || 0, status: st(k), createdAt: k.createdAt, expiresAt: k.expiresAt })).reverse(),
            shops: db.shops.map(s => {
              const k = db.keys.find(x => x.key === s.keyId);
              const seller = findSellerForShop(s.id);
              return { id: s.id, name: s.name, owner: k ? email(k.userId) : '', mode: s.mode, upi: s.upi, active: shopActive(s), sellerStatus: seller ? seller.status : 'unlinked', jobs: db.jobs.filter(j => j.shopId === s.id && j.status === 'printed').length };
            }),
            jobs: db.jobs.slice(-100).reverse().map(j => ({ id: j.id, shop: (db.shops.find(s => s.id === j.shopId) || {}).name, filename: j.filename, pages: j.pages, amount: j.amount, status: j.status, createdAt: j.createdAt })),
            orders: db.orders.slice(-100).reverse().map(o => ({
              id: o.id,
              razorpay_order_id: o.razorpay_order_id,
              razorpay_payment_id: o.razorpay_payment_id,
              amount: o.amount,
              seller_share_amount: o.seller_share_amount,
              platform_fee_amount: o.platform_fee_amount,
              status: o.status,
              payout_status: o.payout_status,
              created_at: o.created_at
            }))
          });
        }

        if (p === '/api/admin/issue' && m === 'POST') {
          const usr = db.users.find(x => x.email === (b.email || '').trim().toLowerCase());
          if (!usr) return J({ error: 'No user has that email.' }, 400);
          if (!DUR[b.plan]) return J({ error: 'Unknown plan' }, 400);
          const k = { key: 'PQR-' + [0, 1, 2].map(() => rid(2).toUpperCase()).join('-'), userId: usr.id, plan: b.plan, price: 0, createdAt: Date.now(), extraMs: Math.max(0, parseInt(b.days) || 0) * 864e5 };
          db.keys.push(k);
          save();
          return J(k);
        }

        if (p === '/api/admin/key' && m === 'POST') {
          const k = db.keys.find(x => x.key === b.key);
          if (!k) return J({ error: 'Key not found' }, 404);
          if (b.action === 'revoke') {
            k.activatedAt = k.activatedAt || Date.now();
            k.expiresAt = Date.now();
          } else if (b.action === 'extend') {
            const d = (parseInt(b.days) || 30) * 864e5;
            if (k.expiresAt) k.expiresAt = Math.max(k.expiresAt, Date.now()) + d;
            else k.extraMs = (k.extraMs || 0) + d;
          } else return J({ error: 'Unknown action' }, 400);
          save();
          return J({ ok: 1 });
        }

        if (p === '/api/admin/prices' && m === 'POST') {
          ['3m', '6m', '12m'].forEach(x => {
            const v = Number(b.prices && b.prices[x]);
            if (isFinite(v) && v >= 0) PRICES[x] = v;
          });
          save();
          return J(PRICES);
        }

        return J({ error: 'Not found' }, 404);
      }

      return J({ error: 'Not found' }, 404);
    }

    // Static assets
    let f = path.join(PUB, path.normalize(p === '/' ? '/index.html' : p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': ext[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  } catch (e) {
    J({ error: e.message }, 500);
  }
}).listen(PORT, () => console.log('PrintQR server running at http://localhost:' + PORT));
