/**
 * Conector Relbase (solo lectura).
 *
 * Se deja deliberadamente sin implementar hasta contar con la aplicación API
 * real y confirmar versión, endpoints y scopes. De esta forma esta versión
 * NO puede modificar ni consultar accidentalmente datos reales de Relbase.
 *
 * Cuando estén las credenciales, este módulo será el único lugar que habrá
 * que adaptar para devolver productos normalizados con esta forma:
 * { relbaseId, sku, name, barcode, brand, active, stock, stockUpdatedAt }
 */
async function listProducts() {
  throw new Error('Conector Relbase pendiente de configurar.');
}

module.exports = { listProducts };
