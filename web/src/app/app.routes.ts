import { Routes } from '@angular/router';
import { MeditationComponent } from './meditation.component';

export const routes: Routes = [
	{
		path: '',
		pathMatch: 'full',
		component: MeditationComponent,
	},
	{
		path: 'day/:date',
		pathMatch: 'full',
		component: MeditationComponent,
	},
];
