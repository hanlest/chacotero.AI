import OpenAI from 'openai';
import config from '../config/config.js';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

/**
 * Genera metadatos para una llamada usando GPT-4
 * @param {string} transcription - Transcripción de la llamada
 * @param {string} youtubeVideoId - ID del video de YouTube
 * @param {string} uploadDate - Fecha de subida del video
 * @param {Array<string>} speakers - Lista de speakers identificados
 * @returns {Promise<{title: string, description: string, theme: string, tags: Array<string>, date: string}>}
 */
export async function generateMetadata(transcription, youtubeVideoId, uploadDate, speakers = []) {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  try {
    const prompt = `Analiza la siguiente transcripción de una llamada de radio y genera metadatos estructurados.

Transcripción:
${transcription}

Genera:
1. Un título corto y descriptivo (máximo 80 caracteres)
2. Una descripción breve del contenido de la llamada (2-3 oraciones)
3. El tema principal de la llamada (una palabra o frase corta)
4. Un listado de tags relevantes (máximo 10 tags, palabras clave que identifiquen el contenido)
5. La fecha de la llamada (usar la fecha proporcionada si está disponible, o inferir del contexto)

Responde SOLO con un JSON válido con esta estructura:
{
  "title": "Título de la llamada",
  "description": "Descripción breve...",
  "theme": "Tema principal",
  "tags": ["tag1", "tag2", "tag3"],
  "date": "YYYY-MM-DD"
}`;

    // Log del prompt (sin la transcripción completa para no saturar los logs)
    console.log('📝 Prompt para generación de metadatos:');
    console.log('═'.repeat(80));
    console.log('SYSTEM MESSAGE:');
    console.log('Eres un experto en análisis de contenido de radio. Genera metadatos precisos y relevantes para llamadas de radio. Responde ÚNICAMENTE con JSON válido, sin texto adicional ni explicaciones.');
    console.log('─'.repeat(80));
    console.log('USER MESSAGE (sin transcripción):');
    const promptWithoutTranscription = prompt.replace(
      /Transcripción:\n[\s\S]*?\n\nGenera:/,
      `Transcripción:\n[Transcripción completa: ${transcription.length.toLocaleString()} caracteres]\n\nGenera:`
    );
    console.log(promptWithoutTranscription);
    console.log(`   📄 Transcripción completa: ${transcription.length.toLocaleString()} caracteres`);
    console.log('═'.repeat(80));
    
    const response = await openai.chat.completions.create({
      model: 'gpt-5.2', // GPT-5.2 - mejor razonamiento, memoria extendida y 38% menos errores
      messages: [
        {
          role: 'system',
          content: 'Eres un experto en análisis de contenido de radio. Genera metadatos precisos y relevantes para llamadas de radio. Responde ÚNICAMENTE con JSON válido, sin texto adicional ni explicaciones.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3, // Temperatura moderada para metadatos (más creativo que separación pero aún preciso)
    });

    // Extraer JSON de la respuesta (puede venir con texto adicional)
    let responseText = response.choices[0].message.content.trim();
    
    // Intentar extraer JSON si viene envuelto en texto
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      responseText = jsonMatch[0];
    }
    
    let metadata;
    try {
      metadata = JSON.parse(responseText);
    } catch (parseError) {
      console.warn('Error al parsear JSON de metadatos, usando valores por defecto:', parseError.message);
      // Si falla el parsing, usar valores por defecto
      metadata = {};
    }

    // Validar y completar metadatos
    return {
      title: metadata.title || 'Llamada sin título',
      description: metadata.description || 'Sin descripción disponible',
      theme: metadata.theme || 'General',
      tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 10) : [],
      date: metadata.date || uploadDate || new Date().toISOString().split('T')[0],
      youtubeVideoId,
      speakers: speakers.length > 0 ? speakers : ['Conductor', 'Llamante'],
    };
  } catch (error) {
    console.error('Error al generar metadatos:', error);
    
    // Retornar metadatos por defecto en caso de error
    return {
      title: 'Llamada sin título',
      description: 'Sin descripción disponible',
      theme: 'General',
      tags: [],
      date: uploadDate || new Date().toISOString().split('T')[0],
      youtubeVideoId,
      speakers: speakers.length > 0 ? speakers : ['Conductor', 'Llamante'],
    };
  }
}
