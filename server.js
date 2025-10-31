'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch'); // v2
const Stripe = require('stripe');

const {
  STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  SQUARESPACE_API_KEY,
  PORT = 8080,
} = process.env;

if (!STRIPE_API_KEY || !STRIPE_WEBHOOK_SECRET || !SQUARESPACE_API_KEY) {
  console.error('Missing required env vars.');
  process.exit(1);
}

const stripe = Stripe(STRIPE_API_KEY);
const app = express();

// Squarespace Orders API base (yours)
const SS_BASE = 'https://api.squarespace.com/1.0/commerce/orders';

// Helper: Squarespace GET
async function ssGet(path) {
  const url = `${SS_BASE}${path}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SQUARESPACE_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Squarespace ${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json();
}

// Stripe requires raw body for signature verification
app.post('/webhooks/stripe', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded' || event.type === 'charge.succeeded') {
      await handleStripeEvent(event);
    }
    // Always 200 so Stripe doesn’t retry forever (log failures internally)
    res.json({ received: true });
  } catch (err) {
    console.error('Handler error:', err);
    // Optionally return 500 to have Stripe retry; 200 is fine if you have logging/alerts.
    res.json({ received: true, error: true });
  }
});

async function handleStripeEvent(event) {
  let paymentIntentId = null;
  let chargeId = null;

  if (event.type.startsWith('payment_intent.')) {
    const pi = event.data.object;
    paymentIntentId = pi.id;
    if (pi.latest_charge) chargeId = pi.latest_charge;
  } else if (event.type === 'charge.succeeded') {
    const ch = event.data.object;
    chargeId = ch.id;
    if (ch.payment_intent) paymentIntentId = ch.payment_intent;
  }

  // Retrieve charge to read metadata reliably (even if event was PI)
  let charge = null;
  if (chargeId) {
    charge = await stripe.charges.retrieve(chargeId, { expand: [] });
  } else if (paymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['charges.data'] });
    charge = pi.charges?.data?.[0] || null;
  }

  if (!charge) {
    console.warn('No charge found; cannot read metadata join key.');
    return;
  }

  // Stripe normalizes metadata keys to lowercase
  const md = charge.metadata || {};
  const orderId =
    md.metadataid ||
    md.orderid ||
    md.squarespace_order_id ||
    null;

  if (!orderId) {
    console.warn('No Squarespace order id in charge.metadata; aborting clean match.');
    return;
  }

  // Fetch Squarespace order by id
  const order = await ssGet(`/${encodeURIComponent(orderId)}`);

  // Build description from line items
  const names = (order.lineItems || [])
    .map(li => (li?.productName || '').trim())
    .filter(Boolean);

  if (!names.length) {
    console.warn(`Order ${orderId} has no productName entries.`);
    return;
  }

  const description = names.join(', ').slice(0, 500); // keep it under Stripe UI-friendly limit

  // Ensure we have PI id to update
  if (!paymentIntentId) {
    // Most Stripe flows will have it on the charge
    paymentIntentId = charge.payment_intent || null;
  }
  if (!paymentIntentId) {
    console.warn('No PaymentIntent id available; cannot update description.');
    return;
  }

  const updated = await stripe.paymentIntents.update(paymentIntentId, {
    description,
    metadata: {
      // keep this linkage for future audits/searching
      squarespace_order_id: order.id,
      squarespace_order_number: String(order.orderNumber || ''),
      product_count: String(names.length)
    }
  });

  console.log(`✅ Updated PI ${updated.id} description → "${description}"`);
}

app.get('/health', (_req, res) => res.send('ok'));
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
