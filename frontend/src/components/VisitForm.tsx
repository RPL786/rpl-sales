import { useEffect, useMemo, useState } from "react";

const API_BASE_URL = "";

type VisitFormState = {
  team: string;
  sales_person: string;
  client_name: string;
  client_category: string;
  product: string;
  meeting_date: string;
  meeting_time: string;
  meeting_type: string;
  meeting_status: string;
  client_response: string;
  order_amount: string;
  quantity: string;
  future_potential: string;
  next_meeting_date: string;
  next_meeting_time: string;
  notes: string;
};

type VisitEntry = {
  id: number;
  created_by?: string;
  created_at?: string;
  team: string;
  sales_person: string;
  client_name: string;
  client_category?: string;
  product: string;
  meeting_date: string;
  meeting_time: string;
  meeting_type: string;
  meeting_status: string;
  client_response?: string;
  order_amount?: number;
  quantity?: number;
  future_potential?: number;
  next_meeting_date?: string;
  next_meeting_time?: string;
  notes?: string;
};

type OptionItem = {
  id: number;
  name: string;
};

const emptyForm: VisitFormState = {
  team: "",
  sales_person: "",
  client_name: "",
  client_category: "",
  product: "",
  meeting_date: "",
  meeting_time: "",
  meeting_type: "",
  meeting_status: "",
  client_response: "",
  order_amount: "",
  quantity: "",
  future_potential: "",
  next_meeting_date: "",
  next_meeting_time: "",
  notes: "",
};

function getAuthUser() {
  try {
    return JSON.parse(localStorage.getItem("auth_user") || "{}");
  } catch {
    return {};
  }
}

function authHeaders(json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
  };
}

export default function VisitForm() {
  const authUser = useMemo(() => getAuthUser(), []);
  const isAdmin = authUser?.role === "admin";
  const canViewAllTeams =
    authUser?.role === "admin" || authUser?.role === "super_user";
  const canSelectTeamAndSalesPerson =
    authUser?.role === "admin" || authUser?.role === "super_user";
    const [form, setForm] = useState<VisitFormState>(emptyForm);
  const [visits, setVisits] = useState<VisitEntry[]>([]);
  const [message, setMessage] = useState("");
  const [editingVisitId, setEditingVisitId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [teams, setTeams] = useState<OptionItem[]>([]);
  const [products, setProducts] = useState<OptionItem[]>([]);
  const [clients, setClients] = useState<OptionItem[]>([]);
  const [newClientName, setNewClientName] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [productDropdownOpen, setProductDropdownOpen] = useState(false);
  const [salesPersons, setSalesPersons] = useState<any[]>([]);

  const loadVisits = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/visit-entries`, {
        headers: authHeaders(),
      });

      const result = await res.json();

      if (!res.ok) {
        setMessage(result.detail || "Visits load failed");
        return;
      }

      setVisits(result.visits || []);
    } catch {
      setMessage("Visits load failed");
    }
  };

  useEffect(() => {
    loadTeams();
    loadVisits();

    const initialTeam = canSelectTeamAndSalesPerson ? form.team : authUser?.team || "";
    if (initialTeam) {
      loadTeamOptions(initialTeam);
    }
  }, []);

  useEffect(() => {
    const activeTeam = canSelectTeamAndSalesPerson ? form.team : authUser?.team || "";
    if (activeTeam) {
      loadTeamOptions(activeTeam);
    } else {
      setProducts([]);
      setClients([]);
    }
  }, [form.team]);

  useEffect(() => {
    const loadSalesPersonsFromDashboard = async () => {
      if (!canSelectTeamAndSalesPerson || !form.team) {
        setSalesPersons([]);
        return;
      }

      try {
        const res = await fetch(
          `${API_BASE_URL}/dashboard/db?team=${encodeURIComponent(form.team)}&_ts=${Date.now()}`,
          {
            cache: "no-store",
            headers: {
              Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
            },
          }
        );

        const data = await res.json();

        console.log("Sales persons API response:", data);

        console.log("Dashboard sales persons data:", data);

        const source = Array.isArray(data.team) && data.team.length
          ? data.team
          : data.sales_scorecards || [];

        const persons = source.filter((m: any) =>
          m.name && m.name.toLowerCase() !== "nan"
        );

        setSalesPersons(persons);
      } catch {
        setSalesPersons([]);
      }
    };

    loadSalesPersonsFromDashboard();
  }, [form.team, isAdmin]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;

    if (name === "team") {
      setForm({ ...form, team: value, client_name: "", product: "" });
      setSelectedProducts([]);
      loadTeamOptions(value);
      return;
    }

    setForm({ ...form, [name]: value });
  };

  const resetForm = () => {
    setForm(emptyForm);
    setSelectedProducts([]);
    setEditingVisitId(null);
  };

  const validateForm = () => {
    const activeTeam = canSelectTeamAndSalesPerson ? form.team : authUser?.team || "";

    if (!activeTeam || !form.client_name || !form.product) {
      return "Team, client, and product are required.";
    }

    if (!form.meeting_date || !form.meeting_time) {
      return "Meeting date and time are required.";
    }

    if (!form.meeting_type || !form.meeting_status) {
      return "Meeting type and status are required.";
    }

    if (canSelectTeamAndSalesPerson && !form.sales_person) {
      return "Sales person is required for admin entries.";
    }

    return "";
  };

  const saveVisit = async () => {
    const validationError = validateForm();
    if (validationError) {
      setMessage(validationError);
      return;
    }

    setSaving(true);
    setMessage("");

    const url = editingVisitId
      ? `${API_BASE_URL}/api/visit-entry/${editingVisitId}`
      : `${API_BASE_URL}/api/visit-entry`;

    const method = editingVisitId ? "PUT" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: authHeaders(true),
        body: JSON.stringify({
          ...form,
          client_category: form.client_category,
          order_amount: Number(form.order_amount || 0),
          quantity: Number(form.quantity || 0),
          future_potential: Number(form.future_potential || 0),
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        setMessage(result.detail || "Visit save failed");
        return;
      }

      setMessage(
        editingVisitId
          ? "Visit updated successfully"
          : "Visit entry saved successfully"
      );
      resetForm();
      loadVisits();
    } catch {
      setMessage("Visit save failed");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (visit: VisitEntry) => {
    if (!isAdmin) return;

    loadTeamOptions(visit.team || "");
    setEditingVisitId(visit.id);
    setForm({
      team: visit.team || "",
      sales_person: visit.sales_person || "",
      client_name: visit.client_name || "",
      client_category: visit.client_category || "",
      product: visit.product || "",
      meeting_date: visit.meeting_date || "",
      meeting_time: visit.meeting_time || "",
      meeting_type: visit.meeting_type || "",
      meeting_status: visit.meeting_status || "",
      client_response: visit.client_response || "",
      order_amount: String(visit.order_amount || ""),
      quantity: String(visit.quantity || ""),
      future_potential: String(visit.future_potential || ""),
      next_meeting_date: visit.next_meeting_date || "",
      next_meeting_time: visit.next_meeting_time || "",
      notes: visit.notes || "",
    });

    setSelectedProducts(
      (visit.product || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    );

    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const filteredVisits = visits
    .filter((visit) => {
      const q = searchText.trim().toLowerCase();
      if (!q) return true;

      return [
        visit.meeting_date,
        visit.meeting_time,
        visit.team,
        visit.sales_person,
        visit.client_name,
        visit.product,
        visit.meeting_type,
        visit.meeting_status,
        visit.client_response,
        visit.notes,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    })
    .filter((visit) => {
      if (dateFrom && visit.meeting_date < dateFrom) return false;
      if (dateTo && visit.meeting_date > dateTo) return false;
      return true;
    })
    .sort((a, b) => {
      const aTime = `${a.meeting_date || ""} ${a.meeting_time || ""}`;
      const bTime = `${b.meeting_date || ""} ${b.meeting_time || ""}`;
      return bTime.localeCompare(aTime);
    });

  const deleteVisit = async (id: number) => {
    if (!isAdmin) return;
    if (!window.confirm("Delete this visit?")) return;

    const res = await fetch(`${API_BASE_URL}/api/visit-entry/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "Delete failed");
      return;
    }

    setMessage("Visit deleted");
    loadVisits();
  };

  const loadTeams = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/teams`, { headers: authHeaders() });
      const result = await res.json();
      if (res.ok) setTeams(result.teams || []);
    } catch {
      setMessage("Teams load failed");
    }
  };

  const loadTeamOptions = async (teamName: string) => {
    const cleanTeam = (teamName || "").trim();
    if (!cleanTeam) {
      setClients([]);
      setProducts([]);
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/form/options?team=${encodeURIComponent(cleanTeam)}`, {
        headers: authHeaders(),
      });
      const result = await res.json();

      if (!res.ok) {
        setMessage(result.detail || "Team options load failed");
        return;
      }

      setClients((result.clients || []).map((name: string, index: number) => ({ id: index + 1, name })));
      setProducts((result.products || []).map((name: string, index: number) => ({ id: index + 1, name })));
    } catch {
      setMessage("Team options load failed");
    }
  };

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h2>Visit / Meeting Entry</h2>
          <p className="section-subtext">
            {isAdmin
              ? "Admin can add, edit, and delete visit entries."
              : "Add your visit entries. Only admin can edit or delete saved visits."}
          </p>
        </div>
      </div>

      <div className="filter-grid">
        <select
          className="filter-select"
          name="team"
          value={canSelectTeamAndSalesPerson ? form.team : authUser?.team || ""}
          onChange={handleChange}
          disabled={!canSelectTeamAndSalesPerson}
        >
          <option value="">Select Team</option>
          {teams.map((team) => (
            <option key={team.id} value={team.name}>
              {team.name}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="filter-select"
            placeholder="New client name"
            value={newClientName}
            onChange={(e) => setNewClientName(e.target.value)}
          />

          <button
            className="action-btn"
            type="button"
            onClick={async () => {
              if (!newClientName.trim()) return;

              const res = await fetch(`${API_BASE_URL}/api/clients`, {
                method: "POST",
                headers: authHeaders(true),
                body: JSON.stringify({ name: newClientName }),
              });

              if (res.ok) {
                setForm({ ...form, client_name: newClientName });
                setNewClientName("");
                loadTeamOptions(canViewAllTeams ? form.team : authUser?.team || "");
              }
            }}
          >
            Add Client
          </button>
        </div>

        {canSelectTeamAndSalesPerson ? (
          <select
            className="filter-select"
            name="sales_person"
            value={form.sales_person}
            onChange={handleChange}
          >
            <option value="">Select Sales Person</option>
            {salesPersons.map((sp) => (
              <option key={sp.name} value={sp.name}>
                {sp.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="filter-select"
            name="sales_person"
            value={authUser?.username || ""}
            readOnly
          />
        )}

        <select
          className="filter-select"
          name="client_name"
          value={form.client_name}
          onChange={handleChange}
        >
          <option value="">Select Client</option>
          {clients.map((client) => (
            <option key={client.id} value={client.name}>
              {client.name}
            </option>
          ))}
        </select>

        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="filter-select"
            onClick={() => setProductDropdownOpen((prev) => !prev)}
            style={{ width: "100%", textAlign: "left" }}
          >
            {selectedProducts.length === 0
              ? "Select Products"
              : `${selectedProducts.length} products selected`}
          </button>

          {productDropdownOpen && (
            <div
              className="card"
              style={{
                position: "absolute",
                zIndex: 50,
                width: "100%",
                maxHeight: 260,
                overflowY: "auto",
                marginTop: 6,
                padding: 12,
              }}
            >
              {products.map((product) => (
                <label
                  key={product.id}
                  style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}
                >
                  <input
                    type="checkbox"
                    checked={selectedProducts.includes(product.name)}
                    onChange={() => {
                      const next = selectedProducts.includes(product.name)
                        ? selectedProducts.filter((name) => name !== product.name)
                        : [...selectedProducts, product.name];

                      setSelectedProducts(next);
                      setForm({ ...form, product: next.join(", ") });
                    }}
                  />
                  {product.name}
                </label>
              ))}
            </div>
          )}
        </div>
        <input className="filter-select" name="meeting_date" type="date" value={form.meeting_date} onChange={handleChange} />
        <input className="filter-select" name="meeting_time" type="time" value={form.meeting_time} onChange={handleChange} />
        
        <select
          className="filter-select"
          name="client_category"
          value={form.client_category}
          onChange={handleChange}
        >
          <option value="">Select Category</option>
          <option value="Retail">Retail</option>
          <option value="Industrial">Industrial</option>
          <option value="Distributor">Distributor</option>
          <option value="Dealer">Dealer</option>
          <option value="Other">Other</option>
          <option value="Applicator">Applicator</option>
          <option value="Home / Project Owner">Home / Project Owner</option>
        </select>
        
        <select className="filter-select" name="meeting_type" value={form.meeting_type} onChange={handleChange}>
          <option value="">Select Meeting Type</option>
          <option>Initial Visit</option>
          <option>Follow-up</option>
          <option>Closing</option>
          <option>Future Scheduled</option>
        </select>

        <select className="filter-select" name="meeting_status" value={form.meeting_status} onChange={handleChange}>
          <option value="">Select Status</option>
          <option>Interested</option>
          <option>Thinking</option>
          <option>No Response</option>
          <option>Rejected</option>
          <option>Need Follow-up</option>
          <option>Order Received</option>
        </select>

        <input className="filter-select" name="client_response" placeholder="Client Response" value={form.client_response} onChange={handleChange} />
        <input
          className="filter-select"
          name="quantity"
          type="number"
          placeholder="Quantity"
          value={form.quantity}
          onChange={handleChange}
        />
        <input className="filter-select" name="future_potential" type="number" placeholder="Future Potential %" value={form.future_potential} onChange={handleChange} />
        <input className="filter-select" name="next_meeting_date" type="date" value={form.next_meeting_date} onChange={handleChange} />
        <input className="filter-select" name="next_meeting_time" type="time" value={form.next_meeting_time} onChange={handleChange} />
        <input className="filter-select" name="notes" placeholder="Meeting Notes" value={form.notes} onChange={handleChange} />
      </div>

      <br />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="action-btn primary-btn" onClick={saveVisit} disabled={saving}>
          {saving ? "Saving..." : editingVisitId ? "Update Visit" : "Save Visit Entry"}
        </button>

        {editingVisitId && (
          <button className="action-btn" onClick={resetForm}>
            Cancel Edit
          </button>
        )}
      </div>

      {message && <div className="status success">{message}</div>}

      <br />

      <div className="section-head">
        <div>
          <h3>Visit List</h3>

          <input
            className="filter-select"
            placeholder="Search visits..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ marginTop: 10, maxWidth: 420 }}
          />

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <input
              className="filter-select"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />

            <input
              className="filter-select"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />

            <button
              className="action-btn"
              onClick={() => {
                setDateFrom("");
                setDateTo("");
              }}
            >
              Clear Date Filter
            </button>
          </div>

          <p className="section-subtext">
            Date-wise list. Users see only their own visits; admin sees all visits.
          </p>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Time</th>
              <th>Team</th>
              <th>Sales Person</th>
              <th>Client</th>
              <th>Product</th>
              <th>Status</th>
              <th>Notes</th>
              <th>Next Follow-up</th>
              {isAdmin && <th>Actions</th>}
            </tr>
          </thead>

          <tbody>
            {filteredVisits.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 10 : 9}>No visits found.</td>
              </tr>
            ) : (
              filteredVisits.map((visit) => (
                <tr
                  key={visit.id}
                  style={{
                    background:
                      visit.meeting_status === "Need Follow-up"
                        ? "rgba(245, 158, 11, 0.12)"
                        : undefined,
                  }}
                >
                  <td>{visit.meeting_date}</td>
                  <td>{visit.meeting_time}</td>
                  <td>{visit.team}</td>
                  <td>{visit.sales_person}</td>
                  <td>{visit.client_name}</td>
                  <td>{visit.product}</td>
                  <td>{visit.meeting_status}</td>
                  <td>{visit.notes}</td>
                  <td>{visit.next_meeting_date || "-"}</td>
                  {isAdmin && (
                    <td>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="action-btn" onClick={() => startEdit(visit)}>
                          Edit
                        </button>
                        <button className="action-btn" onClick={() => deleteVisit(visit.id)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
