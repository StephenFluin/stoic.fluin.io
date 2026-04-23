import { Component, PLATFORM_ID, Inject, Injector, effect, inject, signal, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { marked } from 'marked';
import { initializeApp, getApp, getApps } from 'firebase/app';
import { deleteToken, getMessaging, getToken } from 'firebase/messaging';
import { firebaseWebConfig, firebaseWebVapidKey } from './firebase.config';
import {
  Meditation,
} from '../shared/meditations';

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
  selector: 'app-root',
  standalone: true,
  template: `
    <div class="app-brand">Meditations</div>
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
  `
})
export class App {
  private static readonly tokenStorageKey = 'fcmToken';

  private readonly injector = inject(Injector);
  private messagingSwRegistration: ServiceWorkerRegistration | null = null;
  private readonly meditationCache = new Map<string, Meditation>();
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

  currentDate = signal<Date>(new Date());
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
    // Parse markdown synchronously for simplicity. Replace newlines appropriately if needed.
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

    if (isPlatformBrowser(this.platformId)) {
      void this.syncSubscriptionState();
    }
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
    return localStorage.getItem(App.tokenStorageKey) || '';
  }

  private setStoredToken(token: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (!token) {
      localStorage.removeItem(App.tokenStorageKey);
      return;
    }
    localStorage.setItem(App.tokenStorageKey, token);
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
  }

  nextDay() {
    this.currentDate.update((date) => {
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      return next;
    });
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
        console.log("FCM Token:", token);

        await this.postWithResource('/api/register', { token });
        this.isSubscribed.set(true);
        this.isWorking.set(false);
        alert("Successfully subscribed to daily meditations!");
      } else {
        this.isSubscribed.set(false);
        alert("Permission denied");
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
