'use strict';

const $ = id => document.getElementById(id);
const sensors = [
  ['Front_Top', '前·上'], ['Front_Middle', '前·中'], ['Front_Bottom', '前·下'],
  ['Middle_Top', '中·上'], ['Middle_Middle', '中·中'], ['Middle_Bottom', '中·下'],
  ['Rear_Top', '后·上'], ['Rear_Middle', '后·中'], ['Rear_Bottom', '后·下']
];
const sensorLabel = Object.fromEntries(sensors);
const colors = { green: '#416b3e', red: '#b45646', muted: '#65705a', gold: '#aa812f', gray: '#aab3a2' };
const batchPalette = ['#367a68', '#477eb0', '#af7529', '#8e65a9', '#b45160', '#5b777d'];
const batchSymbols = ['circle', 'rect', 'triangle', 'diamond', 'pin', 'roundRect'];
const charts = Object.fromEntries(Object.entries({
  series: 'series', heatmap: 'heatmap', bars: 'sensorBars', comparison: 'comparisonChart',
  box: 'boxChart', status: 'statusChart', cumulative: 'cumulativeChart',
  rhythm: 'rhythmChart', parallel: 'parallelChart'
}).map(([key, id]) => {
  const element = $(id);
  // Hidden pages need an initial canvas size; navigation fits them to their container.
  return [key, echarts.init(element, null, {
    width: element.clientWidth || 640, height: parseFloat(getComputedStyle(element).height)
  })];
}));
let data = window.REAL_COLDCHAIN_DATA;
let shipment, rows = [], selectedSensor = 'Middle_Middle';
let index = 72, low = 0, high = 4, events = [];
let prefixOutside = [], prefixMissing = [], timer = null;
let selectedStats = null;
let chartWindowStart = 0, chartWindowEnd = 144;
let viewScope = 'day';
let heatMode = 'status', temperatureExtent = [0, 30];
let comparisonRecords = [], comparisonSeries = [], brushedKeys = null;
let syncZoom = false;
const stateLabels = { low: '↓ 低于下限', high: '↑ 高于上限', normal: '● 范围内', missing: '— 缺测' };
const pages = {
  overview: { title: '草莓冷链，温度有迹可循', description: '用六批次九测点实测数据，观察农产品运输中的温度变化。' },
  timeline: { title: '时间与空间', description: '回放运输过程，联动查看温度趋势、九点热力图与空间差异。' },
  distribution: { title: '分布与节律', description: '用箱线图、状态构成、累积曲线与日期热力图看整体分布和时间节律。' },
  exceptions: { title: '异常追溯', description: '筛选高温、低温与缺测区间，点击记录跳转到对应时刻。' },
  comparison: { title: '多维比较', description: '结合有效覆盖率与越界率，比较六个批次的九个测点。' },
  method: { title: '数据与方法', description: '查看数据来源、统计口径与分析边界。' }
};
let currentPage = 'overview';
let measuredModeLabel = '公开研究实测 · 正在载入';
function updatePageDataLabel() {
  $('mode').textContent = measuredModeLabel;
  $('pageDataLabel').textContent = '草莓冷链 · 实测数据';
  $('pageDataNote').textContent = '非实时监测';
}

function resizeVisibleCharts() {
  const navigation = document.querySelector('.section-nav');
  const selectedLink = navigation.querySelector('[aria-current]');
  if (selectedLink) {
    const container = navigation.getBoundingClientRect(), selected = selectedLink.getBoundingClientRect();
    if (selected.right > container.right) navigation.scrollLeft += selected.right - container.right + 12;
    else if (selected.left < container.left) navigation.scrollLeft -= container.left - selected.left + 12;
  }
  Object.values(charts).forEach(chart => {
    const element = chart.getDom();
    if (element.clientWidth && element.clientHeight) chart.resize({ width: 'auto', height: 'auto' });
  });
  if (rows.length && currentPage === 'timeline') {
    for (const id of ['series', 'heatmap']) {
      charts[id].setOption({ xAxis: { axisLabel: { interval: chartLabelInterval(id) } } });
    }
  }
}
function navigateToPage(requestedPage, { updateHistory = true, focus = true } = {}) {
  const pageId = Object.hasOwn(pages, requestedPage) ? requestedPage : 'overview';
  if (currentPage === 'timeline' && pageId !== currentPage) stop();
  currentPage = pageId;
  document.body.dataset.currentPage = pageId;
  if (updateHistory && location.hash !== '#' + pageId) {
    history.pushState(null, '', '#' + pageId);
  } else if (!updateHistory && location.hash !== '#' + pageId) {
    history.replaceState(null, '', '#' + pageId);
  }
  document.querySelectorAll('[data-page]').forEach(element => {
    element.hidden = !element.dataset.page.split(' ').includes(pageId);
  });
  let currentLink;
  document.querySelectorAll('.section-nav a').forEach(link => {
    if (link.hash === '#' + pageId) {
      link.setAttribute('aria-current', 'page');
      currentLink = link;
    } else link.removeAttribute('aria-current');
  });
  $('pageTitle').textContent = pages[pageId].title;
  $('pageDescription').textContent = pages[pageId].description;
  $('pageEyebrow').textContent = '农业数据可视化 · ' + currentLink.textContent;
  document.title = currentLink.textContent + ' · 禾望冷链';
  updatePageDataLabel();
  resizeVisibleCharts();
  window.dispatchEvent(new CustomEvent('pagechange', { detail: { page: pageId } }));
  window.scrollTo({ top: 0, behavior: 'instant' });
  currentLink.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  if (focus) $('pageTitle').focus({ preventScroll: true });
}
function bindNavigation() {
  document.querySelector('.section-nav').addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateToPage(link.hash.slice(1));
  });
  window.addEventListener('hashchange', () => navigateToPage(location.hash.slice(1), { updateHistory: false }));
  window.addEventListener('resize', resizeVisibleCharts);
  navigateToPage(location.hash.slice(1), { updateHistory: false, focus: false });
}

function valid(value) { return typeof value === 'number' && Number.isFinite(value); }
function outside(value) { return valid(value) && (value < low || value > high); }
function reading(row, key = selectedSensor) { return row.temperatures[key]; }
function number(value, digits = 1) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
function timeLabel(position, full = false) {
  const value = rows[position]?.time || '';
  return full ? value.replace('T', ' ') : value.slice(5, 10).replace('-', '/') + ' ' + value.slice(11, 16);
}
function mean(row) {
  const values = Object.values(row.temperatures).filter(valid);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function statsFor(readings, key) {
  return ColdChainAnalysis.stats(readings, key, low, high);
}
function coverageRate(stats, readings) {
  return stats.validIntervals / (readings.length - 1);
}
function outsideRate(stats) {
  return stats.validIntervals ? stats.outsideIntervals / stats.validIntervals : null;
}
function qualityLevel(rate) {
  if (rate < .5) return { label: '缺测过半 · 仅供参考', className: 'low' };
  if (rate < .9) return { label: '部分缺测 · 谨慎比较', className: 'partial' };
  return { label: '覆盖较完整', className: 'good' };
}
function focusChartWindow(center) {
  if (viewScope === 'all') {
    chartWindowStart = 0;
    chartWindowEnd = rows.length - 1;
    return;
  }
  const span = Math.min(144, rows.length - 1);
  chartWindowStart = Math.max(0, Math.min(center - 72, rows.length - 1 - span));
  chartWindowEnd = chartWindowStart + span;
}
function chartLabelInterval(chartId = 'series') {
  const visiblePoints = chartWindowEnd - chartWindowStart + 1;
  const labelCount = Math.max(3, Math.floor(($(chartId).clientWidth || charts[chartId].getWidth()) / 75));
  return Math.max(0, Math.ceil(visiblePoints / labelCount) - 1);
}
function applyChartWindow() {
  syncZoom = true;
  for (const chartId of ['series', 'heatmap']) {
    charts[chartId].setOption({
      xAxis: { axisLabel: { interval: chartLabelInterval(chartId) } },
      dataZoom: [
        { startValue: chartWindowStart, endValue: chartWindowEnd },
        { startValue: chartWindowStart, endValue: chartWindowEnd }
      ]
    });
  }
  syncZoom = false;
  updateWindowStatus();
}
function updateWindowStatus() {
  $('windowStatus').textContent = '联动窗口：' + timeLabel(chartWindowStart) + ' 至 ' + timeLabel(chartWindowEnd) +
    ' · ' + number((chartWindowEnd - chartWindowStart) / 6, 1) + ' h · 下方对比统计按全程计算';
}
function handleZoom(chartId) {
  if (syncZoom) return;
  const zoom = charts[chartId].getOption().dataZoom[0];
  chartWindowStart = Math.max(0, Math.round(zoom.startValue));
  chartWindowEnd = Math.min(rows.length - 1, Math.round(zoom.endValue));
  if (!Number.isFinite(chartWindowStart) || !Number.isFinite(chartWindowEnd)) return;
  stop();
  viewScope = 'custom';
  $('viewWindow').value = viewScope;
  applyChartWindow();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  $('play').textContent = '▶ 播放';
  $('play').setAttribute('aria-label', '播放时间回放');
}
function buildAnalysis() {
  events = ColdChainAnalysis.intervals(rows, selectedSensor, low, high);
  selectedStats = statsFor(rows, selectedSensor);
  prefixOutside = [0];
  prefixMissing = [0];
  for (let i = 0; i < rows.length; i++) {
    const value = reading(rows[i]);
    const hasInterval = i < rows.length - 1;
    const isAlert = hasInterval && outside(value);
    prefixOutside.push(prefixOutside[i] + Number(isAlert));
    prefixMissing.push(prefixMissing[i] + Number(hasInterval && !valid(value)));
  }
}
function chooseBatch(id, resetTime = true) {
  stop();
  shipment = data.shipments.find(item => item.id === id) || data.shipments[0];
  rows = shipment.readings;
  if (viewScope === 'custom') { viewScope = 'day'; $('viewWindow').value = viewScope; }
  $('batch').value = shipment.id;
  if (resetTime) index = Math.min(72, rows.length - 1);
  $('time').max = String(rows.length - 1);
  $('sampleCount').textContent = number(rows.length, 0) + ' 个时点 · 10 分钟';
  $('rangeLabel').textContent = timeLabel(0, true) + ' — ' + timeLabel(rows.length - 1, true);
  $('endTime').textContent = timeLabel(rows.length - 1);
  $('jumpDate').min = rows[0].time.slice(0, 10);
  $('jumpDate').max = rows.at(-1).time.slice(0, 10);
  focusChartWindow(index);
  refreshAnalysis();
}
function refreshAnalysis(redrawHeatmap = true) {
  buildAnalysis();
  drawSeries();
  if (redrawHeatmap) drawHeatmap();
  drawBars();
  drawBox();
  drawStatus();
  drawCumulative();
  drawRhythm();
  drawEvents();
  drawBatchTable();
  if (redrawHeatmap) buildComparison();
  drawComparison();
  drawParallel();
  applyChartWindow();
  setTime(index);
  requestAnimationFrame(() => Object.values(charts).forEach(chart => chart.resize()));
}
function cursorLines() {
  return [
    { yAxis: low, name: '下限', lineStyle: { color: colors.red, type: 'dashed' }, label: { formatter: '下限' } },
    { yAxis: high, name: '上限', lineStyle: { color: colors.red, type: 'dashed' }, label: { formatter: '上限' } },
    { xAxis: rows[index].time, lineStyle: { color: colors.green, width: 1.3 }, label: { formatter: '当前' } }
  ];
}
function drawSeries() {
  const primary = rows.map(row => valid(reading(row)) ? reading(row) : null);
  const average = rows.map(mean);
  const values = primary.concat(average, [low, high]).filter(valid);
  const minimum = Math.floor(Math.min(...values) - 1);
  const maximum = Math.ceil(Math.max(...values) + 1);
  const option = {
    animation: false,
    color: [colors.green, colors.gold],
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    legend: { top: 5, left: 8, data: [sensorLabel[selectedSensor], '九点均值'], textStyle: { fontSize: 11 } },
    tooltip: {
      trigger: 'axis',
      formatter: items => {
        const header = String(items[0]?.axisValue || '').replace('T', ' ');
        return header + items.map(item => '<br>' + item.marker + item.seriesName + '：' + (valid(item.value) ? number(item.value, 2) + ' °C' : '缺测')).join('');
      }
    },
    grid: { left: 49, right: 24, top: 48, bottom: 74 },
    xAxis: {
      type: 'category', boundaryGap: false, data: rows.map(row => row.time),
      axisLabel: { color: colors.muted, fontSize: 10, interval: chartLabelInterval(), formatter: value => value.slice(5, 10).replace('-', '/') + '\n' + value.slice(11, 16) },
      axisLine: { lineStyle: { color: '#cdd9cd' } }
    },
    yAxis: { type: 'value', name: '°C', min: minimum, max: maximum, splitLine: { lineStyle: { color: '#edf1ec' } } },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, startValue: chartWindowStart, endValue: chartWindowEnd },
      { type: 'slider', xAxisIndex: 0, height: 18, bottom: 17, startValue: chartWindowStart, endValue: chartWindowEnd, borderColor: '#dde6dc', fillerColor: 'rgba(35,115,83,.11)' }
    ],
    series: [
      {
        name: sensorLabel[selectedSensor], type: 'line', showSymbol: false, connectNulls: false,
        data: primary, lineStyle: { width: 2.5 }, itemStyle: { color: colors.green },
        markArea: { silent: true, itemStyle: { color: 'rgba(35,115,83,.055)' }, data: [[{ yAxis: low }, { yAxis: high }]] },
        markLine: { silent: true, symbol: 'none', label: { fontSize: 10 }, data: cursorLines() }
      },
      {
        name: '九点均值', type: 'line', showSymbol: false, connectNulls: false,
        data: average, lineStyle: { width: 1.5, type: 'dashed' }, itemStyle: { color: colors.gold },
        emphasis: { disabled: true }
      }
    ]
  };
  charts.series.setOption(option, true);
}
function heatColor(value) {
  if (!valid(value)) return '#d8ded9';
  if (heatMode === 'temperature') {
    const stops = [[34,72,120], [55,135,157], [133,196,171], [246,230,146]];
    const t = Math.max(0, Math.min(1, (value - temperatureExtent[0]) / (temperatureExtent[1] - temperatureExtent[0]))) * 3;
    const i = Math.min(2, Math.floor(t));
    return 'rgb(' + stops[i].map((c, j) => Math.round(c + (stops[i + 1][j] - c) * (t - i))).join(',') + ')';
  }
  if (value < low) return '#729abf';
  if (value > high) return '#c56550';
  return '#75aa80';
}
function drawHeatmap() {
  $('statusLegend').hidden = heatMode !== 'status';
  $('temperatureLegend').hidden = heatMode !== 'temperature';
  $('temperatureLegend').textContent = '固定温标：' + temperatureExtent[0] + ' 至 ' + temperatureExtent[1] + ' °C（深蓝 → 浅黄），所有批次共用；灰色表示缺测。';
  $('temperatureLegend').classList.add('temperature-scale');
  const cells = [];
  rows.forEach((row, timeIndex) => {
    sensors.forEach(([key], sensorIndex) => {
      const value = row.temperatures[key];
      cells.push({
        value: [timeIndex, sensorIndex, valid(value) ? value : 0],
        itemStyle: { color: heatColor(value) }
      });
    });
  });
  charts.heatmap.setOption({
    animation: false,
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: item => {
        const [timeIndex, sensorIndex] = item.value;
        const value = rows[timeIndex].temperatures[sensors[sensorIndex][0]];
        const state = !valid(value) ? '缺测' : value < low ? '低于下限' : value > high ? '高于上限' : '范围内';
        return rows[timeIndex].time.replace('T', ' ') + '<br>' +
          sensors[sensorIndex][1] + '：' + (valid(value) ? number(value, 2) + ' °C' : '缺测') +
          '<br>当前阈值：' + state;
      }
    },
    grid: { left: 57, right: 18, top: 11, bottom: 68 },
    xAxis: {
      type: 'category', data: rows.map(row => row.time),
      axisLabel: { color: colors.muted, fontSize: 10, interval: chartLabelInterval('heatmap'),
        formatter: value => value.slice(5, 10).replace('-', '/') + '\n' + value.slice(11, 16) },
      axisLine: { lineStyle: { color: '#cdd9cd' } }, axisTick: { show: false }
    },
    yAxis: {
      type: 'category', inverse: true, data: sensors.map(([, label]) => label),
      axisLabel: { color: colors.muted, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false }
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: 0, startValue: chartWindowStart, endValue: chartWindowEnd },
      { type: 'slider', xAxisIndex: 0, height: 18, bottom: 14, startValue: chartWindowStart,
        endValue: chartWindowEnd, borderColor: '#dde6dc', fillerColor: 'rgba(35,115,83,.11)' }
    ],
    series: [{ type: 'heatmap', data: cells, progressive: 4000,
      emphasis: { itemStyle: { borderColor: '#18392d', borderWidth: 1 } } },
      { type: 'scatter', silent: true, symbol: 'rect', symbolSize: [12, 23], z: 5,
        itemStyle: { color: 'transparent', borderColor: '#18392d', borderWidth: 2 },
        data: [[index, sensors.findIndex(([key]) => key === selectedSensor)]] }]
  }, true);
}
function drawBars() {
  const details = sensors.map(([key]) => statsFor(rows, key));
  charts.bars.setOption({
    animation: false,
    color: [colors.red, colors.gray],
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    legend: { top: 3, data: ['越界', '缺测'], textStyle: { fontSize: 11 } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: value => number(value, 2) + ' h' },
    grid: { left: 59, right: 15, top: 43, bottom: 29 },
    xAxis: { type: 'value', name: 'h', nameLocation: 'end', splitLine: { lineStyle: { color: '#edf1ec' } } },
    yAxis: { type: 'category', inverse: true, data: sensors.map(([, label]) => label), axisLine: { show: false }, axisTick: { show: false } },
    series: [
      { name: '越界', type: 'bar', barWidth: 8, data: details.map(item => item.outsideIntervals / 6), itemStyle: { borderRadius: [0, 3, 3, 0] } },
      { name: '缺测', type: 'bar', barWidth: 8, data: details.map(item => item.missingIntervals / 6), itemStyle: { borderRadius: [0, 3, 3, 0] } }
    ]
  }, true);
}
function temperatureValues(readings, key) {
  return readings.map(row => row.temperatures[key]).filter(valid);
}
function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position), rest = position - base;
  const next = base + 1 < sorted.length ? sorted[base + 1] : sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}
function drawBox() {
  const summaries = data.shipments.map(batch => {
    const values = temperatureValues(batch.readings, selectedSensor).sort((a, b) => a - b);
    if (!values.length) return null;
    return [values[0], quantile(values, 0.25), quantile(values, 0.5), quantile(values, 0.75), values[values.length - 1]];
  });
  charts.box.setOption({
    animation: false,
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    tooltip: {
      trigger: 'item',
      formatter: info => {
        const summary = summaries[info.dataIndex];
        if (!summary) return info.name + '：无有效读数';
        return info.name + '<br>最大 ' + number(summary[4]) + ' °C<br>75% ' + number(summary[3]) +
          ' °C<br>中位 ' + number(summary[2]) + ' °C<br>25% ' + number(summary[1]) +
          ' °C<br>最小 ' + number(summary[0]) + ' °C';
      }
    },
    grid: { left: 54, right: 58, top: 30, bottom: 34 },
    xAxis: { type: 'category', data: data.shipments.map(batch => batch.id), axisTick: { show: false }, axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', name: '°C', nameTextStyle: { fontSize: 10 }, splitLine: { lineStyle: { color: '#edf1ec' } } },
    series: [{
      type: 'boxplot', boxWidth: ['26%', '52%'],
      itemStyle: { color: 'rgba(65,107,62,.16)', borderColor: colors.green, borderWidth: 1.4 },
      data: summaries.map(summary => summary || '-'),
      markLine: {
        silent: true, symbol: 'none',
        label: { fontSize: 10, color: colors.red, formatter: item => item.name },
        lineStyle: { color: colors.red, type: 'dashed', width: 1 },
        data: [{ name: '下限 ' + number(low) + ' °C', yAxis: low }, { name: '上限 ' + number(high) + ' °C', yAxis: high }]
      }
    }]
  }, true);
  $('boxHint').textContent = sensorLabel[selectedSensor] + ' · 阈值 ' + number(low) + '–' + number(high) + ' °C';
}
function drawStatus() {
  const fills = ['#4d7ea8', '#6f9a5f', '#b45646', '#aab3a2'];
  const details = data.shipments.map(batch => {
    const total = Math.max(batch.readings.length - 1, 0);
    let below = 0, inside = 0, above = 0, missing = 0;
    for (let i = 0; i < total; i++) {
      const value = batch.readings[i].temperatures[selectedSensor];
      if (!valid(value)) missing += 1;
      else if (value < low) below += 1;
      else if (value > high) above += 1;
      else inside += 1;
    }
    return { id: batch.id, total, below, inside, above, missing };
  });
  const percent = (value, total) => total ? value / total * 100 : 0;
  charts.status.setOption({
    animation: false,
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    legend: { top: 4, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: params => {
        const item = details[params[0].dataIndex];
        return item.id + '（共 ' + number(item.total, 0) + ' 个区间）<br>' + params.map(entry =>
          entry.marker + entry.seriesName + ' ' + number(entry.value) + '% · ' +
          number(entry.value * item.total / 100, 1) + ' h').join('<br>');
      }
    },
    grid: { left: 54, right: 22, top: 40, bottom: 26 },
    xAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 }, splitLine: { lineStyle: { color: '#edf1ec' } } },
    yAxis: { type: 'category', data: details.map(item => item.id), inverse: true, axisTick: { show: false }, axisLabel: { fontSize: 11 } },
    series: [
      { name: '低于下限', type: 'bar', stack: 'total', barWidth: 14, data: details.map(item => percent(item.below, item.total)), itemStyle: { color: fills[0] } },
      { name: '范围内', type: 'bar', stack: 'total', barWidth: 14, data: details.map(item => percent(item.inside, item.total)), itemStyle: { color: fills[1] } },
      { name: '高于上限', type: 'bar', stack: 'total', barWidth: 14, data: details.map(item => percent(item.above, item.total)), itemStyle: { color: fills[2] } },
      { name: '缺测', type: 'bar', stack: 'total', barWidth: 14, data: details.map(item => percent(item.missing, item.total)), itemStyle: { color: fills[3] } }
    ]
  }, true);
  $('statusHint').textContent = sensorLabel[selectedSensor] + ' · 区间占比';
}
function drawCumulative() {
  const seriesData = data.shipments.map(batch => {
    const total = Math.max(batch.readings.length - 1, 0);
    const points = [];
    let accumulated = 0, last = -1;
    for (let i = 0; i < total; i++) {
      const value = batch.readings[i].temperatures[selectedSensor];
      if (valid(value) && (value < low || value > high)) accumulated += 1;
      if (accumulated !== last) {
        points.push([+(i * 10 / 60).toFixed(2), +(accumulated / 6).toFixed(2)]);
        last = accumulated;
      }
    }
    points.push([+(total * 10 / 60).toFixed(2), +(accumulated / 6).toFixed(2)]);
    return { id: batch.id, points };
  });
  charts.cumulative.setOption({
    animation: false,
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    legend: { top: 2, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11 }, selectedMode: false },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, valueFormatter: value => number(value) + ' h' },
    grid: { left: 58, right: 20, top: 42, bottom: 34 },
    xAxis: { type: 'value', name: '距首条记录 h', nameLocation: 'end', nameTextStyle: { fontSize: 10 }, splitLine: { lineStyle: { color: '#edf1ec' } } },
    yAxis: { type: 'value', name: '累计越界 h', nameTextStyle: { fontSize: 10 }, splitLine: { lineStyle: { color: '#edf1ec' } } },
    series: seriesData.map((item, index) => ({
      name: item.id, type: 'line', step: 'end', symbol: 'none', data: item.points,
      lineStyle: { width: 2, color: batchPalette[index] }, itemStyle: { color: batchPalette[index] },
      emphasis: { focus: 'series' }
    }))
  }, true);
  $('cumulativeHint').textContent = sensorLabel[selectedSensor] + ' · 越界累计';
}
function drawRhythm() {
  const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
  const buckets = new Map();
  for (const row of rows) {
    const day = row.time.slice(0, 10);
    const hour = Number(row.time.slice(11, 13));
    if (!buckets.has(day)) buckets.set(day, Array.from({ length: 24 }, () => []));
    const value = row.temperatures[selectedSensor];
    if (valid(value)) buckets.get(day)[hour].push(value);
  }
  const days = [...buckets.keys()].filter(day => buckets.get(day).some(list => list.length));
  const cells = [], missingCells = [], values = [];
  days.forEach((day, y) => hours.forEach((_, x) => {
    const list = buckets.get(day)[x];
    if (!list.length) { missingCells.push([x, y]); return; }
    const value = +(list.reduce((sum, item) => sum + item, 0) / list.length).toFixed(1);
    cells.push([x, y, value]);
    values.push(value);
  }));
  const min = values.length ? Math.floor(Math.min(...values)) : 0;
  const max = values.length ? Math.ceil(Math.max(...values)) : 1;
  charts.rhythm.setOption({
    animation: false,
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    tooltip: {
      formatter: info => {
        const [x, y, value] = info.data;
        return days[y] + ' ' + hours[x] + ':00<br>' + (value == null ? '无有效读数' : number(value) + ' °C');
      }
    },
    grid: { left: 92, right: 22, top: 24, bottom: 70 },
    xAxis: { type: 'category', data: hours, splitArea: { show: true }, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'category', data: days, inverse: true, splitArea: { show: true }, axisLabel: { fontSize: 10 } },
    visualMap: {
      min, max, seriesIndex: 0, orient: 'horizontal', left: 'center', bottom: 8,
      itemWidth: 12, itemHeight: 90, text: ['高温', '低温'], textStyle: { fontSize: 10 }, calculable: true,
      inRange: { color: ['#224878', '#37879d', '#85c4ab', '#f6e692', '#d9995b', '#b45646'] }
    },
    series: [
      { type: 'heatmap', data: cells, itemStyle: { borderColor: '#fff', borderWidth: 1 } },
      { type: 'heatmap', data: missingCells, itemStyle: { color: '#e3e7dd', borderColor: '#fff', borderWidth: 1 }, silent: true }
    ]
  }, true);
  $('rhythmHint').textContent = shipment.id + ' · ' + days.length + ' 天 · ' + sensorLabel[selectedSensor];
}
function drawParallel() {
  const dimensions = ['覆盖率 %', '越界率 %', '高温 h', '低温 h', '温差 °C'];
  const profiles = data.shipments.map(batch => {
    const readings = batch.readings;
    const total = Math.max(readings.length - 1, 0);
    let below = 0, above = 0, validIntervals = 0;
    for (let i = 0; i < total; i++) {
      const value = readings[i].temperatures[selectedSensor];
      if (!valid(value)) continue;
      validIntervals += 1;
      if (value < low) below += 1;
      else if (value > high) above += 1;
    }
    let spreadSum = 0, spreadCount = 0;
    for (const row of readings) {
      const values = Object.values(row.temperatures).filter(valid);
      if (values.length < 2) continue;
      spreadSum += Math.max(...values) - Math.min(...values);
      spreadCount += 1;
    }
    return [
      +(validIntervals / (total || 1) * 100).toFixed(1),
      +(validIntervals ? (below + above) / validIntervals * 100 : 0).toFixed(1),
      +(above / 6).toFixed(1),
      +(below / 6).toFixed(1),
      +(spreadCount ? spreadSum / spreadCount : 0).toFixed(1)
    ];
  });
  const ranges = dimensions.map((_, index) => {
    const values = profiles.map(profile => profile[index]);
    const lower = Math.min(...values), upper = Math.max(...values);
    return lower === upper ? [lower, lower + 1] : [lower, upper];
  });
  charts.parallel.setOption({
    animation: false,
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    legend: { data: data.shipments.map(batch => batch.id), top: 4, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11 }, selectedMode: false },
    parallel: {
      top: 84, left: 72, right: 86, bottom: 26,
      parallelAxisDefault: {
        type: 'value', nameTextStyle: { fontSize: 11, color: colors.muted, align: 'center' },
        axisLabel: { fontSize: 10 }, splitLine: { show: false },
        axisLine: { lineStyle: { color: '#cdd6c6' } }
      }
    },
    parallelAxis: dimensions.map((name, index) => ({ dim: index, name, min: ranges[index][0], max: ranges[index][1] })),
    series: data.shipments.map((batch, index) => ({
      name: batch.id, type: 'parallel', data: [profiles[index]],
      lineStyle: { width: 2, color: batchPalette[index], opacity: 0.9 },
      itemStyle: { color: batchPalette[index] },
      emphasis: { lineStyle: { width: 3.5 } }
    }))
  }, true);
}
function drawEvents() {
  const filter = $('eventFilter').value;
  const visible = events.filter(event => filter === 'outside' ? event.kind !== 'missing' : event.kind === filter);
  if ($('eventSort').value === 'duration') visible.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  $('eventCount').textContent = number(visible.length, 0) + ' 个区间';
  const container = $('events');
  container.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = filter === 'missing' ? '该测点全程没有缺测区间。' : '当前筛选下没有越界区间。缺测记录可在“缺测区间”中查看。';
    container.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  visible.forEach(event => {
    const button = document.createElement('button');
    button.className = 'event ' + event.kind;
    button.type = 'button';
    button.dataset.start = String(event.start);
    button.dataset.end = String(event.end);
    const left = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = timeLabel(event.start) + ' — ' + timeLabel(event.end);
    const detail = document.createElement('small');
    detail.textContent = stateLabels[event.kind] + (event.kind === 'missing' ? ' · 原始记录无读数' : ' · 最低 ' + number(event.min) + ' °C · 最高 ' + number(event.max) + ' °C');
    left.append(title, detail);
    const duration = document.createElement('em');
    duration.textContent = number((event.end - event.start) / 6, 2) + ' h';
    button.append(left, duration);
    button.addEventListener('click', () => {
      stop();
      if (event.start < chartWindowStart || event.start > chartWindowEnd) {
        viewScope = 'day'; $('viewWindow').value = viewScope;
        focusChartWindow(event.start); applyChartWindow();
      }
      setTime(event.start);
      navigateToPage('timeline');
      charts.series.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: index });
    });
    fragment.append(button);
  });
  container.append(fragment);
}
function drawBatchTable() {
  const body = $('batchRows');
  body.replaceChildren();
  const fragment = document.createDocumentFragment();
  data.shipments.forEach(item => {
    const stats = statsFor(item.readings, selectedSensor);
    const coverage = coverageRate(stats, item.readings);
    const quality = qualityLevel(coverage);
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.className = item.id === shipment.id ? 'selected' : '';
    tr.setAttribute('aria-label', '切换到 ' + item.id + ' 批次');
    const identity = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = item.id;
    const range = document.createElement('small');
    range.className = 'batch-subtext';
    range.textContent = number(item.readings.length, 0) + ' 点 · ' +
      item.readings[0].time.slice(5, 10).replace('-', '/') + '–' +
      item.readings.at(-1).time.slice(5, 10).replace('-', '/');
    identity.append(name, range);
    tr.append(identity);
    const values = [
      number(coverage * 100, 1) + '%',
      outsideRate(stats) === null ? '—' : number(outsideRate(stats) * 100, 1) + '%',
      number(stats.outsideIntervals / 6, 1) + ' / ' + number(stats.validIntervals / 6, 1) + ' h'
    ];
    values.forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.append(td); });
    const qualityCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'quality-badge ' + quality.className;
    badge.textContent = quality.label;
    qualityCell.append(badge);
    tr.append(qualityCell);
    tr.addEventListener('click', () => chooseBatch(item.id));
    tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tr.click(); } });
    fragment.append(tr);
  });
  body.append(fragment);
  const coverage = coverageRate(selectedStats, rows);
  const notice = $('qualityNotice');
  notice.className = 'quality-note ' + qualityLevel(coverage).className;
  notice.textContent = shipment.id + ' · ' + sensorLabel[selectedSensor] + '：有效覆盖 ' +
    number(coverage * 100, 1) + '%。' +
    (coverage < .5
      ? '缺测过半；越界率仅描述有读数的区间，不能代表未观测的时间。'
      : coverage < .9
        ? '存在较多缺测；跨批次比较时请同时看覆盖率和采样时长。'
        : '越界率仍只基于有读数的区间，不能推断品质或损耗。');
}
function buildComparison() {
  comparisonRecords = data.shipments.flatMap(batch => sensors.map(([key, label]) => {
    const stats = statsFor(batch.readings, key);
    return { id: batch.id + '/' + key, batch: batch.id, key, label,
      coverage: coverageRate(stats, batch.readings) * 100,
      rate: outsideRate(stats) === null ? null : outsideRate(stats) * 100,
      validHours: stats.validIntervals / 6, outsideHours: stats.outsideIntervals / 6 };
  }));
}
function comparisonCandidates() {
  return comparisonRecords.filter(item => item.coverage >= Number($('minCoverage').value));
}
function drawComparison() {
  // Geometry changes after filtering or threshold edits invalidate any previous brush.
  brushedKeys = null;
  const candidates = comparisonCandidates();
  comparisonSeries = data.shipments.map(batch => candidates.filter(item => item.batch === batch.id && item.rate !== null));
  charts.comparison.setOption({
    animation: false,
    textStyle: { fontFamily: 'Microsoft YaHei', color: colors.muted },
    color: batchPalette,
    legend: { top: 6, left: 0, right: 0, itemWidth: 10, itemHeight: 10, itemGap: 9, selectedMode: false, textStyle: { fontSize: 11 } },
    toolbox: { top: 31, right: 6, feature: { brush: { type: ['rect', 'clear'], title: { rect: '框选测点', clear: '清除框选' } } } },
    brush: { toolbox: ['rect', 'clear'], xAxisIndex: 0, yAxisIndex: 0, brushMode: 'single', throttleType: 'debounce', throttleDelay: 100 },
    grid: { left: 58, right: 22, top: 79, bottom: 55 },
    xAxis: { type: 'value', min: 0, max: 100, name: '有效覆盖率 %', nameLocation: 'middle', nameGap: 30, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: '#edf1ec' } } },
    yAxis: { type: 'value', min: 0, max: 100, name: '越界率 %', axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: '#edf1ec' } } },
    tooltip: { confine: true, formatter: item => {
      const record = item.data.record;
      return record.batch + ' · ' + record.label + '<br>有效覆盖：' + number(record.coverage) + '%<br>越界率：' + number(record.rate) +
        '%<br>越界 / 有效时长：' + number(record.outsideHours) + ' / ' + number(record.validHours) + ' h<br>' + qualityLevel(record.coverage / 100).label;
    } },
    series: comparisonSeries.map((records, batchIndex) => ({
      name: data.shipments[batchIndex].id, type: 'scatter', symbol: batchSymbols[batchIndex], clip: false,
      data: records.map(record => ({ value: [record.coverage, record.rate], record,
        symbolSize: record.batch === shipment.id && record.key === selectedSensor ? 17 : 10,
        itemStyle: { opacity: .85, borderWidth: record.batch === shipment.id && record.key === selectedSensor ? 2 : 0, borderColor: '#18392d' } }))
    }))
  }, true);
  drawComparisonList();
}
function drawComparisonList() {
  const candidates = comparisonCandidates();
  const visible = candidates.filter(item => brushedKeys === null || brushedKeys.has(item.id));
  const sort = $('comparisonSort').value;
  visible.sort((a, b) => sort === 'coverage' ? b.coverage - a.coverage || a.id.localeCompare(b.id) :
    sort === 'outside' ? (b.rate ?? -1) - (a.rate ?? -1) || a.id.localeCompare(b.id) : a.id.localeCompare(b.id));
  $('comparisonCount').textContent = visible.length + ' / 54 个批次测点';
  const missing = candidates.filter(item => item.rate === null).length;
  $('comparisonStatus').textContent = (brushedKeys === null ? '符合覆盖筛选' : '当前框选') + '：' + visible.length + ' 个；' +
    (missing ? missing + ' 个无有效区间，仅在未框选列表中显示。' : '点击记录可联动查看原始数据。');
  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'comparison-item' + (item.batch === shipment.id && item.key === selectedSensor ? ' selected' : '');
    button.dataset.key = item.id;
    button.setAttribute('aria-pressed', String(item.batch === shipment.id && item.key === selectedSensor));
    const identity = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = item.batch + ' · ' + item.label;
    const note = document.createElement('small'); note.textContent = '覆盖 ' + number(item.coverage) + '% · 有效 ' + number(item.validHours) + ' h';
    identity.append(title, note);
    const value = document.createElement('em'); value.textContent = item.rate === null ? '越界率 —' : '越界 ' + number(item.rate) + '%';
    button.append(identity, value);
    button.addEventListener('click', () => selectComparison(item));
    fragment.append(button);
  }
  if (!visible.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = '没有符合条件的测点，请降低覆盖门槛或清除框选。'; fragment.append(empty);
  }
  $('comparisonList').replaceChildren(fragment);
}
function selectComparison(item) {
  selectedSensor = item.key;
  $('sensor').value = item.key;
  chooseBatch(item.batch);
  navigateToPage('timeline');
}
function drawSensorGrid() {
  const grid = $('sensorGrid');
  grid.replaceChildren();
  const fragment = document.createDocumentFragment();
  const current = rows[index].temperatures;
  sensors.forEach(([key, label]) => {
    const value = current[key];
    const kind = ColdChainAnalysis.state(value, low, high);
    const button = document.createElement('button');
    button.className = 'sensor-cell' + (key === selectedSensor ? ' selected' : '') + (outside(value) ? ' alert' : '') + (!valid(value) ? ' missing' : '');
    button.type = 'button';
    button.classList.add(kind);
    button.setAttribute('aria-pressed', String(key === selectedSensor));
    const name = document.createElement('small');
    name.textContent = label;
    const readingText = document.createElement('strong');
    readingText.textContent = valid(value) ? number(value) + ' °C' : '缺测';
    const state = document.createElement('span');
    state.className = 'sensor-state';
    state.textContent = stateLabels[kind];
    button.append(name, readingText, state);
    button.addEventListener('click', () => selectSensor(key));
    fragment.append(button);
  });
  grid.append(fragment);
  $('sensorStamp').textContent = timeLabel(index);
}
function selectSensor(key, targetIndex = null) {
  if (!sensorLabel[key]) return;
  stop();
  selectedSensor = key;
  if (targetIndex !== null) {
    index = targetIndex;
    // Selecting a visible heatmap cell preserves the user's zoom window.
  }
  $('sensor').value = key;
  refreshAnalysis(false);
}
function setTime(value) {
  index = Math.max(0, Math.min(rows.length - 1, Math.round(Number(value))));
  $('time').value = String(index);
  $('timeLabel').textContent = timeLabel(index);
  $('heatmapSelection').textContent = timeLabel(index) + ' · ' + sensorLabel[selectedSensor];
  $('jumpDate').value = rows[index].time.slice(0, 10);
  const row = rows[index];
  const valueNow = reading(row);
  $('temp').textContent = valid(valueNow) ? number(valueNow) + ' °C' : '缺测';
  $('temp').classList.toggle('alert', outside(valueNow));
  $('tempState').textContent = valid(valueNow)
    ? (outside(valueNow) ? '超出' : '位于') + ' ' + low + '–' + high + ' °C 分析阈值'
    : '原始记录中该位置无读数';
  $('exposure').textContent = number(prefixOutside[index] / 6, 2) + ' h';
  $('exposureNote').textContent = prefixMissing[index]
    ? '另有 ' + number(prefixMissing[index] / 6, 2) + ' h 缺测，未计入'
    : '按 10 分钟区间累计';
  const values = Object.values(row.temperatures).filter(valid);
  $('coverage').textContent = values.length + ' / 9';
  $('coverageNote').textContent = '该测点全程有效区间 ' + number(coverageRate(selectedStats, rows) * 100, 1) + '%';
  $('spread').textContent = values.length >= 2 ? number(Math.max(...values) - Math.min(...values), 1) + ' °C' : '—';
  $('spreadNote').textContent = values.length >= 2 ? '当前有效测点最高值 − 最低值' : '有效测点不足两个';
  drawSensorGrid();
  document.querySelectorAll('.event').forEach(button => {
    const start = Number(button.dataset.start);
    const end = Number(button.dataset.end);
    button.classList.toggle('active', index >= start && index < end);
  });
  if (viewScope === 'day' && (index < chartWindowStart || index > chartWindowEnd)) {
    focusChartWindow(index);
    applyChartWindow();
  }
  charts.series.setOption({ series: [{ markLine: { data: cursorLines() } }] });
  charts.heatmap.setOption({ series: [{}, { data: [[index, sensors.findIndex(([key]) => key === selectedSensor)]] }] });
}
function exportCsv() {
  const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const header = ['time', 'shipment_id', ...sensors.map(([key]) => key), 'selected_sensor', 'selected_temp_C', 'low_C', 'high_C', 'out_of_range'];
  const lines = [header.join(',')];
  rows.forEach(row => {
    const value = reading(row);
    lines.push([
      row.time, shipment.id, ...sensors.map(([key]) => row.temperatures[key]),
      selectedSensor, value, low, high, valid(value) ? Number(outside(value)) : ''
    ].map(quote).join(','));
  });
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = shipment.id + '_草莓实测温度.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function bindEvents() {
  $('batch').addEventListener('change', event => chooseBatch(event.target.value));
  $('sensor').addEventListener('change', event => selectSensor(event.target.value));
  $('reset').addEventListener('click', () => {
    selectedSensor = 'Middle_Middle';
    $('sensor').value = selectedSensor;
    viewScope = 'day';
    $('viewWindow').value = viewScope;
    low = 0;
    high = 4;
    $('low').value = low;
    $('high').value = high;
    $('thresholdError').textContent = '';
    heatMode = 'status'; $('heatMode').value = heatMode;
    $('eventFilter').value = 'outside'; $('eventSort').value = 'time';
    $('minCoverage').value = '0'; $('comparisonSort').value = 'outside';
    chooseBatch('S3');
  });
  $('heatMode').addEventListener('change', event => { heatMode = event.target.value; drawHeatmap(); });
  for (const id of ['eventFilter', 'eventSort']) $(id).addEventListener('change', () => { drawEvents(); setTime(index); });
  $('minCoverage').addEventListener('change', drawComparison);
  $('comparisonSort').addEventListener('change', drawComparisonList);
  $('clearBrush').addEventListener('click', () => {
    charts.comparison.dispatchAction({ type: 'brush', areas: [] });
    charts.comparison.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: false } });
    brushedKeys = null; drawComparisonList();
  });
  $('export').addEventListener('click', exportCsv);
  $('time').addEventListener('input', event => { stop(); setTime(event.target.value); });
  $('jumpDate').addEventListener('change', event => {
    const target = rows.findIndex(row => row.time.startsWith(event.target.value));
    if (target < 0) return;
    stop();
    focusChartWindow(target);
    applyChartWindow();
    setTime(target);
  });
  $('viewWindow').addEventListener('change', event => {
    viewScope = event.target.value === 'all' ? 'all' : 'day';
    focusChartWindow(index);
    applyChartWindow();
  });
  $('play').addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (index === rows.length - 1) setTime(0);
    $('play').textContent = 'Ⅱ 暂停';
    $('play').setAttribute('aria-label', '暂停时间回放');
    timer = setInterval(() => {
      setTime(index + 1);
      if (index === rows.length - 1) stop();
    }, Number($('speed').value));
  });
  $('speed').addEventListener('change', () => {
    if (timer) { stop(); $('play').click(); }
  });
  for (const id of ['low', 'high']) {
    $(id).addEventListener('input', () => {
      const nextLow = $('low').valueAsNumber;
      const nextHigh = $('high').valueAsNumber;
      if (!Number.isFinite(nextLow) || !Number.isFinite(nextHigh) || nextLow >= nextHigh || nextLow < -30 || nextHigh > 50) {
        $('thresholdError').textContent = '需满足 −30 ≤ 下限 < 上限 ≤ 50';
        return;
      }
      low = nextLow;
      high = nextHigh;
      $('thresholdError').textContent = '';
      refreshAnalysis();
    });
  }
  charts.series.on('click', item => {
    if (item.componentType === 'series') { stop(); setTime(item.dataIndex); }
  });
  for (const id of ['series', 'heatmap']) charts[id].on('datazoom', () => handleZoom(id));
  charts.comparison.on('click', item => { if (item.data?.record) selectComparison(item.data.record); });
  charts.comparison.on('brushSelected', event => {
    const selection = event.batch?.[0];
    if (!selection) return;
    brushedKeys = selection.areas?.length ? new Set(selection.selected.flatMap(series =>
      series.dataIndex.map(i => comparisonSeries[series.seriesIndex][i].id))) : null;
    drawComparisonList();
  });
  charts.bars.on('click', item => selectSensor(sensors[item.dataIndex][0]));
  charts.heatmap.on('click', item => {
    if (item.componentType !== 'series' || item.seriesIndex !== 0) return;
    const [timeIndex, sensorIndex] = item.value;
    selectSensor(sensors[sensorIndex][0], timeIndex);
  });
}
async function init() {
  bindNavigation();
  let mode = '离线快照';
  if (location.protocol !== 'file:') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/api/data', { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw Error('读取接口失败');
      const loaded = await response.json();
      if (!Array.isArray(loaded.shipments) || loaded.shipments.length !== 6 ||
        loaded.shipments.some(batch => !Array.isArray(batch.readings) || !batch.readings.length)) throw Error('数据格式不完整');
      data = loaded;
      mode = response.headers.get('X-Data-Storage') === 'sqlite' ? 'SQLite 数据库' : '数据接口';
    } catch (_) { mode = '离线快照（接口不可用）'; }
    finally { clearTimeout(timeout); }
  }
  if (!data || !Array.isArray(data.shipments) || data.shipments.length !== 6) {
    $('sourceBanner').textContent = '实测数据未找到或格式不完整，请确认 data/real_snapshot.js 与页面位于同一项目。';
    return;
  }
  data.shipments.forEach(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.id + ' · ' + number(item.readings.length, 0) + ' 时点';
    $('batch').append(option);
  });
  sensors.forEach(([key, label]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    $('sensor').append(option);
  });
  $('sensor').value = selectedSensor;
  $('low').value = low;
  $('high').value = high;
  measuredModeLabel = '公开研究实测 · ' + mode;
  updatePageDataLabel();
  $('storageMode').textContent = mode;
  let total = 0, missing = 0, min = Infinity, max = -Infinity;
  for (const batch of data.shipments) for (const row of batch.readings) {
    total++;
    for (const value of Object.values(row.temperatures)) {
      if (!valid(value)) missing++;
      else { min = Math.min(min, value); max = Math.max(max, value); }
    }
  }
  temperatureExtent = [Math.floor(min), Math.ceil(max)];
  if (temperatureExtent[0] === temperatureExtent[1]) temperatureExtent[1]++;
  $('datasetSummary').textContent = '6 个批次 · 9 个测点 · ' + number(total, 0) + ' 个时点。共 ' + number(total * 9, 0) + ' 个测点时点，其中 ' + number(missing, 0) + ' 个缺测。';
  bindEvents();
  chooseBatch('S3');
}
init();



