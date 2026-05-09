import { useEffect, useState } from "react";

type ForecastItem = {
  username: string;
  sales_target: number;
  achieved: number;
  difference: number;
};

export default function ForecastTab() {
  const [data, setData] = useState<ForecastItem[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [selectedTeam, setSelectedTeam] = useState("");

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

    fetch(`/forecast?team=${encodeURIComponent(selectedTeam)}`)
      .then((res) => res.json())
      .then((items) => setData(items))
      .catch((err) => console.error("Forecast error:", err));
  }, [selectedTeam]);

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
        </div>
      </div>
      
      <div className="forecast-table-wrapper">
        <table className="forecast-table">
          <thead>
            <tr>
              <th>Sales Person</th>
              <th>Target</th>
              <th>Achieved</th>
              <th>Difference</th>
              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            {data.map((item, index) => {
              const isGood = item.difference >= 0;

              return (
                <tr key={index}>
                  <td className="user-cell">
                    <div className="avatar">
                      {item.username.charAt(0)}
                    </div>

                    <span>{item.username}</span>
                  </td>

                  <td>
                    {item.sales_target.toLocaleString()}
                  </td>

                  <td className="achieved">
                    {item.achieved.toLocaleString()}
                  </td>

                  <td
                    className={
                      isGood ? "positive-value" : "negative-value"
                    }
                  >
                    {item.difference.toLocaleString()}
                  </td>

                  <td>
                    <span
                      className={
                        isGood
                          ? "status-badge success"
                          : "status-badge danger"
                      }
                    >
                      {isGood
                        ? "Above Target"
                        : "Below Target"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}