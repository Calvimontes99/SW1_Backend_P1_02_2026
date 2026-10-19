/**
 * Historial de la sala: quién hizo cada cambio del diagrama (RF-07).
 *
 * El servidor compara cada versión nueva del diagrama con la anterior y anota las diferencias de
 * contenido con su autor. Las ráfagas de una misma persona sobre un mismo elemento (escribir un
 * atributo letra por letra) se juntan en un solo cambio cuando deja de tocarlo unos segundos.
 */
import { describirOperacion, diferencias, nombresPorId, vistaSemantica } from './diagramaSemantico.js';
import { guardarCambio } from './repositorio.js';

const ESPERA_AGRUPAR_MS = Number(process.env.HISTORIAL_AGRUPAR_MS || 2500);

/** salaId → { vista, estado, pendientes: Map(clave → {...}) } */
const salas = new Map();
let emitir = () => {};

/** Cómo avisar a la sala de un cambio nuevo (lo fija el servidor de sockets). */
export const alRegistrarCambio = (fn) => { emitir = fn; };

const estadoDe = (salaId) => salas.get(salaId);

/** Punto de partida: el diagrama tal como está (al abrir la sala o al recargarla de la base). */
export const fijarBase = (salaId, estado) => {
    if (!salas.has(salaId)) salas.set(salaId, { vista: null, estado: null, pendientes: new Map() });
    const s = salas.get(salaId);
    s.vista = vistaSemantica(estado);
    s.estado = estado;
};

export const tieneBase = (salaId) => !!estadoDe(salaId)?.vista;

/**
 * Filas del historial para un cambio que se guarda dentro de una transacción (propuesta de la IA
 * aceptada): una por cada diferencia de contenido entre `antes` y `despues`.
 */
export const filasDeCambio = (salaId, antes, despues, autor) => {
    const nombreDe = nombresPorId(antes, despues);
    return diferencias(vistaSemantica(antes), vistaSemantica(despues)).map((op) => ({
        salaId,
        autorId: autor.id ?? null,
        autorNombre: autor.nombre,
        esIA: !!autor.esIA,
        pedidoPor: autor.pedidoPor,
        aprobadoPor: autor.aprobadoPor,
        operacion: op.op,
        elementoId: op.id,
        elementoNombre: op.despues?.nombre || op.antes?.nombre || null,
        resumen: describirOperacion(op, nombreDe),
        antes: op.antes || null,
        despues: op.despues || null,
    }));
};

/** Avisa a la sala de cambios ya guardados (los de una transacción confirmada). */
export const anunciarCambios = (salaId, cambios) => {
    for (const c of cambios) emitir(salaId, c);
};

const guardar = async (salaId, p) => {
    try {
        const nombreDe = nombresPorId(p.estadoAntes, p.estadoDespues);
        const cambio = await guardarCambio({
            salaId,
            autorId: p.autor.id,
            autorNombre: p.autor.nombre,
            esIA: !!p.autor.esIA,
            pedidoPor: p.autor.pedidoPor,
            aprobadoPor: p.autor.aprobadoPor,
            operacion: p.op.op,
            elementoId: p.op.id,
            elementoNombre: p.op.despues?.nombre || p.op.antes?.nombre || null,
            resumen: describirOperacion(p.op, nombreDe),
            antes: p.op.antes || null,
            despues: p.op.despues || null,
        });
        emitir(salaId, cambio);
    } catch (error) {
        console.error(`Historial: no se pudo guardar un cambio de la sala ${salaId}:`, error.message);
    }
};

const vaciar = (salaId, clave) => {
    const s = estadoDe(salaId);
    const p = s?.pendientes.get(clave);
    if (!p) return;
    clearTimeout(p.reloj);
    s.pendientes.delete(clave);
    if (p.op) guardar(salaId, p);
};

/** Une dos operaciones seguidas sobre el mismo elemento (la primera con la última). */
const combinar = (primera, ultima) => {
    const agregado = primera.op.startsWith('agregar');
    const eliminado = ultima.op.startsWith('eliminar');
    if (agregado && eliminado) return null; // lo creó y lo borró: no queda nada que contar
    if (agregado) return { ...primera, despues: ultima.despues || primera.despues };
    if (eliminado) return { ...ultima, antes: primera.antes };
    return { ...ultima, antes: primera.antes };
};

/**
 * Registra una versión nueva del diagrama hecha por `autor`.
 * @param {object} autor  { id, nombre, esIA?, pedidoPor?, aprobadoPor? }
 * @param {{nodos?: boolean, aristas?: boolean}} alcance  qué partes trae esta versión
 * @param {{inmediato?: boolean}} opciones  inmediato: sin agrupar (cambios de la IA)
 */
export const registrarVersion = (salaId, estadoNuevo, autor, alcance = { nodos: true, aristas: true }, opciones = {}) => {
    const s = estadoDe(salaId);
    if (!s || !s.vista || !autor) return;
    const vistaNueva = vistaSemantica(estadoNuevo);
    const ops = diferencias(s.vista, vistaNueva, alcance);
    const estadoAntes = s.estado;
    // La vista se actualiza solo en la parte que trajo el evento
    if (alcance.nodos) s.vista.nodos = vistaNueva.nodos;
    if (alcance.aristas) s.vista.aristas = vistaNueva.aristas;
    s.estado = {
        nodes: alcance.nodos ? estadoNuevo.nodes : estadoAntes?.nodes,
        edges: alcance.aristas ? estadoNuevo.edges : estadoAntes?.edges,
    };
    const claveAutor = autor.esIA ? 'ia' : String(autor.id ?? autor.nombre);

    for (const op of ops) {
        const clave = `${op.id}`;
        const pendiente = s.pendientes.get(clave);
        // Otro autor tocó lo mismo: lo anterior se guarda tal cual antes de empezar lo nuevo
        if (pendiente && pendiente.claveAutor !== claveAutor) vaciar(salaId, clave);
        const actual = s.pendientes.get(clave);
        if (actual) {
            clearTimeout(actual.reloj);
            actual.op = actual.op ? combinar(actual.op, op) : op;
            actual.estadoDespues = s.estado;
        } else {
            s.pendientes.set(clave, { claveAutor, autor, op, estadoAntes, estadoDespues: s.estado });
        }
        const p = s.pendientes.get(clave);
        if (opciones.inmediato) vaciar(salaId, clave);
        else p.reloj = setTimeout(() => vaciar(salaId, clave), ESPERA_AGRUPAR_MS);
    }
};

/** Guarda lo pendiente y olvida la sala (cuando se va el último integrante). */
export const cerrarSala = (salaId) => {
    const s = estadoDe(salaId);
    if (!s) return;
    for (const clave of [...s.pendientes.keys()]) vaciar(salaId, clave);
    salas.delete(salaId);
};

/** Guarda todo lo pendiente (al apagar el servidor). */
export const vaciarTodo = () => {
    for (const salaId of [...salas.keys()]) {
        const s = salas.get(salaId);
        for (const clave of [...s.pendientes.keys()]) vaciar(salaId, clave);
    }
};
