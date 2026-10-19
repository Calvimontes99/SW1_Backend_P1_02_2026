/**
 * El diagrama visto por su contenido (clases, miembros, relaciones y notas), sin lo visual
 * (posiciones, selección, medidas). Sirve para tres cosas:
 *  - saber qué cambió entre dos versiones y quién lo hizo (historial de la sala);
 *  - convertir lo que propone la IA en operaciones que se pueden revisar y aplicar después;
 *  - describir el diagrama en texto plano para la IA (también para DeepSeek, que no ve imágenes).
 */

const TIPOS_RELACION = {
    association: 'asociación',
    composition: 'composición',
    aggregation: 'agregación',
    generalization: 'herencia',
    inheritance: 'herencia',
    implementation: 'implementación',
    realization: 'implementación',
    dependency: 'dependencia',
};

export const nombreTipoRelacion = (tipo) => TIPOS_RELACION[String(tipo || 'association').toLowerCase()] || String(tipo);

/** Atributos y métodos siempre como lista de textos (el tablero a veces guarda objetos). */
const comoTextos = (lista, esMetodo = false) => {
    if (!lista) return [];
    const arreglo = Array.isArray(lista) ? lista : [lista];
    return arreglo.map((item) => {
        if (item === null || item === undefined) return '';
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object') {
            if (esMetodo && item.name) return `${item.name}()${item.returnType ? `: ${item.returnType}` : ''}`;
            if (item.name && item.type) return `${item.name}: ${item.type}`;
            if (item.name) return String(item.name);
            return JSON.stringify(item);
        }
        return String(item);
    }).filter(Boolean);
};

const esClase = (n) => n && n.type === 'classNode' && !n.data?.isConnectionPoint;
const esNota = (n) => n && n.type === 'noteNode';

/** Lo que importa de un nodo o una arista para decidir si "cambió". */
export const firmaNodo = (n) => {
    if (esClase(n)) {
        return {
            tipo: 'clase',
            nombre: String(n.data?.className || 'Clase').trim(),
            atributos: comoTextos(n.data?.attributes),
            metodos: comoTextos(n.data?.methods, true),
            estereotipo: n.data?.stereotype || null,
        };
    }
    if (esNota(n)) return { tipo: 'nota', texto: String(n.data?.text || '').trim() };
    return null;
};

export const firmaArista = (e) => ({
    origen: e.source,
    destino: e.target,
    tipo: e.data?.type || 'Association',
    inicio: e.data?.startLabel || '',
    fin: e.data?.endLabel || '',
    etiqueta: e.data?.label || '',
});

/** JSON con las claves ordenadas: PostgreSQL (JSONB) reordena las claves al guardar. */
const canonico = (valor) => {
    if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
    if (valor && typeof valor === 'object') {
        return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
    }
    return JSON.stringify(valor ?? null);
};
const igual = (a, b) => canonico(a) === canonico(b);

/** Vista indexada por id del contenido del diagrama. */
export const vistaSemantica = (estado) => {
    const nodos = new Map();
    const aristas = new Map();
    for (const n of (estado?.nodes || [])) {
        const firma = firmaNodo(n);
        if (firma && n.id) nodos.set(n.id, firma);
    }
    for (const e of (estado?.edges || [])) {
        if (e && e.id && e.source && e.target) aristas.set(e.id, firmaArista(e));
    }
    return { nodos, aristas };
};

/**
 * Diferencias de contenido entre dos versiones. Cada operación lleva lo de antes y lo de después
 * (para el historial y para comprobar, al aplicar una propuesta, que nadie lo cambió entretanto).
 * @param {{nodos?: boolean, aristas?: boolean}} alcance  qué comparar (un evento solo de nodos no
 *        debe hacer creer que se borraron todas las relaciones)
 */
export const diferencias = (vistaAntes, vistaDespues, alcance = { nodos: true, aristas: true }) => {
    const ops = [];
    if (alcance.nodos) {
        for (const [id, despues] of vistaDespues.nodos) {
            const antes = vistaAntes.nodos.get(id);
            if (!antes) ops.push({ op: despues.tipo === 'nota' ? 'agregarNota' : 'agregarClase', id, despues });
            else if (!igual(antes, despues)) ops.push({ op: despues.tipo === 'nota' ? 'modificarNota' : 'modificarClase', id, antes, despues });
        }
        for (const [id, antes] of vistaAntes.nodos) {
            if (!vistaDespues.nodos.has(id)) ops.push({ op: antes.tipo === 'nota' ? 'eliminarNota' : 'eliminarClase', id, antes });
        }
    }
    if (alcance.aristas) {
        for (const [id, despues] of vistaDespues.aristas) {
            const antes = vistaAntes.aristas.get(id);
            if (!antes) ops.push({ op: 'agregarRelacion', id, despues });
            else if (!igual(antes, despues)) ops.push({ op: 'modificarRelacion', id, antes, despues });
        }
        for (const [id, antes] of vistaAntes.aristas) {
            if (!vistaDespues.aristas.has(id)) ops.push({ op: 'eliminarRelacion', id, antes });
        }
    }
    return ops;
};

const lista = (xs) => xs.map((x) => `«${x}»`).join(', ');
const recortar = (texto, max = 60) => (texto.length > max ? `${texto.slice(0, max - 1)}…` : texto);

/**
 * Frase en español de una operación ("agregó la clase Venta"), sin el sujeto.
 * @param {(id: string) => string} nombreDe  nombre de una clase por su id (para las relaciones)
 */
export const describirOperacion = (op, nombreDe = (id) => id) => {
    const nombre = op.despues?.nombre || op.antes?.nombre || 'una clase';
    const relacion = (f) => {
        const card = f.inicio || f.fin ? ` (${f.inicio || '?'} → ${f.fin || '?'})` : '';
        return `${nombreTipoRelacion(f.tipo)} ${nombreDe(f.origen)} → ${nombreDe(f.destino)}${card}`;
    };
    switch (op.op) {
        case 'agregarClase': {
            const n = op.despues.atributos.length;
            return `agregó la clase ${nombre}${n ? ` con ${n} atributo${n === 1 ? '' : 's'}` : ''}`;
        }
        case 'eliminarClase': return `eliminó la clase ${nombre}`;
        case 'modificarClase': {
            const a = op.antes;
            const d = op.despues;
            const partes = [];
            if (a.nombre !== d.nombre) partes.push(`renombró ${a.nombre} a ${d.nombre}`);
            const nuevosAtr = d.atributos.filter((x) => !a.atributos.includes(x));
            const quitadosAtr = a.atributos.filter((x) => !d.atributos.includes(x));
            const nuevosMet = d.metodos.filter((x) => !a.metodos.includes(x));
            const quitadosMet = a.metodos.filter((x) => !d.metodos.includes(x));
            if (nuevosAtr.length) partes.push(`agregó a ${d.nombre} ${nuevosAtr.length === 1 ? 'el atributo' : 'los atributos'} ${lista(nuevosAtr)}`);
            if (quitadosAtr.length) partes.push(`quitó de ${d.nombre} ${quitadosAtr.length === 1 ? 'el atributo' : 'los atributos'} ${lista(quitadosAtr)}`);
            if (nuevosMet.length) partes.push(`agregó a ${d.nombre} ${nuevosMet.length === 1 ? 'el método' : 'los métodos'} ${lista(nuevosMet)}`);
            if (quitadosMet.length) partes.push(`quitó de ${d.nombre} ${quitadosMet.length === 1 ? 'el método' : 'los métodos'} ${lista(quitadosMet)}`);
            if (a.estereotipo !== d.estereotipo) partes.push(`cambió el estereotipo de ${d.nombre} a ${d.estereotipo || 'ninguno'}`);
            if (!partes.length) partes.push(`reordenó los miembros de ${d.nombre}`);
            return partes.join('; ');
        }
        case 'agregarNota': return `agregó una nota «${recortar(op.despues.texto)}»`;
        case 'modificarNota': return `editó una nota «${recortar(op.despues.texto)}»`;
        case 'eliminarNota': return `eliminó una nota «${recortar(op.antes.texto)}»`;
        case 'agregarRelacion': return `agregó la relación ${relacion(op.despues)}`;
        case 'eliminarRelacion': return `eliminó la relación ${relacion(op.antes)}`;
        case 'modificarRelacion': {
            const a = op.antes;
            const d = op.despues;
            const cambios = [];
            if (a.tipo !== d.tipo) cambios.push(`tipo ${nombreTipoRelacion(a.tipo)} → ${nombreTipoRelacion(d.tipo)}`);
            if (a.inicio !== d.inicio || a.fin !== d.fin) cambios.push(`multiplicidad ${a.inicio || '?'}..${a.fin || '?'} → ${d.inicio || '?'}..${d.fin || '?'}`);
            if (a.origen !== d.origen || a.destino !== d.destino) cambios.push('extremos');
            if (a.etiqueta !== d.etiqueta) cambios.push(`nombre «${d.etiqueta}»`);
            return `cambió la relación ${nombreDe(d.origen)} → ${nombreDe(d.destino)} (${cambios.join(', ') || 'detalles'})`;
        }
        default: return op.op;
    }
};

/** Nombre de cada clase por id, a partir de una o más versiones del diagrama. */
export const nombresPorId = (...estados) => {
    const mapa = new Map();
    for (const estado of estados) {
        for (const n of (estado?.nodes || [])) {
            if (esClase(n)) mapa.set(n.id, String(n.data?.className || 'Clase'));
        }
    }
    return (id) => mapa.get(id) || 'una clase';
};

/**
 * El diagrama en texto plano y compacto, para darle contexto a la IA. Se le pasan los ids
 * para que pueda referirse a una clase concreta.
 */
export const diagramaComoTexto = (estado) => {
    const nodos = (estado?.nodes || []);
    const clases = nodos.filter(esClase);
    const notas = nodos.filter(esNota);
    const nombreDe = nombresPorId(estado);
    if (!clases.length && !notas.length) return '(el diagrama está vacío)';
    const lineas = ['Clases:'];
    for (const n of clases) {
        const f = firmaNodo(n);
        const estereotipo = f.estereotipo ? ` «${f.estereotipo}»` : '';
        lineas.push(`- ${f.nombre}${estereotipo} [id ${n.id}]: atributos: ${f.atributos.join(', ') || 'ninguno'} | métodos: ${f.metodos.join(', ') || 'ninguno'}`);
    }
    const aristas = (estado?.edges || []).filter((e) => e && e.source && e.target);
    if (aristas.length) {
        lineas.push('Relaciones:');
        for (const e of aristas) {
            const f = firmaArista(e);
            const card = f.inicio || f.fin ? ` multiplicidad ${f.inicio || '?'} → ${f.fin || '?'}` : '';
            lineas.push(`- ${nombreDe(f.origen)} → ${nombreDe(f.destino)}: ${nombreTipoRelacion(f.tipo)}${card}${f.etiqueta ? ` «${f.etiqueta}»` : ''}`);
        }
    }
    if (notas.length) {
        lineas.push('Notas en la pizarra:');
        for (const n of notas) lineas.push(`- ${recortar(String(n.data?.text || ''), 140)}`);
    }
    return lineas.join('\n');
};

/** Quita del nodo o arista lo que React Flow recalcula solo o lo que es de un usuario. */
export const limpiarElemento = (el) => {
    if (!el || typeof el !== 'object') return el;
    const { selected, dragging, measured, positionAbsolute, internals, resizing, ...resto } = el;
    if (resto.data && typeof resto.data === 'object') {
        const { _aiModified, selected: sel, ...datos } = resto.data;
        resto.data = datos;
    }
    return resto;
};

/**
 * Operaciones que propone la IA: la diferencia entre las clases y relaciones actuales y las que
 * devolvió el editor de IA. Cada una lleva el elemento completo para poder aplicarla después.
 */
export const operacionesPropuestas = (estadoActual, estadoPropuesto) => {
    const soloModelo = (estado) => ({
        nodes: (estado?.nodes || []).filter(esClase),
        edges: estado?.edges || [],
    });
    const actual = soloModelo(estadoActual);
    const propuesto = soloModelo(estadoPropuesto);
    const ops = diferencias(vistaSemantica(actual), vistaSemantica(propuesto));
    const nodoPropuesto = new Map(propuesto.nodes.map((n) => [n.id, n]));
    const aristaPropuesta = new Map(propuesto.edges.map((e) => [e.id, e]));

    // Las clases nuevas van a la derecha del diagrama, en columna, para no tapar nada
    const posiciones = (estadoActual?.nodes || []).map((n) => n.position || { x: 0, y: 0 });
    const xLibre = posiciones.length ? Math.max(...posiciones.map((p) => p.x || 0)) + 450 : 100;
    const yInicial = posiciones.length ? Math.min(...posiciones.map((p) => p.y || 0)) : 100;
    let fila = 0;

    return ops.map((op) => {
        if (op.op === 'agregarClase') {
            const nodo = limpiarElemento(nodoPropuesto.get(op.id));
            nodo.position = { x: xLibre, y: yInicial + fila * 280 };
            fila += 1;
            return { ...op, nodo };
        }
        if (op.op === 'agregarRelacion') return { ...op, arista: limpiarElemento(aristaPropuesta.get(op.id)) };
        if (op.op === 'modificarRelacion') return { ...op, datos: limpiarElemento(aristaPropuesta.get(op.id)).data };
        return op;
    });
};

/**
 * Aplica operaciones aprobadas sobre el estado actual. Primero se validan TODAS contra el diagrama
 * de este momento y recién después se modifica algo: si alguien cambió o borró lo que la propuesta
 * toca (o agregó una relación a una clase que la propuesta borra), no se aplica nada y se
 * devuelven los problemas (la propuesta quedó desactualizada).
 *
 * Es idempotente: si una operación ya está hecha (por ejemplo, se reintenta tras un corte del
 * servidor), se salta en vez de duplicar clases o relaciones.
 * @returns {{estado: object|null, problemas: string[]}}
 */
export const aplicarOperaciones = (estado, ops) => {
    const nodosActuales = new Map((estado?.nodes || []).map((n) => [n.id, n]));
    const aristasActuales = new Map((estado?.edges || []).map((e) => [e.id, e]));
    const nombreDe = nombresPorId(estado);
    const problemas = [];

    // ── 1) Validación sobre el estado actual (sin tocar nada) ──
    // Si el id propuesto ya lo usa OTRA clase, se prueba un id alternativo DETERMINISTA (P~ia1,
    // P~ia2…): reaplicar la misma propuesta encuentra la clase que creó antes en vez de crear otra
    const candidatos = (id) => [id, ...Array.from({ length: 20 }, (_, k) => `${id}~ia${k + 1}`)];
    const idNuevo = new Map(); // id propuesto → id final
    const clasesYaHechas = new Set();
    for (const op of ops) {
        if (op.op !== 'agregarClase') continue;
        for (const id of candidatos(op.id)) {
            const existente = nodosActuales.get(id);
            if (!existente) { if (id !== op.id) idNuevo.set(op.id, id); break; }
            if (igual(firmaNodo(existente), op.despues)) { // ya aplicada antes (con este id)
                if (id !== op.id) idNuevo.set(op.id, id);
                clasesYaHechas.add(op.id);
                break;
            }
        }
    }
    const resolver = (id) => idNuevo.get(id) || id;
    // Lo mismo con las relaciones nuevas cuyo id choca con otra relación
    const aristaFinal = new Map();
    const relacionesYaHechas = new Set();
    for (const op of ops) {
        if (op.op !== 'agregarRelacion') continue;
        const deseada = { ...firmaArista(op.arista), origen: resolver(op.arista.source), destino: resolver(op.arista.target) };
        for (const id of candidatos(op.id)) {
            const existente = aristasActuales.get(id);
            if (!existente) { aristaFinal.set(op.id, id); break; }
            if (igual(firmaArista(existente), deseada)) { aristaFinal.set(op.id, id); relacionesYaHechas.add(op.id); break; }
        }
    }
    const borradas = new Set(ops.filter((o) => o.op === 'eliminarClase' && nodosActuales.has(o.id)).map((o) => o.id));
    const relacionesQueSeBorran = new Set(ops.filter((o) => o.op === 'eliminarRelacion').map((o) => o.id));
    // Clases que existirán al terminar (para comprobar los extremos de cada relación)
    const clasesFinales = new Set([...nodosActuales.keys()].filter((id) => !borradas.has(id)));
    for (const op of ops) if (op.op === 'agregarClase') clasesFinales.add(resolver(op.id));

    const saltar = new Set(); // operaciones que ya estaban hechas
    ops.forEach((op, i) => {
        switch (op.op) {
            case 'modificarClase': {
                const actual = nodosActuales.get(op.id);
                if (!actual) { problemas.push(`la clase ${op.antes.nombre} ya no existe`); break; }
                const firma = firmaNodo(actual);
                if (igual(firma, op.despues)) { saltar.add(i); break; }
                if (!igual(firma, op.antes)) problemas.push(`alguien cambió la clase ${op.antes.nombre} después de la propuesta`);
                break;
            }
            case 'eliminarClase': {
                const actual = nodosActuales.get(op.id);
                if (!actual) { saltar.add(i); break; } // ya la había borrado alguien: el resultado es el mismo
                // Una propuesta vieja no puede borrar el trabajo que otro hizo después en esa clase...
                if (!igual(firmaNodo(actual), op.antes)) { problemas.push(`alguien cambió la clase ${op.antes.nombre} después de la propuesta`); break; }
                // ...ni las relaciones que alguien le agregó después
                for (const e of aristasActuales.values()) {
                    if ((e.source === op.id || e.target === op.id) && !relacionesQueSeBorran.has(e.id)) {
                        problemas.push(`alguien agregó la relación ${nombreDe(e.source)} → ${nombreDe(e.target)} después de la propuesta`);
                    }
                }
                break;
            }
            case 'agregarRelacion': {
                if (relacionesYaHechas.has(op.id)) { saltar.add(i); break; }
                if (!clasesFinales.has(resolver(op.arista.source)) || !clasesFinales.has(resolver(op.arista.target))) {
                    problemas.push(`la relación ${nombreDe(op.arista.source)} → ${nombreDe(op.arista.target)} une una clase que ya no existe`);
                }
                break;
            }
            case 'modificarRelacion': {
                const actual = aristasActuales.get(op.id);
                if (!actual) { problemas.push('una relación que la propuesta cambia ya no existe'); break; }
                const firma = firmaArista(actual);
                if (igual(firma, op.despues)) { saltar.add(i); break; }
                if (!igual(firma, op.antes)) { problemas.push('alguien cambió una relación después de la propuesta'); break; }
                if (!clasesFinales.has(resolver(op.despues.origen)) || !clasesFinales.has(resolver(op.despues.destino))) {
                    problemas.push(`la relación ${nombreDe(op.despues.origen)} → ${nombreDe(op.despues.destino)} apuntaría a una clase que no existe`);
                }
                break;
            }
            case 'eliminarRelacion': {
                const actual = aristasActuales.get(op.id);
                if (!actual) { saltar.add(i); break; }
                if (!igual(firmaArista(actual), op.antes)) problemas.push('alguien cambió una relación que la propuesta borra');
                break;
            }
            default:
                break;
        }
    });
    if (problemas.length) return { estado: null, problemas: [...new Set(problemas)] };

    // ── 2) Aplicación (todo validado) ──
    let nodes = (estado?.nodes || []).map((n) => ({ ...n }));
    let edges = (estado?.edges || []).map((e) => ({ ...e }));
    ops.forEach((op, i) => {
        if (saltar.has(i)) return;
        switch (op.op) {
            case 'agregarClase': {
                if (clasesYaHechas.has(op.id)) break;
                nodes.push({ ...op.nodo, id: resolver(op.id), data: { ...(op.nodo?.data || {}) } });
                break;
            }
            case 'modificarClase': {
                const j = nodes.findIndex((n) => n.id === op.id);
                const data = {
                    ...nodes[j].data,
                    className: op.despues.nombre,
                    attributes: op.despues.atributos,
                    methods: op.despues.metodos,
                };
                // Quitar el estereotipo (p. ej. dejar de ser abstract) borra la clave
                if (op.despues.estereotipo) data.stereotype = op.despues.estereotipo;
                else delete data.stereotype;
                nodes[j] = { ...nodes[j], data };
                break;
            }
            case 'eliminarClase':
                nodes = nodes.filter((n) => n.id !== op.id);
                edges = edges.filter((e) => e.source !== op.id && e.target !== op.id);
                break;
            case 'agregarRelacion': {
                const arista = { ...op.arista, id: aristaFinal.get(op.id) || op.id, source: resolver(op.arista.source), target: resolver(op.arista.target) };
                edges.push(arista);
                break;
            }
            case 'modificarRelacion': {
                const j = edges.findIndex((e) => e.id === op.id);
                edges[j] = { ...edges[j], source: resolver(op.despues.origen), target: resolver(op.despues.destino), data: { ...edges[j].data, ...op.datos } };
                break;
            }
            case 'eliminarRelacion':
                edges = edges.filter((e) => e.id !== op.id);
                break;
            default:
                break;
        }
    });
    return { estado: { ...estado, nodes, edges }, problemas };
};
