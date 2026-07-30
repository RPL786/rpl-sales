import { useEffect, useMemo, useState } from "react";

const API_BASE_URL = "";

type VisitRow = {
  client_name: string;
  client_category: string;
  product: string;
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

const emptyRow: VisitRow = {
  client_name: "",
  client_category: "",
  product: "",
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

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

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
  const canViewAllTeams = authUser?.role === "admin" || authUser?.role === "super_user";
  const canSelectTeamAndSalesPerson = authUser?.role === "admin" || authUser?.role === "super_user";

  const [team, setTeam] = useState(canSelectTeamAndSalesPerson ? "" : authUser?.team || "");
  const [salesPerson, setSalesPerson] = useState(canSelectTeamAndSalesPerson ? "" : authUser?.username || "");
  const [meetingDate, setMeetingDate] = useState(todayDate());
  const [rows, setRows] = useState<VisitRow[]>(Array.from({ length: 5 }, () => ({ ...emptyRow })));
  const [openProductRow, setOpenProductRow] = useState<number | null>(null);
  const [clientSearch, setClientSearch] = useState<{ [key: number]: string }>({});
  const [productSearch, setProductSearch] = useState<{ [key: number]: string }>({});
  const [openClientRow, setOpenClientRow] = useState<number | null>(null);

  const [visits, setVisits] = useState<VisitEntry[]>([]);
  const [editingVisitId, setEditingVisitId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [teams, setTeams] = useState<OptionItem[]>([]);
  const [products, setProducts] = useState<OptionItem[]>([]);
  const [clients, setClients] = useState<OptionItem[]>([]);
  const [newClientName, setNewClientName] = useState("");
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

  useEffect(() => {
    loadTeams();
    loadVisits();
    const initialTeam = canSelectTeamAndSalesPerson ? team : authUser?.team || "";
    if (initialTeam) loadTeamOptions(initialTeam);
  }, []);

  useEffect(() => {
    if (team) loadTeamOptions(team);
  }, [team]);

  useEffect(() => {
    const loadSalesPersonsFromDashboard = async () => {
      if (!canSelectTeamAndSalesPerson || !team) {
        setSalesPersons([]);
        return;
      }

      try {
        const res = await fetch(
          `${API_BASE_URL}/dashboard/db?team=${encodeURIComponent(team)}&_ts=${Date.now()}`,
          {
            cache: "no-store",
            headers: { Authorization: `Bearer ${localStorage.getItem("auth_token")}` },
          }
        );
        const data = await res.json();
        const source = Array.isArray(data.team) && data.team.length ? data.team : data.sales_scorecards || [];
        const persons = source.filter((m: any) => m.name && m.name.toLowerCase() !== "nan");
        setSalesPersons(persons);
      } catch {
        setSalesPersons([]);
      }
    };

    loadSalesPersonsFromDashboard();
  }, [team]);

  const updateRow = (index: number, field: keyof VisitRow, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const toggleProduct = (index: number, productName: string) => {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;

        const selectedProducts = row.product
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);

        const exists = selectedProducts.includes(productName);

        const updatedProducts = exists
          ? selectedProducts.filter((p) => p !== productName)
          : [...selectedProducts, productName];

        return {
          ...row,
          product: updatedProducts.join(", "),
        };
      })
    );
  };

  const clearRows = () => {
    setRows(Array.from({ length: 5 }, () => ({ ...emptyRow })));
  };

  const addEmptyRow = () => {
    setRows((prev) => [...prev, { ...emptyRow }]);
  };

  const removeRow = (index: number) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const completedRows = rows.filter(
    (row) =>
      row.client_name.trim() &&
      row.product.trim() &&
      row.meeting_time &&
      row.meeting_type.trim() &&
      row.meeting_status.trim()
  );

  const saveAllVisits = async () => {
    const activeTeam = canSelectTeamAndSalesPerson ? team : authUser?.team || "";
    const activeSalesPerson = canSelectTeamAndSalesPerson ? salesPerson : authUser?.username || "";

    if (!activeTeam) {
      setMessage("Team required hai.");
      return;
    }
    if (!activeSalesPerson) {
      setMessage("Sales person required hai.");
      return;
    }
    if (!meetingDate) {
      setMessage("Visit date required hai.");
      return;
    }
    if (completedRows.length === 0) {
      setMessage("Kam az kam 1 complete visit row fill karein.");
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      const payload = completedRows.map((row) => ({
        team: activeTeam,
        sales_person: activeSalesPerson,
        client_name: row.client_name,
        client_category: row.client_category,
        product: row.product,
        meeting_date: meetingDate,
        meeting_time: row.meeting_time,
        meeting_type: row.meeting_type,
        meeting_status: row.meeting_status,
        client_response: row.client_response,
        order_amount: Number(row.order_amount || 0),
        quantity: Number(row.quantity || 0),
        future_potential: Number(row.future_potential || 0),
        next_meeting_date: row.next_meeting_date,
        next_meeting_time: row.next_meeting_time,
        notes: row.notes,
      }));

      const res = await fetch(`${API_BASE_URL}/api/visit-entries/bulk`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ visits: payload }),
      });

      const result = await res.json();
      if (!res.ok) {
        setMessage(result.detail || "Visits save failed");
        return;
      }

      setMessage(`${result.saved || completedRows.length} visits saved successfully.`);
      clearRows();
      loadVisits();
    } catch {
      setMessage("Visits save failed");
    } finally {
      setSaving(false);
    }
  };

  const startEditVisit = (visit: VisitEntry) => {
    if (!isAdmin) return;

    setEditingVisitId(visit.id);
    setTeam(visit.team || "");
    setSalesPerson(visit.sales_person || "");
    setMeetingDate(visit.meeting_date || todayDate());

    setRows([
      {
        client_name: visit.client_name || "",
        client_category: visit.client_category || "",
        product: visit.product || "",
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
      },
    ]);

    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEditVisit = () => {
    setEditingVisitId(null);
    clearRows();
    setMeetingDate(todayDate());

    if (canSelectTeamAndSalesPerson) {
      setTeam("");
      setSalesPerson("");
    }
  };
  
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

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h2>Day Wise Visit Form</h2>
          <p className="section-subtext">Ek date ki sari visits Excel style me enter karein aur ek hi dafa save karein.</p>
        </div>
      </div>

      <div className="filter-grid">
        <select
          className="filter-select"
          value={team}
          onChange={(e) => {
            setTeam(e.target.value);
            setSalesPerson("");
            clearRows();
          }}
          disabled={!canSelectTeamAndSalesPerson}
        >
          <option value="">Select Team</option>
          {teams.map((teamItem) => (
            <option key={teamItem.id} value={teamItem.name}>
              {teamItem.name}
            </option>
          ))}
        </select>

        {canSelectTeamAndSalesPerson ? (
          <select className="filter-select" value={salesPerson} onChange={(e) => setSalesPerson(e.target.value)}>
            <option value="">Select Sales Person</option>
            {salesPersons.map((sp) => (
              <option key={sp.name} value={sp.name}>
                {sp.name}
              </option>
            ))}
          </select>
        ) : (
          <input className="filter-select" value={authUser?.username || ""} readOnly />
        )}

        <input className="filter-select" type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} />

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
                setNewClientName("");
                loadTeamOptions(canViewAllTeams ? team : authUser?.team || "");
              }
            }}
          >
            Add Client
          </button>
        </div>
      </div>

      <br />

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Client</th>
              <th>Category</th>
              <th>Products</th>
              <th>Time</th>
              <th>Type</th>
              <th>Status</th>
              <th>Qty</th>
              <th>Next Follow-up</th>
              <th>Notes</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td>{index + 1}</td>
                <td>
                  <div className="search-dropdown">
                    <button
                      type="button"
                      className="dropdown-button"
                      onClick={() => setOpenClientRow(openClientRow === index ? null : index)}
                    >
                      {row.client_name || "Select Client"}
                    </button>

                    {openClientRow === index && (
                      <div className="dropdown-panel">
                        <input
                          className="dropdown-search"
                          placeholder="Search client..."
                          value={clientSearch[index] || ""}
                          onChange={(e) =>
                            setClientSearch((prev) => ({
                              ...prev,
                              [index]: e.target.value,
                            }))
                          }
                        />

                        <div className="dropdown-list">
                          {clients
                            .filter((client) =>
                              String(client.name)
                                .toLowerCase()
                                .includes((clientSearch[index] || "").toLowerCase())
                            )
                            .map((client) => (
                              <div
                                key={client.id}
                                className="dropdown-item"
                                onClick={() => {
                                  updateRow(index, "client_name", client.name);
                                  setOpenClientRow(null);
                                  setClientSearch((prev) => ({ ...prev, [index]: "" }));
                                }}
                              >
                                {client.name}
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                </td>
                <td>
                  <select className="filter-select" value={row.client_category} onChange={(e) => updateRow(index, "client_category", e.target.value)}>
                    <option value="">Select</option>
                    <option>Retail</option>
                    <option>Industrial</option>
                    <option>Distributor</option>
                    <option>Dealer</option>
                    <option>Applicator/Contractor</option>
                    <option>Architect/Consultant</option>
                    <option>Home / Project Owner</option>
                    <option>Other</option>
                  </select>
                </td>
                <td>
                  <div style={{ position: "relative", minWidth: 220 }}>
                    <button
                      type="button"
                      className="filter-select"
                      onClick={() =>
                        setOpenProductRow(openProductRow === index ? null : index)
                      }
                      style={{
                        width: "100%",
                        textAlign: "left",
                        color: row.product ? "#111827" : "#6b7280",
                        background: "#ffffff",
                      }}
                    >
                      {row.product || "Select products"}
                    </button>

                    {openProductRow === index && (
                      <div
                        style={{
                          position: "absolute",
                          top: "42px",
                          left: 0,
                          right: 0,
                          zIndex: 9999,
                          maxHeight: 220,
                          overflowY: "auto",
                          background: "#ffffff",
                          border: "1px solid #d1d5db",
                          borderRadius: 10,
                          boxShadow: "0 12px 30px rgba(15, 23, 42, 0.18)",
                          padding: 8,
                        }}
                      >
                        <input
                          className="dropdown-search"
                          placeholder="Search product..."
                          value={productSearch[index] || ""}
                          onChange={(e) =>
                            setProductSearch((prev) => ({
                              ...prev,
                              [index]: e.target.value,
                            }))
                          }
                        />
                        {products.filter((product) =>
                          String(product.name)
                            .toLowerCase()
                            .includes((productSearch[index] || "").toLowerCase())
                        ).length === 0 ? (
                        
                          <div style={{ fontSize: 13, color: "#6b7280", padding: 8 }}>
                            No products found
                          </div>
                        ) : (
                          products
                            .filter((product) =>
                              String(product.name)
                                .toLowerCase()
                                .includes((productSearch[index] || "").toLowerCase())
                            )
                            .map((product) => {
                            const selectedProducts = row.product
                              .split(",")
                              .map((p) => p.trim())
                              .filter(Boolean);

                            const checked = selectedProducts.includes(product.name);

                            return (
                              <label
                                key={product.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  padding: "7px 8px",
                                  fontSize: 13,
                                  color: "#111827",
                                  cursor: "pointer",
                                  borderRadius: 8,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleProduct(index, product.name)}
                                />
                                <span>{product.name}</span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </td>
                <td>
                  <input className="filter-select" type="time" value={row.meeting_time} onChange={(e) => updateRow(index, "meeting_time", e.target.value)} />
                </td>
                <td>
                  <select className="filter-select" value={row.meeting_type} onChange={(e) => updateRow(index, "meeting_type", e.target.value)}>
                    <option value="">Select</option>
                    <option>Initial Visit</option>
                    <option>Follow-up</option>
                    <option>Closing</option>
                    <option>Future Scheduled</option>
                  </select>
                </td>
                <td>
                  <select
                    className="filter-select"
                    value={row.meeting_status}
                    onChange={(e) => {
                      const status = e.target.value;
                      updateRow(index, "meeting_status", status);

                      if (status === "Order Received" || status === "Rejected" || status === "Closed") {
                        updateRow(index, "next_meeting_date", "");
                        updateRow(index, "next_meeting_time", "");
                      }
                    }}
                  >
                    <option value="">Select</option>
                    <option>Interested</option>
                    <option>Thinking</option>
                    <option>Need Follow-up</option>
                    <option>No Response</option>
                    <option>Order Received</option>
                    <option>Rejected</option>
                    <option>Closed</option>
                  </select>
                </td>
                <td>
                  <input
                    className="filter-select qty-input"
                    type="number"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min="0"
                    value={row.quantity}
                    onWheel={(e) => e.currentTarget.blur()}
                    onChange={(e) => updateRow(index, "quantity", e.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="filter-select"
                    type="date"
                    value={row.next_meeting_date}
                    disabled={
                      row.meeting_status === "Order Received" ||
                      row.meeting_status === "Rejected" ||
                      row.meeting_status === "Closed"
                    }
                    onChange={(e) => updateRow(index, "next_meeting_date", e.target.value)}
                  />
                </td>
                <td>
                  <input className="filter-select" placeholder="Notes" value={row.notes} onChange={(e) => updateRow(index, "notes", e.target.value)} />
                </td>
                <td>
                  <button className="action-btn" type="button" onClick={() => removeRow(index)}>
                    X
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <br />

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="action-btn" type="button" onClick={addEmptyRow}>
            Add Empty Row
          </button>
          <button className="action-btn" type="button" onClick={clearRows}>
            Clear All
          </button>
        </div>

        <button className="action-btn primary-btn" onClick={saveAllVisits} disabled={saving}>
          {saving
            ? "Saving..."
            : editingVisitId
            ? "Update Visit"
            : `Save All Visits (${completedRows.length})`}
        </button>

        {editingVisitId && (
          <button
            className="action-btn"
            type="button"
            onClick={cancelEditVisit}
            disabled={saving}
          >
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
            <input className="filter-select" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <input className="filter-select" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
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
          <p className="section-subtext">Purani aur new saved visits dono yahan show hongi.</p>
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
                        : visit.meeting_status === "Order Received"
                        ? "rgba(16, 185, 129, 0.12)"
                        : visit.meeting_status === "Rejected" || visit.meeting_status === "Closed"
                        ? "rgba(239, 68, 68, 0.10)"
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
                        <button className="action-btn" onClick={() => startEditVisit(visit)}>
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
