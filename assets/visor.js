/* ==========================================================================
   Coberturas de la tierra · Medellín — Spatialis S.A.S.

   Versión sin backend del visor de CORINE Land Cover. Lo que antes resolvían
   PostGIS, FastAPI y GeoServer se resuelve aquí:

     GeoServer WMS   -> la capa se dibuja como GeoJSON en el cliente
     POST /intersect -> polygon-clipping contra los 425 polígonos
     GET  /stats     -> se agrega en el navegador al cargar la capa

   Las áreas se calculan con la misma fórmula geodésica (exceso esférico
   sobre la esfera autálica de WGS84) que usó tools/gpkg_a_geojson.py al
   preparar el dato, así que el tablero, la tabla y el anillo nunca pueden
   desacordarse entre sí.
   ========================================================================== */

(function () {
  "use strict";

  var CENTRO = [6.269, -75.596];
  var DATOS = "data/clc-medellin.geojson";

  /* --- Paleta nivel 3 -----------------------------------------------------
     Mismo criterio que el proyecto original: un tono fijo por nivel 1 y la
     luminosidad creciente según la posición del código dentro de su grupo,
     igual que CORINE hace oficialmente (las subcategorías de una familia
     comparten matiz). Se recalcula en vez de mantener 23 colores a mano. */

  var NIVEL1_NOMBRES = {
    1: "Territorios artificializados",
    2: "Territorios agrícolas",
    3: "Bosques y áreas seminaturales",
    4: "Áreas húmedas",
    5: "Superficies de agua",
  };

  var NIVEL1_HUE = { 1: 345, 2: 45, 3: 100, 4: 270, 5: 195 };

  function hslAHex(h, s, l) {
    var a = s * Math.min(l, 1 - l);
    var f = function (n) {
      var k = (n + h / 30) % 12;
      var c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
      return Math.round(255 * c).toString(16).padStart(2, "0");
    };
    return "#" + f(0) + f(8) + f(4);
  }

  function colorNivel1(nivel1) {
    return hslAHex(NIVEL1_HUE[nivel1] || 0, 0.65, 0.45);
  }

  /* ------------------------------------------------------- área geodésica */

  var RADIO = 6371007.2;   // esfera autálica de WGS84
  var RAD = Math.PI / 180;

  function areaAnillo(anillo) {
    var n = anillo.length - 1;
    if (n < 3) return 0;
    var total = 0;
    for (var i = 0; i < n; i++) {
      var a = anillo[i], b = anillo[(i + 1) % n];
      total += (b[0] - a[0]) * RAD *
        (2 + Math.sin(a[1] * RAD) + Math.sin(b[1] * RAD));
    }
    return Math.abs(total * RADIO * RADIO / 2);
  }

  /* Acepta la forma de polygon-clipping: [poligono][anillo][punto] */
  function areaMulti(multi) {
    var total = 0;
    for (var p = 0; p < multi.length; p++) {
      for (var r = 0; r < multi[p].length; r++) {
        var a = areaAnillo(multi[p][r]);
        total += r === 0 ? a : -a;
      }
    }
    return total;
  }

  function aMulti(geom) {
    return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  }

  /* ------------------------------------------------- círculo geodésico */

  function circulo(lat, lon, radioM, lados) {
    lados = lados || 96;
    var anillo = [];
    var dLat = (radioM / RADIO) / RAD;
    var dLon = dLat / Math.cos(lat * RAD);
    for (var i = 0; i <= lados; i++) {
      var t = (i / lados) * 2 * Math.PI;
      anillo.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
    }
    return [[anillo]];
  }

  /* ------------------------------------------------------------- estado */

  var capa = null;          // FeatureCollection completa
  var porNivel3 = [];       // filas agregadas
  var colorPorNivel3 = {};
  var totalHa = 0;
  var map, capaClc, capaResultado, circuloLeaflet;
  var ultimaConsulta = null;

  /* ----------------------------------------------------------- agregados */

  function agregar(fc) {
    var acc = {};
    fc.features.forEach(function (f) {
      var p = f.properties;
      var clave = p.nivel1 + "|" + p.nivel3;
      if (!acc[clave]) {
        acc[clave] = {
          nivel1: p.nivel1, nivel3: p.nivel3,
          codigo: p.codigo, area_ha: 0,
        };
      }
      acc[clave].area_ha += p.area_ha;
      if (p.codigo < acc[clave].codigo) acc[clave].codigo = p.codigo;
    });
    var filas = Object.keys(acc).map(function (k) { return acc[k]; });
    var total = filas.reduce(function (s, c) { return s + c.area_ha; }, 0);
    filas.forEach(function (c) { c.pct = total > 0 ? (c.area_ha / total) * 100 : 0; });
    totalHa = total;
    return filas;
  }

  function construirPaleta(filas) {
    var grupos = {};
    filas.forEach(function (c) {
      (grupos[c.nivel1] = grupos[c.nivel1] || []).push(c);
    });
    Object.keys(grupos).forEach(function (nivel1) {
      var g = grupos[nivel1];
      g.sort(function (a, b) { return a.codigo.localeCompare(b.codigo); });
      var hue = NIVEL1_HUE[nivel1] || 0;
      g.forEach(function (fila, i) {
        var l = 0.32 + (0.4 * i) / Math.max(g.length - 1, 1);
        colorPorNivel3[fila.nivel3] = hslAHex(hue, 0.65, l);
      });
    });
  }

  /* ---------------------------------------------------------------- mapa */

  function iniciarMapa() {
    var incrustado = window.self !== window.top;

    map = L.map("map", {
      center: CENTRO,
      zoom: 12,
      minZoom: 9,
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: !incrustado,
    });

    window.spMap = map;

    /* Mapa base temático: lienzo gris de Esri (acceso anónimo), claro u oscuro
       según el tema del sitio padre. Al cambiar de tema solo se reemplaza la
       base; los polígonos de coberturas y el resultado de la consulta quedan. */
    var ESRI_CANVAS = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/";
    var TILES_TEMA = {
      light: ESRI_CANVAS + "World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      dark: ESRI_CANVAS + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    };
    var capaBase = null;
    function ponerBaseTema(tema) {
      var url = TILES_TEMA[tema] || TILES_TEMA.dark;
      if (capaBase) map.removeLayer(capaBase);
      capaBase = L.tileLayer(url, { maxZoom: 19, maxNativeZoom: 16 }).addTo(map);
      capaBase.bringToBack();
    }
    ponerBaseTema((window.SpatialisTheme && SpatialisTheme.get()) || "dark");
    window.addEventListener("spatialis:theme-change", function (e) { ponerBaseTema(e.detail.theme); });

    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomright", imperial: false, maxWidth: 110 }).addTo(map);

    capaClc = L.geoJSON(capa, {
      style: function (f) {
        return {
          color: "#0b1424",
          weight: 0.4,
          opacity: 0.7,
          fillColor: colorPorNivel3[f.properties.nivel3] || "#777",
          fillOpacity: 0.78,
        };
      },
      onEachFeature: function (f, c) {
        c.bindTooltip(f.properties.nivel3, { sticky: true, className: "sp-rotulo-tt" });
      },
    }).addTo(map);

    capaResultado = L.layerGroup().addTo(map);

    map.on("mousemove", function (e) { SP.coordenadas(e.latlng.lng, e.latlng.lat); });
    map.on("click", function (e) { consultar(e.latlng.lat, e.latlng.lng); });
  }

  /* --------------------------------------------------- consulta espacial */

  function consultar(lat, lon) {
    var radio = parseInt(document.getElementById("radio").value, 10);
    var t0 = performance.now();

    var consulta = circulo(lat, lon, radio);
    var areaConsulta = areaMulti(consulta);
    var acc = {};
    var piezas = [];

    for (var i = 0; i < capa.features.length; i++) {
      var f = capa.features[i];
      var corte;
      try {
        corte = polygonClipping.intersection(consulta, aMulti(f.geometry));
      } catch (err) {
        continue;   // geometría degenerada: se omite, no se rompe la consulta
      }
      if (!corte || !corte.length) continue;

      var area = areaMulti(corte);
      if (area <= 0) continue;

      var n3 = f.properties.nivel3;
      if (!acc[n3]) {
        acc[n3] = { nivel3: n3, nivel1: f.properties.nivel1, area_ha: 0 };
      }
      acc[n3].area_ha += area / 10000;
      piezas.push({ tipo: "MultiPolygon", coordinates: corte, nivel3: n3 });
    }

    var filas = Object.keys(acc).map(function (k) { return acc[k]; });
    var sumaHa = filas.reduce(function (s, c) { return s + c.area_ha; }, 0);
    filas.forEach(function (c) { c.pct = sumaHa > 0 ? (c.area_ha / sumaHa) * 100 : 0; });
    filas.sort(function (a, b) { return b.area_ha - a.area_ha; });

    var ms = Math.round(performance.now() - t0);
    ultimaConsulta = { lat: lat, lon: lon, radio: radio, filas: filas };

    dibujarResultado(lat, lon, radio, piezas);
    pintarResultado(filas, sumaHa, ms);
  }

  function dibujarResultado(lat, lon, radio, piezas) {
    capaResultado.clearLayers();

    circuloLeaflet = L.circle([lat, lon], {
      radius: radio,
      color: "#34d399",
      weight: 2,
      fill: false,
      dashArray: "5 4",
    }).addTo(capaResultado);

    piezas.forEach(function (p) {
      L.geoJSON({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: p.coordinates } }, {
        style: {
          color: "#ffffff",
          weight: 0.8,
          opacity: 0.9,
          fillColor: colorPorNivel3[p.nivel3] || "#777",
          fillOpacity: 0.95,
        },
        interactive: false,
      }).addTo(capaResultado);
    });
  }

  /* Resultado del clic, graficado en el panel derecho */
  function pintarResultado(filas, sumaHa, ms) {
    document.getElementById("pd-vacio").hidden = true;
    document.getElementById("pd-resultado").hidden = false;

    SP.kpi("res-ha", SP.entero(sumaHa));
    SP.kpi("res-n", filas.length);
    SP.kpi("res-ms", ms + " ms");

    pintarDona(filas, sumaHa);
    pintarLista(filas);
  }

  /* Dona de composición centrada y legible (antes era un anillo sobre el mapa) */
  function pintarDona(filas, sumaHa) {
    var cont = d3.select("#pd-dona");
    cont.selectAll("*").remove();

    if (!filas.length) {
      cont.append("p").attr("class", "sp-note")
        .text("El buffer no cruza ninguna cobertura.");
      return;
    }

    var tam = Math.min(236, cont.node().clientWidth || 236);
    var r = tam / 2;
    var grosor = r * 0.36;

    var svg = cont.append("svg")
      .attr("width", tam).attr("height", tam)
      .attr("viewBox", "0 0 " + tam + " " + tam);
    var g = svg.append("g").attr("transform", "translate(" + r + "," + r + ")");

    var arco = d3.arc().innerRadius(r - grosor).outerRadius(r - 2)
      .padAngle(0.014).cornerRadius(2);
    var pastel = d3.pie().sort(null).value(function (d) { return d.area_ha; });

    g.selectAll("path")
      .data(pastel(filas))
      .enter()
      .append("path")
      .attr("fill", function (d) { return colorPorNivel3[d.data.nivel3] || "#777"; })
      .attr("stroke", "#070d18")
      .attr("stroke-width", 1)
      .transition()
      .duration(650)
      .attrTween("d", function (d) {
        var i = d3.interpolate({ startAngle: d.startAngle, endAngle: d.startAngle }, d);
        return function (t) { return arco(i(t)); };
      });

    g.append("text").attr("class", "pd-dona__num")
      .attr("text-anchor", "middle").attr("dy", "-0.05em")
      .attr("font-size", Math.round(r * 0.3)).text(SP.entero(sumaHa));
    g.append("text").attr("class", "pd-dona__lbl")
      .attr("text-anchor", "middle").attr("dy", "1.5em")
      .attr("font-size", Math.round(r * 0.14)).text("hectáreas");
  }

  function pintarLista(filas) {
    var cont = document.getElementById("pd-lista");
    cont.innerHTML = "";
    filas.forEach(function (f) {
      var row = document.createElement("div");
      row.className = "pd-item";
      var dot = document.createElement("span");
      dot.className = "punto";
      dot.style.background = colorPorNivel3[f.nivel3] || "#777";
      var txt = document.createElement("span");
      txt.className = "pd-item__txt";
      txt.textContent = f.nivel3;
      txt.title = f.nivel3 + " · " + f.area_ha.toFixed(1) + " ha";
      var pct = document.createElement("span");
      pct.className = "pd-item__pct";
      pct.textContent = f.pct.toFixed(1) + "%";
      row.appendChild(dot); row.appendChild(txt); row.appendChild(pct);
      cont.appendChild(row);
    });
  }

  function limpiar() {
    capaResultado.clearLayers();
    document.getElementById("pd-resultado").hidden = true;
    document.getElementById("pd-vacio").hidden = false;
    d3.select("#pd-dona").selectAll("*").remove();
    ultimaConsulta = null;
  }

  /* -------------------------------------------------------------- leyenda */

  function pintarLeyenda() {
    var cont = document.getElementById("leyenda");
    cont.innerHTML = "";

    var grupos = {};
    porNivel3.forEach(function (c) {
      (grupos[c.nivel1] = grupos[c.nivel1] || []).push(c);
    });

    Object.keys(grupos).sort().forEach(function (nivel1) {
      var det = document.createElement("details");
      det.className = "leyenda-grupo";
      if (nivel1 === "1" || nivel1 === "3") det.open = true;

      var sum = document.createElement("summary");
      var sw = document.createElement("span");
      sw.className = "punto";
      sw.style.background = colorNivel1(nivel1);
      sum.appendChild(sw);
      sum.appendChild(document.createTextNode(
        nivel1 + ". " + (NIVEL1_NOMBRES[nivel1] || "")));
      det.appendChild(sum);

      grupos[nivel1]
        .sort(function (a, b) { return b.area_ha - a.area_ha; })
        .forEach(function (c) {
          var fila = document.createElement("div");
          fila.className = "leyenda-item";
          var p = document.createElement("span");
          p.className = "punto";
          p.style.background = colorPorNivel3[c.nivel3];
          var t = document.createElement("span");
          t.className = "leyenda-txt";
          t.textContent = c.nivel3;
          var v = document.createElement("span");
          v.className = "leyenda-pct sp-mono";
          v.textContent = c.pct.toFixed(1) + "%";
          fila.appendChild(p); fila.appendChild(t); fila.appendChild(v);
          det.appendChild(fila);
        });

      cont.appendChild(det);
    });
  }

  /* -------------------------------------------------------------- tablero */

  function pintarTablero() {
    var dominante = porNivel3.slice().sort(function (a, b) {
      return b.area_ha - a.area_ha;
    })[0];

    var natural = porNivel3
      .filter(function (c) { return ["3", "4", "5"].indexOf(c.nivel1) !== -1; })
      .reduce(function (s, c) { return s + c.area_ha; }, 0);

    var kpis = [
      { label: "Área de estudio", valor: SP.entero(totalHa) + " ha", sub: "municipio de Medellín" },
      { label: "Coberturas nivel 3", valor: String(porNivel3.length), sub: "clasificación IDEAM" },
      {
        label: "Cobertura dominante",
        valor: dominante.nivel3.replace(/^\d+(\.\d+)*\.\s*/, ""),
        sub: dominante.pct.toFixed(1) + "% del área",
      },
      {
        label: "Área natural",
        valor: (100 * natural / totalHa).toFixed(1) + "%",
        sub: "bosques, humedales y agua",
      },
    ];

    var fila = document.getElementById("kpi-row");
    fila.innerHTML = "";
    kpis.forEach(function (k) {
      var card = document.createElement("div");
      card.className = "kpi-card";
      var l = document.createElement("div"); l.className = "kpi-label"; l.textContent = k.label;
      var v = document.createElement("div"); v.className = "kpi-value"; v.textContent = k.valor;
      var s = document.createElement("div"); s.className = "kpi-sub"; s.textContent = k.sub;
      card.appendChild(l); card.appendChild(v); card.appendChild(s);
      fila.appendChild(card);
    });

    var porNivel1 = {};
    porNivel3.forEach(function (c) {
      porNivel1[c.nivel1] = (porNivel1[c.nivel1] || 0) + c.area_ha;
    });
    var datos1 = Object.keys(porNivel1).sort().map(function (n) {
      return {
        etiqueta: n + ". " + (NIVEL1_NOMBRES[n] || ""),
        valor: porNivel1[n],
        color: colorNivel1(n),
      };
    }).sort(function (a, b) { return b.valor - a.valor; });

    barras("#barras-nivel1", datos1);

    var datos3 = porNivel3.slice()
      .sort(function (a, b) { return b.area_ha - a.area_ha; })
      .map(function (c) {
        return { etiqueta: c.nivel3, valor: c.area_ha, color: colorPorNivel3[c.nivel3] };
      });

    barras("#barras-nivel3", datos3);
  }

  function barras(selector, datos) {
    var cont = d3.select(selector);
    cont.selectAll("*").remove();
    if (!datos.length) return;

    var ancho = cont.node().clientWidth || 640;
    var altoFila = 26;
    var margen = { top: 4, right: 62, bottom: 4, left: Math.min(230, ancho * 0.42) };
    var alto = datos.length * altoFila + margen.top + margen.bottom;

    var svg = cont.append("svg")
      .attr("width", ancho)
      .attr("height", alto)
      .attr("role", "img");

    var x = d3.scaleLinear()
      .domain([0, d3.max(datos, function (d) { return d.valor; })])
      .range([0, Math.max(10, ancho - margen.left - margen.right)]);

    var y = d3.scaleBand()
      .domain(datos.map(function (d) { return d.etiqueta; }))
      .range([margen.top, alto - margen.bottom])
      .padding(0.22);

    var g = svg.append("g");

    var filas = g.selectAll("g.fila")
      .data(datos)
      .enter()
      .append("g")
      .attr("class", "fila");

    filas.append("text")
      .attr("class", "barra-etiqueta")
      .attr("x", margen.left - 9)
      .attr("y", function (d) { return y(d.etiqueta) + y.bandwidth() / 2; })
      .attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .text(function (d) { return d.etiqueta; })
      .each(function () {
        /* las etiquetas largas se recortan con elipsis midiendo el texto */
        var nodo = this, limite = margen.left - 14;
        var txt = nodo.textContent;
        while (nodo.getComputedTextLength() > limite && txt.length > 4) {
          txt = txt.slice(0, -1);
          nodo.textContent = txt + "…";
        }
      });

    filas.append("rect")
      .attr("x", margen.left)
      .attr("y", function (d) { return y(d.etiqueta); })
      .attr("height", y.bandwidth())
      .attr("rx", 3)
      .attr("fill", function (d) { return d.color; })
      .attr("width", 0)
      .transition()
      .duration(700)
      .delay(function (_, i) { return i * 28; })
      .attr("width", function (d) { return x(d.valor); });

    filas.append("text")
      .attr("class", "barra-valor sp-mono")
      .attr("x", function (d) { return margen.left + x(d.valor) + 7; })
      .attr("y", function (d) { return y(d.etiqueta) + y.bandwidth() / 2; })
      .attr("dy", "0.35em")
      .text(function (d) { return SP.entero(d.valor) + " ha"; })
      .style("opacity", 0)
      .transition()
      .delay(650)
      .duration(300)
      .style("opacity", 1);

    filas.append("title")
      .text(function (d) {
        return d.etiqueta + " — " + SP.entero(d.valor) + " ha (" +
          (100 * d.valor / totalHa).toFixed(1) + "%)";
      });
  }

  /* ------------------------------------------------------------- vistas */

  function iniciarVistas() {
    var tabs = document.querySelectorAll("[data-vista]");
    var paneles = document.querySelectorAll("[data-vista-panel]");
    var pintado = false;

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var destino = tab.dataset.vista;
        tabs.forEach(function (t) {
          t.setAttribute("aria-selected", String(t === tab));
        });
        paneles.forEach(function (p) {
          p.hidden = p.dataset.vistaPanel !== destino;
        });
        if (destino === "mapa") {
          setTimeout(function () { map.invalidateSize(); }, 30);
        } else if (!pintado) {
          pintado = true;
          pintarTablero();
        }
      });
    });

    window.addEventListener("resize", function () {
      if (pintado && !document.querySelector('[data-vista-panel="tablero"]').hidden) {
        pintarTablero();
      }
    });
  }

  function iniciarControles() {
    var rango = document.getElementById("radio");
    var salida = document.querySelector(".sp-range__out");
    rango.addEventListener("input", function () {
      salida.textContent = this.value + " m";
    });
    rango.addEventListener("change", function () {
      if (ultimaConsulta) consultar(ultimaConsulta.lat, ultimaConsulta.lon);
    });

    document.getElementById("btn-ejemplo").addEventListener("click", function () {
      map.setView(CENTRO, 13, { animate: true });
      consultar(CENTRO[0], CENTRO[1]);
    });

    document.getElementById("btn-limpiar").addEventListener("click", limpiar);
  }

  /* ------------------------------------------------------------ arranque */

  window.addEventListener("DOMContentLoaded", function () {
    SP.cargarJSON(DATOS).then(function (fc) {
      capa = fc;
      porNivel3 = agregar(fc);
      construirPaleta(porNivel3);

      iniciarMapa();
      pintarLeyenda();
      iniciarVistas();
      iniciarControles();
      SP.listo();
    }).catch(function (e) {
      SP.listo();
      SP.aviso("No se pudo cargar la capa de coberturas: " + e.message);
    });

    setTimeout(SP.listo, 20000);
  });
})();
