# Despliegue en Cloudflare

Esta variante mantiene la interfaz y las rutas usadas por KORDIS, reemplazando el servidor persistente de Railway por Cloudflare Workers y los archivos de `/data` por D1.

## Recursos

- Worker: `crusec-bodega`
- D1: `crusec-bodega`
- Assets: `public/`
- Cron: sincronización horaria con Relbase

## Preparación

1. Crear la base D1:
   `npx wrangler d1 create crusec-bodega`
2. Copiar el `database_id` devuelto a `wrangler.jsonc`.
3. Aplicar el esquema:
   `npm run cf:migrate:remote`
4. Configurar como secretos:
   - `RELBASE_CLIENT_ID`
   - `RELBASE_CLIENT_SECRET`
   - `RELBASE_REDIRECT_URI`
   - `APP_ACCESS_USER`
   - `APP_ACCESS_PASSWORD`
   - `ADMIN_PIN`
   - `DATA_ENCRYPTION_KEY`
5. Desplegar con `npm run cf:deploy`.

Nunca se deben guardar claves reales en Git. `.dev.vars` está excluido del repositorio y se usa únicamente para pruebas locales.

## Migración de datos

Antes de retirar Railway, obtener de la aplicación activa:

- `/api/products?filter=all&q=`: catálogo, ubicaciones y responsables.
- `/api/history?limit=500`: historial disponible.

Los datos se importan temporalmente mediante `POST /api/admin/import`, protegido por autenticación HTTP y `ADMIN_PIN`. Después se compara el conteo de productos y ubicaciones en ambos entornos.

El OAuth de Relbase se autoriza nuevamente desde `/auth/login`; el nuevo token se guarda cifrado en D1. El secreto de cifrado permanece exclusivamente en Cloudflare Secrets.

Railway no debe apagarse hasta verificar:

1. Inicio y protección HTTP.
2. Conteo de productos.
3. Ubicaciones normales y especiales.
4. Historial.
5. Sincronización Relbase.
6. Exportación Excel.
