# 完整示例：token-trend-dashboard

以下是基于 `data-schema.json` 形状的完整合法 Widget（小时桶、双模型、12 个数据点，故使用 Chart.js）。
渲染时替换为当次 `token_usage_trend` 的真实返回；保持结构、主题令牌与交互契约不变。

设计语言（避免"模板后台"廉价感的关键）：

- **一条整体 KPI 带**（内部用分隔线，不是四个孤立盒子）；
- **窗口选择栏**合并为单个表面：开始 → 结束 + 分段式预设（segmented control）+ 主按钮；
- **模型占比条**：KPI 下方一条细分段条，直接看出各模型份额；
- **图例带数值**：模型名后附 compact tokens 与"自定义"徽记；
- 数字一律 `font-variant-numeric: tabular-nums`；8px 间距节奏；无阴影无渐变，靠层级与留白取胜。

<mavis-widget
  version="mavis.widget.v1"
  kind="dashboard"
  title="token 用量趋势"
  height="760"
  min-height="600"
  max-height="940"
  streaming="html-first"
  capabilities="resize,sendPrompt"
  theme="app"
  token-set="mavis.semantic.v1">
  <mavis-meta type="json">{"summary":"窗口内共 10.6M tokens、146 次调用，整体缓存命中率 96.3%，K3 占主导。","dataSource":"token_usage_trend（本机 runtime sqlite + 日志补全）","chartType":"combo","datasetShape":{"rows":12,"dimensions":["bucket","model"],"measures":["totalTokens","cacheHitRate"]},"interactions":[{"id":"apply-window","label":"应用时间窗口","capability":"sendPrompt"},{"id":"analyze-window","label":"分析这个窗口","capability":"sendPrompt"}]}</mavis-meta>
  <mavis-style>
body{margin:0;padding:20px;background:var(--mw-bg);color:var(--mw-text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.title{font-size:16px;font-weight:500}
.meta{font-size:12px;color:var(--mw-text-subtle);font-variant-numeric:tabular-nums}
.win-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--mw-surface);border:1px solid var(--mw-border);border-radius:12px;padding:10px 12px;margin-bottom:16px}
.win-field{display:flex;align-items:center;gap:6px}
.win-field span{font-size:12px;color:var(--mw-text-muted)}
.win-arrow{font-size:12px;color:var(--mw-text-subtle)}
.win-bar input{font:inherit;font-size:13px;color:var(--mw-text);background:var(--mw-surface-muted);border:1px solid var(--mw-border);border-radius:8px;padding:5px 8px;font-variant-numeric:tabular-nums}
.win-bar input:focus-visible{outline:2px solid var(--mw-accent);outline-offset:1px}
.seg{display:inline-flex;border:1px solid var(--mw-border);border-radius:8px;overflow:hidden;margin-left:auto}
.seg button{font:inherit;font-size:12px;padding:6px 12px;border:none;background:var(--mw-surface);color:var(--mw-text-muted);cursor:pointer}
.seg button+button{border-left:1px solid var(--mw-border)}
.seg button:hover{background:var(--mw-surface-muted);color:var(--mw-text)}
.seg button.on{background:var(--mw-surface-muted);color:var(--mw-text);font-weight:500}
.apply{font:inherit;font-size:12.5px;font-weight:500;padding:7px 16px;border-radius:8px;border:1px solid var(--mw-accent);background:var(--mw-accent);color:var(--mw-surface);cursor:pointer}
.apply:focus-visible,.seg button:focus-visible{outline:2px solid var(--mw-accent);outline-offset:1px}
.win-err{width:100%;font-size:12px;color:var(--mw-danger);display:none}
.kpi-strip{display:grid;grid-template-columns:repeat(4,1fr);background:var(--mw-surface);border:1px solid var(--mw-border);border-radius:12px;margin-bottom:16px;overflow:hidden}
.cell{padding:14px 16px}
.cell+.cell{border-left:1px solid var(--mw-border)}
.cell .v{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.15}
.cell .l{font-size:12px;color:var(--mw-text-muted);margin-top:2px}
.cell .s{font-size:12px;color:var(--mw-text-subtle);margin-top:1px;font-variant-numeric:tabular-nums}
.share{margin-bottom:16px}
.share-track{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--mw-surface-muted)}
.share-track div{height:100%}
.share-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--mw-text-muted);font-variant-numeric:tabular-nums}
.chart-card{background:var(--mw-surface);border:1px solid var(--mw-border);border-radius:12px;padding:16px}
.chart-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.chart-title{font-size:14px;font-weight:500}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--mw-text-muted)}
.legend-item{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.legend-dot{width:10px;height:10px;border-radius:3px}
.tag{font-size:10px;border:1px solid var(--mw-accent);color:var(--mw-accent);border-radius:4px;padding:0 4px;margin-left:2px}
.foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--mw-border)}
.foot .src{font-size:12px;color:var(--mw-text-subtle);line-height:1.6}
.action-btn{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--mw-border);background:var(--mw-surface);color:var(--mw-text-muted);font-size:12px;cursor:pointer}
.action-btn:hover{background:var(--mw-surface-muted);color:var(--mw-accent);border-color:var(--mw-accent)}
.action-btn:focus-visible{outline:2px solid var(--mw-accent);outline-offset:1px}
  </mavis-style>
  <mavis-html>
    <div class="top">
      <div class="title">Token 用量趋势</div>
      <div class="meta" id="top-meta">--</div>
    </div>
    <div class="win-bar">
      <div class="win-field"><span>开始</span><input type="datetime-local" id="win-start" step="60" value="2026-09-28T06:00"></div>
      <div class="win-arrow">→</div>
      <div class="win-field"><span>结束</span><input type="datetime-local" id="win-end" step="60" value="2026-09-28T17:45"></div>
      <div class="seg" role="group" aria-label="预设窗口">
        <button data-preset="1h">近 1 小时</button><button data-preset="today">今天</button><button data-preset="7d">近 7 天</button>
      </div>
      <button class="apply" id="win-apply">应用</button>
      <div class="win-err" id="win-err">请检查时间：开始与结束都不能为空，且结束必须晚于开始。</div>
    </div>
    <div class="kpi-strip">
      <div class="cell"><div class="v" id="kpi-total">--</div><div class="l">总 tokens</div><div class="s" id="kpi-total-sub"></div></div>
      <div class="cell"><div class="v" id="kpi-calls">--</div><div class="l">调用次数</div><div class="s" id="kpi-calls-sub"></div></div>
      <div class="cell"><div class="v" id="kpi-hit">--</div><div class="l">缓存命中率</div><div class="s">cacheRead / (cacheRead + input)</div></div>
      <div class="cell"><div class="v" id="kpi-models">--</div><div class="l">活跃模型</div><div class="s" id="kpi-models-sub"></div></div>
    </div>
    <div class="share" id="share"></div>
    <div class="chart-card">
      <div class="chart-head">
        <div class="chart-title">用量构成</div>
        <div class="legend" id="legend"></div>
      </div>
      <div style="position:relative;width:100%;height:300px;"><canvas id="trend-chart"></canvas></div>
      <div class="foot">
        <div class="src" id="foot"></div>
        <button class="action-btn" id="analyze">分析这个窗口</button>
      </div>
    </div>
  </mavis-html>
  <mavis-data name="trend" type="json">{"window":{"start":"2026-09-28T06:00:00+08:00","end":"2026-09-28T17:45:00+08:00","bucket":"hour","bucketCount":12},"kpis":{"calls":146,"totalTokens":10596787,"cacheHitRate":0.9631,"activeModels":2},"models":[{"key":"custom_provider:provider-c582e6|k3","modelName":"K3","providerName":"Kimi For Coding (kimi.com)","custom":true,"totalTokens":8698275},{"key":"custom_provider:provider-57658e|step-5-preview","modelName":"step-5-preview","providerName":"StepFun Step Plan (Global)","custom":true,"totalTokens":1898512}],"series":{"labels":["06:00","07:00","08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00"],"tokensByModel":{"custom_provider:provider-c582e6|k3":[120000,340000,560000,720000,880000,960000,1020000,980000,1050000,1100000,720000,338275],"custom_provider:provider-57658e|step-5-preview":[0,0,120000,180000,260000,310000,280000,240000,220000,180000,88512,20000]},"cacheHitRate":[0.91,0.93,0.95,0.96,0.97,0.965,0.97,0.972,0.968,0.975,0.9631,null],"calls":[4,9,14,16,18,19,17,15,14,12,5,3],"totalTokens":[120000,340000,680000,900000,1140000,1270000,1300000,1220000,1270000,1280000,808512,358275]},"unknownRows":0,"meta":{"rows":146}}</mavis-data>
  <mavis-script>
(function () {
  var d = window.__mavisData['trend'];
  var t = window.mavisTheme.tokens;
  var fmt = new Intl.NumberFormat('zh-CN');
  var compact = function (v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v); };
  var bucketName = { minute: '分钟', hour: '小时', day: '天' }[d.window.bucket] || d.window.bucket;
  document.getElementById('top-meta').textContent = d.window.start.slice(0, 16).replace('T', ' ') + ' → ' + d.window.end.slice(5, 16).replace('T', ' ') + ' · ' + bucketName + '桶 · ' + fmt.format(d.meta.rows) + ' 条记录';
  document.getElementById('kpi-total').textContent = compact(d.kpis.totalTokens);
  document.getElementById('kpi-total-sub').textContent = fmt.format(d.kpis.totalTokens) + ' tokens';
  document.getElementById('kpi-calls').textContent = fmt.format(d.kpis.calls);
  document.getElementById('kpi-calls-sub').textContent = '峰值 ' + fmt.format(Math.max.apply(null, d.series.totalTokens)) + ' / 桶';
  document.getElementById('kpi-hit').textContent = d.kpis.cacheHitRate == null ? '--' : (d.kpis.cacheHitRate * 100).toFixed(1) + '%';
  document.getElementById('kpi-models').textContent = d.kpis.activeModels;
  document.getElementById('kpi-models-sub').textContent = d.models.map(function (m) { return m.modelName; }).join(' · ');
  var palette = [t.chart1, t.chart2, t.chart3, t.chart4, t.chart5, t.chart6];
  var grand = d.models.reduce(function (s, m) { return s + m.totalTokens; }, 0) || 1;
  var share = document.getElementById('share');
  var track = document.createElement('div');
  track.className = 'share-track';
  var shareLegend = document.createElement('div');
  shareLegend.className = 'share-legend';
  d.models.forEach(function (m, i) {
    var seg = document.createElement('div');
    seg.style.width = (m.totalTokens / grand * 100).toFixed(1) + '%';
    seg.style.background = palette[i % 6];
    track.appendChild(seg);
    var item = document.createElement('span');
    item.textContent = m.modelName + ' ' + (m.totalTokens / grand * 100).toFixed(1) + '%';
    shareLegend.appendChild(item);
  });
  share.appendChild(track);
  share.appendChild(shareLegend);
  var legend = document.getElementById('legend');
  d.models.forEach(function (m, i) {
    var item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = '<span class="legend-dot" style="background:' + palette[i % 6] + ';"></span>' + m.modelName + (m.custom ? '<span class="tag">自定义</span>' : '') + ' ' + compact(m.totalTokens);
    legend.appendChild(item);
  });
  document.getElementById('foot').textContent = '来源：本机 runtime 用量记录（sqlite + 日志补全）' + (d.unknownRows > 0 ? ' · ' + d.unknownRows + ' 条未识别模型' : '') + ' · 命中率 = cacheRead / (cacheRead + input)';
  var chartDatasets = d.models.map(function (m, i) {
    return { type: 'bar', label: m.modelName, data: d.series.tokensByModel[m.key] || [], backgroundColor: palette[i % 6] + 'b3', borderColor: palette[i % 6], borderWidth: 1, borderSkipped: false, borderRadius: 5, stack: 'tokens', yAxisID: 'y' };
  });
  chartDatasets.push({ type: 'line', label: '缓存命中率', data: d.series.cacheHitRate, borderColor: t.accent, backgroundColor: t.accent, borderWidth: 2, pointRadius: 2.5, spanGaps: false, tension: 0.3, yAxisID: 'y1' });
  var chart = new Chart(document.getElementById('trend-chart'), {
    data: { labels: d.series.labels, datasets: chartDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: t.surface, titleColor: t.text, bodyColor: t.textMuted, borderColor: t.border, borderWidth: 1, padding: 10,
          callbacks: {
            label: function (ctx) {
              if (ctx.dataset.yAxisID === 'y1') return ' 缓存命中率: ' + (ctx.parsed.y == null ? '--' : (ctx.parsed.y * 100).toFixed(1) + '%');
              return ' ' + ctx.dataset.label + ': ' + fmt.format(ctx.parsed.y) + ' tokens';
            },
            footer: function (items) { var i = items[0].dataIndex; return '调用 ' + d.series.calls[i] + ' 次 · 合计 ' + fmt.format(d.series.totalTokens[i]); }
          }
        }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: t.chartAxis } },
        y: { stacked: true, grid: { color: t.chartGrid }, border: { display: false }, ticks: { color: t.chartAxis, callback: function (v) { return compact(v); } } },
        y1: { position: 'right', min: 0, max: 1, grid: { display: false }, border: { display: false }, ticks: { color: t.chartAxis, callback: function (v) { return (v * 100).toFixed(0) + '%'; } } }
      }
    }
  });
  window.addEventListener('mavis:theme-change', function () {
    var nt = window.mavisTheme.tokens;
    var np = [nt.chart1, nt.chart2, nt.chart3, nt.chart4, nt.chart5, nt.chart6];
    chart.data.datasets.forEach(function (ds, i) {
      if (ds.yAxisID === 'y1') { ds.borderColor = nt.accent; ds.backgroundColor = nt.accent; }
      else { ds.borderColor = np[i % 6]; ds.backgroundColor = np[i % 6] + 'b3'; }
    });
    chart.options.scales.x.ticks.color = nt.chartAxis;
    chart.options.scales.y.ticks.color = nt.chartAxis;
    chart.options.scales.y1.ticks.color = nt.chartAxis;
    chart.options.scales.y.grid.color = nt.chartGrid;
    chart.options.plugins.tooltip.backgroundColor = nt.surface;
    chart.options.plugins.tooltip.titleColor = nt.text;
    chart.options.plugins.tooltip.bodyColor = nt.textMuted;
    chart.options.plugins.tooltip.borderColor = nt.border;
    chart.update('none');
    document.querySelectorAll('.share-track div').forEach(function (el, i) { el.style.background = np[i % 6]; });
    document.querySelectorAll('.legend-dot').forEach(function (el, i) { el.style.background = np[i % 6]; });
  });
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var toInput = function (ms) { var x = new Date(ms); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + 'T' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
  document.querySelectorAll('.seg button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.seg button').forEach(function (b) { b.classList.remove('on'); });
      btn.classList.add('on');
      var now = Date.now(), start;
      if (btn.dataset.preset === '1h') start = now - 3600000;
      else if (btn.dataset.preset === '7d') start = now - 7 * 86400000;
      else { var x = new Date(); x.setHours(0, 0, 0, 0); start = x.getTime(); }
      document.getElementById('win-start').value = toInput(start);
      document.getElementById('win-end').value = toInput(now);
      document.getElementById('win-err').style.display = 'none';
    });
  });
  document.getElementById('win-apply').addEventListener('click', function () {
    var s = document.getElementById('win-start').value;
    var e = document.getElementById('win-end').value;
    var err = document.getElementById('win-err');
    if (!s || !e || new Date(e) <= new Date(s)) { err.style.display = 'block'; return; }
    err.style.display = 'none';
    window.mavis.sendPrompt('用 token-meter 渲染 ' + s.replace('T', ' ') + ' 到 ' + e.replace('T', ' ') + ' 的 token 用量趋势看板。', {
      widgetTitle: 'token 用量趋势',
      action: 'apply-window',
      selectedData: { startAt: s, endAt: e, bucket: 'auto' },
      visibleFilters: { bucket: d.window.bucket },
      userIntent: '应用新的时间窗口（分钟精度）并重新渲染用量趋势'
    });
  });
  document.getElementById('analyze').addEventListener('click', function () {
    window.mavis.sendPrompt('分析当前窗口（' + d.window.start.slice(0, 16).replace('T', ' ') + ' 到 ' + d.window.end.slice(0, 16).replace('T', ' ') + '）的 token 消耗特征：峰值时段、模型占比与缓存效率异常。', {
      widgetTitle: 'token 用量趋势',
      action: 'analyze-window',
      selectedData: { window: d.window, kpis: d.kpis },
      visibleFilters: { bucket: d.window.bucket },
      userIntent: '解读当前窗口的用量特征与异常'
    });
  });
})();
  </mavis-script>
  <mavis-fallback>
窗口 2026-09-28 06:00 → 17:45（小时桶）：共 10.6M tokens、146 次调用，整体缓存命中率 96.3%，2 个活跃模型（K3 82.1%、step-5-preview 17.9%，均为自定义接入）。
峰值桶 Top 3：12:00（1.30M，命中率 97.0%）、15:00（1.28M，97.5%）、13:00（1.22M，97.2%）。
命中率口径：cacheRead / (cacheRead + input)；窗口选择器支持分钟精度，应用后由 Agent 重新取数渲染。
  </mavis-fallback>
</mavis-widget>
