import { Component, signal, inject, OnDestroy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
// RXJS ASYNC: Operadores para programación reactiva asíncrona
import { concatMap, finalize } from 'rxjs/operators';  // Secuencia async manteniendo orden
import { UploadService, UploadProgress } from '../services/upload.service';

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
   * Inicia la subida de todos los archivos pendientes
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

    // Crear un Observable que combine la subida con el progreso individualizado
    this.uploadSvc.initUpload(fileState.file).pipe(
      concatMap(init => {
        // Usar uploadFileMultipartWithProgress para progreso individualizado
        return this.uploadSvc.uploadFileMultipartWithProgress(fileState.file, init, (progress: UploadProgress) => {
          // Callback de progreso individual para este archivo específico
          const currentFiles = this.files();
          const currentFile = currentFiles[fileIndex];
          if (currentFile && currentFile.uploading && !currentFile.done) {
            this.updateFileState(fileIndex, {
              percent: Math.min(progress.percent, 99), // No llegar a 100% hasta completar
              sentBytes: Math.min(progress.sentBytes, fileState.totalBytes),
              speedBps: progress.currentSpeedBps,
              etaSeconds: progress.etaSeconds
            });
          }
        });
      })
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
          percent: 100,
          sentBytes: fileState.totalBytes
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

  /**
   * Maneja el evento dragover (cuando se arrastra sobre la zona)
   * ASYNC: Event handler no bloqueante del DOM event loop
   */
  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);  // Signal update → async UI re-render
  }

  /**
   * Maneja el evento dragleave (cuando se sale de la zona)
   * ASYNC: Event handler no bloqueante del DOM event loop
   */
  onDragLeave(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false); // Signal update → async UI re-render
  }

  /**
   * Maneja el evento drop (cuando se suelta el archivo)
   * ASYNC: Event handler con procesamiento asíncrono de archivos
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
   */
  clearFile(event: Event) {
    event.stopPropagation();
    this.files.set([]);
    this.globalUploading.set(false);
  }

  /**
   * Remueve un archivo específico de la lista
   */
  removeFile(fileIndex: number, event: Event) {
    event.stopPropagation();
    const files = this.files();
    const updatedFiles = files.filter((_, index) => index !== fileIndex);
    this.files.set(updatedFiles);
  }

  /**
   * Convierte bytes a formato legible (KB, MB, GB, TB)
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
