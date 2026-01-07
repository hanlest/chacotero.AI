# Chacotero.AI - Backend

Backend en Node.js para procesar videos de YouTube, extraer audio, transcribir con Whisper, separar llamadas y generar metadatos con GPT-4.

## Características

- Descarga de audio de videos de YouTube
- Transcripción con Whisper (identificación de speakers)
- Separación automática de múltiples llamadas usando IA
- Generación de metadatos (título, descripción, tema, tags) con GPT-4
- Verificación de videos ya procesados para evitar duplicados
- Documentación API con Swagger

## Instalación

1. Instalar dependencias:
```bash
npm install
```

2. Configurar variables de entorno:
```bash
cp .env.example .env
# Editar .env con tu OPENAI_API_KEY
```

### Configuración de Cookies para YouTube (Opcional)

Para procesar videos con restricción de edad o que requieren autenticación, puedes configurar cookies de YouTube:

**Opción 1: Usar archivo de cookies exportado**
```env
YOUTUBE_COOKIES_PATH=./storage/cookies.txt
```

**Opción 2: Usar cookies del navegador**
```env
YOUTUBE_COOKIES_BROWSER=chrome
# También puedes usar: firefox, edge, safari, opera, brave
```

Para exportar cookies desde tu navegador, puedes usar extensiones como "Get cookies.txt LOCALLY" o seguir la [guía oficial de yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).

3. Iniciar el servidor:
```bash
npm start
```

## API

La documentación completa de la API está disponible en `/api-docs` cuando el servidor está corriendo.

### Endpoint Principal

**POST /api/video/process**

Procesa un video de YouTube y extrae las llamadas.

**Body:**
```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=..."
}
```

## Estructura del Proyecto

```
chacotero.AI/
├── src/
│   ├── controllers/     # Controladores de endpoints
│   ├── services/        # Servicios de negocio
│   ├── routes/          # Definición de rutas
│   ├── config/          # Configuración
│   └── app.js           # Aplicación principal
├── storage/             # Archivos generados
│   ├── audio/           # Audios MP3
│   ├── transcriptions/  # Transcripciones SRT
│   └── metadata/        # Metadatos JSON
└── swagger/             # Configuración Swagger
```
