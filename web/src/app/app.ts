import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AnalyticsService } from './analytics.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`
})
export class App {
  private readonly analytics = inject(AnalyticsService);

  constructor() {
    this.analytics.init();
  }
}
