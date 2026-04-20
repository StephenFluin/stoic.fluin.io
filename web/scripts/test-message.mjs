#!/usr/bin/env node

import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

function usage() {
  console.log('Usage: npm run test-message -- "Your push message"');
}

const messageBody = process.argv.slice(2).join(' ').trim();

if (!messageBody) {
  usage();
  process.exit(1);
}

const projectId =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  'stoic-fluin-io';

try {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId,
    });
  }

  console.info(`[FCM Test] Using projectId="${projectId}"`);

  const db = getFirestore();
  const snapshot = await db.collection('fcmTokens').get();
  const tokenSet = new Set();

  for (const doc of snapshot.docs) {
    const token = doc.get('token') || doc.id;
    if (typeof token === 'string' && token.trim()) {
      tokenSet.add(token);
    }
  }

  const tokens = Array.from(tokenSet);

  if (!tokens.length) {
    console.log('[FCM Test] No registered tokens found in fcmTokens collection.');
    process.exit(0);
  }

  const notification = {
    title: 'Stoic Meditations',
    body: messageBody,
  };

  let successCount = 0;
  let failureCount = 0;
  const staleTokens = [];

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const response = await getMessaging().sendEachForMulticast({
      tokens: chunk,
      notification,
      data: {
        testMessage: messageBody,
        sentAt: new Date().toISOString(),
      },
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((result, index) => {
      if (result.success) return;

      const token = chunk[index];
      const code = result.error?.code || 'unknown';
      console.error(`[FCM Test] Failed token ${token}: ${code}`);

      if (code === 'messaging/registration-token-not-registered') {
        staleTokens.push(token);
      }
    });
  }

  if (staleTokens.length) {
    await Promise.all(
      staleTokens.map((token) => db.collection('fcmTokens').doc(token).delete().catch(() => undefined))
    );
    console.info(`[FCM Test] Removed ${staleTokens.length} stale token(s) from Firestore.`);
  }

  console.log(
    `[FCM Test] Sent notification to ${tokens.length} token(s): ${successCount} success, ${failureCount} failure.`
  );

  if (!successCount) {
    process.exit(1);
  }
} catch (error) {
  console.error('[FCM Test] Error sending push message:', error);
  const message = String(error?.message || '');
  if (message.includes('Could not load the default credentials')) {
    console.error('[FCM Test] Run: gcloud auth application-default login');
  }
  process.exit(1);
}
