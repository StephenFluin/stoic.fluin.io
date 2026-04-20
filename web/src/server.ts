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
