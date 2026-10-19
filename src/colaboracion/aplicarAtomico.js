/**
 * Aplicar un cambio de la IA (propuesta aceptada) de forma atómica.
 *
 *  1) Se calcula sobre el diagrama de ESTE momento.
 *  2) La sala queda bloqueada: los cambios que lleguen mientras tanto esperan su turno.
 *  3) En UNA transacción se escriben el diagrama nuevo (con una versión mayor), el cierre de la
 *     propuesta y su historial.
 *  4) Recién después del COMMIT se aplica en memoria y se envía a todos. Si algo falla, no cambió
 *     nada: ni la base, ni la memoria, ni lo que ven los demás (y la propuesta no queda aceptada).
 *
 * Todo esto va en la FILA de escrituras de la sala: un autoguardado anterior termina antes de la
 * transacción y uno posterior escribe después (ya con el cambio). Además la base solo acepta una
 * versión mayor que la guardada: una escritura atrasada nunca pisa la propuesta.
 *
 * Las dependencias se inyectan para poder probarlo con una base que falla a propósito.
 */

/** Escribe el diagrama solo si la versión es MAYOR que la guardada (una escritura atrasada no pisa). */
const ESCRIBIR_DIAGRAMA = `UPDATE "Salas" SET xml = $2, lotes_aplicados = $3::jsonb, version_guardada = $4, updatedAt = now()
     WHERE id = $1 AND eliminar = false AND version_guardada < $4`;

/**
 * Guardado normal del diagrama de memoria (autoguardado, "Guardar", salida del último usuario,
 * apagado). Va en la misma fila que las propuestas y lee el diagrama y su versión en el momento
 * de escribir, no al programarlo.
 */
export const crearGuardarSala = ({ pool, serializarLotes, escrituraEnTurno = (salaId, fn) => fn() }) =>
    (salaId, sala) => escrituraEnTurno(salaId, async () => {
        if (!sala || !sala.ultimoEstado) return;
        const version = sala.version || 0;
        // El diagrama y las tandas que incluye se escriben juntos: tras un reinicio siguen coincidiendo
        await pool.query(ESCRIBIR_DIAGRAMA, [salaId, JSON.stringify(sala.ultimoEstado), JSON.stringify(serializarLotes(sala)), version]);
        // Si mientras se escribía llegó otro cambio, sigue sucio y su guardado ya está programado
        if (sala.version === version) sala.sucio = false;
    });

export const crearAplicarAtomico = ({
    pool, guardarCambio, filasDeCambio, serializarLotes, alConfirmar, drenar,
    escrituraEnTurno = (salaId, fn) => fn(),
}) => {
    /**
     * @param {(estado) => {estado: object, problemas: string[]}} calcular
     * @param {(db) => Promise<any>} alGuardar  cierra la propuesta DENTRO de la transacción
     * @returns {{aplicada: true, resultado} | {aplicada: false, problemas?: string[], error?: Error}}
     */
    const aplicar = async (salaId, sala, { calcular, autor, alGuardar }) => {
        const antes = sala.ultimoEstado || { nodes: [], edges: [] };
        const calculo = calcular(antes);
        if (calculo.problemas?.length) return { aplicada: false, problemas: calculo.problemas };
        const despues = calculo.estado;
        const filas = filasDeCambio(salaId, antes, despues, autor);
        // Versión nueva: mayor que la de memoria (y por lo tanto que cualquier guardado anterior)
        const version = (sala.version || 0) + 1;
        sala.bloqueada = true;
        let cliente = null;
        try {
            cliente = await pool.connect();
            await cliente.query('BEGIN');
            const escrito = await cliente.query(ESCRIBIR_DIAGRAMA, [salaId, JSON.stringify(despues), JSON.stringify(serializarLotes(sala)), version]);
            if (escrito.rowCount !== 1) throw new Error('El diagrama guardado es más nuevo que el de memoria');
            const resultado = await alGuardar(cliente);
            if (!resultado) throw new Error('La propuesta ya no estaba reservada');
            const guardadas = [];
            for (const fila of filas) guardadas.push(await guardarCambio(fila, cliente));
            await cliente.query('COMMIT');
            // Mientras duró la transacción nada pudo cambiar la sala (estaba bloqueada)
            alConfirmar(salaId, sala, antes, despues, autor, guardadas, version);
            return { aplicada: true, resultado };
        } catch (error) {
            if (cliente) await cliente.query('ROLLBACK').catch(() => {});
            return { aplicada: false, error };
        } finally {
            if (cliente) cliente.release();
            sala.bloqueada = false;
            drenar(salaId, sala);
        }
    };
    return (salaId, sala, opciones) => escrituraEnTurno(salaId, () => aplicar(salaId, sala, opciones));
};

export default crearAplicarAtomico;
