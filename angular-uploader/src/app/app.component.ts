import { Component } from '@angular/core';
import { UploaderComponent } from './uploader/uploader.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [UploaderComponent],
  template: '<app-uploader></app-uploader>',
})
export class AppComponent {}
