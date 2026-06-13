// api/stripe-webhook.js
// Listens for Stripe payment events and updates the user's plan in Supabase.

const SUPABASE_URL = 'https://nyumfsrwrfnasvkgjulv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55dW1mc3J3cmZuYXN2a2dqdWx2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDYyOTgsImV4cCI6MjA5NjUyMjI5OH0.sW1FjOEhtZEnOIgmYDF2gd60u2aTUZs9fvK5N-1D1S8';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Vercel needs the raw body to verify the Stripe signature
export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Minimal Stripe signature verification (no stripe npm package needed)
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const crypto = await import('crypto');
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return expected === parts.v1;
}

async function updateSupabasePlan(email, plan, name) {
  if (!email) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_data?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ plan, updated_at: new Date().toISOString() }),
  });

  const data = await res.json().catch(() => null);

  // If no row exists yet for this email (they paid before ever opening the app),
  // create one so the plan is ready when they sign up.
  if (Array.isArray(data) && data.length === 0) {
    await fetch(`${SUPABASE_URL}/rest/v1/user_data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ email, name: name || '', plan }),
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  let event;
  try {
    const rawBody = (await buffer(req)).toString('utf8');
    const sig = req.headers['stripe-signature'];

    if (STRIPE_WEBHOOK_SECRET) {
      const valid = await verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        res.status(400).send('Invalid signature');
        return;
      }
    }

    event = JSON.parse(rawBody);
  } catch (err) {
    res.status(400).send(`Webhook error: ${err.message}`);
    return;
  }

  try {
    const obj = event.data?.object;

    switch (event.type) {
      // Fired when a checkout completes (first payment)
      case 'checkout.session.completed': {
        const email = obj.customer_details?.email || obj.customer_email;
        const amountTotal = obj.amount_total; // in pence
        const plan = amountTotal >= 3000 ? 'annual' : 'monthly';
        await updateSupabasePlan(email, plan, obj.customer_details?.name);
        break;
      }

      // Fired on recurring renewals
      case 'invoice.paid': {
        const email = obj.customer_email;
        const amountPaid = obj.amount_paid;
        const plan = amountPaid >= 3000 ? 'annual' : 'monthly';
        await updateSupabasePlan(email, plan);
        break;
      }

      // Fired when a subscription is cancelled
      case 'customer.subscription.deleted': {
        // Stripe doesn't always include email here directly; best-effort via customer object
        // For now we leave the user's plan as-is; manual follow-up via email recommended.
        break;
      }

      default:
        // Ignore other event types
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler error');
  }
}
