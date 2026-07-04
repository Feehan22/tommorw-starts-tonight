// api/send-notifications.js
// Vercel serverless function — called by cron job every minute
// Sends Web Push notifications for task reminders, evening nudge, re-engagement

const SUPABASE_URL = 'https://nyumfsrwrfnasvkgjulv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55dW1mc3J3cmZuYXN2a2dqdWx2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDYyOTgsImV4cCI6MjA5NjUyMjI5OH0.sW1FjOEhtZEnOIgmYDF2gd60u2aTUZs9fvK5N-1D1S8';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = 'mailto:hello@tomorrowstartstonight.co.uk';

// ── VAPID JWT signing (no npm packages needed) ──
async function createVapidJwt(audience) {
  const crypto = require('crypto');
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: audience, exp: now + 3600, sub: VAPID_SUBJECT
  })).toString('base64url');
  const data = `${header}.${payload}`;
  const keyDer = Buffer.from(VAPID_PRIVATE_KEY, 'base64url');
  const privateKey = crypto.createPrivateKey({ key: keyDer, format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

async function sendPush(subscription, title, body) {
  try {
    const sub = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
    const endpoint = sub.endpoint;
    const url = new URL(endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt = await createVapidJwt(audience);
    const payload = JSON.stringify({ title, body, icon: '/icon-192.png', badge: '/icon-192.png' });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
        'Content-Type': 'application/json',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400'
      },
      body: payload
    });
    return res.status;
  } catch(e) {
    console.error('Push send error:', e.message);
    return 500;
  }
}

async function supabaseGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

// Get HH:MM in a given IANA timezone, safely falling back to Europe/London
function getLocalTime(date, timezone) {
  try {
    return date.toLocaleTimeString('en-GB', {
      timeZone: timezone || 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  } catch (e) {
    // Invalid/unknown timezone string stored — fall back safely
    return date.toLocaleTimeString('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
}

export default async function handler(req, res) {
  // Verify this is called by Vercel cron (or manually for testing)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== 'GET') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const now = new Date();

    // Get all push subscriptions
    const subs = await supabaseGet('push_subscriptions?select=email,subscription');
    if (!subs || !subs.length) {
      res.status(200).json({ sent: 0, message: 'No subscriptions' });
      return;
    }

    // Get all user data (now includes timezone)
    const users = await supabaseGet('user_data?select=email,tasks,last_date,timezone');

    let sent = 0;

    for (const sub of subs) {
      const user = users.find(u => u.email === sub.email);
      if (!user) continue;

      // Calculate "now" in THIS user's timezone (defaults to Europe/London if not set)
      const currentTime = getLocalTime(now, user.timezone);

      // ── Task time reminders ──
      try {
        const tasks = JSON.parse(user.tasks || '[]');
        for (const task of tasks) {
          if (task.hasTime && task.time && task.val && task.val.trim() && !task.done) {
            if (task.time === currentTime) {
              const status = await sendPush(sub.subscription, `⏰ Time for: ${task.val}`, "Your reminder is here — let's get this done! 🔥");
              if (status < 300) sent++;
            }
          }
        }
      } catch(e) {}

      // ── 9pm evening nudge (9pm in the USER'S timezone) ──
      if (currentTime === '21:00') {
        const status = await sendPush(sub.subscription, 'Tomorrow starts tonight 🌙', "Set your Top 3 for tomorrow before bed. 60 seconds. Make it count.");
        if (status < 300) sent++;
      }

      // ── 2-day re-engagement (checked at 6pm in the USER'S timezone) ──
      try {
        const lastDate = user.last_date;
        if (lastDate) {
          const diffDays = Math.floor((now - new Date(lastDate)) / (1000 * 60 * 60 * 24));
          if (diffDays >= 2 && currentTime === '18:00') {
            const status = await sendPush(sub.subscription, "Your streak is waiting 🔥", `It's been ${diffDays} days. Don't let tomorrow slip by — check in tonight.`);
            if (status < 300) sent++;
          }
        }
      } catch(e) {}
    }

    res.status(200).json({ sent, time: now.toISOString() });
  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
