import { useEffect, useState } from "react";

const API_BASE_URL = "";

type UserItem = {
  id: number;
  username: string;
  role: string;
  team: string;
  sales_target: number;
  target_duration: string;
  target_type?: string;
};

export default function AdminPanel() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  
  const [userTeam, setUserTeam] = useState("");
  const [userRole, setUserRole] = useState("user");
  const [users, setUsers] = useState<UserItem[]>([]);
  const [salesTarget, setSalesTarget] = useState("");
  const [targetDuration, setTargetDuration] = useState("monthly");
  const [targetYear, setTargetYear] = useState(new Date().getFullYear());
  const [targetMonth, setTargetMonth] = useState("Jan");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [message, setMessage] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamTargetType, setTeamTargetType] = useState("QTY");
  const [productName, setProductName] = useState("");
  const [teams, setTeams] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [productDropdownOpen, setProductDropdownOpen] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [aiProvider, setAiProvider] = useState("gemini");
  const [aiModel, setAiModel] = useState("gemini-2.5-flash");
  const [fallbackModel, setFallbackModel] = useState("gemini-2.5-flash");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiTimeout, setAiTimeout] = useState(180);
  const [aiEnabled, setAiEnabled] = useState(true);

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
  };

  const getTeamTargetType = (teamName: string) => {
    const team = teams.find((t) => t.name === teamName);
    return team?.target_type || "QTY";
  };

  const loadMonthlyTargets = async () => {
    const res = await fetch(
      `${API_BASE_URL}/admin/monthly-targets?year=${targetYear}&month=${targetMonth}`,
      { headers: authHeaders }
    );

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "Monthly targets load failed");
      return;
    }

    const targetMap = new Map(
      (result.targets || []).map((t: any) => [
        `${t.username}__${t.team}`,
        t,
      ])
    );

    setUsers((prev) =>
      prev.map((u) => {
        const key = `${u.username}__${u.team || ""}`;
        const saved = targetMap.get(key);

        return {
          ...u,
          sales_target: saved ? Number(saved.target_value || 0) : 0,
          target_type: saved?.target_type || getTeamTargetType(u.team),
        };
      })
    );
  };

  const loadTeamsProducts = async () => {
    const [teamRes, productRes] = await Promise.all([
      fetch(`${API_BASE_URL}/api/teams`, { headers: authHeaders }),
      fetch(`${API_BASE_URL}/api/products`, { headers: authHeaders }),
    ]);

    const teamData = await teamRes.json();
    const productData = await productRes.json();

    if (teamRes.ok) setTeams(teamData.teams || []);
    if (productRes.ok) setProducts(productData.products || []);
  };

  const loadAISettings = async () => {
    const res = await fetch(`${API_BASE_URL}/admin/ai-settings`, {
      headers: authHeaders,
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage("Failed to load AI settings");
      return;
    }

    setAiProvider(result.provider || "gemini");
    setAiModel(result.model || "gemini-1.5-flash");
    setFallbackModel(result.fallback_model || "gemini-1.5-flash");
    setAiApiKey(result.api_key || "");
    setAiTimeout(result.timeout_seconds || 180);
    setAiEnabled(result.enabled ?? true);
  };
  
  const loadUsers = async () => {
    const res = await fetch(`${API_BASE_URL}/admin/users`, {
      headers: authHeaders,
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "Users load failed");
      return;
    }

    setUsers(result.users || []);
    setTimeout(() => {
      loadMonthlyTargets();
    }, 300);
  };

  const createUser = async () => {
    setMessage("");

    if (userRole !== "super_user" && !userTeam) {
      setMessage("Please select the team first");
      return;
    }

    const res = await fetch(`${API_BASE_URL}/admin/create-user`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        username,
        password,
        team: userRole === "super_user" ? "" : userTeam,
        role: userRole,
        sales_target: Number(salesTarget || 0),
        target_duration: targetDuration,
      }),
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "User create failed");
      return;
    }

    setMessage("User created successfully ✅");
    setUsername("");
    setPassword("");
    setUserTeam("");
    setUserRole("user");
    setSalesTarget("");
    setTargetDuration("monthly");
    loadUsers();
  };

  const deleteUser = async (userId: number) => {
    if (!window.confirm("Delete this user?")) return;

    const res = await fetch(`${API_BASE_URL}/admin/delete-user/${userId}`, {
      method: "DELETE",
      headers: authHeaders,
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "User delete failed");
      return;
    }

    setMessage("User deleted successfully ✅");
    loadUsers();
  };

  const saveUserTarget = async (u: UserItem) => {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/monthly-target`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          username: u.username,
          team: u.team || userTeam,
          year: targetYear,
          month: targetMonth,
          target_kg: u.sales_target || 0,
          target_type: getTeamTargetType(u.team || userTeam),
          target_value: u.sales_target || 0,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        alert(result.detail || "Target update failed");
        return;
      }

      alert(`Target saved for ${targetMonth} ${targetYear}`);
      loadMonthlyTargets();
    } catch (err) {
      console.error(err);
    }
  };

  const resetPassword = async (userId: number) => {
    const newPassword = window.prompt("Enter new password");
    if (!newPassword) return;

    const res = await fetch(`${API_BASE_URL}/admin/reset-password/${userId}`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ password: newPassword }),
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "Password reset failed");
      return;
    }

    setMessage("Password reset successfully ✅");
  };

  const addTeam = async () => {
    const res = await fetch(`${API_BASE_URL}/api/teams`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: teamName, target_type: teamTargetType }),
    });

    const result = await res.json();
    setMessage(res.ok ? "Team added ✅" : result.detail || "Team add failed");
    if (res.ok) {
      setTeamName("");
      setTeamTargetType("QTY");
      loadTeamsProducts();
    }
  };

  const addProduct = async () => {
    const res = await fetch(`${API_BASE_URL}/api/products`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: productName }),
    });

    const result = await res.json();
    setMessage(res.ok ? "Product added ✅" : result.detail || "Product add failed");
    if (res.ok) {
      setProductName("");
      loadTeamsProducts();
    }
  };

  const deleteTeam = async (id: number) => {
    if (!window.confirm("Delete this team?")) return;

    const res = await fetch(`${API_BASE_URL}/api/teams/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });

    const result = await res.json();
    setMessage(res.ok ? "Team deleted ✅" : result.detail || "Team delete failed");
    loadTeamsProducts();
  };

  const deleteProduct = async (id: number) => {
    if (!window.confirm("Delete this product?")) return;

    const res = await fetch(`${API_BASE_URL}/api/products/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });

    const result = await res.json();
    setMessage(res.ok ? "Product deleted ✅" : result.detail || "Product delete failed");
    loadTeamsProducts();
  };

  const saveAISettings = async () => {
    const res = await fetch(`${API_BASE_URL}/admin/ai-settings`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        provider: aiProvider,
        model: aiModel,
        fallback_model: fallbackModel,
        api_key: aiApiKey,
        timeout_seconds: aiTimeout,
        enabled: aiEnabled,
      }),
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "AI settings save failed");
      return;
    }

    setMessage("AI settings updated successfully ✅");
  };

  const testAIConnection = async () => {
  setMessage("Testing AI connection...");

  const res = await fetch(`${API_BASE_URL}/admin/test-ai`, {
    method: "POST",
    headers: authHeaders,
  });

  const result = await res.json();

  if (!res.ok) {
    setMessage(result.detail || "AI connection test failed");
    return;
  }

  setMessage(`AI connected successfully ✅ (${result.provider} / ${result.model})`);
};

  useEffect(() => {
    loadUsers();
    loadTeamsProducts();
    loadAISettings();
  }, []);
  useEffect(() => {
    if (users.length > 0 && teams.length > 0) {
      loadMonthlyTargets();
    }
  }, [targetYear, targetMonth, teams.length]);

  return (
    <div className="card">

      <input
        className="filter-select"
        placeholder="Search product..."
        value={productSearch}
        onChange={(e) => setProductSearch(e.target.value)}
        style={{ marginBottom: 10 }}
      />

      <select
        className="filter-select"
        value={userTeam}
        onChange={(e) => setUserTeam(e.target.value)}
      >
        <option value="">Select Team</option>
        {teams.map((team) => (
          <option key={team.id} value={team.name}>
            {team.name}
          </option>
        ))}
      </select>

      <h2>Admin Panel</h2>
      <p className="section-subtext">Create, delete, and reset user passwords</p>

      <div
        className="filter-grid"
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center", // 👈 ALIGN FIX
          flexWrap: "wrap",
        }}
      >
        <input
          className="filter-select"
          placeholder="New username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <input
          className="filter-select"
          placeholder="New password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <select
          className="filter-select"
          value={userRole}
          onChange={(e) => setUserRole(e.target.value)}
        >
          <option value="user">User</option>
          <option value="team_leader">Team Leader</option>
          <option value="super_user">Super User</option>
        </select>

        <input
          className="filter-select"
          type="number"
          placeholder="Sales Target"
          value={salesTarget}
          onChange={(e) => setSalesTarget(e.target.value)}
        />

        <select
          className="filter-select"
          value={targetDuration}
          onChange={(e) => setTargetDuration(e.target.value)}
        >
          <option value="monthly">Monthly</option>
          <option value="3months">3 Months</option>
          <option value="6months">6 Months</option>
          <option value="yearly">Yearly</option>
        </select>
      </div>

      <br />

      <button className="action-btn primary-btn" onClick={createUser}>
        Create User
      </button>

      {message && <div className="status success">{message}</div>}

      <br />

      <hr />

      <h3>Teams / Products</h3>

      <div
        className="filter-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 220px 1fr auto",
          gap: 12,
          alignItems: "center",
        }}
      >
        <input
          className="filter-select"
          placeholder="New team name"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
        />

        <select
          className="filter-select"
          value={teamTargetType}
          onChange={(e) => setTeamTargetType(e.target.value)}
        >
          <option value="QTY">QTY Target</option>
          <option value="AMOUNT">Rupees Target</option>
        </select>

        <button className="action-btn" onClick={addTeam}>
          Add Team
        </button>

        

        <label
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            height: 42,
            width: "100%",
            borderRadius: 12,
            background: "rgba(30, 41, 59, 0.8)",
            border: "1px solid rgba(139, 92, 246, 0.2)",
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
            cursor: "pointer",
            gap: 10,
            transition: "all 0.2s ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: "linear-gradient(135deg, #8b5cf6, #6366f1)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
              }}

              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "scale(1.02)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "scale(1)";
              }}
            >
              ⬆️
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                whiteSpace: "nowrap", // 👈 line break band
              }}
            >
              <span style={{ fontWeight: 600 }}>
                Upload Excel File
              </span>              
            </div>
          </div>          

          <input
            type="file"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;

              const data = new FormData();
              data.append("file", file);

              const res = await fetch(`${API_BASE_URL}/api/products/upload`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
                },
                body: data,
              });

              const result = await res.json();
              alert(res.ok ? `Added ${result.added} products` : result.detail);

              loadTeamsProducts();
            }}
          />
        </label>

        <input
          className="filter-select"
          placeholder="New product name"
          value={productName}
          onChange={(e) => setProductName(e.target.value)}
          style={{ width: "100%" }}
        />

        <button className="action-btn" onClick={addProduct}>
          Add Product
        </button>
      </div>

      <div className="table-wrap" style={{ marginTop: 20 }}>
        <h4>Teams List</h4>
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Team</th>
              <th>Target Type</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team) => (
              <tr key={team.id}>
                <td>{team.id}</td>
                <td>{team.name}</td>
                <td>{team.target_type || "QTY"}</td>
                <td>
                  <button className="action-btn" onClick={() => deleteTeam(team.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 20, position: "relative" }}>
        <h4>Products List</h4>

        <button
          className="filter-select"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => setProductDropdownOpen((prev) => !prev)}
        >
          {products.length} products available
        </button>

        {productDropdownOpen && (
          <div
            className="card"
            style={{
              position: "absolute",
              width: "100%",
              zIndex: 50,
              maxHeight: 250,
              overflowY: "auto",
              marginTop: 6,
              padding: 10,
              background: "#1f2937",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              boxShadow: "0 8px 20px rgba(0,0,0,0.1)",
            }}
          >
            {products
              .filter((p) =>
                p.name.toLowerCase().includes(productSearch.toLowerCase())
              )
              .map((product) => (
              <div
                key={product.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <span>{product.name}</span>

                <button
                  className="action-btn"
                  onClick={() => deleteProduct(product.id)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <hr style={{ marginTop: 30, marginBottom: 30 }} />

      <h3>AI Settings</h3>

      <div
        className="filter-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          alignItems: "center",
        }}
      >
        <select
          className="filter-select"
          value={aiProvider}
          onChange={(e) => setAiProvider(e.target.value)}
        >
          <option value="gemini">Gemini</option>
          <option value="openai">OpenAI</option>
          <option value="claude">Claude</option>
        </select>

        <input
          className="filter-select"
          placeholder="Primary Model"
          value={aiModel}
          onChange={(e) => setAiModel(e.target.value)}
        />

        <input
          className="filter-select"
          placeholder="Fallback Model"
          value={fallbackModel}
          onChange={(e) => setFallbackModel(e.target.value)}
        />

        <input
          className="filter-select"
          type="number"
          placeholder="Timeout Seconds"
          value={aiTimeout}
          onChange={(e) => setAiTimeout(Number(e.target.value))}
        />

        <input
          className="filter-select"
          type="password"
          placeholder="API Key"
          value={aiApiKey}
          onChange={(e) => setAiApiKey(e.target.value)}
          style={{ gridColumn: "span 2" }}
        />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "#fff",
          }}
        >
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(e) => setAiEnabled(e.target.checked)}
          />
          AI Enabled
        </label>
      </div>

      <br />

      <button className="action-btn primary-btn" onClick={saveAISettings}>
        Save AI Settings
      </button>

      <button
        className="action-btn"
        onClick={testAIConnection}
        style={{ marginLeft: 10 }}
      >
        Test AI Connection
      </button>

      <h3>Users List</h3>

      <div
        className="filter-grid"
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <input
          className="filter-select"
          type="number"
          value={targetYear}
          onChange={(e) => setTargetYear(Number(e.target.value))}
          style={{ maxWidth: 160 }}
        />

        <select
          className="filter-select"
          value={targetMonth}
          onChange={(e) => setTargetMonth(e.target.value)}
          style={{ maxWidth: 160 }}
        >
          {months.map((month) => (
            <option key={month} value={month}>
              {month}
            </option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Username</th>
              <th>Role</th>
              <th>Monthly Target</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>

          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.username}</td>
                <td>{u.role}</td>

                <td>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ minWidth: 55, fontWeight: 700 }}>
                      {getTeamTargetType(u.team) === "AMOUNT" ? "Rs" : "Qty"}
                    </span>

                    <input
                      className="filter-select"
                      type="number"
                      value={u.sales_target || 0}
                      onChange={(e) =>
                        setUsers(users.map((x) =>
                          x.id === u.id ? { ...x, sales_target: Number(e.target.value) } : x
                      ))
                    }
                    />
                  </div>
                </td>

                <td>
                  <select
                    className="filter-select"
                    value={u.target_duration || "monthly"}
                    onChange={(e) =>
                      setUsers(users.map((x) =>
                        x.id === u.id ? { ...x, target_duration: e.target.value } : x
                      ))
                    }
                  >
                    <option value="monthly">Monthly</option>
                    <option value="3months">3 Months</option>
                    <option value="6months">6 Months</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </td>

                <td>
                  <button className="action-btn" onClick={() => saveUserTarget(u)}>
                    Save Target
                  </button>
                  
                  <button className="action-btn" onClick={() => resetPassword(u.id)}>
                    Reset Password
                  </button>

                  <button className="action-btn" onClick={() => deleteUser(u.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
