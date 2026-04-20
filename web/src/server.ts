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

try {
  if (!getApps().length) {
    const projectIdFromGoogleCloudProject = process.env['GOOGLE_CLOUD_PROJECT'];
    const projectIdFromGcloudProject = process.env['GCLOUD_PROJECT'];
    const projectId =
      projectIdFromGoogleCloudProject ||
      projectIdFromGcloudProject ||
      'stoic-fluin-io';
    const projectIdSource = projectIdFromGoogleCloudProject
      ? 'GOOGLE_CLOUD_PROJECT'
      : projectIdFromGcloudProject
        ? 'GCLOUD_PROJECT'
        : 'hardcoded fallback';

    console.info(`[Firebase Admin] Initializing with projectId="${projectId}" (source: ${projectIdSource})`);

    initializeApp({
      credential: applicationDefault(),
      projectId,
    });
  } else {
    console.info('[Firebase Admin] Reusing existing initialized app instance.');
  }
} catch (e) {
  console.warn('Firebase Admin local init failed:', e);
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

app.post('/api/register', async (req: express.Request, res: express.Response) => {
  const token = getValidToken(req.body?.token);
  if (!token) {
    res.status(400).json({ error: 'A valid token is required' });
    return;
  }
  try {
    const db = getFirestore();
    await db.collection('fcmTokens').doc(token).set({ token, createdAt: new Date() }, { merge: true });
    res.json({ success: true });
  } catch (err: any) {
    console.error('Firestore Error:', err);
    res.status(200).json({ success: true, mocked: true }); // Fallback success for local UI testing
  }
});

app.post('/api/unregister', async (req: express.Request, res: express.Response) => {
  const token = getValidToken(req.body?.token);
  if (!token) {
    res.status(400).json({ error: 'A valid token is required' });
    return;
  }

  try {
    const db = getFirestore();
    await db.collection('fcmTokens').doc(token).delete();
    res.json({ success: true });
  } catch (err: any) {
    console.error('Firestore Error:', err);
    res.status(200).json({ success: true, mocked: true }); // Fallback success for local UI testing
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
