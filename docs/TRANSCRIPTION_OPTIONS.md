# Opciones de Transcripción de OpenAI Whisper API

## Modelos Disponibles

Actualmente, OpenAI solo ofrece **un modelo** para transcripciones de audio:

- **`whisper-1`** - El único modelo disponible para transcripciones de audio

> Nota: OpenAI no ha lanzado otros modelos de transcripción además de Whisper-1. Todos los endpoints de transcripción usan este modelo.

## Formatos de Respuesta (response_format)

La API de transcripciones de OpenAI soporta los siguientes formatos:

### 1. `json` (por defecto)
- Retorna solo el texto de la transcripción en formato JSON
- Estructura: `{ "text": "transcripción completa aquí" }`
- Útil cuando solo necesitas el texto sin timestamps

### 2. `text`
- Retorna el texto plano sin formato
- Solo el texto de la transcripción, sin estructura JSON
- Más simple pero menos información

### 3. `srt`
- Formato de subtítulos SubRip (.srt)
- Incluye números de secuencia, timestamps y texto
- Ideal para generar subtítulos directamente
- Ejemplo:
```
1
00:00:00,000 --> 00:00:05,000
Primera línea de texto

2
00:00:05,000 --> 00:00:10,000
Segunda línea de texto
```

### 4. `verbose_json` ⭐ (Actual)
- JSON con información detallada
- Incluye:
  - `text`: Texto completo de la transcripción
  - `language`: Idioma detectado
  - `duration`: Duración del audio en segundos
  - `segments`: Array de segmentos con:
    - `id`: ID del segmento
    - `seek`: Tiempo de inicio en segundos
    - `start`: Tiempo de inicio en segundos
    - `end`: Tiempo de fin en segundos
    - `text`: Texto del segmento
    - `tokens`: Tokens del segmento
    - `temperature`: Temperatura usada
    - `avg_logprob`: Probabilidad promedio del log
    - `compression_ratio`: Ratio de compresión
    - `no_speech_prob`: Probabilidad de que no haya habla
- **Recomendado** cuando necesitas timestamps y segmentos

### 5. `vtt`
- Formato WebVTT (Web Video Text Tracks)
- Similar a SRT pero con formato web estándar
- Ideal para subtítulos en HTML5
- Ejemplo:
```
WEBVTT

00:00:00.000 --> 00:00:05.000
Primera línea de texto

00:00:05.000 --> 00:00:10.000
Segunda línea de texto
```

## Parámetros Adicionales Disponibles

### `language`
- Especifica el idioma del audio
- Códigos ISO 639-1 (ej: 'es', 'en', 'fr')
- Si se omite, Whisper detecta automáticamente
- **Actual**: `language: 'es'` (Español)

### `timestamp_granularities`
- Especifica qué granularidad de timestamps incluir
- Opciones: `['word']`, `['segment']`, o ambos `['word', 'segment']`
- **Actual**: `['segment']` (solo timestamps de segmentos)
- `['word']` - Incluye timestamps por palabra (solo en `verbose_json`)
- `['segment']` - Incluye timestamps por segmento (lo que usas actualmente)

### `prompt`
- Texto de contexto opcional para mejorar la precisión
- Puede incluir vocabulario técnico o nombres propios
- Ejemplo: `prompt: "Nombres: Juan, María. Términos: minería, carrete"`

### `temperature`
- Controla la "creatividad" de la transcripción
- Rango: 0.0 a 1.0
- Valores más bajos = más determinista
- Por defecto: 0.0 (más preciso)

## Configuración Actual en el Código

```javascript
openai.audio.transcriptions.create({
  file: file,
  model: 'whisper-1',                    // Único modelo disponible
  response_format: 'verbose_json',       // JSON detallado con segmentos
  language: 'es',                        // Español
  timestamp_granularities: ['segment'],  // Timestamps por segmento
})
```

## Recomendaciones

1. **Para tu caso de uso actual**: `verbose_json` es perfecto porque necesitas los segmentos con timestamps para separar las llamadas.

2. **Si quisieras timestamps por palabra** (más preciso pero más datos):
   ```javascript
   timestamp_granularities: ['word', 'segment']
   ```

3. **Si solo necesitaras el texto sin timestamps**:
   ```javascript
   response_format: 'text'  // Más simple y rápido
   ```

4. **Si quisieras generar subtítulos directamente**:
   ```javascript
   response_format: 'srt'  // Genera formato SRT directamente
   ```
