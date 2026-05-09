import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Download,
  RefreshCw,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";

type SalesInsight = {
  salesperson_name: string;
  provider: string;
  summary: string;
  strengths: string[];
  risks: string[];
  strategy: string[];
  manager_note?: string;
  performance_label?: "excellent" | "good" | "mixed" | "weak" | string;
  confidence?: "high" | "medium" | "low" | string;
  error?: string;
  root_causes?: string[];
  coaching_actions?: string[];
  risk_alerts?: string[];
  next_30_day_plan?: string[];
  expected_impact?: string[];
  performance_score?: number | null;
};

type Props = {
  apiBaseUrl: string;
  salespersonNames?: string[];
  selectedSalesPerson?: string;
  dataSource?: "excel" | "database";
  selectedTeam?: string;
  className?: string;
};

function getTone(label?: string) {
  if (label === "excellent" || label === "good") return "positive";
  if (label === "weak") return "negative";
  return "neutral";
}

function formatPerformanceLabel(label?: string) {
  if (!label) return "mixed";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function hasItems(value?: string[]) {
  return Array.isArray(value) && value.length > 0;
}

function getExecutiveSignal(item: SalesInsight) {
  const label = (item.performance_label || "mixed").toLowerCase();

  if (label === "excellent") {
    return {
      headline: "Exceptional performance detected",
      subline: "Strong execution, healthy contribution, and positive management confidence.",
    };
  }

  if (label === "good") {
    return {
      headline: "Healthy performance with scale potential",
      subline: "Current output is positive, but there is still room to protect retention and expand accounts.",
    };
  }

  if (label === "weak") {
    return {
      headline: "Immediate management attention required",
      subline: "Performance signals suggest weak execution, risk concentration, or recovery pressure.",
    };
  }

  return {
    headline: "Mixed performance pattern",
    subline: "Some positive signals exist, but stronger execution and follow-through are still needed.",
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderList(title: string, items?: string[]) {
  if (!hasItems(items)) return "";
  const rows = (items || []).map((entry) => `<li>${escapeHtml(entry)}</li>`).join("");
  return `
    <section class="pdf-section">
      <h3>${escapeHtml(title)}</h3>
      <ul>${rows}</ul>
    </section>
  `;
}

function createPdfDocument(title: string, subtitle: string, sectionsHtml: string) {
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Inter, Arial, sans-serif;
            color: #0f172a;
            background: #ffffff;
          }
          .report-shell {
            max-width: 980px;
            margin: 0 auto;
            padding: 28px 28px 48px;
          }
          .report-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 18px;
            margin-bottom: 22px;
          }
          .report-brand {
            display: flex;
            align-items: center;
            gap: 16px;
          }
          .report-brand img {
            height: 52px;
            width: auto;
            object-fit: contain;
          }
          .report-brand-text h1 {
            margin: 0;
            font-size: 28px;
            line-height: 1.1;
            color: #111827;
          }
          .report-brand-text p {
            margin: 6px 0 0;
            color: #475569;
            font-size: 14px;
          }
          .report-meta {
            text-align: right;
            color: #475569;
            font-size: 13px;
          }
          .report-page {
            page-break-after: always;
            margin-bottom: 22px;
          }
          .report-page:last-child {
            page-break-after: auto;
          }
          .person-header {
            border: 1px solid #dbeafe;
            background: #f8fbff;
            border-radius: 14px;
            padding: 16px 18px;
            margin-bottom: 18px;
          }
          .person-header-top {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
          }
          .person-header h2 {
            margin: 0;
            font-size: 22px;
            color: #0f172a;
          }
          .person-meta {
            margin-top: 8px;
            color: #475569;
            font-size: 14px;
          }
          .pdf-chip {
            display: inline-block;
            padding: 7px 12px;
            border-radius: 999px;
            border: 1px solid #cbd5e1;
            font-size: 12px;
            font-weight: 700;
            white-space: nowrap;
          }
          .pdf-chip.positive {
            color: #166534;
            background: #dcfce7;
            border-color: #bbf7d0;
          }
          .pdf-chip.negative {
            color: #991b1b;
            background: #fee2e2;
            border-color: #fecaca;
          }
          .pdf-chip.neutral {
            color: #1e3a8a;
            background: #dbeafe;
            border-color: #bfdbfe;
          }
          .summary-box {
            margin-top: 14px;
            padding: 14px 16px;
            border-radius: 12px;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            color: #334155;
            line-height: 1.6;
          }
          .pdf-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
            margin-top: 16px;
          }
          .pdf-section {
            border: 1px solid #e2e8f0;
            border-radius: 14px;
            padding: 14px 16px;
            background: #ffffff;
          }
          .pdf-section h3 {
            margin: 0 0 10px;
            font-size: 16px;
            color: #0f172a;
          }
          .pdf-section ul {
            margin: 0;
            padding-left: 20px;
            color: #334155;
          }
          .pdf-section li + li {
            margin-top: 8px;
          }
          .manager-note {
            margin-top: 16px;
            border: 1px solid #dbeafe;
            background: #f8fbff;
            border-radius: 14px;
            padding: 14px 16px;
          }
          .manager-note h3 {
            margin: 0 0 8px;
            font-size: 16px;
            color: #0f172a;
          }
          .manager-note p {
            margin: 0;
            color: #334155;
            line-height: 1.6;
          }
          .report-footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 8px 24px;
            border-top: 1px solid #e2e8f0;
            color: #64748b;
            font-size: 12px;
            background: #ffffff;
            text-align: center;
          }
          @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .report-shell { padding-bottom: 56px; }
          }
        </style>
      </head>
      <body>
        <div class="report-shell">
          <div class="report-header">
            <div class="report-brand">
              <img src="/logo.svg" alt="Company Logo" />
              <div class="report-brand-text">
                <h1>${escapeHtml(title)}</h1>
                <p>${escapeHtml(subtitle)}</p>
              </div>
            </div>
            <div class="report-meta">
              <div>${escapeHtml(new Date().toLocaleString())}</div>
              <div>Ressichem Pvt Ltd</div>
            </div>
          </div>
          ${sectionsHtml}
        </div>
        <div class="report-footer">
          © ${new Date().getFullYear()} Created by Adil Siddiqui — Ressichem Pvt Ltd
        </div>
      </body>
    </html>
  `;
}

function openPrintWindow(html: string) {
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) {
    window.alert("Popup blocked. Please allow popups to export PDF.");
    return;
  }

  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();

  const triggerPrint = () => {
    try {
      win.print();
    } catch {
      window.alert("Print window could not be opened correctly.");
    }
  };

  if (win.document.readyState === "complete") {
    setTimeout(triggerPrint, 250);
  } else {
    win.onload = () => setTimeout(triggerPrint, 250);
  }
}

function buildInsightPage(item: SalesInsight) {
  const tone = getTone(item.performance_label);
  const scoreText =
    typeof item.performance_score === "number" ? ` · score ${item.performance_score}` : "";
  const executiveSignal = getExecutiveSignal(item);  
  return `
    <div class="report-page">
      <div class="person-header">
        <div class="person-header-top">
          <div>
            <h2>${escapeHtml(item.salesperson_name)}</h2>
            <div class="person-meta">
              ${escapeHtml(formatPerformanceLabel(item.performance_label))} · confidence ${escapeHtml(
    item.confidence || "medium"
  )}${escapeHtml(scoreText)}
            </div>
          </div>
          <span class="pdf-chip ${tone}">${escapeHtml(item.provider)}</span>
        </div>
        <div class="summary-box">
          <strong>${escapeHtml(executiveSignal.headline)}</strong>
          <p style="margin:8px 0 0;">${escapeHtml(executiveSignal.subline)}</p>
          <p style="margin:10px 0 0;">${escapeHtml(item.summary || "No summary available.")}</p>
        </div>
      </div>

      <div class="pdf-grid">
        <section class="pdf-section">
          <h3>Executive snapshot</h3>
          <ul>
            <li>Performance label: ${escapeHtml(formatPerformanceLabel(item.performance_label))}</li>
            <li>Confidence: ${escapeHtml(item.confidence || "medium")}</li>
            <li>Provider: ${escapeHtml(item.provider || "fallback")}</li>
            ${
              typeof item.performance_score === "number"
                ? `<li>Performance score: ${escapeHtml(String(item.performance_score))}</li>`
                : ""
            }
          </ul>
        </section>

        ${renderList("What went right", item.strengths)}
        ${renderList("Where he missed", item.risks)}
        ${renderList("Next strategy", item.strategy)}
        ${renderList("Root causes", item.root_causes)}
        ${renderList("Risk alerts", item.risk_alerts)}
        ${renderList("Expected impact", item.expected_impact)}
        ${renderList("Coaching actions", item.coaching_actions)}
        ${renderList("Next 30 day plan", item.next_30_day_plan)}
      </div>

      ${
        item.manager_note
          ? `
        <div class="manager-note">
          <h3>Manager note</h3>
          <p>${escapeHtml(item.manager_note)}</p>
        </div>
      `
          : ""
      }
    </div>
  `;
}

async function fetchInsights(
  apiBaseUrl: string,
  salespersonNames: string[],
  dataSource: "excel" | "database" = "excel",
  selectedTeam = ""
) {
  const response = await fetch(`${apiBaseUrl}/salesperson-insights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      salesperson_names: salespersonNames,
      data_source: dataSource,
      team: dataSource === "database" ? selectedTeam : "",
    }),
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  const result = isJson
    ? await response.json()
    : { detail: await response.text() };

  if (!response.ok) {
    throw new Error(result?.detail || "Insights fetch failed");
  }

  return result;
}

export default function SalesAiInsightsPanel({
  apiBaseUrl,
  salespersonNames = [],
  selectedSalesPerson = "all",
  dataSource = "excel",
  selectedTeam = "",
  className = "",
}: Props) {
  const [loading, setLoading] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState("fallback");
  const [insights, setInsights] = useState<SalesInsight[]>([]);

  const effectiveNames = useMemo(() => {
    if (selectedSalesPerson && selectedSalesPerson !== "all") return [selectedSalesPerson];
    return salespersonNames;
  }, [selectedSalesPerson, salespersonNames]);

  const loadInsights = async () => {
    try {
      if (dataSource === "database" && !selectedTeam) {
        setError("");
        setInsights([]);
        return;
      }

      setLoading(true);
      setError("");

      const result = await fetchInsights(
        apiBaseUrl,
        effectiveNames,
        dataSource,
        selectedTeam
      );

      setProvider(result.provider || "fallback");
      setInsights(Array.isArray(result.insights) ? result.insights : []);
    } catch (err: any) {
      setError(err.message || "AI insights load failed");
      setInsights([]);
    } finally {
      setLoading(false);
    }
  };

  const exportSinglePdf = (item: SalesInsight) => {
    const html = createPdfDocument(
      `${item.salesperson_name} - AI Sales Performance Review`,
      "Single salesperson management report",
      buildInsightPage(item)
    );
    openPrintWindow(html);
  };

  const exportAllPdf = async () => {
    try {
      setExportingAll(true);

      const result = await fetchInsights(
        apiBaseUrl,
        salespersonNames,
        dataSource,
        selectedTeam
      );

      const allInsights: SalesInsight[] = Array.isArray(result.insights) ? result.insights : [];
      if (!allInsights.length) {
        throw new Error("No team insights available for export");
      }

      const pages = allInsights.map(buildInsightPage).join("");
      const html = createPdfDocument(
        "Full Team AI Sales Performance Review",
        "Combined management report for all salespersons",
        pages
      );
      openPrintWindow(html);
    } catch (err: any) {
      window.alert(err.message || "Full team PDF export failed");
    } finally {
      setExportingAll(false);
    }
  };

  useEffect(() => {
    if (!apiBaseUrl) return;
    if (dataSource === "database" && !selectedTeam) {
      setInsights([]);
      setError("");
      return;
    }
    loadInsights();
  }, [apiBaseUrl, effectiveNames, dataSource, selectedTeam]);

  return (
    <div className={`card ai-panel ${className}`.trim()}>
      <div className="section-head">
        <div>
          <h2>AI Sales Manager</h2>
          <p className="section-subtext">
            Gemini salesperson analysis with strengths, mistakes, root causes, action plan, and expected impact.
          </p>
        </div>

        <div className="ai-panel-actions">
          <span className={`ai-provider-chip ${provider === "gemini" ? "live" : "fallback"}`}>
            <Bot size={14} />
            {provider === "gemini" ? "Gemini Live" : "Fallback Mode"}
          </span>

          <button className="action-btn" type="button" onClick={exportAllPdf} disabled={exportingAll || salespersonNames.length === 0}>
            <Users size={15} />
            {exportingAll ? "Preparing Team PDF..." : "Full Team AI PDF"}
          </button>

          <button className="action-btn" type="button" onClick={loadInsights} disabled={loading}>
            <RefreshCw size={15} />
            {loading ? "Refreshing..." : "Refresh AI"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert-card high">
          <div className="row-inline">
            <AlertTriangle size={15} />
            <strong>AI insights error</strong>
          </div>
          <p>{error}</p>
        </div>
      ) : null}

      {loading ? <div className="empty-lite">Generating AI analysis...</div> : null}

      {!loading && insights.length === 0 ? (
        <div className="empty-lite">No salesperson insight available yet.</div>
      ) : null}

      <div className="ai-insights-grid">
        {insights.map((item) => {
          const tone = getTone(item.performance_label);
          const badgeClass =
            tone === "positive" ? "success" : tone === "negative" ? "danger" : "neutral";

          return (
            <div key={item.salesperson_name} className={`ai-card tone-${tone}`}>
              <div className="row-between">
                <div>
                  <strong>{item.salesperson_name}</strong>
                  <p className="ai-card-meta">
                    {formatPerformanceLabel(item.performance_label)} · confidence {item.confidence || "medium"}
                    {typeof item.performance_score === "number" ? ` · score ${item.performance_score}` : ""}
                  </p>
                </div>

                <div className="ai-card-actions">
                  <span className={`badge ${badgeClass}`}>
                    {tone === "positive" ? (
                      <TrendingUp size={14} />
                    ) : tone === "negative" ? (
                      <TrendingDown size={14} />
                    ) : (
                      <ShieldCheck size={14} />
                    )}
                    {item.provider}
                  </span>

                  <button className="ai-export-btn" type="button" onClick={() => exportSinglePdf(item)}>
                    <Download size={14} />
                    This PDF
                  </button>
                </div>
              </div>

              <div className="ai-summary-box">
                <p>{item.summary}</p>
              </div>

              <div className="ai-three-col">
                <div className="mini-card">
                  <strong>What went right</strong>
                  <ul className="ai-list">
                    {(item.strengths || []).map((entry, index) => (
                      <li key={index}>{entry}</li>
                    ))}
                  </ul>
                </div>

                <div className="mini-card">
                  <strong>Where he missed</strong>
                  <ul className="ai-list">
                    {(item.risks || []).map((entry, index) => (
                      <li key={index}>{entry}</li>
                    ))}
                  </ul>
                </div>

                <div className="mini-card">
                  <strong>Next strategy</strong>
                  <ul className="ai-list">
                    {(item.strategy || []).map((entry, index) => (
                      <li key={index}>{entry}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {(hasItems(item.root_causes) || hasItems(item.risk_alerts) || hasItems(item.expected_impact)) && (
                <div className="ai-three-col">
                  {hasItems(item.root_causes) ? (
                    <div className="mini-card">
                      <strong>Root causes</strong>
                      <ul className="ai-list">
                        {(item.root_causes || []).map((entry, index) => (
                          <li key={index}>{entry}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="mini-card">
                      <strong>Root causes</strong>
                      <p className="ai-card-meta">No deeper root-cause analysis available.</p>
                    </div>
                  )}

                  {hasItems(item.risk_alerts) ? (
                    <div className="mini-card">
                      <strong>Risk alerts</strong>
                      <ul className="ai-list">
                        {(item.risk_alerts || []).map((entry, index) => (
                          <li key={index}>{entry}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="mini-card">
                      <strong>Risk alerts</strong>
                      <p className="ai-card-meta">No special risk alert from current analysis.</p>
                    </div>
                  )}

                  {hasItems(item.expected_impact) ? (
                    <div className="mini-card">
                      <strong>Expected impact</strong>
                      <ul className="ai-list">
                        {(item.expected_impact || []).map((entry, index) => (
                          <li key={index}>{entry}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="mini-card">
                      <strong>Expected impact</strong>
                      <p className="ai-card-meta">Expected impact not provided by model.</p>
                    </div>
                  )}
                </div>
              )}

              {(hasItems(item.coaching_actions) || hasItems(item.next_30_day_plan)) && (
                <div className="ai-three-col">
                  {hasItems(item.coaching_actions) ? (
                    <div className="mini-card">
                      <strong>
                        <Zap size={14} style={{ marginRight: 6, verticalAlign: "text-bottom" }} />
                        Coaching actions
                      </strong>
                      <ul className="ai-list">
                        {(item.coaching_actions || []).map((entry, index) => (
                          <li key={index}>{entry}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="mini-card">
                      <strong>Coaching actions</strong>
                      <p className="ai-card-meta">No coaching actions generated.</p>
                    </div>
                  )}

                  {hasItems(item.next_30_day_plan) ? (
                    <div className="mini-card">
                      <strong>
                        <Target size={14} style={{ marginRight: 6, verticalAlign: "text-bottom" }} />
                        Next 30 day plan
                      </strong>
                      <ul className="ai-list">
                        {(item.next_30_day_plan || []).map((entry, index) => (
                          <li key={index}>{entry}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="mini-card">
                      <strong>Next 30 day plan</strong>
                      <p className="ai-card-meta">No 30-day plan generated.</p>
                    </div>
                  )}

                  <div className="mini-card">
                    <strong>Manager quick read</strong>
                    <p className="ai-card-meta">
                      Review the summary first, validate the risks, then convert coaching actions and next 30 day plan into weekly follow-up tasks.
                    </p>
                  </div>
                </div>
              )}

              {item.manager_note ? (
                <div className="manager-note-box">
                  <strong>Manager note</strong>
                  <p>{item.manager_note}</p>
                </div>
              ) : null}

              {item.error ? (
                <div className="info-banner warning-banner">
                  Gemini fallback used: {item.error}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
