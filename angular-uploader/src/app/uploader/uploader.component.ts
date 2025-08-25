
import { Component, signal, inject, OnDestroy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { concatMap } from 'rxjs/operators';
import { UploadService } from '../services/upload.service';

@Component({
  selector: 'app-uploader',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './uploader.component.html',
  styleUrl: './uploader.component.css'
})
export class UploaderComponent implements OnDestroy {
  private uploadSvc = inject(UploadService);
  private file: File | null = null;

  // Signals reactivos para el estado de la UI
  fileName = signal<string>('');
  percent = signal<number>(0);
  totalBytes = signal<number>(0);
  sentBytes = signal<number>(0);
  speedBps = signal<number | undefined>(undefined);
  etaSeconds = signal<number | undefined>(undefined);
  uploading = signal<boolean>(false);
  paused = signal<boolean>(false);
  done = signal<boolean>(false);
  error = signal<string | null>(null);
  isDragOver = signal<boolean>(false);

  constructor() {
    // Suscribirse a los cambios de progreso del servicio
    this.uploadSvc.progress$.subscribe(p => {
      this.totalBytes.set(p.totalBytes);
      this.sentBytes.set(p.sentBytes);
      this.percent.set(p.percent);
      this.speedBps.set(p.currentSpeedBps);
      this.etaSeconds.set(p.etaSeconds);
    });
    // Suscribirse al estado de subida
    this.uploadSvc.isUploading$.subscribe(v => this.uploading.set(v));
    this.uploadSvc.isPaused$.subscribe(v => this.paused.set(v));
  }

  ngOnDestroy() {
    // Cleanup: cancelar subida en curso si el componente se destruye
    if (this.uploading()) {
      this.uploadSvc.cancel();
    }
  }

  /**
   * Maneja la selección de archivo desde input file
   * 
   * @param e - Evento del input file
   */
  onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.setFile(file);
    } else {
      this.clearFile(e);
    }
  }

  /**
   * Verifica si se puede iniciar la subida
   * 
   * @returns true si hay archivo seleccionado y no se está subiendo
   */
  canStart() { 
    return !!this.file && !this.uploading(); 
  }

  /**
   * Inicia el proceso de subida
   * 
   * Pipeline reactivo:
   * 1. Inicializa la sesión en el servidor
   * 2. Inicia la subida multipart
   * 3. Maneja errores y completado
   */
  start() {
    if (!this.file) return;
    this.error.set(null);
    this.done.set(false);
    this.uploadSvc.initUpload(this.file).pipe(
      concatMap(init => this.uploadSvc.uploadFileMultipart(this.file!, init))
    ).subscribe({
      error: (err) => this.error.set(err?.message || 'Fallo subiendo'),
      complete: () => this.done.set(true),
    });
  }

  /**
   * Pausa la subida actual
   */
  pause()  { 
    this.uploadSvc.pause();  
  }

  /**
   * Reanuda la subida pausada
   */
  resume() { 
    this.uploadSvc.resume(); 
  }

  /**
   * Cancela la subida y resetea el estado
   */
  cancel() { 
    this.uploadSvc.cancel(); 
    this.done.set(false); 
    this.error.set(null); 
  }

  // Métodos para manejar Drag & Drop

  /**
   * Maneja el evento dragover (cuando se arrastra sobre la zona)
   * 
   * @param event - Evento de drag
   */
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  /**
   * Maneja el evento dragleave (cuando se sale de la zona)
   * 
   * @param event - Evento de drag
   */
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  /**
   * Maneja el evento drop (cuando se suelta el archivo)
   * 
   * @param event - Evento de drop con los archivos
   */
  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      const file = files[0];
      this.setFile(file);
    }
  }

  /**
   * Limpia el archivo seleccionado y resetea el estado
   * 
   * @param event - Evento del botón/acción
   */
  clearFile(event: Event) {
    event.stopPropagation();
    this.file = null;
    this.fileName.set('');
    this.totalBytes.set(0);
    this.percent.set(0);
    this.sentBytes.set(0);
    this.done.set(false);
    this.error.set(null);
  }

  /**
   * Establece un nuevo archivo y resetea el estado previo
   * 
   * @param file - Archivo seleccionado
   */
  private setFile(file: File) {
    // Validación básica
    const maxSize = 10 * 1024 * 1024 * 1024; // 10GB límite para POC
    if (file.size > maxSize) {
      this.error.set(`Archivo muy grande. Máximo: ${this.humanSize(maxSize)}`);
      return;
    }

    if (file.size === 0) {
      this.error.set('El archivo está vacío');
      return;
    }

    this.file = file;
    this.done.set(false);
    this.error.set(null);
    this.fileName.set(file.name);
    this.totalBytes.set(file.size);
    this.percent.set(0);
    this.sentBytes.set(0);
  }

  /**
   * Convierte bytes a formato legible (KB, MB, GB, TB)
   * 
   * @param n - Número de bytes
   * @returns String formateado (ej: "1.5 MB")
   */
  humanSize(n: number | undefined) {
    if (n == null) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let x = n;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return `${x.toFixed(1)} ${units[i]}`;
  }

  /**
   * Obtiene el emoji apropiado según la extensión del archivo
   * 
   * @param fileName - Nombre del archivo con extensión
   * @returns Emoji representativo del tipo de archivo
   */
  getFileIcon(fileName: string): string {
    const extension = fileName.split('.').pop()?.toLowerCase() || '';

    // Videos
    if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', 'm4v'].includes(extension)) {
      return '🎬';
    }

    // Imágenes
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(extension)) {
      return '🖼️';
    }

    // Documentos PDF
    if (extension === 'pdf') {
      return '📕';
    }

    // Documentos de texto
    if (['doc', 'docx', 'txt', 'rtf', 'odt'].includes(extension)) {
      return '📝';
    }

    // Hojas de cálculo
    if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) {
      return '📊';
    }

    // Presentaciones
    if (['ppt', 'pptx', 'odp'].includes(extension)) {
      return '📋';
    }

    // Audio
    if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(extension)) {
      return '🎵';
    }

    // Archivos comprimidos
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) {
      return '🗜️';
    }

    // Código
    if (['js', 'ts', 'html', 'css', 'py', 'java', 'cpp', 'c', 'php'].includes(extension)) {
      return '💻';
    }

    // Por defecto
    return '📄';
  }
}
