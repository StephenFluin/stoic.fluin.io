import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Inject, Injectable, PLATFORM_ID } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { firebaseAnalyticsMeasurementId } from './firebase.config';

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private initialized = false;
  private scriptLoaded = false;
  private lastTrackedPath = '';
  private pendingPageViews: string[] = [];

  constructor(
    @Inject(PLATFORM_ID) private readonly platformId: Object,
    @Inject(DOCUMENT) private readonly document: Document,
    private readonly router: Router,
  ) {}

  init(): void {
    if (!isPlatformBrowser(this.platformId) || this.initialized) {
      return;
    }

    if (!firebaseAnalyticsMeasurementId || this.isDoNotTrackEnabled()) {
      return;
    }

    this.initialized = true;

    this.trackPageView(this.router.url || this.document.location.pathname);

    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.trackPageView(event.urlAfterRedirects);
      }
    });

    this.bootstrapWhenNonCritical();
  }

  private bootstrapWhenNonCritical(): void {
    const load = () => this.loadAnalyticsScript();

    const onFirstInteraction = () => {
      cleanupListeners();
      load();
    };

    const cleanupListeners = () => {
      this.document.removeEventListener('pointerdown', onFirstInteraction);
      this.document.removeEventListener('keydown', onFirstInteraction);
      this.document.removeEventListener('touchstart', onFirstInteraction);
      this.document.removeEventListener('scroll', onFirstInteraction);
    };

    this.document.addEventListener('pointerdown', onFirstInteraction, { once: true, passive: true });
    this.document.addEventListener('keydown', onFirstInteraction, { once: true, passive: true });
    this.document.addEventListener('touchstart', onFirstInteraction, { once: true, passive: true });
    this.document.addEventListener('scroll', onFirstInteraction, { once: true, passive: true });

    if (window.requestIdleCallback) {
      window.requestIdleCallback(load, { timeout: 4000 });
      return;
    }

    setTimeout(load, 2000);
  }

  private loadAnalyticsScript(): void {
    if (this.scriptLoaded) {
      return;
    }

    this.scriptLoaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = (...args: unknown[]) => {
      window.dataLayer.push(args);
    };

    window.gtag('js', new Date());
    window.gtag('config', firebaseAnalyticsMeasurementId, {
      send_page_view: false,
      transport_type: 'beacon',
    });

    const script = this.document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(firebaseAnalyticsMeasurementId)}`;
    this.document.head.appendChild(script);

    for (const path of this.pendingPageViews) {
      this.sendPageView(path);
    }
    this.pendingPageViews = [];
  }

  private trackPageView(path: string): void {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;

    if (normalizedPath === this.lastTrackedPath) {
      return;
    }
    this.lastTrackedPath = normalizedPath;

    if (!this.scriptLoaded) {
      this.pendingPageViews.push(normalizedPath);
      return;
    }

    this.sendPageView(normalizedPath);
  }

  private sendPageView(path: string): void {
    if (!window.gtag) {
      return;
    }

    const pageLocation = new URL(path, this.document.location.origin).href;
    window.gtag('event', 'page_view', {
      page_path: path,
      page_location: pageLocation,
      page_title: this.document.title,
    });
  }

  private isDoNotTrackEnabled(): boolean {
    const browserDnt = (globalThis as { doNotTrack?: string }).doNotTrack;

    return (
      navigator.doNotTrack === '1' ||
      (browserDnt ?? '') === '1'
    );
  }
}
