'use strict';

// FFMT Play — isolated deposit gateway test server.
// This is deliberately separate from the production FFMT backend.
// Wallet crediting is NOT implemented here. Never credit a wallet from an
// unverified webhook. SpacePay's published docs do not specify signature format.

const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const UPI_ID = (process.env.DEPOSIT_UPI_ID || '').trim();
const UPI_NAME = (process.env.DEPOSIT_UPI_NAME || 'FFMT Play').trim();
const SPACEPAY_PUBLIC_KEY = (process.env.SPACEPAY_PUBLIC_KEY || '').trim();
const SPACEPAY_SECRET_KEY = (process.env.SPACEPAY_SECRET_KEY || '').trim();
const SPACEPAY_REDIRECT_URL = (process.env.SPACEPAY_REDIRECT_URL || '').trim();
const MIN_AMOUNT = Number(process.env.MIN_DEPOSIT_RUPEES || 10);
const MAX_AMOUNT = Number(process.env.MAX_DEPOSIT_RUPEES || 50000);

// Ephemeral test storage only. Orders/events are lost when the service restarts.
const orders = new Map();
const webhookEvents = [];

// Capture exact webhook bytes before JSON parsing, in case signature verification
// is added later once SpacePay confirms its official header/algorithm.
app.use('/api/webhooks/spacepay', express.raw({ type: '*/*', limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

function newOrderId(prefix = 'FFMTTEST') {
  return `${prefix}${Date.now()}${crypto.randomInt(1000, 9999)}`;
}
function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) return null;
  // Only allow up to 2 decimal places.
  if (Math.round(amount * 100) !== amount * 100) return null;
  return amount;
}
function makeUpiUri({ amount, orderId }) {
  const params = new URLSearchParams({
    pa: UPI_ID,
    pn: UPI_NAME,
    am: amount.toFixed(2),
    cu: 'INR',
    tn: orderId
  });
  return `upi://pay?${params.toString()}`;
}

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    service: 'FFMT Play Deposit Test Server',
    mode: 'isolated-test-only',
    upiConfigured: Boolean(UPI_ID),
    spacepayConfigured: Boolean(SPACEPAY_PUBLIC_KEY && SPACEPAY_SECRET_KEY && SPACEPAY_REDIRECT_URL),
    walletCreditEnabled: false,
    timestamp: new Date().toISOString()
  });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FFMT Deposit Test</title><style>body{font-family:system-ui;max-width:560px;margin:24px auto;padding:0 16px;background:#090011;color:#fff}main{background:#151922;padding:20px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #555;font-size:16px}button{background:#ff6b00;color:#fff;border:0;font-weight:700}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{display:block;max-width:240px;margin:16px auto;background:white;padding:8px}</style></head><body><main><h2>FFMT Play — Deposit Testing</h2><p>Isolated test server. This does not credit any real wallet.</p><label>Amount (₹)</label><input id="amount" type="number" min="${MIN_AMOUNT}" max="${MAX_AMOUNT}" step="0.01" value="10"><button onclick="upi()">Generate Dynamic UPI QR</button><button onclick="spacepay()">Create SpacePay Payment Link</button><div id="result"></div><script>
async function upi(){const r=await fetch('/api/deposits/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount:document.getElementById('amount').value})});document.getElementById('result').innerHTML='<pre>'+JSON.stringify(await r.json(),null,2)+'</pre>';}
async function spacepay(){const r=await fetch('/api/spacepay/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount:document.getElementById('amount').value})});const d=await r.json();document.getElementById('result').innerHTML='<pre>'+JSON.stringify(d,null,2)+'</pre>'+(d.paymentUrl?'<p><a style="color:#ff9100" href="'+d.paymentUrl+'" target="_blank" rel="noopener">Open SpacePay checkout</a></p>':'');}
</script></main></body></html>`);
});

// Dynamic UPI intent + QR. Requires DEPOSIT_UPI_ID environment variable.
app.post('/api/deposits/create', async (req, res) => {
  try {
    const amount = parseAmount(req.body && req.body.amount);
    if (amount === null) return res.status(400).json({ success: false, message: `Amount must be between ₹${MIN_AMOUNT} and ₹${MAX_AMOUNT}, with at most 2 decimals.` });
    if (!UPI_ID) return res.status(503).json({ success: false, message: 'DEPOSIT_UPI_ID is not configured in Render environment variables.' });
    const orderId = newOrderId();
    const upiUri = makeUpiUri({ amount, orderId });
    const qrDataUrl = await QRCode.toDataURL(upiUri, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
    const order = { orderId, amount, currency: 'INR', method: 'dynamic_upi', status: 'pending', upiUri, createdAt: new Date().toISOString() };
    orders.set(orderId, order);
    res.json({ success: true, message: 'Dynamic UPI QR generated. This test server does not verify payment or credit a wallet.', ...order, upiId: UPI_ID, upiName: UPI_NAME, qrDataUrl });
  } catch (err) {
    console.error('UPI create error:', err.message);
    res.status(500).json({ success: false, message: 'Could not create UPI QR.' });
  }
});

// SpacePay API according to https://spacepay.in/api-docs (POST /v1/pay).
app.post('/api/spacepay/create', async (req, res) => {
  try {
    const amount = parseAmount(req.body && req.body.amount);
    if (amount === null) return res.status(400).json({ success: false, message: `Amount must be between ₹${MIN_AMOUNT} and ₹${MAX_AMOUNT}, with at most 2 decimals.` });
    if (!SPACEPAY_PUBLIC_KEY || !SPACEPAY_SECRET_KEY || !SPACEPAY_REDIRECT_URL) {
      return res.status(503).json({ success: false, message: 'Set SPACEPAY_PUBLIC_KEY, SPACEPAY_SECRET_KEY and SPACEPAY_REDIRECT_URL in Render environment variables.' });
    }
    const orderId = newOrderId('FFMTSPS');
    const payload = {
      public_key: SPACEPAY_PUBLIC_KEY,
      secret_key: SPACEPAY_SECRET_KEY,
      amount: amount.toFixed(2),
      order_id: orderId,
      customer_mobile: String((req.body && req.body.customerMobile) || process.env.TEST_CUSTOMER_MOBILE || '9999999999').replace(/\D/g, '').slice(-10),
      redirect_url: SPACEPAY_REDIRECT_URL
    };
    if (!/^\d{10}$/.test(payload.customer_mobile)) return res.status(400).json({ success: false, message: 'customerMobile must be a 10-digit mobile number.' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let gatewayResponse;
    try {
      gatewayResponse = await fetch('https://api.spacepay.in/v1/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally { clearTimeout(timeout); }
    const data = await gatewayResponse.json().catch(() => ({}));
    if (!gatewayResponse.ok || !data || !data.result || !data.result.payment_url) {
      console.error('SpacePay create failed:', gatewayResponse.status, JSON.stringify(data).slice(0, 1000));
      return res.status(502).json({ success: false, message: 'SpacePay did not return a payment URL. Check SpacePay dashboard/API credentials and Render logs.', gatewayHttpStatus: gatewayResponse.status, gatewayResponse: data });
    }
    const order = { orderId, amount, currency: 'INR', method: 'spacepay', status: 'pending', paymentUrl: data.result.payment_url, createdAt: new Date().toISOString() };
    orders.set(orderId, order);
    res.json({ success: true, message: 'SpacePay payment link created. Payment status is not yet verified and no wallet is credited.', ...order });
  } catch (err) {
    console.error('SpacePay create error:', err.name, err.message);
    res.status(502).json({ success: false, message: err.name === 'AbortError' ? 'SpacePay request timed out.' : 'Could not connect to SpacePay API.' });
  }
});

// Webhook receipt-only test endpoint. It intentionally does NOT mark an order paid.
// Obtain signature header, HMAC algorithm, signed bytes/encoding and event schema
// from SpacePay support/docs before enabling verification or wallet crediting.
app.post('/api/webhooks/spacepay', (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  let parsed = null;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch (_) { /* retain raw receipt */ }
  const event = {
    receivedAt: new Date().toISOString(),
    headers: {
      'content-type': req.get('content-type') || null,
      'x-webhook-signature-present': Boolean(req.get('x-webhook-signature')),
      'x-signature-present': Boolean(req.get('x-signature'))
    },
    parseableJson: parsed !== null,
    payload: parsed,
    rawBody: parsed === null ? raw.toString('utf8').slice(0, 5000) : undefined,
    verified: false,
    action: 'receipt-only; no order status change and no wallet credit'
  };
  webhookEvents.push(event);
  if (webhookEvents.length > 100) webhookEvents.shift();
  console.log('SpacePay webhook received (NOT VERIFIED):', JSON.stringify(event));
  res.status(202).json({ success: true, received: true, verified: false, message: 'Webhook received for testing only; no payment was confirmed and no wallet was credited.' });
});

// Safe diagnostic endpoints for isolated testing only. Do not use this server
// as the production wallet backend or expose it as a public transaction ledger.
app.get('/api/test/orders/:orderId', (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found in this process memory.' });
  res.json({ success: true, order });
});
app.get('/api/test/webhook-count', (_req, res) => res.json({ success: true, count: webhookEvents.length, note: 'Payloads are only in server memory and are not payment verification.' }));

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err.message);
  res.status(400).json({ success: false, message: 'Invalid request.' });
});

app.listen(PORT, () => {
  console.log(`FFMT Deposit Test Server listening on ${PORT}`);
  console.log(`UPI configured: ${Boolean(UPI_ID)} | SpacePay configured: ${Boolean(SPACEPAY_PUBLIC_KEY && SPACEPAY_SECRET_KEY && SPACEPAY_REDIRECT_URL)}`);
});
