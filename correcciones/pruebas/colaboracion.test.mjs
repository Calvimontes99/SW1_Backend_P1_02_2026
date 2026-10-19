// Pruebas de la colaboración con la IA que no necesitan base de datos (npm test).
// Las que necesitan el servidor y PostgreSQL están en integracion-colaboracion.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aplicarOps, opsEntre, fusionarOps } from '../../src/colaboracion/operacionesDiagrama.js';
import { aplicarOperaciones, firmaArista, firmaNodo, operacionesPropuestas } from '../../src/colaboracion/diagramaSemantico.js';
import { conCandado } from '../../src/colaboracion/candado.js';

const clase = (id, nombre, attrs = [], extra = {}) => ({ id, type: 'classNode', position: { x: 0, y: 0 }, data: { className: nombre, attributes: attrs, methods: [], ...extra } });
const relacion = (id, source, target, tipo = 'Association') => ({ id, source, target, type: 'umlEdge', data: { type: tipo } });

test('operaciones: un borrado es explícito y una edición posterior no lo resucita', () => {
  const estado = { nodes: [clase('A', 'Cliente'), clase('B', 'Venta')], edges: [relacion('e1', 'A', 'B')] };
  const ops = opsEntre(estado, { nodes: [clase('A', 'Cliente')], edges: [] });
  const otro = aplicarOps(estado, ops);
  assert.deepEqual(otro.nodes.map((n) => n.id), ['A']);
  const despues = aplicarOps(otro, [{ op: 'ponerNodo', nodo: clase('A', 'Cliente', ['email']) }]);
  assert.deepEqual(despues.nodes.map((n) => n.id), ['A']);
});

test('operaciones: "borrar B" y después "crear A→B" no deja una relación colgando', () => {
  const r = aplicarOps({ nodes: [clase('A', 'Cliente'), clase('B', 'Venta')], edges: [] },
    [{ op: 'quitarNodo', id: 'B' }, { op: 'ponerArista', arista: relacion('e1', 'A', 'B') }]);
  assert.equal(r.edges.length, 0);
});

test('operaciones: los movimientos seguidos se juntan', () => {
  const lista = fusionarOps([{ op: 'moverNodo', id: 'A', position: { x: 1, y: 1 } }], [{ op: 'moverNodo', id: 'A', position: { x: 2, y: 2 } }]);
  assert.equal(lista.length, 1);
  assert.deepEqual(lista[0].position, { x: 2, y: 2 });
});

test('propuesta: borrar una clase no se lleva una relación que alguien agregó después', () => {
  const antes = { nodes: [clase('A', 'Cliente'), clase('B', 'Venta')], edges: [] };
  const propuesta = operacionesPropuestas(antes, { nodes: [clase('A', 'Cliente')], edges: [] }); // borrar B
  const ahora = { ...antes, edges: [relacion('e9', 'A', 'B')] }; // alguien conectó A→B después
  const r = aplicarOperaciones(ahora, propuesta);
  assert.equal(r.estado, null);
  assert.match(r.problemas.join(' '), /agregó la relación/);
});

test('propuesta: borrar una clase no se lleva una relación modificada después', () => {
  const antes = { nodes: [clase('A', 'Cliente'), clase('B', 'Venta')], edges: [relacion('e1', 'A', 'B')] };
  const propuesta = operacionesPropuestas(antes, { nodes: [clase('A', 'Cliente')], edges: [] }); // borra B y e1
  const ahora = { ...antes, edges: [relacion('e1', 'A', 'B', 'Composition')] }; // otro cambió e1
  const r = aplicarOperaciones(ahora, propuesta);
  assert.equal(r.estado, null);
  assert.equal(ahora.edges.length, 1, 'el estado recibido no se modifica');
});

test('propuesta: se valida todo antes de tocar nada (ningún cambio parcial)', () => {
  const antes = { nodes: [clase('A', 'Cliente'), clase('B', 'Venta')], edges: [] };
  const propuesta = [
    { op: 'modificarClase', id: 'A', antes: firmaNodo(clase('A', 'Cliente')), despues: firmaNodo(clase('A', 'Cliente', ['email'])) },
    { op: 'modificarClase', id: 'B', antes: firmaNodo(clase('B', 'Viejo')), despues: firmaNodo(clase('B', 'Venta', ['total'])) },
  ];
  const r = aplicarOperaciones(antes, propuesta);
  assert.equal(r.estado, null);
  assert.equal(r.problemas.length, 1);
});

test('propuesta: reintentar una ya aplicada (tras un corte) no duplica clases ni relaciones', () => {
  const antes = { nodes: [clase('A', 'Cliente')], edges: [] };
  const despues = { nodes: [clase('A', 'Cliente', ['email']), clase('P', 'Producto', ['nombre'])], edges: [relacion('e1', 'A', 'P')] };
  const propuesta = operacionesPropuestas(antes, despues);
  const primera = aplicarOperaciones(antes, propuesta);
  assert.deepEqual(primera.problemas, []);
  const segunda = aplicarOperaciones(primera.estado, propuesta);
  assert.deepEqual(segunda.problemas, []);
  assert.equal(segunda.estado.nodes.length, 2);
  assert.equal(segunda.estado.edges.length, 1);
});

test('propuesta: quitar el estereotipo abstract borra la clave', () => {
  const abstracta = clase('Z', 'Figura', [], { stereotype: 'abstract' });
  const r = aplicarOperaciones({ nodes: [abstracta], edges: [] },
    [{ op: 'modificarClase', id: 'Z', antes: firmaNodo(abstracta), despues: { ...firmaNodo(abstracta), estereotipo: null } }]);
  assert.equal('stereotype' in r.estado.nodes[0].data, false);
});

test('propuesta: una relación modificada no puede apuntar a una clase inexistente', () => {
  const estado = { nodes: [clase('A', 'Cliente'), clase('B', 'Venta')], edges: [relacion('e1', 'A', 'B')] };
  const r = aplicarOperaciones(estado, [{ op: 'modificarRelacion', id: 'e1', antes: firmaArista(estado.edges[0]), despues: { ...firmaArista(estado.edges[0]), destino: 'NO' }, datos: {} }]);
  assert.equal(r.estado, null);
});

test('candado: lo de una misma sala va en fila; otra sala no espera', async () => {
  const orden = [];
  const tarea = (nombre, ms) => () => new Promise((r) => setTimeout(() => { orden.push(nombre); r(nombre); }, ms));
  await Promise.all([
    conCandado(1, tarea('sala1-a', 30)),
    conCandado(1, tarea('sala1-b', 1)),
    conCandado(2, tarea('sala2', 5)),
  ]);
  assert.ok(orden.indexOf('sala1-a') < orden.indexOf('sala1-b'), 'en la misma sala, en orden');
  assert.ok(orden.indexOf('sala2') < orden.indexOf('sala1-a'), 'otra sala no espera');
  // Un error no traba la fila
  await assert.rejects(conCandado(3, async () => { throw new Error('falla'); }));
  assert.equal(await conCandado(3, async () => 'sigue'), 'sigue');
});

// ── Auditoría del 14/10/2026 ──
import { crearAplicarAtomico, crearGuardarSala } from '../../src/colaboracion/aplicarAtomico.js';
import { crearFila } from '../../src/colaboracion/candado.js';

test('12) reaplicar una propuesta cuyo id chocó no duplica la clase', () => {
  const antes = { nodes: [clase('A', 'Cliente')], edges: [] };
  const propuesta = operacionesPropuestas(antes, { nodes: [clase('A', 'Cliente'), clase('P', 'Producto')], edges: [] });
  const concurrente = { nodes: [clase('A', 'Cliente'), clase('P', 'Proveedor')], edges: [] }; // otro usó el id P
  const primera = aplicarOperaciones(concurrente, propuesta);
  assert.deepEqual(primera.problemas, []);
  const segunda = aplicarOperaciones(primera.estado, propuesta);
  assert.deepEqual(segunda.problemas, []);
  const nombres = segunda.estado.nodes.map((n) => n.data.className).sort();
  assert.deepEqual(nombres, ['Cliente', 'Producto', 'Proveedor']);
  assert.equal(segunda.estado.nodes.find((n) => n.data.className === 'Producto').id, 'P~ia1', 'id alternativo determinista');
});

/** Base de datos de mentira: registra consultas y puede fallar en el UPDATE del diagrama. */
const poolDePrueba = ({ falla = false } = {}) => {
  const registro = [];
  return {
    registro,
    async connect() {
      return {
        async query(sql) {
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) { registro.push(sql); return { rows: [] }; }
          if (sql.includes('UPDATE "Salas"')) {
            registro.push('UPDATE Salas');
            if (falla) throw new Error('fallo de escritura de prueba');
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`consulta inesperada: ${sql.slice(0, 40)}`);
        },
        release() { registro.push('release'); },
      };
    },
  };
};

const prepararAtomico = (pool) => {
  const sala = { ultimoEstado: { nodes: [], edges: [] }, bloqueada: false, enEspera: [] };
  const confirmados = [];
  const aplicar = crearAplicarAtomico({
    pool,
    guardarCambio: async (fila) => ({ ...fila, id: 1 }),
    filasDeCambio: () => [{ resumen: 'agregó A' }],
    serializarLotes: () => ({}),
    alConfirmar: (salaId, s, antes, despues) => { s.ultimoEstado = despues; confirmados.push(despues); },
    drenar: (salaId, s) => { while (!s.bloqueada && s.enEspera.length) s.enEspera.shift()(); },
  });
  return { sala, confirmados, aplicar };
};

test('2) si falla el guardado de una propuesta, no cambia nada y no queda aceptada', async () => {
  const pool = poolDePrueba({ falla: true });
  const { sala, confirmados, aplicar } = prepararAtomico(pool);
  let cerrada = false;
  const r = await aplicar(7, sala, {
    autor: { esIA: true, nombre: 'IA' },
    calcular: () => ({ estado: { nodes: [clase('A')], edges: [] }, problemas: [] }),
    alGuardar: async () => { cerrada = true; return { id: 1, estado: 'aceptada' }; },
  });
  assert.equal(r.aplicada, false);
  assert.ok(r.error);
  assert.equal(cerrada, false, 'el cierre no llegó a ejecutarse');
  assert.deepEqual(sala.ultimoEstado.nodes, [], 'la memoria no cambió');
  assert.equal(confirmados.length, 0, 'no se envió nada a los demás');
  assert.deepEqual(pool.registro, ['BEGIN', 'UPDATE Salas', 'ROLLBACK', 'release']);
  assert.equal(sala.bloqueada, false);
});

test('2b) mientras se guarda, los cambios que llegan esperan y se aplican después en orden', async () => {
  const pool = poolDePrueba();
  const { sala, aplicar } = prepararAtomico(pool);
  const orden = [];
  const promesa = aplicar(7, sala, {
    autor: { esIA: true, nombre: 'IA' },
    calcular: () => ({ estado: { nodes: [clase('A')], edges: [] }, problemas: [] }),
    alGuardar: async () => {
      // Llega un cambio de otra persona en medio de la transacción: debe esperar
      assert.equal(sala.bloqueada, true);
      sala.enEspera.push(() => orden.push('cambio en espera'));
      return { id: 1, estado: 'aceptada' };
    },
  });
  const r = await promesa;
  orden.push('fin');
  assert.equal(r.aplicada, true);
  assert.deepEqual(sala.ultimoEstado.nodes.map((n) => n.id), ['A']);
  assert.deepEqual(orden, ['cambio en espera', 'fin'], 'se drenó al terminar');
  assert.deepEqual(pool.registro, ['BEGIN', 'UPDATE Salas', 'COMMIT', 'release']);
});

/** Base con UNA sala que respeta la versión condicional; `retener` demora el próximo UPDATE fuera de transacción. */
const baseConVersion = () => {
  const fila = { xml: null, version: 0 };
  let retenida = null;
  const escribir = ([, xml, , version]) => {
    if (!(fila.version < version)) return { rows: [], rowCount: 0 };
    fila.xml = JSON.parse(xml); fila.version = version;
    return { rows: [], rowCount: 1 };
  };
  return {
    fila,
    retener() { let soltar; const espera = new Promise((r) => { soltar = r; }); retenida = espera; return soltar; },
    async query(sql, params) {
      assert.match(sql, /version_guardada < \$4/);
      if (retenida) { const espera = retenida; retenida = null; await espera; }
      return escribir(params);
    },
    async connect() {
      return { async query(sql, params) { return sql.includes('UPDATE "Salas"') ? escribir(params) : { rows: [] }; }, release() {} };
    },
  };
};

const prepararSalaConVersion = (pool, escrituraEnTurno) => {
  const sala = { ultimoEstado: { nodes: [clase('A')], edges: [] }, version: 1, bloqueada: false, enEspera: [] };
  const dependencias = { pool, serializarLotes: () => ({}), escrituraEnTurno };
  const guardar = crearGuardarSala(dependencias);
  const aplicar = crearAplicarAtomico({
    ...dependencias,
    guardarCambio: async (f) => f,
    filasDeCambio: () => [],
    alConfirmar: (salaId, s, antes, despues, autor, guardadas, version) => { s.ultimoEstado = despues; s.version = Math.max(s.version, version); },
    drenar: () => {},
  });
  const agregarB = {
    autor: { esIA: true, nombre: 'IA' },
    calcular: (estado) => ({ estado: { nodes: [...estado.nodes, clase('B')], edges: [] }, problemas: [] }),
    alGuardar: async () => ({ id: 1, estado: 'aceptada' }),
  };
  return { sala, guardar, aplicar, agregarB };
};

test('V1) un autoguardado que empezó antes de aceptar una propuesta no la pisa (misma fila de escrituras)', async () => {
  const pool = baseConVersion();
  const { sala, guardar, aplicar, agregarB } = prepararSalaConVersion(pool, crearFila());
  const soltar = pool.retener(); // la base tarda en escribir el autoguardado
  const autoguardado = guardar(7, sala);
  const propuesta = aplicar(7, sala, agregarB); // espera su turno
  soltar();
  await autoguardado;
  assert.equal((await propuesta).aplicada, true);
  await guardar(7, sala); // otro autoguardado después: escribe lo mismo o nada
  assert.deepEqual(pool.fila.xml.nodes.map((n) => n.id), ['A', 'B'], 'la base conserva la propuesta');
  assert.equal(pool.fila.version, 2);
});

test('V1b) aunque una escritura vieja llegue a la base después del COMMIT, la versión condicional la rechaza', async () => {
  const pool = baseConVersion();
  const { sala, guardar, aplicar, agregarB } = prepararSalaConVersion(pool); // sin fila: solo la versión protege
  const soltar = pool.retener();
  const atrasado = guardar(7, sala); // leyó {A} con versión 1 y queda esperando en la base
  assert.equal((await aplicar(7, sala, agregarB)).aplicada, true);
  soltar();
  await atrasado;
  assert.deepEqual(pool.fila.xml.nodes.map((n) => n.id), ['A', 'B']);
  assert.equal(pool.fila.version, 2);
});
