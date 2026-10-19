/**
 * Fila por sala: `fn` se ejecuta cuando terminó lo anterior de la misma sala. Salas distintas no
 * se esperan entre sí. Cada fila es independiente (una tarea de una fila puede esperar a otra).
 */
export const crearFila = () => {
    const colas = new Map();
    return (salaId, fn) => {
        const previo = colas.get(salaId) || Promise.resolve();
        const actual = previo.catch(() => {}).then(fn);
        const cola = actual.catch(() => {});
        colas.set(salaId, cola);
        cola.then(() => { if (colas.get(salaId) === cola) colas.delete(salaId); });
        return actual;
    };
};

/**
 * Una cosa a la vez por sala (aceptar propuestas, pegar las notas de la IA). Dos propuestas
 * aceptadas a la vez no leen el mismo diagrama ni se pisan.
 */
export const conCandado = crearFila();

export default conCandado;
