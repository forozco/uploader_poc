import { Component, signal, inject, OnDestroy, computed, effect } from '@angular/core';
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
  assembling: boolean;  // Nuevo estado: ensamblando archivo final
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

  // Computed signals para estadísticas globales (Angular 20)
  totalFiles = computed(() => this.files().length);
  completedFiles = computed(() => this.files().filter(f => f.done).length);
  uploadingFiles = computed(() => this.files().filter(f => f.uploading).length);
  assemblingFiles = computed(() => this.files().filter(f => f.assembling).length);
  globalProgress = computed(() => {
    const files = this.files();
    if (files.length === 0) return 0;
    const totalProgress = files.reduce((sum, f) => sum + f.percent, 0);
    return Math.round(totalProgress / files.length);
  });

  constructor() {
    // Angular 20: Effect para lógica reactiva automática
    effect(() => {
      const uploadingCount = this.uploadingFiles();
      console.log(`Archivos subiendo: ${uploadingCount}`);
      
      // Auto-actualizar el estado global basado en archivos activos
      this.globalUploading.set(uploadingCount > 0);
    });
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
      assembling: false,
      paused: false,
      done: false,
      error: null
    }));

    this.files.set([...currentFiles, ...filesToAdd]);
  }

  /**
   * Verifica si se puede iniciar alguna subida
   *
   * @returns true si hay archivos no completados, no está subiendo globalmente, y no hay archivos ensamblando
   */
  canStart() {
    const files = this.files();
    // No se puede iniciar si algún archivo está ensamblando
    if (files.some(f => f.assembling)) return false;
    return files.length > 0 && !this.globalUploading() && files.some(f => !f.done && !f.uploading);
  }

  /**
   * Verifica si se puede pausar (hay archivos subiendo, pero no ensamblando)
   */
  canPause() {
    const files = this.files();
    // No se puede pausar si algún archivo está ensamblando
    if (files.some(f => f.assembling)) return false;
    return this.uploadingFiles() > 0;
  }

  /**
   * Verifica si se puede reanudar (hay archivos pausados o pendientes, pero no ensamblando)
   */
  canResume() {
    const files = this.files();
    // No se puede reanudar si algún archivo está ensamblando
    if (files.some(f => f.assembling)) return false;
    return files.some(f => f.paused || (!f.done && !f.uploading && f.percent > 0));
  }

  /**
   * Verifica si se puede cancelar (hay archivos con progreso, pero no ensamblando)
   */
  canCancel() {
    const files = this.files();
    // No se puede cancelar si algún archivo está ensamblando (fase final)
    if (files.some(f => f.assembling)) return false;
    return files.some(f => f.uploading || f.paused || f.percent > 0);
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
        return this.uploadSvc.uploadFileMultipartWithProgress(
          fileState.file,
          init,
          (progress: UploadProgress) => {
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
          },
          () => {
            // Callback de ensamblado: cuando comienza el proceso de ensamblado
            console.log(`Ensamblando archivo: ${fileState.fileName}`);
            this.updateFileState(fileIndex, {
              uploading: false,
              assembling: true,
              percent: 100, // Mostrar 100% durante ensamblado
              sentBytes: fileState.totalBytes
            });
          }
        );
      })
    ).subscribe({
      error: (err) => {
        this.updateFileState(fileIndex, {
          uploading: false,
          assembling: false,
          error: err?.message || 'Fallo subiendo'
        });
        this.checkGlobalUploadStatus();
      },
      complete: () => {
        this.updateFileState(fileIndex, {
          uploading: false,
          assembling: false,
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
   * Angular 20: Ya no necesario gracias al effect() que auto-gestiona el estado global
   */
  private checkGlobalUploadStatus() {
    // El effect() en constructor maneja esto automáticamente
    // Mantenemos el método por compatibilidad pero puede ser removido
  }

  /**
   * Pausa todas las subidas en curso
   * ASYNC: Envía señal asíncrona para pausar chunks en progreso
   */
  pause() {
    console.log('Pausando todas las subidas...');
    this.uploadSvc.pause();
    
    // Actualizar estado de archivos que están subiendo
    const files = this.files();
    const updatedFiles = files.map(f =>
      f.uploading ? { ...f, paused: true, uploading: false } : f
    );
    this.files.set(updatedFiles);
    console.log('Subidas pausadas');
  }

  /**
   * Reanuda las subidas pausadas
   * ASYNC: Reactiva el pipeline de chunks pendientes
   */
  resume() {
    console.log('Reanudando subidas...');
    this.uploadSvc.resume();
    
    // Actualizar estado de archivos pausados
    const files = this.files();
    const updatedFiles = files.map(f =>
      f.paused ? { ...f, paused: false, uploading: true } : f
    );
    this.files.set(updatedFiles);
    console.log('Subidas reanudadas');
  }

  /**
   * Cancela todas las subidas y resetea el estado
   * ASYNC: Aborta requests HTTP en curso y limpia observables
   */
  cancel() {
    console.log('Cancelando todas las subidas...');
    
    // Cancelar en el servicio primero
    this.uploadSvc.cancel();
    
    // Resetear estado de todos los archivos completamente
    const files = this.files();
    const updatedFiles = files.map(f => ({
      ...f,
      uploading: false,
      assembling: false,
      paused: false,
      percent: 0,
      sentBytes: 0,
      speedBps: undefined,
      etaSeconds: undefined,
      error: null,
      done: false  // Importante: también resetear el estado de completado
    }));
    this.files.set(updatedFiles);
    
    // Resetear todos los signals relacionados
    this.globalUploading.set(false);
    this.isDragOver.set(false);
    
    console.log('Todas las subidas canceladas y estado reseteado completamente');
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
    
    // Cancelar cualquier subida en curso antes de limpiar
    this.uploadSvc.cancel();
    
    // Limpiar completamente el estado
    this.files.set([]);
    this.globalUploading.set(false);
    this.isDragOver.set(false);
    
    console.log('Todos los archivos limpiados y estado reseteado');
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
      return 'Video';
    }

    // Imágenes
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico'].includes(extension)) {
      return 'Imagen';
    }

    // Documentos PDF
    if (extension === 'pdf') {
      return 'PDF';
    }

    // Documentos de texto
    if (['doc', 'docx', 'txt', 'rtf', 'odt'].includes(extension)) {
      return 'Documento';
    }

    // Hojas de cálculo
    if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) {
      return 'Hoja de Cálculo';
    }

    // Presentaciones
    if (['ppt', 'pptx', 'odp'].includes(extension)) {
      return 'Presentación';
    }

    // Audio
    if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a'].includes(extension)) {
      return 'Audio';
    }

    // Archivos comprimidos
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) {
      return 'Comprimido';
    }

    // Código
    if (['js', 'ts', 'html', 'css', 'py', 'java', 'cpp', 'c', 'php'].includes(extension)) {
      return 'Código';
    }

    // Por defecto
    return 'Archivo';
  }
}
