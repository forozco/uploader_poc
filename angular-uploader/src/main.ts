import 'zone.js';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
// Angular 20: Experimental zoneless change detection para mejor performance
// import { provideExperimentalZonelessChangeDetection } from '@angular/core';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    // Opcional para Angular 20: mejor performance con signals
    // provideExperimentalZonelessChangeDetection()
  ]
}).catch(err => console.error(err));
