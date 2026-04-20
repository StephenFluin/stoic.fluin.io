import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';

const DATA_DIR = path.join(__dirname, 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const MEDITATIONS_FILE = path.join(__dirname, '../meditations.json');

// Initialize Firebase Admin
try {
  // Uncomment and provide your serviceAccountKey.json when deploying
  // const serviceAccount = require('./serviceAccountKey.json');
  // admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  
  // For local mocking, initialized without credentials (will throw on actual send)
  admin.initializeApp();
  console.log('Firebase Admin initialized.');
} catch (e) {
  console.warn('Firebase Admin mock init failed:', e);
}

function getInitialDay(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0); // Dec 31
  const diff = (now.getTime() - start.getTime()) + ((start.getTimezoneOffset() - now.getTimezoneOffset()) * 60 * 1000);
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

const sendDailyPush = async () => {
  console.log('Running daily push job...');
  
  if (!fs.existsSync(TOKENS_FILE)) {
    console.log('No tokens to send to.');
    return;
  }
  
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
  if (tokens.length === 0) {
    console.log('Token list is empty.');
    return;
  }

  // Load meditations payload
  const meditations = JSON.parse(fs.readFileSync(MEDITATIONS_FILE, 'utf-8'));
  const currentDay = getInitialDay();
  
  // Find meditation matching today or fallback to first element
  const meditation = meditations.find((m: any) => m.day_of_year === currentDay) || meditations[0];
  
  console.log(`Sending meditation for day ${currentDay}: ${meditation.meditation}`);
  
  const payload = {
    notification: {
      title: meditation.meditation,
      body: meditation.description.substring(0, 100) + '...'
    },
    tokens: tokens
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(payload);
    console.log(response.successCount + ' messages were sent successfully');
  } catch (error) {
    console.error('Error sending message (expected if Firebase is mocked):', error);
  }
};

// Scheduled for 8:00 AM Central Time daily
cron.schedule('0 8 * * *', () => {
  sendDailyPush();
}, {
  timezone: 'America/Chicago'
});

console.log('Cron job scheduled for 8:00 AM Central Time daily.');
// Use this to test immediately upon execution
// sendDailyPush();
