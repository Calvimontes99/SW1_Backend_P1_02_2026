/**
 * Operaciones explícitas sobre el diagrama, compartidas por el servidor, la web y el móvil
 * (la misma lógica está en frontend/src/utils/operacionesDiagrama.js y en mobile/lib).
 *
 * Antes se mandaban listas completas de nodos o aristas y cada lado las interpretaba distinto
 * (el servidor reemplazaba, la web fusionaba), así un borrado no llegaba a los demás y una
 * edición posterior lo "resucitaba". Ahora cada cambio es una operación con significado único:
 *
 *   { op: 'ponerNodo', nodo }          crear o reemplazar un nodo
 *   { op: 'moverNodo', id, position }  solo la posición
 *   { op: 'quitarNodo', id }           borrar un nodo y sus relaciones
 *   { op: 'ponerArista', arista }      crear o reemplazar una relación
 *   { op: 'quitarArista', id }         borrar una relación
 *
 * Son idempotentes: aplicar dos veces la misma operación deja el mismo resultado.
 */

const TRANSITORIOS = ['selected', 'dragging', 'measured', 'positionAbsolute', 'internals', 'resizing'];

/** El elemento sin lo que es de un solo usuario o lo recalcula React Flow (selección, medidas). */
export const limpiar = (el) => {
    if (!el || typeof el !== 'object') return el;
    const copia = { ...el };
    for (const k of TRANSITORIOS) delete copia[k];
    if (copia.data && typeof copia.data === 'object' && 'selected' in copia.data) {
        const { selected, ...datos } = copia.data;
        copia.data = datos;
    }
    return copia;
};

const sinPosicion = (n) => {
    const { position, ...resto } = n;
    return resto;
};
/** Comparación sin depender del orden de las claves (al fusionar objetos el orden cambia). */
const canonico = (v) => {
    if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
};
const igual = (a, b) => canonico(a) === canonico(b);

export const esOperacionValida = (o) => {
    if (!o || typeof o !== 'object') return false;
    switch (o.op) {
        case 'ponerNodo': return !!(o.nodo && typeof o.nodo.id === 'string' && o.nodo.position);
        case 'moverNodo': return typeof o.id === 'string' && !!o.position && Number.isFinite(o.position.x) && Number.isFinite(o.position.y);
        case 'quitarNodo':
        case 'quitarArista': return typeof o.id === 'string';
        case 'ponerArista': return !!(o.arista && typeof o.arista.id === 'string' && o.arista.source && o.arista.target);
        default: return false;
    }
};

/** Aplica operaciones y devuelve un estado nuevo (no modifica el recibido). */
export const aplicarOps = (estado, ops) => {
    let nodes = Array.isArray(estado?.nodes) ? estado.nodes : [];
    let edges = Array.isArray(estado?.edges) ? estado.edges : [];
    for (const o of ops || []) {
        if (!esOperacionValida(o)) continue;
        switch (o.op) {
            case 'ponerNodo': {
                const nodo = limpiar(o.nodo);
                const i = nodes.findIndex((n) => n.id === nodo.id);
                nodes = i >= 0 ? nodes.map((n, j) => (j === i ? { ...n, ...nodo } : n)) : [...nodes, nodo];
                break;
            }
            case 'moverNodo':
                nodes = nodes.map((n) => (n.id === o.id ? { ...n, position: { x: o.position.x, y: o.position.y } } : n));
                break;
            case 'quitarNodo':
                nodes = nodes.filter((n) => n.id !== o.id);
                edges = edges.filter((e) => e.source !== o.id && e.target !== o.id);
                break;
            case 'ponerArista': {
                const arista = limpiar(o.arista);
                // Una relación solo existe entre clases que existen: "borrar B" seguido de
                // "crear A→B" no deja una relación colgando
                if (!nodes.some((n) => n.id === arista.source) || !nodes.some((n) => n.id === arista.target)) break;
                const i = edges.findIndex((e) => e.id === arista.id);
                edges = i >= 0 ? edges.map((e, j) => (j === i ? { ...e, ...arista } : e)) : [...edges, arista];
                break;
            }
            case 'quitarArista':
                edges = edges.filter((e) => e.id !== o.id);
                break;
            default:
                break;
        }
    }
    return { ...(estado || {}), nodes, edges };
};

/** Operaciones que llevan de `antes` a `despues` (solo lo que cambió de verdad). */
export const opsEntre = (antes, despues) => {
    const ops = [];
    const nodosAntes = new Map((antes?.nodes || []).map((n) => [n.id, limpiar(n)]));
    const nodosDespues = new Map((despues?.nodes || []).map((n) => [n.id, limpiar(n)]));
    for (const [id, d] of nodosDespues) {
        const a = nodosAntes.get(id);
        if (!a) { ops.push({ op: 'ponerNodo', nodo: d }); continue; }
        if (igual(a, d)) continue;
        if (igual(sinPosicion(a), sinPosicion(d))) ops.push({ op: 'moverNodo', id, position: d.position });
        else ops.push({ op: 'ponerNodo', nodo: d });
    }
    for (const id of nodosAntes.keys()) if (!nodosDespues.has(id)) ops.push({ op: 'quitarNodo', id });

    const aristasAntes = new Map((antes?.edges || []).map((e) => [e.id, limpiar(e)]));
    const aristasDespues = new Map((despues?.edges || []).map((e) => [e.id, limpiar(e)]));
    for (const [id, d] of aristasDespues) {
        const a = aristasAntes.get(id);
        if (!a || !igual(a, d)) ops.push({ op: 'ponerArista', arista: d });
    }
    for (const id of aristasAntes.keys()) if (!aristasDespues.has(id)) ops.push({ op: 'quitarArista', id });
    return ops;
};

/**
 * Junta operaciones pendientes con nuevas sin cambiar el orden en que deben aplicarse:
 *  - de cada clase basta la última posición, y un reemplazo (ponerNodo / ponerArista) ocupa el
 *    LUGAR de la operación anterior sobre ese elemento. Si se moviera al final, una relación
 *    creada en medio quedaría antes que su clase y se descartaría (crear A → conectar A–B →
 *    renombrar A perdía la relación);
 *  - un borrado anula lo anterior sobre ese elemento y va al final.
 */
export const fusionarOps = (pendientes, nuevas) => {
    let lista = [...(pendientes || [])];
    const idDe = (p) => p.id || p.nodo?.id || p.arista?.id;
    const ultimaSobre = (id, tipos) => {
        for (let i = lista.length - 1; i >= 0; i -= 1) {
            if (idDe(lista[i]) === id && tipos.includes(lista[i].op)) return i;
        }
        return -1;
    };
    for (const o of nuevas || []) {
        const id = idDe(o);
        switch (o.op) {
            case 'moverNodo': {
                const i = ultimaSobre(id, ['ponerNodo', 'moverNodo', 'quitarNodo']);
                if (i >= 0 && lista[i].op === 'moverNodo') { lista[i] = o; continue; }
                if (i >= 0 && lista[i].op === 'ponerNodo') { lista[i] = { op: 'ponerNodo', nodo: { ...lista[i].nodo, position: o.position } }; continue; }
                lista.push(o);
                break;
            }
            case 'ponerNodo': {
                const i = ultimaSobre(id, ['ponerNodo', 'moverNodo', 'quitarNodo']);
                if (i >= 0 && lista[i].op !== 'quitarNodo') { lista[i] = o; continue; } // en su lugar
                lista.push(o);
                break;
            }
            case 'quitarNodo':
                lista = lista.filter((p) => !((p.op === 'moverNodo' || p.op === 'ponerNodo') && idDe(p) === id));
                lista.push(o);
                break;
            case 'ponerArista': {
                const i = ultimaSobre(id, ['ponerArista', 'quitarArista']);
                if (i >= 0 && lista[i].op === 'ponerArista') { lista[i] = o; continue; } // en su lugar
                lista.push(o);
                break;
            }
            case 'quitarArista':
                lista = lista.filter((p) => !(p.op === 'ponerArista' && idDe(p) === id));
                lista.push(o);
                break;
            default:
                lista.push(o);
        }
    }
    return lista;
};
