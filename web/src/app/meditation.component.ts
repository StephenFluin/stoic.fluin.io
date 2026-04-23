import { Component, PLATFORM_ID, Inject, Injector, effect, inject, signal, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { marked } from 'marked';
import { initializeApp, getApp, getApps } from 'firebase/app';
import { deleteToken, getMessaging, getToken } from 'firebase/messaging';
import { firebaseWebConfig, firebaseWebVapidKey } from './firebase.config';
import { Meditation } from '../shared/meditations';

interface ApiResponse {
  success: boolean;
  error?: string;
  message?: string;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unknown error';
}

@Component({
  selector: 'app-meditation',
  standalone: true,
  template: `
    <button type="button" class="app-brand app-brand-button" (click)="goToToday()">Meditations</button>
    <main aria-label="Daily meditation content">
      <div class="glass-panel">
        @if (currentMeditation()) {
          <div class="header">
            <button (click)="prevDay()">&#8592;</button>
            <div class="date-display">{{ currentDateDisplay() }}</div>
            <button (click)="nextDay()">&#8594;</button>
          </div>

          <h1 class="title">{{ currentMeditation()?.meditation }}</h1>
          <div class="description" [innerHTML]="parsedDescription()"></div>
        } @else {
          <div class="loading">
            <p>Loading meditations...</p>
          </div>
        }
      </div>
      <div class="actions">
        @if (!isSubscribed()) {
          <button class="primary-btn" [disabled]="isWorking()" (click)="subscribe()">Get these daily</button>
        } @else {
          <button class="secondary-btn" [disabled]="isWorking()" (click)="unsubscribe()">Unsubscribe</button>
        }
      </div>
    </main>
  `,
})
export class MeditationComponent {
  private static readonly tokenStorageKey = 'fcmToken';
  private static readonly dayPathPrefix = '/day/';

  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly meta = inject(Meta);
  private readonly title = inject(Title);
  private messagingSwRegistration: ServiceWorkerRegistration | null = null;
  private readonly meditationCache = new Map<string, Meditation>();
  private readonly prefetchInFlight = new Set<string>();
  private readonly meditationRequest = computed(() => {
    const date = this.currentDateDisplay();
    if (this.meditationCache.has(date)) {
      return undefined;
    }
    return `/api/meditation?date=${encodeURIComponent(date)}`;
  });
  private readonly meditationResource = httpResource<Meditation | null>(
    () => this.meditationRequest(),
    { defaultValue: null }
  );

  currentDate = signal<Date>(this.getInitialDateFromPath(this.router.url) || new Date());
  isSubscribed = signal<boolean>(false);
  isWorking = signal<boolean>(false);

  currentDateDisplay = computed(() => {
    const targetDate = this.currentDate();
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });

  currentMeditation = computed(() => {
    const date = this.currentDateDisplay();
    return this.meditationCache.get(date) || this.meditationResource.value();
  });

  parsedDescription = computed(() => {
    const med = this.currentMeditation();
    return med ? marked.parse(med.description) : '';
  });

  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    effect(() => {
      const meditation = this.meditationResource.value();
      if (!meditation) {
        return;
      }

      this.meditationCache.set(this.currentDateDisplay(), meditation);
    });

    effect(() => {
      const err = this.meditationResource.error();
      if (err) {
        console.error('Could not load meditation', err);
      }
    });

    effect(() => {
      const meditation = this.currentMeditation();
      if (!meditation) {
        return;
      }

      const dateLabel = this.currentDateDisplay();
      const description = this.buildMetaDescription(meditation);
      this.title.setTitle(`${meditation.meditation} | Daily Stoic Meditations`);
      this.meta.updateTag({
        name: 'description',
        content: `${dateLabel}: ${description}`,
      });
    });

    this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) {
        return;
      }

      const parsedDate = this.getInitialDateFromPath(event.urlAfterRedirects);
      const nextDate = this.formatDate(parsedDate || new Date());
      if (nextDate !== this.currentDateDisplay()) {
        this.currentDate.set(parsedDate || new Date());
      }
    });

    if (isPlatformBrowser(this.platformId)) {
      this.scheduleAfterIdle(() => {
        effect(() => {
          const date = this.currentDate();
          const prev = new Date(date);
          const next = new Date(date);
          prev.setDate(prev.getDate() - 1);
          next.setDate(next.getDate() + 1);

          void this.prefetchMeditation(this.formatDate(prev));
          void this.prefetchMeditation(this.formatDate(next));
        }, { injector: this.injector });
      });

      void this.syncSubscriptionState();
    }
  }

  private scheduleAfterIdle(callback: () => void): void {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(callback, { timeout: 2000 });
    } else {
      setTimeout(callback, 200);
    }
  }

  private async prefetchMeditation(date: string): Promise<void> {
    if (this.meditationCache.has(date) || this.prefetchInFlight.has(date)) {
      return;
    }

    this.prefetchInFlight.add(date);
    try {
      const response = await fetch(`/api/meditation?date=${encodeURIComponent(date)}`);
      if (!response.ok) {
        return;
      }

      const meditation = await response.json() as Meditation;
      if (
        typeof meditation?.day_of_year !== 'number' ||
        typeof meditation?.meditation !== 'string' ||
        typeof meditation?.description !== 'string'
      ) {
        return;
      }

      this.meditationCache.set(date, meditation);
    } catch {
      // Prefetch is best-effort; no user-facing error needed.
    } finally {
      this.prefetchInFlight.delete(date);
    }
  }

  private getInitialDateFromPath(pathname: string): Date | null {
    const match = pathname.match(/^\/day\/(\d{4})-(\d{2})-(\d{2})\/?$/);
    if (!match) {
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(year, month - 1, day);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day
    ) {
      return null;
    }

    return parsed;
  }

  private getPathForDate(date: string): string {
    return `${MeditationComponent.dayPathPrefix}${date}`;
  }

  private formatDate(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private buildMetaDescription(meditation: Meditation): string {
    const plain = `${meditation.meditation}. ${meditation.description}`
      .replace(/\*+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (plain.length <= 160) {
      return plain;
    }

    return `${plain.slice(0, 157).trimEnd()}...`;
  }

  private async postWithResource(url: string, body: unknown): Promise<ApiResponse> {
    const requestResource = httpResource<ApiResponse>(
      () => ({
        url,
        method: 'POST',
        body,
      }),
      { injector: this.injector }
    );

    try {
      return await new Promise<ApiResponse>((resolve, reject) => {
        let watcher: { destroy: () => void } | undefined;
        watcher = effect(() => {
          if (requestResource.isLoading()) {
            return;
          }

          const error = requestResource.error();
          if (error) {
            watcher?.destroy();
            reject(error);
            return;
          }

          if (requestResource.hasValue()) {
            watcher?.destroy();
            const response = requestResource.value();
            if (!response.success) {
              reject(new Error(response.message || response.error || 'Server request failed'));
              return;
            }
            resolve(response);
          }
        }, { injector: this.injector });
      });
    } finally {
      requestResource.destroy();
    }
  }

  private getMessagingClient() {
    if (!firebaseWebVapidKey.trim()) {
      throw new Error('Missing FCM VAPID key');
    }

    const app = getApps().length ? getApp() : initializeApp(firebaseWebConfig);
    return getMessaging(app);
  }

  private async getMessagingServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
    if (!isPlatformBrowser(this.platformId)) {
      throw new Error('Service workers are only available in the browser');
    }

    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are not supported by this browser');
    }

    if (this.messagingSwRegistration) {
      return this.messagingSwRegistration;
    }

    const existing = await navigator.serviceWorker.getRegistration('/firebase-cloud-messaging-push-scope');
    if (existing) {
      this.messagingSwRegistration = existing;
      return existing;
    }

    const registered = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/firebase-cloud-messaging-push-scope',
    });
    this.messagingSwRegistration = registered;
    return registered;
  }

  private getStoredToken(): string {
    if (!isPlatformBrowser(this.platformId)) return '';
    return localStorage.getItem(MeditationComponent.tokenStorageKey) || '';
  }

  private setStoredToken(token: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (!token) {
      localStorage.removeItem(MeditationComponent.tokenStorageKey);
      return;
    }
    localStorage.setItem(MeditationComponent.tokenStorageKey, token);
  }

  private async syncSubscriptionState(): Promise<void> {
    if (!isPlatformBrowser(this.platformId) || Notification.permission !== 'granted') {
      this.isSubscribed.set(false);
      return;
    }

    try {
      const messaging = this.getMessagingClient();
      const serviceWorkerRegistration = await this.getMessagingServiceWorkerRegistration();
      const token = await getToken(messaging, {
        vapidKey: firebaseWebVapidKey,
        serviceWorkerRegistration,
      });
      this.setStoredToken(token || '');
      this.isSubscribed.set(!!token);
    } catch (e) {
      console.error('Could not determine current FCM subscription state:', e);
      this.isSubscribed.set(!!this.getStoredToken());
    }
  }

  prevDay() {
    this.currentDate.update((date) => {
      const next = new Date(date);
      next.setDate(next.getDate() - 1);
      return next;
    });

    void this.router.navigateByUrl(this.getPathForDate(this.currentDateDisplay()));
  }

  nextDay() {
    this.currentDate.update((date) => {
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      return next;
    });

    void this.router.navigateByUrl(this.getPathForDate(this.currentDateDisplay()));
  }

  goToToday() {
    this.currentDate.set(new Date());
    void this.router.navigateByUrl('/');
  }

  async subscribe() {
    if (!isPlatformBrowser(this.platformId)) return;
    if (this.isSubscribed() || this.isWorking()) return;

    this.isWorking.set(true);
    try {
      const messaging = this.getMessagingClient();
      const serviceWorkerRegistration = await this.getMessagingServiceWorkerRegistration();

      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const token = await getToken(messaging, {
          vapidKey: firebaseWebVapidKey,
          serviceWorkerRegistration,
        });
        if (!token) {
          alert('Could not get an FCM token for this browser.');
          this.isWorking.set(false);
          return;
        }

        this.setStoredToken(token);
        console.log('FCM Token:', token);

        await this.postWithResource('/api/register', { token });
        this.isSubscribed.set(true);
        this.isWorking.set(false);
        alert('Successfully subscribed to daily meditations!');
      } else {
        this.isSubscribed.set(false);
        alert('Permission denied');
        this.isWorking.set(false);
      }
    } catch (e) {
      console.error(e);
      alert(`Subscription failed: ${getErrorMessage(e)}`);
      this.isWorking.set(false);
    }
  }

  async unsubscribe() {
    if (!isPlatformBrowser(this.platformId)) return;
    if (!this.isSubscribed() || this.isWorking()) return;

    this.isWorking.set(true);
    const storedToken = this.getStoredToken();

    try {
      const messaging = this.getMessagingClient();
      await deleteToken(messaging);

      if (storedToken) {
        await this.postWithResource('/api/unregister', { token: storedToken });
      }

      this.setStoredToken('');
      this.isSubscribed.set(false);
      this.isWorking.set(false);
      alert('You are unsubscribed from daily meditations.');
    } catch (e) {
      console.error(e);
      this.isWorking.set(false);
      alert(`Could not unsubscribe: ${getErrorMessage(e)}`);
    }
  }
}
