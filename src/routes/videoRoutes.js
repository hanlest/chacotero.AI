import express from 'express';
import multer from 'multer';
import { processVideo, processPlaylist, generateThumbnail, processPlaylistForDownload, listVideos, serveOriginalThumbnail, serveGeneratedThumbnail, deleteCall, downloadOriginalThumbnail, blacklistCall, regenerateTitle, updateTitle, listVideosFromSource, checkBlacklist, checkProcessed, downloadVideoAudio, transcribeAudioFile, downloadYouTubeTranscription, processAudioFile, getVideoThumbnailUrl, generateVideo, uploadVideoToYouTube, reuploadThumbnailToYouTube, getYouTubeAuthUrl, saveYouTubeAuthCode, youtubeAuthCallback, generateAudioWaveform, serveAudio, redownloadAudio, normalizeAudio, updateMetadata, getAudioDuration, trimAudio, mergeAudios, updateCallContent, getThumbnailPrompt, uploadThumbnail, getYouTubeChannelInfo, logoutYouTube } from '../controllers/videoController.js';

const router = express.Router();

// Configurar multer para manejar archivos JSON en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Aceptar solo archivos JSON
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      req.fileValidationError = 'Solo se permiten archivos JSON (.json)';
      cb(null, false);
    }
  },
});

// Configurar multer para manejar archivos de imagen
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB máximo para imágenes
  },
  fileFilter: (req, file, cb) => {
    // Aceptar solo imágenes
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      req.fileValidationError = 'Solo se permiten archivos de imagen';
      cb(null, false);
    }
  },
});

/**
 * @swagger
 * /api/video/process:
 *   post:
 *     summary: "Procesa un audio MP3: separa llamadas, recorta audios y limpia temporales"
 *     tags: [Video]
 *     description: |
 *       Este endpoint recibe un archivo de audio MP3 y su transcripción SRT, separa las llamadas,
 *       recorta los audios individuales y genera los archivos finales. Los archivos temporales se eliminan al finalizar.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - audioPath
 *               - transcriptionPath
 *               - videoId
 *             properties:
 *               audioPath:
 *                 type: string
 *                 description: Ruta al archivo de audio MP3
 *                 example: "storage/temp/dQw4w9WgXcQ.mp3"
 *               transcriptionPath:
 *                 type: string
 *                 description: Ruta al archivo de transcripción SRT
 *                 example: "storage/temp/dQw4w9WgXcQ.srt"
 *               videoId:
 *                 type: string
 *                 description: ID del video de YouTube
 *                 example: "dQw4w9WgXcQ"
 *               youtubeUrl:
 *                 type: string
 *                 description: URL completa del video de YouTube (opcional)
 *                 example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *               uploadDate:
 *                 type: string
 *                 description: Fecha de subida del video (formato ISO o YYYY-MM-DD)
 *                 example: "2024-01-15"
 *               thumbnailUrl:
 *                 type: string
 *                 description: URL de la miniatura de YouTube (opcional)
 *                 example: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
 *               saveProcessingPrompt:
 *                 type: boolean
 *                 description: Si es true, guarda el prompt de procesamiento de datos como archivo .txt
 *                 default: false
 *                 example: false
 *               saveImagePrompt:
 *                 type: boolean
 *                 description: Si es true, guarda el prompt de generación de imagen como archivo .txt
 *                 default: false
 *                 example: false
 *               thumbnail:
 *                 type: object
 *                 nullable: true
 *                 description: "Configuración para generar miniatura. Si es null, NO se generará miniatura."
 *                 properties:
 *                   model:
 *                     type: string
 *                     enum: ['gpt-image-1.5']
 *                     default: 'gpt-image-1.5'
 *                   size:
 *                     type: string
 *                     enum: ['1536x1024']
 *                     default: '1536x1024'
 *                   quality:
 *                     type: string
 *                     enum: ['medium']
 *                     default: 'medium'
 *                   saveImagePrompt:
 *                     type: boolean
 *                     default: false
 *           example:
 *             audioPath: "storage/temp/dQw4w9WgXcQ.mp3"
 *             transcriptionPath: "storage/temp/dQw4w9WgXcQ.srt"
 *             videoId: "dQw4w9WgXcQ"
 *             youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *             uploadDate: "2024-01-15"
 *             thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
 *             saveProcessingPrompt: false
 *             saveImagePrompt: false
 *             thumbnail:
 *               model: "gpt-image-1.5"
 *               size: "1536x1024"
 *               quality: "medium"
 *               saveImagePrompt: false
 *     responses:
 *       200:
 *         description: Audio procesado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 videoId:
 *                   type: string
 *                 processed:
 *                   type: boolean
 *                 calls:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: Error en la solicitud (archivos faltantes o inválidos)
 *       500:
 *         description: Error interno del servidor
 */
router.post('/process', processVideo);

/**
 * @swagger
 * /api/video/check-blacklist:
 *   post:
 *     summary: Verifica si un video está en la lista negra
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoId
 *             properties:
 *               videoId:
 *                 type: string
 *                 example: "dQw4w9WgXcQ"
 *           example:
 *             videoId: "dQw4w9WgXcQ"
 *     responses:
 *       200:
 *         description: Verificación completada
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/check-blacklist', checkBlacklist);

/**
 * @swagger
 * /api/video/check-processed:
 *   post:
 *     summary: Verifica si un video ya fue procesado
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoId
 *             properties:
 *               videoId:
 *                 type: string
 *                 example: "dQw4w9WgXcQ"
 *           example:
 *             videoId: "dQw4w9WgXcQ"
 *     responses:
 *       200:
 *         description: Verificación completada
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/check-processed', checkProcessed);

/**
 * @swagger
 * /api/video/download-audio:
 *   post:
 *     summary: Descarga el audio de un video de YouTube
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoUrl
 *             properties:
 *               videoUrl:
 *                 type: string
 *                 example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *           example:
 *             videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *     responses:
 *       200:
 *         description: Audio descargado exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/download-audio', downloadVideoAudio);

/**
 * @swagger
 * /api/video/update-call-content:
 *   post:
 *     tags:
 *       - Video
 *     summary: Actualiza todo el contenido de una llamada
 *     description: Re-descarga el audio, miniatura y actualiza el metadata de una llamada desde YouTube
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *               - youtubeUrl
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Nombre del archivo de la llamada
 *               youtubeUrl:
 *                 type: string
 *                 description: URL del video de YouTube
 *     responses:
 *       200:
 *         description: Contenido actualizado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 fileName:
 *                   type: string
 *                 videoId:
 *                   type: string
 *                 audioPath:
 *                   type: string
 *                 thumbnailPath:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Error en los parámetros de entrada
 *       500:
 *         description: Error al actualizar contenido
 */
router.post('/update-call-content', updateCallContent);

/**
 * @swagger
 * /api/video/transcribe:
 *   post:
 *     summary: Transcribe un archivo de audio
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - audioPath
 *               - transcriptionSource
 *             properties:
 *               audioPath:
 *                 type: string
 *                 example: "storage/temp/dQw4w9WgXcQ.mp3"
 *               transcriptionSource:
 *                 type: string
 *                 enum: ['WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE']
 *                 example: 'WHISPER-OpenAI'
 *               videoId:
 *                 type: string
 *                 example: "dQw4w9WgXcQ"
 *               youtubeUrl:
 *                 type: string
 *                 example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *           example:
 *             audioPath: "storage/temp/dQw4w9WgXcQ.mp3"
 *             transcriptionSource: "WHISPER-OpenAI"
 *             videoId: "dQw4w9WgXcQ"
 *     responses:
 *       200:
 *         description: Transcripción completada exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/transcribe', transcribeAudioFile);

/**
 * @swagger
 * /api/video/download-transcription:
 *   post:
 *     summary: Descarga la transcripción de un video desde YouTube
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoUrl
 *             properties:
 *               videoUrl:
 *                 type: string
 *                 example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *               videoId:
 *                 type: string
 *                 example: "dQw4w9WgXcQ"
 *           example:
 *             videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *     responses:
 *       200:
 *         description: Transcripción descargada exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/download-transcription', downloadYouTubeTranscription);

/**
 * @swagger
 * /api/video/get-thumbnail-url:
 *   post:
 *     summary: Obtiene la URL de la miniatura de un video de YouTube
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoId
 *             properties:
 *               videoId:
 *                 type: string
 *                 description: ID del video de YouTube
 *                 example: "dQw4w9WgXcQ"
 *               videoUrl:
 *                 type: string
 *                 description: URL del video (alternativa a videoId)
 *                 example: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *           example:
 *             videoId: "dQw4w9WgXcQ"
 *     responses:
 *       200:
 *         description: URL de miniatura obtenida exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/get-thumbnail-url', getVideoThumbnailUrl);

/**
 * @swagger
 * /api/video/list-source:
 *   post:
 *     summary: Obtiene la lista de videos de un canal o lista de reproducción de YouTube
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sourceUrl
 *             properties:
 *               sourceUrl:
 *                 type: string
 *                 description: URL del canal o lista de reproducción de YouTube
 *                 example: "https://www.youtube.com/@channel/videos"
 *     responses:
 *       200:
 *         description: Lista de videos obtenida exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 sourceUrl:
 *                   type: string
 *                 totalVideos:
 *                   type: number
 *                 videos:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       url:
 *                         type: string
 *                       title:
 *                         type: string
 *       400:
 *         description: Error en la solicitud (sourceUrl faltante)
 *       500:
 *         description: Error al obtener la lista de videos
 */
router.post('/list-source', listVideosFromSource);

/**
 * @swagger
 * /api/video/process/download:
 *   post:
 *     summary: Procesar un video de YouTube, extrae el audio, la metadata y las miniaturas, y retorna los archivos como ZIP
 *     tags: [Video]
 *     description: |
 *       Este endpoint funciona igual que /api/video/process pero en lugar de guardar los archivos permanentemente,
 *       los comprime en un archivo ZIP y los retorna para descarga. Los archivos se organizan en carpetas con formato
 *       "[idYoutube] - Part1", "[idYoutube] - Part2", etc. Una vez enviado el ZIP, los archivos se eliminan del servidor.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoUrl
 *             properties:
 *               videoUrl:
 *                 type: string
 *                 description: URL del video individual de YouTube
 *                 example: "https://www.youtube.com/watch?v=VIDEO_ID"
 *               transcriptionSource:
 *                 type: string
 *                 description: |
 *                   Fuente de transcripción. Opciones disponibles:
 *                   - **WHISPER-OpenAI**: Usa la API de OpenAI Whisper (requiere OPENAI_API_KEY). Más rápido y preciso, pero tiene costo por minuto de audio.
 *                   - **WHISPER-LOCAL**: Usa Whisper local con @xenova/transformers (gratis, sin API key). Más lento pero no tiene costo. Requiere más recursos del sistema.
 *                   - **YOUTUBE**: Descarga subtítulos directamente de YouTube (gratis y rápido). Solo funciona si el video tiene subtítulos disponibles (automáticos o manuales).
 *                   Por defecto: YOUTUBE
 *                 enum: ['WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE']
 *                 default: 'YOUTUBE'
 *                 example: 'YOUTUBE'
 *               thumbnail:
 *                 type: object
 *                 nullable: true
 *                 description: "Configuración para generar miniatura con DALL-E. Si este campo no viene o es null, NO se generará miniatura y se usará la original de YouTube. Si viene (incluso como objeto vacío), se generará una imagen basada en el resumen del audio."
 *                 properties:
 *                   model:
 *                     type: string
 *                     description: "Modelo de generación de imágenes a usar. Valores: 'gpt-image-1.5' (único modelo disponible). Por defecto es 'gpt-image-1.5'."
 *                     enum: ['gpt-image-1.5']
 *                     default: 'gpt-image-1.5'
 *                     example: 'gpt-image-1.5'
 *                   size:
 *                     type: string
 *                     description: "Tamaño de la imagen generada. Valores: '1536x1024' (16:9 horizontal, recomendado para YouTube). Por defecto es '1536x1024'."
 *                     enum: ['1536x1024']
 *                     default: '1536x1024'
 *                     example: '1536x1024'
 *                   quality:
 *                     type: string
 *                     description: "Calidad de la imagen generada. Valores: 'medium' (calidad media). Por defecto es 'medium'."
 *                     enum: ['medium']
 *                     default: 'medium'
 *                     example: 'medium'
 *                   saveImagePrompt:
 *                     type: boolean
 *                     description: "Si es true, guarda el prompt de generación de miniatura usado para DALL-E como archivo .txt en la carpeta calls (una vez por cada llamada). El archivo se guarda con el nombre: {fileName}_image_prompt.txt. Por defecto es false."
 *                     default: false
 *                     example: false
 *               downloadOriginalThumbnail:
 *                 type: boolean
 *                 description: "Si es true, descarga la miniatura original de YouTube y la guarda como '_original.jpg'. Si es false, no descarga la miniatura original. Por defecto es true."
 *                 default: true
 *                 example: true
 *               saveProcessingPrompt:
 *                 type: boolean
 *                 description: "Si es true, guarda el prompt de procesamiento de datos usado para la IA como archivo .txt en la carpeta calls (una vez por video). El archivo se guarda con el nombre: {videoId}_processing_prompt.txt. Por defecto es false."
 *                 default: false
 *                 example: false
 *           example:
 *             videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *             transcriptionSource: "YOUTUBE"
 *             thumbnail:
 *               model: "gpt-image-1.5"
 *               size: "1536x1024"
 *               quality: "medium"
 *               saveImagePrompt: false
 *             downloadOriginalThumbnail: true
 *             saveProcessingPrompt: false
 *     responses:
 *       200:
 *         description: Archivo ZIP con los archivos procesados
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/process/download', processPlaylistForDownload);

/**
 * @swagger
 * /api/video/generate-thumbnail:
 *   post:
 *     summary: Genera una miniatura para una llamada basada en sus metadatos
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - metadata
 *             properties:
 *               metadata:
 *                 type: string
 *                 format: binary
 *                 description: "Archivo JSON con los metadatos completos de la llamada. Debe contener al menos 'summary' o 'thumbnailScene'. Si 'thumbnailScene' no existe, se generará automáticamente usando la plantilla scene-generation.txt."
 *               model:
 *                 type: string
 *                 description: "Modelo de generación de imágenes a usar. Actualmente solo está disponible 'gpt-image-1.5'."
 *                 enum: ['gpt-image-1.5']
 *                 default: 'gpt-image-1.5'
 *                 example: 'gpt-image-1.5'
 *               size:
 *                 type: string
 *                 description: "Tamaño de la imagen generada. Valores: '1536x1024' (16:9 horizontal). Por defecto es '1536x1024'."
 *                 enum: ['1536x1024']
 *                 default: '1536x1024'
 *                 example: '1536x1024'
 *               quality:
 *                 type: string
 *                 description: "Calidad de la imagen generada. Valores: 'medium' (calidad media). Por defecto es 'medium'."
 *                 enum: ['medium']
 *                 default: 'medium'
 *                 example: 'medium'
 *               saveImagePrompt:
 *                 type: boolean
 *                 description: "Si es true, guarda el prompt de generación de miniatura usado para DALL-E como archivo .txt en la carpeta calls. Por defecto es false."
 *                 default: false
 *                 example: false
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - metadata
 *             properties:
 *               metadata:
 *                 type: object
 *                 description: "JSON completo de metadata de la llamada. Debe contener al menos 'summary' o 'thumbnailScene'. Si 'thumbnailScene' no existe, se generará automáticamente usando la plantilla scene-generation.txt."
 *               model:
 *                 type: string
 *                 description: "Modelo de generación de imágenes a usar. Actualmente solo está disponible 'gpt-image-1.5'."
 *                 enum: ['gpt-image-1.5']
 *                 default: 'gpt-image-1.5'
 *                 example: 'gpt-image-1.5'
 *               size:
 *                 type: string
 *                 description: "Tamaño de la imagen generada. Valores: '1536x1024' (16:9 horizontal). Por defecto es '1536x1024'."
 *                 enum: ['1536x1024']
 *                 default: '1536x1024'
 *                 example: '1536x1024'
 *               quality:
 *                 type: string
 *                 description: "Calidad de la imagen generada. Valores: 'medium' (calidad media). Por defecto es 'medium'."
 *                 enum: ['medium']
 *                 default: 'medium'
 *                 example: 'medium'
 *               saveImagePrompt:
 *                 type: boolean
 *                 description: "Si es true, guarda el prompt de generación de miniatura usado para DALL-E como archivo .txt en la carpeta calls. Por defecto es false."
 *                 default: false
 *                 example: false
 *           examples:
 *             json:
 *               summary: Ejemplo usando application/json
 *               value:
 *                 metadata:
 *                   callId: "123e4567-e89b-12d3-a456-426614174000"
 *                   callNumber: 1
 *                   fileName: "abc123_call_1"
 *                   title: "El triángulo amoroso de las hermanas"
 *                   topic: "romance"
 *                   summary: "Agustín (17 años) llama al programa para contar su situación sentimental con dos hermanas..."
 *                   youtubeVideoId: "abc123"
 *                 model: 'gpt-image-1.5'
 *                 size: '1536x1024'
 *                 quality: 'medium'
 *                 saveImagePrompt: false
 *     responses:
 *       200:
 *         description: Miniatura generada exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error interno del servidor
 */
router.post('/generate-thumbnail', upload.single('metadata'), generateThumbnail);

/**
 * @swagger
 * /api/video/list:
 *   get:
 *     summary: Lista todos los videos procesados con sus metadatos
 *     tags: [Video]
 *     responses:
 *       200:
 *         description: Lista de videos procesados
 */
router.get('/list', listVideos);

/**
 * @swagger
 * /api/video/thumbnail/original/{baseName}:
 *   get:
 *     summary: Sirve la miniatura original de un video
 *     tags: [Video]
 *     parameters:
 *       - in: path
 *         name: baseName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Imagen de miniatura original
 *       404:
 *         description: Miniatura no encontrada
 */
router.get('/thumbnail/original/:baseName', serveOriginalThumbnail);

/**
 * @swagger
 * /api/video/thumbnail/generated/{baseName}:
 *   get:
 *     summary: Sirve la miniatura generada de un video
 *     tags: [Video]
 *     parameters:
 *       - in: path
 *         name: baseName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Imagen de miniatura generada
 *       404:
 *         description: Miniatura no encontrada
 */
router.get('/thumbnail/generated/:baseName', serveGeneratedThumbnail);

/**
 * @swagger
 * /api/video/thumbnail/original/download/{fileName}:
 *   post:
 *     summary: Descarga o regenera la miniatura original desde YouTube
 *     tags: [Video]
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo base (sin extensión) de la llamada
 *     responses:
 *       200:
 *         description: Miniatura original descargada exitosamente
 *       400:
 *         description: Error en la solicitud
 *       404:
 *         description: No se encontró el metadata o la miniatura
 *       500:
 *         description: Error al descargar miniatura
 */
router.post('/thumbnail/original/download/:fileName', downloadOriginalThumbnail);

/**
 * @swagger
 * /api/video/delete/{fileName}:
 *   delete:
 *     summary: Elimina todos los archivos relacionados con una llamada
 *     tags: [Video]
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo base (sin extensión) de la llamada a eliminar
 *     responses:
 *       200:
 *         description: Archivos eliminados exitosamente
 *       404:
 *         description: No se encontraron archivos para eliminar
 *       500:
 *         description: Error al eliminar archivos
 */
router.delete('/delete/:fileName', deleteCall);

/**
 * @swagger
 * /api/video/blacklist/{fileName}:
 *   post:
 *     summary: Agrega un video a la lista negra y elimina todos sus archivos
 *     tags: [Video]
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo base (sin extensión) de la llamada
 *     responses:
 *       200:
 *         description: Video agregado a la lista negra y archivos eliminados exitosamente
 *       400:
 *         description: Error en la solicitud
 *       500:
 *         description: Error al procesar
 */
router.post('/blacklist/:fileName', blacklistCall);

/**
 * @swagger
 * /api/video/regenerate-title/{fileName}:
 *   post:
 *     summary: Regenera el título de una llamada usando IA y renombra todos los archivos relacionados
 *     tags: [Video]
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo base (sin extensión) de la llamada
 *     responses:
 *       200:
 *         description: Título regenerado y archivos renombrados exitosamente
 *       400:
 *         description: Error en la solicitud (metadata sin summary)
 *       404:
 *         description: No se encontró el metadata
 *       500:
 *         description: Error al generar título o renombrar archivos
 */
router.post('/regenerate-title/:fileName', regenerateTitle);

/**
 * @swagger
 * /api/video/update-title/{fileName}:
 *   put:
 *     summary: Actualiza el título de una llamada manualmente y renombra todos los archivos relacionados
 *     tags: [Video]
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo base (sin extensión) de la llamada
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *             properties:
 *               title:
 *                 type: string
 *                 description: Nuevo título para la llamada
 *                 example: "El triángulo amoroso de las hermanas"
 *     responses:
 *       200:
 *         description: Título actualizado y archivos renombrados exitosamente
 *       400:
 *         description: Error en la solicitud (title vacío o faltante)
 *       404:
 *         description: No se encontró el metadata
 *       500:
 *         description: Error al renombrar archivos o guardar metadata
 */
router.put('/update-title/:fileName', updateTitle);
router.put('/metadata/:fileName', express.text({ type: 'application/json', limit: '10mb' }), updateMetadata);

/**
 * @swagger
 * /api/video/thumbnail-prompt/:fileName:
 *   get:
 *     tags:
 *       - Video
 *     summary: Obtiene el prompt completo de generación de miniatura
 *     description: Devuelve el prompt completo que se usa para generar la miniatura, incluyendo la plantilla y el thumbnailScene
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo de la llamada (sin extensión)
 *     responses:
 *       200:
 *         description: Prompt obtenido exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 prompt:
 *                   type: string
 *                   description: Prompt completo (plantilla + thumbnailScene)
 *                 thumbnailScene:
 *                   type: string
 *                   description: Solo el thumbnailScene (sin la plantilla)
 *       400:
 *         description: Error en los parámetros de entrada
 *       404:
 *         description: No se encontró el archivo de metadata
 *       500:
 *         description: Error al obtener el prompt
 */
router.get('/thumbnail-prompt/:fileName', getThumbnailPrompt);

/**
 * @swagger
 * /api/video/upload-thumbnail:
 *   post:
 *     tags:
 *       - Video
 *     summary: Sube una miniatura desde el PC
 *     description: Permite subir una imagen desde el PC y guardarla como miniatura generada, reemplazando la generada por IA
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *               - thumbnail
 *             properties:
 *               fileName:
 *                 type: string
 *                 description: Nombre del archivo de la llamada (sin extensión)
 *               thumbnail:
 *                 type: string
 *                 format: binary
 *                 description: Archivo de imagen (JPG, PNG, WEBP)
 *     responses:
 *       200:
 *         description: Miniatura subida exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 imagePath:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Error en los parámetros de entrada o archivo inválido
 *       500:
 *         description: Error al subir la miniatura
 */
router.post('/upload-thumbnail', uploadImage.single('thumbnail'), uploadThumbnail);

/**
 * @swagger
 * /api/video/generate:
 *   post:
 *     summary: Genera un video a partir de un audio, una imagen de fondo y opcionalmente visualización de audio
 *     tags: [Video]
 *     description: |
 *       Este endpoint genera un video combinando un archivo de audio con una imagen de fondo.
 *       Opcionalmente puede agregar visualizaciones de audio como barras de frecuencia u ondas de sonido.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - audioPath
 *               - imagePath
 *             properties:
 *               audioPath:
 *                 type: string
 *                 description: Ruta al archivo de audio (MP3, WAV, etc.)
 *                 example: "storage/calls/videoId - 1 - Título.mp3"
 *               imagePath:
 *                 type: string
 *                 description: Ruta a la imagen de fondo (JPG, PNG, etc.)
 *                 example: "storage/calls/videoId - 1 - Título_generated.jpg"
 *               outputPath:
 *                 type: string
 *                 description: Ruta donde guardar el video generado. Si no se proporciona, se genera automáticamente en la carpeta temp.
 *                 example: "storage/temp/videoId_video.mp4"
 *               visualizationType:
 *                 type: string
 *                 enum: ['none', 'bars', 'waves', 'spectrum', 'vectorscope', 'cqt']
 *                 default: 'none'
 *                 description: |
 *                   Tipo de visualización de audio:
 *                   - **none**: Sin visualización, solo imagen de fondo
 *                   - **bars**: Barras de frecuencia de audio
 *                   - **waves**: Ondas de sonido
 *                   - **spectrum**: Espectrograma (frecuencia en el tiempo)
 *                   - **vectorscope**: Vectorscopio estéreo
 *                   - **cqt**: Visualización en escala musical
 *                 example: "bars"
 *               barCount:
 *                 type: number
 *                 default: 64
 *                 description: |
 *                   Cantidad de barras a mostrar (solo para visualizationType='bars').
 *                   Menor valor = menos barras.
 *                   Rango recomendado: 16-128.
 *                 example: 32
 *               barPositionY:
 *                 type: number
 *                 nullable: true
 *                 default: null
 *                 description: |
 *                   Posición Y de las barras en píxeles desde arriba (solo para visualizationType='bars').
 *                   Si es null, se calcula automáticamente con un margen del 10% desde abajo.
 *                 example: null
 *               barOpacity:
 *                 type: number
 *                 default: 0.7
 *                 description: |
 *                   Opacidad de las barras (solo para visualizationType='bars').
 *                   Rango: 0.0 (transparente) a 1.0 (opaco).
 *                 example: 0.7
 *               videoCodec:
 *                 type: string
 *                 default: "libx264"
 *                 description: Códec de video a usar (libx264, libx265, etc.)
 *                 example: "libx264"
 *               audioCodec:
 *                 type: string
 *                 default: "aac"
 *                 description: Códec de audio a use (aac, mp3, etc.)
 *                 example: "aac"
 *               fps:
 *                 type: number
 *                 default: 30
 *                 description: Frames por segundo del video
 *                 example: 30
 *               resolution:
 *                 type: string
 *                 default: "1920x1080"
 *                 description: Resolución del video (ancho x alto)
 *                 example: "1920x1080"
 *               bitrate:
 *                 type: number
 *                 default: 5000
 *                 description: Bitrate del video en kbps
 *                 example: 5000
 *           example:
 *             audioPath: "storage/calls/videoId - 1 - Título.mp3"
 *             imagePath: "storage/calls/videoId - 1 - Título_generated.jpg"
 *             outputPath: "storage/temp/videoId_video.mp4"
 *             visualizationType: "bars"
 *             barCount: 32
 *             barPositionY: null
 *             barOpacity: 0.7
 *             videoCodec: "libx264"
 *             audioCodec: "aac"
 *             fps: 30
 *             resolution: "1920x1080"
 *             bitrate: 5000
 *     responses:
 *       200:
 *         description: Video generado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 videoPath:
 *                   type: string
 *                   description: Ruta del archivo de video generado
 *                 message:
 *                   type: string
 *       400:
 *         description: Error en la solicitud (archivos faltantes o inválidos)
 *       500:
 *         description: Error interno del servidor
 */
router.post('/generate', generateVideo);

/**
 * @swagger
 * /api/video/upload-to-youtube:
 *   post:
 *     tags:
 *       - Video
 *     summary: Sube un video generado a YouTube
 *     description: |
 *       Sube un video generado a YouTube usando la YouTube Data API v3.
 *       Requiere autenticación OAuth 2.0 configurada (ver YOUTUBE_API_SETUP.md).
 *       Si se proporciona metadataPath, actualiza el JSON con información del video subido.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoPath
 *             properties:
 *               videoPath:
 *                 type: string
 *                 description: Ruta del archivo de video a subir
 *                 example: "storage/calls/abc123.mp4"
 *               title:
 *                 type: string
 *                 description: Título del video (opcional, se usa del metadata si no se proporciona)
 *                 example: "Mi Video"
 *               description:
 *                 type: string
 *                 description: Descripción del video (opcional, se usa del metadata si no se proporciona)
 *                 example: "Descripción del video"
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Tags del video (opcional, se usa del metadata si no se proporciona)
 *                 example: ["tag1", "tag2"]
 *               privacyStatus:
 *                 type: string
 *                 enum: ['private', 'unlisted', 'public']
 *                 default: 'public'
 *                 description: Estado de privacidad del video
 *                 example: "private"
 *               thumbnailPath:
 *                 type: string
 *                 description: Ruta de la miniatura a subir (opcional)
 *                 example: "storage/calls/abc123_generated.jpg"
 *               metadataPath:
 *                 type: string
 *                 description: Ruta del archivo JSON de metadata (opcional, se actualiza con información de YouTube si se proporciona)
 *                 example: "storage/calls/abc123.json"
 *           example:
 *             videoPath: "storage/calls/abc123.mp4"
 *             title: "Mi Video"
 *             description: "Descripción del video"
 *             tags: ["tag1", "tag2"]
 *             privacyStatus: "public"
 *             thumbnailPath: "storage/calls/abc123_generated.jpg"
 *             metadataPath: "storage/calls/abc123.json"
 *     responses:
 *       200:
 *         description: Video subido exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 videoId:
 *                   type: string
 *                   description: ID del video en YouTube
 *                 videoUrl:
 *                   type: string
 *                   description: URL del video en YouTube
 *                 title:
 *                   type: string
 *                   description: Título del video subido
 *                 message:
 *                   type: string
 *       400:
 *         description: Error en la solicitud (archivo faltante o inválido)
 *       500:
 *         description: Error interno del servidor o error de autenticación
 */
router.post('/upload-to-youtube', uploadVideoToYouTube);

/**
 * @swagger
 * /api/video/reupload-thumbnail-to-youtube:
 *   post:
 *     tags:
 *       - Video
 *     summary: Resube una miniatura a YouTube para un video existente
 *     description: Resube una miniatura a YouTube para un video que ya fue subido previamente
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - videoId
 *               - thumbnailPath
 *             properties:
 *               videoId:
 *                 type: string
 *                 description: ID del video de YouTube
 *               thumbnailPath:
 *                 type: string
 *                 description: Ruta de la miniatura a subir
 *               metadataPath:
 *                 type: string
 *                 description: Ruta del archivo de metadata (opcional, para obtener la miniatura desde metadata)
 *     responses:
 *       200:
 *         description: Miniatura resubida exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 videoId:
 *                   type: string
 *                 videoUrl:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Error en los parámetros de entrada
 *       500:
 *         description: Error al resubir la miniatura
 */
router.post('/reupload-thumbnail-to-youtube', reuploadThumbnailToYouTube);

/**
 * @swagger
 * /api/video/youtube/auth-url:
 *   get:
 *     tags:
 *       - Video
 *     summary: Obtiene la URL de autenticación de YouTube
 *     description: |
 *       Genera y retorna la URL de autenticación OAuth 2.0 para YouTube.
 *       El usuario debe visitar esta URL, autorizar la aplicación y copiar el código de autorización.
 *     responses:
 *       200:
 *         description: URL de autenticación generada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 authUrl:
 *                   type: string
 *                   description: URL de autenticación OAuth 2.0
 *                 message:
 *                   type: string
 *       500:
 *         description: Error al generar URL de autenticación
 */
router.get('/youtube/auth-url', getYouTubeAuthUrl);

/**
 * @swagger
 * /api/video/youtube/auth-code:
 *   post:
 *     tags:
 *       - Video
 *     summary: Guarda el código de autorización de YouTube
 *     description: |
 *       Guarda el código de autorización obtenido después de visitar la URL de autenticación.
 *       Este código se intercambia por un token de acceso que se guarda automáticamente.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *             properties:
 *               code:
 *                 type: string
 *                 description: Código de autorización obtenido de la URL de autenticación
 *                 example: "4/0AeanS..."
 *           example:
 *             code: "4/0AeanS..."
 *     responses:
 *       200:
 *         description: Código guardado exitosamente
 *       400:
 *         description: Código no proporcionado
 *       500:
 *         description: Error al guardar código de autorización
 */
router.post('/youtube/auth-code', saveYouTubeAuthCode);

/**
 * @swagger
 * /api/video/youtube/callback:
 *   get:
 *     tags:
 *       - Video
 *     summary: Callback de OAuth de YouTube
 *     description: |
 *       Endpoint de callback que recibe el código de autorización de Google OAuth.
 *       Este endpoint es llamado automáticamente por Google después de la autorización.
 *       Guarda el token automáticamente y muestra una página de éxito.
 *     parameters:
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *         description: Código de autorización proporcionado por Google
 *       - in: query
 *         name: error
 *         schema:
 *           type: string
 *         description: Error de autorización (si existe)
 *     responses:
 *       200:
 *         description: Página HTML de éxito o error
 */
router.get('/youtube/callback', youtubeAuthCallback);

/**
 * @swagger
 * /api/video/youtube/channel-info:
 *   get:
 *     summary: "Obtiene información del canal de YouTube autenticado"
 *     tags: [Video]
 *     responses:
 *       200:
 *         description: Información del canal
 *       500:
 *         description: Error al obtener información del canal
 */
router.get('/youtube/channel-info', getYouTubeChannelInfo);

/**
 * @swagger
 * /api/video/youtube/logout:
 *   post:
 *     summary: "Cierra la sesión de YouTube eliminando el token"
 *     tags: [Video]
 *     responses:
 *       200:
 *         description: Sesión cerrada exitosamente
 *       500:
 *         description: Error al cerrar sesión
 */
router.post('/youtube/logout', logoutYouTube);

/**
 * @swagger
 * /api/video/audio/waveform:
 *   get:
 *     summary: "Genera una imagen de waveform del audio en base64"
 *     tags: [Video]
 *     description: |
 *       Genera una imagen de waveform del audio de una llamada y la retorna en formato base64.
 *     parameters:
 *       - in: query
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo de audio (sin extensión)
 *         example: "0q-YeIe39Q8 - 1 - El carrete descontrolado en la cabaña del lago"
 *       - in: query
 *         name: width
 *         required: false
 *         schema:
 *           type: integer
 *           default: 800
 *         description: Ancho de la imagen en píxeles
 *         example: 800
 *     responses:
 *       200:
 *         description: Imagen de waveform generada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 image:
 *                   type: string
 *                   description: Imagen en formato data URL (base64)
 *                   example: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
 *       400:
 *         description: Error en los parámetros
 *       404:
 *         description: Archivo de audio no encontrado
 *       500:
 *         description: Error al generar waveform
 */
router.get('/audio/waveform', generateAudioWaveform);

// IMPORTANTE: Las rutas específicas deben ir ANTES de las rutas con parámetros
// para evitar que Express capture rutas como /audio/duration como /audio/:fileName
router.get('/audio/duration', getAudioDuration);
router.post('/audio/redownload', redownloadAudio);
router.post('/audio/normalize', normalizeAudio);
router.post('/audio/trim', trimAudio);

/**
 * @swagger
 * /api/video/merge:
 *   post:
 *     summary: Combina varios audios en uno solo y genera un nuevo archivo de metadatos
 *     tags: [Video]
 *     description: |
 *       Este endpoint combina múltiples archivos de audio en uno solo y genera un nuevo archivo de metadatos JSON
 *       que combina la información de todos los archivos originales.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileNames
 *             properties:
 *               fileNames:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array de nombres de archivo (sin extensión) a combinar
 *                 minItems: 2
 *                 example: ["videoId - 1 - Título 1", "videoId - 2 - Título 2"]
 *           example:
 *             fileNames: ["videoId - 1 - Título 1", "videoId - 2 - Título 2"]
 *     responses:
 *       200:
 *         description: Audios combinados exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 fileName:
 *                   type: string
 *                   description: Nombre del archivo combinado (sin extensión)
 *                 audioPath:
 *                   type: string
 *                   description: Ruta del archivo de audio combinado
 *                 metadataPath:
 *                   type: string
 *                   description: Ruta del archivo de metadatos JSON combinado
 *       400:
 *         description: Error en la solicitud (menos de 2 archivos o archivos faltantes)
 *       404:
 *         description: Archivo de audio o metadata no encontrado
 *       500:
 *         description: Error interno del servidor
 */
router.post('/merge', mergeAudios);

/**
 * @swagger
 * /api/video/audio/{fileName}:
 *   get:
 *     summary: "Sirve un archivo de audio"
 *     tags: [Video]
 *     description: |
 *       Sirve un archivo de audio desde la carpeta de llamadas.
 *     parameters:
 *       - in: path
 *         name: fileName
 *         required: true
 *         schema:
 *           type: string
 *         description: Nombre del archivo de audio (con extensión, URL encoded)
 *         example: "QrgeFgyEp8U%20-%201%20-%20El%20TENS%20y%20el%20'grado%203'%20en%20la%20sala%20con%20la%20abuelita.mp3"
 *     responses:
 *       200:
 *         description: Archivo de audio servido exitosamente
 *         content:
 *           audio/mpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Archivo de audio no encontrado
 *       500:
 *         description: Error al servir audio
 */
router.get('/audio/:fileName', serveAudio);

export default router;
