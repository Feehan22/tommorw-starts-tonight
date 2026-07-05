// api/send-notifications.js
// Vercel serverless function — called by cron job every minute
// Sends Web Push notifications for task reminders, evening nudge, re-engagement
//
// FIXED: now uses the official "web-push" library for encryption instead of
// a hand-built version. This is what was silently failing before — messages
// were being sent unencrypted/mislabeled, so Apple/browsers discarded them
// with no visible error.

const webpush = require('web-push');

const SUPABASE_URL = 'https://nyumfsrwrfnasvkgjulv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55dW1mc3J3cmZuYXN2a2dqdWx2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDYyOTgsImV4cCI6MjA5NjUyMjI5OH0.sW1FjOEhtZEnOIgmYDF2gd60u2aTUZs9fvK5N-1D1S8';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = 'mailto:hello@tomorrowstartstonight.co.uk';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function sendPush(subscription, title, body) {
  try {
    const sub = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
    const payload = JSON.stringify({ title, body, icon: '/icon-192.png', badge: '/icon-192.png' });
    await webpush.sendNotification(sub, payload);
    return 201;
  } catch (e) {
    // web-push throws an error object with a statusCode when the push service rejects it
    console.error('Push send error:', e.statusCode, e.body || e.message);
    return e.statusCode || 500;
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
    return date.toLocaleTimeString('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== 'GET') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const now = new Date();

    const subs = await supabaseGet('push_subscriptions?select=email,subscription');
    if (!subs || !subs.length) {
      res.status(200).json({ sent: 0, message: 'No subscriptions' });
      return;
    }

    const users = await supabaseGet('user_data?select=email,tasks,last_date,timezone');

    let sent = 0;
    const results = [];

    for (const sub of subs) {
      const user = users.find(u => u.email === sub.email);
      if (!user) continue;

      const currentTime = getLocalTime(now, user.timezone);

      try {
        const tasks = JSON.parse(user.tasks || '[]');
        for (const task of tasks) {
          if (task.hasTime && task.time && task.val && task.val.trim() && !task.done) {
            if (task.time === currentTime) {
              const status = await sendPush(sub.subscription, `⏰ Time for: ${task.val}`, "Your reminder is here — let's get this done! 🔥");
              results.push({ email: sub.email, type: 'task', status });
              if (status < 300) sent++;
            }
          }
        }
      } catch(e) {}

      if (currentTime === '21:00') {
        const status = await sendPush(sub.subscription, 'Tomorrow starts tonight 🌙', "Set your Top 3 for tomorrow before bed. 60 seconds. Make it count.");
        results.push({ email: sub.email, type: 'evening_nudge', status });
        if (status < 300) sent++;
      }

      try {
        const lastDate = user.last_date;
        if (lastDate) {
          const diffDays = Math.floor((now - new Date(lastDate)) / (1000 * 60 * 60 * 24));
          if (diffDays >= 2 && currentTime === '18:00') {
            const status = await sendPush(sub.subscription, "Your streak is waiting 🔥", `It's been ${diffDays} days. Don't let tomorrow slip by — check in tonight.`);
            results.push({ email: sub.email, type: 're_engagement', status });
            if (status < 300) sent++;
          }
        }
      } catch(e) {}
    }

    res.status(200).json({ sent, time: now.toISOString(), results });
  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
