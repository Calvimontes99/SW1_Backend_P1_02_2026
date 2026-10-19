/**
 * IA local con Ollama como último respaldo del servidor (después de Gemini y DeepSeek), para
 * trabajar sin internet en el laboratorio: el backend y Ollama corren en la misma PC.
 * Se activa solo si OLLAMA_URL está definida (p. ej. http://localhost:11434).
 */

const URL_OLLAMA = () => (process.env.OLLAMA_URL || '').trim().replace(/\/+$/, '');
const MODELO_TEXTO = () => process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const MODELO_VISION = () => process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:7b';

export const hayOllama = () => Boolean(URL_OLLAMA());

/**
 * Genera texto con el modelo local. Acepta el mismo pedido que Gemini: texto, o un arreglo
 * [texto, { inlineData: { data: base64 } }] cuando hay imagen (usa el modelo con visión).
 */
export const generarConOllama = async (prompt, { temperatura = 0.2, json = false, limiteMs = 180000 } = {}) => {
    if (!hayOllama()) throw new Error('No hay IA local configurada (OLLAMA_URL)');
    const partes = Array.isArray(prompt) ? prompt : [prompt];
    const texto = partes.filter((p) => typeof p === 'string').join('\n\n');
    const imagenes = partes.filter((p) => p && p.inlineData?.data).map((p) => p.inlineData.data);
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), limiteMs);
    try {
        const respuesta = await fetch(`${URL_OLLAMA()}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: control.signal,
            body: JSON.stringify({
                model: imagenes.length ? MODELO_VISION() : MODELO_TEXTO(),
                messages: [{ role: 'user', content: texto, ...(imagenes.length ? { images: imagenes } : {}) }],
                stream: false,
                ...(json ? { format: 'json' } : {}),
                options: { temperature: temperatura },
            }),
        });
        if (!respuesta.ok) throw new Error(`La IA local respondió ${respuesta.status}`);
        const datos = await respuesta.json();
        const salida = datos?.message?.content || '';
        if (!salida.trim()) throw new Error('La IA local devolvió una respuesta vacía');
        return salida;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('La IA local tardó demasiado en responder');
        if (/fetch failed|ECONNREFUSED/i.test(error.message)) throw new Error('La IA local (Ollama) no está encendida');
        throw error;
    } finally {
        clearTimeout(reloj);
    }
};
