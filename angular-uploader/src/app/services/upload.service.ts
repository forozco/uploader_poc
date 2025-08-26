
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEvent, HttpEventType } from '@angular/common/http';
import { BehaviorSubject, Observable, from, of } from 'rxjs';
import { catchError, concatMap, filter, map, mergeMap, toArray, finalize } from 'rxjs/operators';

/**
 * Respuesta del endpoint de inicialización de subida
 */
export interface InitResponse {
  uploadId: string;                    // ID único para esta sesión de subida
  recommendedChunkSize: number;        // Tamaño de chunk recomendado por el servidor
  uploadedChunks?: number[];          // Chunks ya subidos previamente (para reanudar)
}

/**
 * Información de progreso de subida en tiempo real
 */
export interface UploadProgress {
  totalBytes: number;                 // Tamaño total del archivo
  sentBytes: number;                  // Bytes ya enviados
  percent: number;                    // Porcentaje completado (0-100)
  currentSpeedBps?: number;          // Velocidad actual en bytes por segundo
  etaSeconds?: number;               // Tiempo estimado restante en segundos
}

/**
 * Configuración simple para la POC
 */
const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024, // 10GB
  PAUSE_CHECK_INTERVAL: 300, // ms
  BASE_RETRY_DELAY: 1000, // ms
  LARGE_FILE_EXTRA_DELAY: 2000 // ms para archivos con >100 chunks
} as const;

@Injectable({ providedIn: 'root' })
export class UploadService {
  private http = inject(HttpClient);

  // Observables reactivos para comunicar estado a los componentes
  progress$ = new BehaviorSubject<UploadProgress>({ totalBytes: 0, sentBytes: 0, percent: 0 });
  isPaused$  = new BehaviorSubject<boolean>(false);    // Estado de pausa
  isUploading$ = new BehaviorSubject<boolean>(false);  // Estado de subida activa

  /**
   * Calcula la configuración óptima de subida basada en el tamaño del archivo
   *
   * Estrategia adaptativa:
   * - Archivos pequeños: chunks pequeños, alta concurrencia (más velocidad)
   * - Archivos grandes: chunks grandes, baja concurrencia (más estabilidad)
   *
   * @param fileSize - Tamaño del archivo en bytes
   * @returns Configuración con chunkSize, concurrency y retries optimizados
   */
  private getOptimalConfig(fileSize: number) {
    const MB = 1024 * 1024;
    const GB = 1024 * MB;

    if (fileSize <= 50 * MB) {
      // Archivos pequeños (PDFs, documentos, imágenes)
      return {
        chunkSize: 5 * MB,
        concurrency: 6,
        retries: 3
      };
    } else if (fileSize <= 500 * MB) {
      // Archivos medianos (videos cortos, archivos medianos)
      return {
        chunkSize: 10 * MB,
        concurrency: 4,
        retries: 3
      };
    } else if (fileSize <= 2 * GB) {
      // Archivos grandes (videos largos, archivos pesados)
      return {
        chunkSize: 25 * MB,
        concurrency: 3,
        retries: 4
      };
    } else if (fileSize <= 10 * GB) {
      // Archivos muy grandes (videos 4K, archivos muy pesados)
      return {
        chunkSize: 50 * MB,
        concurrency: 2,
        retries: 5
      };
    } else {
      // Archivos extremadamente grandes (>10GB)
      return {
        chunkSize: 100 * MB,
        concurrency: 1,
        retries: 5
      };
    }
  }

  /**
   * Inicializa una nueva sesión de subida en el servidor
   *
   * Este endpoint del servidor:
   * 1. Crea un uploadId único para la sesión
   * 2. Verifica si hay chunks ya subidos (para reanudar)
   * 3. Puede recomendar un tamaño de chunk específico
   *
   * @param file - Archivo a subir
   * @returns Observable con la respuesta de inicialización
   */
  initUpload(file: File) {
    return this.http.post<InitResponse>('/api/uploads/init', {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
    });
  }

  /**
   * Pausa la subida actual
   *
   * Establece el flag de pausa que será detectado por los chunks
   * que estén pendientes de subir
   */
  pause() {
    this.isPaused$.next(true);
  }

  /**
   * Reanuda la subida pausada
   *
   * Quita el flag de pausa permitiendo que continúen los chunks pendientes
   */
  resume() {
    this.isPaused$.next(false);
  }

  /**
   * Cancela completamente la subida
   *
   * Pausa la subida y resetea todo el estado a valores iniciales
   */
  cancel() {
    this.pause();
    this.isUploading$.next(false);
    this.progress$.next({ totalBytes: 0, sentBytes: 0, percent: 0 });
  }

  /**
   * Método principal para subir archivos usando estrategia multipart
   *
   * Pipeline reactivo que:
   * 1. Divide el archivo en chunks optimizados
   * 2. Filtra chunks ya subidos (para reanudar subidas)
   * 3. Procesa chunks en paralelo con concurrencia controlada
   * 4. Actualiza progreso en tiempo real con velocidad y ETA
   * 5. Ensambla el archivo final en el servidor
   *
   * @param file - Archivo a subir
   * @param init - Respuesta de inicialización con uploadId y chunks previos
   * @returns Observable que completa cuando el archivo está totalmente subido
   */
  uploadFileMultipart(file: File, init: InitResponse): Observable<void> {
    // Obtener configuración óptima basada en el tamaño del archivo
    const config = this.getOptimalConfig(file.size);
    const chunkSize = init.recommendedChunkSize || config.chunkSize;
    const totalChunks = Math.ceil(file.size / chunkSize);
    const uploadedSet = new Set(init.uploadedChunks || []);
    const chunks: number[] = [];

    // Crear lista de chunks pendientes (excluir los ya subidos)
    for (let i = 0; i < totalChunks; i++) {
      if (!uploadedSet.has(i)) chunks.push(i);
    }

    // Inicializar métricas de progreso
    const startTime = Date.now();
    const totalBytes = file.size;
    let sentBytes = (uploadedSet.size * chunkSize);

    console.log(`Archivo: ${file.name}`);
    console.log(`Tamaño: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Configuración: Chunks de ${(chunkSize / (1024 * 1024)).toFixed(2)} MB, Concurrencia: ${config.concurrency}`);
    console.log(`Chunks pendientes: ${chunks.length}/${totalChunks} (${uploadedSet.size} ya subidos)`);

    if (chunks.length === 0) {
      console.log(`Archivo ya completamente subido`);
      this.progress$.next({ totalBytes, sentBytes: totalBytes, percent: 100 });
      return of(void 0);
    }

    // Iniciar el proceso de subida
    this.isUploading$.next(true);
    this.progress$.next({ totalBytes, sentBytes, percent: Math.min(99, Math.floor((sentBytes / totalBytes) * 100)) });

    // Pipeline reactivo principal
    return from(chunks).pipe(
      // Procesar chunks en paralelo con concurrencia controlada
      mergeMap((idx) => this.uploadSingleChunk(file, init.uploadId, idx, chunkSize, totalChunks, config.retries).pipe(
        map((bytesSent) => {
          sentBytes += bytesSent;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? sentBytes / elapsed : undefined;
          const remaining = totalBytes - sentBytes;
          const eta = speed ? remaining / speed : undefined;

          // Actualizar progreso en tiempo real
          this.progress$.next({
            totalBytes,
            sentBytes,
            percent: Math.min(99, Math.floor((sentBytes / totalBytes) * 100)),
            currentSpeedBps: speed,
            etaSeconds: eta,
          });
          return bytesSent;
        })
      ), config.concurrency),
      toArray(), // Esperar a que todos los chunks terminen
      concatMap(() => this.complete(init.uploadId, totalChunks, file.name, file.type)), // Ensamblar archivo final
      finalize(() => {
        // Cleanup: resetear estado cuando termine (éxito o error)
        this.isUploading$.next(false);
        this.progress$.next({ totalBytes, sentBytes: totalBytes, percent: 100 });
      }),
      map(() => void 0)
    );
  }

  /**
   * Versión mejorada para múltiples archivos con progreso individualizado
   * No interfiere con el progress$ global, sino que usa un callback individual
   *
   * @param file - Archivo a subir
   * @param init - Respuesta de inicialización con uploadId y chunks previos
   * @param progressCallback - Función que se llama con el progreso de ESTE archivo específico
   * @param assemblingCallback - Función que se llama cuando comienza el proceso de ensamblado
   * @returns Observable que completa cuando el archivo está totalmente subido
   */
  uploadFileMultipartWithProgress(
    file: File,
    init: InitResponse,
    progressCallback: (progress: UploadProgress) => void,
    assemblingCallback?: () => void
  ): Observable<void> {
    // Obtener configuración óptima basada en el tamaño del archivo
    const config = this.getOptimalConfig(file.size);
    const chunkSize = init.recommendedChunkSize || config.chunkSize;
    const totalChunks = Math.ceil(file.size / chunkSize);
    const uploadedSet = new Set(init.uploadedChunks || []);
    const chunks: number[] = [];

    // Crear lista de chunks pendientes (excluir los ya subidos)
    for (let i = 0; i < totalChunks; i++) {
      if (!uploadedSet.has(i)) chunks.push(i);
    }

    // Inicializar métricas de progreso individuales para este archivo
    const startTime = Date.now();
    const totalBytes = file.size;
    let sentBytes = (uploadedSet.size * chunkSize);

    console.log(`Archivo individual: ${file.name}`);
    console.log(`Tamaño: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Configuración: Chunks de ${(chunkSize / (1024 * 1024)).toFixed(2)} MB, Concurrencia: ${config.concurrency}`);
    console.log(`Chunks pendientes: ${chunks.length}/${totalChunks} (${uploadedSet.size} ya subidos)`);

    if (uploadedSet.size === totalChunks) {
      console.log(`Archivo ya completamente subido`);
      progressCallback({ totalBytes, sentBytes: totalBytes, percent: 100 });
      return of(void 0);
    }

    // Notificar progreso inicial
    progressCallback({ totalBytes, sentBytes, percent: Math.min(99, Math.floor((sentBytes / totalBytes) * 100)) });

    // Pipeline reactivo principal con progreso individualizado
    return from(chunks).pipe(
      // Procesar chunks en paralelo con concurrencia controlada
      mergeMap((idx) => this.uploadSingleChunk(file, init.uploadId, idx, chunkSize, totalChunks, config.retries).pipe(
        map((bytesSent) => {
          sentBytes += bytesSent;
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? sentBytes / elapsed : undefined;
          const remaining = totalBytes - sentBytes;
          const eta = speed ? remaining / speed : undefined;

          // Llamar callback de progreso individual (NO actualizar progress$ global)
          progressCallback({
            totalBytes,
            sentBytes,
            percent: Math.min(99, Math.floor((sentBytes / totalBytes) * 100)),
            currentSpeedBps: speed,
            etaSeconds: eta,
          });
          return bytesSent;
        })
      ), config.concurrency),
      toArray(), // Esperar a que todos los chunks terminen
      concatMap(() => {
        // Notificar que comienza el ensamblado
        console.log(`Ensamblando archivo: ${file.name}`);
        if (assemblingCallback) {
          assemblingCallback();
        }
        return this.complete(init.uploadId, totalChunks, file.name, file.type);
      }), // Ensamblar archivo final
      finalize(() => {
        // Notificar progreso final de este archivo específico
        progressCallback({ totalBytes, sentBytes: totalBytes, percent: 100 });
      }),
      map(() => void 0)
    );
  }

  /**
   * Sube un chunk individual del archivo
   *
   * Funcionalidades:
   * 1. Detecta si la subida está pausada y espera hasta reanudar
   * 2. Extrae la porción correcta del archivo (slice)
   * 3. Crea FormData con metadatos del chunk
   * 4. Maneja errores y ejecuta reintentos automáticos
   *
   * @param file - Archivo original
   * @param uploadId - ID único de la sesión de subida
   * @param chunkIndex - Índice del chunk (0, 1, 2, ...)
   * @param chunkSize - Tamaño de cada chunk en bytes
   * @param totalChunks - Número total de chunks
   * @param maxRetries - Número máximo de reintentos en caso de error
   * @returns Observable con el número de bytes enviados
   */
  private uploadSingleChunk(file: File, uploadId: string, chunkIndex: number, chunkSize: number, totalChunks: number, maxRetries = 3): Observable<number> {
    // Verificar si la subida está pausada
    if (this.isPaused$.value) {
      return new Observable<number>((subscriber) => {
        const check = setInterval(() => {
          if (!this.isPaused$.value) {
            clearInterval(check);
            // Recursión reactiva: volver a intentar cuando se reanude
            this.uploadSingleChunk(file, uploadId, chunkIndex, chunkSize, totalChunks, maxRetries).subscribe(subscriber);
          }
        }, UPLOAD_CONFIG.PAUSE_CHECK_INTERVAL);
      });
    }

    // Extraer la porción del archivo para este chunk
    const start = chunkIndex * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const blob = file.slice(start, end);

    // Preparar FormData con el chunk y metadatos
    const form = new FormData();
    form.append('chunk', new File([blob], `${file.name}.part.${chunkIndex}`));
    form.append('chunkIndex', String(chunkIndex));
    form.append('totalChunks', String(totalChunks));
    form.append('fileName', file.name);
    form.append('fileSize', String(file.size));

    // Enviar chunk al servidor con manejo de errores
    return this.http.post(`/api/uploads/${encodeURIComponent(uploadId)}/chunk`, form).pipe(
      map(() => end - start), // Retornar bytes enviados
      catchError(err => {
        console.error(`Error subiendo chunk ${chunkIndex + 1}/${totalChunks}:`, err);
        return this.retryChunkUpload(uploadId, form, end - start, maxRetries, chunkIndex + 1, totalChunks);
      })
    );
  }

  /**
   * Sistema de reintentos inteligente para chunks fallidos
   *
   * Estrategia de reintentos:
   * 1. Delay progresivo: más tiempo entre reintentos
   * 2. Delay adicional para archivos grandes (más estabilidad)
   * 3. Logging detallado para debugging
   * 4. Recursión reactiva hasta agotar reintentos
   *
   * @param uploadId - ID de la sesión de subida
   * @param form - FormData del chunk a reintentar
   * @param chunkSize - Tamaño del chunk en bytes
   * @param retriesLeft - Reintentos restantes
   * @param chunkNum - Número del chunk (para logging)
   * @param totalChunks - Total de chunks (para calcular delay)
   * @returns Observable con bytes enviados o error si se agotan reintentos
   */
  private retryChunkUpload(uploadId: string, form: FormData, chunkSize: number, retriesLeft: number, chunkNum: number, totalChunks: number): Observable<number> {
    if (retriesLeft <= 0) {
      console.error(`Fallo definitivo en chunk ${chunkNum}/${totalChunks} después de todos los reintentos`);
      throw new Error(`Failed to upload chunk ${chunkNum} after all retries`);
    }

    console.log(`Reintentando chunk ${chunkNum}/${totalChunks} (${retriesLeft} intentos restantes)`);

    // Delay progresivo: más delay entre reintentos + extra para archivos grandes
    const delay = (5 - retriesLeft) * UPLOAD_CONFIG.BASE_RETRY_DELAY +
                  (totalChunks > 100 ? UPLOAD_CONFIG.LARGE_FILE_EXTRA_DELAY : 0);

    return new Observable<number>((subscriber) => {
      setTimeout(() => {
        this.http.post(`/api/uploads/${encodeURIComponent(uploadId)}/chunk`, form).pipe(
          map(() => chunkSize),
          catchError(err => {
            console.error(`Error en reintento para chunk ${chunkNum}:`, err);
            // Recursión reactiva: intentar de nuevo con menos reintentos
            return this.retryChunkUpload(uploadId, form, chunkSize, retriesLeft - 1, chunkNum, totalChunks);
          })
        ).subscribe(subscriber);
      }, delay);
    });
  }

  /**
   * Finaliza la subida y ensambla el archivo en el servidor
   *
   * Cuando todos los chunks han sido subidos exitosamente:
   * 1. Notifica al servidor que puede ensamblar las partes
   * 2. El servidor verifica integridad y crea el archivo final
   * 3. Limpia los chunks temporales del servidor
   *
   * @param uploadId - ID único de la sesión de subida
   * @param totalChunks - Número total de chunks para validación
   * @param fileName - Nombre del archivo final
   * @param mimeType - Tipo MIME del archivo
   * @returns Observable que completa cuando el archivo está ensamblado
   */
  private complete(uploadId: string, totalChunks: number, fileName: string, mimeType: string) {
    return this.http.post(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, {
      totalChunks, fileName, mimeType
    });
  }
}
