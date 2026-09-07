import { useEffect, useMemo, useState } from "react";

const API_BASE_URL = "";

const MONTHS = ["all", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PRODUCT_CATEGORIES = ["all", "Tile Adhesive", "Tile Grout", "BCM", "Zepoxy"];

type TeamContribution = {
  team: string;
  qty: number;
  amount: number;
  qty_percent: number;
  amount_percent: number;
};

type ProductContributionRow = {
  category: string;
  product: string;
  total_qty: number;
  total_amount: number;
  overall_qty_percent: number;
  overall_amount_percent: number;
  teams: TeamContribution[];
};

type ReportResponse = {
  year: number;
  month: string;
  overall_total_qty: number;
  overall_total_amount: number;
  team_names: string[];
  rows: ProductContributionRow[];
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(Math.round(Number(value || 0)));
}

function formatPercent(value: number) {
  return `${Number(value || 0).toFixed(2)}%`;
}

export default function ProductContributionTab() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState("all");
  const [category, setCategory] = useState("all");
  const [team, setTeam] = useState("all");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<ReportResponse | null>(null);

  const loadReport = async () => {
    try {
      setLoading(true);
      setMessage("");

      const params = new URLSearchParams({
        year: String(year),
        month,
        category,
        team,
      });

      const res = await fetch(`${API_BASE_URL}/api/product-contribution-report?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
        },
        cache: "no-store",
      });

      const result = await res.json();

      if (!res.ok) {
        setMessage(result.detail || "Product contribution report load failed");
        return;
      }

      setReport(result);
    } catch (err: any) {
      setMessage(err.message || "Product contribution report load failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
  }, []);

  const teamOptions = useMemo(() => {
    return ["all", ...(report?.team_names || [])];
  }, [report]);

  const rows = report?.rows || [];

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h2>Product Contribution</h2>
          <p className="section-subtext">
            Category-wise department sales, product-wise total sale, aur contribution percentage.
          </p>
        </div>

        <button className="action-btn primary-btn" onClick={loadReport} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div className="filter-grid">
        <input
          className="filter-select"
          type="number"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        />

        <select className="filter-select" value={month} onChange={(e) => setMonth(e.target.value)}>
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {m === "all" ? "All Months" : m}
            </option>
          ))}
        </select>

        <select className="filter-select" value={category} onChange={(e) => setCategory(e.target.value)}>
          {PRODUCT_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat === "all" ? "All Categories" : cat}
            </option>
          ))}
        </select>

        <select className="filter-select" value={team} onChange={(e) => setTeam(e.target.value)}>
          {teamOptions.map((t) => (
            <option key={t} value={t}>
              {t === "all" ? "All Teams" : t}
            </option>
          ))}
        </select>
      </div>

      {message && <div className="status error">{message}</div>}

      <div className="kpi-grid" style={{ marginTop: 18 }}>
        <div className="kpi-card">
          <span>Total Qty</span>
          <strong>{formatNumber(report?.overall_total_qty || 0)}</strong>
        </div>

        <div className="kpi-card">
          <span>Total Amount</span>
          <strong>Rs {formatNumber(report?.overall_total_amount || 0)}</strong>
        </div>

        <div className="kpi-card">
          <span>Products</span>
          <strong>{formatNumber(rows.length)}</strong>
        </div>
      </div>

      <br />

      <h3>Category-wise Department Sales</h3>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Product</th>
              <th>Total Qty</th>
              <th>Overall Share</th>
              <th>Team Contribution</th>
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5}>No product contribution data found.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${row.category}-${row.product}`}>
                  <td>{row.category}</td>
                  <td>{row.product}</td>
                  <td>{formatNumber(row.total_qty)}</td>
                  <td>{formatPercent(row.overall_qty_percent)}</td>
                  <td>
                    <div style={{ display: "grid", gap: 6 }}>
                      {row.teams.length === 0 ? (
                        <span>-</span>
                      ) : (
                        row.teams.map((teamRow) => (
                          <span key={teamRow.team}>
                            <strong>{teamRow.team}</strong>: {formatNumber(teamRow.qty)} /{" "}
                            {formatPercent(teamRow.qty_percent)}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <br />

      <h3>Product-wise Total Sales & Contribution</h3>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Category</th>
              <th>Total Qty</th>
              <th>Total Amount</th>
              <th>Overall Qty Share</th>
              <th>Overall Amount Share</th>
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>No product contribution data found.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`overall-${row.category}-${row.product}`}>
                  <td>{row.product}</td>
                  <td>{row.category}</td>
                  <td>{formatNumber(row.total_qty)}</td>
                  <td>Rs {formatNumber(row.total_amount)}</td>
                  <td>{formatPercent(row.overall_qty_percent)}</td>
                  <td>{formatPercent(row.overall_amount_percent)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}