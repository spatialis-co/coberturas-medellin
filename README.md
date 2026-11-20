# coberturas-medellin

Visor de **coberturas de la tierra CORINE Land Cover** del municipio de Medellín, con consulta espacial por radio resuelta **íntegramente en el navegador**.

Demo de [Spatialis S.A.S.](https://spatialis.co) · <https://spatialis-co.github.io/coberturas-medellin/>

## Qué demuestra

Que un análisis geoespacial real —intersección de polígonos y cálculo de áreas— no siempre necesita servidor. Esta demo parte de un stack completo (PostGIS + FastAPI + GeoServer sobre Docker) y entrega el mismo resultado como sitio estático: sin base de datos, sin API, sin contenedores y sin claves.

Para un cliente eso significa una demo que abre en un enlace, no caduca y no cuesta infraestructura. Para un proyecto real, el criterio es el inverso y conviene decirlo: con millones de geometrías, datos que cambian o reglas de negocio, el cálculo vuelve al servidor. El valor aquí es saber dónde está esa frontera.

| Antes (servidor) | Ahora (navegador) |
|---|---|
| GeoServer WMS | La capa se dibuja como GeoJSON en el cliente |
| `POST /api/intersect` (PostGIS `ST_Intersection`) | [`polygon-clipping`](https://github.com/mfogel/polygon-clipping) sobre los 425 polígonos |
| `GET /api/stats` (`SUM() OVER()`) | Se agrega en el navegador al cargar la capa |
| `GET /api/health` | Ya no hace falta |

La consulta completa —425 intersecciones, áreas y porcentajes— se resuelve en unas decenas de milisegundos.

## Vistas

- **Mapa** — Leaflet con base OpenStreetMap y las coberturas coloreadas por nivel 3. Clic en el mapa + radio ajustable → círculo de consulta, recorte de las coberturas que cruza, tabla con hectáreas y porcentaje, y un **anillo estadístico en D3** alrededor del círculo, con los mismos colores de la leyenda.
- **Tablero** — tarjetas de indicadores (área de estudio, coberturas nivel 3, cobertura dominante, porcentaje de área natural) y gráficas de barras en D3 por nivel 1 y por nivel 3.

Leyenda de 23 coberturas agrupadas por nivel 1 y colapsables, presente junto al mapa.

## Datos

| Archivo | Entidades | Tamaño | Atributos |
|---|---|---|---|
| `data/clc-medellin.geojson` | 425 polígonos | 1,1 MB (297 KB servido comprimido) | `codigo`, `nivel1`, `nivel3`, `cobertura`, `area_ha` |

Fuente: coberturas CORINE Land Cover adaptadas para Colombia (IDEAM), recorte del municipio de Medellín.

`tools/gpkg_a_geojson.py` reconstruye el archivo desde el GeoPackage original. Un `.gpkg` es una base SQLite, así que el script **no necesita GDAL**: lee la tabla con el módulo `sqlite3` de la biblioteca estándar e interpreta la geometría WKB a mano.

```bash
python3 tools/gpkg_a_geojson.py data/clc-medellin.geojson
```

Simplifica con Douglas-Peucker a ~4 m y redondea a 6 decimales: la mitad de vértices y, medido, **0,001 % de diferencia en el área total**. La geometría viene en EPSG:4686 (MAGNA-SIRGAS) y se sirve tal cual como 4326, porque entre ambos datums en Colombia la diferencia está por debajo del metro, muy por debajo de la precisión de la propia cartografía.

### Cómo se miden las áreas

Áreas geodésicas por exceso esférico sobre la **esfera autálica de WGS84** (R = 6 371 007,2 m), la que tiene la misma superficie que el elipsoide. El script de preparación y el navegador usan exactamente la misma fórmula, así que el tablero, la tabla de resultados y el anillo no pueden desacordarse entre sí.

El proyecto original medía en EPSG:9377 y obtenía 37 344 ha; aquí salen 37 489 ha. La diferencia, 0,4 %, es de método, no de dato: una proyección cartográfica no conserva áreas exactamente. El reparto relativo coincide —la cobertura dominante da 25,1 % del área en ambos.

## Colores

Un tono fijo por nivel 1 y la luminosidad creciente según la posición del código dentro de su grupo, que es como CORINE agrupa oficialmente (las subcategorías de una familia comparten matiz). Se calcula con una fórmula, no con una lista de 23 colores a mano: mapa, leyenda, tabla, anillo y gráficas salen siempre del mismo sitio.

Varios `codigo` comparten `nivel3` (por ejemplo `31111` y `31121` caen ambos en «3.1.1. Bosque denso»), así que todo se agrupa por nivel 3 antes de asignar color.

## Cómo está hecho

Páginas estáticas. Leaflet, D3 y polygon-clipping se cargan desde CDN; no hay que instalar ni compilar nada.

```bash
python3 -m http.server 8779
```

y abrir <http://localhost:8779>.

Dentro de un `iframe` el visor activa el gesto cooperativo: la rueda del ratón desplaza la página y solo hace zoom con `Ctrl`. Por debajo de 860 px el panel pasa a hoja inferior y los objetivos táctiles crecen a 44 px.

## Identidad

Interfaz alineada al sistema oficial de spatialis.co: reparto de color 60-30-10 (superficies neutras, azul corporativo `#0068B5`/`#0071C5`/`#00C7FD`, acento esmeralda `#34D399`), tipografías Nunito y JetBrains Mono, e isotipo oficial. `assets/spatialis-ui.css` es la misma hoja que usan los demás demos de Spatialis.

## Licencia

Código de demostración, todos los derechos reservados. Consulta el archivo `LICENSE`. Las librerías de terceros conservan sus propias licencias y los datos CORINE Land Cover son del IDEAM.

## Contacto

Spatialis S.A.S. · <https://spatialis.co> · desarrollo@spatialis.com.co
