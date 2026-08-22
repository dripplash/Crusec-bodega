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
CATALOG_MODE=relbase
DATA_DIR=/data
AUTO_SYNC_ENABLED=true
AUTO_SYNC_ON_START=true
SYNC_INTERVAL_MINUTES=30
RELBASE_SAFETY_MAX_PAGES=10000
RELBASE_MAIN_WAREHOUSE_ID=2881
```

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

## Verificación técnica

```bash
npm install
npm run check
npm start
```

El servidor usa Node.js 20 o superior.
