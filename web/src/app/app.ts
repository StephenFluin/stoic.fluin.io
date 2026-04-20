import { Component, PLATFORM_ID, Inject, signal, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { marked } from 'marked';
import { initializeApp } from 'firebase/app';
import { getMessaging, getToken } from 'firebase/messaging';

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
          <button class="primary-btn" (click)="subscribe()">Get these daily</button>
        </div>
      } @else {
        <div class="loading">
          <p>Loading meditations...</p>
        </div>
      }
    </div>
  `,
  styles: [`
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
    .loading {
      text-align: center;
      padding: 2rem;
    }
  `]
})
export class App {
  meditations = signal<Meditation[]>([]);
  currentDay = signal<number>(this.getInitialDay());
  
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
    try {
      // Firebase placeholder config
      const firebaseConfig = {
        apiKey: "YOUR_API_KEY",
        authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
        projectId: "YOUR_PROJECT_ID",
        storageBucket: "YOUR_PROJECT_ID.appspot.com",
        messagingSenderId: "YOUR_SENDER_ID",
        appId: "YOUR_APP_ID"
      };
      const app = initializeApp(firebaseConfig);
      const messaging = getMessaging(app);
      
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const token = await getToken(messaging, { vapidKey: 'YOUR_VAPID_KEY' });
        console.log("FCM Token:", token);
        
        // Post to server
        this.http.post('/api/register', { token }).subscribe({
          next: () => alert("Successfully subscribed to daily meditations!"),
          error: (err) => alert("Token generated, but Failed to save to server.")
        });
      } else {
        alert("Permission denied");
      }
    } catch (e) {
      console.error(e);
      alert("FCM config missing or error. See console for details.");
    }
  }
}
