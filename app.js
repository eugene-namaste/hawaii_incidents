(async function () {
  "use strict";

  const configResponse = await fetch("./config.yaml", { cache: "no-store" });
  if (!configResponse.ok) {
    throw new Error(`Unable to load config.yaml (${configResponse.status})`);
  }

  const yamlText = await configResponse.text();
  const config = jsyaml.load(yamlText);

  document.title = config.app?.title || "Incident Viewer";

  const headerTitle = document.querySelector("#header h1");
  const headerSubtitle = document.querySelector("#header .subtitle");

  if (headerTitle) headerTitle.textContent = config.app?.title || "Incident Viewer";
  if (headerSubtitle) headerSubtitle.textContent = config.app?.subtitle || "";

  require([
    "esri/Map",
    "esri/views/MapView",
    "esri/layers/FeatureLayer"
  ], (ArcGISMap, MapView, FeatureLayer) => {

    const layer = new FeatureLayer({
      url: config.data.service_url,
      outFields: ["*"],
      popupTemplate: buildPopupTemplate(config),
      renderer: buildRenderer(config)
    });

    const logConfig = config.operations?.logs || {};
    const logLayer = logConfig.service_url
      ? new FeatureLayer({ url: logConfig.service_url, outFields: ["*"] })
      : null;

    const map = new ArcGISMap({
      basemap: config.map?.basemap || "streets-navigation-vector",
      layers: [layer]
    });

    const view = new MapView({
      container: "viewDiv",
      map,
      center: config.map?.initial_center || [-157.7, 20.8],
      zoom: config.map?.initial_zoom ?? 7,
      popup: {
        dockEnabled: true,
        dockOptions: {
          buttonEnabled: false,
          position: "top-right"
        }
      }
    });

    const filtersEl = document.getElementById("filters");
    const listEl = document.getElementById("incidentList");
    const resultCount = document.getElementById("resultCount");
    const statusEl = document.getElementById("status");
    const lastUpdateEl = document.getElementById("lastUpdate");
    const totalRecordsEl = document.getElementById("totalRecords");
    const incidentsTab = document.getElementById("incidentsTab");
    const logsTab = document.getElementById("logsTab");
    const incidentPanel = document.getElementById("incidentPanel");
    const logPanel = document.getElementById("logPanel");
    const logList = document.getElementById("logList");

    const filterControls = new globalThis.Map();
    let currentFeatures = [];
    let highlightHandle = null;
    let logsLoaded = false;

    function setActivePanel(panelName) {
      const showLogs = panelName === "logs";
      incidentPanel.hidden = showLogs;
      logPanel.hidden = !showLogs;
      incidentsTab.classList.toggle("active", !showLogs);
      logsTab.classList.toggle("active", showLogs);

      if (showLogs && !logsLoaded) {
        loadLatestLogs();
      }
    }

    incidentsTab.addEventListener("click", () => setActivePanel("incidents"));
    logsTab.addEventListener("click", () => {
      logsLoaded = false;
      setActivePanel("logs");
    });

    async function fetchJson(url) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const json = await response.json();
      if (json?.error) {
        throw new Error(json.error.message || "ArcGIS REST request failed");
      }
      return json;
    }

    async function loadPublicationStatus() {
      try {
        const baseUrl = String(config.data.service_url || "").replace(/\/$/, "");
        const metadataUrl = `${baseUrl}?f=json`;
        const countUrl = `${baseUrl}/query?where=1%3D1&returnCountOnly=true&f=json`;

        const [metadata, countResult] = await Promise.all([
          fetchJson(metadataUrl),
          fetchJson(countUrl)
        ]);

        const count = Number(countResult?.count);
        totalRecordsEl.textContent = Number.isFinite(count)
          ? count.toLocaleString()
          : "Not available";

        const lastEdit =
          metadata?.editingInfo?.lastEditDate ??
          metadata?.lastEditDate ??
          metadata?.dataLastEditDate ??
          null;

        lastUpdateEl.textContent = lastEdit ? formatDate(lastEdit) : "Not available";
      } catch (err) {
        console.error("Unable to load publication status", err);
        lastUpdateEl.textContent = "Unavailable";
        totalRecordsEl.textContent = "Unavailable";
      }
    }

    function appendLogCard(label, feature) {
      const card = document.createElement("div");
      card.className = "log-card";

      const title = document.createElement("div");
      title.className = "log-card-title";

      const name = document.createElement("span");
      name.textContent = label;

      const status = document.createElement("span");
      status.className = "log-status";
      status.textContent = feature
        ? safeText(feature.attributes[logConfig.status_field])
        : "No record";

      title.appendChild(name);
      title.appendChild(status);
      card.appendChild(title);

      if (feature) {
        const date = document.createElement("div");
        date.className = "log-date";
        date.textContent = formatDate(feature.attributes[logConfig.run_date_field]);
        card.appendChild(date);

        const summary = document.createElement("pre");
        summary.className = "log-summary";
        summary.textContent = safeText(feature.attributes[logConfig.summary_field]);
        card.appendChild(summary);
      } else {
        const empty = document.createElement("div");
        empty.className = "log-date";
        empty.textContent = "No published summary found for this script.";
        card.appendChild(empty);
      }

      logList.appendChild(card);
    }

    async function loadLatestLogs() {
      logList.innerHTML = '<div class="empty">Loading ETL summaries…</div>';

      if (!logLayer) {
        logList.innerHTML =
          '<div class="empty">ETL log table is not configured yet.<br>Set operations.logs.service_url in config.yaml.</div>';
        logsLoaded = true;
        return;
      }

      try {
        await logLayer.load();

        const scriptField = logConfig.script_field;
        const runDateField = logConfig.run_date_field;
        const statusField = logConfig.status_field;
        const summaryField = logConfig.summary_field;
        const scripts = logConfig.scripts || [];

        logList.innerHTML = "";

        if (scripts.length) {
          const jobs = scripts.map(async script => {
            const q = logLayer.createQuery();
            q.where = `${scriptField} = '${sqlEscape(script.value)}'`;
            q.outFields = [scriptField, runDateField, statusField, summaryField];
            q.returnGeometry = false;
            q.orderByFields = [`${runDateField} DESC`];
            q.num = 1;

            const result = await logLayer.queryFeatures(q);
            return { script, feature: result.features?.[0] || null };
          });

          const latest = await Promise.all(jobs);
          for (const item of latest) {
            appendLogCard(item.script.label || item.script.value, item.feature);
          }
        } else {
          const q = logLayer.createQuery();
          q.where = "1=1";
          q.outFields = [scriptField, runDateField, statusField, summaryField];
          q.returnGeometry = false;
          q.orderByFields = [`${runDateField} DESC`];
          q.num = Number(logConfig.max_records ?? 100);

          const result = await logLayer.queryFeatures(q);
          const features = result.features || [];
          const latestByScript = new globalThis.Map();
          for (const feature of features) {
            const scriptName = safeText(feature.attributes[scriptField]);
            if (!latestByScript.has(scriptName)) latestByScript.set(scriptName, feature);
          }
          for (const [scriptName, feature] of latestByScript) {
            appendLogCard(scriptName, feature);
          }
          if (!features.length) {
            logList.innerHTML = '<div class="empty">No ETL log records found.</div>';
          }
        }

        logsLoaded = true;
      } catch (err) {
        console.error("Unable to load ETL logs", err);
        logList.innerHTML = '<div class="empty">Unable to load ETL log summaries. See browser console for details.</div>';
      }
    }

    function buildMarkerSymbol(symbolConfig = {}) {
      return {
        type: "simple-marker",
        style: symbolConfig.style || "circle",
        size: symbolConfig.size ?? 7,
        color: symbolConfig.color || "#808080",
        outline: {
          color: symbolConfig.outline_color || "#ffffff",
          width: symbolConfig.outline_width ?? 0.5
        }
      };
    }

    function buildRenderer(cfg) {
      const rendererConfig = cfg.map?.renderer;

      // No YAML renderer configured:
      // use the renderer already defined on the hosted layer.
      if (!rendererConfig) {
        return undefined;
      }

      if (rendererConfig.type === "simple") {
        return {
          type: "simple",
          symbol: buildMarkerSymbol(
            rendererConfig.symbol || rendererConfig.default_symbol
          )
        };
      }

      if (rendererConfig.type === "unique_value") {
        if (!rendererConfig.field) {
          console.warn(
            "Unique-value renderer requires map.renderer.field. " +
            "Falling back to the hosted layer renderer."
          );
          return undefined;
        }

        const defaultConfig = rendererConfig.default_symbol || {};

        return {
          type: "unique-value",
          field: rendererConfig.field,
          defaultSymbol: buildMarkerSymbol(defaultConfig),
          defaultLabel: defaultConfig.label || "Other",
          uniqueValueInfos: (rendererConfig.values || []).map(item => ({
            value: item.value,
            label: item.label || String(item.value),
            symbol: buildMarkerSymbol(item)
          }))
        };
      }

      console.warn(
        `Unsupported renderer type: ${rendererConfig.type}. ` +
        "Using the hosted layer renderer."
      );

      return undefined;
    }

    function buildPopupTemplate(cfg) {
      const details = cfg.details || {};
      return {
        title: details.title_template || "Incident",
        content: [{
          type: "fields",
          fieldInfos: (details.fields || []).map(item => {
            const info = {
              fieldName: item.field,
              label: item.label || item.field
            };

            if (item.type === "date") {
              info.format = { dateFormat: "short-date-short-time" };
            }

            if (item.type === "date_only") {
              info.format = { dateFormat: "short-date" };
            }

            return info;
          })
        }]
      };
    }

    function sqlEscape(value) {
      return String(value).replace(/'/g, "''");
    }

    function selectedValues(selectElement) {
      return Array.from(selectElement.selectedOptions).map(o => o.value);
    }

    function formatDate(value) {
      if (!value) return "—";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";

      return d.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    }

    function formatDateOnly(value) {
      if (!value) return "—";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";

      return d.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric"
      });
    }

    function safeText(value) {
      if (value === null || value === undefined || value === "") return "—";
      return String(value);
    }

    function dateSql(fieldName, days) {
      const d = new Date();
      d.setDate(d.getDate() - Number(days));

      const pad = n => String(n).padStart(2, "0");
      const literal =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      return `${fieldName} >= TIMESTAMP '${literal}'`;
    }

    function inClause(field, values) {
      if (!values.length) return null;
      return `${field} IN (${values.map(v => `'${sqlEscape(v)}'`).join(",")})`;
    }

    function addDaysToIsoDate(isoDate, days) {
      const [year, month, day] = isoDate.split("-").map(Number);
      const d = new Date(Date.UTC(year, month - 1, day));
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    }

    function customDateRangeSql(fieldName, startDate, endDate) {
      const endExclusive = addDaysToIsoDate(endDate, 1);
      return (
        `${fieldName} >= TIMESTAMP '${startDate} 00:00:00' AND ` +
        `${fieldName} < TIMESTAMP '${endExclusive} 00:00:00'`
      );
    }

    function getCustomDateRangeState(filter, control) {
      const startDate = control.start.value;
      const endDate = control.end.value;

      if (!startDate && !endDate) {
        return { active: false };
      }

      if (!startDate || !endDate) {
        throw new Error(`${filter.label || "Incident Date Range"}: enter both start and end dates.`);
      }

      const start = new Date(`${startDate}T00:00:00Z`);
      const end = new Date(`${endDate}T00:00:00Z`);

      if (end < start) {
        throw new Error(`${filter.label || "Incident Date Range"}: end date cannot be before start date.`);
      }

      const maxDays = Number(filter.max_days ?? 15);
      const spanDays = Math.round((end - start) / 86400000);

      if (spanDays > maxDays) {
        throw new Error(`${filter.label || "Incident Date Range"}: range cannot exceed ${maxDays} days.`);
      }

      return { active: true, startDate, endDate };
    }

    function syncDateFilterExclusivity() {
      const customFilters = (config.filters || []).filter(f => f.type === "custom_date_range");
      const customActive = customFilters.some(filter => {
        const control = filterControls.get(filter.id);
        return control && (control.start.value || control.end.value);
      });

      for (const filter of config.filters || []) {
        if (filter.type !== "date_range") continue;
        const control = filterControls.get(filter.id);
        if (control) control.disabled = customActive;
      }
    }

    function createFilterUI() {
      filtersEl.innerHTML = "";

      for (const filter of config.filters || []) {
        const block = document.createElement("div");
        block.className = "filter-block";

        const title = document.createElement("div");
        title.className = "filter-title";
        title.textContent = filter.label || filter.field;
        block.appendChild(title);

        let control;

        if (filter.type === "custom_date_range") {
          const wrapper = document.createElement("div");
          wrapper.className = "custom-date-range";

          const start = document.createElement("input");
          start.type = "date";
          start.id = `filter_${filter.id}_start`;
          start.setAttribute("aria-label", `${filter.label || filter.field} start date`);

          const separator = document.createElement("span");
          separator.textContent = " to ";

          const end = document.createElement("input");
          end.type = "date";
          end.id = `filter_${filter.id}_end`;
          end.setAttribute("aria-label", `${filter.label || filter.field} end date`);

          const onDateInput = () => {
            syncDateFilterExclusivity();
            statusEl.textContent = config.behavior?.default_status_text || "Ready";
          };

          start.addEventListener("input", onDateInput);
          end.addEventListener("input", onDateInput);

          wrapper.appendChild(start);
          wrapper.appendChild(separator);
          wrapper.appendChild(end);
          block.appendChild(wrapper);

          control = { start, end, wrapper };
        } else {
          const select = document.createElement("select");
          select.id = `filter_${filter.id}`;
          select.dataset.filterId = filter.id;

          if (filter.type === "date_range") {
            for (const choice of filter.choices || []) {
              const option = document.createElement("option");
              option.value = choice.value;
              option.textContent = choice.label;
              option.selected = Number(choice.value) === Number(filter.default);
              select.appendChild(option);
            }
          } else if (filter.type === "unique_values") {
            if (filter.multiple) {
              select.multiple = true;
            }
          } else {
            console.warn(`Unsupported filter type: ${filter.type}`);
          }

          block.appendChild(select);
          control = select;
        }

        if (filter.hint) {
          const hint = document.createElement("div");
          hint.className = "hint";
          hint.textContent = filter.hint;
          block.appendChild(hint);
        }

        filtersEl.appendChild(block);
        filterControls.set(filter.id, control);
      }

      const actions = document.createElement("div");
      actions.id = "filterActions";

      const applyBtn = document.createElement("button");
      applyBtn.id = "applyBtn";
      applyBtn.className = "primary";
      applyBtn.textContent = "Apply Filters";
      applyBtn.addEventListener("click", applyFilters);

      const clearBtn = document.createElement("button");
      clearBtn.id = "clearBtn";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", clearFilters);

      actions.appendChild(applyBtn);
      actions.appendChild(clearBtn);
      filtersEl.appendChild(actions);
    }

    async function loadUniqueFilterValues() {
      const jobs = [];

      for (const filter of config.filters || []) {
        if (filter.type !== "unique_values") continue;

        const select = filterControls.get(filter.id);
        if (!select) continue;

        jobs.push((async () => {
          const q = layer.createQuery();
          q.where = `${filter.field} IS NOT NULL`;
          q.outFields = [filter.field];
          q.returnGeometry = false;
          q.returnDistinctValues = true;
          q.orderByFields = [filter.field];

          const result = await layer.queryFeatures(q);

          const values = [...new Set(
            result.features
              .map(f => f.attributes[filter.field])
              .filter(v => v !== null && v !== undefined && String(v).trim() !== "")
          )].sort((a, b) => String(a).localeCompare(String(b)));

          select.innerHTML = "";

          for (const value of values) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            select.appendChild(option);
          }
        })());
      }

      await Promise.all(jobs);
    }

    function buildWhere() {
      const clauses = [];

      for (const filter of config.filters || []) {
        const control = filterControls.get(filter.id);
        if (!control) continue;

        if (filter.type === "date_range") {
          if (!control.disabled) {
            clauses.push(dateSql(filter.field, control.value));
          }
        }

        if (filter.type === "custom_date_range") {
          const range = getCustomDateRangeState(filter, control);
          if (range.active) {
            clauses.push(customDateRangeSql(filter.field, range.startDate, range.endDate));
          }
        }

        if (filter.type === "unique_values") {
          const values = selectedValues(control);
          const clause = inClause(filter.field, values);
          if (clause) clauses.push(clause);
        }
      }

      return clauses.length ? clauses.join(" AND ") : "1=1";
    }

    function getRequiredFields() {
      const fields = new Set();

      fields.add(layer.objectIdField || "OBJECTID");

      for (const filter of config.filters || []) {
        if (filter.field) fields.add(filter.field);
      }

      for (const item of config.list?.fields || []) {
        if (item.field) fields.add(item.field);
      }

      for (const item of config.details?.fields || []) {
        if (item.field) fields.add(item.field);
      }

      if (config.list?.sort_field) {
        fields.add(config.list.sort_field);
      }

      return [...fields];
    }

    async function fetchAllFilteredFeatures(where) {
      const objectIds = await layer.queryObjectIds({ where });

      if (!objectIds || objectIds.length === 0) {
        return [];
      }

      const chunkSize = 1000;
      const chunks = [];

      for (let i = 0; i < objectIds.length; i += chunkSize) {
        chunks.push(objectIds.slice(i, i + chunkSize));
      }

      const outFields = getRequiredFields();

      const results = await Promise.all(
        chunks.map(ids => layer.queryFeatures({
          objectIds: ids,
          outFields,
          returnGeometry: true,
          outSpatialReference: view.spatialReference
        }))
      );

      const features = results.flatMap(r => r.features);

      const sortField = config.list?.sort_field;
      const descending =
        String(config.list?.sort_order || "descending").toLowerCase() !== "ascending";

      if (sortField) {
        features.sort((a, b) => {
          const av = a.attributes[sortField];
          const bv = b.attributes[sortField];

          const ad = new Date(av);
          const bd = new Date(bv);

          let result;
          if (!Number.isNaN(ad.getTime()) && !Number.isNaN(bd.getTime())) {
            result = ad - bd;
          } else {
            result = String(av ?? "").localeCompare(String(bv ?? ""));
          }

          return descending ? -result : result;
        });
      }

      return features;
    }

    function findListField(role) {
      return (config.list?.fields || []).find(f => f.role === role);
    }

    function renderList(features) {
      listEl.innerHTML = "";
      resultCount.textContent = features.length.toLocaleString();

      if (!features.length) {
        listEl.innerHTML =
          `<div class="empty">${config.behavior?.no_results_text || "No incidents match the current filters."}</div>`;
        return;
      }

      const titleField = findListField("title");
      const addressField = findListField("address");
      const metaFields = (config.list?.fields || []).filter(f => f.role === "meta");
      const dateField = findListField("date");

      const fragment = document.createDocumentFragment();

      for (const feature of features) {
        const a = feature.attributes;
        const oid = a[layer.objectIdField];

        const row = document.createElement("div");
        row.className = "incident";
        row.dataset.objectId = oid;

        const title = titleField ? safeText(a[titleField.field]) : safeText(oid);
        const address = addressField ? safeText(a[addressField.field]) : "";

        const metaLines = metaFields.map(item => safeText(a[item.field]));

        if (dateField) {
          let dateValue;

          if (dateField.type === "date") {
            dateValue = formatDate(a[dateField.field]);
          } else if (dateField.type === "date_only") {
            dateValue = formatDateOnly(a[dateField.field]);
          } else {
            dateValue = safeText(a[dateField.field]);
          }

          metaLines.push(dateValue);
        }

        row.innerHTML = `
          <div class="incident-id">${title}</div>
          ${address ? `<div class="incident-address">${address}</div>` : ""}
          <div class="incident-meta">${metaLines.join("<br>")}</div>
        `;

        row.addEventListener("click", () => selectIncident(feature));
        fragment.appendChild(row);
      }

      listEl.appendChild(fragment);
    }

    async function selectIncident(feature) {
      const oid = feature.attributes[layer.objectIdField];

      document.querySelectorAll(".incident").forEach(el => {
        el.classList.toggle("selected", Number(el.dataset.objectId) === Number(oid));
      });

      try {
        await view.goTo({
          target: feature.geometry,
          zoom: config.map?.selection_zoom ?? 16
        }, {
          duration: 700
        });
      } catch (e) {
        if (e.name !== "AbortError") console.error(e);
      }

      await view.openPopup({
        features: [feature],
        location: feature.geometry
      });

      if (config.behavior?.selection_highlight !== false) {
        const layerView = await view.whenLayerView(layer);

        if (highlightHandle) {
          highlightHandle.remove();
        }

        highlightHandle = layerView.highlight(feature);
      }
    }

    async function zoomToFilteredExtent(where) {
      const extentResult = await layer.queryExtent({ where });

      if (!extentResult.extent) return;

      try {
        if (extentResult.count === 1) {
          const only = currentFeatures[0];

          if (only?.geometry) {
            await view.goTo({
              target: only.geometry,
              zoom: config.map?.selection_zoom ?? 16
            }, {
              duration: 650
            });
          }
        } else {
          const factor = config.map?.extent_expand_factor ?? 1.15;
          await view.goTo(extentResult.extent.expand(factor), { duration: 650 });
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error(e);
      }
    }

    async function applyFilters() {
      const applyBtn = document.getElementById("applyBtn");
      statusEl.textContent = "Loading incidents...";

      if (applyBtn) applyBtn.disabled = true;

      try {
        const where = buildWhere();

        layer.definitionExpression = where;

        currentFeatures = await fetchAllFilteredFeatures(where);

        if (highlightHandle) {
          highlightHandle.remove();
          highlightHandle = null;
        }

        view.closePopup();
        renderList(currentFeatures);

        if (currentFeatures.length) {
          await zoomToFilteredExtent(where);
        }

        statusEl.textContent =
          `${currentFeatures.length.toLocaleString()} incident` +
          `${currentFeatures.length === 1 ? "" : "s"} shown`;
      } catch (err) {
        console.error(err);
        statusEl.textContent = err?.message || "Unable to load incidents. See browser console for details.";
      } finally {
        if (applyBtn) applyBtn.disabled = false;
      }
    }

    function clearFilters() {
      for (const filter of config.filters || []) {
        const control = filterControls.get(filter.id);
        if (!control) continue;

        if (filter.type === "date_range") {
          if (filter.default !== undefined) {
            control.value = String(filter.default);
          }
        }

        if (filter.type === "custom_date_range") {
          control.start.value = "";
          control.end.value = "";
        }

        if (filter.type === "unique_values") {
          Array.from(control.options).forEach(o => {
            o.selected = false;
          });
        }
      }

      syncDateFilterExclusivity();
      applyFilters();
    }

    view.when(async () => {
      try {
        statusEl.textContent = config.behavior?.default_status_text || "Loading...";

        await layer.load();
        loadPublicationStatus();

        createFilterUI();
        syncDateFilterExclusivity();

        statusEl.textContent = "Loading filter values...";
        await loadUniqueFilterValues();

        await applyFilters();
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Initialization failed. See browser console for details.";
      }
    });
  });
})().catch(err => {
  console.error(err);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Unable to load configuration. See browser console for details.";
  }
});
