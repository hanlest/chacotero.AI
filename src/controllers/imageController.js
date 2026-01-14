import { generateImageFromPrompt, editImageFromBase64 } from '../services/imageGenerationService.js';
import { logError } from '../services/loggerService.js';

/**
 * Genera una imagen directamente desde un prompt
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function generateImage(req, res) {
  try {
    const { prompt, model, size, quality, returnType } = req.body;

    // Validar prompt (requerido)
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        error: 'El parámetro "prompt" es requerido y debe ser un string no vacío',
      });
    }

    // Validar y parsear parámetros de imagen
    const validModels = ['gpt-image-1.5'];
    const finalModel = model && validModels.includes(model) ? model : 'gpt-image-1.5';
    
    const validSizes = ['1536x1024'];
    const finalSize = size && validSizes.includes(size) ? size : '1536x1024';
    
    const validQualities = ['medium'];
    const finalQuality = quality && validQualities.includes(quality) ? quality : 'medium';

    // Validar returnType (por defecto 'file')
    const validReturnTypes = ['file', 'base64'];
    const finalReturnType = returnType && validReturnTypes.includes(returnType) ? returnType : 'file';

    // Configuración de imagen
    const imageConfig = {
      model: finalModel,
      size: finalSize,
      quality: finalQuality,
    };

    // Generar imagen
    const imageResult = await generateImageFromPrompt(prompt.trim(), imageConfig);

    // Retornar según el tipo solicitado
    if (finalReturnType === 'base64') {
      // Retornar como JSON con base64
      return res.json({
        success: true,
        format: imageResult.format,
        base64: `data:image/${imageResult.format};base64,${imageResult.base64}`,
        model: finalModel,
        size: finalSize,
        quality: finalQuality,
      });
    } else {
      // Retornar como archivo
      const contentType = imageResult.format === 'png' ? 'image/png' : 
                          imageResult.format === 'jpg' || imageResult.format === 'jpeg' ? 'image/jpeg' : 
                          'image/png';
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="generated-image.${imageResult.format}"`);
      return res.send(imageResult.buffer);
    }
  } catch (error) {
    await logError(`Error al generar imagen: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al generar imagen',
      message: error.message,
    });
  }
}

/**
 * Modifica/edita una imagen existente
 * @param {object} req - Request object
 * @param {object} res - Response object
 */
export async function modifyImage(req, res) {
  try {
    // Manejar errores de multer (archivo muy grande, tipo no permitido, etc.)
    if (req.fileValidationError) {
      return res.status(400).json({
        error: req.fileValidationError,
      });
    }

    // Obtener imagen desde archivo subido o desde body (base64)
    let imageBase64 = null;
    
    // Si hay un archivo subido (multipart/form-data)
    if (req.file) {
      // Convertir el buffer del archivo a base64
      imageBase64 = req.file.buffer.toString('base64');
    } else if (req.body.image) {
      // Si viene como base64 en el body (application/json)
      imageBase64 = req.body.image;
    } else {
      return res.status(400).json({
        error: 'El parámetro "image" es requerido. Puede ser un archivo (multipart/form-data) o un string base64 (application/json)',
      });
    }

    const { prompt, model, mode, size, returnType } = req.body;

    // Validar que imageBase64 no esté vacío
    if (!imageBase64 || (typeof imageBase64 === 'string' && imageBase64.trim().length === 0)) {
      return res.status(400).json({
        error: 'La imagen proporcionada está vacía o es inválida',
      });
    }

    // Validar prompt (requerido)
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        error: 'El parámetro "prompt" es requerido y debe ser un string no vacío',
      });
    }

    // Validar y parsear parámetros de edición
    const validModels = ['gpt-image-1.5'];
    const finalModel = model && validModels.includes(model) ? model : 'gpt-image-1.5';
    
    const validModes = ['variations'];
    const finalMode = mode && validModes.includes(mode) ? mode : 'variations';
    
    const validSizes = ['1536x1024', '1024x1024'];
    const finalSize = size && validSizes.includes(size) ? size : '1536x1024';

    // Validar returnType (por defecto 'file')
    const validReturnTypes = ['file', 'base64'];
    const finalReturnType = returnType && validReturnTypes.includes(returnType) ? returnType : 'file';

    // Configuración de edición
    const editConfig = {
      model: finalModel,
      mode: finalMode,
      size: finalSize,
    };

    // Editar imagen
    const imageBase64String = typeof imageBase64 === 'string' ? imageBase64.trim() : imageBase64;
    const imageResult = await editImageFromBase64(imageBase64String, prompt.trim(), editConfig);

    // Retornar según el tipo solicitado
    if (finalReturnType === 'base64') {
      // Retornar como JSON con base64
      return res.json({
        success: true,
        format: imageResult.format,
        base64: `data:image/${imageResult.format};base64,${imageResult.base64}`,
        model: finalModel,
        mode: finalMode,
        size: finalSize,
      });
    } else {
      // Retornar como archivo
      const contentType = imageResult.format === 'png' ? 'image/png' : 
                          imageResult.format === 'jpg' || imageResult.format === 'jpeg' ? 'image/jpeg' : 
                          'image/png';
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="modified-image.${imageResult.format}"`);
      return res.send(imageResult.buffer);
    }
  } catch (error) {
    await logError(`Error al modificar imagen: ${error.message}`);
    await logError(`Stack: ${error.stack}`);
    return res.status(500).json({
      error: 'Error al modificar imagen',
      message: error.message,
    });
  }
}
