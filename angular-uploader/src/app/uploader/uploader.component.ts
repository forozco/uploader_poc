
import { Component, signal, inject, OnDestroy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
// RXJS ASYNC: Operadores para programación reactiva asíncrona
import { concatMap } from 'rxjs/operators';  // Secuencia async manteniendo orden
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

  // SIGNALS REACTIVOS: Estado asíncrono que actualiza UI automáticamente
  // Cada signal es un observable que triggea re-render cuando cambia
  fileName = signal<string>('');           // Nombre del archivo actual
  percent = signal<number>(0);             // Progreso de subida (0-100)
  totalBytes = signal<number>(0);          // Tamaño total del archivo
  sentBytes = signal<number>(0);           // Bytes ya enviados
  speedBps = signal<number | undefined>(undefined);    // Velocidad actual (bytes/sec)
  etaSeconds = signal<number | undefined>(undefined);  // Tiempo estimado restante
  uploading = signal<boolean>(false);      // Estado: subiendo
  paused = signal<boolean>(false);         // Estado: pausado
  done = signal<boolean>(false);           // Estado: completado
  error = signal<string | null>(null);     // Mensaje de error
  isDragOver = signal<boolean>(false);     // Estado: arrastrando archivo

  constructor() {
    // ASINCRONÍA REACTIVA: Suscripciones a streams de datos en tiempo real
    // Los observables emiten valores automáticamente cuando cambian los datos
    
    // ASYNC: Stream de progreso - actualizaciones no bloqueantes cada ~100ms
    this.uploadSvc.progress$.subscribe(p => {
      // SIGNALS: Actualizaciones reactivas que triggean re-render automático
      this.totalBytes.set(p.totalBytes);
      this.sentBytes.set(p.sentBytes);
      this.percent.set(p.percent);
      this.speedBps.set(p.currentSpeedBps);
      this.etaSeconds.set(p.etaSeconds);
    });
    
    // ASYNC: Streams de estado - notificaciones automáticas de cambios
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
   * Inicia el proceso de subida ASÍNCRONO
   * 
   * ASINCRONÍA:
   * - Pipeline reactivo RxJS (Observable streams)
   * - Operaciones no bloqueantes en el hilo principal
   * - Manejo de eventos asincrónicos (success/error)
   * - Actualizaciones de UI en tiempo real vía signals
   * 
   * Pipeline reactivo:
   * 1. Inicializa la sesión en el servidor (HTTP async)
   * 2. Inicia la subida multipart (chunks paralelos async)
   * 3. Maneja errores y completado (callbacks async)
   */
  start() {
    if (!this.file) return;
    this.error.set(null);
    this.done.set(false);
    
    // ASYNC: Observable pipeline - operaciones no bloqueantes
    this.uploadSvc.initUpload(this.file).pipe(
      // ASYNC: concatMap mantiene orden secuencial pero procesa async
      concatMap(init => this.uploadSvc.uploadFileMultipart(this.file!, init))
    ).subscribe({
      // ASYNC: Manejo de errores asincrónicos
      error: (err) => this.error.set(err?.message || 'Fallo subiendo'),
      // ASYNC: Callback de completado asíncrono
      complete: () => this.done.set(true),
    });
  }

  /**
   * Pausa la subida actual
   * ASYNC: Envía señal asíncrona para pausar chunks en progreso
   */
  pause()  { 
    this.uploadSvc.pause();  
  }

  /**
   * Reanuda la subida pausada
   * ASYNC: Reactiva el pipeline de chunks pendientes
   */
  resume() { 
    this.uploadSvc.resume(); 
  }

  /**
   * Cancela la subida y resetea el estado
   * ASYNC: Aborta requests HTTP en curso y limpia observables
   */
  cancel() { 
    this.uploadSvc.cancel(); 
    this.done.set(false); 
    this.error.set(null); 
  }

  // MÉTODOS ASÍNCRONOS PARA DRAG & DROP
  // Los eventos DOM son inherentemente asincrónicos (event loop)

  /**
   * Maneja el evento dragover (cuando se arrastra sobre la zona)
   * ASYNC: Event handler no bloqueante del DOM event loop
   * 
   * @param event - Evento de drag
   */
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);  // Signal update → async UI re-render
  }

  /**
   * Maneja el evento dragleave (cuando se sale de la zona)
   * ASYNC: Event handler no bloqueante del DOM event loop
   * 
   * @param event - Evento de drag
   */
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false); // Signal update → async UI re-render
  }

  /**
   * Maneja el evento drop (cuando se suelta el archivo)
   * ASYNC: Event handler con procesamiento asíncrono de archivos
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
      this.setFile(file);  // ASYNC: Procesamiento de archivo sin bloqueo
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
