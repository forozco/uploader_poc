
import { Component, signal, inject, OnDestroy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
// RXJS ASYNC: Operadores para programación reactiva asíncrona
import { concatMap } from 'rxjs/operators';  // Secuencia async manteniendo orden
import { UploadService } from '../services/upload.service';

// Interface para representar cada archivo con su estado individual
interface FileUploadState {
  file: File;
  fileName: string;
  percent: number;
  totalBytes: number;
  sentBytes: number;
  speedBps?: number;
  etaSeconds?: number;
  uploading: boolean;
  paused: boolean;
  done: boolean;
  error: string | null;
}

@Component({
  selector: 'app-uploader',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './uploader.component.html',
  styleUrl: './uploader.component.css'
})
export class UploaderComponent implements OnDestroy {
  private uploadSvc = inject(UploadService);

  // SIGNALS REACTIVOS para múltiples archivos
  files = signal<FileUploadState[]>([]);   // Lista de archivos con sus estados
  isDragOver = signal<boolean>(false);     // Estado: arrastrando archivo
  globalUploading = signal<boolean>(false); // Estado global: algún archivo subiendo

  // Computed signals para estadísticas globales
  totalFiles = () => this.files().length;
  completedFiles = () => this.files().filter(f => f.done).length;
  uploadingFiles = () => this.files().filter(f => f.uploading).length;
  globalProgress = () => {
    const files = this.files();
    if (files.length === 0) return 0;
    const totalProgress = files.reduce((sum, f) => sum + f.percent, 0);
    return Math.round(totalProgress / files.length);
  };

  constructor() {
    // Para multi-upload, el manejo de progreso se hará por archivo individual
    // Este constructor se simplifica ya que cada archivo tendrá su propio estado
  }

  ngOnDestroy() {
    // Cleanup: cancelar todas las subidas en curso si el componente se destruye
    const uploadingFiles = this.files().filter(f => f.uploading);
    uploadingFiles.forEach(() => this.uploadSvc.cancel());
  }

  /**
   * Maneja la selección de múltiples archivos desde input file
   * 
   * @param e - Evento del input file
   */
  onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const selectedFiles = input.files;
    if (selectedFiles && selectedFiles.length > 0) {
      this.addFiles(Array.from(selectedFiles));
    }
  }

  /**
   * Agrega múltiples archivos a la lista
   * 
   * @param newFiles - Array de archivos a agregar
   */
  addFiles(newFiles: File[]) {
    const currentFiles = this.files();
    const filesToAdd: FileUploadState[] = newFiles.map(file => ({
      file,
      fileName: file.name,
      percent: 0,
      totalBytes: file.size,
      sentBytes: 0,
      speedBps: undefined,
      etaSeconds: undefined,
      uploading: false,
      paused: false,
      done: false,
      error: null
    }));
    
    this.files.set([...currentFiles, ...filesToAdd]);
  }

  /**
   * Verifica si se puede iniciar alguna subida
   * 
   * @returns true si hay archivos no completados y no está subiendo globalmente
   */
  canStart() { 
    const files = this.files();
    return files.length > 0 && !this.globalUploading() && files.some(f => !f.done && !f.uploading);
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
    const files = this.files();
    const pendingFiles = files.filter(f => !f.done && !f.uploading);
    
    if (pendingFiles.length === 0) return;
    
    this.globalUploading.set(true);
    
    // Subir todos los archivos pendientes de manera simultánea
    pendingFiles.forEach((fileState, index) => {
      const actualIndex = files.findIndex(f => f === fileState);
      this.startFileUpload(actualIndex);
    });
  }

  /**
   * Inicia la subida de un archivo específico
   */
  private startFileUpload(fileIndex: number) {
    const files = this.files();
    const fileState = files[fileIndex];
    
    if (!fileState || fileState.uploading || fileState.done) return;
    
    // Actualizar estado: subiendo
    this.updateFileState(fileIndex, { uploading: true, error: null });
    
    // ASYNC: Observable pipeline - operaciones no bloqueantes
    this.uploadSvc.initUpload(fileState.file).pipe(
      concatMap(init => this.uploadSvc.uploadFileMultipart(fileState.file, init))
    ).subscribe({
      error: (err) => {
        this.updateFileState(fileIndex, { 
          uploading: false, 
          error: err?.message || 'Fallo subiendo' 
        });
        this.checkGlobalUploadStatus();
      },
      complete: () => {
        this.updateFileState(fileIndex, { 
          uploading: false, 
          done: true, 
          percent: 100 
        });
        this.checkGlobalUploadStatus();
      },
    });
  }

  /**
   * Actualiza el estado de un archivo específico
   */
  private updateFileState(fileIndex: number, updates: Partial<FileUploadState>) {
    const files = this.files();
    const updatedFiles = [...files];
    updatedFiles[fileIndex] = { ...updatedFiles[fileIndex], ...updates };
    this.files.set(updatedFiles);
  }

  /**
   * Verifica si todas las subidas han terminado
   */
  private checkGlobalUploadStatus() {
    const files = this.files();
    const stillUploading = files.some(f => f.uploading);
    if (!stillUploading) {
      this.globalUploading.set(false);
    }
  }

  /**
   * Pausa todas las subidas en curso
   * ASYNC: Envía señal asíncrona para pausar chunks en progreso
   */
  pause() { 
    this.uploadSvc.pause();
    // Actualizar estado de archivos que están subiendo
    const files = this.files();
    const updatedFiles = files.map(f => 
      f.uploading ? { ...f, paused: true } : f
    );
    this.files.set(updatedFiles);
  }

  /**
   * Reanuda las subidas pausadas
   * ASYNC: Reactiva el pipeline de chunks pendientes
   */
  resume() { 
    this.uploadSvc.resume();
    // Actualizar estado de archivos pausados
    const files = this.files();
    const updatedFiles = files.map(f => 
      f.paused ? { ...f, paused: false } : f
    );
    this.files.set(updatedFiles);
  }

  /**
   * Cancela todas las subidas y resetea el estado
   * ASYNC: Aborta requests HTTP en curso y limpia observables
   */
  cancel() { 
    this.uploadSvc.cancel();
    // Resetear estado de todos los archivos
    const files = this.files();
    const updatedFiles = files.map(f => ({
      ...f,
      uploading: false,
      paused: false,
      percent: 0,
      sentBytes: 0,
      error: null
    }));
    this.files.set(updatedFiles);
    this.globalUploading.set(false);
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
      this.addFiles(Array.from(files));  // ASYNC: Procesamiento de múltiples archivos
    }
  }

  /**
   * Limpia todos los archivos y resetea el estado
   * 
   * @param event - Evento del botón/acción
   */
  clearFile(event: Event) {
    event.stopPropagation();
    this.files.set([]);
    this.globalUploading.set(false);
  }

  /**
   * Remueve un archivo específico de la lista
   * 
   * @param fileIndex - Índice del archivo a remover
   * @param event - Evento del botón
   */
  removeFile(fileIndex: number, event: Event) {
    event.stopPropagation();
    const files = this.files();
    const updatedFiles = files.filter((_, index) => index !== fileIndex);
    this.files.set(updatedFiles);
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
