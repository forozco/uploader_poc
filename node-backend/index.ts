
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
const TEMP_ROOT = path.join(process.cwd(), 'tmp_uploads');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
fs.mkdirSync(TEMP_ROOT, { recursive: true });

function newUploadId() {
  return crypto.randomBytes(16).toString('hex');
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Inicializa una nueva subida, crea un directorio temporal y devuelve un uploadId
app.post('/api/uploads/init', (req, res) => {
  console.log('Solicitud de inicialización recibida:', req.body);
  try {
    // Extrae información del archivo desde el body
    const { fileName, fileSize, mimeType } = req.body || {};
  console.log('Información del archivo:', { fileName, fileSize, mimeType });

    // Genera un ID único para la subida
    const uploadId = newUploadId();
  console.log('uploadId generado:', uploadId);

    // Crea un directorio temporal para almacenar los chunks
    const dir = path.join(TEMP_ROOT, uploadId);
  console.log('Creando directorio temporal:', dir);
    fs.mkdirSync(dir, { recursive: true });

    // Devuelve el uploadId y el tamaño recomendado de chunk
    const response = {
      uploadId,
      recommendedChunkSize: 10 * 1024 * 1024,
      uploadedChunks: [],
    };
  console.log('Enviando respuesta:', response);
    res.json(response);
  } catch (error) {
    // Manejo de errores
  console.error('Error en /init:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Recibe y almacena un chunk de archivo en el directorio temporal correspondiente
app.post('/api/uploads/:uploadId/chunk', upload.single('chunk'), (req, res) => {
  // Extrae parámetros de la petición
  const { uploadId } = req.params;
  const { chunkIndex } = req.body;
  console.log('Subida de chunk:', { uploadId, chunkIndex, fileSize: req.file?.size });

  // Verifica que se haya recibido un archivo
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo chunk' });

  // Verifica que el directorio temporal exista
  const dir = path.join(TEMP_ROOT, uploadId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'uploadId no encontrado' });

  // Guarda el chunk en el disco con el índice correspondiente
  const idx = Number(chunkIndex);
  const partPath = path.join(dir, `part_${idx}`);
  fs.writeFileSync(partPath, req.file.buffer);
  console.log('Chunk almacenado:', partPath);

  // Responde confirmando el almacenamiento
  return res.json({ ok: true, stored: partPath });
});

// Ensambla los chunks recibidos en un solo archivo final y limpia los temporales
app.post('/api/uploads/:uploadId/complete', (req, res) => {
  console.log('Solicitud de completado:', { uploadId: req.params.uploadId, body: req.body });
  const { uploadId } = req.params;
  const { totalChunks, fileName } = req.body;

  // Verifica que se reciban los parámetros necesarios
  if (!fileName || !totalChunks) {
    console.error('Falta fileName o totalChunks');
    return res.status(400).json({ error: 'Se requieren fileName y totalChunks' });
  }

  // Verifica que el directorio temporal exista
  const dir = path.join(TEMP_ROOT, uploadId);
  if (!fs.existsSync(dir)) {
    console.error('Directorio temporal de subida no encontrado:', dir);
    return res.status(404).json({ error: 'uploadId no encontrado' });
  }

  // Sanitiza el nombre del archivo para evitar problemas de seguridad
  const sanitizedFileName = fileName.replace(/[<>:"/\\|?*\[\]]/g, '_');
  console.log('Nombre de archivo original:', fileName);
  console.log('Nombre de archivo sanitizado:', sanitizedFileName);

  // Define la ruta de salida del archivo final
  const outPath = path.join(UPLOAD_ROOT, sanitizedFileName);
  console.log('Creando archivo final:', outPath);

  try {
  // Verifica que el directorio de uploads existe y tiene permisos
  const stats = fs.statSync(UPLOAD_ROOT);
  console.log('Estado del directorio:', { esDirectorio: stats.isDirectory() });

  // Crea el archivo vacío antes de ensamblar los chunks
  fs.writeFileSync(outPath, '');
  console.log('Archivo vacío creado:', outPath);

    // Lee y concatena cada chunk en orden
    for (let i = 0; i < Number(totalChunks); i++) {
      const partPath = path.join(dir, `part_${i}`);
      if (!fs.existsSync(partPath)) {
        // Si falta algún chunk, responde con error
        console.error('Falta chunk:', i, 'en', partPath);
        return res.status(400).json({ error: `Falta chunk ${i}` });
      }

      console.log('Leyendo chunk:', i);
      const chunkData = fs.readFileSync(partPath);

      // Agrega el chunk al archivo final
      fs.appendFileSync(outPath, chunkData);

      // Log de progreso cada 50 chunks
      if (i % 50 === 0) {
        console.log(`Progreso: ${i}/${totalChunks} chunks (${Math.round(i/totalChunks*100)}%)`);
      }
    }

    console.log('Archivo ensamblado correctamente');

    // Limpia los archivos temporales usados para la subida
    try {
      fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
      fs.rmdirSync(dir);
      console.log('Limpieza completada');
    } catch (cleanupError) {
      console.error('Error en limpieza:', cleanupError);
    }

    // Responde con éxito y detalles del archivo final
    console.log('Archivo finalizado correctamente:', outPath);
    res.json({ ok: true, filePath: outPath, originalFileName: fileName, sanitizedFileName });

  } catch (error) {
    // Manejo de errores durante el ensamblado
    console.error('Error al crear el archivo:', error);
    res.status(500).json({ error: String(error) });
  }
});
app.get('/', (req, res) => {
  res.send('<h2>Servidor de uploads activo. Usa las rutas /api/uploads/*</h2>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Uploader server on http://localhost:${PORT}`));
