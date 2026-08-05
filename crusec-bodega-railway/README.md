# Crusec Bodega — versión Railway

Esta es la base de la versión final. Mantiene la interfaz aprobada y separa claramente:

- **Catálogo**: por ahora productos de demostración; después vendrá desde Relbase en modo solo lectura.
- **Ubicaciones**: se guardan en `locations.json` en el servidor y son compartidas por PC y celulares.

## Probar localmente

1. Tener Node.js 20 o superior.
2. Ejecutar `npm start`.
3. Abrir `http://localhost:3000`.

SKUs demo: `C02140`, `P00240`, `Y00120`.

## Railway

La app está preparada para Railway. Para que las ubicaciones sobrevivan a reinicios o nuevos deploys, hay que agregar un **Volume** y montarlo en `/data`, luego configurar:

`DATA_DIR=/data`

Sin Volume, varios dispositivos verán los mismos cambios mientras el servidor esté vivo, pero un redeploy podría borrar esos cambios.

## Relbase

Relbase está desactivado intencionalmente. `src/relbase.js` es el único conector que habrá que adaptar cuando tengamos la aplicación API real y confirmemos endpoints/scopes.

La integración debe ser de **solo lectura**. Las ubicaciones nunca se escriben en Relbase.

Las credenciales deben configurarse como variables privadas del hosting, nunca dentro de `public/`, GitHub o el código fuente.

## Dominio

Primero se despliega y prueba con la URL temporal de Railway. Al final se crea `bodega.crusec.cl` en DNS apuntando al dominio que entregue Railway.
