import express from 'express';
import multer from 'multer';
import { generateImage, modifyImage } from '../controllers/imageController.js';

const router = express.Router();

// Configurar multer para manejar archivos en memoria (sin guardar en disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Aceptar solo imágenes
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      req.fileValidationError = 'Solo se permiten archivos de imagen (PNG, JPEG, JPG, GIF, WEBP)';
      cb(null, false);
    }
  },
});

/**
 * @swagger
 * /api/image/generate:
 *   post:
 *     summary: Genera una imagen directamente desde un prompt usando gpt-image-1.5
 *     tags: [Image]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - prompt
 *             properties:
 *               prompt:
 *                 type: string
 *                 description: Prompt descriptivo para generar la imagen. Debe ser un texto que describa la imagen que se desea generar.
 *                 example: "Un paisaje montañoso al atardecer con colores vibrantes"
 *               model:
 *                 type: string
 *                 description: "Modelo de generación de imágenes a usar. Actualmente solo está disponible 'gpt-image-1.5'."
 *                 enum: ['gpt-image-1.5']
 *                 default: 'gpt-image-1.5'
 *                 example: 'gpt-image-1.5'
 *               size:
 *                 type: string
 *                 description: "Tamaño de la imagen generada. Actualmente solo está disponible '1536x1024' (formato 16:9 horizontal)."
 *                 enum: ['1536x1024']
 *                 default: '1536x1024'
 *                 example: '1536x1024'
 *               quality:
 *                 type: string
 *                 description: "Calidad de la imagen generada. Actualmente solo está disponible 'medium'."
 *                 enum: ['medium']
 *                 default: 'medium'
 *                 example: 'medium'
 *               returnType:
 *                 type: string
 *                 description: |
 *                   Forma de retornar la imagen generada. Opciones disponibles:
 *                   - **file**: Retorna la imagen como archivo binario directamente (Content-Type: image/png o image/jpeg). El navegador descargará el archivo o lo mostrará según su configuración. Esta es la opción por defecto.
 *                   - **base64**: Retorna un objeto JSON con la imagen codificada en base64. Útil para integrar en aplicaciones web o APIs que necesiten la imagen como string.
 *                 enum: ['file', 'base64']
 *                 default: 'file'
 *                 example: 'file'
 *           examples:
 *             default:
 *               summary: Ejemplo completo con todos los parámetros
 *               description: |
 *                 **Parámetros disponibles:**
 *                 
 *                 - **prompt** (requerido): String. Descripción detallada de la imagen que se desea generar. Debe ser un texto descriptivo que explique qué se quiere ver en la imagen. Ejemplos: "Un gato durmiendo en un jardín", "Una ciudad futurista con luces neón", "Un paisaje montañoso al atardecer".
 *                 
 *                 - **model** (opcional, por defecto: 'gpt-image-1.5'): String. Modelo de generación de imágenes a usar. Actualmente solo está disponible 'gpt-image-1.5', que es el modelo de generación de imágenes de OpenAI.
 *                 
 *                 - **size** (opcional, por defecto: '1536x1024'): String. Tamaño de la imagen generada en píxeles. Actualmente solo está disponible '1536x1024', que es un formato 16:9 horizontal (landscape), ideal para miniaturas de YouTube o imágenes panorámicas.
 *                 
 *                 - **quality** (opcional, por defecto: 'medium'): String. Calidad de la imagen generada. Actualmente solo está disponible 'medium', que proporciona un balance entre calidad y tamaño de archivo.
 *                 
 *                 - **returnType** (opcional, por defecto: 'file'): String. Forma de retornar la imagen generada.
 *                   - **file**: Retorna la imagen como archivo binario directamente. El servidor establece los headers HTTP apropiados (Content-Type: image/png o image/jpeg, Content-Disposition: attachment). El navegador descargará el archivo automáticamente o lo mostrará según su configuración. Esta es la opción recomendada para descargas directas.
 *                   - **base64**: Retorna un objeto JSON con la siguiente estructura:
 *                     ```json
 *                     {
 *                       "success": true,
 *                       "format": "png",
 *                       "base64": "data:image/png;base64,iVBORw0KGgo...",
 *                       "model": "gpt-image-1.5",
 *                       "size": "1536x1024",
 *                       "quality": "medium"
 *                     }
 *                     ```
 *                     El campo "base64" contiene la imagen codificada en formato data URI, lista para usar directamente en etiquetas `<img>` HTML o para guardar como archivo. Útil para integraciones en aplicaciones web o APIs.
 *               value:
 *                 prompt: "Un paisaje montañoso al atardecer con colores vibrantes, estilo realista"
 *                 model: 'gpt-image-1.5'
 *                 size: '1536x1024'
 *                 quality: 'medium'
 *                 returnType: 'file'
 *     responses:
 *       200:
 *         description: Imagen generada exitosamente
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *             description: Imagen generada (cuando returnType es 'file')
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *             description: Imagen generada en formato JPEG (cuando returnType es 'file')
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Indica si la generación fue exitosa
 *                 format:
 *                   type: string
 *                   description: Formato de la imagen (png, jpg, jpeg)
 *                 base64:
 *                   type: string
 *                   description: Imagen codificada en base64 con data URI (cuando returnType es 'base64')
 *                 model:
 *                   type: string
 *                   description: Modelo usado para generar la imagen
 *                 size:
 *                   type: string
 *                   description: Tamaño de la imagen generada
 *                 quality:
 *                   type: string
 *                   description: Calidad de la imagen generada
 *             description: Respuesta JSON con la imagen en base64 (cuando returnType es 'base64')
 *       400:
 *         description: Error en la solicitud (prompt faltante o inválido, parámetros inválidos)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Mensaje de error
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Tipo de error
 *                 message:
 *                   type: string
 *                   description: Mensaje de error detallado
 */
router.post('/generate', generateImage);

/**
 * @swagger
 * /api/image/modify:
 *   post:
 *     summary: Modifica/edita una imagen existente usando gpt-image-1.5
 *     tags: [Image]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *               - prompt
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: "Archivo de imagen a modificar. Formatos soportados: PNG, JPEG, JPG, GIF, WEBP. Tamaño máximo: 10MB."
 *               prompt:
 *                 type: string
 *                 description: "Prompt descriptivo para la modificación de la imagen. Debe describir cómo se desea modificar la imagen."
 *                 example: "Generar una variación con el mismo estilo"
 *               model:
 *                 type: string
 *                 description: "Modelo de generación de imágenes a usar. Actualmente solo está disponible 'gpt-image-1.5'."
 *                 enum: ['gpt-image-1.5']
 *                 default: 'gpt-image-1.5'
 *                 example: 'gpt-image-1.5'
 *               mode:
 *                 type: string
 *                 description: "Modo de edición. Actualmente solo está disponible 'variations' que genera variaciones de la imagen manteniendo el estilo."
 *                 enum: ['variations']
 *                 default: 'variations'
 *                 example: 'variations'
 *               size:
 *                 type: string
 *                 description: "Tamaño de la imagen generada. Opciones disponibles: '1536x1024' (16:9 horizontal) o '1024x1024' (cuadrado)."
 *                 enum: ['1536x1024', '1024x1024']
 *                 default: '1536x1024'
 *                 example: '1536x1024'
 *               returnType:
 *                 type: string
 *                 description: "Forma de retornar la imagen modificada. Opciones: 'file' (archivo binario, por defecto) o 'base64' (JSON con imagen codificada)."
 *                 enum: ['file', 'base64']
 *                 default: 'file'
 *                 example: 'file'
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - image
 *               - prompt
 *             properties:
 *               image:
 *                 type: string
 *                 description: "Imagen en formato base64 (puede incluir el prefijo data:image/... o solo el base64). La imagen debe estar codificada en base64."
 *                 example: "iVBORw0KGgoAAAANSUhEUgAA..."
 *               prompt:
 *                 type: string
 *                 description: "Prompt descriptivo para la modificación de la imagen. Debe describir cómo se desea modificar la imagen."
 *                 example: "Generar una variación con el mismo estilo"
 *               model:
 *                 type: string
 *                 description: "Modelo de generación de imágenes a usar. Actualmente solo está disponible 'gpt-image-1.5'."
 *                 enum: ['gpt-image-1.5']
 *                 default: 'gpt-image-1.5'
 *                 example: 'gpt-image-1.5'
 *               mode:
 *                 type: string
 *                 description: "Modo de edición. Actualmente solo está disponible 'variations' que genera variaciones de la imagen manteniendo el estilo."
 *                 enum: ['variations']
 *                 default: 'variations'
 *                 example: 'variations'
 *               size:
 *                 type: string
 *                 description: "Tamaño de la imagen generada. Opciones disponibles: '1536x1024' (16:9 horizontal) o '1024x1024' (cuadrado)."
 *                 enum: ['1536x1024', '1024x1024']
 *                 default: '1536x1024'
 *                 example: '1536x1024'
 *               returnType:
 *                 type: string
 *                 description: "Forma de retornar la imagen modificada. Opciones: 'file' (archivo binario, por defecto) o 'base64' (JSON con imagen codificada)."
 *                 enum: ['file', 'base64']
 *                 default: 'file'
 *                 example: 'file'
 *           examples:
 *             multipart:
 *               summary: Ejemplo usando multipart/form-data (subir archivo)
 *               description: |
 *                 **Uso con archivo (multipart/form-data):**
 *                 
 *                 En Swagger UI, selecciona "multipart/form-data" en el selector de Content-Type. Luego:
 *                 - **image**: Haz clic en "Choose File" y selecciona un archivo de imagen (PNG, JPEG, JPG, GIF, WEBP). Tamaño máximo: 10MB.
 *                 - **prompt**: Escribe el texto descriptivo de cómo modificar la imagen.
 *                 - **model, mode, size, returnType**: Parámetros opcionales como se describen abajo.
 *                 
 *                 **Parámetros disponibles:**
 *                 
 *                 - **image** (requerido): Archivo de imagen o String base64. 
 *                   - **Con multipart/form-data**: Sube un archivo de imagen directamente desde tu computadora. Formatos soportados: PNG, JPEG, JPG, GIF, WEBP. Tamaño máximo: 10MB.
 *                   - **Con application/json**: String en formato base64. Puede venir con el prefijo data URI (data:image/png;base64,...) o solo el base64. El sistema automáticamente detecta y limpia el prefijo si está presente.
 *                 
 *                 - **prompt** (requerido): String. Descripción de cómo se desea modificar la imagen. Debe ser un texto descriptivo que explique qué cambios se quieren aplicar. Ejemplos: "Generar una variación con el mismo estilo", "Añadir más colores vibrantes", "Cambiar el fondo a un paisaje montañoso".
 *                 
 *                 - **model** (opcional, por defecto: 'gpt-image-1.5'): String. Modelo de generación de imágenes a usar. Actualmente solo está disponible 'gpt-image-1.5', que es el modelo de generación de imágenes de OpenAI.
 *                 
 *                 - **mode** (opcional, por defecto: 'variations'): String. Modo de edición de la imagen. Actualmente solo está disponible 'variations', que genera variaciones de la imagen original manteniendo el estilo general pero aplicando los cambios descritos en el prompt.
 *                 
 *                 - **size** (opcional, por defecto: '1536x1024'): String. Tamaño de la imagen modificada en píxeles. Opciones disponibles:
 *                   - **1536x1024**: Formato 16:9 horizontal (landscape), ideal para miniaturas de YouTube o imágenes panorámicas.
 *                   - **1024x1024**: Formato cuadrado 1:1, ideal para redes sociales o imágenes cuadradas.
 *                 
 *                 - **returnType** (opcional, por defecto: 'file'): String. Forma de retornar la imagen modificada.
 *                   - **file**: Retorna la imagen como archivo binario directamente. El servidor establece los headers HTTP apropiados (Content-Type: image/png o image/jpeg, Content-Disposition: attachment). El navegador descargará el archivo automáticamente o lo mostrará según su configuración. Esta es la opción recomendada para descargas directas.
 *                   - **base64**: Retorna un objeto JSON con la siguiente estructura:
 *                     ```json
 *                     {
 *                       "success": true,
 *                       "format": "png",
 *                       "base64": "data:image/png;base64,iVBORw0KGgo...",
 *                       "model": "gpt-image-1.5",
 *                       "mode": "variations",
 *                       "size": "1536x1024"
 *                     }
 *                     ```
 *                     El campo "base64" contiene la imagen codificada en formato data URI, lista para usar directamente en etiquetas `<img>` HTML o para guardar como archivo. Útil para integraciones en aplicaciones web o APIs.
 *             json:
 *               summary: Ejemplo usando application/json (base64)
 *               description: |
 *                 **Uso con base64 (application/json):**
 *                 
 *                 En Swagger UI, selecciona "application/json" en el selector de Content-Type. Luego proporciona la imagen como string base64.
 *               value:
 *                 image: "iVBORw0KGgoAAAANSUhEUgAA..."
 *                 prompt: "Generar una variación con el mismo estilo"
 *                 model: 'gpt-image-1.5'
 *                 mode: 'variations'
 *                 size: '1536x1024'
 *                 returnType: 'file'
 *     responses:
 *       200:
 *         description: Imagen modificada exitosamente
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *             description: Imagen modificada (cuando returnType es 'file')
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *             description: Imagen modificada en formato JPEG (cuando returnType es 'file')
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Indica si la modificación fue exitosa
 *                 format:
 *                   type: string
 *                   description: Formato de la imagen (png, jpg, jpeg)
 *                 base64:
 *                   type: string
 *                   description: Imagen codificada en base64 con data URI (cuando returnType es 'base64')
 *                 model:
 *                   type: string
 *                   description: Modelo usado para modificar la imagen
 *                 mode:
 *                   type: string
 *                   description: Modo de edición usado
 *                 size:
 *                   type: string
 *                   description: Tamaño de la imagen modificada
 *             description: Respuesta JSON con la imagen en base64 (cuando returnType es 'base64')
 *       400:
 *         description: Error en la solicitud (image o prompt faltante o inválido, parámetros inválidos)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Mensaje de error
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Tipo de error
 *                 message:
 *                   type: string
 *                   description: Mensaje de error detallado
 */
router.post('/modify', upload.single('image'), modifyImage);

export default router;
