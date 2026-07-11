import { useEffect, useMemo, useState } from "react";

const API_BASE_URL = "";

type OptionItem = {
  id: number;
  name: string;
};

type EntryItem = {
  id: number;
  team: string;
  sales_person: string;
  client_name: string;
  client_category?: string;
  product: string;
  year: number;
  month: string;
  quantity: number;
  amount: string;
  entry_date: string;
};

export default function DataEntry() {
  const authUser = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("auth_user") || "{}");
    } catch {
      return {};
    }
  }, []);

  const isAdmin = authUser?.role === "admin";

  const canViewAllTeams =
    authUser?.role === "admin" || authUser?.role === "super_user";

  const canSelectTeamAndSalesPerson =
    authUser?.role === "admin" || authUser?.role === "super_user";

  const [form, setForm] = useState({
    team: "",
    sales_person: "",
    client_name: "",
    client_category: "",
    entry_date: "",
  });

  const [items, setItems] = useState([
    { product: "", quantity: "", amount: "" },
  ]);

  const [teams, setTeams] = useState<OptionItem[]>([]);
  const [products, setProducts] = useState<OptionItem[]>([]);
  const [clients, setClients] = useState<OptionItem[]>([]);
  const [newClientName, setNewClientName] = useState("");
  const [entries, setEntries] = useState<EntryItem[]>([]);
  const [message, setMessage] = useState("");
  const [salesPersons, setSalesPersons] = useState<any[]>([]);
  const [entrySearch, setEntrySearch] = useState("");
  

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
  };

  const loadTeams = async () => {
    const res = await fetch(`${API_BASE_URL}/api/teams`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
      },
    });
    const result = await res.json();
    if (res.ok) setTeams(result.teams || []);
  };

  const loadTeamOptions = async (teamName: string) => {
    const cleanTeam = (teamName || "").trim();
    if (!cleanTeam) {
      setProducts([]);
      setClients([]);
      return;
    }

    const res = await fetch(`${API_BASE_URL}/form/options?team=${encodeURIComponent(cleanTeam)}`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
      },
    });

    const result = await res.json();
    if (res.ok) {
      setProducts((result.products || []).map((name: string, index: number) => ({ id: index + 1, name })));
      setClients((result.clients || []).map((name: string, index: number) => ({ id: index + 1, name })));
    }
  };

  const loadEntries = async () => {
    const res = await fetch(`${API_BASE_URL}/data/entries`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
      },
    });
    const result = await res.json();
    if (res.ok) setEntries(result.entries || []);
  };

  useEffect(() => {
    loadTeams();
    loadEntries();

    const initialTeam = canSelectTeamAndSalesPerson
      ? form.team
      : authUser?.team || "";
        if (initialTeam) {
      loadTeamOptions(initialTeam);
    }
  }, []);

  useEffect(() => {
    if (form.team) {
      loadTeamOptions(form.team);
    }
  }, [form.team]);

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

  const handleChange = (e: any) => {
    const { name, value } = e.target;

    if (name === "team") {
      setForm({ ...form, team: value, client_name: "" });
      setItems([{ product: "", quantity: "", amount: "" }]);
      loadTeamOptions(value);
      return;
    }

    setForm({ ...form, [name]: value });
  };

  const saveEntry = async () => {
    setMessage("");

    for (const item of items) {
      if (!item.product || !item.quantity) continue;

      const payload = {
        ...form,
        team: canSelectTeamAndSalesPerson ? form.team : authUser?.team || "",
        sales_person: canSelectTeamAndSalesPerson ? form.sales_person : authUser?.username || "",
        product: item.product,
        quantity: Number(item.quantity),
        amount: Number(item.amount || 0),
      };

      const res = await fetch(`${API_BASE_URL}/data/entry`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payload),
      });

      const result = await res.json();

      if (!res.ok) {
        setMessage(result.detail || "Entry save failed");
        return;
      }
    }

    setMessage("Order entry saved successfully ✅");
    setForm({
      team: "",
      sales_person: "",
      client_name: "",
      client_category: "",
      entry_date: "",
    });

    setItems([{ product: "", : "" }]);
    loadEntries();
  };

  const filteredEntries = entries.filter((entry) => {
    const q = entrySearch.toLowerCase();

    return (
      entry.team.toLowerCase().includes(q) ||
      entry.sales_person.toLowerCase().includes(q) ||
      entry.client_name.toLowerCase().includes(q) ||
      entry.product.toLowerCase().includes(q) ||
      String(entry.quantity).toLowerCase().includes(q) ||
      String(entry.amount || "").toLowerCase().includes(q) ||
      String(entry.entry_date).toLowerCase().includes(q)
    );
  });

  const deleteEntry = async (id: number) => {
    if (!window.confirm("Delete this order entry?")) return;

    const res = await fetch(`${API_BASE_URL}/data/entries/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("auth_token")}`,
      },
    });

    const result = await res.json();

    if (!res.ok) {
      setMessage(result.detail || "Delete failed");
      return;
    }

    setMessage("Entry deleted ✅");
    loadEntries();
  };

  return (
    <div className="card">
      <div className="section-head">
        <div>
          <h2>Order / Data Entry</h2>
          <p className="section-subtext">
            User can enter orders only for assigned team and own sales name.
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
                headers: authHeaders,
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

        <input
          className="filter-select"
          name="entry_date"
          type="date"
          value={form.entry_date}
          onChange={handleChange}
        />

        <div>
          {items.map((item, index) => (
            <div key={index} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <select
                className="filter-select"
                value={item.product}
                onChange={(e) => {
                  const updated = [...items];
                  updated[index].product = e.target.value;
                  setItems(updated);
                }}
              >
                <option value="">Select Product</option>
                {products.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>

              <input
                className="filter-select qty-input"
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Qty"
                value={item.quantity}
                onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => {
                  const updated = [...items];
                  updated[index].quantity = e.target.value;
                  setItems(updated);
                }}
              />

              <input
                className="filter-select qty-input"
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder="Amount Rs"
                value={item.amount}
                onWheel={(e) => e.currentTarget.blur()}
                onChange={(e) => {
                  const updated = [...items];
                  updated[index].amount = e.target.value;
                  setItems(updated);
                }}
              />

              {items.length > 1 && (
                <button
                  className="action-btn"
                  onClick={() => {
                    const updated = items.filter((_, i) => i !== index);
                    setItems(updated);
                  }}
                >
                  ❌
                </button>
              )}
            </div>
          ))}

          <button
            className="action-btn"
            onClick={() => setItems([...items, { product: "", quantity: "", amount: "" }])}
          >
            + Add Product
          </button>
        </div>
      </div>

      <br />

      <button className="action-btn primary-btn" onClick={saveEntry}>
        Save Order Entry
      </button>

      {message && <div className="status success">{message}</div>}

      <br />

      <h3>Order Entries</h3>

      <input
        className="filter-select"
        placeholder="Search entries by client, product, sales person, team..."
        value={entrySearch}
        onChange={(e) => setEntrySearch(e.target.value)}
        style={{ marginBottom: 12, width: "100%" }}
      />

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Team</th>
              <th>Sales Person</th>
              <th>Client</th>
              <th>Category</th>
              <th>Product</th>
              <th>Qty</th>
              <th>Amount</th>
              {isAdmin && <th>Action</th>}
            </tr>
          </thead>

          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 8 : 7}>No order entries found.</td>
              </tr>
            ) : (
              filteredEntries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.entry_date}</td>
                  <td>{entry.team}</td>
                  <td>{entry.sales_person}</td>
                  <td>{entry.client_name}</td>
                  <td>{entry.client_category || "-"}</td>
                  <td>{entry.product}</td>
                  <td>{entry.quantity}</td>
                  <td>{entry.amount || 0}</td>
                  {isAdmin && (
                    <td>
                      <button className="action-btn" onClick={() => deleteEntry(entry.id)}>
                        Delete
                      </button>
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
