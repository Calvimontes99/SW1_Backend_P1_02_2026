/**
 * Transcripción real de audio con Gemini (acepta audio en el pedido). Antes el servidor devolvía
 * un texto inventado según el tamaño del archivo. DeepSeek no acepta audio; si Gemini no está
 * disponible, se avisa para dictar con el micrófono del navegador (Whisper local o reconocimiento
 * de voz) en su lugar.
 */
import AIEditorController from '../controllers/ai.editor.controller.js';

const modelos = () => String(process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-2.5-flash')
    .split(',').map((s) => s.trim()).filter(Boolean);

export const transcribirAudio = async (buffer, tipo = 'audio/webm') => {
    if (!buffer || !buffer.length) throw new Error('El audio está vacío.');
    const prompt = [
        'Transcribe este audio en español, palabra por palabra. Devuelve SOLO la transcripción, sin comillas ni comentarios. Si no se entiende nada, devuelve exactamente: (inaudible)',
        { inlineData: { mimeType: tipo.split(';')[0] || 'audio/webm', data: buffer.toString('base64') } },
    ];
    let resultado;
    try {
        resultado = await AIEditorController._generateUsingModels(modelos(), prompt);
    } catch {
        throw new Error('No se pudo transcribir el audio ahora (Gemini no está disponible). Dicta el pedido con el micrófono 🎤 del chat.');
    }
    if (resultado.model === 'ollama') throw new Error('La IA local no transcribe audio. Dicta el pedido con el micrófono 🎤 del chat.');
    const texto = String(resultado.text || '').trim().replace(/^["“]|["”]$/g, '');
    if (!texto || /^\(inaudible\)$/i.test(texto)) throw new Error('No se entendió el audio. Prueba de nuevo más cerca del micrófono.');
    return texto;
};
