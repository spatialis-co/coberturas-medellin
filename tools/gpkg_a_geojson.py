#!/usr/bin/env python3
"""Convierte el GeoPackage de CORINE Land Cover a GeoJSON servible estatico.

Un .gpkg es una base SQLite, asi que no hace falta GDAL: se lee con el modulo
sqlite3 de la biblioteca estandar y se interpreta la geometria WKB a mano.

La capa viene en EPSG:4686 (MAGNA-SIRGAS). Para un visor web se entrega tal
cual como 4326: la diferencia entre ambos datums en Colombia esta por debajo
del metro, muy por debajo de la precision de la propia cartografia CLC.
"""
import json
import math
import os
import sqlite3
import struct
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))

TOLERANCIA = 0.00004   # ~4 m en el ecuador
PRECISION = 6          # ~0,1 m


# --------------------------------------------------------------- WKB

def leer_geometria_gpkg(blob):
    """Devuelve la geometria GeoJSON de un blob GeoPackage.

    Cabecera GPKG: 'GP' + version + flags + srs_id + envelope opcional,
    y a continuacion el WKB estandar.
    """
    if blob[:2] != b"GP":
        raise ValueError("no es una geometria GeoPackage")
    flags = blob[3]
    tipo_envelope = (flags >> 1) & 0x07
    dobles = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}[tipo_envelope]
    desplazamiento = 8 + dobles * 8
    return leer_wkb(blob, desplazamiento)[0]


def leer_wkb(datos, pos):
    orden = "<" if datos[pos] == 1 else ">"
    pos += 1
    (tipo,) = struct.unpack_from(orden + "I", datos, pos)
    pos += 4
    tipo_base = tipo % 1000

    if tipo_base == 3:      # Polygon
        anillos, pos = leer_poligono(datos, pos, orden)
        return {"type": "Polygon", "coordinates": anillos}, pos

    if tipo_base == 6:      # MultiPolygon
        (n,) = struct.unpack_from(orden + "I", datos, pos)
        pos += 4
        polis = []
        for _ in range(n):
            geom, pos = leer_wkb(datos, pos)
            polis.append(geom["coordinates"])
        return {"type": "MultiPolygon", "coordinates": polis}, pos

    raise ValueError("tipo de geometria no soportado: %d" % tipo_base)


def leer_poligono(datos, pos, orden):
    (n_anillos,) = struct.unpack_from(orden + "I", datos, pos)
    pos += 4
    anillos = []
    for _ in range(n_anillos):
        (n_puntos,) = struct.unpack_from(orden + "I", datos, pos)
        pos += 4
        crudos = struct.unpack_from(orden + "%dd" % (n_puntos * 2), datos, pos)
        pos += n_puntos * 16
        anillos.append([[crudos[i], crudos[i + 1]] for i in range(0, len(crudos), 2)])
    return anillos, pos


# ------------------------------------------------- simplificacion

def distancia_perpendicular(p, a, b):
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplificar(puntos, tol):
    """Douglas-Peucker iterativo."""
    if len(puntos) < 3:
        return puntos[:]
    conservar = [False] * len(puntos)
    conservar[0] = conservar[-1] = True
    pila = [(0, len(puntos) - 1)]
    while pila:
        i, j = pila.pop()
        if j - i < 2:
            continue
        peor, idx = -1.0, i
        for k in range(i + 1, j):
            d = distancia_perpendicular(puntos[k], puntos[i], puntos[j])
            if d > peor:
                peor, idx = d, k
        if peor > tol:
            conservar[idx] = True
            pila.append((i, idx))
            pila.append((idx, j))
    return [p for p, k in zip(puntos, conservar) if k]


def limpiar_anillo(anillo, tol):
    s = simplificar(anillo, tol)
    if len(s) < 4:
        s = anillo[:]
    s = [[round(x, PRECISION), round(y, PRECISION)] for x, y in s]
    ded = [s[0]]
    for p in s[1:]:
        if p != ded[-1]:
            ded.append(p)
    if ded[0] != ded[-1]:
        ded.append(ded[0])
    return ded if len(ded) >= 4 else None


def limpiar_geometria(geom, tol):
    polis = ([geom["coordinates"]] if geom["type"] == "Polygon"
             else geom["coordinates"])
    salida = []
    for poli in polis:
        anillos = []
        for i, anillo in enumerate(poli):
            limpio = limpiar_anillo(anillo, tol)
            if limpio is None:
                if i == 0:
                    anillos = []
                    break
                continue
            anillos.append(limpio)
        if anillos:
            salida.append(anillos)
    if not salida:
        return None
    if len(salida) == 1:
        return {"type": "Polygon", "coordinates": salida[0]}
    return {"type": "MultiPolygon", "coordinates": salida}


# ------------------------------------------------------------ area

# Radio autalico de WGS84: la esfera con la misma superficie que el elipsoide.
# Turf usa el radio ecuatorial (6378137), que sobreestima el area un 0,22 %.
RADIO = 6371007.2


def area_anillo(anillo):
    """Area geodesica por exceso esferico, en m²."""
    total = 0.0
    n = len(anillo) - 1
    if n < 3:
        return 0.0
    for i in range(n):
        x1, y1 = anillo[i]
        x2, y2 = anillo[(i + 1) % n]
        total += math.radians(x2 - x1) * (
            2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2))
        )
    return abs(total * RADIO * RADIO / 2.0)


def area_geometria(geom):
    polis = ([geom["coordinates"]] if geom["type"] == "Polygon"
             else geom["coordinates"])
    total = 0.0
    for poli in polis:
        for i, anillo in enumerate(poli):
            a = area_anillo(anillo)
            total += a if i == 0 else -a
    return total


# ------------------------------------------------------------ main

def main(destino):
    ruta = os.path.join(AQUI, "CLC_Medellin.gpkg")
    con = sqlite3.connect(ruta)
    filas = con.execute(
        "select fid, codigo, leyenda, nivel_1, nivel_3, geom from CLC_Medellin"
    ).fetchall()

    feats = []
    vertices_antes = vertices_despues = 0
    area_total = 0.0

    for fid, codigo, leyenda, nivel1, nivel3, blob in filas:
        geom = leer_geometria_gpkg(blob)
        vertices_antes += contar(geom)
        limpio = limpiar_geometria(geom, TOLERANCIA)
        if limpio is None:
            sys.stderr.write("descartado fid=%s (geometria vacia al simplificar)\n" % fid)
            continue
        vertices_despues += contar(limpio)
        area = area_geometria(limpio)
        area_total += area
        feats.append({
            "type": "Feature",
            "id": fid,
            "properties": {
                "codigo": str(codigo),
                "nivel1": str(codigo)[0],
                "nivel1_nombre": nivel1 or "",
                "nivel3": nivel3 or "",
                "cobertura": leyenda or "",
                "area_ha": round(area / 10000.0, 4),
            },
            "geometry": limpio,
        })

    fc = {
        "type": "FeatureCollection",
        "name": "clc_medellin",
        "attribution": "CORINE Land Cover - IDEAM",
        "features": feats,
    }

    with open(destino, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False, separators=(",", ":"))

    tam = os.path.getsize(destino)
    print("coberturas: %d" % len(feats))
    print("vertices:   %d -> %d (%.0f%% menos)"
          % (vertices_antes, vertices_despues,
             100 * (1 - vertices_despues / vertices_antes)))
    print("area total: %.1f ha" % (area_total / 10000.0))
    print("salida:     %.0f KB -> %s" % (tam / 1024, destino))


def contar(geom):
    polis = ([geom["coordinates"]] if geom["type"] == "Polygon"
             else geom["coordinates"])
    return sum(len(a) for p in polis for a in p)


if __name__ == "__main__":
    main(sys.argv[1])
