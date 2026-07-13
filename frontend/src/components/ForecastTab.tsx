import { useEffect, useState } from "react";

type ForecastItem = {
  username: string;
  sales_target: number;
  achieved: number;
  difference: number;
  remaining?: number;
  percent?: number;
  remaining_percent?: number;
  target_type?: "QTY" | "AMOUNT";
  unit?: string;
};

export default function ForecastTab() {
  const [data, setData] = useState<ForecastItem[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [selectedTeam, setSelectedTeam] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const formatValue = (value: number, item?: ForecastItem) => {
  const targetType = item?.target_type || data[0]?.target_type || "QTY";

  if (targetType === "AMOUNT") {
    return `Rs. ${Number(value || 0).toLocaleString()}`;
  }

  return `${Number(value || 0).toLocaleString()} Qty`;
};

const forecastUnitLabel = data[0]?.target_type === "AMOUNT" ? "Rs" : "Qty";

  useEffect(() => {
    fetch("/form/options")
      .then((res) => res.json())
      .then((result) => setTeams(result.teams || []))
      .catch((err) => console.error("Teams error:", err));
  }, []);

  useEffect(() => {
    if (!selectedTeam) {
      setData([]);
      return;
    }

    fetch(`/forecast?team=${encodeURIComponent(selectedTeam)}&month=${encodeURIComponent(selectedMonth)}`)
      .then((res) => res.json())
      .then((items) => setData(items))
      .catch((err) => console.error("Forecast error:", err));
  }, [selectedTeam, selectedMonth]);

  const teamTotal = data.reduce(
    (acc, item) => {
      acc.target += item.sales_target || 0;
      acc.achieved += item.achieved || 0;
      return acc;
    },
    { target: 0, achieved: 0 }
  );

  const teamPercent =
    teamTotal.target > 0
      ? (teamTotal.achieved / teamTotal.target) * 100
      : 0;

  const teamRemainingPercent = Math.max(
    0,
    100 - teamPercent
  );
  
  return (
    <div className="forecast-wrapper">
      <div className="forecast-header">
        <h2>📈 Sales Forecast Dashboard</h2>
        <p>Target vs Achieved Performance Overview</p>
        <div style={{ marginTop: "20px", marginBottom: "20px" }}>
          <select
            className="filter-select"
            value={selectedTeam}
            onChange={(e) => setSelectedTeam(e.target.value)}
          >
            <option value="">Select Team</option>

            {teams.map((team) => (
              <option key={team} value={team}>
                {team}
              </option>
            ))}
          </select>

          <select
            className="filter-select"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            style={{ marginTop: 12 }}
          >
            <option value="">Full Year</option>
            {months.map((month) => (
              <option key={month} value={month}>
                {month}
              </option>
            ))}
          </select>
        </div>
      </div>
      
      <div className="forecast-table-wrapper">
        <table className="forecast-table">
          <thead>
            <tr>
              <th>Sales Person</th>
              <th>Target ({forecastUnitLabel})</th>
              <th>Achieved ({forecastUnitLabel})</th>
              <th>Remaining ({forecastUnitLabel})</th>
              <th>Achieved %</th>
              <th>Remaining %</th>
            </tr>
          </thead>

          <tbody>
            {data.map((item, index) => {
              
              return (
                <tr key={index}>
                  <td className="user-cell">
                    <div className="avatar">
                      {item.username.charAt(0)}
                    </div>

                    <span>{item.username}</span>
                  </td>

                  <td>
                    {formatValue(item.sales_target, item)}
                  </td>

                  <td className="achieved">
                    {formatValue(item.achieved, item)}
                  </td>

                  <td>
                    {formatValue((item.remaining ?? item.sales_target - item.achieved), item)}
                  </td>

                  <td>
                    {Math.round(item.percent || 0)}%
                  </td>

                  <td>
                    {Math.round((item as any).remaining_percent || 0)}%
                  </td>
                </tr>
              );
            })}
            {data.length > 0 && (
              <tr className="forecast-total-row">
                <td>
                  <strong>Team Total</strong>
                </td>

                <td>
                  <strong>{formatValue(teamTotal.target)}</strong>
                </td>

                <td className="achieved">
                  <strong>{formatValue(teamTotal.achieved)}</strong>
                </td>

                <td>
                  <strong>{formatValue(teamTotal.target - teamTotal.achieved)}</strong>
                </td>

                <td>
                  <strong>{Math.round(teamPercent)}%</strong>
                </td>

                <td>
                  <strong>{Math.round(teamRemainingPercent)}%</strong>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
