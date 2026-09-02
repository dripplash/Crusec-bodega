# KORDIS · Warehouse Management System

Versión candidata a producción basada en el último MAIN estable del proyecto.

## Estructura

La carpeta que debe quedar configurada como **Root Directory** en Railway sigue siendo:

`crusec-bodega-railway`

No es necesario cambiar la URL actual ni recrear el proyecto Railway.

## Funciones incluidas

- Búsqueda por SKU, código de barras o nombre.
- Stock leído desde Relbase.
- Stock de la bodega principal usando `product.inventories` y `RELBASE_MAIN_WAREHOUSE_ID`.
- Asignación de ubicación física:
  - Pasillo 1–6
  - Lado izquierdo/derecho
  - Rack 1–11
  - Nivel 1–5
- Ubicaciones especiales.
- Historial de cambios.
- Inventario.
- Exportación Excel real por pasillo con `xlsx`.
- OAuth de Relbase.
- Sincronización manual y automática.
- Barra de progreso de sincronización.
- Caché persistente de productos.
- Persistencia en `/data`.
- Mapa vectorial de racks, nítido en pantallas HD/4K.
- Perfil simple de usuario KORDIS, sin contraseña, guardado en el navegador.
- Interfaz responsive para escritorio y móvil.
- Favicon y app icon KORDIS renovados.

## Variables Railway recomendadas

```text
NODE_ENV=production
CATALOG_MODE=relbase
DATA_DIR=/data
AUTO_SYNC_ENABLED=true
AUTO_SYNC_ON_START=true
SYNC_INTERVAL_MINUTES=30
RELBASE_SAFETY_MAX_PAGES=10000
RELBASE_MAIN_WAREHOUSE_ID=2881
MAX_BODY_BYTES=65536
REQUIRE_APP_ACCESS=true
```

Acceso y administración (guardar como secretos sellados en Railway):

```text
APP_ACCESS_USER
APP_ACCESS_PASSWORD
ADMIN_PIN
```

`APP_ACCESS_USER` y `APP_ACCESS_PASSWORD` activan la protección HTTP de toda la aplicación. El endpoint `/healthz` queda público únicamente para que Railway valide el despliegue. `ADMIN_PIN` no tiene valor predeterminado y se usa solo en operaciones administrativas.

OAuth:

```text
RELBASE_BASE_URL
RELBASE_CLIENT_ID
RELBASE_CLIENT_SECRET
RELBASE_REDIRECT_URI
RELBASE_SCOPES
```

El redirect actual puede mantenerse:

`https://crusec-bodega.up.railway.app/auth/callback`

Scopes:

```text
products:read inventory:read warehouses:read
```

## Antes de subir

1. No borrar el proyecto Railway.
2. No borrar ni reemplazar manualmente el volumen `/data`.
3. Mantener `crusec-bodega-railway` como Root Directory.
4. Verificar que `RELBASE_MAIN_WAREHOUSE_ID=2881` siga configurado.
5. Después del deploy, revisar `/api/status`.
6. Si Relbase aparece no autorizado, entrar a `/auth/login`.
7. Ejecutar una sincronización manual desde KORDIS.
8. Comparar al menos 5 productos contra Relbase antes de dar la versión por cerrada.
9. Crear en Railway únicamente `APP_ACCESS_PASSWORD` y `ADMIN_PIN` como secretos nuevos después de verificar el despliegue. Las variables `RELBASE_*` existentes se conservan sin cambiar.

## Verificación técnica

```bash
npm install
npm run check
npm test
npm start
```

La dependencia de Excel se instala desde la distribución oficial SheetJS 0.20.3 para evitar las vulnerabilidades conocidas de la versión 0.18.5 publicada en npm.

El servidor usa Node.js 20 o superior.

## Ajustes móviles incluidos en este candidato

- El buscador y campos móviles usan tamaño de fuente seguro para evitar el zoom automático al enfocar en navegadores móviles.
- El Inventario se adapta a tarjetas en pantallas pequeñas, sin desplazamiento horizontal.
- En la ficha de producto se muestra primero el nombre y luego el SKU.
- La marca visible del sistema queda como **Crusec** por ahora.
- La flecha de la ubicación abre directamente el mapa de bodega.
- El modal del mapa muestra Pasillo, Lado, Rack y Nivel antes del plano.

## Ajustes candidato v4

- Búsqueda predictiva simplificada: muestra una sola vista previa mientras se escribe; al tener el SKU, Enter ejecuta la búsqueda directamente.
- Tarjeta de ubicación actual reorganizada en Pasillo, Lado, Rack y Nivel; la flecha y el botón abren el mapa.
- Ubicaciones: se eliminó el corte de 250 registros y se muestran todos los productos ubicados, agrupados por Pasillo 1–6 y ubicaciones especiales.
- Inventario: se eliminó el corte visual de 300 registros; se muestran todos los productos cargados desde el catálogo sincronizado con Relbase.
- Se conservan OAuth, sincronización, stock por `RELBASE_MAIN_WAREHOUSE_ID`, persistencia `/data`, Excel y el resto del motor de producción.



## Candidato v5 — optimización web y móvil

Ajustes de interfaz añadidos sin cambiar el motor de producción:

- Inventario general oculta productos cuyo stock viene `null` o sin informar para mantener la vista limpia.
- Esos productos siguen apareciendo si el usuario los busca; la búsqueda consulta `/api/products?q=...` para intentar refrescar su stock desde Relbase.
- Inventario móvil se presenta como tarjetas responsive sin desplazamiento horizontal.
- Modal del mapa con más margen, mejor altura útil y mayor separación en escritorio y móvil.
- Excel evita estirarse a la altura completa de la vista previa.
- Configuración responsive mejorada y nuevos avatares de personas.
- Optimización visual de listados largos con `content-visibility`.
