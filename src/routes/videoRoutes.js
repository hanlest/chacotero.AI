import express from 'express';
import multer from 'multer';
import { processPlaylist, generateThumbnail, processPlaylistForDownload, listVideos, serveOriginalThumbnail, serveGeneratedThumbnail, deleteCall, downloadOriginalThumbnail, blacklistCall, regenerateTitle, updateTitle } from '../controllers/videoController.js';

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

/**
 * @swagger
 * /api/video/process:
 *   post:
 *     summary: Procesa una o más playlists de YouTube y extrae las llamadas de cada video
 *     tags: [Video]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - playlistUrls
 *             properties:
 *               playlistUrls:
 *                 type: array
 *                 description: Array de URLs de playlists de YouTube. Para una sola playlist, usar array con un elemento.
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 example: ["https://www.youtube.com/playlist?list=PLxxxxxx"]
 *               maxConcurrency:
 *                 type: number
 *                 description: Cantidad máxima de videos a procesar simultáneamente. Si no se especifica, usa 3 por defecto.
 *                 minimum: 1
 *                 example: 5
 *               limit:
 *                 type: number
 *                 description: Cantidad máxima de videos a procesar de la playlist. Si hay 100 videos y limit es 10, solo procesará los primeros 10. Si no se especifica, procesa todos los videos.
 *                 minimum: 1
 *                 example: 10
 *               sortOrder:
 *                 type: string
 *                 description: "Orden de procesamiento de los videos. Valores: 'ASC' (ascendente, del primero al último), 'DESC' (descendente, del último al primero). Por defecto es 'ASC'."
 *                 enum: ['ASC', 'DESC']
 *                 default: 'ASC'
 *                 example: 'ASC'
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
 *                 example:
 *                   model: 'gpt-image-1.5'
 *                   size: '1536x1024'
 *                   quality: 'medium'
 *                   saveImagePrompt: false
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
 *               usePlaylistIndex:
 *                 type: boolean
 *                 description: "Si es true, usa un archivo índice (playlist_{ID}_index.json) para verificar rápidamente qué videos ya fueron procesados. Esto es mucho más rápido cuando hay muchos videos procesados. Si es false, verifica leyendo todos los archivos JSON individuales (más lento pero más preciso). Si es false y existe un índice previo para la playlist, se eliminará automáticamente. Por defecto es true."
 *                 default: true
 *                 example: true
 *           examples:
 *             default:
 *               summary: Ejemplo completo con todos los parámetros
 *               description: |
 *                 **Parámetros disponibles:**
 *                 
 *                 - **playlistUrls** (requerido): Array de URLs de playlists de YouTube. Mínimo 1 URL.
 *                 
 *                 - **maxConcurrency** (opcional, por defecto: 3): Número entero mayor a 0. Cantidad máxima de videos a procesar simultáneamente. Valores recomendados: 2-5.
 *                 
 *                 - **limit** (opcional): Número entero mayor a 0. Cantidad máxima de videos a procesar de la playlist. Solo cuenta videos sin procesar. Si hay 100 videos y limit es 10, procesará los primeros 10 videos sin procesar que encuentre. Si no se especifica, procesa todos los videos sin procesar.
 *                 
 *                 - **sortOrder** (opcional, por defecto: 'ASC'): Orden de procesamiento de los videos. Valores posibles:
 *                   - **ASC**: Ascendente, procesa del primer video al último (orden original de la playlist)
 *                   - **DESC**: Descendente, procesa del último video al primero (orden inverso)
 *                 
 *                 - **transcriptionSource** (opcional, por defecto: 'YOUTUBE'): Fuente de transcripción. Valores posibles:
 *                   - **WHISPER-OpenAI**: Usa la API de OpenAI Whisper. Requiere OPENAI_API_KEY configurada. Más rápido y preciso, pero tiene costo por minuto de audio procesado (~$0.006 por minuto).
 *                   - **WHISPER-LOCAL**: Usa Whisper local con @xenova/transformers. Gratis, sin API key. Más lento pero no tiene costo. Requiere más recursos del sistema (CPU/GPU). Ideal para procesamiento offline.
 *                   - **YOUTUBE**: Descarga subtítulos directamente de YouTube. Gratis y muy rápido. Solo funciona si el video tiene subtítulos disponibles (automáticos o manuales). No requiere procesamiento de audio.
 *                 
 *                 - **thumbnail** (opcional, puede ser null): Objeto de configuración para generar miniatura con gpt-image-1.5. Si este campo no viene o es null, NO se generará miniatura y se usará la original de YouTube. Si viene (incluso como objeto vacío), se generará una imagen basada en el resumen del audio.
 *                   - **model** (opcional, por defecto: 'gpt-image-1.5'): Modelo de generación de imágenes a usar. Valores posibles:
 *                     - **gpt-image-1.5**: Modelo de generación de imágenes de OpenAI (único disponible)
 *                   - **size** (opcional, por defecto: '1536x1024'): Tamaño de la imagen generada. Valores posibles:
 *                     - **1536x1024**: Formato 16:9 horizontal (recomendado para miniaturas de YouTube)
 *                   - **quality** (opcional, por defecto: 'medium'): Calidad de la imagen generada. Valores posibles:
 *                     - **medium**: Calidad media
 *                   - **saveImagePrompt** (opcional, por defecto: false): Boolean. Si es true, guarda el prompt de generación de miniatura usado para DALL-E como archivo .txt en la carpeta calls (una vez por cada llamada). El archivo se guarda con el nombre: {fileName}_image_prompt.txt
 *                 
 *                 - **downloadOriginalThumbnail** (opcional, por defecto: true): Boolean. Si es true, descarga la miniatura original de YouTube y la guarda como '_original.jpg'. Si es false, no descarga la miniatura original de YouTube.
 *                 
 *                 
 *                 - **usePlaylistIndex** (opcional, por defecto: true): Boolean. Si es true, usa un archivo índice (playlist_{ID}_index.json) para verificar rápidamente qué videos ya fueron procesados. Esto es mucho más rápido cuando hay muchos videos procesados. Si es false, verifica leyendo todos los archivos JSON individuales (más lento pero más preciso). Si es false y existe un índice previo para la playlist, se eliminará automáticamente.
 *                 
 *                 - **saveProcessingPrompt** (opcional, por defecto: false): Boolean. Si es true, guarda el prompt de procesamiento de datos usado para la IA como archivo .txt en la carpeta calls (una vez por video). El archivo se guarda con el nombre: {videoId}_processing_prompt.txt
 *               value:
 *                 playlistUrls:
 *                   - "https://www.youtube.com/playlist?list=PLxxxxxx"
 *                 maxConcurrency: 3
 *                 limit: 10
 *                 sortOrder: 'ASC'
 *                 transcriptionSource: 'YOUTUBE'
 *                 thumbnail:
 *                   model: 'gpt-image-1.5'
 *                   size: '1536x1024'
 *                   quality: 'medium'
 *                   saveImagePrompt: false
 *                 downloadOriginalThumbnail: true
 *                 usePlaylistIndex: true
 *                 saveProcessingPrompt: false
 *     responses:
 *       200:
 *         description: Playlist(s) procesada(s) exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   description: Respuesta para una sola playlist
 *                   properties:
 *                     playlistUrl:
 *                       type: string
 *                       description: URL de la playlist procesada
 *                     totalVideos:
 *                       type: number
 *                       description: Total de videos en la playlist
 *                     processed:
 *                       type: number
 *                       description: Número de videos procesados exitosamente
 *                     skipped:
 *                       type: number
 *                       description: Número de videos omitidos (ya procesados)
 *                     errors:
 *                       type: number
 *                       description: Número de videos con error
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           videoId:
 *                             type: string
 *                           videoTitle:
 *                             type: string
 *                           processed:
 *                             type: boolean
 *                           calls:
 *                             type: array
 *                             items:
 *                               $ref: '#/components/schemas/Call'
 *                 - type: object
 *                   description: Respuesta para múltiples playlists
 *                   properties:
 *                     totalPlaylists:
 *                       type: number
 *                       description: Total de playlists procesadas
 *                     totalVideos:
 *                       type: number
 *                       description: Total de videos en todas las playlists
 *                     processed:
 *                       type: number
 *                       description: Número total de videos procesados exitosamente
 *                     skipped:
 *                       type: number
 *                       description: Número total de videos omitidos (ya procesados)
 *                     errors:
 *                       type: number
 *                       description: Número total de videos con error
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           playlistUrl:
 *                             type: string
 *                           totalVideos:
 *                             type: number
 *                           processed:
 *                             type: number
 *                           skipped:
 *                             type: number
 *                           errors:
 *                             type: number
 *                           results:
 *                             type: array
 *       400:
 *         description: Error en la solicitud (URL inválida o faltante)
 *       500:
 *         description: Error interno del servidor
 */
router.post('/process', processPlaylist);

/**
 * @swagger
 * /api/video/process/download:
 *   post:
 *     summary: Procesa una o más playlists de YouTube y retorna los archivos generados como un ZIP
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
 *               - playlistUrls
 *             properties:
 *               playlistUrls:
 *                 type: array
 *                 description: Array de URLs de playlists de YouTube
 *                 items:
 *                   type: string
 *               maxConcurrency:
 *                 type: number
 *                 description: Cantidad máxima de videos a procesar simultáneamente
 *               limit:
 *                 type: number
 *                 description: Cantidad máxima de videos a procesar
 *               sortOrder:
 *                 type: string
 *                 enum: ['ASC', 'DESC']
 *                 default: 'ASC'
 *               transcriptionSource:
 *                 type: string
 *                 enum: ['WHISPER-OpenAI', 'WHISPER-LOCAL', 'YOUTUBE']
 *                 default: 'YOUTUBE'
 *               thumbnail:
 *                 type: object
 *                 nullable: true
 *               downloadOriginalThumbnail:
 *                 type: boolean
 *                 default: true
 *               usePlaylistIndex:
 *                 type: boolean
 *                 default: true
 *               saveProcessingPrompt:
 *                 type: boolean
 *                 default: false
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

export default router;
