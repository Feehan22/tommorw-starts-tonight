// api/send-notifications.js
// Vercel serverless function — called by cron job every minute
//
// v7: uses the private service key. v6: skips expired free trials. v5: every task now carries a "forDate" (the day it is meant for). The
// server only sends a task reminder when forDate is TODAY in the user's
// timezone, so reminders never fire on the wrong day and expire on their
// own once the day is over. Tasks saved before this change have no
// forDate and keep the old behaviour until the app re-saves them.
//
// v6: free accounts whose 5-day trial has ended get no pushes at all (no task
// reminders, no 9pm nudge, no re-engagement). Paid accounts are never affected.

const webpush = require('web-push');

const SUPABASE_URL = 'https://nyumfsrwrfnasvkgjulv.supabase.co';
// Private server key (bypasses the database lock). Falls back to the public key
// only so nothing breaks before the new key is deployed.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55dW1mc3J3cmZuYXN2a2dqdWx2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NDYyOTgsImV4cCI6MjA5NjUyMjI5OH0.sW1FjOEhtZEnOIgmYDF2gd60u2aTUZs9fvK5N-1D1S8';
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

// Update a single column (tasks or today_tasks) for one user
async function supabaseUpdateColumn(email, column, valueArray) {
  await fetch(`${SUPABASE_URL}/rest/v1/user_data?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ [column]: JSON.stringify(valueArray) })
  });
}

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

// Today's date as YYYY-MM-DD in the user's timezone (en-CA prints it that way)
function getLocalDate(date, timezone) {
  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone || 'Europe/London' });
  } catch (e) {
    return date.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  }
}

// True only for a FREE account whose 5-day trial is over. Same maths as the app.
// If there is no start date, we treat the account as NOT expired (fail open).
function isExpiredFree(user, now) {
  const isPaid = user.plan && user.plan !== 'free';
  if (isPaid) return false;
  if (!user.trial_start) return false;
  const used = Math.floor((now - new Date(user.trial_start)) / 86400000);
  return used >= 5;
}

// Checks one list of tasks (either "tasks" or "today_tasks") for anything
// due right now ON THE RIGHT DAY, sends it, marks it notified, and reports
// if anything changed.
async function checkTaskList(rawJson, currentTime, todayStr, subscription, email, results) {
  let sent = 0;
  try {
    const list = JSON.parse(rawJson || '[]');
    let changed = false;
    for (const task of list) {
      if (
        task.hasTime &&
        task.time &&
        task.val &&
        task.val.trim() &&
        !task.done &&
        !task.notified &&
        task.time === currentTime &&
        (!task.forDate || task.forDate === todayStr)
      ) {
        const status = await sendPush(
          subscription,
          `⏰ Time for: ${task.val}`,
          "Your reminder is here — let's get this done! 🔥"
        );
        results.push({ email, type: 'task', status });
        if (status < 300) {
          sent++;
          task.notified = true;
          changed = true;
        }
      }
    }
    return { list, changed, sent };
  } catch (e) {
    return { list: null, changed: false, sent: 0 };
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

    const users = await supabaseGet('user_data?select=email,tasks,today_tasks,last_date,timezone,plan,trial_start');
    if (!Array.isArray(users)) throw new Error('Could not load user data');

    let sent = 0;
    const results = [];

    for (const sub of subs) {
      const user = users.find(u => u.email === sub.email);
      if (!user) continue;

      // Free trial over: send this account nothing
      if (isExpiredFree(user, now)) continue;

      const currentTime = getLocalTime(now, user.timezone);
      const todayStr = getLocalDate(now, user.timezone);

      // ── Check "Tonight" plan ──
      const tonightResult = await checkTaskList(user.tasks, currentTime, todayStr, sub.subscription, sub.email, results);
      sent += tonightResult.sent;
      if (tonightResult.changed) {
        await supabaseUpdateColumn(user.email, 'tasks', tonightResult.list);
      }

      // ── Check "Today" live list ──
      const todayResult = await checkTaskList(user.today_tasks, currentTime, todayStr, sub.subscription, sub.email, results);
      sent += todayResult.sent;
      if (todayResult.changed) {
        await supabaseUpdateColumn(user.email, 'today_tasks', todayResult.list);
      }

      // ── 9pm evening nudge (meant to repeat daily for everyone) ──
      if (currentTime === '21:00') {
        const status = await sendPush(sub.subscription, 'Tomorrow starts tonight 🌙', "Set your Top 3 for tomorrow before bed. 60 seconds. Make it count.");
        results.push({ email: sub.email, type: 'evening_nudge', status });
        if (status < 300) sent++;
      }

      // ── 2-day re-engagement ──
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

    const expiredFree = users.filter(u => isExpiredFree(u, now)).length;
    res.status(200).json({ sent, time: now.toISOString(), expiredFree, results });
  } catch(e) {
    console.error('Handler error:', e);
    res.status(500).json({ error: e.message });
  }
}
