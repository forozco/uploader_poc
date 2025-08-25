# Uploader POC (Angular 20 + Node Backend)

Este repositorio contiene una **prueba de concepto (POC)** para subir archivos muy grandes (1–2 GB) en **chunks multipart** de forma asíncrona con Angular 20 y un backend en Node.js/Express.

---

## 📂 Estructura
```
uploader_poc_v2/
├── angular-uploader/   # Frontend en Angular 20
└── node-backend/       # Backend en Node.js/Express con TypeScript
```

---

## ▶️ Instrucciones de uso

### 1) Backend
1. Entrar a la carpeta:
   ```bash
   cd node-backend
   ```
2. Instalar dependencias:
   ```bash
   npm install
   ```
3. Ejecutar:
   ```bash
   npm run start
   ```
   - Se levanta en `http://localhost:3000`
   - Los archivos finales se guardan en `uploads/`

---

### 2) Frontend (Angular 20)
1. En otra terminal:
   ```bash
   cd angular-uploader
   ```
2. Instalar dependencias:
   ```bash
   npm install
   ```
3. Correr el servidor de desarrollo:
   ```bash
   npm start
   ```
   - Abre `http://localhost:4200`
   - El proxy ya envía `/api` hacia el backend

---

## ⚙️ Características
- **Chunked upload** (10 MB por defecto)
- **Multipart** (cada chunk viaja en `FormData`)
- **Asíncrono y concurrente** (4 chunks simultáneos)
- **Pausar / Reanudar / Cancelar**
- **Progreso en tiempo real** con ETA y velocidad
- **Ensamblado en servidor** (los chunks se unen al finalizar)

---

## 🚀 Notas
- Para producción se recomienda usar almacenamiento en la nube (ej. AWS S3 multipart uploads con pre-signed URLs).
- Este ejemplo es educativo, enfocado en la mecánica de chunked uploads.

---

👨‍💻 Autor: Fernando Orozco (POC generado con ayuda de ChatGPT)
