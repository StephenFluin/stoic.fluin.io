import { Component, PLATFORM_ID, Inject, signal, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked';
import { initializeApp, getApp, getApps } from 'firebase/app';
import { deleteToken, getMessaging, getToken } from 'firebase/messaging';
import { firebaseWebConfig, firebaseWebVapidKey } from './firebase.config';

interface Meditation {
  day_of_year: number;
  theme: string;
  meditation: string;
  description: string;
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
        
        <div class="actions">
          @if (!isSubscribed()) {
            <button class="primary-btn" [disabled]="isWorking()" (click)="subscribe()">Get these daily</button>
          } @else {
            <button class="secondary-btn" [disabled]="isWorking()" (click)="unsubscribe()">Unsubscribe</button>
          }
        </div>
      } @else {
        <div class="loading">
          <p>Loading meditations...</p>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      min-height: 100vh;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 1.5rem;
    }

    .app-brand {
      font-family: 'Inter', -apple-system, sans-serif;
      text-transform: uppercase;
      letter-spacing: 4px;
      font-size: 0.85rem;
      color: var(--text-secondary);
      margin-bottom: 2rem;
      opacity: 0.7;
      text-align: center;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
    }
    .date-display {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--accent-color);
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    button {
      font-size: 1.5rem;
      padding: 0.5rem 1rem;
      border-radius: 12px;
      outline: none;
    }
    button:hover {
      background: var(--glass-border);
    }
    .title {
      font-family: 'Playfair Display', serif;
      font-size: 2.5rem;
      margin-bottom: 1.5rem;
      line-height: 1.2;
    }
    .description {
      font-size: 1.1rem;
      line-height: 1.7;
      color: var(--text-secondary);
      margin-bottom: 3rem;
    }
    /* Provide styles for injected markdown HTML */
    ::ng-deep .description em { color: var(--text-primary); font-style: italic; }
    ::ng-deep .description p { margin-bottom: 1rem; }
    
    .actions {
      display: flex;
      justify-content: center;
    }
    .primary-btn {
      background: var(--accent-color);
      color: #000;
      font-size: 1rem;
      font-weight: 600;
      padding: 1rem 2rem;
      border-radius: 50px;
      text-transform: uppercase;
      letter-spacing: 1px;
      box-shadow: 0 4px 15px rgba(56, 189, 248, 0.4);
    }
    .primary-btn:hover {
      background: var(--accent-hover);
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(56, 189, 248, 0.6);
    }
    .secondary-btn {
      background: transparent;
      color: var(--text-primary);
      font-size: 1rem;
      font-weight: 600;
      padding: 1rem 2rem;
      border-radius: 50px;
      text-transform: uppercase;
      letter-spacing: 1px;
      border: 1px solid var(--glass-border);
    }
    .secondary-btn:hover {
      background: var(--glass-border);
      transform: translateY(-2px);
    }
    .primary-btn:disabled,
    .secondary-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .loading {
      text-align: center;
      padding: 2rem;
    }
  `]
})
export class App {
  private static readonly tokenStorageKey = 'fcmToken';

  meditations = signal<Meditation[]>([]);
  currentDay = signal<number>(this.getInitialDay());
  isSubscribed = signal<boolean>(false);
  isWorking = signal<boolean>(false);
  
  currentDateDisplay = computed(() => {
    const targetDate = new Date(new Date().getFullYear(), 0, this.currentDay());
    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  });
  
  currentMeditation = computed(() => {
    const meds = this.meditations();
    if (meds.length === 0) return null;
    // Attempt to find today's exact meditation. If not found, show arbitrary fallback to prevent blank screen.
    // For a real app, you would probably want to find the nearest previous quote.
    return meds.find(m => m.day_of_year === this.currentDay()) || meds[0];
  });
  
  parsedDescription = computed(() => {
    const med = this.currentMeditation();
    // Parse markdown synchronously for simplicity. Replace newlines appropriately if needed.
    return med ? marked.parse(med.description) : '';
  });

  constructor(private http: HttpClient, @Inject(PLATFORM_ID) private platformId: Object) {
    this.http.get<Meditation[]>('/meditations.json').subscribe({
      next: (data) => {
        this.meditations.set(data);
      },
      error: (err) => {
        console.error('Could not load meditations', err);
      }
    });

    if (isPlatformBrowser(this.platformId)) {
      void this.syncSubscriptionState();
    }
  }

  private getMessagingClient() {
    if (!firebaseWebVapidKey.trim()) {
      throw new Error('Missing FCM VAPID key');
    }

    const app = getApps().length ? getApp() : initializeApp(firebaseWebConfig);
    return getMessaging(app);
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
      const token = await getToken(messaging, { vapidKey: firebaseWebVapidKey });
      this.setStoredToken(token || '');
      this.isSubscribed.set(!!token);
    } catch (e) {
      console.error('Could not determine current FCM subscription state:', e);
      this.isSubscribed.set(!!this.getStoredToken());
    }
  }

  getInitialDay(): number {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0); // Dec 31
    const diff = (now.getTime() - start.getTime()) + ((start.getTimezoneOffset() - now.getTimezoneOffset()) * 60 * 1000);
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
  }

  prevDay() {
    this.currentDay.update(d => (d <= 0 ? 365 : d - 1));
  }

  nextDay() {
    this.currentDay.update(d => (d >= 365 ? 0 : d + 1));
  }

  async subscribe() {
    if (!isPlatformBrowser(this.platformId)) return;
    if (this.isSubscribed() || this.isWorking()) return;

    this.isWorking.set(true);
    try {
      const messaging = this.getMessagingClient();
      
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const token = await getToken(messaging, { vapidKey: firebaseWebVapidKey });
        if (!token) {
          alert('Could not get an FCM token for this browser.');
          return;
        }

        this.setStoredToken(token);
        console.log("FCM Token:", token);
        
        // Post to server
        this.http.post('/api/register', { token }).subscribe({
          next: () => {
            this.isSubscribed.set(true);
            this.isWorking.set(false);
            alert("Successfully subscribed to daily meditations!");
          },
          error: () => {
            this.isSubscribed.set(false);
            this.isWorking.set(false);
            alert("Token generated, but failed to save to server.");
          }
        });
      } else {
        this.isSubscribed.set(false);
        alert("Permission denied");
        this.isWorking.set(false);
      }
    } catch (e) {
      console.error(e);
      alert("FCM config missing or error. See console for details.");
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
        this.http.post('/api/unregister', { token: storedToken }).subscribe({
          next: () => {
            this.setStoredToken('');
            this.isSubscribed.set(false);
            this.isWorking.set(false);
            alert('You are unsubscribed from daily meditations.');
          },
          error: () => {
            this.setStoredToken('');
            this.isSubscribed.set(false);
            this.isWorking.set(false);
            alert('Device unsubscribed, but failed to remove server token.');
          }
        });
        return;
      }

      this.setStoredToken('');
      this.isSubscribed.set(false);
      this.isWorking.set(false);
      alert('You are unsubscribed from daily meditations.');
    } catch (e) {
      console.error(e);
      this.isWorking.set(false);
      alert('Could not unsubscribe. See console for details.');
    }
  }
}
