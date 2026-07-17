// Jala datos reales de Meta Ads (campañas Táctica/Estratégica de las 4 sedes) y actualiza data/live-metrics.json.
// Se ejecuta automáticamente desde GitHub Actions (.github/workflows/refresh-meta-data.yml).
// Necesita el secreto de repo META_ACCESS_TOKEN (token de acceso de Meta con permisos ads_read sobre la cuenta).
//
// Trae varios periodos (no solo "últimos 30 días") para que el dashboard tenga un selector de rango de fechas,
// igual que Metricool. Cada periodo usa un date_preset distinto soportado nativamente por la Graph API.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = '1009181843347130';
const GRAPH_VERSION = 'v21.0';
const DATA_FILE = path.join(__dirname, '..', 'data', 'live-metrics.json');

if (!TOKEN) {
  console.error('Falta el secreto META_ACCESS_TOKEN — no se puede actualizar. Revisa Settings > Secrets and variables > Actions.');
  process.exit(1);
}

// IDs reales descubiertos manualmente (campaña dedicada + conjunto dentro de la campaña "Formulario unificado" por sede).
const SEDES = {
  tacuri: {
    tactica: { campaignIds: ['120246580112850278'], adsetIds: ['120244696278310278'] },
    estrategica: { campaignIds: ['120242359902880278'], adsetIds: [] }
  },
  juanambu: {
    tactica: { campaignIds: ['120246579965740278'], adsetIds: ['120244696278340278'] },
    estrategica: { campaignIds: ['120242358705960278'], adsetIds: [] }
  },
  entrevalles: {
    tactica: { campaignIds: [], adsetIds: ['120244696278330278'] },
    estrategica: { campaignIds: ['120242361892640278'], adsetIds: [] }
  },
  tayana: {
    tactica: { campaignIds: [], adsetIds: ['120244696278320278'] },
    estrategica: { campaignIds: ['120242361172460278'], adsetIds: [] }
  }
};

const PERIODS = [
  { key: 'yesterday', preset: 'yesterday', label: 'Ayer' },
  { key: 'last_7d', preset: 'last_7d', label: 'Última semana' },
  { key: 'this_month', preset: 'this_month', label: 'Mes actual' },
  { key: 'last_30d', preset: 'last_30d', label: 'Últimos 30 días' },
  { key: 'last_month', preset: 'last_month', label: 'Mes pasado' }
];

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fmtDate(iso) {
  if (!iso) return null;
  var parts = iso.split('-');
  var m = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);
  return d + ' ' + MONTHS_ES[m];
}

function buildPeriodLabel(label, dateStart, dateStop) {
  if (!dateStart || !dateStop) return label;
  var stopYear = dateStop.split('-')[0];
  return label + ' (' + fmtDate(dateStart) + ' – ' + fmtDate(dateStop) + ' ' + stopYear + ')';
}

async function fetchInsights(objectId, datePreset) {
  const fields = 'spend,reach,frequency,impressions,actions,date_start,date_stop';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${objectId}/insights?fields=${fields}&date_preset=${datePreset}&access_token=${TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) {
    console.error(`Error consultando ${objectId} (${datePreset}):`, json.error.message);
    return null;
  }
  return (json.data && json.data[0]) || null;
}

// Meta reporta el mismo lead bajo varias etiquetas a la vez (lead, onsite_conversion.lead_grouped, etc.).
// Sumarlas todas cuenta el mismo lead varias veces, así que se toma solo una, en orden de prioridad.
var LEAD_ACTION_TYPES = ['onsite_conversion.lead_grouped', 'lead', 'onsite_conversion.total_messaging_connection'];

function sumLeads(actions) {
  if (!actions) return 0;
  for (const type of LEAD_ACTION_TYPES) {
    const match = actions.find(function (a) { return a.action_type === type; });
    if (match) return parseFloat(match.value || 0);
  }
  return 0;
}

async function aggregate(ids, datePreset) {
  var totalSpend = 0, totalLeads = 0, totalReach = 0, totalImpressions = 0, weightedFreq = 0, count = 0;
  var dateStart = null, dateStop = null;
  for (const id of ids) {
    const row = await fetchInsights(id, datePreset);
    if (!row) continue;
    if (!dateStart) { dateStart = row.date_start; dateStop = row.date_stop; }
    const spend = parseFloat(row.spend || 0);
    totalSpend += spend;
    totalLeads += sumLeads(row.actions);
    totalReach += parseFloat(row.reach || 0);
    totalImpressions += parseFloat(row.impressions || 0);
    weightedFreq += parseFloat(row.frequency || 0) * spend;
    count++;
  }
  return {
    spend: totalSpend, leads: totalLeads, reach: totalReach, impressions: totalImpressions,
    freq: count && totalSpend ? weightedFreq / totalSpend : 0,
    dateStart: dateStart, dateStop: dateStop
  };
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), source: 'github-actions', accounts: {} };

  for (const sede of Object.keys(SEDES)) {
    const cfg = SEDES[sede];
    const tacticaIds = cfg.tactica.campaignIds.concat(cfg.tactica.adsetIds);
    const estrategicaIds = cfg.estrategica.campaignIds.concat(cfg.estrategica.adsetIds);

    var tacticaPeriods = {};
    var estrategicaPeriods = {};

    for (const p of PERIODS) {
      const t = await aggregate(tacticaIds, p.preset);
      const e = await aggregate(estrategicaIds, p.preset);

      tacticaPeriods[p.key] = {
        current: Math.round(t.leads),
        cpl: t.leads ? Math.round(t.spend / t.leads) : null,
        spend: Math.round(t.spend),
        period: buildPeriodLabel(p.label, t.dateStart, t.dateStop)
      };
      estrategicaPeriods[p.key] = {
        current: Math.round(e.reach),
        freq: Math.round(e.freq * 100) / 100,
        cpm: e.impressions ? Math.round((e.spend / e.impressions) * 1000) : null,
        spend: Math.round(e.spend),
        period: buildPeriodLabel(p.label, e.dateStart, e.dateStop)
      };
    }

    out.accounts[sede] = {
      tactica: { periods: tacticaPeriods },
      estrategica: { periods: estrategicaPeriods }
    };
    console.log(sede, 'OK ->', JSON.stringify(out.accounts[sede]));
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log('Escrito', DATA_FILE);
}

main().catch(function (err) {
  console.error('Falló la actualización:', err);
  process.exit(1);
});
