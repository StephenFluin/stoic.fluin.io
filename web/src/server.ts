import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { BatchResponse, SendResponse, getMessaging } from 'firebase-admin/messaging';
import {
  getMeditationForDate,
} from './shared/meditations';
import { MEDITATIONS } from './shared/meditations.data';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'] || process.env['GCLOUD_PROJECT'] || 'stoic-fluin-io';
const isGoogleRuntime = Boolean(process.env['K_SERVICE'] || process.env['GAE_ENV'] || process.env['FUNCTION_TARGET']);
const shouldPreferEmulator = !isGoogleRuntime && process.env['FIRESTORE_USE_EMULATOR'] !== 'false';

if (shouldPreferEmulator && !process.env['FIRESTORE_EMULATOR_HOST']) {
  process.env['FIRESTORE_EMULATOR_HOST'] = '127.0.0.1:8081';
}

const firestoreMode = process.env['FIRESTORE_EMULATOR_HOST']
  ? `emulator(${process.env['FIRESTORE_EMULATOR_HOST']})`
  : (isGoogleRuntime ? 'google-runtime-workload-identity' : 'local-adc');

try {
  if (!getApps().length) {
    console.info(`[Firebase Admin] Initializing Firestore with projectId="${projectId}" mode=${firestoreMode}`);
    const options = process.env['FIRESTORE_EMULATOR_HOST']
      ? { projectId }
      : { projectId, credential: applicationDefault() };
    initializeApp(options);
  } else {
    console.info('[Firebase Admin] Reusing existing initialized app instance.');
  }
} catch (e) {
  console.warn('[Firebase Admin] Initialization failed:', e);
}

const app = express();
const angularApp = new AngularNodeAppEngine();

app.use(express.json());

function getValidToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token) return null;
  // FCM tokens are long URL-safe-ish strings; enforce reasonable bounds.
  if (token.length < 20 || token.length > 4096) return null;
  if (!/^[A-Za-z0-9:_\-\.]+$/.test(token)) return null;
  return token;
}

function parseApiDateParam(value: unknown): Date | null {
  if (value === undefined) {
    return new Date();
  }

  if (Array.isArray(value) || typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function getInvalidTokens(tokens: string[], result: BatchResponse): string[] {
  const invalidCodes = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ]);

  return result.responses.flatMap((response: SendResponse, index: number) => {
    const code = response.error?.code;
    if (response.success || !code || !invalidCodes.has(code)) {
      return [];
    }
    return [tokens[index]];
  });
}

let hasLoggedMissingAdcHint = false;

function isMissingAdcError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Could not load the default credentials');
}

function isEmulatorUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  return message.includes('ECONNREFUSED') || message.includes('14 UNAVAILABLE');
}

function handleFirestoreError(error: unknown, res: express.Response): void {
  if (process.env['FIRESTORE_EMULATOR_HOST'] && isEmulatorUnavailableError(error)) {
    console.error('[Firestore] Emulator unavailable:', error);
    res.status(503).json({
      success: false,
      error: 'firestore-emulator-unavailable',
      message: `Could not reach Firestore emulator at ${process.env['FIRESTORE_EMULATOR_HOST']}. Start it with: firebase emulators:start --only firestore`,
    });
    return;
  }

  if (isMissingAdcError(error)) {
    if (!hasLoggedMissingAdcHint) {
      hasLoggedMissingAdcHint = true;
      console.warn('[Firestore] Missing Application Default Credentials. Either run `gcloud auth application-default login` or set FIRESTORE_USE_EMULATOR=true and run `firebase emulators:start --only firestore`.');
    }

    res.status(503).json({
      success: false,
      error: 'missing-application-default-credentials',
      message: 'Server is missing Google Application Default Credentials.',
    });
    return;
  }

  console.error('Firestore Error:', error);
  res.status(500).json({
    success: false,
    error: 'firestore-operation-failed',
  });
}

app.get('/api/meditation', (req: express.Request, res: express.Response) => {
  const targetDate = parseApiDateParam(req.query['date']);
  if (!targetDate) {
    res.status(400).json({
      success: false,
      error: 'invalid-date',
      message: 'Use date format YYYY-MM-DD.',
    });
    return;
  }

  const meditation = getMeditationForDate(MEDITATIONS, targetDate, { timeZone: 'America/Chicago' });
  if (!meditation) {
    res.status(404).json({
      success: false,
      error: 'meditation-not-found',
    });
    return;
  }

  res.json(meditation);
});

app.post('/api/register', async (req: express.Request, res: express.Response) => {
  const token = getValidToken(req.body?.token);
  if (!token) {
    res.status(400).json({ success: false, error: 'invalid-token', message: 'A valid token is required' });
    return;
  }
  try {
    const db = getFirestore();
    await db.collection('fcmTokens').doc(token).set({ token, createdAt: new Date() }, { merge: true });
    res.json({ success: true });
  } catch (err: unknown) {
    handleFirestoreError(err, res);
  }
});

app.post('/api/unregister', async (req: express.Request, res: express.Response) => {
  const token = getValidToken(req.body?.token);
  if (!token) {
    res.status(400).json({ success: false, error: 'invalid-token', message: 'A valid token is required' });
    return;
  }

  try {
    const db = getFirestore();
    await db.collection('fcmTokens').doc(token).delete();
    res.json({ success: true });
  } catch (err: unknown) {
    handleFirestoreError(err, res);
  }
});

app.post('/api/scheduler/push', async (req: express.Request, res: express.Response) => {
  const expectedSecret = process.env['SCHEDULER_SECRET']?.trim() || '';
  const providedSecret = req.get('x-scheduler-secret')?.trim() || '';

  if (!expectedSecret) {
    res.status(500).json({
      success: false,
      error: 'scheduler-auth-not-configured',
      message: 'SCHEDULER_SECRET must be configured.',
    });
    return;
  }

  if (providedSecret !== expectedSecret) {
    res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Invalid scheduler secret.',
    });
    return;
  }

  const link = 'https://stoic.fluin.io/';

  try {
    const todayMeditation = getMeditationForDate(MEDITATIONS, new Date(), { timeZone: 'America/Chicago' });
    if (!todayMeditation) {
      throw new Error('No meditation found for current date.');
    }

    const title = todayMeditation.meditation;
    const body = todayMeditation.description;
    const db = getFirestore();
    const snapshot = await db.collection('fcmTokens').get();
    const tokens = snapshot.docs
      .map((doc) => doc.get('token') || doc.id)
      .filter((value): value is string => getValidToken(value) !== null);

    if (!tokens.length) {
      res.json({ success: true, sent: 0, failed: 0, totalTokens: 0, pruned: 0 });
      return;
    }

    let sent = 0;
    let failed = 0;
    const invalidTokens: string[] = [];

    for (let index = 0; index < tokens.length; index += 500) {
      const tokenBatch = tokens.slice(index, index + 500);
      const result = await getMessaging().sendEachForMulticast({
        tokens: tokenBatch,
        notification: { title, body },
        data: {
          type: 'daily-meditation',
          link,
        },
        webpush: {
          fcmOptions: { link },
        },
      });

      sent += result.successCount;
      failed += result.failureCount;
      invalidTokens.push(...getInvalidTokens(tokenBatch, result));
    }

    if (invalidTokens.length) {
      const uniqueInvalidTokens = [...new Set(invalidTokens)];
      for (let index = 0; index < uniqueInvalidTokens.length; index += 450) {
        const deleteBatch = uniqueInvalidTokens.slice(index, index + 450);
        const writeBatch = db.batch();
        for (const token of deleteBatch) {
          writeBatch.delete(db.collection('fcmTokens').doc(token));
        }
        await writeBatch.commit();
      }
    }

    res.json({
      success: true,
      sent,
      failed,
      totalTokens: tokens.length,
      pruned: invalidTokens.length,
    });
  } catch (err: unknown) {
    handleFirestoreError(err, res);
  }
});

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
